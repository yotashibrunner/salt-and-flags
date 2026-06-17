// ============================================================================
// Salt & Flags — economy agent simulation (§11, the dynamics half of the play
// tester). Where the fuzzer proves CORRECTNESS (invariants hold under random ops),
// this proves DYNAMICS: a population of economically-motivated bots — producers and
// arbitrage traders — run for a long horizon, and we watch whether the closed loop
// plus the sinks settles into something stable or runs away (inflation / collapse /
// deadlock). Pure + deterministic (seeded RNG, fixed clock) so a run is reproducible.
//
//   Report:  node src/economy/sim.mjs        (prints a per-epoch metrics table)
//   Test:    sim.test.mjs imports runSim() and asserts health bounds.
// ============================================================================
import { pathToFileURL } from "node:url";
import { Exchange } from "./economy.mjs";
import { Market, FLAGS, LISTING_FEE_BPS, DEMAND_LEVY_BPS, EXTRACT_FEE } from "./market.mjs";
import { checkAll } from "./invariants.mjs";

// A small, legible economy: a producing harbor (cheap sugar + rum) and a flagged
// reach that DEMANDS rum (the burn-sink). Traders arbitrage harbor -> reach.
const ISLANDS = [
  // harbor produces sugar (so it can be EXTRACTED here) + rum (seeds cheap). Producers
  // now pay to extract their own feedstock — no free grant — so raw supply costs money.
  { id: "harbor", produces: ["sugar", "rum"], demands: [], flag: null, taxRate: 0 },
  { id: "reach", produces: [], demands: ["rum"], flag: "wardens", taxRate: 0.05 },
];
const HOME = "harbor";
const MARKET = "reach"; // where rum is demanded (and burned)

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// Gini coefficient of a list of wealths (0 = perfectly equal, ->1 = concentrated).
function gini(xs) {
  const v = xs.filter((x) => x >= 0).slice().sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((a, b) => a + b, 0);
  if (n === 0 || sum === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

// --- agent policies (each step is best-effort; an invalid action just no-ops) ---

// Producer: distill starting sugar into rum and REST it as a sell (a price-MAKER,
// undercutting the NPC ask) so traders have a renewable supply to buy. Pays the
// build/listing fees + upkeep. The supplier side of the closed loop.
function stepProducer(a, ctx) {
  const m = ctx.markets[HOME];
  let bal = m.balancesOf(a.id);
  if (!bal.sites.includes("sugar") && bal.poe > 400) { try { m.buildSite(a.id, "sugar"); } catch {} }
  if (!bal.stalls.includes("distill") && bal.poe > 400) { try { m.build(a.id, "distill"); } catch {} }
  bal = m.balancesOf(a.id);
  // extract sugar (pays the fee — the sink) when feedstock is low
  if ((bal.holdings.sugar || 0) < 3 && bal.poe > EXTRACT_FEE) { try { m.extract(a.id, "sugar"); } catch {} }
  try { m.produce(a.id, "distill"); } catch {} // 3 sugar + labor -> 2 rum
  bal = m.balancesOf(a.id);
  const rum = bal.holdings.rum || 0;
  if (rum > 0) {
    // rest the rum as the best ask (seedPrice sits below the NPC ask, above the bids)
    try { m.placeLimit(a.id, "rum", "sell", m.seedPrice("rum"), Math.min(rum, 6)); } catch {}
  }
}

// Trader: a four-phase loop — buy rum cheap at home, sail to the demanding reach,
// sell it into demand (burned), sail home. Profits on the produce/demand price gap,
// minus fees + tax + upkeep; feeds the demand sink.
function stepTrader(a, ctx) {
  const m = ctx.markets[a.loc];
  const bal = m.balancesOf(a.id);
  const ship = bal.ships.find((s) => s.id === a.shipId);
  if (!ship) return; // (no sinking in this sim)
  switch (a.phase) {
    case "buy": {
      const ask = m.depth("rum").asks[0];
      if (ask && bal.poe > ask.price * 6) { try { m.placeLimit(a.id, "rum", "buy", ask.price, 5); } catch {} }
      const have = m.balancesOf(a.id).holdings.rum || 0;
      if (have > 0) { try { m.loadCargo(a.id, a.shipId, "rum", Math.min(have, ship.cargoCap)); a.phase = "sail"; } catch {} }
      break;
    }
    case "sail":
      try { m.moveShip(a.id, a.shipId, MARKET); a.loc = MARKET; a.phase = "sell"; } catch {}
      break;
    case "sell": {
      const held = m.balancesOf(a.id).ships.find((s) => s.id === a.shipId);
      const inHold = held ? (held.hold.rum || 0) : 0;
      if (inHold > 0) { try { m.unloadCargo(a.id, a.shipId, "rum", inHold); } catch {} }
      const have = m.balancesOf(a.id).holdings.rum || 0;
      if (have > 0) {
        const bid = m.depth("rum").bids[0];
        if (bid) { try { m.placeLimit(a.id, "rum", "sell", bid.price, have); } catch {} }
      }
      a.phase = "return";
      break;
    }
    case "return":
      try { m.moveShip(a.id, a.shipId, HOME); a.loc = HOME; a.phase = "buy"; } catch {}
      break;
  }
}

function metrics(ex, agents, markets) {
  const wealth = agents.map((a) => (ex.accounts.has(a.id) ? ex.poeOf(a.id) : 0));
  const playerPoE = wealth.reduce((s, w) => s + w, 0);
  const crown = ex.accounts.has("crown") ? ex.poeOf("crown") : 0;
  const flags = FLAGS.reduce((s, f) => s + (ex.accounts.has(f) ? ex.poeOf(f) : 0), 0);
  const rumPx = markets[MARKET].depth("rum").last || markets[HOME].depth("rum").last;
  return { playerPoE, crown, flags, rumPx, gini: Number(gini(wealth).toFixed(3)), trades: ex.trades.length };
}

// Run the simulation. Returns { history, ex, agents, violation } where history is one
// metrics row per epoch and violation is the first invariant breakage seen (or null).
export function runSim(opts = {}) {
  const epochs = opts.epochs ?? 40;
  const ticksPerEpoch = opts.ticksPerEpoch ?? 40;
  const nProducers = opts.producers ?? 5;
  const nTraders = opts.traders ?? 5;
  const dtMs = opts.dtMs ?? 5000;
  const rnd = makeRng(opts.seed ?? 1234);

  let clock = 1;
  const now = () => clock;
  const ex = new Exchange();
  let seq = 0;
  const markets = {};
  for (const cfg of ISLANDS) {
    markets[cfg.id] = new Market(cfg.id, { exchange: ex, ...cfg, listingFeeBps: LISTING_FEE_BPS, demandLevyBps: DEMAND_LEVY_BPS, nextSeq: () => ++seq, now });
    markets[cfg.id].seedLiquidity();
  }

  const agents = [];
  for (let i = 0; i < nProducers; i++) agents.push({ id: `prod${i}`, role: "producer", loc: HOME });
  for (let i = 0; i < nTraders; i++) agents.push({ id: `trad${i}`, role: "trader", loc: HOME, phase: "buy" });
  for (const a of agents) {
    markets[HOME].join(a.id); // purse + starter goods + a sloop at HOME
    a.shipId = markets[HOME].balancesOf(a.id).ships[0].id;
  }

  const history = [];
  let violation = null;
  let lastTrades = ex.trades.length;
  for (let e = 0; e < epochs; e++) {
    for (let t = 0; t < ticksPerEpoch; t++) {
      clock += dtMs;
      for (const a of agents) {
        try { (a.role === "producer" ? stepProducer : stepTrader)(a, { markets, rnd, now }); }
        catch { /* an agent's action was invalid for the current state — skip */ }
      }
      markets[MARKET].restockDemand(); // keep a standing buyer so trade doesn't deadlock
    }
    // end-of-epoch upkeep (recurring rent — the deflationary pressure)
    for (const id of Object.keys(markets)) markets[id].tickUpkeep();

    const v = checkAll(ex);
    if (v && !violation) violation = { epoch: e, ...v };
    const m = metrics(ex, agents, markets);
    m.volume = ex.trades.length - lastTrades;
    lastTrades = ex.trades.length;
    history.push({ epoch: e, ...m });
  }
  return { history, ex, agents, violation };
}

// --- CLI: print a per-epoch metrics table ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { history, ex, violation } = runSim({});
  console.table(history.map((h) => ({
    epoch: h.epoch, playerPoE: h.playerPoE, crown: h.crown, flags: h.flags,
    rumPx: h.rumPx, gini: h.gini, volume: h.volume,
  })));
  console.log(`\ntotalPoE ${ex.totalPoe()} === minted ${ex.minted}: ${ex.totalPoe() === ex.minted}`);
  console.log(`invariants: ${violation ? `BROKE at epoch ${violation.epoch}: ${violation.name} (${violation.detail})` : "held every epoch"}`);
}
