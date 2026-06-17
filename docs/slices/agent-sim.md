# Slice: economy agent simulation (§11 — the dynamics half of the play tester)

Status: **implemented**. Completes the §11 economy play tester: the fuzzer proves
*correctness* (invariants hold under random ops); this proves *dynamics* (a population
of economically-motivated bots produces a stable, non-deadlocked economy over a long
horizon, now that faucets and sinks both exist).

## What it is
`sim.mjs` runs a deterministic (seeded RNG, fixed clock) simulation over a shared
`Exchange` + island `Market` views:
- **Producers** distill starting sugar into rum and REST it as a sell (price-makers,
  undercutting the NPC ask) — the renewable supply side. Pay build/listing fees + upkeep.
- **Arbitrage traders** buy rum cheap at `harbor`, sail to `reach` (which DEMANDS rum),
  and sell it into the demand burn-bid — the renewable demand side. Pay fees + tax + upkeep.

Two deliverables:
- **Report** — `npm run sim` prints a per-epoch metrics table: player money supply,
  crown (burned) balance, flag treasuries, rum price, wealth Gini, and trade volume.
- **Health test** — `sim.test.mjs` asserts the economy stays healthy over 40 epochs:
  invariants hold every epoch, PoE conserved, **no deadlock** (trade volume > 0 through
  the second half), not collapsed and not runaway (`0 < playerPoE < minted`), prices
  finite and sane, Gini not pathological, and the crown sink actually drains. Plus a
  determinism test (same seed → identical history).

## What the sim immediately surfaced (its first real findings)
Building it was itself the test — two failure modes appeared and were diagnosed:
1. **Deadlock when both sides take liquidity.** With producers and traders both *hitting*
   the finite NPC seed book, trade stopped once it was consumed. Fix (realistic):
   producers REST asks (become price-makers) so traders have a renewable supply.
2. **Money-supply imbalance.** With a standing demand buyer, trade is stable (volume flat,
   prices flat at the demand price, Gini ~0.17) — but **player money inflates**: the
   demand faucet (PoE paid per rum bought from the reserve) far outweighs the sinks
   (1% fees + modest upkeep). Conversely, refilling demand too slowly *collapses* the
   economy to zero via upkeep. The healthy middle is narrow.

The headline tuning insight: **true monetary balance needs a cost on the supply side.**
Producers here get free granted sugar (a stand-in until raw extraction exists), so every
rum sold to demand is near-pure new money. A future slice that makes raws cost PoE (a
sink) — or scales upkeep with wealth — is what closes the gap. The health test therefore
guards correctness/health properties, not a perfectly flat money supply.

## Follow-on
1. **Raw extraction with a cost** (or wealth-scaled upkeep) — the lever the sim shows is
   needed to balance the demand faucet; re-run the sim to confirm a flat money supply.
2. Richer agents (raiders/pillage faucet, multiple demand goods) once combat is wired.
3. Promote the metrics to a small dashboard / CSV for tuning sweeps.
