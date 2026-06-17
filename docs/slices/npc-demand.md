# Slice: NPC finished-goods demand (the production loop's exit)

Status: **implemented**. Closes the output end of the production chain — finished goods
now have a durable buyer that removes them from play.

## Goal
At islands that DEMAND a finished good (rum / sailcloth / shot), a dedicated reserve
rests a standing buy order for it. Selling into that bid:
- **burns** the goods (a true goods SINK — finished goods leave circulation), and
- **pays** the seller from the reserve (a PoE FAUCET).

Demand is **bounded**: total resting demand per good per island is capped
(`DEMAND_CAP`), refilled toward the cap on a slow tick. This gives finished goods
durable, finite value and makes the next slice's PoE-drain sinks meaningful.

## Model: refreshing burn-bids with a per-tick cap
- A pre-funded `demand` reserve account (deep PoE, like `bounty`/`npc`).
- `seedLiquidity` stands up the reserve and seeds a burn-bid at the island's **demand
  price** (`seedPrice` = base × `DEMAND_FACTOR`), capped at `DEMAND_CAP` per good.
- The bid sits at the demand price — above the NPC seed bids, below the NPC seed asks —
  so it rests as the best bid and never self-deals against NPC asks.
- On fill, `applyDemandBurn` burns exactly what the reserve bought from `wh:demand:island`
  (`ex.burn`, so `mintedUnits` drops in lockstep → units stay reconciled).
- `restockDemand()` tops each demanded good back to the cap by placing the shortfall as
  an ordinary buy; the room calls it on a 30 s tick and only when there's a shortfall.

## Replay strategy (no new intent kind)
Demand bids — seed and restock — are placed via the normal `_place` path, so they
persist as ordinary `place` intents and replay verbatim. `applyDemandBurn` runs in the
`place` branch of both the live path and `replay()`, so the burns a fill produces are
reproduced from the very same intents — burned-down supply rebuilds identically. The
`demand` reserve's purse is an `account` intent like any other reserve.

## Invariant reframe (extend, not rewrite)
The seam built in the located-inventory slice is now exercised:
- **`reason_classified`** (new): every ledger entry's reason ∈ `FAUCET ∪ SINK ∪ TRANSFER`.
  A forgotten faucet/sink (future upkeep/repair/fees) now fails loudly instead of
  silently inflating. Adding a flow = labeling its reason in the taxonomy.
- **`demand_burns`** (new): the demand reserve never retains goods it buys (its
  warehouses hold nothing) — proves the sink actually destroys.
- `units_reconciled` already covered the burn (mintedUnits tracks it); `poe_accounted`
  is unchanged (the reserve's PoE was minted at creation, like bounty).

## Tests
`demand.test.mjs`: burn-on-sell + seller paid + supply drops; cap + refill; finished-only
targeting (rum yes, iron/refined no, neutral island none); and a **replay** test that
burns/refills/burns then rebuilds identical supply + resting demand + invariants from an
empty engine. `fuzz.test.mjs`: `restock` added to the op set; isleB demands rum, so the
4000-op fuzz now exercises demand fills + burns under `demand_burns` / `reason_classified`.

## Follow-on (unblocked next)
1. **PoE-drain sinks** — upkeep/rent, repair, fees, loss-on-sinking. Each is added by
   labeling a new reason in the taxonomy; `reason_classified` enforces coverage.
2. Agent sim (second half of §11) — now has both a faucet and a sink to balance.
3. Real sailing (replace the `move` stub).
