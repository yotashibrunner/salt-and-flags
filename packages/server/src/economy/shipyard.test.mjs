import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, CROWN, SHIP_PRICE, NEW_PLAYER_POE } from "./market.mjs";
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

test("the free starter sloop is one-time: rejoining never grants another", () => {
  const m = new Market("isleA", { now: () => 1 });
  m.join("p1");
  assert.equal(m.balancesOf("p1").ships.length, 1, "starter sloop granted once");
  const poe = m.balancesOf("p1").poe;
  m.join("p1"); // rejoin
  assert.equal(m.balancesOf("p1").ships.length, 1, "no second free ship on rejoin");
  assert.equal(m.balancesOf("p1").poe, poe, "no second goods grant either");
  assert.equal(checkAll(m.ex), null);
});

test("buying a ship costs PoE as a sink (split crown/flag) and docks a fresh hull here", () => {
  const m = new Market("isleA", { flag: "wardens", now: () => 1 });
  m.join("p1");
  const before = m.balancesOf("p1").poe;
  assert.throws(() => m.buyShip("p1", "galleon"), /insufficient PoE/); // 3600 > 1000 start
  assert.throws(() => m.buyShip("p1", "dinghy"), /unknown ship class/);

  const id = m.buyShip("p1", "sloop"); // 300
  assert.equal(before - m.balancesOf("p1").poe, SHIP_PRICE.sloop, "paid the sloop price");
  assert.equal(m.ex.poeOf(CROWN), Math.floor(SHIP_PRICE.sloop * 0.6), "60% burned to crown");
  assert.equal(m.ex.poeOf("wardens"), SHIP_PRICE.sloop - Math.floor(SHIP_PRICE.sloop * 0.6), "40% to the flag");
  const ships = m.balancesOf("p1").ships;
  assert.equal(ships.length, 2, "now owns the starter + the bought ship");
  const bought = ships.find((s) => s.id === id);
  assert.equal(bought.dockedAt, "isleA");
  assert.equal(bought.hull, bought.maxHull, "fresh hull");
  assert.equal(checkAll(m.ex), null);
});

test("loss-on-sinking has real stakes: no free respawn, you must buy a replacement", () => {
  const m = new Market("isleA", { now: () => 1 });
  m.join("p1");
  const ship = m.balancesOf("p1").ships[0];

  m.resolveShip(ship.id, 0); // sunk
  assert.equal(m.balancesOf("p1").ships.length, 0, "ship lost");

  m.join("p1"); // come back to port
  assert.equal(m.balancesOf("p1").ships.length, 0, "NO free replacement (the fix)");

  // the only way back is to pay the shipyard
  const id = m.buyShip("p1", "sloop");
  assert.equal(m.balancesOf("p1").ships.length, 1, "bought a replacement");
  assert.equal(m.balancesOf("p1").ships[0].id, id);
  assert.equal(checkAll(m.ex), null);
});

test("shipyard purchases + the one-time starter survive a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleA", { exchange: ex1, store, flag: "wardens", nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("p1"); await m.flush();              // starter sloop (onboard)
  const starter = m.balancesOf("p1").ships[0].id;
  m.buyShip("p1", "brig"); await m.flush();    // a second, bought hull
  m.resolveShip(starter, 0); await m.flush();  // sink the starter
  m.join("p1"); await m.flush();               // rejoin -> must NOT respawn a ship

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleA", { exchange: ex2, flag: "wardens", now });

  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE preserved");
  assert.equal(ex2.poeOf(CROWN), ex1.poeOf(CROWN), "shipyard burn preserved");
  assert.deepEqual(m2.balancesOf("p1"), m.balancesOf("p1"), "p1 view identical across the restart");
  assert.equal(m2.balancesOf("p1").ships.length, 1, "only the bought brig remains (starter sunk, no respawn)");
  assert.equal(m2.balancesOf("p1").ships[0].cls, "brig");
  assert.equal(checkAll(ex2), null);
});
