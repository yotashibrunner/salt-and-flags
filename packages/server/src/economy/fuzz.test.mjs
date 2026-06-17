import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange } from "./economy.mjs";
import { Market } from "./market.mjs";
import { checkAll } from "./invariants.mjs";

// Deterministic LCG so a failure is reproducible from the seed.
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0];

function expectClean(ex, label) {
  const v = checkAll(ex);
  if (v) assert.fail(`invariant ${v.name} broken ${label}: ${v.detail}`);
}

test("full loop: buy at A, load, sail to B, unload, sell at B — goods are physical", () => {
  const ex = new Exchange();
  const A = new Market("A", { exchange: ex, now: () => 1 });
  const B = new Market("B", { exchange: ex, now: () => 1 });
  A.seedLiquidity();
  B.seedLiquidity();
  A.join("cap"); // purse + starter goods in wh:cap:A + a sloop docked at A
  const ship = A.balancesOf("cap").ships[0];
  assert.equal(ship.dockedAt, "A");
  assert.equal(A.balancesOf("cap").holdings.rum, 25);

  // can't sell rum at B — the captain has no goods physically there
  assert.throws(() => B.placeLimit("cap", "rum", "sell", 2, 1), /insufficient goods/);

  // load 10 rum from A's warehouse into the hold
  A.loadCargo("cap", ship.id, "rum", 10);
  assert.equal(A.balancesOf("cap").holdings.rum, 15, "10 rum left the warehouse");
  assert.equal(A.balancesOf("cap").ships[0].hold.rum, 10, "into the hold");

  // can't unload at B before the ship arrives
  assert.throws(() => B.unloadCargo("cap", ship.id, "rum", 10), /not docked here/);

  // sail A -> B (instant stub); the hold travels with the ship
  A.moveShip("cap", ship.id, "B");
  assert.equal(B.balancesOf("cap").ships[0].dockedAt, "B");
  assert.equal(B.balancesOf("cap").ships[0].hold.rum, 10, "hold rode along to B");

  // unload at B, then it's sellable on B's book
  B.unloadCargo("cap", ship.id, "rum", 10);
  assert.equal(B.balancesOf("cap").holdings.rum, 10, "now in wh:cap:B");
  const bid = B.depth("rum").bids[0].price;
  B.placeLimit("cap", "rum", "sell", bid, 10); // hits the NPC bid at B
  assert.equal(B.depth("rum").last, bid, "sold dear at B");

  expectClean(ex, "after the full loop");
});

test("cargo respects capacity: a sloop hold can't exceed its cap", () => {
  const ex = new Exchange();
  const A = new Market("A", { exchange: ex, newPlayerInv: { rum: 1000 }, now: () => 1 });
  A.seedLiquidity();
  A.join("cap");
  const ship = A.balancesOf("cap").ships[0];
  assert.equal(ship.cargoCap, 60, "sloop cap");
  A.loadCargo("cap", ship.id, "rum", 60); // exactly full
  assert.throws(() => A.loadCargo("cap", ship.id, "rum", 1), /cargo capacity/);
  expectClean(ex, "at capacity");
});

test("invariant fuzz: random ops across islands/players never break conservation", () => {
  const ex = new Exchange();
  let seq = 0;
  const nextSeq = () => ++seq;
  let clock = 1_000_000;
  const now = () => clock;

  const islands = ["isleA", "isleB", "isleC"];
  const cfg = {
    isleA: { flag: "wardens", taxRate: 0.05, produces: ["rum"], demands: [] },
    isleB: { flag: "gulls", taxRate: 0.05, produces: [], demands: ["rum"] },
    isleC: { flag: null, taxRate: 0, produces: [], demands: [] },
  };
  const markets = {};
  for (const id of islands) {
    markets[id] = new Market(id, { exchange: ex, ...cfg[id], listingFeeBps: 100, nextSeq, now });
    markets[id].seedLiquidity();
  }

  const players = ["p1", "p2", "p3", "p4"];
  for (const p of players) markets.isleA.join(p); // everyone homes at isleA
  expectClean(ex, "after setup");

  const rnd = makeRng(987654321);
  const commodities = markets.isleA.commodities;
  // "sink" (loss-on-sinking) is exercised by sinks.test.mjs; it's left out here so it
  // doesn't deplete the fleet and starve the cargo/move/repair ops of ships to act on.
  const ops = [
    "buy", "sell", "cancel", "build", "produce",
    "load", "unload", "move", "pledge", "seize", "payout", "award", "restock",
    "upkeep", "repair", "damage",
  ];

  for (let i = 0; i < 4000; i++) {
    const m = markets[pick(rnd, islands)];
    const p = pick(rnd, players);
    const c = pick(rnd, commodities);
    const op = pick(rnd, ops);
    clock += (rnd() * 400) | 0; // labor regen marches on
    try {
      switch (op) {
        case "buy": m.placeLimit(p, c, "buy", 1 + ((rnd() * 30) | 0), 1 + ((rnd() * 5) | 0)); break;
        case "sell": m.placeLimit(p, c, "sell", 1 + ((rnd() * 30) | 0), 1 + ((rnd() * 5) | 0)); break;
        case "cancel": {
          const mine = m.balancesOf(p).orders;
          if (mine.length) m.cancel(p, pick(rnd, mine).id);
          break;
        }
        case "build": m.build(p, pick(rnd, m.recipes).id); break;
        case "produce": m.produce(p, pick(rnd, m.recipes).id); break;
        case "load": {
          const sh = m.balancesOf(p).ships.find((s) => s.dockedAt === m.island);
          if (sh) m.loadCargo(p, sh.id, c, 1 + ((rnd() * 5) | 0));
          break;
        }
        case "unload": {
          const sh = m.balancesOf(p).ships.find((s) => s.dockedAt === m.island);
          if (sh) m.unloadCargo(p, sh.id, c, 1 + ((rnd() * 5) | 0));
          break;
        }
        case "move": {
          const sh = pick(rnd, m.balancesOf(p).ships);
          if (sh) m.moveShip(p, sh.id, pick(rnd, islands));
          break;
        }
        case "pledge": m.pledge(p, pick(rnd, ["wardens", "gulls"])); break;
        case "seize": m.seize(p, pick(rnd, ["wardens", "gulls"])); break;
        case "payout": m.payout(p); break;
        case "award": m.award(p, 1 + ((rnd() * 200) | 0)); break;
        case "restock": m.restockDemand(); break;
        case "upkeep": m.tickUpkeep(); break;
        case "repair": {
          const sh = m.balancesOf(p).ships.find((s) => s.dockedAt === m.island && s.hull < s.maxHull);
          if (sh) m.repairShip(p, sh.id);
          break;
        }
        case "damage": {
          const sh = pick(rnd, m.balancesOf(p).ships);
          if (sh) m.resolveShip(sh.id, 1 + ((rnd() * sh.maxHull) | 0)); // 1..maxHull -> never sinks here
          break;
        }
      }
    } catch {
      // invalid for the current state (insufficient funds/goods, not docked, etc.)
      // — expected and fine; the invariants must still hold either way.
    }
    expectClean(ex, `after op #${i} (${op})`);
  }
});
