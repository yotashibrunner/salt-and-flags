// Live end-to-end check of the PillageRoom over the websocket: rig (gather wind +
// powder) -> plot a turn -> receive the authoritative resolution script and see
// the ship move. Uses a short rig so it runs fast.
//
//   1) npm run dev:server
//   2) node packages/client/pillage.e2e.mjs
import assert from "node:assert/strict";
import { Client } from "colyseus.js";

const SERVER = process.env.VITE_SERVER ?? "http://localhost:2567";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await wait(30); }
  throw new Error("timed out");
}

const client = new Client(SERVER);
const room = await client.joinOrCreate("pillage", { rigMs: 300, secret: "e2e-pillage" });

let resolution = null;
room.onMessage("resolution", (m) => (resolution = m));
room.onMessage("error", (e) => { throw new Error(`room error: ${e.message}`); });

await until(() => room.state && room.state.phase === "rig");
const startRow = room.state.ships.get("player").row;

// RIG: crew clears puzzles -> wind + powder
room.send("rig:clears", { wind: 4, powder: 4 });

// PLOT: once the rig timer flips us to plot, submit the turn
await until(() => room.state.phase === "plot");
room.send("plot", { moves: ["F", "F"], ballsPort: 0, ballsStar: 2 });

// RESOLVE: the server broadcasts one deterministic script
await until(() => resolution !== null);
assert.equal(resolution.round, 1, "resolved round 1");
assert.ok(Array.isArray(resolution.script.frames) && resolution.script.frames.length >= 1, "has move frames");
assert.ok(Array.isArray(resolution.script.fire), "has a fire phase");

// the player ship actually advanced (and the server is authoritative about it)
await until(() => room.state.ships.get("player").row !== startRow);
const endRow = room.state.ships.get("player").row;
assert.ok(endRow < startRow, "player sailed north (toward the foe)");

console.log(`PASS: pillage round resolved THROUGH the room`);
console.log(`  frames=${resolution.script.frames.length}, fire events=${resolution.script.fire.length}`);
console.log(`  player row ${startRow} -> ${endRow}; enemy hull=${room.state.ships.get("enemy").hull}`);
await room.leave();

// --- victory -> plunder: win a rigged battle, then check the market wallet ---
const HERO = `plunder-${Date.now()}`; // fresh captain so the wallet check is exact
// player at (2,4) facing N (starboard = east); a 1-hull enemy sits one cell east
const battle = await client.joinOrCreate("pillage", {
  rigMs: 300, secret: HERO, enemyMoveBudget: 0, // hold the enemy still for a clean kill
  setup: { player: { col: 2, row: 4, heading: 0 }, enemy: { col: 3, row: 4, hull: 1 } },
});
let ended = null;
battle.onMessage("resolution", () => {});
battle.onMessage("end", (m) => (ended = m));
battle.onMessage("error", (e) => { throw new Error(`battle error: ${e.message}`); });
await until(() => battle.state && battle.state.phase === "rig");
battle.send("rig:clears", { powder: 1 });
await until(() => battle.state.phase === "plot");
battle.send("plot", { moves: [], ballsPort: 0, ballsStar: 1 }); // starboard volley sinks the enemy
await until(() => ended !== null);
assert.equal(ended.winner, "player", "we won");
assert.ok(ended.bounty > 0, "a plunder bounty was paid");
await battle.leave();

// the plunder landed in the SAME player's market wallet (cross-subsystem)
const world = await (await fetch(`${SERVER}/world`)).json();
const mkt = await client.joinOrCreate("market", { island: world.islands[0].id, secret: HERO });
let bal = null;
mkt.onMessage("hello", () => {});
mkt.onMessage("balances", (b) => (bal = b));
mkt.onMessage("error", (e) => { throw new Error(`market error: ${e.message}`); });
mkt.send("sync");
await until(() => bal !== null);
assert.equal(bal.poe, 1000 + ended.bounty, "market wallet = starting PoE + plunder");
console.log(`PASS: victory plunder — ${HERO} won; market wallet PoE = ${bal.poe} (1000 + ${ended.bounty})`);
await mkt.leave();
await wait(150); // let sockets close before exit (avoids a libuv teardown assert on Windows)
process.exit(0);
