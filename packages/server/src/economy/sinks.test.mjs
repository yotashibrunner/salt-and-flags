import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import {
  Market, replay, CROWN, SHIP_HULL, REPAIR_PER_HULL,
  UPKEEP_PERIOD_MS, UPKEEP_STALL, UPKEEP_SHIP,
} from "./market.mjs";
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

const split = (amt) => [Math.floor(amt * 0.6), amt - Math.floor(amt * 0.6)]; // [crown, flag]

test("listing fee drains the placer, split 60% crown / 40% controlling flag", () => {
  const m = new Market("isleA", { flag: "wardens", listingFeeBps: 100, now: () => 1 }); // 1%
  m.join("p1");
  const before = m.balancesOf("p1").poe;
  // a resting sell well above the bids: no fill, so we isolate the fee (notional 50*10=500 -> fee 5)
  m.placeLimit("p1", "rum", "sell", 50, 10);
  const [crown, flag] = split(5);
  assert.equal(before - m.balancesOf("p1").poe, 5, "1% listing fee charged");
  assert.equal(m.ex.poeOf(CROWN), crown, "60% burned to the crown");
  assert.equal(m.ex.poeOf("wardens"), flag, "40% to the controlling flag");
  assert.equal(checkAll(m.ex), null);
});

test("on an unflagged island the whole fee is burned to the crown", () => {
  const m = new Market("isleN", { listingFeeBps: 100, now: () => 1 }); // no flag
  m.join("p1");
  m.placeLimit("p1", "rum", "sell", 50, 10); // fee 5
  assert.equal(m.ex.poeOf(CROWN), 5, "no flag -> all to crown");
  assert.equal(checkAll(m.ex), null);
});

test("upkeep charges rent per elapsed cycle for stalls + ships, split crown/flag", () => {
  let clock = 0;
  const m = new Market("isleA", { flag: "wardens", now: () => clock });
  m.join("p1");          // 1 sloop docked here
  m.build("p1", "distill"); // 1 stall here (its 150 levy -> wardens is separate from rent)
  const flagAfterBuild = m.ex.poeOf("wardens");

  assert.deepEqual(m.tickUpkeep(), [], "first tick just starts the clock");
  const before = m.balancesOf("p1").poe;

  clock += 2 * UPKEEP_PERIOD_MS + 123; // two whole cycles (+ partial, which doesn't count)
  assert.deepEqual(m.tickUpkeep(), ["p1"]);
  const due = 2 * (UPKEEP_STALL * 1 + UPKEEP_SHIP * 1); // 2 * (5 + 3) = 16
  const [crown, flag] = split(due);
  assert.equal(before - m.balancesOf("p1").poe, due, "two cycles of rent on a stall + a ship");
  assert.equal(m.ex.poeOf(CROWN), crown, "60% burned");
  assert.equal(m.ex.poeOf("wardens"), flagAfterBuild + flag, "40% to the flag (on top of the build levy)");

  assert.deepEqual(m.tickUpkeep(), [], "no whole cycle elapsed -> no charge");
  assert.equal(checkAll(m.ex), null);
});

test("repair restores hull at port and drains PoE (split crown/flag)", () => {
  const m = new Market("isleA", { flag: "wardens", now: () => 1 });
  m.join("p1");
  const ship = m.balancesOf("p1").ships[0];
  assert.equal(ship.hull, SHIP_HULL.sloop);

  m.resolveShip(ship.id, 10);             // battle left it at 10/16
  assert.equal(m.balancesOf("p1").ships[0].hull, 10);
  assert.throws(() => new Market("other", { now: () => 1 }).repairShip("p1", ship.id), /no such ship|not your ship/);

  const before = m.balancesOf("p1").poe;
  const paid = m.repairShip("p1", ship.id);
  const cost = (SHIP_HULL.sloop - 10) * REPAIR_PER_HULL; // 6 * 4 = 24
  assert.equal(paid, cost);
  assert.equal(m.balancesOf("p1").ships[0].hull, SHIP_HULL.sloop, "fully repaired");
  assert.equal(before - m.balancesOf("p1").poe, cost);
  assert.equal(m.ex.poeOf(CROWN), Math.floor(cost * 0.6));
  assert.throws(() => m.repairShip("p1", ship.id), /already full/);
  assert.equal(checkAll(m.ex), null);
});

test("loss-on-sinking: a sunk ship's cargo is burned and the ship is removed", () => {
  const m = new Market("isleA", { now: () => 1 });
  m.join("p1");
  const ship = m.balancesOf("p1").ships[0];
  m.loadCargo("p1", ship.id, "rum", 10);
  const rumBefore = m.totalUnits("rum");

  m.resolveShip(ship.id, 0); // hull <= 0 -> SINK

  assert.equal(m.balancesOf("p1").ships.length, 0, "the ship is gone");
  assert.equal(m.totalUnits("rum"), rumBefore - 10, "the hold's cargo was burned (a goods sink)");
  assert.equal(m.ex.accounts.has(`hold:${ship.id}`), false, "no orphan hold account left behind");
  assert.equal(checkAll(m.ex), null, "no orphan_hold / units stay reconciled");
});

test("all four sinks survive a restart: fee, upkeep, repair, and a sinking replay identically", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq;
  let clock = 0; const now = () => clock;

  const ex1 = new Exchange();
  const m = new Market("isleA", { exchange: ex1, store, flag: "wardens", taxRate: 0.05, listingFeeBps: 100, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("p1"); await m.flush();
  const ship = m.balancesOf("p1").ships[0];

  m.placeLimit("p1", "rum", "sell", 50, 10); await m.flush(); // fee
  m.build("p1", "distill"); await m.flush();                   // a stall to pay rent on
  m.tickUpkeep(); await m.flush();                             // start the upkeep clock
  clock += 3 * UPKEEP_PERIOD_MS;
  m.tickUpkeep(); await m.flush();                             // charge 3 cycles
  m.resolveShip(ship.id, 9); await m.flush();                  // battle damage
  m.repairShip("p1", ship.id); await m.flush();                // repair (drain)
  m.loadCargo("p1", ship.id, "iron", 5); await m.flush();      // cargo aboard
  m.resolveShip(ship.id, 0); await m.flush();                  // SINK -> burns the 5 iron, removes the ship

  // restart
  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleA", { exchange: ex2, flag: "wardens", now });

  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE preserved");
  assert.equal(ex2.poeOf(CROWN), ex1.poeOf(CROWN), "crown (burned) balance preserved");
  assert.equal(ex2.poeOf("wardens"), ex1.poeOf("wardens"), "flag treasury preserved");
  assert.deepEqual(ex2.mintedUnits, ex1.mintedUnits, "minted-units (net of the sink burn) preserved");
  assert.equal(ex2.totalUnits("iron"), ex1.totalUnits("iron"), "burned cargo stays burned");
  assert.deepEqual(m2.balancesOf("p1"), m.balancesOf("p1"), "p1 view identical (no ship, drained PoE)");
  assert.equal(m2.balancesOf("p1").ships.length, 0, "sunk ship did not come back");
  assert.equal(checkAll(ex2), null, "all invariants hold on the rebuilt engine");
});
