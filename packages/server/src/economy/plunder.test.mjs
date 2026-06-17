import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import {
  Market, replay, PRIZE, PRIZE_RESERVE, PRIZE_CAP, PRIZE_REGEN, PVE_PLUNDER,
  PVP_COIN_BPS, PLUNDER_CROWN_BPS, CROWN,
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
const cut = (gross) => Math.floor((gross * PLUNDER_CROWN_BPS) / 10000);

test("PvE plunder is a CAPPED faucet: the pool drains and rate-limits payouts", () => {
  const ex = new Exchange();
  let clock = 0; const now = () => clock; // frozen -> no refill, so the pool can run dry
  const m = new Market("isle", { exchange: ex, now });
  m.join("hero");

  // draw from the pool with no time passing (no refill): it depletes to 0 and stops
  let totalGross = 0, draws = 0;
  while (true) {
    const paid = m.pvePlunder("hero");
    if (paid <= 0) break;
    totalGross += paid; draws++;
    if (draws > 10000) break;
  }
  assert.equal(m.ex.poeOf(PRIZE), 0, "the pool drained to empty — the faucet is capped, not infinite");
  assert.equal(totalGross, PRIZE_RESERVE, `total PvE plunder was bounded by the pool (${PRIZE_RESERVE})`);
  assert.equal(checkAll(ex), null);
});

test("PvE plunder refills the pool over time at a bounded rate (the controlled faucet)", () => {
  const ex = new Exchange();
  let clock = 0; const now = () => clock;
  const m = new Market("isle", { exchange: ex, now });
  m.join("hero");
  m.pvePlunder("hero"); // seeds the pool (PRIZE_RESERVE) + one draw
  assert.equal(m.ex.poeOf(PRIZE), PRIZE_RESERVE - PVE_PLUNDER);

  // 10 seconds pass -> the next draw first refills PRIZE_REGEN*10, capped at PRIZE_CAP
  clock = 10_000;
  const before = m.ex.poeOf(PRIZE);
  m.pvePlunder("hero");
  const refilled = m.ex.poeOf(PRIZE) - (before - PVE_PLUNDER);
  assert.equal(refilled, Math.min(PRIZE_CAP - before, PRIZE_REGEN * 10), "refill is the rate-limited faucet, capped");
  assert.equal(checkAll(ex), null);
});

test("PvP plunder loots the LOSER (cargo + coin share), zero-sum, minus the crown cut", () => {
  const ex = new Exchange();
  const m = new Market("isle", { exchange: ex, now: () => 1 });
  m.join("victor"); m.join("victim");
  // give the victim a ship with cargo + a known coin balance
  const ship = m.balancesOf("victim").ships[0];
  m.loadCargo("victim", ship.id, "rum", 12);
  const victimCoin0 = m.balancesOf("victim").poe;
  const victorRum0 = m.balancesOf("victor").holdings.rum || 0;
  const total0 = m.totalPoe();

  m.pvpPlunder("victor", "victim", ship.id, "isle"); // victor loots victim

  const take = Math.floor((victimCoin0 * PVP_COIN_BPS) / 10000);
  assert.equal(m.balancesOf("victim").poe, victimCoin0 - take, "victim lost the coin share");
  assert.equal(m.balancesOf("victor").poe, /* start */ 1000 + take - cut(take), "victor gained it minus the crown cut");
  assert.equal(m.ex.poeOf(CROWN), cut(take), "crown took the letter-of-marque cut (a sink)");
  assert.equal(m.balancesOf("victor").holdings.rum, victorRum0 + 12, "victor took the loser's cargo");
  assert.equal(m.balancesOf("victim").ships[0].hold.rum ?? 0, 0, "loser's hold emptied");
  assert.equal(m.totalPoe(), total0, "PvP plunder MINTS nothing — it's a pure transfer (+ sink, still conserved)");
  assert.equal(m.ex.ledger.sum(), 0, "ledger zero-sum");
  assert.equal(checkAll(ex), null);
});

test("plunder (PvE pool + crown cut) survives a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; let clock = 0; const now = () => clock;

  const ex1 = new Exchange();
  const m = new Market("isle", { exchange: ex1, store, nextSeq, now });
  m.join("hero"); await m.flush();
  m.pvePlunder("hero"); await m.flush();
  clock = 7000; m.pvePlunder("hero"); await m.flush(); // a refill happens on this draw

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isle", { exchange: ex2, now });

  assert.equal(ex2.poeOf(PRIZE), ex1.poeOf(PRIZE), "pool (incl. the timed refill) rebuilt identically");
  assert.equal(ex2.poeOf(CROWN), ex1.poeOf(CROWN), "crown cut preserved");
  assert.deepEqual(m2.balancesOf("hero"), m.balancesOf("hero"), "hero view identical");
  assert.equal(checkAll(ex2), null);
});
