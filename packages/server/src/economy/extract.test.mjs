import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import {
  Market, replay, CROWN, SITE_COST, EXTRACT_FEE, EXTRACT_YIELD, EXTRACT_LABOR, LABOR_START,
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

test("a site can only be built for a raw the island produces", () => {
  const m = new Market("harbor", { produces: ["sugar", "rum"], now: () => 1 });
  m.join("p1");
  assert.throws(() => m.buildSite("p1", "rum"), /not a raw resource/);     // rum is finished
  assert.throws(() => m.buildSite("p1", "wood"), /can't be sourced/);      // not produced here
  assert.throws(() => m.extract("p1", "sugar"), /build a sugar site here first/);
  const site = m.buildSite("p1", "sugar");
  assert.equal(site.commodity, "sugar");
  assert.deepEqual(m.balancesOf("p1").sites, ["sugar"]);
  assert.equal(checkAll(m.ex), null);
});

test("extraction mints a raw for labor + a PoE fee (a sink, split crown/flag)", () => {
  let clock = 0;
  const m = new Market("harbor", { produces: ["sugar"], flag: "wardens", now: () => clock });
  m.join("p1");
  m.buildSite("p1", "sugar"); // levy SITE_COST -> wardens (a transfer)
  const sugar0 = m.balancesOf("p1").holdings.sugar || 0;
  const poe0 = m.balancesOf("p1").poe;
  const sugarSupply0 = m.totalUnits("sugar");
  const crown0 = m.ex.accounts.has(CROWN) ? m.ex.poeOf(CROWN) : 0;

  m.extract("p1", "sugar");

  assert.equal(m.balancesOf("p1").holdings.sugar, sugar0 + EXTRACT_YIELD, "raw minted into the warehouse");
  assert.equal(m.totalUnits("sugar"), sugarSupply0 + EXTRACT_YIELD, "raw supply is renewable (minted)");
  assert.equal(poe0 - m.balancesOf("p1").poe, EXTRACT_FEE, "the per-pull fee was charged");
  assert.equal(m.balancesOf("p1").labor, LABOR_START - EXTRACT_LABOR, "labor spent");
  assert.equal(m.ex.poeOf(CROWN) - crown0, Math.floor(EXTRACT_FEE * 0.6), "60% of the fee burned to crown");
  assert.equal(checkAll(m.ex), null);
});

test("extraction is gated on labor and PoE", () => {
  let clock = 0;
  const m = new Market("harbor", { produces: ["sugar"], now: () => clock });
  m.join("p1");
  m.buildSite("p1", "sugar");
  // drain labor (EXTRACT_LABOR each) at a frozen clock
  let pulls = 0;
  while (true) { try { m.extract("p1", "sugar"); pulls++; } catch { break; } }
  assert.equal(pulls, Math.floor(LABOR_START / EXTRACT_LABOR), "ran until labor ran out");
  assert.throws(() => m.extract("p1", "sugar"), /not enough labor/);
  assert.equal(checkAll(m.ex), null);
});

test("sites + extraction survive a restart: renewable supply rebuilds identically", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq;
  let clock = 0; const now = () => clock;

  const ex1 = new Exchange();
  const m = new Market("harbor", { exchange: ex1, store, produces: ["sugar"], flag: "wardens", nextSeq, now });
  m.seedLiquidity(); await m.flush();
  m.join("p1"); await m.flush();
  m.buildSite("p1", "sugar"); await m.flush();
  for (let i = 0; i < 5; i++) { clock += 4000; m.extract("p1", "sugar"); await m.flush(); } // regen between pulls

  const sugarLive = ex1.totalUnits("sugar");

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("harbor", { exchange: ex2, produces: ["sugar"], flag: "wardens", now });

  assert.equal(ex2.totalUnits("sugar"), sugarLive, "extracted (minted) sugar rebuilt identically");
  assert.equal(ex2.poeOf(CROWN), ex1.poeOf(CROWN), "burned fees preserved");
  assert.equal(ex2.poeOf("wardens"), ex1.poeOf("wardens"), "flag treasury (site levy + fee share) preserved");
  assert.deepEqual(m2.balancesOf("p1"), m.balancesOf("p1"), "p1 view identical (sites, sugar, PoE, labor)");
  assert.deepEqual(m2.balancesOf("p1").sites, ["sugar"], "site ownership replayed");
  assert.equal(checkAll(ex2), null);
});
