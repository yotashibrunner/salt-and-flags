// ============================================================================
// Salt & Flags — economy invariants (the standing safety net the fuzzer runs
// after every op). Each invariant is a PURE check over the Exchange:
//   (ex) => null            // holds
//   (ex) => { name, detail } // violated
// `checkAll` runs the whole registry and returns the first violation (or null).
//
// Built to be EXTENDED, not rewritten. The next slice (faucet/sink money-supply
// accounting) adds entries to INVARIANTS and TIGHTENS `poe_accounted` using the
// ledger reason taxonomy below — it does not tear this file down. The taxonomy is
// already first-class today even though we currently only assert zero-sum +
// minted-accounting, so that reframe is an added assertion over data already flowing.
// ============================================================================
import { SHIP_CARGO, DEMAND, FINISHED, CROWN } from "./market.mjs";

const TERMINAL_SINKS = new Set([CROWN, "warchest"]); // accounts that only ever receive PoE

// --- ledger reason taxonomy (every postPair reason is classified) ---
// FAUCET: PoE enters players' hands from a pre-funded reserve.
// SINK:   PoE leaves to a terminal account that never pays out.
// TRANSFER: PoE moves between player-controlled accounts (net money unchanged).
// Next slice: assert every system-touching pair's reason is in FAUCET ∪ SINK and
// that ΔtotalPoe over a window == Σfaucet − Σsink.
export const FAUCET_REASONS = new Set(["plunder"]);
export const SINK_REASONS = new Set(["conquest", "upkeep", "fee", "repair", "extract", "demand_levy", "shipyard", "blockade"]);
export const TRANSFER_REASONS = new Set([
  "escrow_buy", "fill", "price_improve_refund", "cancel_refund",
  "stall_levy", "trade_tax", "flag_payout", "flag_levy", "site_levy",
  "crew_deposit", "crew_withdraw",
]);
// Every PoE movement must carry one of these reasons — the reframe seam: a new
// faucet/sink (e.g. upkeep, repair, fees) is added by labeling it here, and
// I_reasonsClassified then guarantees no unlabeled PoE flow slips through.
const KNOWN_REASONS = new Set([...FAUCET_REASONS, ...SINK_REASONS, ...TRANSFER_REASONS]);

function I_ledgerZeroSum(ex) {
  const s = ex.ledger.sum();
  return s === 0 ? null : { name: "ledger_zero_sum", detail: `ledger sums to ${s}, expected 0` };
}

// PoE is conserved except for what was minted at account creation (opening balances
// — the only PoE faucet today). NEXT SLICE: replace `ex.minted` with faucet/sink
// accounting derived from labeled ledger reasons. Same equality, stricter source.
function I_poeAccounted(ex) {
  const total = ex.totalPoe();
  return total === ex.minted
    ? null
    : { name: "poe_accounted", detail: `totalPoe ${total} != minted ${ex.minted}` };
}

// Units are conserved except for what production/grants minted (tracked in
// mintedUnits). NEXT SLICE: NPC finished-goods consumption registers as a burn here.
function I_unitsReconciled(ex) {
  for (const c of Object.keys(ex.mintedUnits)) {
    const total = ex.totalUnits(c);
    if (total !== ex.mintedUnits[c]) {
      return { name: "units_reconciled", detail: `${c}: total ${total} != minted ${ex.mintedUnits[c]}` };
    }
  }
  return null;
}

function I_noNegatives(ex) {
  for (const a of ex.accounts.values()) {
    if (a.poe < 0) return { name: "no_negative_poe", detail: `${a.id} poe ${a.poe}` };
    for (const c in a.inv) {
      if (a.inv[c] < 0) return { name: "no_negative_inv", detail: `${a.id} ${c} ${a.inv[c]}` };
    }
  }
  return null;
}

// Escrow holds EXACTLY what resting orders reserved: PoE for open buys, goods for
// open sells. Catches a leak/double-spend the moment it happens.
function I_escrowIntegrity(ex) {
  const esc = ex.accounts.get("ESCROW");
  if (!esc) return null;
  let needPoe = 0;
  const needInv = {};
  for (const o of ex.openOrders.values()) {
    if (o.side === "buy") needPoe += o.price * o.qty;
    else needInv[o.commodity] = (needInv[o.commodity] || 0) + o.qty;
  }
  if (esc.poe !== needPoe) return { name: "escrow_poe", detail: `escrow poe ${esc.poe} != open buys ${needPoe}` };
  for (const c of new Set([...Object.keys(needInv), ...Object.keys(esc.inv)])) {
    if ((esc.inv[c] || 0) !== (needInv[c] || 0)) {
      return { name: "escrow_inv", detail: `escrow ${c} ${esc.inv[c] || 0} != open sells ${needInv[c] || 0}` };
    }
  }
  return null;
}

// Located-inventory integrity: no hold over its ship's capacity, and every hold
// account belongs to a registered ship. NEXT SLICE: loss-on-sinking / salvage add
// located-transfer checks here.
function I_locationIntegrity(ex) {
  if (!ex.ships) return null;
  for (const [id, s] of ex.ships) {
    const h = ex.accounts.get(`hold:${id}`);
    if (!h) continue;
    let fill = 0;
    for (const c in h.inv) fill += h.inv[c];
    const cap = SHIP_CARGO[s.cls] ?? 0;
    if (fill > cap) return { name: "cargo_capacity", detail: `${id} hold ${fill} > cap ${cap}` };
  }
  for (const a of ex.accounts.values()) {
    if (a.id.startsWith("hold:")) {
      const sid = a.id.slice("hold:".length);
      if (!ex.ships.has(sid)) return { name: "orphan_hold", detail: `${a.id} has no registered ship` };
    }
  }
  return null;
}

// Every ledger entry carries a classified reason (faucet | sink | transfer). The
// reframe in action: PoE only ever moves via a labeled flow, so an unlabeled one
// (a forgotten faucet/sink) fails loudly instead of silently inflating the economy.
function I_reasonsClassified(ex) {
  for (const e of ex.ledger.entries) {
    if (!KNOWN_REASONS.has(e.reason)) {
      return { name: "reason_classified", detail: `unlabeled ledger reason "${e.reason}"` };
    }
  }
  return null;
}

// The finished-goods sink actually destroys: the demand reserve never retains the
// goods it buys (they're burned on fill), so its warehouses hold nothing.
function I_demandBurns(ex) {
  const prefix = `wh:${DEMAND}:`;
  for (const a of ex.accounts.values()) {
    if (!a.id.startsWith(prefix)) continue;
    for (const c in a.inv) {
      if (a.inv[c] !== 0) {
        return { name: "demand_burns", detail: `${a.id} retains ${a.inv[c]} ${c} — demand goods must be burned${FINISHED.has(c) ? "" : " (and demand shouldn't even buy this)"}` };
      }
    }
  }
  return null;
}

// Terminal sinks (crown, warchest) only ever RECEIVE PoE — they never pay out, which
// is what makes them a real drain on player-held money. Any debit from one is a bug.
function I_terminalSinks(ex) {
  for (const e of ex.ledger.entries) {
    if (TERMINAL_SINKS.has(e.account) && e.delta < 0) {
      return { name: "terminal_sink", detail: `${e.account} paid out ${-e.delta} (${e.reason}) — sinks never debit` };
    }
  }
  return null;
}

export const INVARIANTS = [
  I_ledgerZeroSum,
  I_poeAccounted,
  I_unitsReconciled,
  I_noNegatives,
  I_escrowIntegrity,
  I_locationIntegrity,
  I_reasonsClassified,
  I_demandBurns,
  I_terminalSinks,
];

// Run every invariant; return the first violation { name, detail } or null.
export function checkAll(ex) {
  for (const inv of INVARIANTS) {
    const v = inv(ex);
    if (v) return v;
  }
  return null;
}
