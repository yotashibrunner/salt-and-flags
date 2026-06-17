import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay, BLOCKADE_COST, BLOCKADE_START, BLOCKADE_STEP, BLOCKADE_LABOR, WARCHEST } from "./market.mjs";
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

const steps = (from, to) => Math.ceil(Math.abs(to - from) / BLOCKADE_STEP);

test("a blockade is a labor tug-of-war; reaching the top seizes the island", () => {
  const ex = new Exchange();
  const seq = (() => { let n = 0; return () => ++n; })();
  let clock = 0; const now = () => clock;
  const m = new Market("isleA", { exchange: ex, flag: "sash", taxRate: 0.1, nextSeq: seq, now });
  m.seedLiquidity();
  m.join("att"); m.join("def");
  m.pledge("att", "wardens");
  m.pledge("def", "sash");
  const poe0 = m.totalPoe();

  // wardens declares a blockade (a PoE sink -> warchest)
  m.declareBlockade("att", "wardens");
  assert.deepEqual(m.blockadeHere(), { attacker: "wardens", defender: "sash", meter: BLOCKADE_START });
  assert.equal(ex.poeOf(WARCHEST), BLOCKADE_COST, "declaration fee consumed by the warchest");
  assert.equal(m.totalPoe(), poe0, "PoE conserved (fee was a transfer)");

  // a defender push first drops the meter; pledge gating holds
  assert.throws(() => m.pushBlockade("def"), /pledge to wardens/);   // def isn't wardens
  m.defendBlockade("def"); // 50 -> 40
  assert.equal(m.blockadeHere().meter, BLOCKADE_START - BLOCKADE_STEP);

  // wardens push it from 40 up past 100 — each push costs labor, so advance the clock to regen
  for (let i = 0; i < steps(BLOCKADE_START - BLOCKADE_STEP, 100) + 1; i++) {
    clock += BLOCKADE_LABOR * 1000; // regen enough labor for the next push
    try { m.pushBlockade("att"); } catch { /* may finish early */ }
    if (!m.blockadeHere()) break;
  }
  assert.equal(m.blockadeHere(), null, "blockade resolved");
  assert.equal(m.flag, "wardens", "wardens took the island");
  assert.equal(checkAll(ex), null);
});

test("blockade gating: must be pledged, can't blockade what you already hold, one at a time", () => {
  const ex = new Exchange();
  const m = new Market("isleA", { exchange: ex, flag: "sash", now: () => 1 });
  m.seedLiquidity();
  m.join("p");
  assert.throws(() => m.declareBlockade("p", "wardens"), /pledge to wardens first/);
  m.pledge("p", "sash");
  assert.throws(() => m.declareBlockade("p", "sash"), /already controls/);
  m.pledge("p", "wardens");
  m.declareBlockade("p", "wardens");
  assert.throws(() => m.declareBlockade("p", "wardens"), /already under blockade/);
  assert.equal(checkAll(ex), null);
});

test("a blockade in progress survives a restart (meter + flip replay identically)", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq;
  let clock = 0; const now = () => clock;

  const ex1 = new Exchange();
  const m = new Market("isleZ", { exchange: ex1, store, flag: "sash", nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("att"); await m.flush();
  m.pledge("att", "wardens"); await m.flush();
  m.declareBlockade("att", "wardens"); await m.flush();
  clock += BLOCKADE_LABOR * 1000; m.pushBlockade("att"); await m.flush(); // 50 -> 60
  clock += BLOCKADE_LABOR * 1000; m.pushBlockade("att"); await m.flush(); // 60 -> 70

  assert.equal(m.blockadeHere().meter, BLOCKADE_START + 2 * BLOCKADE_STEP);

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleZ", { exchange: ex2, flag: "sash", now });

  assert.deepEqual(m2.blockadeHere(), m.blockadeHere(), "in-progress meter rebuilt");
  assert.equal(ex2.poeOf(WARCHEST), ex1.poeOf(WARCHEST), "warchest preserved");
  assert.equal(ex2.totalPoe(), ex1.totalPoe(), "PoE conserved across restart");
  assert.deepEqual(m2.balancesOf("att"), m.balancesOf("att"), "attacker view identical");
  assert.equal(checkAll(ex2), null);
});
