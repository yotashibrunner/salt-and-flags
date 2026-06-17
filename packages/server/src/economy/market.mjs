// ============================================================================
// Salt & Flags — Market core (one view per island over a shared Exchange).
// The authoritative brain the Colyseus MarketRoom owns: it wraps the canonical
// engine (economy.mjs), manages accounts, validates intents, seeds NPC liquidity,
// and produces the public book + private balance snapshots the room broadcasts.
//
// Persistence (optional): when a `store` is attached, every state-changing action
// (account create, place, cancel) is recorded as an append-only INTENT, and any
// trades/ledger rows it produced are projected to the audit tables. On boot the
// server REPLAYS the intent log through a fresh Exchange (`replay()` below) to
// rebuild identical state — money-safe because restart uses the very same engine
// code path. No network/DB deps here, so it stays pure and unit-testable.
// ============================================================================

import { Exchange } from "./economy.mjs";

// Commodities listed on every island market (ids mirror shared COMMODITIES).
export const MARKET_COMMODITIES = [
  "hemp", "wood", "ironore", "sugar", "cloth",
  "iron", "planks", "rum", "sailcloth", "shot",
];

// Reference price per commodity (pieces of eight). ONLY used to seed the NPC
// book so there is something to trade at boot — never sent to clients as truth.
export const BASE_PRICE = {
  hemp: 6, wood: 5, ironore: 8, sugar: 5, cloth: 12,
  iron: 16, planks: 11, rum: 24, sailcloth: 30, shot: 20,
};

export const NEW_PLAYER_POE = 1000;
const NEW_PLAYER_UNITS = 25; // of each listed commodity, so a new player can sell

// Production recipes (server source of truth; mirrors @salt/shared RECIPES, kept
// local so this stays importable under `node --test` without the TS package).
// Running one consumes inputs + labor and yields outputs — a FAUCET of goods, so
// commodity units are intentionally NOT conserved by production (PoE is untouched).
export const RECIPES = [
  { id: "distill", stall: "Distillery", inputs: { sugar: 3 },   outputs: { rum: 2 },       labor: 4 },
  { id: "weave",   stall: "Weavery",    inputs: { hemp: 3 },    outputs: { cloth: 2 },     labor: 3 },
  { id: "tailor",  stall: "Sail Loft",  inputs: { cloth: 2 },   outputs: { sailcloth: 1 }, labor: 5 },
  { id: "saw",     stall: "Sawmill",    inputs: { wood: 3 },    outputs: { planks: 2 },    labor: 3 },
  { id: "smelt",   stall: "Foundry",    inputs: { ironore: 3 }, outputs: { iron: 2 },      labor: 4 },
  { id: "cast",    stall: "Ironworks",  inputs: { iron: 2 },    outputs: { shot: 3 },      labor: 6 },
];
const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

// Labor regenerates over time up to a cap. To keep persistence REPLAYABLE, labor
// is never stored as a moving number: each account holds { amount, ts } and the
// live value is computed from the elapsed time since `ts`. Every labor change
// (account create, produce) records its timestamp on the intent, so replaying the
// log reproduces { amount, ts } exactly and regen continues from there on boot.
export const LABOR_START = 100;     // starting (and max) pool
export const LABOR_MAX = 100;
export const LABOR_REGEN_MS = 1000; // +1 labor per second, capped at LABOR_MAX

// Current labor for `owner` at time `now` (regen since last change, capped). Pure
// read — does not mutate stored state, so it needs no persistence.
export function laborAt(ex, owner, now) {
  const e = ex.labor && ex.labor.get(owner);
  if (!e) return 0;
  const gained = Math.max(0, Math.floor((now - e.ts) / LABOR_REGEN_MS));
  return Math.min(LABOR_MAX, e.amount + gained);
}

// --- stalls: production is gated on owning a stall for that recipe at the island ---
export const STALL_COST = 150; // PoE to build a stall (transferred to the crown, so PoE is conserved)
function stallKey(owner, island, recipe) { return `${owner} ${island} ${recipe}`; }

export const UNCLAIMED_TREASURY = "unclaimed"; // collects build levies on flag-less islands

// Build a stall for `owner` at `island`: charge the build levy (player -> `to`, the
// island's controlling flag treasury, via the ledger so PoE is conserved) and
// register ownership. Used live AND on replay (the destination is on the intent),
// so the rule lives in one place. Throws on unknown recipe / duplicate / shortfall.
function applyBuild(ex, owner, island, recipeId, to) {
  const r = RECIPE_BY_ID[recipeId];
  if (!r) throw new Error(`unknown recipe: ${recipeId}`);
  const a = ex.accounts.get(owner);
  if (!a) throw new Error(`no account: ${owner}`);
  if (!ex.stalls) ex.stalls = new Map();
  const key = stallKey(owner, island, recipeId);
  if (ex.stalls.has(key)) throw new Error(`you already own a ${r.stall} here`);
  if (a.poe < STALL_COST) throw new Error(`insufficient PoE to build (need ${STALL_COST})`);
  if (!ex.accounts.has(to)) ex.createAccount(to, 0); // flag (or unclaimed) treasury
  a.poe -= STALL_COST;
  ex.accounts.get(to).poe += STALL_COST;
  ex.ledger.postPair(owner, to, STALL_COST, "stall_levy");
  const stall = { owner, island, recipe: recipeId, stall: r.stall };
  ex.stalls.set(key, stall);
  return stall;
}

// --- raw extraction: the renewable INPUT end of the production loop (claim-gated) ---
// A captain builds an extraction site (plantation/mine) at an island that PRODUCES a
// raw, then extracts it for labor + a per-pull PoE fee. The fee is a SINK (split
// crown/flag) — the lever the agent sim showed is needed to offset the demand faucet —
// and the site accrues upkeep. So raw supply is renewable, but it COSTS money, not free.
export const RAWS = new Set(["hemp", "wood", "ironore", "sugar"]); // tier "raw" (mirrors @salt/shared)
export const SITE_COST = 120;   // build levy for an extraction site (-> flag/unclaimed; a transfer)
export const EXTRACT_LABOR = 3; // labor per pull
export const EXTRACT_YIELD = 4; // raw units per pull
export const EXTRACT_FEE = 25;  // PoE per pull (the money sink — tuned against the sim)
function siteKey(owner, island, commodity) { return `${owner} ${island} ${commodity}`; }

// Register an extraction site, charging the build levy (player -> the island's flag
// treasury, or unclaimed) like a stall. Used live AND on replay.
function applyBuildSite(ex, owner, island, commodity, to) {
  const a = ex.accounts.get(owner);
  if (!a) throw new Error(`no account: ${owner}`);
  if (!ex.sites) ex.sites = new Map();
  const key = siteKey(owner, island, commodity);
  if (ex.sites.has(key)) throw new Error(`you already have a ${commodity} site here`);
  if (a.poe < SITE_COST) throw new Error(`insufficient PoE to build (need ${SITE_COST})`);
  if (!ex.accounts.has(to)) ex.createAccount(to, 0);
  a.poe -= SITE_COST;
  ex.accounts.get(to).poe += SITE_COST;
  ex.ledger.postPair(owner, to, SITE_COST, "site_levy");
  const site = { owner, island, commodity };
  ex.sites.set(key, site);
  return site;
}

// Extract one pull: spend labor + the PoE fee (a SINK), then mint the raw into the
// owner's warehouse here. Affordability-gated (no half-price pull when broke), so the
// fee always lands in full. Used live AND on replay (fee/flag/ts ride on the intent).
function applyExtract(ex, owner, island, commodity, fee, flag, now) {
  const a = ex.accounts.get(owner);
  if (!a) throw new Error(`no account: ${owner}`);
  if (!ex.labor) ex.labor = new Map();
  const have = laborAt(ex, owner, now);
  if (have < EXTRACT_LABOR) throw new Error(`not enough labor (need ${EXTRACT_LABOR}, have ${have})`);
  if (a.poe < fee) throw new Error(`insufficient PoE to extract (need ${fee})`);
  applyDrain(ex, owner, fee, "extract", flag);
  ex.mint(ex.whId(owner, island), commodity, EXTRACT_YIELD);
  ex.labor.set(owner, { amount: have - EXTRACT_LABOR, ts: now });
}

// --- plunder: combat MOVES wealth, it doesn't mint it. PvP loots the defeated player
// (their cargo + a share of coin — a zero-sum TRANSFER); PvE pays from a CAPPED, rate-
// limited prize pool (a controlled FAUCET, not the old infinite reserve); both pay a
// letter-of-marque cut to the crown (a SINK), so combat is net-neutral-to-deflationary. ---
export const PRIZE = "prize";          // capped, drainable PvE prize pool (replaced the infinite bounty)
export const PRIZE_RESERVE = 20_000;   // starting pool
export const PRIZE_REGEN = 6;          // PoE refilled per SECOND of game time (the rate-limited PvE faucet)
export const PRIZE_CAP = 20_000;       // the pool never refills above this
export const PVE_PLUNDER = 80;         // coin a PvE win draws from the pool (capped by the pool)
export const PVP_COIN_BPS = 3000;      // share of a defeated PLAYER's coin the victor takes (a transfer)
export const PLUNDER_CROWN_BPS = 1500; // letter-of-marque cut of plunder coin -> crown (a SINK)

// Skim the letter-of-marque fee from a plunder payout (player -> crown, a terminal SINK).
function plunderCrownCut(ex, playerId, gross) {
  const cut = Math.floor((gross * PLUNDER_CROWN_BPS) / 10000);
  if (cut <= 0) return 0;
  if (!ex.accounts.has(CROWN)) ex.createAccount(CROWN, 0);
  ex.accounts.get(playerId).poe -= cut;
  ex.accounts.get(CROWN).poe += cut;
  ex.ledger.postPair(playerId, CROWN, cut, "letter_of_marque");
  return cut;
}

// PvE plunder: lazily refill the prize pool from elapsed game time (the rate-limited
// faucet — new PoE, capped at PRIZE_CAP), then pay the winner from it and skim the crown
// cut. Capped by the pool, so no number of wins extracts faster than the pool refills.
// Used live AND on replay (the win's timestamp rides on the intent).
function applyPvePlunder(ex, playerId, now) {
  if (!ex.accounts.has(PRIZE)) { ex.createAccount(PRIZE, PRIZE_RESERVE); ex.prizeTs = now; }
  if (!ex.accounts.has(playerId)) ex.createAccount(playerId, 0);
  const pool = ex.accounts.get(PRIZE);
  const refill = Math.min(PRIZE_CAP - pool.poe, Math.max(0, Math.floor((now - (ex.prizeTs ?? now)) / 1000)) * PRIZE_REGEN);
  if (refill > 0) { pool.poe += refill; ex.minted += refill; } // the faucet: new money into the pool
  ex.prizeTs = now;
  const gross = Math.min(PVE_PLUNDER, pool.poe);
  if (gross <= 0) return 0;
  pool.poe -= gross; ex.accounts.get(playerId).poe += gross;
  ex.ledger.postPair(PRIZE, playerId, gross, "plunder"); // FAUCET (pool -> player)
  plunderCrownCut(ex, playerId, gross);                   // SINK
  return gross;
}

// PvP plunder: the victor loots the defeated PLAYER — the loser's hold cargo to the
// victor's warehouse here, plus a share of their coin (zero-sum TRANSFER), minus the crown
// cut (SINK). No minting — piracy moves wealth. Used live AND on replay.
function applyPvpPlunder(ex, winnerId, island, loserId, loserShipId, coinBps) {
  const hold = ex.accounts.get(`hold:${loserShipId}`);
  if (hold) {
    const w = ex._inv(ex.whId(winnerId, island));
    for (const c of Object.keys(hold.inv)) { const q = hold.inv[c]; if (q > 0) { hold.inv[c] = 0; w.inv[c] = (w.inv[c] || 0) + q; } }
  }
  const loser = ex.accounts.get(loserId);
  const take = loser ? Math.floor((loser.poe * coinBps) / 10000) : 0;
  if (take > 0) {
    loser.poe -= take;
    ex.accounts.get(winnerId).poe += take;
    ex.ledger.postPair(loserId, winnerId, take, "pvp_plunder"); // TRANSFER (loser -> victor)
    plunderCrownCut(ex, winnerId, take);                         // SINK
  }
}

// --- NPC finished-goods demand: the closing end of the production loop ---
// At islands that DEMAND a finished good, a dedicated reserve ("demand") rests a
// standing buy order for it. When a player sells into that bid the goods are BURNED
// (a true goods SINK — finished goods leave play) and PoE is paid from the reserve
// (a FAUCET). Demand is BOUNDED: total resting demand for a good is capped, and the
// room tops it back up to the cap on a tick (recorded as ordinary `place` intents,
// so a restart replays demand exactly — including the burns the fills produce).
export const DEMAND = "demand";              // pre-funded reserve that buys finished goods to destroy
export const DEMAND_RESERVE = 1_000_000_000; // deep PoE so the faucet never dries up
export const DEMAND_CAP = 20;                // max units of a good resting in demand per island
export const FINISHED = new Set(["rum", "sailcloth", "shot"]); // tier "finished" (mirrors @salt/shared)
export const DEMAND_LEVY_BPS = 2700; // sink skimmed from demand SALES
export const RAIDER = "raider";              // owner of NPC enemy ships spawned for battles

// Burn every unit the demand reserve just bought: settle deposited it into
// wh:demand:island, so remove it there. mintedUnits drops in lockstep (ex.burn), so
// totalUnits stays reconciled. Used live (after each place) AND on replay, so the
// sink is reproduced without persisting anything beyond the place that triggered it.
function applyDemandBurn(ex, trades) {
  for (const t of trades) {
    if (t.buyer === DEMAND) ex.burn(ex.whId(DEMAND, t.island), t.commodity, t.qty);
  }
}

// Skim a levy from each DEMAND sale's proceeds (the seller was just paid by the
// reserve, so the funds are there) as a SINK — this drains the premium NPC demand
// injects, the lever the sim showed flattens the money supply. Rate 0 => off (the
// default for unit tests; the server sets it). Used live AND on replay. applyDrain
// clamps to the seller's funds, so it can never push them negative.
function applyDemandLevy(ex, trades, flag, bps) {
  if (!bps || bps <= 0) return;
  for (const t of trades) {
    if (t.buyer !== DEMAND) continue;
    const levy = Math.floor((t.price * t.qty * bps) / 10000);
    if (levy > 0) applyDrain(ex, t.seller, levy, "demand_levy", flag);
  }
}

// --- flag conquest: a flag can seize an island, rerouting its royalties ---
export const FLAGS = ["wardens", "gulls", "iron", "sash", "crown"]; // factions (mirror worldgen)
export const CONQUEST_COST = 200; // PoE a captain spends to seize an island (-> warchest sink)
export const WARCHEST = "warchest"; // neutral sink for resources consumed by war

// Flip `island`'s controlling flag to `flag`, charging the captain the conquest
// cost into the warchest (PoE-conserving). Used live AND on replay.
function applySeize(ex, owner, island, flag, cost) {
  if (!ex.islandFlag) ex.islandFlag = new Map();
  if (!ex.accounts.has(WARCHEST)) ex.createAccount(WARCHEST, 0);
  ex.accounts.get(owner).poe -= cost;
  ex.accounts.get(WARCHEST).poe += cost;
  ex.ledger.postPair(owner, WARCHEST, cost, "conquest");
  ex.islandFlag.set(island, flag);
}

// --- blockades: a contested, labor-driven tug-of-war for an island (vs. the instant
// `seize`). An attacking flag declares one (a PoE sink -> warchest), then its crews PUSH
// the control meter up while the defenders push it DOWN — each push spends labor. At 100
// the attacker takes the island (royalties reroute, like a seize); at 0 the defenders
// hold and it lifts. Resolves on the meter (no timer needed). Used live AND on replay. ---
export const BLOCKADE_COST = 200; // PoE to declare (-> warchest sink)
export const BLOCKADE_START = 50; // control meter at declaration
export const BLOCKADE_MAX = 100;  // attacker wins at >= MAX, defender holds at <= 0
export const BLOCKADE_STEP = 10;  // meter shift per labor push
export const BLOCKADE_LABOR = 8;  // labor spent per push
export const BLOCKADE_BATTLE_STEP = 25; // meter shift from WINNING a battle in contested waters

function applyDeclareBlockade(ex, owner, island, attacker, defender, cost) {
  if (!ex.blockades) ex.blockades = new Map();
  if (!ex.accounts.has(WARCHEST)) ex.createAccount(WARCHEST, 0);
  ex.accounts.get(owner).poe -= cost;
  ex.accounts.get(WARCHEST).poe += cost;
  ex.ledger.postPair(owner, WARCHEST, cost, "blockade");
  ex.blockades.set(island, { attacker, defender: defender ?? null, meter: BLOCKADE_START });
}

// Shift a blockade's meter (attack=up, defend=down) and resolve if it hits a bound: the
// attacker taking the island reroutes its royalties (islandFlag override); the defender
// holding lifts the blockade. No-op if there's no blockade. Shared by labor pushes and
// battle wins. Used live AND on replay.
function applyBlockadeMeter(ex, island, side, step) {
  const b = ex.blockades && ex.blockades.get(island);
  if (!b) return;
  b.meter += side === "attack" ? step : -step;
  if (b.meter >= BLOCKADE_MAX) { if (!ex.islandFlag) ex.islandFlag = new Map(); ex.islandFlag.set(island, b.attacker); ex.blockades.delete(island); }
  else if (b.meter <= 0) { ex.blockades.delete(island); }
}

// One LABOR push on the blockade at `island`: spend labor, then shift the meter. Labor-
// gated; throws if short (replay reproduces the same state, so it won't throw there).
function applyBlockadePush(ex, owner, island, side, now) {
  if (!ex.blockades || !ex.blockades.get(island)) throw new Error("no blockade here");
  if (!ex.labor) ex.labor = new Map();
  const have = laborAt(ex, owner, now);
  if (have < BLOCKADE_LABOR) throw new Error(`not enough labor (need ${BLOCKADE_LABOR}, have ${have})`);
  ex.labor.set(owner, { amount: have - BLOCKADE_LABOR, ts: now });
  applyBlockadeMeter(ex, island, side, BLOCKADE_STEP);
}

// --- flag membership + payouts (the spend side of royalties) ---
// Pledge `owner` to `flag` (idempotent). Membership is global to the flag.
function applyPledge(ex, owner, flag) {
  if (!ex.flagMembers) ex.flagMembers = new Map();
  let s = ex.flagMembers.get(flag);
  if (!s) { s = new Set(); ex.flagMembers.set(flag, s); }
  s.add(owner);
}

// Distribute `flag`'s whole treasury equally among its pledged members (integer
// split; any remainder stays in the treasury). PoE-conserving transfer to the
// ledger. Used live AND on replay (deterministic from membership + treasury, so
// no amount needs recording). Returns the per-member payout (0 if none).
function applyPayout(ex, flag) {
  const members = ex.flagMembers && ex.flagMembers.get(flag);
  const treasury = ex.accounts.has(flag) ? ex.accounts.get(flag).poe : 0;
  if (!members || members.size === 0 || treasury <= 0) return 0;
  const per = Math.floor(treasury / members.size);
  if (per <= 0) return 0;
  for (const m of members) {
    ex.accounts.get(flag).poe -= per;
    ex.accounts.get(m).poe += per;
    ex.ledger.postPair(flag, m, per, "flag_payout");
  }
  return per;
}

// --- crews: player-formed groups with a shared coffer (a `crew:{id}` account). Unlike
// flags (pre-set factions fed by territory royalties), a crew is an ad-hoc party that
// pools PoE for joint ventures. Members contribute; the captain withdraws. All movements
// are conserving transfers player<->coffer (no money created). Used live AND on replay. ---
function crewCoffer(crewId) { return `crew:${crewId}`; }
function applyFormCrew(ex, crewId, captain, name) {
  if (!ex.crews) ex.crews = new Map();
  ex.crews.set(crewId, { name, captain, members: new Set([captain]) });
  if (!ex.accounts.has(crewCoffer(crewId))) ex.createAccount(crewCoffer(crewId), 0);
  const n = Number(String(crewId).replace(/^c/, "")); // keep the live counter ahead on replay
  if (Number.isFinite(n)) ex._cid = Math.max(ex._cid || 0, n);
}
function applyJoinCrew(ex, crewId, playerId) {
  const c = ex.crews && ex.crews.get(crewId);
  if (!c) throw new Error(`no such crew: ${crewId}`);
  c.members.add(playerId);
}
function applyCrewDeposit(ex, crewId, playerId, amount) {
  ex.accounts.get(playerId).poe -= amount;
  ex.accounts.get(crewCoffer(crewId)).poe += amount;
  ex.ledger.postPair(playerId, crewCoffer(crewId), amount, "crew_deposit");
}
function applyCrewWithdraw(ex, crewId, playerId, amount) {
  ex.accounts.get(crewCoffer(crewId)).poe -= amount;
  ex.accounts.get(playerId).poe += amount;
  ex.ledger.postPair(crewCoffer(crewId), playerId, amount, "crew_withdraw");
}

// --- captain names: a human display name over the cryptographic player id. Unique
// (one owner per name), claimable + renameable. No PoE, so it never touches the ledger.
// Used live AND on replay. ---
export const NAME_MAX = 24;
function applySetName(ex, playerId, name) {
  if (!ex.names) ex.names = new Map();        // playerId -> name
  if (!ex.nameOwners) ex.nameOwners = new Map(); // name -> playerId (uniqueness)
  const taken = ex.nameOwners.get(name);
  if (taken && taken !== playerId) throw new Error(`the name "${name}" is already taken`);
  const prev = ex.names.get(playerId);
  if (prev && prev !== name) ex.nameOwners.delete(prev); // free the old name on rename
  ex.names.set(playerId, name);
  ex.nameOwners.set(name, playerId);
}

// Skim a commerce tax from each fill's SELLER (who was just credited the sale
// proceeds, so the funds are always there — tax < proceeds, never negative) to the
// island's controlling flag. PoE-conserving transfer, posted to the ledger. Used
// live AND on replay (rate/flag come off the place intent). No-op when unflagged
// or rate 0 — so it never touches the standalone/in-memory paths.
function applyTradeTax(ex, trades, flag, rate) {
  if (!flag || !rate) return;
  for (const t of trades) {
    const tax = Math.floor(t.price * t.qty * rate);
    if (tax <= 0) continue;
    if (!ex.accounts.has(flag)) ex.createAccount(flag, 0);
    ex.accounts.get(t.seller).poe -= tax;
    ex.accounts.get(flag).poe += tax;
    ex.ledger.postPair(t.seller, flag, tax, "trade_tax");
  }
}

// --- PoE sinks: the economy's money drains (fees, upkeep, repair) ---
// Drained PoE is SPLIT: SINK_BURN_BPS to the CROWN (terminal — it never pays out, so
// player-held money genuinely shrinks) and the remainder to the island's controlling
// flag (territory income, redistributed via payout). Unflagged islands send it all to
// the crown. This is the economy's first real deflationary pressure.
export const CROWN = "crown";            // terminal sink account (never pays out)
export const SINK_BURN_BPS = 6000;        // 60% burned to crown, 40% to the controlling flag
export const LISTING_FEE_BPS = 100;       // 1% of an order's notional, charged to the placer
export const UPKEEP_PERIOD_MS = 60_000;   // one upkeep cycle
export const UPKEEP_STALL = 5;            // PoE per cycle per stall owned here
export const UPKEEP_SHIP = 3;             // PoE per cycle per ship docked here
export const UPKEEP_SITE = 4;             // PoE per cycle per extraction site owned here

// Accounts that are part of the system plumbing, not a player's holdings. They never
// pay fees/upkeep, and the flag-share of a drain is never routed back into one.
const SYSTEM_ACCOUNTS = new Set(["ESCROW", "npc", DEMAND, PRIZE, WARCHEST, CROWN, UNCLAIMED_TREASURY, RAIDER, ...FLAGS]);
export function isSystemOwner(id) { return SYSTEM_ACCOUNTS.has(id); }

// Charge `amount` PoE from `payer` as a SINK, clamped to what they hold (soft model —
// no debt this slice). Splits SINK_BURN_BPS to the crown (terminal) and the rest to
// `flag` (territory income), or all to the crown when unflagged. `reason` labels the
// burned portion (a SINK reason); the flag share is a TRANSFER ("flag_levy"). Used
// live AND on replay. Returns the amount actually charged.
function applyDrain(ex, payer, amount, reason, flag) {
  if (!ex.accounts.has(payer)) return 0;
  const p = ex.accounts.get(payer);
  const pay = Math.min(Math.max(0, Math.floor(amount)), p.poe);
  if (pay <= 0) return 0;
  if (!ex.accounts.has(CROWN)) ex.createAccount(CROWN, 0);
  const burned = Math.floor((pay * SINK_BURN_BPS) / 10000);
  const toFlag = pay - burned;
  p.poe -= burned; ex.accounts.get(CROWN).poe += burned;
  ex.ledger.postPair(payer, CROWN, burned, reason);
  if (toFlag > 0) {
    if (flag) { // the controlling flag's treasury (territory income, redistributed via payout)
      if (!ex.accounts.has(flag)) ex.createAccount(flag, 0);
      p.poe -= toFlag; ex.accounts.get(flag).poe += toFlag;
      ex.ledger.postPair(payer, flag, toFlag, "flag_levy");
    } else { // unflagged -> the whole drain is burned to the crown

      p.poe -= toFlag; ex.accounts.get(CROWN).poe += toFlag;
      ex.ledger.postPair(payer, CROWN, toFlag, reason);
    }
  }
  return pay;
}

// A listing fee on a player's order (NPC/demand liquidity is exempt), at `bps` of the
// order's notional. Rate 0 => no fee (the default for unit tests; the server sets it),
// so it never perturbs the order-book balance tests. Deterministic from the order, so
// it runs in both the live place path and replay (the rate rides on the place intent).
function applyListingFee(ex, owner, price, qty, flag, bps) {
  if (!bps || bps <= 0 || isSystemOwner(owner)) return 0;
  const fee = Math.max(1, Math.floor((price * qty * bps) / 10000));
  return applyDrain(ex, owner, fee, "fee", flag);
}

// Apply a production run on `owner`'s account at time `now`: regen labor to `now`,
// validate labor + inputs, then burn inputs + labor and mint outputs. Used live
// (Market.produce) AND on replay (with the recorded ts), so the rule lives in one
// place. Throws on unknown recipe / shortfalls.
function applyProduce(ex, owner, recipeId, island, now) {
  const r = RECIPE_BY_ID[recipeId];
  if (!r) throw new Error(`unknown recipe: ${recipeId}`);
  if (!ex.accounts.has(owner)) throw new Error(`no account: ${owner}`);
  if (!ex.labor) ex.labor = new Map();
  const have = laborAt(ex, owner, now);
  if (have < r.labor) throw new Error(`not enough labor (need ${r.labor}, have ${have})`);
  // inputs/outputs are LOCATED: a stall consumes from and deposits into the
  // owner's warehouse at this island. mint/burn keep mintedUnits in lockstep.
  const wid = ex.whId(owner, island);
  const w = ex._inv(wid);
  for (const [c, q] of Object.entries(r.inputs)) {
    if ((w.inv[c] || 0) < q) throw new Error(`not enough ${c} (need ${q})`);
  }
  for (const [c, q] of Object.entries(r.inputs)) ex.burn(wid, c, q);
  for (const [c, q] of Object.entries(r.outputs)) ex.mint(wid, c, q);
  ex.labor.set(owner, { amount: have - r.labor, ts: now });
  return r;
}

// --- ships + cargo: goods are physical. A hold rides on a ship docked at a port;
// load/unload move goods between the hold and the warehouse at that port; move
// relocates the ship (instant stub — real sailing is a later slice). All three are
// pure unit transfers (no PoE, no ledger), used live AND on replay. ---
export const SHIP_CARGO = { sloop: 60, brig: 140, frigate: 220, galleon: 400 }; // mirrors @salt/shared SHIP_CLASSES.cargo
export const SHIP_HULL = { sloop: 16, brig: 28, frigate: 44, galleon: 70 };      // mirrors @salt/shared SHIP_CLASSES.hull
export const REPAIR_PER_HULL = 4; // PoE per hull point to repair at a port (a SINK)
export const SHIP_PRICE = { sloop: 300, brig: 900, frigate: 1800, galleon: 3600 }; // shipyard purchase price (a SINK)
export const SHIP_SAIL = { sloop: 10, brig: 14, frigate: 18, galleon: 16 }; // mirrors @salt/shared SHIP_CLASSES.sail
export const TRAVEL_MS_PER_DIST = 600; // voyage ms per lane-distance unit, before the ship's sail divides it
export const SALVAGE_BPS = 4000; // fraction of a sunk ship's cargo that washes up as a recoverable wreck (rest lost)

// Deterministic transit encounter for a voyage. Pure (no RNG state) — the roll is a
// hash of (shipId, departAt), so it reproduces on replay and in tests, while the OUTCOME
// is also recorded on the `arrive` intent for robustness. A hit does 20%..60% of max
// hull in damage; a ship already low enough is sunk. `danger` is the route's risk (0..1).
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function voyageEncounter(shipId, departAt, danger, hull, maxHull) {
  const h = hash32(`${shipId}:${departAt}`);
  if ((h % 10000) / 10000 >= (danger || 0)) return { hit: false, sunk: false, hull, dmg: 0 };
  const sev = ((h >>> 13) % 1000) / 1000; // 0..1
  const dmg = Math.max(1, Math.ceil(maxHull * (0.2 + 0.4 * sev)));
  const nh = hull - dmg;
  return { hit: true, sunk: nh <= 0, hull: Math.max(0, nh), dmg };
}
function holdId(shipId) { return `hold:${shipId}`; }
function shipCargoCap(cls) { return SHIP_CARGO[cls] ?? 0; }
function holdFill(ex, shipId) {
  const h = ex.accounts.get(holdId(shipId));
  if (!h) return 0;
  let t = 0; for (const c in h.inv) t += h.inv[c];
  return t;
}
function getShip(ex, shipId, owner) {
  const s = ex.ships && ex.ships.get(shipId);
  if (!s) throw new Error(`no such ship: ${shipId}`);
  if (s.owner !== owner) throw new Error("not your ship");
  return s;
}
function applyCreateShip(ex, shipId, owner, cls, dockedAt) {
  if (!ex.ships) ex.ships = new Map();
  const maxHull = SHIP_HULL[cls] ?? 0;
  ex.ships.set(shipId, { owner, cls, dockedAt, hull: maxHull, maxHull, voyage: null });
  const n = Number(String(shipId).replace(/^s/, "")); // keep the live counter ahead on replay
  if (Number.isFinite(n)) ex._sid = Math.max(ex._sid || 0, n);
}
// One-time onboarding: mark the player onboarded, grant starter goods into the home
// warehouse, and create the free starter sloop. Recorded as a single 'onboard' intent
// so a restart rebuilds all three — and so losing your ship later does NOT re-trigger
// it (the free starter is once per captain; replacements come from the shipyard).
function applyOnboard(ex, owner, island, inv, cls, shipId) {
  if (!ex.onboarded) ex.onboarded = new Set();
  ex.onboarded.add(owner);
  for (const [c, q] of Object.entries(inv)) ex.mint(ex.whId(owner, island), c, q);
  applyCreateShip(ex, shipId, owner, cls, island);
}
function applyLoad(ex, owner, shipId, commodity, qty, island) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("qty must be a positive integer");
  const s = getShip(ex, shipId, owner);
  if (s.dockedAt !== island) throw new Error("your ship is not docked here");
  const w = ex.accounts.get(ex.whId(owner, island));
  if (!w || (w.inv[commodity] || 0) < qty) throw new Error(`not enough ${commodity} in your warehouse here`);
  const cap = shipCargoCap(s.cls);
  if (holdFill(ex, shipId) + qty > cap) throw new Error(`exceeds ${s.cls} cargo capacity (${cap})`);
  w.inv[commodity] -= qty;
  const h = ex._inv(holdId(shipId));
  h.inv[commodity] = (h.inv[commodity] || 0) + qty;
}
function applyUnload(ex, owner, shipId, commodity, qty, island) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("qty must be a positive integer");
  const s = getShip(ex, shipId, owner);
  if (s.dockedAt !== island) throw new Error("your ship is not docked here");
  const h = ex.accounts.get(holdId(shipId));
  if (!h || (h.inv[commodity] || 0) < qty) throw new Error(`not enough ${commodity} in the hold`);
  h.inv[commodity] -= qty;
  const w = ex._inv(ex.whId(owner, island));
  w.inv[commodity] = (w.inv[commodity] || 0) + qty;
}
// Begin a voyage: the ship leaves port (dockedAt -> null) and is at sea until arriveAt.
// Used live AND on replay (the timing + route ride on the `sail` intent).
function applySail(ex, owner, shipId, toIsland, from, departAt, arriveAt, danger) {
  const s = getShip(ex, shipId, owner);
  s.dockedAt = null;
  s.voyage = { from, to: toIsland, departAt, arriveAt, danger };
}
// Complete a voyage: sink it (loss-on-sinking) or dock it at the destination with its
// post-encounter hull. Used live AND on replay (outcome recorded on the `arrive` intent).
function applyArrive(ex, shipId, to, hull, sunk) {
  if (sunk) { applyScuttle(ex, shipId); return; }
  const s = ex.ships && ex.ships.get(shipId);
  if (!s) return;
  s.dockedAt = to;
  s.voyage = null;
  s.hull = Math.max(0, Math.min(s.maxHull, hull));
}
// Set a ship's hull (clamped). Used to persist a battle's damage outcome on replay.
function applySetHull(ex, shipId, hull) {
  const s = ex.ships && ex.ships.get(shipId);
  if (!s) return;
  s.hull = Math.max(0, Math.min(s.maxHull, hull));
}
// Restore `owner`'s ship toward full hull, paying REPAIR_PER_HULL/point as a SINK
// (split crown/flag). Pays for as much as the captain can afford. Used live + replay.
function applyRepair(ex, owner, shipId, flag) {
  const s = ex.ships && ex.ships.get(shipId);
  if (!s) throw new Error(`no such ship: ${shipId}`);
  const missing = s.maxHull - s.hull;
  if (missing <= 0) return 0;
  const charged = applyDrain(ex, owner, missing * REPAIR_PER_HULL, "repair", flag);
  s.hull = Math.min(s.maxHull, s.hull + Math.floor(charged / REPAIR_PER_HULL));
  return charged;
}
// Loss-on-sinking: most of a sunk ship's cargo is lost to the deep (burned, so
// mintedUnits stays reconciled), but SALVAGE_BPS of it washes up as a WRECK at the
// nearest port (the voyage destination, or where it was docked) — a recoverable faucet
// any captain can salvage. Drops the hold account and removes the ship.
function applyScuttle(ex, shipId) {
  const s = ex.ships && ex.ships.get(shipId);
  if (!s) return;
  const loc = s.voyage ? s.voyage.to : s.dockedAt; // where the wreck settles
  const h = ex.accounts.get(holdId(shipId));
  if (h) {
    for (const c of Object.keys(h.inv)) {
      const q = h.inv[c];
      if (q <= 0) continue;
      const salvaged = loc ? Math.floor((q * SALVAGE_BPS) / 10000) : 0;
      const burned = q - salvaged;
      if (burned > 0) ex.burn(holdId(shipId), c, burned);
      if (salvaged > 0) { h.inv[c] -= salvaged; const w = ex._inv(`wreck:${loc}`); w.inv[c] = (w.inv[c] || 0) + salvaged; }
    }
    ex.accounts.delete(holdId(shipId)); // no orphan hold left behind (location integrity)
  }
  ex.ships.delete(shipId);
}

// Recover `qty` of `commodity` from the wreck at `island` into the owner's warehouse
// there (a located transfer — no mint). Used live AND on replay.
function applySalvage(ex, owner, island, commodity, qty) {
  const w = ex.accounts.get(`wreck:${island}`);
  if (!w || (w.inv[commodity] || 0) < qty || qty <= 0) return;
  w.inv[commodity] -= qty;
  const wh = ex._inv(ex.whId(owner, island));
  wh.inv[commodity] = (wh.inv[commodity] || 0) + qty;
}

// Seed prices are skewed by what the island produces vs. demands, so the same
// good is cheap where it's abundant and dear where it's wanted — the gap is what
// makes inter-island trade worth sailing. Pricing stays server-authoritative.
export const PRODUCE_FACTOR = 0.8; // produced here -> abundant -> cheaper
export const DEMAND_FACTOR = 1.3;  // demanded here -> premium -> dearer
const DEPTH_BONUS = 5;             // extra NPC depth on the abundant/wanted side

function defaultInventory(commodities, units = NEW_PLAYER_UNITS) {
  const inv = {};
  for (const c of commodities) inv[c] = units;
  return inv;
}

function emptyBatch() { return { intents: [], trades: [], ledger: [] }; }

export class Market {
  constructor(island, opts = {}) {
    this.island = island;
    this.commodities = opts.commodities ?? MARKET_COMMODITIES;
    this.basePrice = opts.basePrice ?? BASE_PRICE;
    this.newPlayerPoe = opts.newPlayerPoe ?? NEW_PLAYER_POE;
    this.newPlayerInv = opts.newPlayerInv ?? defaultInventory(this.commodities);
    this.produces = new Set(opts.produces ?? []); // commodities abundant here
    this.demands = new Set(opts.demands ?? []);   // commodities wanted here
    this._flag0 = opts.flag ?? null;              // island's INITIAL flag (conquest can override it)
    this.taxRate = opts.taxRate ?? 0;             // commerce tax skimmed from sellers (0 = none)
    this.listingFeeBps = opts.listingFeeBps ?? 0; // fee on placing an order (0 = none; the server sets it)
    this.demandLevyBps = opts.demandLevyBps ?? 0; // sink skimmed from demand sales (0 = none; the server sets it)

    // A shared Exchange (from the hub) gives every island ONE global wallet/ledger
    // per player. Standalone (tests) gets its own and auto-seeds in the ctor.
    this.ex = opts.exchange ?? new Exchange();
    this.ex.located = true;                          // goods are physical (warehouse + ship hold)
    if (!this.ex.labor) this.ex.labor = new Map();   // per-player { amount, ts } (shared via the engine)
    if (!this.ex.stalls) this.ex.stalls = new Map(); // stallKey -> { owner, island, recipe, stall }
    if (!this.ex.flagMembers) this.ex.flagMembers = new Map(); // flag -> Set(playerId)
    if (!this.ex.islandFlag) this.ex.islandFlag = new Map();   // island -> flag override (conquest)
    if (!this.ex.ships) this.ex.ships = new Map();   // shipId -> { owner, cls, dockedAt }
    if (this.ex._sid === undefined) this.ex._sid = 0; // ship-id counter
    if (!this.ex.sites) this.ex.sites = new Map();   // siteKey -> { owner, island, commodity }
    if (!this.ex.onboarded) this.ex.onboarded = new Set(); // players who got their one-time starter
    if (!this.ex.crews) this.ex.crews = new Map();   // crewId -> { name, captain, members:Set }
    if (this.ex._cid === undefined) this.ex._cid = 0; // crew-id counter
    if (!this.ex.blockades) this.ex.blockades = new Map(); // island -> { attacker, defender, meter }
    if (!this.ex.names) this.ex.names = new Map();   // playerId -> captain name
    if (!this.ex.nameOwners) this.ex.nameOwners = new Map(); // name -> playerId (uniqueness)
    this.recipes = RECIPES;
    this.store = opts.store ?? null;
    this._now = opts.now ?? (() => Date.now()); // wall clock for labor regen (injectable for tests)
    this._nextSeq = opts.nextSeq ?? (() => 0); // global op sequence (for replay order)
    this._pending = emptyBatch();

    if (!opts.exchange) this.seedLiquidity(opts.seedLevels ?? 3, opts.seedQty ?? 10);
  }

  // Current controlling flag: a conquest override if any, else the initial flag.
  get flag() {
    const o = this.ex.islandFlag.get(this.island);
    return o === undefined ? this._flag0 : o;
  }

  // The island-adjusted reference price for a commodity (integer, >= 2).
  seedPrice(commodity) {
    const factor = this.produces.has(commodity) ? PRODUCE_FACTOR
      : this.demands.has(commodity) ? DEMAND_FACTOR : 1;
    return Math.max(2, Math.round((this.basePrice[commodity] ?? 10) * factor));
  }

  // Seed a little resting NPC liquidity around each commodity's island price so a
  // fresh market already has a book to hit. The NPC (created once, shared across
  // islands) is given deep funds/goods and extra depth on the abundant/wanted side.
  seedLiquidity(levels = 3, qty = 10) {
    if (!this.ex.accounts.has("npc")) this._createPurse("npc", 1_000_000_000);
    // located deep stock so the NPC's sell orders escrow from THIS island's warehouse
    const deep = {};
    for (const c of this.commodities) deep[c] = 1_000_000;
    this._grant("npc", this.island, deep);
    for (const c of this.commodities) {
      const base = this.seedPrice(c);
      const askQty = qty + (this.produces.has(c) ? DEPTH_BONUS : 0);
      const bidQty = qty + (this.demands.has(c) ? DEPTH_BONUS : 0);
      for (let i = 1; i <= levels; i++) {
        const bid = Math.max(1, base - i); // NPC buys below base
        const ask = base + i;              // NPC sells above base
        this._place("npc", c, "buy", bid, bidQty);
        this._place("npc", c, "sell", ask, askQty);
      }
    }
    // stand up the finished-goods demand reserve + its initial burn-bids for this island
    if (!this.ex.accounts.has(DEMAND)) this._createPurse(DEMAND, DEMAND_RESERVE);
    this.restockDemand();
  }

  // Finished goods this island demands (the loop's exit for rum/sailcloth/shot).
  _demandGoods() {
    return this.commodities.filter((c) => FINISHED.has(c) && this.demands.has(c));
  }
  // Total units the demand reserve currently rests as buy orders for `commodity` here.
  _demandResting(commodity) {
    let q = 0;
    for (const o of this.ex.openOrders.values()) {
      if (o.owner === DEMAND && o.island === this.island && o.commodity === commodity && o.side === "buy") q += o.qty;
    }
    return q;
  }
  // Top each demanded finished good's resting demand back up to DEMAND_CAP at the
  // island's (premium) demand price. The shortfall is placed as an ordinary buy, so
  // it persists + replays like any other order. Returns the commodities it touched
  // (so the room resyncs just those books); a no-op returns []. The reserve must
  // exist first (seedLiquidity creates it).
  restockDemand() {
    if (!this.ex.accounts.has(DEMAND)) return [];
    const touched = [];
    for (const c of this._demandGoods()) {
      const shortfall = DEMAND_CAP - this._demandResting(c);
      if (shortfall > 0) { this._place(DEMAND, c, "buy", this.seedPrice(c), shortfall); touched.push(c); }
    }
    return touched;
  }

  // --- player lifecycle (keyed by session id; account is global across islands) ---
  hasPlayer(playerId) {
    return this.ex.accounts.has(playerId);
  }
  join(playerId) {
    if (!this.ex.accounts.has(playerId)) this._createPurse(playerId, this.newPlayerPoe);
    // ONE-TIME onboarding at a real port: starter goods + a free starter sloop, exactly
    // once per captain (tracked in ex.onboarded — independent of current ship count, so
    // a captain who loses their ship is NOT handed a free one; they buy a replacement at
    // the shipyard). Skipped on the island-less system view.
    if (this.island !== "__system__" && !this.ex.onboarded.has(playerId)) {
      const shipId = `s${++this.ex._sid}`;
      applyOnboard(this.ex, playerId, this.island, { ...this.newPlayerInv }, "sloop", shipId);
      if (this.store) this._record({ kind: "onboard", owner: playerId, island: this.island, inv: { ...this.newPlayerInv }, cls: "sloop", ship: shipId });
    }
  }

  // Buy a ship at this port's shipyard: pay the class price (a SINK, split crown/flag)
  // and dock a fresh hull here. The way back from a sinking. Recorded as 'buyship'.
  buyShip(playerId, cls) {
    const price = SHIP_PRICE[cls];
    if (!price) throw new Error(`unknown ship class: ${cls}`);
    const a = this.ex.acct(playerId);
    if (a.poe < price) throw new Error(`insufficient PoE to buy a ${cls} (need ${price})`);
    const shipId = `s${++this.ex._sid}`;
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applyDrain(this.ex, playerId, price, "shipyard", this.flag);
    applyCreateShip(this.ex, shipId, playerId, cls, this.island);
    if (this.store) { this._record({ kind: "buyship", owner: playerId, cls, ship: shipId, price, flag: this.flag, island: this.island }); this._captureAudit(lLen, tLen); }
    return shipId;
  }
  // No account teardown on leave: resting orders + escrow stay consistent and
  // no pieces of eight ever leave the system.

  // --- cargo: move goods between a docked ship's hold and the warehouse here, and
  // sail a ship to another port (instant stub). Recorded so a restart replays them. ---
  loadCargo(playerId, shipId, commodity, qty) {
    if (!this.commodities.includes(commodity)) throw new Error(`unknown commodity: ${commodity}`);
    applyLoad(this.ex, playerId, shipId, commodity, qty, this.island);
    if (this.store) this._record({ kind: "load", owner: playerId, ship: shipId, commodity, qty, island: this.island });
  }
  unloadCargo(playerId, shipId, commodity, qty) {
    if (!this.commodities.includes(commodity)) throw new Error(`unknown commodity: ${commodity}`);
    applyUnload(this.ex, playerId, shipId, commodity, qty, this.island);
    if (this.store) this._record({ kind: "unload", owner: playerId, ship: shipId, commodity, qty, island: this.island });
  }
  // Set sail for `toIsland` along a lane of length `dist` through risk `danger`. The
  // ship goes to sea (can't load/unload/trade) for a duration set by the lane distance
  // and the ship's sail speed, then arrives via tickVoyages. Recorded as a `sail` intent.
  moveShip(playerId, shipId, toIsland, dist = 1, danger = 0) {
    const s = this.ex.ships.get(shipId);
    if (!s) throw new Error(`no such ship: ${shipId}`);
    if (s.owner !== playerId) throw new Error("not your ship");
    if (s.voyage) throw new Error("ship is already at sea");
    if (s.dockedAt !== this.island) throw new Error("your ship is not docked here");
    if (!toIsland || toIsland === this.island) throw new Error("choose a destination");
    const departAt = this._now();
    const duration = Math.max(1000, Math.round((dist || 1) * TRAVEL_MS_PER_DIST / (SHIP_SAIL[s.cls] || 10)));
    const arriveAt = departAt + duration;
    applySail(this.ex, playerId, shipId, toIsland, this.island, departAt, arriveAt, danger);
    if (this.store) this._record({ kind: "sail", owner: playerId, ship: shipId, to: toIsland, from: this.island, departAt, arriveAt, danger });
    return { arriveAt };
  }

  // Land every ship whose voyage is due by `now`: roll its transit encounter (damage or
  // a sinking) and dock it (or scuttle it). Recorded as `arrive` intents (the outcome is
  // stored, so a restart applies it verbatim). Returns the arrivals (for the room/sim).
  tickVoyages(now = this._now()) {
    const due = [];
    for (const [id, s] of this.ex.ships) if (s.voyage && now >= s.voyage.arriveAt) due.push(id);
    const arrived = [];
    for (const id of due) {
      const s = this.ex.ships.get(id);
      const r = voyageEncounter(id, s.voyage.departAt, s.voyage.danger, s.hull, s.maxHull);
      const to = s.voyage.to;
      applyArrive(this.ex, id, to, r.hull, r.sunk);
      if (this.store) this._record({ kind: "arrive", ship: id, to, hull: r.hull, sunk: r.sunk });
      arrived.push({ ship: id, to, sunk: r.sunk, hit: r.hit });
    }
    return arrived;
  }

  // --- sinks: upkeep (recurring rent), repair, and battle outcomes (hull/sink) ---
  // Charge whole elapsed cycles of rent for everything kept on THIS island (stalls
  // here + ships docked here), for every owner with assets here. Lazy + ts-based
  // (no global clock), so whichever room ticks doesn't matter and idle owners still
  // pay. Records the charged amount so a restart replays the drain exactly. Returns
  // the owners charged (so the room can refresh them).
  tickUpkeep(now = this._now()) {
    if (!this.ex.upkeepTs) this.ex.upkeepTs = new Map();
    const counts = new Map(); // owner -> { stalls, ships, sites }
    const bump = (owner, k) => {
      if (isSystemOwner(owner)) return;
      const e = counts.get(owner) ?? { stalls: 0, ships: 0, sites: 0 }; e[k]++; counts.set(owner, e);
    };
    for (const s of this.ex.stalls.values()) if (s.island === this.island) bump(s.owner, "stalls");
    for (const s of this.ex.ships.values()) if (s.dockedAt === this.island) bump(s.owner, "ships");
    for (const s of this.ex.sites.values()) if (s.island === this.island) bump(s.owner, "sites");

    const charged = [];
    for (const [owner, c] of counts) {
      const key = `${owner}:${this.island}`;
      const last = this.ex.upkeepTs.get(key);
      if (last === undefined) { this.ex.upkeepTs.set(key, now); continue; } // first sight: start the clock
      const cycles = Math.floor((now - last) / UPKEEP_PERIOD_MS);
      if (cycles <= 0) continue;
      const ts = last + cycles * UPKEEP_PERIOD_MS;
      const due = cycles * (UPKEEP_STALL * c.stalls + UPKEEP_SHIP * c.ships + UPKEEP_SITE * c.sites);
      const lLen = this.ex.ledger.entries.length;
      const paid = applyDrain(this.ex, owner, due, "upkeep", this.flag);
      this.ex.upkeepTs.set(key, ts);
      if (this.store) { this._record({ kind: "upkeep", owner, island: this.island, amount: paid, flag: this.flag, ts }); this._captureAudit(lLen, this.ex.trades.length); }
      charged.push(owner);
    }
    return charged;
  }

  // Repair a docked ship toward full hull (a SINK, split crown/flag). Throws if the
  // ship isn't the caller's, isn't docked here, or is already whole.
  repairShip(playerId, shipId) {
    const s = this.ex.ships.get(shipId);
    if (!s) throw new Error(`no such ship: ${shipId}`);
    if (s.owner !== playerId) throw new Error("not your ship");
    if (s.dockedAt !== this.island) throw new Error("your ship is not docked here");
    if (s.hull >= s.maxHull) throw new Error("hull is already full");
    const lLen = this.ex.ledger.entries.length;
    const paid = applyRepair(this.ex, playerId, shipId, this.flag);
    if (this.store) { this._record({ kind: "repair", owner: playerId, ship: shipId, flag: this.flag }); this._captureAudit(lLen, this.ex.trades.length); }
    return paid;
  }

  // Persist a battle's hull outcome for a ship: <=0 sinks it (loss-on-sinking — hold
  // burned, ship removed), otherwise records the remaining hull. Called by the hub
  // from PillageRoom; island-agnostic (works on the __system__ view).
  resolveShip(shipId, finalHull) {
    if (finalHull <= 0) { applyScuttle(this.ex, shipId); if (this.store) this._record({ kind: "scuttle", ship: shipId }); }
    else { applySetHull(this.ex, shipId, finalHull); if (this.store) this._record({ kind: "hull", ship: shipId, hull: finalHull }); }
  }
  shipHull(shipId) { const s = this.ex.ships.get(shipId); return s ? s.hull : 0; }

  // --- intents (validated; throw on bad input, caller turns it into an error msg) ---
  placeLimit(playerId, commodity, side, price, qty) {
    if (!this.commodities.includes(commodity)) throw new Error(`unknown commodity: ${commodity}`);
    // economy.mjs enforces integer/positive price+qty and sufficient funds/goods.
    return this._place(playerId, commodity, side, price, qty);
  }

  // Build a stall here (charges the build fee to the crown). Recorded as a 'build'
  // intent so a restart replays the ownership + fee.
  build(playerId, recipeId) {
    const to = this.flag ?? UNCLAIMED_TREASURY;
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    const stall = applyBuild(this.ex, playerId, this.island, recipeId, to);
    if (this.store) { this._record({ kind: "build", owner: playerId, island: this.island, recipe: recipeId, to }); this._captureAudit(lLen, tLen); }
    return stall;
  }

  // PoE held by this island's controlling flag (build levies it has collected,
  // possibly from several islands it controls). 0 if the island is unflagged.
  flagTreasury() {
    if (!this.flag) return 0;
    const a = this.ex.accounts.get(this.flag);
    return a ? a.poe : 0;
  }
  isPledged(playerId, flag = this.flag) {
    return !!flag && !!this.ex.flagMembers.get(flag)?.has(playerId);
  }
  flagMemberCount() {
    return this.flag ? (this.ex.flagMembers.get(this.flag)?.size ?? 0) : 0;
  }
  // Every flag this player is pledged to (for the conquest UI).
  flagsOf(playerId) {
    const mine = [];
    for (const [f, set] of this.ex.flagMembers) if (set.has(playerId)) mine.push(f);
    return mine;
  }

  // Pledge to a flag (defaults to this island's flag). Generalised so a captain
  // can join any faction — required to seize an island for it. 'pledge' intent.
  pledge(playerId, flag = this.flag) {
    if (!flag) throw new Error("this island has no flag to pledge to");
    this.ex.acct(playerId); // must be a real account
    applyPledge(this.ex, playerId, flag);
    if (this.store) this._record({ kind: "pledge", owner: playerId, flag });
  }

  // Seize THIS island for `flag` (which the caller must be pledged to), paying the
  // conquest cost into the warchest. Future levies + tax then route to `flag`.
  seize(playerId, flag) {
    if (!flag) throw new Error("choose a flag to seize for");
    if (!this.isPledged(playerId, flag)) throw new Error(`pledge to ${flag} first`);
    if (this.flag === flag) throw new Error(`${flag} already controls this island`);
    const a = this.ex.acct(playerId);
    if (a.poe < CONQUEST_COST) throw new Error(`insufficient PoE to seize (need ${CONQUEST_COST})`);
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applySeize(this.ex, playerId, this.island, flag, CONQUEST_COST);
    if (this.store) { this._record({ kind: "seize", owner: playerId, island: this.island, flag, cost: CONQUEST_COST }); this._captureAudit(lLen, tLen); }
    return flag;
  }

  // Distribute this flag's treasury to its members (caller must be a member).
  // Recorded as a 'payout' intent; the split is deterministic so no amount is stored.
  payout(playerId) {
    if (!this.flag) throw new Error("this island has no flag");
    if (!this.isPledged(playerId)) throw new Error(`pledge to ${this.flag} first`);
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    const per = applyPayout(this.ex, this.flag);
    if (this.store) { this._record({ kind: "payout", flag: this.flag }); this._captureAudit(lLen, tLen); }
    return per;
  }

  // PvE plunder: pay a winner from the capped prize pool (a controlled faucet) + crown
  // cut. Recorded as a 'plunder' intent (timestamp drives the deterministic pool refill).
  pvePlunder(playerId) {
    const ts = this._now();
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    const paid = applyPvePlunder(this.ex, playerId, ts);
    if (this.store) { this._record({ kind: "plunder", owner: playerId, ts }); this._captureAudit(lLen, tLen); }
    return paid;
  }
  // PvP plunder: the victor loots the defeated player's cargo + a share of coin (transfer)
  // minus the crown cut (sink). Recorded as a 'pvp_plunder' intent.
  pvpPlunder(winnerId, loserId, loserShipId, island = this.island) {
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applyPvpPlunder(this.ex, winnerId, island, loserId, loserShipId, PVP_COIN_BPS);
    if (this.store) { this._record({ kind: "pvp_plunder", winner: winnerId, loser: loserId, ship: loserShipId, island }); this._captureAudit(lLen, tLen); }
  }

  // Run a production recipe at YOUR stall on this island: burn inputs + labor, mint
  // outputs. Gated on stall ownership (a permission check; the transform itself is
  // replayed without re-checking). Recorded as a 'produce' intent.
  produce(playerId, recipeId) {
    if (!this.ex.stalls.has(stallKey(playerId, this.island, recipeId))) {
      const r = RECIPE_BY_ID[recipeId];
      throw new Error(r ? `build a ${r.stall} here first` : `unknown recipe: ${recipeId}`);
    }
    const ts = this._now();
    const r = applyProduce(this.ex, playerId, recipeId, this.island, ts);
    if (this.store) this._record({ kind: "produce", owner: playerId, island: this.island, recipe: recipeId, ts });
    return r;
  }

  // Build an extraction site here for a raw the island produces (charges the levy to
  // the controlling flag). Recorded as a 'site' intent so a restart replays ownership.
  buildSite(playerId, commodity) {
    if (!RAWS.has(commodity)) throw new Error(`${commodity} is not a raw resource`);
    if (!this.produces.has(commodity)) throw new Error(`${commodity} can't be sourced on this island`);
    const to = this.flag ?? UNCLAIMED_TREASURY;
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    const site = applyBuildSite(this.ex, playerId, this.island, commodity, to);
    if (this.store) { this._record({ kind: "site", owner: playerId, island: this.island, commodity, to }); this._captureAudit(lLen, tLen); }
    return site;
  }

  // Extract a raw at YOUR site here: spend labor + the per-pull fee (a sink), mint the
  // raw into your warehouse. Gated on owning the site. Recorded as an 'extract' intent.
  extract(playerId, commodity) {
    if (!this.ex.sites.has(siteKey(playerId, this.island, commodity))) {
      throw new Error(`build a ${commodity} site here first`);
    }
    const ts = this._now();
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applyExtract(this.ex, playerId, this.island, commodity, EXTRACT_FEE, this.flag, ts);
    if (this.store) { this._record({ kind: "extract", owner: playerId, island: this.island, commodity, fee: EXTRACT_FEE, flag: this.flag, ts }); this._captureAudit(lLen, tLen); }
  }

  // Spawn an NPC enemy ship (a "raider") docked here with a cargo hold, for a battle.
  // Its cargo is minted (a faucet), so defeating it yields salvage (a wreck) when it's
  // scuttled. Recorded as a `raider` intent. Owned by the system RAIDER account (pays
  // no fees/upkeep). Returns the new ship id.
  spawnRaider(cls, dockedAt, cargo = {}) {
    const shipId = `s${++this.ex._sid}`;
    applyCreateShip(this.ex, shipId, RAIDER, cls, dockedAt);
    for (const [c, q] of Object.entries(cargo)) this.ex.mint(`hold:${shipId}`, c, q);
    if (this.store) this._record({ kind: "raider", ship: shipId, cls, dockedAt, cargo });
    return shipId;
  }

  // --- blockades: declare a contested takeover, then push/defend the control meter ---
  blockadeHere() {
    const b = this.ex.blockades.get(this.island);
    return b ? { attacker: b.attacker, defender: b.defender, meter: b.meter } : null;
  }
  declareBlockade(playerId, flag) {
    if (!flag) throw new Error("choose a flag to blockade for");
    if (!this.isPledged(playerId, flag)) throw new Error(`pledge to ${flag} first`);
    if (this.flag === flag) throw new Error(`${flag} already controls this island`);
    if (this.ex.blockades.has(this.island)) throw new Error("this island is already under blockade");
    if (this.ex.acct(playerId).poe < BLOCKADE_COST) throw new Error(`insufficient PoE to declare (need ${BLOCKADE_COST})`);
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applyDeclareBlockade(this.ex, playerId, this.island, flag, this.flag, BLOCKADE_COST);
    if (this.store) { this._record({ kind: "blockade_declare", owner: playerId, island: this.island, attacker: flag, defender: this.flag, cost: BLOCKADE_COST }); this._captureAudit(lLen, tLen); }
  }
  // Push the blockade for the attacking flag (raise the meter toward a takeover).
  pushBlockade(playerId) {
    const b = this.ex.blockades.get(this.island);
    if (!b) throw new Error("no blockade here");
    if (!this.isPledged(playerId, b.attacker)) throw new Error(`pledge to ${b.attacker} first`);
    const ts = this._now();
    applyBlockadePush(this.ex, playerId, this.island, "attack", ts);
    if (this.store) this._record({ kind: "blockade_push", owner: playerId, island: this.island, side: "attack", ts });
  }
  // Defend the blockade for the island's controlling flag (push the meter back down).
  defendBlockade(playerId) {
    const b = this.ex.blockades.get(this.island);
    if (!b) throw new Error("no blockade here");
    if (!b.defender) throw new Error("an unclaimed island has no defenders");
    if (!this.isPledged(playerId, b.defender)) throw new Error(`pledge to ${b.defender} first`);
    const ts = this._now();
    applyBlockadePush(this.ex, playerId, this.island, "defend", ts);
    if (this.store) this._record({ kind: "blockade_push", owner: playerId, island: this.island, side: "defend", ts });
  }

  // Winning a battle in contested waters advances your faction's blockade (no labor — the
  // battle WAS the effort). Pushes for whichever side `playerId` is pledged to; a no-op if
  // there's no blockade or the captain is in neither flag. Called by the hub on a win.
  battlePush(playerId, island = this.island) {
    const b = this.ex.blockades.get(island);
    if (!b) return null;
    const side = this.isPledged(playerId, b.attacker) ? "attack"
      : (b.defender && this.isPledged(playerId, b.defender)) ? "defend" : null;
    if (!side) return null;
    applyBlockadeMeter(this.ex, island, side, BLOCKADE_BATTLE_STEP);
    if (this.store) this._record({ kind: "blockade_battle", island, side });
    return side;
  }

  // --- captain name: claim/rename a unique human display name for your wallet ---
  nameOf(playerId) { return (this.ex.names && this.ex.names.get(playerId)) || ""; }
  setName(playerId, name) {
    this.ex.acct(playerId); // must be a real account
    const nm = String(name ?? "").trim().slice(0, NAME_MAX);
    if (!nm) throw new Error("a name can't be empty");
    applySetName(this.ex, playerId, nm);
    if (this.store) this._record({ kind: "name", owner: playerId, name: nm });
    return nm;
  }

  // --- crews: form/join + the shared coffer (contribute / captain withdraws) ---
  formCrew(playerId, name) {
    this.ex.acct(playerId); // must be a real account
    const nm = String(name ?? "").trim().slice(0, 40) || "Crew";
    const crewId = `c${++this.ex._cid}`;
    applyFormCrew(this.ex, crewId, playerId, nm);
    if (this.store) this._record({ kind: "crew_form", crew: crewId, captain: playerId, name: nm });
    return crewId;
  }
  joinCrew(playerId, crewId) {
    this.ex.acct(playerId);
    if (!this.ex.crews.has(crewId)) throw new Error("no such crew");
    applyJoinCrew(this.ex, crewId, playerId);
    if (this.store) this._record({ kind: "crew_join", crew: crewId, owner: playerId });
  }
  crewDeposit(playerId, crewId, amount) {
    amount = Math.floor(amount);
    const c = this.ex.crews.get(crewId);
    if (!c) throw new Error("no such crew");
    if (!c.members.has(playerId)) throw new Error("join the crew first");
    if (amount <= 0) throw new Error("amount must be a positive integer");
    if (this.ex.acct(playerId).poe < amount) throw new Error("insufficient PoE");
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applyCrewDeposit(this.ex, crewId, playerId, amount);
    if (this.store) { this._record({ kind: "crew_deposit", crew: crewId, owner: playerId, amount }); this._captureAudit(lLen, tLen); }
  }
  crewWithdraw(playerId, crewId, amount) {
    amount = Math.floor(amount);
    const c = this.ex.crews.get(crewId);
    if (!c) throw new Error("no such crew");
    if (c.captain !== playerId) throw new Error("only the crew captain can withdraw");
    if (amount <= 0) throw new Error("amount must be a positive integer");
    if (this.ex.acct(crewCoffer(crewId)).poe < amount) throw new Error("the coffer is short");
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    applyCrewWithdraw(this.ex, crewId, playerId, amount);
    if (this.store) { this._record({ kind: "crew_withdraw", crew: crewId, owner: playerId, amount }); this._captureAudit(lLen, tLen); }
  }
  crewCofferOf(crewId) {
    const a = this.ex.accounts.get(crewCoffer(crewId));
    return a ? a.poe : 0;
  }
  // The crews this player belongs to (for the UI).
  crewsOf(playerId) {
    const out = [];
    for (const [id, c] of this.ex.crews) {
      if (c.members.has(playerId)) out.push({ id, name: c.name, coffer: this.crewCofferOf(id), members: c.members.size, captain: c.captain === playerId });
    }
    return out;
  }

  // Goods washed up here from sunk ships, available to salvage (commodity -> qty).
  wreckHere() {
    const w = this.ex.accounts.get(`wreck:${this.island}`);
    const out = {};
    if (w) for (const c of this.commodities) if (w.inv[c]) out[c] = w.inv[c];
    return out;
  }
  // Salvage up to `qty` of `commodity` from this island's wreck into your warehouse.
  salvage(playerId, commodity, qty) {
    if (!this.commodities.includes(commodity)) throw new Error(`unknown commodity: ${commodity}`);
    const w = this.ex.accounts.get(`wreck:${this.island}`);
    const take = Math.min(Math.max(0, Math.floor(qty)), (w && w.inv[commodity]) || 0);
    if (take <= 0) throw new Error(`no ${commodity} to salvage here`);
    applySalvage(this.ex, playerId, this.island, commodity, take);
    if (this.store) this._record({ kind: "salvage", owner: playerId, island: this.island, commodity, qty: take });
    return take;
  }

  // Returns the cancelled order's commodity (so the room can resync that book),
  // or null if there was nothing to cancel. Throws if the order isn't the caller's.
  cancel(playerId, orderId) {
    const o = this.ex.openOrders.get(orderId);
    if (!o) return null;
    if (o.owner !== playerId) throw new Error("not your order");
    const commodity = o.commodity;
    return this._cancel(orderId) ? commodity : null;
  }

  // --- engine wrappers that also record persistence intents/audit when a store is set ---
  _createPurse(id, poe) {
    const ts = this._now();
    this.ex.createAccount(id, poe);                  // poe only; goods live in warehouses
    this.ex.labor.set(id, { amount: LABOR_START, ts });
    if (this.store) this._record({ kind: "account", owner: id, poe, ts });
  }
  // Deposit located goods into `owner`'s warehouse at `island` (onboarding + NPC seed).
  _grant(owner, island, inv) {
    for (const [c, q] of Object.entries(inv)) this.ex.mint(this.ex.whId(owner, island), c, q);
    if (this.store) this._record({ kind: "grant", owner, island, inv });
  }
  _place(owner, commodity, side, price, qty) {
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    const order = this.ex.placeLimit(owner, this.island, commodity, side, price, qty);
    const newTrades = this.ex.trades.slice(tLen);
    applyTradeTax(this.ex, newTrades, this.flag, this.taxRate); // game rule, always
    applyDemandBurn(this.ex, newTrades);                        // finished goods sold to demand are destroyed
    applyDemandLevy(this.ex, newTrades, this.flag, this.demandLevyBps); // drains the demand premium -> sink
    applyListingFee(this.ex, owner, price, qty, this.flag, this.listingFeeBps); // players only -> sink/flag
    if (this.store) {
      this._record({ kind: "place", owner, island: this.island, commodity, side, price, qty, flag: this.flag, rate: this.taxRate, fee: this.listingFeeBps, levy: this.demandLevyBps });
      this._captureAudit(lLen, tLen);
    }
    return order;
  }
  _cancel(orderId) {
    const lLen = this.ex.ledger.entries.length, tLen = this.ex.trades.length;
    const ok = this.ex.cancel(orderId);
    if (this.store && ok) {
      this._record({ kind: "cancel", ref: orderId });
      this._captureAudit(lLen, tLen);
    }
    return ok;
  }
  _record(intent) {
    this._pending.intents.push({ seq: this._nextSeq(), ...intent });
  }
  _captureAudit(lLen, tLen) {
    for (const e of this.ex.ledger.entries.slice(lLen)) {
      this._pending.ledger.push({ account: e.account, delta: e.delta, reason: e.reason });
    }
    for (const t of this.ex.trades.slice(tLen)) {
      this._pending.trades.push({ island: t.island, commodity: t.commodity, price: t.price, qty: t.qty, buyer: t.buyer, seller: t.seller });
    }
  }

  // Persist everything recorded since the last flush (one batch per call). The
  // room awaits this after each op so a client sees success only once durable.
  async flush() {
    if (!this.store) return;
    const batch = this._pending;
    if (!batch.intents.length && !batch.trades.length && !batch.ledger.length) return;
    this._pending = emptyBatch();
    await this.store.persist(batch);
  }

  // --- snapshots ---
  depth(commodity, n = 8) {
    return this.ex.depth(this.island, commodity, n);
  }

  // Private to one player: spendable PoE (global), labor (regen'd to `now`),
  // holdings, and their resting orders ON THIS ISLAND (the book this room shows).
  balancesOf(playerId, now = this._now()) {
    const a = this.ex.acct(playerId);                              // purse (global PoE)
    const wh = this.ex.accounts.get(this.ex.whId(playerId, this.island)); // warehouse HERE
    const holdings = {};
    for (const c of this.commodities) holdings[c] = (wh && wh.inv[c]) || 0;
    const orders = [];
    for (const o of this.ex.openOrders.values()) {
      if (o.owner === playerId && o.island === this.island) {
        orders.push({ id: o.id, commodity: o.commodity, side: o.side, price: o.price, qty: o.qty });
      }
    }
    const stalls = []; // recipes this player owns a stall for ON THIS ISLAND
    for (const s of this.ex.stalls.values()) {
      if (s.owner === playerId && s.island === this.island) stalls.push(s.recipe);
    }
    const sites = []; // raws this player owns an extraction site for ON THIS ISLAND
    for (const s of this.ex.sites.values()) {
      if (s.owner === playerId && s.island === this.island) sites.push(s.commodity);
    }
    // the captain's fleet (every ship they own, wherever it's docked) + each hold's
    // contents — so the client can render where goods are and where they can sail.
    const ships = [];
    for (const [id, s] of this.ex.ships) {
      if (s.owner !== playerId) continue;
      const h = this.ex.accounts.get(`hold:${id}`);
      const hold = {};
      if (h) for (const c of this.commodities) if (h.inv[c]) hold[c] = h.inv[c];
      const voyage = s.voyage ? { from: s.voyage.from, to: s.voyage.to, arriveAt: s.voyage.arriveAt } : null;
      ships.push({ id, cls: s.cls, dockedAt: s.dockedAt, voyage, cargoCap: SHIP_CARGO[s.cls] ?? 0, hull: s.hull, maxHull: s.maxHull, hold });
    }
    return { poe: a.poe, name: this.nameOf(playerId), labor: laborAt(this.ex, playerId, now), holdings, orders, stalls, sites, ships, wreck: this.wreckHere(), crews: this.crewsOf(playerId), pledged: this.isPledged(playerId), myFlags: this.flagsOf(playerId) };
  }

  // --- conservation totals (tests / ops) ---
  totalPoe() { return this.ex.totalPoe(); }
  totalUnits(commodity) { return this.ex.totalUnits(commodity); }
}

// Rebuild an Exchange from an append-only intent log (ascending by seq). Applies
// each intent through the SAME engine code path used live, so the reconstructed
// books, balances, escrow, last prices and order ids are byte-for-byte identical.
export function replay(ex, intents) {
  ex.located = true;                                 // rebuild a LOCATED world (goods in warehouses)
  if (!ex.labor) ex.labor = new Map();
  if (!ex.stalls) ex.stalls = new Map();
  if (!ex.flagMembers) ex.flagMembers = new Map();
  if (!ex.islandFlag) ex.islandFlag = new Map();
  if (!ex.ships) ex.ships = new Map();
  if (ex._sid === undefined) ex._sid = 0;
  if (!ex.sites) ex.sites = new Map();
  if (!ex.onboarded) ex.onboarded = new Set();
  if (!ex.crews) ex.crews = new Map();
  if (ex._cid === undefined) ex._cid = 0;
  if (!ex.blockades) ex.blockades = new Map();
  if (!ex.names) ex.names = new Map();
  if (!ex.nameOwners) ex.nameOwners = new Map();
  const ordered = [...intents].sort((a, b) => a.seq - b.seq);
  for (const it of ordered) {
    if (it.kind === "account") { ex.createAccount(it.owner, it.poe); ex.labor.set(it.owner, { amount: LABOR_START, ts: it.ts ?? 0 }); }
    else if (it.kind === "grant") { for (const [c, q] of Object.entries(it.inv)) ex.mint(ex.whId(it.owner, it.island), c, q); }
    else if (it.kind === "onboard") applyOnboard(ex, it.owner, it.island, it.inv, it.cls, it.ship);
    else if (it.kind === "buyship") { applyDrain(ex, it.owner, it.price, "shipyard", it.flag ?? null); applyCreateShip(ex, it.ship, it.owner, it.cls, it.island); }
    else if (it.kind === "place") {
      const tLen = ex.trades.length;
      ex.placeLimit(it.owner, it.island, it.commodity, it.side, it.price, it.qty);
      const newTrades = ex.trades.slice(tLen);
      applyTradeTax(ex, newTrades, it.flag ?? null, it.rate ?? 0);
      applyDemandBurn(ex, newTrades);
      applyDemandLevy(ex, newTrades, it.flag ?? null, it.levy ?? 0);
      applyListingFee(ex, it.owner, it.price, it.qty, it.flag ?? null, it.fee ?? 0);
    }
    else if (it.kind === "upkeep") {
      applyDrain(ex, it.owner, it.amount, "upkeep", it.flag ?? null);
      if (!ex.upkeepTs) ex.upkeepTs = new Map();
      ex.upkeepTs.set(`${it.owner}:${it.island}`, it.ts);
    }
    else if (it.kind === "repair") applyRepair(ex, it.owner, it.ship, it.flag ?? null);
    else if (it.kind === "hull") applySetHull(ex, it.ship, it.hull);
    else if (it.kind === "scuttle") applyScuttle(ex, it.ship);
    else if (it.kind === "cancel") ex.cancel(it.ref);
    else if (it.kind === "load") applyLoad(ex, it.owner, it.ship, it.commodity, it.qty, it.island);
    else if (it.kind === "unload") applyUnload(ex, it.owner, it.ship, it.commodity, it.qty, it.island);
    else if (it.kind === "sail") applySail(ex, it.owner, it.ship, it.to, it.from, it.departAt, it.arriveAt, it.danger);
    else if (it.kind === "arrive") applyArrive(ex, it.ship, it.to, it.hull, it.sunk);
    else if (it.kind === "build") applyBuild(ex, it.owner, it.island, it.recipe, it.to ?? UNCLAIMED_TREASURY);
    else if (it.kind === "site") applyBuildSite(ex, it.owner, it.island, it.commodity, it.to ?? UNCLAIMED_TREASURY);
    else if (it.kind === "extract") applyExtract(ex, it.owner, it.island, it.commodity, it.fee ?? EXTRACT_FEE, it.flag ?? null, it.ts ?? 0);
    else if (it.kind === "salvage") applySalvage(ex, it.owner, it.island, it.commodity, it.qty);
    else if (it.kind === "raider") { applyCreateShip(ex, it.ship, RAIDER, it.cls, it.dockedAt); for (const [c, q] of Object.entries(it.cargo)) ex.mint(`hold:${it.ship}`, c, q); }
    else if (it.kind === "crew_form") applyFormCrew(ex, it.crew, it.captain, it.name);
    else if (it.kind === "crew_join") applyJoinCrew(ex, it.crew, it.owner);
    else if (it.kind === "crew_deposit") applyCrewDeposit(ex, it.crew, it.owner, it.amount);
    else if (it.kind === "crew_withdraw") applyCrewWithdraw(ex, it.crew, it.owner, it.amount);
    else if (it.kind === "blockade_declare") applyDeclareBlockade(ex, it.owner, it.island, it.attacker, it.defender ?? null, it.cost ?? BLOCKADE_COST);
    else if (it.kind === "blockade_push") applyBlockadePush(ex, it.owner, it.island, it.side, it.ts ?? 0);
    else if (it.kind === "blockade_battle") applyBlockadeMeter(ex, it.island, it.side, BLOCKADE_BATTLE_STEP);
    else if (it.kind === "name") applySetName(ex, it.owner, it.name);
    else if (it.kind === "pledge") applyPledge(ex, it.owner, it.flag);
    else if (it.kind === "payout") applyPayout(ex, it.flag);
    else if (it.kind === "seize") applySeize(ex, it.owner, it.island, it.flag, it.cost ?? CONQUEST_COST);
    else if (it.kind === "plunder") applyPvePlunder(ex, it.owner, it.ts ?? 0);
    else if (it.kind === "pvp_plunder") applyPvpPlunder(ex, it.winner, it.island, it.loser, it.ship, PVP_COIN_BPS);
    else if (it.kind === "produce") applyProduce(ex, it.owner, it.recipe, it.island, it.ts ?? 0);
  }
  return ex;
}

// Islands that have been NPC-seeded, inferred from the intent log (so a restart
// doesn't double-seed). An island is seeded once an "npc" place exists for it.
export function seededIslandsFrom(intents) {
  const s = new Set();
  for (const it of intents) if (it.kind === "place" && it.owner === "npc") s.add(it.island);
  return s;
}
