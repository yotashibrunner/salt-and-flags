# Slice: raw extraction (the loop's renewable input + the sim's balancing lever)

Status: **implemented**. Closes the production loop's last dangling end (raws had no
renewable source) AND adds the supply-side money sink the agent sim showed was needed.

## Mechanic: claim-gated extraction sites
A captain builds an **extraction site** (plantation/mine) at an island that PRODUCES a
raw, then extracts it:
- **Build** (`buildSite`) — gated on the island producing that raw and the good being a
  raw tier (hemp/wood/ironore/sugar). Charges `SITE_COST` (120) as a levy to the
  controlling flag (a transfer, like a stall levy).
- **Extract** (`extract`) — gated on owning the site. Spends `EXTRACT_LABOR` (3) labor +
  an `EXTRACT_FEE` (25) PoE fee, mints `EXTRACT_YIELD` (4) units into the local
  warehouse. The fee is a **SINK** (split 60% crown / 40% flag), affordability-gated.
- **Upkeep** — sites accrue rent (`UPKEEP_SITE` = 4/cycle) alongside stalls + ships.

So raw supply is renewable but **costs money** (build levy + per-pull fee + upkeep) —
three sinks on the input side. Persisted/replayed via `site` + `extract` intents; the
extract fee/flag/ts ride on the intent so a restart rebuilds the burned-down supply
identically.

## What the sim now shows (the point of doing this)
Re-running `npm run sim` with producers extracting their own sugar (no more free grant):
- **Crown drain ~8.6×** the no-extraction run (≈16k → ≈138k over 40 epochs).
- **Player-money growth roughly halved** (final ≈229k → ≈108k), with trade volume,
  prices, conservation, and all invariants unchanged. Gini settles ~0.42 (healthy).

`EXTRACT_FEE` was tuned to keep producers solvent (50 made them break-even and spiked
Gini to ~0.6; 25 restores a producer margin while still draining hard).

## The remaining (structural) finding
The economy is still mildly inflationary, and extraction can't fully fix it: the drain it
adds lands on the **producer** side, but the residual new money is the **trader's demand
premium** — NPC demand pays ~31/rum for goods that cost ~19 to make, and that premium
flows to whoever sells into demand. Full balance needs draining the demand *sale*
(a higher tax/fee at the demand point) or pricing demand nearer production cost. That's
the next calibration lever, not an extraction problem.

## Tests
`extract.test.mjs`: site gating (raw-only, produced-here-only, site-required); extract
mints the raw + charges the fee (split) + labor; labor/PoE gating; and a **replay** test
rebuilding identical renewable supply + crown/flag balances + site ownership. The 4000-op
`fuzz.test.mjs` now includes `buildSite`/`extract` (isleA produces sugar, isleC wood) under
all invariants, and the `sim.test.mjs` health run uses extraction throughout.

## Follow-on
1. **Drain the demand premium** (tax/fee at the demand sale, or demand priced to cost) —
   the lever to flatten the money supply the rest of the way; re-run the sim to confirm.
2. Shipyard (buy/replace ships → lasting loss-on-sinking stakes).
3. Real sailing (replace the `move` stub) + wiring real ship ids into PillageRoom.
