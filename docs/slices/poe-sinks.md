# Slice: PoE-drain sinks (fees, upkeep, repair, loss-on-sinking)

Status: **implemented**. Gives the economy its first real money drains — the fix for
the audit's central finding (no net PoE drain → monotonic inflation).

## Drain destination (split)
Every drained PoE is split: **60% to the `crown`** (a terminal account that never pays
out — so player-held money genuinely shrinks) and **40% to the island's controlling
flag** (territory income, redistributed via the existing payout). Unflagged islands
burn the whole amount to the crown. `SINK_BURN_BPS = 6000`.

## The four sinks
1. **Listing fee** — a per-order fee (`listingFeeBps`, default 0; the hub sets it to
   `LISTING_FEE_BPS` = 1% for live islands). NPC/demand liquidity is exempt. Charged in
   the `_place` path and replayed (the rate rides on the `place` intent as `fee`).
   Gated at 0 by default so it never perturbs the order-book balance unit tests.
2. **Upkeep / rent** — `tickUpkeep(now)` charges whole elapsed cycles of rent for stalls
   on the island + ships docked there (`UPKEEP_STALL`/`UPKEEP_SHIP` per
   `UPKEEP_PERIOD_MS`). Lazy + ts-based per `(owner, island)` (no global clock), so it's
   safe that only live-island rooms tick and idle owners still owe. Soft model: clamped
   to what the owner can pay (no debt). Recorded as `upkeep` intents (charged amount + ts).
3. **Repair** — `repairShip(player, ship)` restores a docked ship toward full hull at
   `REPAIR_PER_HULL`/point (drained, split). Ships now carry `hull`/`maxHull`
   (`SHIP_HULL`, mirrors `@salt/shared`). Recorded as `repair`; cost recomputed from the
   replayed hull state.
4. **Loss-on-sinking** — `resolveShip(shipId, finalHull)`: `<= 0` **sinks** the ship
   (its hold cargo burned — a goods sink — the hold account dropped, the ship removed),
   otherwise records the remaining hull. Recorded as `scuttle` / `hull`.

## Combat integration (thin, real)
`PillageRoom` accepts optional `playerShipId` / `enemyShipId`. When present, the real
ship's persisted hull seeds the battle and the outcome is written back via the hub:
a defeated ship is sunk (cargo burned, removed), a survivor keeps its damage. Omitted
(today's default / tests) → combat has no economy effect, exactly as before. Full
matchmaking that supplies real ship ids is still deferred.

> Note: a captain who loses their only ship is re-granted a basic sloop on next join
> (no ship-purchase economy yet). Flagged for a future "shipyard" slice.

## Invariants (extends the registry, doesn't rewrite it)
- `reason_classified` now covers the new SINK reasons (`upkeep`/`fee`/`repair`) and the
  `flag_levy` transfer — a forgotten label fails loudly.
- **`terminal_sink`** (new): the `crown` and `warchest` only ever receive PoE; any debit
  is a bug.
- `poe_accounted` / `units_reconciled` unchanged (the burned PoE sits in the crown;
  burned cargo decrements `mintedUnits` in lockstep).

## Tests
`sinks.test.mjs`: fee split (flagged + unflagged); upkeep per-cycle split + no-partial;
repair restore + drain + guards; loss-on-sinking burns hold + removes ship + no orphan;
and an **all-four replay** test (fee + upkeep + repair + sinking) rebuilding identical
crown/flag/supply/views from an empty engine. `fuzz.test.mjs`: fees enabled, plus
`upkeep`/`repair`/`damage` ops, under `terminal_sink` + `reason_classified` (sink is
covered by the dedicated test so it doesn't starve the fleet).

## Follow-on
- Shipyard: buy/replace ships (so loss-on-sinking has lasting stakes), salvage (sunk
  cargo to the victor — a faucet).
- Agent sim (§11): now has faucets (grant, plunder, demand) AND sinks (crown drains) to
  balance — measure money supply / prices over a long simulated run.
- Real sailing (replace the `move` stub) + wiring real ship ids into PillageRoom.
