import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, RAIDER, SALVAGE_BPS } from "./market.mjs";
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

// (PillageRoom drives the turn-by-turn fight + calls hub.concludeBattle, which is the
// same market primitives exercised directly here — the economic substance of a battle.)

test("a raider spawns as a real enemy ship with cargo", () => {
  const ex = new Exchange();
  const m = new Market("isleA", { exchange: ex, now: () => 1 });
  const raider = m.spawnRaider("brig", "isleA", { rum: 10, shot: 4 });
  const s = ex.ships.get(raider);
  assert.equal(s.owner, RAIDER);
  assert.equal(s.cls, "brig");
  assert.equal(s.dockedAt, "isleA");
  assert.equal(ex.invOf(`hold:${raider}`, "rum"), 10);
  assert.equal(ex.invOf(`hold:${raider}`, "shot"), 4);
  assert.equal(checkAll(ex), null);
});

test("winning a battle: enemy sunk into a salvageable wreck + plunder to the victor", () => {
  const ex = new Exchange();
  const m = new Market("isleA", { exchange: ex, now: () => 1 });
  m.join("cap");
  const raider = m.spawnRaider("sloop", "isleA", { rum: 10, shot: 5 });
  const poe0 = m.balancesOf("cap").poe;

  // outcome of a player win (what hub.concludeBattle("player", ...) applies):
  m.award("cap", 500);          // plunder
  m.resolveShip(raider, 0);     // sink the raider -> wreck at isleA

  assert.equal(ex.ships.has(raider), false, "raider sunk");
  assert.equal(m.balancesOf("cap").poe, poe0 + 500, "plunder paid");
  assert.equal(m.wreckHere().rum, Math.floor(10 * SALVAGE_BPS / 10000), "enemy rum salvageable");
  assert.equal(m.wreckHere().shot, Math.floor(5 * SALVAGE_BPS / 10000), "enemy shot salvageable");
  // the victor can recover the spoils
  m.salvage("cap", "rum", 99);
  assert.ok((m.balancesOf("cap").holdings.rum || 0) >= Math.floor(10 * SALVAGE_BPS / 10000));
  assert.equal(checkAll(ex), null);
});

test("losing a battle: the player's ship is sunk (loss-on-sinking), cargo lost/salvageable", () => {
  const ex = new Exchange();
  const m = new Market("isleA", { exchange: ex, now: () => 1 });
  m.join("cap");
  const ship = m.balancesOf("cap").ships[0];
  m.loadCargo("cap", ship.id, "rum", 8);
  const supply0 = ex.totalUnits("rum");

  m.resolveShip(ship.id, 0); // what concludeBattle("enemy", ...) applies

  assert.equal(m.balancesOf("cap").ships.length, 0, "player ship lost");
  assert.equal(m.wreckHere().rum, Math.floor(8 * SALVAGE_BPS / 10000), "some cargo washed up");
  assert.ok(ex.totalUnits("rum") < supply0, "the rest was lost");
  assert.equal(checkAll(ex), null);
});

test("raider spawn + its defeat survive a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleA", { exchange: ex1, store, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("cap"); await m.flush();
  const raider = m.spawnRaider("sloop", "isleA", { rum: 10 }); await m.flush();
  m.award("cap", 500); await m.flush();
  m.resolveShip(raider, 0); await m.flush(); // defeat it -> wreck

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleA", { exchange: ex2, now });

  assert.equal(ex2.ships.has(raider), false, "raider stays sunk");
  assert.equal(ex2.invOf("wreck:isleA", "rum"), Math.floor(10 * SALVAGE_BPS / 10000), "wreck rebuilt");
  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE conserved (incl. plunder)");
  assert.deepEqual(m2.balancesOf("cap"), m.balancesOf("cap"), "victor view identical");
  assert.equal(checkAll(ex2), null);
});
