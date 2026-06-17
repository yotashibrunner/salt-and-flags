# Slice: drain the demand premium (tame the money supply)

Status: **implemented**. The last balance lever the agent sim named: NPC demand pays a
premium over production cost, and that premium was the residual new money inflating
player wealth. This skims it back as a sink.

## Mechanic: demand levy
A **demand levy** is skimmed from the proceeds of every sale into the demand burn-bid
(when the buyer is the `demand` reserve), routed as a **SINK** (split 60% crown / 40%
flag) via the shared `applyDrain`. It's a per-island rate (`demandLevyBps`, default 0 so
unit tests are untouched; the hub sets it to `DEMAND_LEVY_BPS` = 2500 = 25% live), rides
on the `place` intent (`levy`), and runs in both the live path and replay. `applyDrain`
clamps to the seller's funds, so a levy can never push a trader negative.

Mirrors the listing-fee pattern exactly (gated rate, recorded per-intent, sink split).

## What the sim now shows — the balance story, end to end
`npm run sim`, player money supply over 40 epochs, stacking the slices:

| Config | start → end | growth | Gini |
|---|---|---|---|
| No sinks | 15k → 229k | ~15× | 0.17 |
| + raw extraction (producer-side sink) | 14k → 108k | ~8× | 0.42 |
| **+ demand levy 25% (this slice)** | **12k → 47k** | **~4×** | **0.19** |

Trade volume stays flat (~160/epoch, no deadlock), prices stay pinned at 31,
conservation + every invariant hold throughout. The levy also *lowers* Gini (0.42 → 0.19):
it taxes the rich demand-sellers (traders), so wealth stops concentrating.

## The honest end state
The money supply now grows **slowly and roughly linearly** rather than running away —
which is the right target, not a perfectly flat line. A flat supply is structurally
impossible while agents profit: NPC demand injects more than goods cost to make, so the
surplus is *either* player profit (progression — desirable) *or* fully taxed away (no
reason to play). 25% leaves traders a workable margin while draining the bulk of the
premium. The knob (`DEMAND_LEVY_BPS`) is where future tuning lives; the sim is the dial's
readout.

## Tests
`demand.test.mjs` gains a levy test (skim split crown/flag, seller kept proceeds minus
levy). The sim health test (`sim.test.mjs`) runs with the levy on and still passes (no
deadlock, bounded, sane prices, sinks drain). 58 tests pass; tsc clean.

## Follow-on
- Shipyard (buy/replace ships → lasting loss-on-sinking stakes).
- Real sailing (replace the `move` stub) + wiring real ship ids into PillageRoom.
- Tuning sweeps: the sim is now a dial readout — vary fee/levy/upkeep to target a chosen
  growth rate.
