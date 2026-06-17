// Live proof of restart persistence through the REAL MarketHub (not just Market):
// session 1 trades and persists to a file-backed Store; session 2 boots a fresh
// hub, replays the log, and must show identical books/balances WITHOUT re-seeding.
// This exercises hub.init() -> replay() -> seed-skip end to end, no database needed.
//
//   run:  npm -w @salt/server run persist:live
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { MarketHub } from "./src/economy/hub.js";
import type { Store, Batch, Intent } from "./src/economy/market.mjs";

const FILE = "./.persist-live.json";
const read = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { intents: [], trades: [], ledger: [] });

// A file is obviously not how you'd ship this — it's a stand-in for PgStore so we
// can demonstrate a real cross-"restart" replay here without Postgres.
class FileStore implements Store {
  async persist(batch: Batch): Promise<void> {
    const cur = read();
    cur.intents.push(...batch.intents);
    cur.trades.push(...batch.trades);
    cur.ledger.push(...batch.ledger);
    writeFileSync(FILE, JSON.stringify(cur));
  }
  async loadIntents(): Promise<Intent[]> { return read().intents; }
}

const island = {
  id: "r0_0_i0", name: "Tortuga head", region: "tropic",
  produces: ["sugar", "wood"], demands: ["shot", "iron"], controllingFlag: "sash", taxRate: 0.05,
};

rmSync(FILE, { force: true });

// --- session 1: seed on first visit, trade, leave a resting order ---
const hub1 = new MarketHub(new FileStore());
await hub1.init();
const m1 = await hub1.market(island);
m1.join("p1"); await m1.flush();
m1.join("p2"); await m1.flush();

const px = m1.depth("shot").bids[0].price + 1; // shot is demanded here -> premium book
m1.placeLimit("p2", "shot", "sell", px, 5); await m1.flush();
m1.placeLimit("p1", "shot", "buy", px, 5); await m1.flush();   // player <-> player fill
m1.placeLimit("p1", "iron", "buy", 3, 4); await m1.flush();    // a resting order

const before = {
  poe: m1.totalPoe(),
  shotUnits: m1.totalUnits("shot"),
  p1: m1.balancesOf("p1"),
  p2: m1.balancesOf("p2"),
  shot: m1.depth("shot"),
  iron: m1.depth("iron"),
};
const logSize = read().intents.length;

// --- session 2: brand-new hub, replay the persisted log ---
const hub2 = new MarketHub(new FileStore());
await hub2.init();
const m2 = await hub2.market(island); // must NOT re-seed (log says it's already seeded)

assert.equal(read().intents.length, logSize, "restart must not append new seed intents");
assert.equal(m2.totalPoe(), before.poe, "total PoE preserved across restart");
assert.equal(m2.totalUnits("shot"), before.shotUnits, "shot units preserved");
assert.deepEqual(m2.depth("shot"), before.shot, "shot book identical after restart");
assert.deepEqual(m2.depth("iron"), before.iron, "iron book identical after restart");
assert.deepEqual(m2.balancesOf("p1"), before.p1, "p1 balances identical after restart");
assert.deepEqual(m2.balancesOf("p2"), before.p2, "p2 balances identical after restart");

// the rehydrated book is live
m2.join("p9");
const ask = m2.depth("shot").asks[0].price;
m2.placeLimit("p9", "shot", "buy", ask, 1);
assert.equal(m2.depth("shot").last, ask, "rehydrated book trades after restart");

rmSync(FILE, { force: true });
console.log("PASS: restart persistence through MarketHub");
console.log(`  replayed ${logSize} intents; p1 ${before.p1.poe} PoE, shot book last=${before.shot.last}`);
console.log(`  p1 resting orders after restart: ${JSON.stringify(before.p1.orders)}`);
process.exit(0);
