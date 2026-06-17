# Slice: real sailing (time-based voyages + transit encounters)

Status: **implemented**. Replaces the instant `move` teleport with real, lane-gated,
time-based voyages, and makes loss-on-sinking reachable through play via deterministic
transit encounters.

## Sailing model
- **Lane-gated**: a ship may only sail to an island connected by a world lane. The
  `move` room message looks the lane up (`registry.laneDist`) and rejects if none.
- **Time-based**: `moveShip(player, ship, to, dist, danger)` puts the ship **at sea**
  (`dockedAt = null`, `voyage = {from, to, departAt, arriveAt, danger}`) for a duration
  set by the lane distance / the ship's sail speed (`SHIP_SAIL`, `TRAVEL_MS_PER_DIST`).
  At sea it can't load/unload/sail again. `tickVoyages(now)` lands due voyages.
- **Lazy-but-recorded arrival**: arrivals settle on a tick (the room runs `tickVoyages`
  every 2 s) and are recorded as `arrive` intents, so replay rebuilds positions exactly
  (the `sail` intent carries the timing; `arrive` carries the outcome).

## Transit encounters (deterministic)
On arrival each voyage rolls `voyageEncounter(shipId, departAt, danger, hull, maxHull)` —
pure, hash-based on `(shipId, departAt)`, so it's reproducible and unit-testable, and the
**outcome is also recorded** on the `arrive` intent for replay robustness. A hit does
20–60% of max hull in damage; a ship already wounded enough is **sunk** → the existing
`applyScuttle` path burns its cargo and removes it (loss-on-sinking, now triggered by
sailing, not just the API). Route `danger` comes from the destination/origin region theme.

Note: a single encounter never sinks a full-hull ship (max 60% damage) — sinkings come
from sailing battered or repeated bad luck, which is the intended risk curve.

## What's wired vs deferred
The user chose **deterministic server-side resolution** (testable, no client) over
interactive `PillageRoom` battles. So encounters auto-resolve via `tickVoyages` →
`hub.resolveShip` semantics; the interactive-battle hooks (`PillageRoom` + real ship ids)
remain ready for a later combat slice. World plumbing: `registry.setWorld` now indexes the
lane graph + per-region danger.

## Sim impact (the integration check)
The agent sim now sails real voyages (traders go at sea, driven by their ship's actual
`dockedAt`, and buy a replacement if sunk). It stays healthy: volume steady (~160/epoch —
voyages are short vs the tick), invariants hold every epoch, and Gini drops further
(~0.15) as sink/rebuy churn redistributes. Money-supply growth slows again (sinkings cost
cargo + a 300 rebuy). Full loop, end to end, through real movement.

## Tests
`sailing.test.mjs`: a voyage is real (at sea, can't act, arrives on time, cargo rides
along); an encounter sinks a wounded ship (cargo burned, ship gone, no orphan hold); and a
replay test (damaged-in-transit hull + position rebuild identically). The fuzzer's `move`
op now sails with danger and lands voyages each iteration (encounters under all
invariants). Existing full-loop + located-replay tests updated for at-sea semantics.
65 tests pass; tsc clean.

## Follow-on
- Interactive `PillageRoom` battles from encounters (real ship ids → the hooks exist).
- Salvage: a sunk ship's cargo to a nearby victor (a faucet) instead of pure burn.
- Client UI for voyages (ETA, at-sea state) — server already sends `voyage` in balances.
