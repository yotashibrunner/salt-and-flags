import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, voyageEncounter, SHIP_HULL } from "./market.mjs";
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

// Find a departAt that makes voyageEncounter safe / sink for a given danger+hull, so the
// tests are deterministic without hard-coding the hash.
function findDepart(shipId, danger, hull, maxHull, want) {
  for (let t = 1; t < 100000; t++) {
    const r = voyageEncounter(shipId, t, danger, hull, maxHull);
    if (want === "safe" && !r.hit) return t;
    if (want === "sink" && r.sunk) return t;
    if (want === "hit" && r.hit && !r.sunk) return t;
  }
  throw new Error(`no ${want} departAt found`);
}

test("a voyage is real: the ship is AT SEA until it arrives, and can't act in transit", () => {
  let clock = findDepart("s1", 0, SHIP_HULL.sloop, SHIP_HULL.sloop, "safe"); // danger 0 -> always safe
  const ex = new Exchange();
  const A = new Market("A", { exchange: ex, now: () => clock });
  const B = new Market("B", { exchange: ex, now: () => clock });
  A.seedLiquidity(); B.seedLiquidity();
  A.join("cap");
  const ship = A.balancesOf("cap").ships[0];
  A.loadCargo("cap", ship.id, "rum", 5);

  const { arriveAt } = A.moveShip("cap", ship.id, "B", 5, 0);
  assert.ok(arriveAt > clock, "voyage takes time");
  const atSea = A.balancesOf("cap").ships[0];
  assert.equal(atSea.dockedAt, null, "no longer docked");
  assert.deepEqual({ from: atSea.voyage.from, to: atSea.voyage.to }, { from: "A", to: "B" });
  assert.throws(() => A.loadCargo("cap", ship.id, "rum", 1), /not docked here/);
  assert.throws(() => B.unloadCargo("cap", ship.id, "rum", 1), /not docked here/);
  assert.throws(() => A.moveShip("cap", ship.id, "B", 5, 0), /already at sea/);

  // not arrived yet
  clock = arriveAt - 1; assert.equal(A.tickVoyages().length, 0, "not due yet");
  // arrives
  clock = arriveAt; const arrived = A.tickVoyages();
  assert.equal(arrived.length, 1);
  const landed = B.balancesOf("cap").ships[0];
  assert.equal(landed.dockedAt, "B", "docked at the destination");
  assert.equal(landed.voyage, null);
  assert.equal(landed.hold.rum, 5, "cargo rode along safely (danger 0)");
  assert.equal(checkAll(ex), null);
});

test("a transit encounter can sink a ship — cargo lost, ship gone (loss-on-sinking via sailing)", () => {
  const ex = new Exchange();
  let clock = 1;
  const A = new Market("A", { exchange: ex, now: () => clock });
  new Market("B", { exchange: ex, now: () => clock });
  A.seedLiquidity();
  A.join("cap");
  const ship = A.balancesOf("cap").ships[0];
  A.loadCargo("cap", ship.id, "rum", 8);
  const rumBefore = ex.totalUnits("rum");

  // a single encounter does 20%..60% of MAX hull, so a full ship is only damaged — it
  // takes a battered ship to be sunk. Reflect that: bring it in already wounded.
  A.resolveShip(ship.id, 3); // hull 3/16
  clock = findDepart(ship.id, 1, 3, SHIP_HULL.sloop, "sink");
  const { arriveAt } = A.moveShip("cap", ship.id, "B", 5, 1); // danger 1 = certain encounter
  clock = arriveAt;
  const arrived = A.tickVoyages();
  assert.equal(arrived[0].sunk, true, "the ship was sunk in transit");
  assert.equal(A.balancesOf("cap").ships.length, 0, "ship gone");
  // of 8 rum: 40% (3) washes up as a wreck at the destination B, the rest (5) is lost
  assert.equal(ex.totalUnits("rum"), rumBefore - 5, "most cargo lost; the salvageable share survives");
  assert.equal(ex.invOf("wreck:B", "rum"), 3, "salvage washed up at the voyage destination");
  assert.equal(ex.accounts.has(`hold:${ship.id}`), false, "no orphan hold");
  assert.equal(checkAll(ex), null);
});

test("voyages + transit encounters survive a restart (deterministic, replay-safe)", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq;
  let clock = 1; const now = () => clock;

  const ex1 = new Exchange();
  const A = new Market("A", { exchange: ex1, store, flag: "wardens", nextSeq, now });
  const B = new Market("B", { exchange: ex1, store, nextSeq, now });
  A.seedLiquidity(); await A.flush();
  B.seedLiquidity(); await B.flush();
  A.join("cap"); await A.flush();
  const ship = A.balancesOf("cap").ships[0];
  A.loadCargo("cap", ship.id, "rum", 6); await A.flush();

  // a voyage that takes a hit (damage, not sink) at moderate danger
  clock = findDepart(ship.id, 0.9, SHIP_HULL.sloop, SHIP_HULL.sloop, "hit");
  const { arriveAt } = A.moveShip("cap", ship.id, "B", 6, 0.9); await A.flush();
  clock = arriveAt; A.tickVoyages(); await A.flush();

  const liveShip = B.balancesOf("cap").ships[0];
  assert.equal(liveShip.dockedAt, "B");
  assert.ok(liveShip.hull < liveShip.maxHull, "took transit damage");

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("B", { exchange: ex2, now });

  assert.deepEqual(m2.balancesOf("cap"), B.balancesOf("cap"), "ship position + damaged hull + hold rebuilt identically");
  assert.equal(ex2.totalUnits("rum"), ex1.totalUnits("rum"), "supply preserved");
  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE conserved across the restart");
  assert.equal(checkAll(ex2), null);
});