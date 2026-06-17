import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";

test("a crossing buy fills against a resting ask; PoE and goods conserved", () => {
  const ex = new Exchange();
  ex.createAccount("alice", 1000);
  ex.createAccount("bob", 0, { rum: 10 });
  const poe0 = ex.totalPoe(), rum0 = ex.totalUnits("rum");

  ex.placeLimit("bob", "maris", "rum", "sell", 20, 5);
  ex.placeLimit("alice", "maris", "rum", "buy", 20, 5);

  assert.equal(ex.invOf("alice", "rum"), 5);
  assert.equal(ex.poeOf("bob"), 100);
  assert.equal(ex.poeOf("alice"), 900);
  assert.equal(ex.poeOf("ESCROW"), 0);          // fully settled
  assert.equal(ex.totalPoe(), poe0);            // conserved
  assert.equal(ex.totalUnits("rum"), rum0);     // conserved
  assert.equal(ex.ledger.sum(), 0);             // ledger is zero-sum
});

test("taker buyer gets price improvement and a refund", () => {
  const ex = new Exchange();
  ex.createAccount("alice", 1000);
  ex.createAccount("bob", 0, { rum: 10 });

  ex.placeLimit("bob", "maris", "rum", "sell", 8, 5);   // resting ask at 8
  ex.placeLimit("alice", "maris", "rum", "buy", 10, 5); // willing to pay 10, fills at 8

  assert.equal(ex.poeOf("bob"), 40);            // 8 * 5
  assert.equal(ex.poeOf("alice"), 960);         // 1000 - 50 escrow + 10 refund
  assert.equal(ex.invOf("alice", "rum"), 5);
  assert.equal(ex.poeOf("ESCROW"), 0);
});

test("partial fill rests the remainder; cancel refunds the escrow", () => {
  const ex = new Exchange();
  ex.createAccount("alice", 1000);
  ex.createAccount("bob", 0, { rum: 10 });

  ex.placeLimit("bob", "maris", "rum", "sell", 20, 3);
  const buy = ex.placeLimit("alice", "maris", "rum", "buy", 20, 5); // 3 fill, 2 rest

  assert.equal(ex.invOf("alice", "rum"), 3);
  assert.equal(ex.poeOf("ESCROW"), 40);         // 2 units * 20 still escrowed
  assert.equal(buy.qty, 2);

  assert.equal(ex.cancel(buy.id), true);
  assert.equal(ex.poeOf("ESCROW"), 0);
  assert.equal(ex.poeOf("alice"), 940);         // 1000 - 60 spent
});

test("price-time priority: lowest ask fills first", () => {
  const ex = new Exchange();
  ex.createAccount("alice", 1000);
  ex.createAccount("bob", 0, { rum: 10 });
  ex.createAccount("carol", 0, { rum: 10 });

  ex.placeLimit("bob", "maris", "rum", "sell", 20, 2);
  ex.placeLimit("carol", "maris", "rum", "sell", 18, 2); // cheaper -> should fill first
  ex.placeLimit("alice", "maris", "rum", "buy", 25, 2);

  assert.equal(ex.poeOf("carol"), 36);          // 18 * 2
  assert.equal(ex.poeOf("bob"), 0);             // untouched
});

test("underfunded and undersupplied orders are rejected", () => {
  const ex = new Exchange();
  ex.createAccount("alice", 10);
  ex.createAccount("bob", 0, { rum: 1 });
  assert.throws(() => ex.placeLimit("alice", "maris", "rum", "buy", 20, 5), /insufficient PoE/);
  assert.throws(() => ex.placeLimit("bob", "maris", "rum", "sell", 20, 5), /insufficient goods/);
});

test("conservation holds across a long run of randomized orders", () => {
  const ex = new Exchange();
  for (const id of ["a", "b", "c"]) ex.createAccount(id, 5000, { rum: 50 });
  const poe0 = ex.totalPoe(), rum0 = ex.totalUnits("rum");

  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ids = ["a", "b", "c"];

  for (let i = 0; i < 400; i++) {
    const owner = ids[(rnd() * 3) | 0];
    const side = rnd() < 0.5 ? "buy" : "sell";
    const price = 5 + ((rnd() * 25) | 0);
    const qty = 1 + ((rnd() * 6) | 0);
    try { ex.placeLimit(owner, "maris", "rum", side, price, qty); }
    catch { /* rejected for funds/goods — fine, skip */ }
  }

  assert.equal(ex.totalPoe(), poe0, "PoE must be conserved");
  assert.equal(ex.totalUnits("rum"), rum0, "rum units must be conserved");
  assert.equal(ex.ledger.sum(), 0, "ledger must be zero-sum");
});
