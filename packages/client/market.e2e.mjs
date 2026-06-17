// Live end-to-end check: connects TWO Colyseus clients to a running MarketRoom,
// places a crossing sell + buy THROUGH the room over the websocket, and asserts
// they match and that PoE + units are conserved between the two participants.
//
//   1) start the server:  npm run dev:server
//   2) run this:          node packages/client/market.e2e.mjs
import assert from "node:assert/strict";
import { Client } from "colyseus.js";

const SERVER = process.env.VITE_SERVER ?? "http://localhost:2567";
const COMMODITY = "rum";
const QTY = 5;

// route through a real worldgen island that has a controlling flag (so we can see
// the build levy land in that flag's treasury)
const world = await (await fetch(`${SERVER}/world`)).json();
const isle = world.islands.find((i) => i.controllingFlag) ?? world.islands[0];
const ISLAND = isle.id;
console.log(`using island ${ISLAND} (${isle.name}), flag=${isle.controllingFlag}`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await wait(50); }
  throw new Error("timed out waiting for condition");
}

const client = new Client(SERVER);

// join + attach handlers + request initial snapshot. Each player has a stable id.
let pidSeq = 0;
async function connect(island = ISLAND, playerId = `e2e-${++pidSeq}`) {
  const room = await client.joinOrCreate("market", { island, playerId });
  const state = { bal: null };
  room.onMessage("hello", () => {});
  room.onMessage("balances", (b) => (state.bal = b));
  room.onMessage("error", (e) => { throw new Error(`room error: ${e.message}`); });
  room.send("sync");
  await until(() => state.bal !== null);
  return { room, state, playerId };
}

// auth: a join without a playerId is rejected
let noPid = false;
try { await client.joinOrCreate("market", { island: ISLAND }); } catch { noPid = true; }
assert.ok(noPid, "joining without a playerId must be rejected");
console.log("✔ join without playerId rejected");

// unknown island ids are rejected by the room (onCreate throws -> join fails)
let rejected = false;
try { await client.joinOrCreate("market", { island: "no-such-island", playerId: "x" }); }
catch { rejected = true; }
assert.ok(rejected, "joining an unknown island must be rejected");
console.log("✔ unknown island rejected");

const seller = await connect();
const buyer = await connect();
await wait(200); // let book state settle

// pick a price strictly inside the NPC spread so the seller rests as best ask
const book = seller.room.state.books.get(COMMODITY);
const bestBid = book.bids[0].price, bestAsk = book.asks[0].price;
const px = bestBid + 1;
assert.ok(px < bestAsk, `chosen price ${px} must sit inside NPC spread [${bestBid}, ${bestAsk}]`);

const sBefore = { poe: seller.state.bal.poe, rum: seller.state.bal.holdings[COMMODITY] };
const bBefore = { poe: buyer.state.bal.poe, rum: buyer.state.bal.holdings[COMMODITY] };

// seller rests, buyer crosses it
seller.room.send("placeLimit", { commodity: COMMODITY, side: "sell", price: px, qty: QTY });
await wait(300);
buyer.room.send("placeLimit", { commodity: COMMODITY, side: "buy", price: px, qty: QTY });

// wait until both clients observe the settlement
await until(() =>
  buyer.state.bal.holdings[COMMODITY] === bBefore.rum + QTY &&
  seller.state.bal.holdings[COMMODITY] === sBefore.rum - QTY);

const sAfter = { poe: seller.state.bal.poe, rum: seller.state.bal.holdings[COMMODITY] };
const bAfter = { poe: buyer.state.bal.poe, rum: buyer.state.bal.holdings[COMMODITY] };

// --- assertions: the trade happened; seller paid the island's commerce tax ---
const rate = seller.room.state.taxRate;
const tax = Math.floor(px * QTY * rate); // tax skimmed from the seller
assert.equal(bAfter.rum, bBefore.rum + QTY, "buyer gained QTY units");
assert.equal(sAfter.rum, sBefore.rum - QTY, "seller lost QTY units");
assert.equal(bAfter.poe, bBefore.poe - px * QTY, "buyer paid px*qty PoE");
assert.equal(sAfter.poe, sBefore.poe + px * QTY - tax, "seller received px*qty minus tax");

// PoE conserved across buyer + seller + the flag that took the tax
const dPoe = (bAfter.poe - bBefore.poe) + (sAfter.poe - sBefore.poe) + tax;
const dUnits = (bAfter.rum - bBefore.rum) + (sAfter.rum - sBefore.rum);
assert.equal(dPoe, 0, "PoE conserved (buyer + seller + flag tax)");
assert.equal(dUnits, 0, "units conserved across the two clients");

await until(() => seller.room.state.books.get(COMMODITY).last === px);
assert.equal(seller.room.state.books.get(COMMODITY).last, px, "last price broadcast == fill price");

console.log(`PASS: matched ${QTY} ${COMMODITY} @ ${px} THROUGH the room (tax ${tax} @ ${(rate * 100).toFixed(1)}% -> flag ${seller.room.state.flag})`);
console.log(`  buyer  PoE ${bBefore.poe} -> ${bAfter.poe}, ${COMMODITY} ${bBefore.rum} -> ${bAfter.rum}`);
console.log(`  seller PoE ${sBefore.poe} -> ${sAfter.poe}, ${COMMODITY} ${sBefore.rum} -> ${sAfter.rum}`);
console.log(`  last = ${seller.room.state.books.get(COMMODITY).last};  dPoE=${dPoe}, dUnits=${dUnits} (conserved)`);

// --- stall ownership + per-flag royalty: buyer builds a Distillery, levy -> flag ---
const pPoe0 = buyer.state.bal.poe;
await wait(300); // let the trade-tax state patch settle before snapshotting the treasury
const flagTreasury0 = buyer.room.state.flagTreasury;
buyer.room.send("build", { recipeId: "distill" }); // pay the build levy, own the stall
await until(() => buyer.state.bal.stalls.includes("distill"));
assert.ok(buyer.state.bal.poe < pPoe0, "build fee charged");
const levy = pPoe0 - buyer.state.bal.poe;
await until(() => buyer.room.state.flagTreasury === flagTreasury0 + levy); // wait for the state patch
assert.equal(buyer.room.state.flagTreasury, flagTreasury0 + levy, "levy landed in the controlling flag's treasury");
console.log(`PASS: built a Distillery THROUGH the room — PoE ${pPoe0}->${buyer.state.bal.poe}; flag ${buyer.room.state.flag} treasury ${flagTreasury0}->${buyer.room.state.flagTreasury}`);

const pSugar0 = buyer.state.bal.holdings.sugar;
const pRum0 = buyer.state.bal.holdings.rum;
const pLabor0 = buyer.state.bal.labor;
buyer.room.send("produce", { recipeId: "distill" }); // 3 sugar + 4 labor -> 2 rum
await until(() => buyer.state.bal.holdings.sugar === pSugar0 - 3);
assert.equal(buyer.state.bal.holdings.rum, pRum0 + 2, "distilled 2 rum");
// labor dropped by ~4 (a periodic regen tick may have added a little back)
assert.ok(buyer.state.bal.labor >= pLabor0 - 4 && buyer.state.bal.labor < pLabor0,
  `labor spent (got ${buyer.state.bal.labor}, started ${pLabor0})`);
console.log(`PASS: produced THROUGH the room — sugar ${pSugar0}->${pSugar0 - 3}, rum ${pRum0}->${pRum0 + 2}, labor ${pLabor0}->${buyer.state.bal.labor}`);

// --- flag payout: buyer pledges, then triggers a payout of the flag treasury ---
buyer.room.send("pledge");
await until(() => buyer.state.bal.pledged === true && buyer.room.state.flagMembers >= 1);
const members = buyer.room.state.flagMembers;
assert.ok(members >= 1, "buyer is a pledged member");
const poeB = buyer.state.bal.poe, treB = buyer.room.state.flagTreasury;
buyer.room.send("payout");
await wait(500);
// robust to cross-run accumulation: a payout never raises the treasury or lowers a member
assert.ok(buyer.room.state.flagTreasury <= treB, "payout did not increase the treasury");
assert.ok(buyer.state.bal.poe >= poeB, "payout never reduces a member's PoE");
console.log(`PASS: pledged + paid out THROUGH the room — ${members} member(s); treasury ${treB}->${buyer.room.state.flagTreasury}, buyer PoE ${poeB}->${buyer.state.bal.poe}`);

// --- conquest: buyer pledges to a rival flag and seizes this island for it ---
const oldFlag = buyer.room.state.flag;
const rival = oldFlag === "wardens" ? "gulls" : "wardens";
buyer.room.send("pledge", { flag: rival });
await until(() => buyer.state.bal.myFlags.includes(rival));
const poeBeforeSeize = buyer.state.bal.poe;
buyer.room.send("seize", { flag: rival });
await until(() => buyer.room.state.flag === rival);
assert.equal(buyer.room.state.flag, rival, "island conquered by the rival flag");
assert.ok(buyer.state.bal.poe < poeBeforeSeize, "conquest cost paid");
console.log(`PASS: conquest THROUGH the room — island flag ${oldFlag} -> ${buyer.room.state.flag}; buyer PoE ${poeBeforeSeize}->${buyer.state.bal.poe}`);

// --- stable auth: the SAME player sees the SAME wallet on a different island ---
const island2 = world.islands.find((i) => i.id !== ISLAND).id;
const elsewhere = await connect(island2, buyer.playerId); // same playerId, different island
assert.equal(elsewhere.state.bal.poe, buyer.state.bal.poe, "same wallet PoE on another island");
assert.equal(elsewhere.state.bal.holdings.rum, buyer.state.bal.holdings.rum, "same holdings on another island");
assert.deepEqual(elsewhere.state.bal.myFlags.sort(), buyer.state.bal.myFlags.sort(), "same flag allegiances everywhere");
console.log(`PASS: stable identity — player ${buyer.playerId} carries PoE ${elsewhere.state.bal.poe} from ${ISLAND} to ${island2}`);
await elsewhere.room.leave();

await seller.room.leave();
await buyer.room.leave();
process.exit(0);
