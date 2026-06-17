import { test } from "node:test";
import assert from "node:assert/strict";
import { Market, NEW_PLAYER_POE, BASE_PRICE, LABOR_START, LABOR_MAX, STALL_COST, UNCLAIMED_TREASURY, CONQUEST_COST, WARCHEST, PRIZE, PRIZE_RESERVE, PVE_PLUNDER, PLUNDER_CROWN_BPS, CROWN } from "./market.mjs";
import { Exchange } from "./economy.mjs";

test("market seeds an NPC book to hit on both sides", () => {
  const m = new Market("maris");
  const d = m.depth("rum");
  assert.ok(d.bids.length > 0, "should have resting bids");
  assert.ok(d.asks.length > 0, "should have resting asks");
  assert.ok(d.asks[0].price > d.bids[0].price, "spread is positive at seed");
});

test("a crossing buy and sell placed THROUGH the market match; PoE + units conserved", () => {
  const m = new Market("maris");
  m.join("p1");
  m.join("p2");

  // snapshot AFTER joins (joining mints starting balances) so we measure the trade
  const poe0 = m.totalPoe();
  const rum0 = m.totalUnits("rum");

  const p1Rum0 = m.balancesOf("p1").holdings.rum;
  const p2Rum0 = m.balancesOf("p2").holdings.rum;

  // Price p2's sell strictly between the NPC's best bid and best ask so it rests
  // as the new best ask (won't hit the NPC book); then p1's buy crosses p2.
  const seed = m.depth("rum");
  const px = seed.bids[0].price + 1;
  assert.ok(px < seed.asks[0].price, "chosen price sits inside the NPC spread");

  m.placeLimit("p2", "rum", "sell", px, 5); // rests as best ask
  m.placeLimit("p1", "rum", "buy", px, 5);  // crosses p2 (cheaper than the NPC ask)

  // p1 received 5 rum, p2 sold 5 rum
  assert.equal(m.balancesOf("p1").holdings.rum, p1Rum0 + 5);
  assert.equal(m.balancesOf("p2").holdings.rum, p2Rum0 - 5);

  // a trade was recorded between the two players at px
  const t = m.ex.trades.find((x) => x.buyer === "p1" && x.seller === "p2");
  assert.ok(t, "a p1<-p2 trade exists");
  assert.equal(t.price, px);
  assert.equal(t.qty, 5);

  // conservation across the whole exchange (players + NPC + ESCROW)
  assert.equal(m.totalPoe(), poe0, "PoE conserved");
  assert.equal(m.totalUnits("rum"), rum0, "rum units conserved");
  assert.equal(m.ex.ledger.sum(), 0, "ledger zero-sum");
});

test("crossing the seeded NPC ask fills immediately and updates last price", () => {
  const m = new Market("maris");
  m.join("p1");
  const bestAsk = m.depth("rum").asks[0].price;
  m.placeLimit("p1", "rum", "buy", bestAsk, 1);
  assert.equal(m.depth("rum").last, bestAsk, "last price set to the fill price");
  assert.equal(m.balancesOf("p1").poe, NEW_PLAYER_POE - bestAsk);
});

test("a player can cancel only their own resting order; escrow is refunded", () => {
  const m = new Market("maris");
  m.join("p1");
  m.join("p2");
  // rest a non-crossing buy well below the NPC bid so it stays open
  const o = m.placeLimit("p1", "rum", "buy", 2, 3);
  const poeAfterEscrow = m.balancesOf("p1").poe;
  assert.equal(poeAfterEscrow, NEW_PLAYER_POE - 2 * 3);

  // p2 cannot cancel p1's order
  assert.throws(() => m.cancel("p2", o.id), /not your order/);

  // p1 cancels and gets the escrow back
  const commodity = m.cancel("p1", o.id);
  assert.equal(commodity, "rum");
  assert.equal(m.balancesOf("p1").poe, NEW_PLAYER_POE);
  assert.equal(m.balancesOf("p1").orders.length, 0);
});

test("seed prices are skewed by the island's produces vs demands (arbitrage gap)", () => {
  // an island that PRODUCES rum seeds it cheap; one that DEMANDS rum seeds it dear
  const producer = new Market("isleP", { produces: ["rum"] });
  const consumer = new Market("isleD", { demands: ["rum"] });
  const neutral = new Market("isleN");

  const pAsk = producer.depth("rum").asks[0].price;
  const cBid = consumer.depth("rum").bids[0].price;

  // cheap where produced, dear where demanded
  assert.ok(producer.seedPrice("rum") < BASE_PRICE.rum, "producer seed below base");
  assert.ok(consumer.seedPrice("rum") > BASE_PRICE.rum, "consumer seed above base");
  assert.equal(neutral.seedPrice("rum"), BASE_PRICE.rum, "neutral seed == base");

  // the arbitrage gap is real: you can buy from the producer's ask cheaper than
  // the consumer is willing to pay on their bid.
  assert.ok(pAsk < cBid, `producer ask ${pAsk} should be below consumer bid ${cBid}`);

  // extra NPC depth on the abundant (sell) side at the producer
  assert.ok(producer.depth("rum").asks[0].qty > neutral.depth("rum").asks[0].qty, "producer has deeper asks");
});

test("production: a recipe burns inputs + labor and mints outputs (PoE untouched)", () => {
  const m = new Market("maris", { now: () => 1000 }); // frozen clock (no regen during the test)
  m.join("p1");
  m.build("p1", "distill"); // must own a stall to produce
  const poe0 = m.totalPoe();
  const b0 = m.balancesOf("p1");
  assert.equal(b0.labor, LABOR_START);
  assert.deepEqual(b0.stalls, ["distill"], "owns the distillery here");

  // distill: 3 sugar + 4 labor -> 2 rum
  m.produce("p1", "distill");

  const b1 = m.balancesOf("p1");
  assert.equal(b1.holdings.sugar, b0.holdings.sugar - 3, "sugar consumed");
  assert.equal(b1.holdings.rum, b0.holdings.rum + 2, "rum produced");
  assert.equal(b1.labor, LABOR_START - 4, "labor spent");
  assert.equal(m.totalPoe(), poe0, "production does not touch PoE");

  // produced goods are real holdings you can then sell on the book
  const bid = m.depth("rum").bids[0].price;
  m.placeLimit("p1", "rum", "sell", bid, 2); // hit the NPC bid with freshly-made rum
  assert.equal(m.depth("rum").last, bid, "made-then-sold: rum traded into the market");
});

test("stall ownership: you must build a stall (levy -> treasury, conserved) before producing", () => {
  const m = new Market("maris", { now: () => 1000 });
  m.join("p1");
  const poe0 = m.totalPoe();

  // can't produce without a stall
  assert.throws(() => m.produce("p1", "distill"), /build a Distillery here first/);

  // build it: PoE leaves the player, lands in the treasury — total PoE unchanged
  const before = m.balancesOf("p1").poe;
  m.build("p1", "distill");
  assert.equal(m.balancesOf("p1").poe, before - STALL_COST, "player paid the build fee");
  assert.equal(m.ex.poeOf(UNCLAIMED_TREASURY), STALL_COST, "unflagged island -> unclaimed treasury");
  assert.equal(m.totalPoe(), poe0, "total PoE conserved (fee was a transfer)");
  assert.equal(m.ex.ledger.sum(), 0, "ledger still zero-sum");

  // now production works; building a duplicate is rejected
  m.produce("p1", "distill");
  assert.throws(() => m.build("p1", "distill"), /already own a Distillery/);

  // a different player without a stall still can't produce here
  m.join("p2");
  assert.throws(() => m.produce("p2", "distill"), /build a Distillery here first/);
});

test("per-flag royalties: build levies flow to the island's controlling flag", () => {
  // two islands controlled by the same flag, sharing one engine
  const ex = new Exchange();
  const seq = (() => { let n = 0; return () => ++n; })();
  const isleA = new Market("isleA", { exchange: ex, flag: "wardens", now: () => 1, nextSeq: seq });
  const isleB = new Market("isleB", { exchange: ex, flag: "wardens", now: () => 1, nextSeq: seq });
  const neutral = new Market("isleN", { exchange: ex, now: () => 1, nextSeq: seq }); // no flag
  isleA.seedLiquidity(); isleB.seedLiquidity(); neutral.seedLiquidity();
  isleA.join("p1");
  const poe0 = isleA.totalPoe();

  isleA.build("p1", "distill"); // levy -> wardens
  isleB.build("p1", "weave");   // levy -> wardens (same flag, different island)
  neutral.build("p1", "saw");   // levy -> unclaimed

  assert.equal(isleA.flagTreasury(), 2 * STALL_COST, "wardens collected both island levies");
  assert.equal(isleB.flagTreasury(), 2 * STALL_COST, "same flag treasury seen from either island");
  assert.equal(ex.poeOf(UNCLAIMED_TREASURY), STALL_COST, "neutral island levy went to unclaimed");
  assert.equal(isleA.totalPoe(), poe0, "PoE conserved across all the levies");
  assert.equal(ex.ledger.sum(), 0, "ledger zero-sum");
});

test("trade tax: a sale is taxed to the controlling flag (seller pays, conserved, never negative)", () => {
  const ex = new Exchange();
  const seq = (() => { let n = 0; return () => ++n; })();
  const m = new Market("isleA", { exchange: ex, flag: "wardens", taxRate: 0.10, now: () => 1, nextSeq: seq });
  m.seedLiquidity();
  m.join("p1");
  const poe0 = m.totalPoe();

  // p1 sells rum into the NPC's best bid -> p1 is the seller and pays the tax
  const bid = m.depth("rum").bids[0].price;
  const p1poe0 = m.balancesOf("p1").poe;
  m.placeLimit("p1", "rum", "sell", bid, 2);

  const proceeds = bid * 2;
  const tax = Math.floor(proceeds * 0.10);
  assert.ok(tax > 0, "tax is non-trivial");
  assert.equal(m.balancesOf("p1").poe, p1poe0 + proceeds - tax, "seller got proceeds minus tax");
  assert.ok(m.balancesOf("p1").poe > p1poe0, "still a net gain — tax never makes it negative");
  assert.equal(m.flagTreasury(), tax, "the controlling flag collected the tax");
  assert.equal(m.totalPoe(), poe0, "PoE conserved (tax was a transfer)");
  assert.equal(ex.ledger.sum(), 0, "ledger zero-sum");
});

test("no commerce tax on unflagged islands", () => {
  const m = new Market("isleN", { taxRate: 0 }); // standalone, no flag
  m.join("p1");
  const bid = m.depth("rum").bids[0].price;
  const before = m.balancesOf("p1").poe;
  m.placeLimit("p1", "rum", "sell", bid, 2);
  assert.equal(m.balancesOf("p1").poe, before + bid * 2, "full proceeds, no tax");
});

test("flag payout: a flag's treasury is split equally among its pledged members (conserved)", () => {
  const ex = new Exchange();
  const seq = (() => { let n = 0; return () => ++n; })();
  const m = new Market("isleA", { exchange: ex, flag: "wardens", now: () => 1, nextSeq: seq });
  m.seedLiquidity();
  m.join("a"); m.join("b"); m.join("c");

  m.build("a", "distill"); // levy 150 -> wardens treasury
  const treasury = m.flagTreasury();
  assert.equal(treasury, STALL_COST);

  m.pledge("a"); m.pledge("b"); // a and b are crew; c is not
  assert.equal(m.flagMemberCount(), 2);
  const poe0 = m.totalPoe();
  const aPoe = m.balancesOf("a").poe, bPoe = m.balancesOf("b").poe;

  const per = m.payout("a");
  assert.equal(per, Math.floor(treasury / 2), "split equally between the two members");
  assert.equal(m.balancesOf("a").poe, aPoe + per);
  assert.equal(m.balancesOf("b").poe, bPoe + per);
  assert.equal(m.flagTreasury(), treasury - 2 * per, "remainder (if any) stays in the treasury");
  assert.equal(m.totalPoe(), poe0, "PoE conserved (payout was a transfer)");
  assert.equal(ex.ledger.sum(), 0, "ledger zero-sum");

  // only members may trigger a payout
  assert.throws(() => m.payout("c"), /pledge to wardens first/);
});

test("flag conquest: seizing an island reroutes its royalties to the new flag (conserved)", () => {
  const ex = new Exchange();
  const seq = (() => { let n = 0; return () => ++n; })();
  const m = new Market("isleA", { exchange: ex, flag: "sash", taxRate: 0.1, now: () => 1, nextSeq: seq });
  m.seedLiquidity();
  m.join("cap");
  const poe0 = m.totalPoe();
  assert.equal(m.flag, "sash", "starts under sash");

  // must pledge to the attacker flag first
  assert.throws(() => m.seize("cap", "wardens"), /pledge to wardens first/);
  m.pledge("cap", "wardens");
  // a member of the ruling flag still can't "seize" what it already holds
  m.pledge("cap", "sash");
  assert.throws(() => m.seize("cap", "sash"), /already controls/);

  const capPoe = m.balancesOf("cap").poe;
  m.seize("cap", "wardens");
  assert.equal(m.flag, "wardens", "island conquered by wardens");
  assert.equal(m.balancesOf("cap").poe, capPoe - CONQUEST_COST, "captain paid the conquest cost");
  assert.equal(ex.poeOf(WARCHEST), CONQUEST_COST, "cost consumed by the warchest sink");
  assert.equal(m.totalPoe(), poe0, "PoE conserved (cost was a transfer)");
  assert.equal(ex.ledger.sum(), 0, "ledger zero-sum");

  // future commerce tax now flows to wardens, the new controller
  m.join("s");
  const bid = m.depth("rum").bids[0].price;
  m.placeLimit("s", "rum", "sell", bid, 2); // s is the seller -> taxed to the controlling flag
  assert.equal(m.flagTreasury(), Math.floor(bid * 2 * 0.1), "wardens collects the rerouted tax");
});

test("plunder: a PvE win pays from the capped prize pool, minus the crown cut", () => {
  const m = new Market("isle", { now: () => 1 });
  m.join("hero");
  const heroPoe = m.balancesOf("hero").poe;

  const paid = m.pvePlunder("hero"); // draws PVE_PLUNDER from the pool, skims the letter-of-marque cut
  const cut = Math.floor((PVE_PLUNDER * PLUNDER_CROWN_BPS) / 10000);

  assert.equal(paid, PVE_PLUNDER, "gross plunder = PVE_PLUNDER (pool had plenty)");
  assert.equal(m.balancesOf("hero").poe, heroPoe + PVE_PLUNDER - cut, "hero kept plunder minus the crown cut");
  assert.equal(m.ex.poeOf(PRIZE), PRIZE_RESERVE - PVE_PLUNDER, "drawn from the prize pool, not an infinite reserve");
  assert.equal(m.ex.poeOf(CROWN), cut, "the crown took its cut (a sink)");
  assert.equal(m.ex.ledger.sum(), 0, "ledger zero-sum");
});

test("you can't pledge on an unclaimed island", () => {
  const m = new Market("isleN"); // standalone, no flag
  m.join("p1");
  assert.throws(() => m.pledge("p1"), /no flag to pledge/);
});

test("production is rejected when inputs or labor are short, or the recipe is unknown", () => {
  const m = new Market("maris", { newPlayerInv: { sugar: 2 }, now: () => 1000 }); // sugar < distill (needs 3)
  m.join("p1");
  m.build("p1", "distill");
  assert.throws(() => m.produce("p1", "distill"), /not enough sugar/);
  assert.throws(() => m.produce("p1", "forge_gold"), /unknown recipe/);

  // drain labor at a frozen clock (no regen), then a valid+stocked recipe is refused
  const rich = new Market("maris", { newPlayerInv: { hemp: 1000 }, now: () => 1000 });
  rich.join("p2");
  rich.build("p2", "weave");
  let runs = 0;
  while (true) { try { rich.produce("p2", "weave"); runs++; } catch { break; } }
  assert.equal(runs, Math.floor(LABOR_START / 3), "ran until labor ran out (weave costs 3)");
  assert.throws(() => rich.produce("p2", "weave"), /not enough labor/);
});

test("labor regenerates over time, capped at LABOR_MAX", () => {
  let clock = 0;
  const m = new Market("maris", { now: () => clock });
  m.join("p1");                                  // labor 100 @ t0
  m.build("p1", "cast");
  m.produce("p1", "cast");                        // cast: 2 iron + 6 labor -> 3 shot
  assert.equal(m.balancesOf("p1").labor, LABOR_START - 6, "spent 6 labor, none regen yet");

  clock += 3000;                                  // +3s -> +3 labor (1/sec)
  assert.equal(m.balancesOf("p1").labor, LABOR_START - 6 + 3);

  clock += 100_000;                               // long wait -> regen caps
  assert.equal(m.balancesOf("p1").labor, LABOR_MAX, "regen capped at LABOR_MAX");

  // regen is real labor: after waiting, an otherwise-too-expensive run succeeds
  let clock2 = 0;
  const drained = new Market("maris", { newPlayerInv: { hemp: 1000 }, now: () => clock2 });
  drained.join("p2");
  drained.build("p2", "weave");
  while (true) { try { drained.produce("p2", "weave"); } catch { break; } } // labor < 3
  assert.throws(() => drained.produce("p2", "weave"), /not enough labor/);
  clock2 += 3000;                                 // regen +3 -> enough for one more weave
  drained.produce("p2", "weave");                 // no throw
  assert.ok(drained.balancesOf("p2").labor >= 0);
});

test("intents are validated: unknown commodity and underfunded orders are rejected", () => {
  const m = new Market("maris");
  m.join("p1");
  assert.throws(() => m.placeLimit("p1", "gold", "buy", 5, 1), /unknown commodity/);
  assert.throws(() => m.placeLimit("p1", "rum", "buy", 100000, 1000), /insufficient PoE/);
  assert.throws(() => m.placeLimit("p1", "rum", "buy", 0, 1), /price must be a positive integer/);
});
