import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, SALVAGE_BPS } from "./market.mjs";
import { checkAll } from "./invariants.mjs";

class MemStore {
  constructor() { this.intents = []; this.trades = []; this.ledger = []; }
  async persist(b) {
    for (const i of b.intents) this.intents.push(i);
    for (const t of b.trades) this.trades.push(t);
    for (const l of b.ledger) this.ledger.push(l);
  }
  async loadIntents() { return this.intents.slice(); }
}

test("a sinking leaves a salvageable wreck; another captain recovers it", () => {
  const ex = new Exchange();
  const m = new Market("isleA", { exchange: ex, now: () => 1 });
  m.join("victim");
  m.join("scavenger");
  const ship = m.balancesOf("victim").ships[0];
  m.loadCargo("victim", ship.id, "rum", 10);
  const supply0 = ex.totalUnits("rum");

  m.resolveShip(ship.id, 0); // sunk while docked at isleA

  const salvageable = Math.floor(10 * SALVAGE_BPS / 10000); // 4
  assert.equal(m.wreckHere().rum, salvageable, "40% washed up as a wreck");
  assert.equal(ex.totalUnits("rum"), supply0 - (10 - salvageable), "the rest was lost to the deep");

  // a different captain at the island salvages it into their own warehouse
  const before = m.balancesOf("scavenger").holdings.rum || 0;
  const got = m.salvage("scavenger", "rum", 100); // asks for more than exists -> clamps
  assert.equal(got, salvageable, "salvaged what the wreck held");
  assert.equal(m.balancesOf("scavenger").holdings.rum, before + salvageable, "into the scavenger's warehouse");
  assert.equal(m.wreckHere().rum ?? 0, 0, "wreck emptied");
  assert.throws(() => m.salvage("scavenger", "rum", 1), /no rum to salvage/);
  assert.equal(checkAll(ex), null);
});

test("a transit sinking drops the wreck at the voyage's destination port", () => {
  const ex = new Exchange();
  let clock = 1; const now = () => clock;
  const A = new Market("A", { exchange: ex, now });
  const B = new Market("B", { exchange: ex, now });
  A.seedLiquidity(); B.seedLiquidity();
  A.join("cap");
  const ship = A.balancesOf("cap").ships[0];
  A.loadCargo("cap", ship.id, "rum", 10);
  A.resolveShip(ship.id, 2); // wound it so the encounter will finish it

  // danger 1 guarantees a hit; a 2-hull sloop is sunk by any hit's >=4 damage
  const { arriveAt } = A.moveShip("cap", ship.id, "B", 5, 1);
  clock = arriveAt;
  A.tickVoyages();
  assert.equal(A.balancesOf("cap").ships.length, 0, "sunk in transit");
  assert.equal(ex.invOf("wreck:B", "rum"), Math.floor(10 * SALVAGE_BPS / 10000), "wreck at the destination B");
  assert.equal(B.wreckHere().rum, Math.floor(10 * SALVAGE_BPS / 10000), "salvageable at B");
  assert.equal(checkAll(ex), null);
});

test("wreck + salvage survive a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleA", { exchange: ex1, store, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("victim"); await m.flush();
  m.join("scav"); await m.flush();
  const ship = m.balancesOf("victim").ships[0];
  m.loadCargo("victim", ship.id, "iron", 10); await m.flush();
  m.resolveShip(ship.id, 0); await m.flush();           // wreck: 4 iron
  m.salvage("scav", "iron", 3); await m.flush();         // leave 1 in the wreck

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleA", { exchange: ex2, now });

  assert.equal(ex2.invOf("wreck:isleA", "iron"), 1, "remaining wreck rebuilt");
  assert.equal(m2.balancesOf("scav").holdings.iron, 25 + 3, "salvaged goods rebuilt (25 starter + 3 salvaged)");
  assert.equal(ex2.totalUnits("iron"), ex1.totalUnits("iron"), "supply preserved");
  assert.deepEqual(m2.balancesOf("scav"), m.balancesOf("scav"), "scavenger view identical");
  assert.equal(checkAll(ex2), null);
});
