import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, NEW_PLAYER_POE } from "./market.mjs";
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

test("a crew pools PoE in a shared coffer (conserving transfers)", () => {
  const ex = new Exchange();
  const m = new Market("isleA", { exchange: ex, now: () => 1 });
  m.join("cap"); m.join("mate"); m.join("rando");
  const poe0 = m.totalPoe();

  const crew = m.formCrew("cap", "The Salt Dogs");
  m.joinCrew("mate", crew);

  // members contribute; the coffer is just an account, money is conserved
  m.crewDeposit("cap", crew, 200);
  m.crewDeposit("mate", crew, 150);
  assert.equal(m.crewCofferOf(crew), 350, "coffer holds the pooled PoE");
  assert.equal(m.balancesOf("cap").poe, NEW_PLAYER_POE - 200);
  assert.equal(m.balancesOf("mate").poe, NEW_PLAYER_POE - 150);
  assert.equal(m.totalPoe(), poe0, "PoE conserved (deposits were transfers)");
  assert.equal(m.ex.ledger.sum(), 0, "ledger zero-sum");

  // the captain withdraws; a non-member can't deposit; a non-captain can't withdraw
  m.crewWithdraw("cap", crew, 100);
  assert.equal(m.crewCofferOf(crew), 250);
  assert.equal(m.balancesOf("cap").poe, NEW_PLAYER_POE - 200 + 100);
  assert.throws(() => m.crewDeposit("rando", crew, 10), /join the crew first/);
  assert.throws(() => m.crewWithdraw("mate", crew, 10), /only the crew captain/);
  assert.throws(() => m.crewWithdraw("cap", crew, 9999), /coffer is short/);

  // the crew shows up in members' balances
  const capCrews = m.balancesOf("cap").crews;
  assert.equal(capCrews.length, 1);
  assert.deepEqual({ name: capCrews[0].name, coffer: capCrews[0].coffer, members: capCrews[0].members, captain: capCrews[0].captain },
    { name: "The Salt Dogs", coffer: 250, members: 2, captain: true });
  assert.equal(m.balancesOf("mate").crews[0].captain, false, "mate is a member, not captain");
  assert.equal(m.balancesOf("rando").crews.length, 0, "non-member sees no crew");
  assert.equal(checkAll(ex), null);
});

test("crews + the coffer survive a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleA", { exchange: ex1, store, nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("cap"); await m.flush();
  m.join("mate"); await m.flush();
  const crew = m.formCrew("cap", "Reavers"); await m.flush();
  m.joinCrew("mate", crew); await m.flush();
  m.crewDeposit("cap", crew, 300); await m.flush();
  m.crewDeposit("mate", crew, 120); await m.flush();
  m.crewWithdraw("cap", crew, 70); await m.flush();

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleA", { exchange: ex2, now });

  assert.equal(m2.crewCofferOf(crew), m.crewCofferOf(crew), "coffer rebuilt");
  assert.equal(m2.crewCofferOf(crew), 350); // 300 + 120 - 70
  assert.deepEqual(m2.balancesOf("cap"), m.balancesOf("cap"), "captain view identical");
  assert.deepEqual(m2.balancesOf("mate").crews, m.balancesOf("mate").crews, "membership rebuilt");
  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE conserved across restart");
  assert.equal(checkAll(ex2), null);
});
