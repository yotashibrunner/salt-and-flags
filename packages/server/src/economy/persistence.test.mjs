import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, LABOR_START } from "./market.mjs";

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
