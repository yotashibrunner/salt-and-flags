import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market, replay } from "./market.mjs";
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

test("a captain claims a unique display name; it shows in balances", () => {
  const m = new Market("isleA", { now: () => 1 });
  m.join("p1"); m.join("p2");
  assert.equal(m.balancesOf("p1").name, "", "no name by default");

  m.setName("p1", "Blackbeard");
  assert.equal(m.nameOf("p1"), "Blackbeard");
  assert.equal(m.balancesOf("p1").name, "Blackbeard");

  // names are unique across players
  assert.throws(() => m.setName("p2", "Blackbeard"), /already taken/);
  m.setName("p2", "Anne Bonny"); // a free name is fine
  assert.equal(m.balancesOf("p2").name, "Anne Bonny");

  // empty names are rejected; over-long names are trimmed
  assert.throws(() => m.setName("p1", "   "), /can't be empty/);
  assert.equal(checkAll(m.ex), null);
});

test("renaming frees the old name for someone else to claim", () => {
  const m = new Market("isleA", { now: () => 1 });
  m.join("p1"); m.join("p2");
  m.setName("p1", "Kidd");
  m.setName("p1", "Captain Kidd"); // rename
  assert.equal(m.nameOf("p1"), "Captain Kidd");
  m.setName("p2", "Kidd"); // the freed name is claimable now
  assert.equal(m.nameOf("p2"), "Kidd");
  // re-claiming your own current name is idempotent (not "taken by another")
  m.setName("p2", "Kidd");
  assert.equal(m.nameOf("p2"), "Kidd");
});

test("names survive a restart", async () => {
  const store = new MemStore();
  let seq = 0; const nextSeq = () => ++seq; const now = () => 1;

  const ex1 = new Exchange();
  const m = new Market("isleA", { exchange: ex1, store, nextSeq, now });
  m.join("p1"); await m.flush();
  m.setName("p1", "Roberts"); await m.flush();
  m.setName("p1", "Bartholomew Roberts"); await m.flush(); // rename before restart

  const ex2 = new Exchange();
  replay(ex2, await store.loadIntents());
  const m2 = new Market("isleA", { exchange: ex2, now });

  assert.equal(m2.nameOf("p1"), "Bartholomew Roberts", "current name replayed");
  // the freed earlier name is claimable on the rebuilt engine (uniqueness map rebuilt)
  m2.join("p2");
  m2.setName("p2", "Roberts");
  assert.equal(m2.nameOf("p2"), "Roberts");
  assert.deepEqual(m2.balancesOf("p1").name, m.balancesOf("p1").name);
  assert.equal(checkAll(ex2), null);
});
