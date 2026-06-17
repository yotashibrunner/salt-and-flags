// ============================================================================
// Salt & Flags — economy core (hardened, money-safe).
// Order book with price-time priority + escrow + append-only ledger.
// Invariant: pieces of eight and commodity units are CONSERVED across all ops
// (every change is a transfer between accounts, including the ESCROW account).
// Runnable with: node --test
//
// This is the canonical logic the authoritative server uses. A Postgres adapter
// implements the same account/order/ledger storage; the matching logic is this.
// ============================================================================

export class Ledger {
  constructor() { this.entries = []; this._id = 0; }
  // every PoE movement is posted as a transfer; postPair keeps the ledger zero-sum
  postPair(fromId, toId, amount, reason, ref) {
    this.entries.push({ id: ++this._id, account: fromId, delta: -amount, reason, ref });
    this.entries.push({ id: ++this._id, account: toId, delta: +amount, reason, ref });
  }
  sum() { return this.entries.reduce((s, e) => s + e.delta, 0); } // must always be 0
}

export class Exchange {
  constructor() {
    this.accounts = new Map();          // id -> { id, poe, inv:{commodity:qty} }
    this.books = new Map();             // "island:commodity" -> { bids, asks, last }
    this.openOrders = new Map();        // orderId -> order
    this.trades = [];                   // immutable trade log
    this.ledger = new Ledger();
    this._oid = 0; this._seq = 0;
    // When false, an order owner's goods live on the owner account (the engine
    // stays location-agnostic — what its own unit tests assume). When true (the
    // Market flips it on), goods live in per-(owner,island) WAREHOUSE accounts, so
    // a good is physical: it can only be sold where it sits. PoE is always global.
    this.located = false;
    // faucet accounting baselines: PoE/units only enter play via account creation
    // (opening balances) + production mint. totalPoe()===minted and
    // totalUnits(c)===mintedUnits[c] are the conservation invariants the fuzzer checks.
    this.minted = 0;
    this.mintedUnits = {};
    this.createAccount("ESCROW", 0);    // holds reserved funds/goods for resting orders
  }

  // --- accounts ---
  createAccount(id, poe = 0, inv = {}) {
    if (this.accounts.has(id)) throw new Error(`account exists: ${id}`);
    this.accounts.set(id, { id, poe, inv: { ...inv } });
    this.minted += poe;                                       // opening PoE is a faucet
    for (const c in inv) this.mintedUnits[c] = (this.mintedUnits[c] || 0) + inv[c];
    return this.accounts.get(id);
  }
  acct(id) {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`no account: ${id}`);
    return a;
  }
  poeOf(id) { return this.acct(id).poe; }
  invOf(id, c) { return this.acct(id).inv[c] || 0; }

  // --- located goods plumbing ---
  whId(owner, island) { return `wh:${owner}:${island}`; }    // warehouse account id
  // get (lazily creating) a goods-holding account by id
  _inv(id) {
    let a = this.accounts.get(id);
    if (!a) a = this.createAccount(id, 0);
    return a;
  }
  // the account that holds `owner`'s tradable goods for `island`: the warehouse
  // when located, else the owner account (engine-default, location-agnostic).
  _goods(owner, island) {
    return this.located ? this._inv(this.whId(owner, island)) : this.acct(owner);
  }
  // mint/burn are the ONLY non-transfer unit movements (onboarding grants, NPC
  // seed stock, production). They keep mintedUnits in lockstep with totalUnits.
  mint(id, commodity, qty) {
    const a = this._inv(id);
    a.inv[commodity] = (a.inv[commodity] || 0) + qty;
    this.mintedUnits[commodity] = (this.mintedUnits[commodity] || 0) + qty;
  }
  burn(id, commodity, qty) {
    const a = this.acct(id);
    if ((a.inv[commodity] || 0) < qty) throw new Error(`insufficient ${commodity} to burn`);
    a.inv[commodity] -= qty;
    this.mintedUnits[commodity] = (this.mintedUnits[commodity] || 0) - qty;
  }

  // --- conservation checks (test/ops use these) ---
  totalPoe() { let t = 0; for (const a of this.accounts.values()) t += a.poe; return t; }
  totalUnits(c) { let t = 0; for (const a of this.accounts.values()) t += (a.inv[c] || 0); return t; }

  // --- book helpers ---
  bookKey(island, commodity) { return `${island}:${commodity}`; }
  book(island, commodity) {
    const k = this.bookKey(island, commodity);
    let b = this.books.get(k);
    if (!b) { b = { bids: [], asks: [], last: 0 }; this.books.set(k, b); }
    return b;
  }
  _sort(b) {
    b.bids.sort((x, y) => y.price - x.price || x.ts - y.ts); // best bid = highest, then oldest
    b.asks.sort((x, y) => x.price - y.price || x.ts - y.ts); // best ask = lowest, then oldest
  }

  // --- place a limit order: escrow, cross, rest remainder ---
  placeLimit(ownerId, island, commodity, side, price, qty) {
    if (!Number.isInteger(price) || price <= 0) throw new Error("price must be a positive integer");
    if (!Number.isInteger(qty) || qty <= 0) throw new Error("qty must be a positive integer");
    const a = this.acct(ownerId);
    const ESC = this.acct("ESCROW");

    // escrow up front so an order can never settle for funds/goods the owner lacks
    if (side === "buy") {
      const cost = price * qty;
      if (a.poe < cost) throw new Error("insufficient PoE to escrow buy");
      a.poe -= cost; ESC.poe += cost;
      this.ledger.postPair(ownerId, "ESCROW", cost, "escrow_buy");
    } else if (side === "sell") {
      const g = this._goods(ownerId, island);    // warehouse at this island when located
      if ((g.inv[commodity] || 0) < qty) throw new Error("insufficient goods to escrow sell");
      g.inv[commodity] -= qty; ESC.inv[commodity] = (ESC.inv[commodity] || 0) + qty;
    } else throw new Error("side must be buy or sell");

    const order = { id: ++this._oid, owner: ownerId, side, price, qty, island, commodity, ts: ++this._seq };
    this._match(order);
    if (order.qty > 0) {
      const b = this.book(island, commodity);
      (side === "buy" ? b.bids : b.asks).push(order);
      this._sort(b);
      this.openOrders.set(order.id, order);
    }
    return order;
  }

  _match(order) {
    const b = this.book(order.island, order.commodity);
    const opp = order.side === "buy" ? b.asks : b.bids;
    while (order.qty > 0 && opp.length) {
      const top = opp[0];
      const cross = order.side === "buy" ? order.price >= top.price : order.price <= top.price;
      if (!cross) break;
      const tpx = top.price;                       // resting order sets the price
      const q = Math.min(order.qty, top.qty);
      const buyOrder = order.side === "buy" ? order : top;
      const sellOrder = order.side === "buy" ? top : order;
      this._settle(buyOrder, sellOrder, order.commodity, tpx, q, order.island);
      order.qty -= q; top.qty -= q; b.last = tpx;
      this.trades.push({ island: order.island, commodity: order.commodity, price: tpx, qty: q, buyer: buyOrder.owner, seller: sellOrder.owner });
      if (top.qty <= 0) { opp.shift(); this.openOrders.delete(top.id); }
    }
  }

  // settle one fill of q units at price tpx between a buy order and a sell order,
  // both of which escrowed their side at placement.
  _settle(buyOrder, sellOrder, commodity, tpx, q, island) {
    const ESC = this.acct("ESCROW");
    const buyerPurse = this.acct(buyOrder.owner);
    const buyerGoods = this._goods(buyOrder.owner, island); // warehouse at this island when located
    const seller = this.acct(sellOrder.owner);

    // goods: seller's escrowed units -> buyer's goods store at this island
    ESC.inv[commodity] -= q;
    buyerGoods.inv[commodity] = (buyerGoods.inv[commodity] || 0) + q;

    // PoE: buyer escrowed at buyOrder.price; pay seller tpx*q, refund the overpay
    ESC.poe -= tpx * q; seller.poe += tpx * q;
    this.ledger.postPair("ESCROW", seller.id, tpx * q, "fill");
    const refund = (buyOrder.price - tpx) * q;     // 0 when buyer is the resting side
    if (refund > 0) {
      ESC.poe -= refund; buyerPurse.poe += refund;
      this.ledger.postPair("ESCROW", buyerPurse.id, refund, "price_improve_refund");
    }
  }

  cancel(orderId) {
    const order = this.openOrders.get(orderId);
    if (!order) return false;
    const b = this.book(order.island, order.commodity);
    const arr = order.side === "buy" ? b.bids : b.asks;
    const i = arr.indexOf(order);
    if (i >= 0) arr.splice(i, 1);
    const ESC = this.acct("ESCROW");
    if (order.side === "buy") {
      const back = order.price * order.qty;
      ESC.poe -= back; this.acct(order.owner).poe += back;
      this.ledger.postPair("ESCROW", order.owner, back, "cancel_refund");
    } else {
      ESC.inv[order.commodity] -= order.qty;
      const g = this._goods(order.owner, order.island); // back to the warehouse it came from
      g.inv[order.commodity] = (g.inv[order.commodity] || 0) + order.qty;
    }
    this.openOrders.delete(orderId);
    return true;
  }

  depth(island, commodity, n = 10) {
    const b = this.book(island, commodity);
    return {
      last: b.last,
      bids: b.bids.slice(0, n).map(o => ({ price: o.price, qty: o.qty })),
      asks: b.asks.slice(0, n).map(o => ({ price: o.price, qty: o.qty })),
    };
  }
}
