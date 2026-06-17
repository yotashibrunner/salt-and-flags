import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, LABOR_START } from "./market.mjs";
import { checkAll } from "./invariants.mjs";

// A complete picture of LOCATED state: every ship's position + hold contents, and
// every warehouse's stock. Acceptance criterion 5 is that this rebuilds identically
// from an empty engine by replaying the intent log.
function locatedSnapshot(ex) {
  const ships = {};
  for (const [id, s] of ex.ships) {
    const hold = ex.accounts.get(`hold:${id}`);
    ships[id] = { owner: s.owner, cls: s.cls, dockedAt: s.dockedAt, hold: { ...(hold ? hold.inv : {}) } };
  }
  const warehouses = {};
  for (const a of ex.accounts.values()) {
    if (a.id.startsWith("wh:")) warehouses[a.id] = { ...a.inv };
  }
  return { ships, warehouses };
}

// In-memory double of the Store interface (PgStore is the real Postgres impl).
class MemStore {
  constructor() { this.intents = []; this.trades = []; this.ledger = []; }
  async persist(batch) {
    for (const i of batch.intents) this.intents.push(i);
    for (const t of batch.trades) this.trades.push(t);
    for (const l of batch.ledger) this.ledger.push(l);
  }
  async loadIntents() { return this.intents.slice(); }
}

test("state survives a restart: replaying the intent log rebuilds identical books + balances", async () => {
  const store = new MemStore();
  let seq = 0;
  const nextSeq = () => ++seq;
  const now = () => 1_000_000; // frozen clock so labor regen is deterministic across the "restart"
  const island = "isleX";

  // --- live session 1: seed, two players, a crossing trade, a rest + cancel ---
  const ex1 = new Exchange();
  const m = new Market(island, { exchange: ex1, store, produces: ["iron"], demands: ["rum"], flag: "wardens", taxRate: 0.05, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("p1"); await m.flush();
  m.join("p2"); await m.flush();

  // p2 rests a rum sell inside the NPC spread; p1 crosses it (player <-> player)
  const px = m.depth("rum").bids[0].price + 1;
  assert.ok(px < m.depth("rum").asks[0].price, "price sits inside the NPC spread");
  m.placeLimit("p2", "rum", "sell", px, 5); await m.flush();
  m.placeLimit("p1", "rum", "buy", px, 5); await m.flush();

  // p1 rests a low buy then cancels it (escrow out then back)
  const o = m.placeLimit("p1", "rum", "buy", 2, 3); await m.flush();
  m.cancel("p1", o.id); await m.flush();

  // p1 leaves a resting iron buy open (must come back after restart)
  m.placeLimit("p1", "iron", "buy", 3, 4); await m.flush();

  // p2 builds a stall then runs production (levy->flag, burns sugar + labor, mints
  // rum) — stall ownership, the flag levy, and the produce must all replay
  m.build("p2", "distill"); await m.flush();
  m.produce("p2", "distill"); await m.flush();

  // both pledge to the flag and p1 triggers a payout — membership + the split must replay
  m.pledge("p1"); await m.flush();
  m.pledge("p2"); await m.flush();
  m.payout("p1"); await m.flush();

  // audit projections were written
  assert.ok(store.intents.length > 0, "intents recorded");
  assert.ok(store.trades.length > 0, "trades projected");
  assert.ok(store.ledger.length > 0, "ledger projected");

  // --- simulate a restart: fresh engine, replay the persisted log ---
  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market(island, { exchange: ex2, flag: "wardens", now }); // read-only view (same flag + clock)

  // conservation across the restart
  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "total PoE preserved");
  assert.equal(ex2.totalUnits("rum"), ex1.totalUnits("rum"), "rum units preserved");
  assert.equal(ex2.totalUnits("iron"), ex1.totalUnits("iron"), "iron units preserved");
  assert.equal(ex2.ledger.sum(), 0, "rebuilt ledger is zero-sum");

  // identical books and balances
  assert.deepEqual(m2.depth("rum"), m.depth("rum"), "rum book identical");
  assert.deepEqual(m2.depth("iron"), m.depth("iron"), "iron book identical");
  assert.deepEqual(m2.balancesOf("p1"), m.balancesOf("p1"), "p1 balances identical");
  assert.deepEqual(m2.balancesOf("p2"), m.balancesOf("p2"), "p2 balances identical");

  // production replayed too: p2 spent labor and holds the rum it distilled
  assert.equal(m2.balancesOf("p2").labor, LABOR_START - 4, "p2 labor (distill cost) survived");
  // stall ownership + the flag's build levy survived the restart
  assert.deepEqual(m2.balancesOf("p2").stalls, ["distill"], "p2's stall survived");
  assert.equal(ex2.poeOf("wardens"), ex1.poeOf("wardens"), "flag treasury preserved (levy + tax - payout)");
  assert.equal(m2.balancesOf("p1").pledged, true, "p1's pledge survived");
  assert.equal(m2.balancesOf("p2").pledged, true, "p2's pledge survived");

  // the resting iron buy (the only thing p1 left open) came back intact
  const p1orders = m2.balancesOf("p1").orders;
  assert.equal(p1orders.length, 1);
  assert.equal(p1orders[0].commodity, "iron");
  assert.equal(p1orders[0].side, "buy");
  assert.equal(p1orders[0].price, 3);
  assert.equal(p1orders[0].qty, 4);

  // --- the rehydrated book is live: a new player can hit a restored NPC ask ---
  m2.join("p3");
  const ask = m2.depth("iron").asks[0].price;
  m2.placeLimit("p3", "iron", "buy", ask, 1);
  assert.equal(m2.balancesOf("p3").holdings.iron, 26, "p3 bought 1 iron from the restored book");
  assert.equal(m2.depth("iron").last, ask, "last price updates on the rehydrated book");
});

test("conquest survives a restart: the seized island stays under its conqueror", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleZ", { exchange: ex1, store, flag: "sash", taxRate: 0.1, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("cap"); await m.flush();
  m.pledge("cap", "wardens"); await m.flush();
  m.seize("cap", "wardens"); await m.flush(); // isleZ flips sash -> wardens
  assert.equal(m.flag, "wardens");
  const warchest1 = ex1.poeOf("warchest");
  const capPoe1 = m.balancesOf("cap").poe;

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleZ", { exchange: ex2, flag: "sash", now }); // same INITIAL flag

  assert.equal(m2.flag, "wardens", "conquest replayed — island still held by wardens");
  assert.equal(ex2.poeOf("warchest"), warchest1, "warchest preserved");
  assert.equal(m2.balancesOf("cap").poe, capPoe1, "captain's post-conquest PoE preserved");
  assert.equal(m2.totalPoe(), m.totalPoe(), "PoE conserved across the restart");
});

test("plunder survives a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isle", { exchange: ex1, store, nextSeq, now });
  m.join("hero"); await m.flush();
  m.award("hero", 500); await m.flush();
  const heroPoe1 = m.balancesOf("hero").poe; // 1000 start + 500 plunder

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isle", { exchange: ex2, now });

  assert.equal(m2.balancesOf("hero").poe, heroPoe1, "plunder replayed");
  assert.equal(ex2.poeOf("bounty"), ex1.poeOf("bounty"), "bounty reserve preserved");
});

test("a fresh log replays to an empty (but valid) exchange", () => {
  const ex = new Exchange();
  replay(ex, []);
  assert.equal(ex.totalPoe(), 0);
  assert.equal(ex.ledger.sum(), 0);
});

test("LOCATED state survives a restart: ships at different ports, partial holds, and per-island warehouses all rebuild IDENTICALLY", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq;
  const now = () => 5_000_000; // frozen clock so labor + produce replay deterministically

  // --- live session: three islands sharing one engine, three captains ---
  const ex1 = new Exchange();
  const opts = { exchange: ex1, store, nextSeq, now };
  const isleA = new Market("isleA", { ...opts, produces: ["iron"], demands: ["rum"], flag: "wardens", taxRate: 0.05 });
  const isleB = new Market("isleB", { ...opts });
  const isleC = new Market("isleC", { ...opts });
  for (const m of [isleA, isleB, isleC]) { m.seedLiquidity(); await m.flush(); }

  // captains home at DIFFERENT ports -> their starter sloops dock in different places
  isleA.join("p1"); await isleA.flush();
  isleB.join("p2"); await isleB.flush();
  isleA.join("p3"); await isleA.flush();
  const s1 = isleA.balancesOf("p1").ships[0].id;
  const s2 = isleB.balancesOf("p2").ships[0].id;
  const s3 = isleA.balancesOf("p3").ships[0].id;

  // p1: partially load at A, SAIL to C, partially unload there (hold stays partial)
  isleA.loadCargo("p1", s1, "rum", 7); await isleA.flush();
  isleA.loadCargo("p1", s1, "iron", 3); await isleA.flush();
  isleA.moveShip("p1", s1, "isleC"); await isleA.flush();
  isleC.unloadCargo("p1", s1, "rum", 2); await isleC.flush();   // wh:p1:isleC gets 2 rum

  // p2: load at B, sail to A, unload SOME (hold keeps a remainder)
  isleB.loadCargo("p2", s2, "cloth", 5); await isleB.flush();
  isleB.moveShip("p2", s2, "isleA"); await isleB.flush();
  isleA.unloadCargo("p2", s2, "cloth", 3); await isleA.flush(); // hold keeps cloth 2

  // p3: a taxed sale + located production, then load a little and stay docked at A
  const bid = isleA.depth("rum").bids[0].price;
  isleA.placeLimit("p3", "rum", "sell", bid, 4); await isleA.flush();
  isleA.build("p3", "distill"); await isleA.flush();
  isleA.produce("p3", "distill"); await isleA.flush();          // -3 sugar, +2 rum in wh:p3:isleA
  isleA.loadCargo("p3", s3, "sugar", 2); await isleA.flush();

  // sanity: the live located state is genuinely rich (guards against a vacuous pass)
  const snap1 = locatedSnapshot(ex1);
  assert.deepEqual(snap1.ships[s1], { owner: "p1", cls: "sloop", dockedAt: "isleC", hold: { rum: 5, iron: 3 } });
  assert.deepEqual(snap1.ships[s2], { owner: "p2", cls: "sloop", dockedAt: "isleA", hold: { cloth: 2 } });
  assert.deepEqual(snap1.ships[s3], { owner: "p3", cls: "sloop", dockedAt: "isleA", hold: { sugar: 2 } });
  assert.equal(snap1.warehouses[ex1.whId("p1", "isleA")].rum, 18);  // 25 - 7 loaded
  assert.equal(snap1.warehouses[ex1.whId("p1", "isleA")].iron, 22); // 25 - 3 loaded
  assert.equal(snap1.warehouses[ex1.whId("p1", "isleC")].rum, 2);   // unloaded at C
  assert.equal(snap1.warehouses[ex1.whId("p2", "isleB")].cloth, 20); // 25 - 5 loaded
  assert.equal(snap1.warehouses[ex1.whId("p2", "isleA")].cloth, 3);  // unloaded at A
  assert.equal(snap1.warehouses[ex1.whId("p3", "isleA")].rum, 23);   // 25 - 4 sold + 2 produced
  assert.equal(snap1.warehouses[ex1.whId("p3", "isleA")].sugar, 20); // 25 - 3 produced - 2 loaded

  // --- restart: replay the full intent log into a fresh, empty engine ---
  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());

  // THE acceptance check: every ship position, hold, and warehouse rebuilt identically
  assert.deepEqual(locatedSnapshot(ex2), snap1, "located state must rebuild byte-for-byte");

  // and the player-facing views match across islands (holdings here + the whole fleet)
  const a2 = new Market("isleA", { exchange: ex2, flag: "wardens", taxRate: 0.05, now });
  const b2 = new Market("isleB", { exchange: ex2, now });
  const c2 = new Market("isleC", { exchange: ex2, now });
  assert.deepEqual(a2.balancesOf("p1"), isleA.balancesOf("p1"), "p1 @ isleA view identical");
  assert.deepEqual(c2.balancesOf("p1"), isleC.balancesOf("p1"), "p1 @ isleC view identical");
  assert.deepEqual(b2.balancesOf("p2"), isleB.balancesOf("p2"), "p2 @ isleB view identical");
  assert.deepEqual(a2.balancesOf("p3"), isleA.balancesOf("p3"), "p3 @ isleA view identical");

  // conservation + every invariant holds on the rebuilt engine
  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE preserved");
  for (const c of ["rum", "iron", "cloth", "sugar"]) {
    assert.equal(ex2.totalUnits(c), ex1.totalUnits(c), `${c} units preserved`);
  }
  assert.equal(ex2.minted, ex1.minted, "minted PoE baseline preserved");
  assert.deepEqual(ex2.mintedUnits, ex1.mintedUnits, "minted units baseline preserved");
  assert.equal(checkAll(ex2), null, "all invariants hold after replay");
});
