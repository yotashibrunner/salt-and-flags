# Slice: fix the plunder faucet (PvP transfer / PvE capped pool / crown cut)

Status: **implemented** (combat faucet only — trade/demand/extract/sink constants untouched).

## Problem
The long sim showed the money supply inflated linearly; the cause was plunder — a flat
500/win MINTED from an infinite bounty reserve, the one faucet with no offsetting drain.

## Fix (three parts + tunable dials)
1. **PvP plunder = loot the loser, not mint.** `applyPvpPlunder`: the defeated player's hold
   cargo → the victor's warehouse here, plus `PVP_COIN_BPS` (30%) of the loser's coin →
   victor. Zero-sum, reason `pvp_plunder` = **TRANSFER**. Gives combat real stakes.
2. **PvE plunder = a capped, rate-limited prize pool** (`PRIZE`, replaces the infinite
   bounty). `applyPvePlunder` lazily refills the pool from elapsed game time
   (`PRIZE_REGEN`/sec, capped at `PRIZE_CAP`) — the refill is the only minting — then pays
   `PVE_PLUNDER`/win from it, capped by the pool. Reason `plunder` = **FAUCET**, but now
   bounded by the refill rate regardless of win count.
3. **Letter-of-marque crown cut.** `plunderCrownCut`: `PLUNDER_CROWN_BPS` (15%) of every
   plunder payout → crown, reason `letter_of_marque` = **SINK**. Combat is net-neutral-to-
   deflationary.

Dials (alongside the other economy constants): `PRIZE_RESERVE`, `PRIZE_REGEN`, `PRIZE_CAP`,
`PVE_PLUNDER`, `PVP_COIN_BPS`, `PLUNDER_CROWN_BPS`.

`hub.concludeBattle` picks PvP (loser is a player) vs PvE (NPC raider) automatically.
Invariants stay green: the three new reasons classify as TRANSFER / FAUCET / SINK.

## Result (25k-tick sim, 6 producers + 6 traders + 3 raiders)
- PvE plunder faucet: **6,270,000 → ~2,080** (essentially eliminated as a driver).
- Money-supply drift: **~21,600/epoch → ~4,250/epoch (5x lower)**.
- Combat is now NEUTRAL: drift with raiders (4,225/epoch) == drift with raiders=0
  (4,250/epoch). The residual drift is 100% the trade loop (demand premium > trade sinks),
  which this slice was scoped NOT to touch.

So combat no longer inflates the economy. Full flattening needs a trade-side tune
(the demand premium vs demand-levy/extract/upkeep), a separate slice.
