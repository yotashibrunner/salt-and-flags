# Slice: shipyard (ships cost money → loss-on-sinking has real stakes)

Status: **implemented**. Closes the loss-on-sinking gap flagged after the sinks slice:
a sunk-ship captain used to be handed a free sloop on rejoin, so sinking cost nothing
lasting. Now the free starter is strictly one-time and replacements are bought.

## Two parts
1. **One-time starter, no free respawn.** Onboarding (starter goods + a free sloop) now
   fires exactly once per captain, tracked in `ex.onboarded` — independent of current
   ship count. Losing your ship no longer re-triggers it. Recorded as a single `onboard`
   intent (goods + sloop + the marker), so a restart rebuilds it and never re-onboards.
   (Fixes the old `!ownsAnyShip` re-grant.)
2. **Shipyard purchase.** `buyShip(player, cls)` pays `SHIP_PRICE[cls]`
   (sloop 300 / brig 900 / frigate 1800 / galleon 3600) as a **SINK** (split 60/40
   crown/flag, reason `shipyard`) and docks a fresh hull at the port. Recorded as
   `buyship`; replayed. The way back from a sinking — and another money drain.

So sinking now costs the hold's cargo (burned) **and** the ship (≥300 to replace) — real
stakes — while a broke, shipless captain can still trade warehouse goods / extract to earn
their way back to a hull (not a dead end).

## Housekeeping
Removed the now-dead `_createShip` / `ship` intent (onboarding uses `onboard`, the
shipyard uses `buyship`). Also stripped stray NUL bytes that had been sitting in
`stallKey`'s separators since the original scaffold (they made git/grep treat
`market.mjs` as binary); the key now uses plain spaces — purely in-memory, so no
persisted state changes.

## Tests
`shipyard.test.mjs`: one-time starter (rejoin grants nothing); purchase charges the price
as a split sink + docks a fresh hull + class/affordability guards; **loss-on-sinking has
no free respawn** (sink → rejoin → still shipless → must buy); and a restart test
(starter + a bought brig + a sinking + a rejoin → replay leaves exactly the brig). The
4000-op `fuzz.test.mjs` gains a `buyShip` op under all invariants (incl. `terminal_sink`).
62 tests pass; tsc clean.

## Follow-on
- Real sailing: replace the instant `move` stub + wire real ship ids into PillageRoom so
  loss-on-sinking triggers from actual battles (the hub hooks already exist).
- Salvage: a sunk ship's cargo to the victor (a faucet) instead of pure burn.
- Branch/PR: `slice/located-inventory` now carries the full economy arc (8 slices).
