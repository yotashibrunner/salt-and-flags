# Slice: wreck salvage (loss-on-sinking leaves recoverable cargo)

Status: **implemented**. Softens loss-on-sinking and adds a risk/reward faucet: a sunk
ship no longer burns 100% of its hold — `SALVAGE_BPS` (40%) washes up as a **wreck** at
the nearest port, recoverable by any captain who sails there.

## Mechanic
- On `applyScuttle`, for each commodity in the hold: 40% moves to a `wreck:{island}`
  account (the voyage destination, or where it was docked), 60% is burned (`ex.burn`, so
  `mintedUnits` stays reconciled). The wreck is a located account — no new structure.
- `salvage(player, commodity, qty)` transfers from `wreck:{island}` into the player's
  warehouse here (clamped to what's available). `wreckHere()` / `balancesOf().wreck`
  expose what's salvageable. Recorded as a `salvage` intent; the wreck itself is rebuilt
  on replay as a consequence of the recorded scuttle (deterministic split).

So sinking still costs the ship + most of the cargo, but a portion is recoverable — by
the victim later, or by anyone who braves the dangerous route to the wreck. A new faucet
that rewards sailing into danger, with no victor needed (fits auto-resolved encounters).

## Tests
`salvage.test.mjs`: a sinking leaves a 40% wreck another captain recovers (clamps + empties);
a transit sinking drops the wreck at the voyage destination; and a replay test (partial
salvage rebuilds identically). Updated the loss-on-sinking assertions in `sinks.test.mjs`
and `sailing.test.mjs` for the partial burn. 68 tests pass; tsc clean.
