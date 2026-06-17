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
import { Market, FLAGS, LISTING_FEE_BPS, DEMAND_LEVY_BPS, EXTRACT_FEE, DEMAND_RESERVE, PRIZE_CAP } from "./market.mjs";
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
  // back off when our unsold rum is already resting on the book — don't make what we
  // can't sell (also keeps the order book bounded over a long run)
  const restingRum = bal.orders.reduce((s, o) => s + (o.commodity === "rum" && o.side === "sell" ? o.qty : 0), 0);
  if (restingRum >= 12) return;
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

const ROUTE_DIST = 4;     // lane length harbor <-> reach
const ROUTE_DANGER = 0.03; // modest transit risk: mostly damage, the occasional sinking

// Trader: arbitrage harbor <-> reach, driven by where the ship actually IS. Buy rum at
// harbor, sail (now a real voyage — the ship is at sea until it lands), sell into demand
// at reach, sail home. If the ship is sunk in transit, buy a replacement and carry on.
function stepTrader(a, ctx) {
  const ship = ctx.markets[HOME].balancesOf(a.id).ships[0]; // the fleet view is global
  if (!ship) { // sunk: replace it at the last port if we can afford one
    try { ctx.markets[a.loc].buyShip(a.id, "sloop"); } catch {}
    return;
  }
  if (ship.voyage) return; // at sea — wait for arrival (tickVoyages lands it)
  const here = ship.dockedAt;
  a.loc = here;
  const m = ctx.markets[here];

  if (here === HOME) {
    // buy rum cheap, load it, set sail for the demanding reach
    const ask = m.depth("rum").asks[0];
    const bal = m.balancesOf(a.id);
    if (ask && bal.poe > ask.price * 6) { try { m.placeLimit(a.id, "rum", "buy", ask.price, 5); } catch {} }
    const have = m.balancesOf(a.id).holdings.rum || 0;
    if (have > 0) {
      try { m.loadCargo(a.id, ship.id, "rum", Math.min(have, ship.cargoCap)); } catch {}
      try { m.moveShip(a.id, ship.id, MARKET, ROUTE_DIST, ROUTE_DANGER); } catch {}
    }
  } else if (here === MARKET) {
    // unload + sell into demand (burned), then sail home
    const held = m.balancesOf(a.id).ships[0];
    const inHold = held ? (held.hold.rum || 0) : 0;
    if (inHold > 0) { try { m.unloadCargo(a.id, ship.id, "rum", inHold); } catch {} }
    const have = m.balancesOf(a.id).holdings.rum || 0;
    if (have > 0) {
      const bid = m.depth("rum").bids[0];
      if (bid) { try { m.placeLimit(a.id, "rum", "sell", bid.price, have); } catch {} }
    }
    try { m.moveShip(a.id, ship.id, HOME, ROUTE_DIST, ROUTE_DANGER); } catch {}
  }
}

const RAID_PROB = 0.25;   // chance a docked raider engages on a given tick

// Raider: fights NPC ships for plunder. Drives the battle ECONOMICS directly (the same
// market primitives hub.concludeBattle uses) rather than a live PillageRoom — so the
// plunder faucet + salvage + repair/rebuild sinks are all exercised in the sim.
function stepRaider(a, ctx) {
  const m = ctx.markets[HOME];
  const ship = m.balancesOf(a.id).ships[0];
  if (!ship) { try { m.buyShip(a.id, "sloop"); } catch {} return; } // lost the last fight -> rebuy (sink)
  if (ship.voyage) return;
  if (ship.hull < ship.maxHull - 3) { try { m.repairShip(a.id, ship.id); } catch {} } // patch up (sink)
  if (ctx.rnd() > RAID_PROB) return;

  let enemy;
  try { enemy = m.spawnRaider("sloop", HOME, { rum: 6, shot: 3 }); } catch { return; }
  if (ctx.rnd() < 0.7) {                                  // win
    try { m.pvePlunder(a.id); } catch {}                  // PvE plunder from the capped prize pool
    try { m.resolveShip(enemy, 0); } catch {}             // enemy sunk -> salvageable wreck here
    try { m.resolveShip(ship.id, Math.max(1, ship.hull - 4)); } catch {} // took damage
    for (const c of ["rum", "shot"]) { try { m.salvage(a.id, c, 99); } catch {} } // grab the spoils
  } else {                                                // loss
    try { m.resolveShip(ship.id, 0); } catch {}           // own ship sunk (loss-on-sinking)
    try { m.resolveShip(enemy, 0); } catch {}             // clear the enemy off the board
  }
}

function metrics(ex, agents, markets) {
  const wealth = agents.map((a) => (ex.accounts.has(a.id) ? ex.poeOf(a.id) : 0));
  const playerPoE = wealth.reduce((s, w) => s + w, 0);
  const crown = ex.accounts.has("crown") ? ex.poeOf("crown") : 0;
  const flags = FLAGS.reduce((s, f) => s + (ex.accounts.has(f) ? ex.poeOf(f) : 0), 0);
  const rumPx = markets[MARKET].depth("rum").last || markets[HOME].depth("rum").last;
  const rumHome = markets[HOME].depth("rum").last;
  return { playerPoE, crown, flags, rumPx, rumHome, gini: Number(gini(wealth).toFixed(3)), trades: ex.trades.length };
}

// Run the simulation. Returns { history, ex, agents, violation } where history is one
// metrics row per epoch and violation is the first invariant breakage seen (or null).
export function runSim(opts = {}) {
  const epochs = opts.epochs ?? 40;
  const ticksPerEpoch = opts.ticksPerEpoch ?? 40;
  const nProducers = opts.producers ?? 5;
  const nTraders = opts.traders ?? 5;
  const nRaiders = opts.raiders ?? 0; // off by default so the health test population is unchanged
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
  for (let i = 0; i < nRaiders; i++) agents.push({ id: `raid${i}`, role: "raider", loc: HOME });
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
        const step = a.role === "producer" ? stepProducer : a.role === "trader" ? stepTrader : stepRaider;
        try { step(a, { markets, rnd, now }); }
        catch { /* an agent's action was invalid for the current state — skip */ }
      }
      markets[MARKET].restockDemand(); // keep a standing buyer so trade doesn't deadlock
      markets[HOME].tickVoyages();     // land arrivals (rolls transit encounters: damage / sinking)
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

// --- CLI: node sim.mjs [epochs ticksPerEpoch producers traders raiders seed] ---
// Long-horizon report: the player money-supply curve, drift, price stability, the
// faucet/sink breakdown, and any invariant failure.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = (i, d) => (process.argv[i] !== undefined ? Number(process.argv[i]) : d);
  const cfg = { epochs: n(2, 250), ticksPerEpoch: n(3, 100), producers: n(4, 6), traders: n(5, 6), raiders: n(6, 3), seed: n(7, 1234) };
  const totalTicks = cfg.epochs * cfg.ticksPerEpoch;
  console.log(`sim: ${cfg.producers} producers + ${cfg.traders} traders + ${cfg.raiders} raiders, ${cfg.epochs} epochs x ${cfg.ticksPerEpoch} ticks = ${totalTicks} ticks (seed ${cfg.seed})\n`);

  const { history, ex, violation } = runSim(cfg);
  const H = history.length;
  const at = (h) => ({ epoch: h.epoch, playerPoE: h.playerPoE, crown: h.crown, flags: h.flags, rumHome: h.rumHome, rumMkt: h.rumPx, gini: h.gini, vol: h.volume });
  // sample ~20 rows across the run
  const stride = Math.max(1, Math.floor(H / 20));
  console.log("money-supply curve (sampled):");
  console.table(history.filter((_, i) => i % stride === 0 || i === H - 1).map(at));

  // drift: compare average per-epoch growth of playerPoE in the first vs second half
  const first = history[0].playerPoE, mid = history[Math.floor(H / 2)].playerPoE, last = history[H - 1].playerPoE;
  const slope1 = (mid - first) / Math.max(1, Math.floor(H / 2));
  const slope2 = (last - mid) / Math.max(1, H - Math.floor(H / 2));
  const verdict = Math.abs(slope2) < Math.abs(slope1) * 0.25 ? "FLATTENING (approaching steady state)"
    : Math.abs(slope2) < Math.abs(slope1) * 0.9 ? "still drifting but decelerating"
    : slope2 > 0 ? "DRIFTING UP ~linearly (faucets > sinks)" : "DRIFTING DOWN ~linearly (sinks > faucets)";
  console.log(`\nplayer money supply: start ${first} -> mid ${mid} -> end ${last}`);
  console.log(`  per-epoch growth: 1st half ${slope1.toFixed(1)}/epoch, 2nd half ${slope2.toFixed(1)}/epoch -> ${verdict}`);

  // price stability (rumPx = last trade at the demand market, rumHome = at the producer port)
  const px = history.map((h) => h.rumPx).filter((p) => p > 0);
  const pxH = history.map((h) => h.rumHome).filter((p) => p > 0);
  console.log(`\nrum @ demand: min ${Math.min(...px)} max ${Math.max(...px)} last ${px.at(-1)}   rum @ home: min ${Math.min(...pxH)} max ${Math.max(...pxH)}  (anchored by seed/demand pricing)`);

  // faucet / sink accounting: sum the ledger by reason (positive deltas = total flowed)
  const flow = {};
  for (const e of ex.ledger.entries) if (e.delta > 0) flow[e.reason] = (flow[e.reason] || 0) + e.delta;
  const plunder = flow["plunder"] || 0;                 // PvE faucet (capped prize pool -> players)
  const pvp = flow["pvp_plunder"] || 0;                 // PvP transfer (0 in this PvE-only sim)
  const lom = flow["letter_of_marque"] || 0;            // crown cut on plunder (sink)
  const demandPaid = ex.accounts.has("demand") ? DEMAND_RESERVE - ex.poeOf("demand") : 0;
  const crown = ex.accounts.has("crown") ? ex.poeOf("crown") : 0;
  const flagsHeld = FLAGS.reduce((s, f) => s + (ex.accounts.has(f) ? ex.poeOf(f) : 0), 0);
  const pool = ex.accounts.has("prize") ? ex.poeOf("prize") : 0;
  console.log(`\nfaucets into players:  PvE plunder ${plunder}   demand payouts ${demandPaid}   (PvP transfers ${pvp})`);
  console.log(`sinks out of players:  crown(burned) ${crown}   incl. letter-of-marque ${lom}   flags(locked) ${flagsHeld}`);
  console.log(`prize pool: ${pool}/${PRIZE_CAP} (PvE faucet is rate-limited by the pool refill)`);

  console.log(`\nconservation: totalPoE ${ex.totalPoe()} === minted ${ex.minted}: ${ex.totalPoe() === ex.minted}`);
  console.log(`invariants: ${violation ? `BROKE at epoch ${violation.epoch}: ${violation.name} (${violation.detail})` : "held every epoch"}`);
}
