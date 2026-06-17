import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, DEMAND, DEMAND_CAP, CROWN } from "./market.mjs";
import { checkAll } from "./invariants.mjs";

// In-memory Store double (same shape PgStore implements).
class MemStore {
  constructor() { this.intents = []; this.trades = []; this.ledger = []; }
  async persist(b) {
    for (const i of b.intents) this.intents.push(i);
    for (const t of b.trades) this.trades.push(t);
    for (const l of b.ledger) this.ledger.push(l);
  }
  async loadIntents() { return this.intents.slice(); }
}

test("demand burns finished goods sold into it and pays the seller (loop's exit)", () => {
  const m = new Market("isleB", { demands: ["rum"], now: () => 1 }); // demands rum
  m.join("p1");

  // a demand burn-bid exists at the premium price, capped at DEMAND_CAP
  const px = m.seedPrice("rum");
  const book = m.depth("rum");
  assert.equal(book.bids[0].price, px, "demand sets the best bid at the demand price");
  assert.equal(m._demandResting("rum"), DEMAND_CAP, "resting demand starts at the cap");

  const rumBefore = m.totalUnits("rum");
  const p1PoeBefore = m.balancesOf("p1").poe;
  const p1RumBefore = m.balancesOf("p1").holdings.rum;

  m.placeLimit("p1", "rum", "sell", px, 8); // sell into the demand bid

  assert.equal(m.balancesOf("p1").holdings.rum, p1RumBefore - 8, "player's rum left their warehouse");
  assert.equal(m.balancesOf("p1").poe, p1PoeBefore + px * 8, "player paid the demand price");
  assert.equal(m.totalUnits("rum"), rumBefore - 8, "8 rum were BURNED — total supply dropped");
  assert.equal(m.ex.invOf(m.ex.whId(DEMAND, "isleB"), "rum"), 0, "demand reserve keeps nothing");
  assert.equal(m._demandResting("rum"), DEMAND_CAP - 8, "demand bid drew down by the fill");
  assert.equal(checkAll(m.ex), null, "all invariants (incl. demand_burns + units_reconciled) hold");
});

test("demand is bounded by the cap, and refills on restock", () => {
  const m = new Market("isleB", { demands: ["rum"], newPlayerInv: { rum: 1000 }, now: () => 1 });
  m.join("p1");
  const px = m.seedPrice("rum");

  // drain the whole demand bid, then selling more does NOT keep hitting demand
  m.placeLimit("p1", "rum", "sell", px, DEMAND_CAP);
  assert.equal(m._demandResting("rum"), 0, "demand exhausted");
  const burnedSoFar = 1000 - m.balancesOf("p1").holdings.rum; // rum that left p1 (sold)
  assert.equal(burnedSoFar, DEMAND_CAP, "only the capped amount was absorbed by demand");

  // refill brings it back to the cap and reports the touched commodity
  const touched = m.restockDemand();
  assert.deepEqual(touched, ["rum"]);
  assert.equal(m._demandResting("rum"), DEMAND_CAP, "demand topped back to the cap");

  // a no-op restock (already full) records/returns nothing
  assert.deepEqual(m.restockDemand(), []);
  assert.equal(checkAll(m.ex), null);
});

test("a demand levy skims demand sales as a sink (split crown/flag) — drains the premium", () => {
  const m = new Market("isleB", { demands: ["rum"], flag: "wardens", demandLevyBps: 2500, now: () => 1 }); // 25%
  m.join("p1");
  const px = m.seedPrice("rum");
  const before = m.balancesOf("p1").poe;
  m.placeLimit("p1", "rum", "sell", px, 8); // sells into the demand bid (burned)

  const proceeds = px * 8;
  const levy = Math.floor(proceeds * 0.25);
  assert.equal(m.balancesOf("p1").poe, before + proceeds - levy, "seller kept proceeds minus the demand levy");
  assert.equal(m.ex.poeOf(CROWN), Math.floor(levy * 0.6), "60% of the levy burned to crown");
  assert.equal(m.ex.poeOf("wardens"), levy - Math.floor(levy * 0.6), "40% to the controlling flag");
  assert.equal(checkAll(m.ex), null);
});

test("demand only targets finished goods the island actually demands", () => {
  const dRum = new Market("d", { demands: ["rum"], now: () => 1 });
  assert.equal(dRum._demandResting("rum"), DEMAND_CAP, "demands rum -> demand bid for rum");
  assert.equal(dRum._demandResting("shot"), 0, "doesn't demand shot -> none");

  // demanding a NON-finished good (refined/raw) creates no demand sink
  const dIron = new Market("e", { demands: ["iron"], now: () => 1 });
  assert.equal(dIron._demandResting("iron"), 0, "iron is refined, not finished -> no demand burn-bid");

  const neutral = new Market("n", { now: () => 1 });
  assert.equal(neutral._demandResting("rum"), 0, "neutral island has no demand bids");
});

test("demand + burns survive a restart: replaying rebuilds identical supply", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleB", { exchange: ex1, store, demands: ["rum"], newPlayerInv: { rum: 40 }, flag: "wardens", taxRate: 0.05, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("p1"); await m.flush();

  // sell into demand (burns), drain it, refill, sell again (burns more)
  const px = m.seedPrice("rum");
  m.placeLimit("p1", "rum", "sell", px, 5); await m.flush();
  m.placeLimit("p1", "rum", "sell", px, 15); await m.flush(); // exhausts the cap (5+15=20)
  m.restockDemand(); await m.flush();
  m.placeLimit("p1", "rum", "sell", px, 6); await m.flush(); // burns 6 more

  const rumLive = ex1.totalUnits("rum");
  const demandRestingLive = m._demandResting("rum");

  // restart: replay the full log into a fresh engine
  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleB", { exchange: ex2, flag: "wardens", now });

  assert.equal(ex2.totalUnits("rum"), rumLive, "burned-down rum supply rebuilt identically");
  assert.equal(m2._demandResting("rum"), demandRestingLive, "resting demand rebuilt identically");
  assert.equal(ex2.invOf(ex2.whId(DEMAND, "isleB"), "rum"), 0, "demand reserve still holds nothing");
  assert.deepEqual(ex2.mintedUnits, ex1.mintedUnits, "minted-units baseline (net of burns) preserved");
  assert.deepEqual(m2.balancesOf("p1"), m.balancesOf("p1"), "p1 view identical across the restart");
  assert.equal(checkAll(ex2), null, "all invariants hold on the rebuilt engine");
});
