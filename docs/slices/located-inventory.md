# Slice: Located inventory + cargo + ship-move stub + extensible invariant fuzzer

Status: **implemented** (this slice). Tracking doc — check items off as verified.

## Goal
Goods become physical. They live at a port **warehouse** (`wh:{owner}:{island}`) or in a
ship's **hold** (`hold:{shipId}`). The only way a good gets from island A to island B is to
load it onto a ship and sail (instant stub) the ship to B. PoE stays the captain's global
purse. A standing invariant fuzzer guards the money-safe core and is built to be *extended*
by the next slice (faucet/sink accounting), not rewritten.

## In scope
- [x] Located goods storage (warehouse + ship hold), opt-in on the engine via `Exchange.located`.
- [x] Per-ship holds with capacity from `SHIP_CARGO` (mirrors `@salt/shared` SHIP_CLASSES).
- [x] Load / unload at the docked port; capacity enforced.
- [x] Instant **ship-move-between-ports** stub (changes `dockedAt`; hold travels with the ship).
- [x] Located new-player onboarding grant + located NPC seed stock.
- [x] Persistence + replay for `grant` / `ship` / `load` / `unload` / `move` intents.
- [x] Migration `0003` drops the stale `market_intents.kind` CHECK.
- [x] Extensible invariant fuzzer with the new ops in its set + a full-loop scenario test.

## Out of scope (deferred — kept as minimal stubs)
Turn-based sailing, wind / encounters / interception, travel time or fuel, loss-on-sinking,
salvage, docking / move fees, repair, recurring upkeep, NPC finished-goods *consumption*.
`move` only changes which port a ship is docked at.

## Data model
A **location is an account**, so goods only ever move account-to-account through the proven
conserved-transfer engine.

| Purpose | Account id | Holds |
|---|---|---|
| Captain's purse (global) | `playerId` | `poe` |
| Warehouse (located goods) | `wh:{owner}:{island}` | `inv` |
| Ship hold | `hold:{shipId}` | `inv` |
| Escrow / npc / bounty / warchest / treasuries | as before | — |

Non-account state on the `Exchange`: `ships: Map<shipId,{owner,cls,dockedAt}>`, `_sid`
(ship-id counter), `minted` / `mintedUnits` (faucet accounting baselines).

## Engine design note (`economy.mjs`)
Located goods are **opt-in**: `Exchange.located` defaults `false`, so the engine-level tests
keep treating the owner account as the goods store and pass unchanged. `Market` sets
`ex.located = true`. When located, `_goods(owner, island)` resolves to `_inv(whId(owner,island))`;
otherwise to `acct(owner)`. Escrow/settle/cancel all route goods through `_goods`. PoE escrow
and seller proceeds always hit the owner's purse account (global coin).

## The full loop (verified by `fuzz.test.mjs`)
buy at A → goods land in `wh:p:A` → `load` into a ship docked at A → `move` ship A→B →
`unload` into `wh:p:B` → sell on B's book. Goods are **not** sellable at B until the move +
unload land.

## Invariant registry (`invariants.mjs`) — built to extend
`INVARIANTS` is an array of pure checks `(ex) => null | {name, detail}`; `checkAll` runs them
all. The ledger `reason` taxonomy (`FAUCET_REASONS` / `SINK_REASONS` / `TRANSFER_REASONS`) is
first-class **now**, even though today only zero-sum + minted-accounting are asserted.

| Check | Basis | Next-slice fate |
|---|---|---|
| ledger_zero_sum | `ledger.sum()===0` | unchanged |
| poe_accounted | `totalPoe()===ex.minted` | tightened: derive from labeled faucet/sink reasons |
| units_reconciled | `totalUnits(c)===ex.mintedUnits[c]` | extended: NPC consumption registers as burn |
| no_negative_poe / _inv | per-account scan | unchanged |
| escrow_poe / _inv | derived from `openOrders` | unchanged |
| cargo_capacity / orphan_hold | ships + hold accounts | extended by loss-on-sinking/salvage |

## Follow-on slices (unblocked by this one)
1. NPC finished-goods demand (closes the loop's output end).
2. PoE drain sinks: upkeep/rent, repair, fees, loss-on-sinking → reframes `poe_accounted` to
   faucet/sink accounting.
3. Agent sim (second half of §11).
4. Real sailing: replace the `move` stub with lanes/distance/encounters.
