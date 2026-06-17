import { test } from "node:test";
import assert from "node:assert/strict";
import { runSim } from "./sim.mjs";

// The agent sim is the DYNAMICS guardrail (the fuzzer is the correctness one). It runs
// a producer/trader population for a long horizon and asserts the economy stays
// HEALTHY — distinguishing a working economy from the failure modes the sim itself
// surfaced while building it (deadlock-to-zero, runaway-to-ceiling, price blow-up). It
// deliberately does NOT assert a perfectly balanced money supply: with today's
// mechanics the demand faucet outweighs the sinks (mild inflation), which the report
// shows and which a future raw-purchase/upkeep tuning slice addresses.
test("economy stays healthy over a long agent-driven run", () => {
  const { history, ex, violation } = runSim({ epochs: 40, ticksPerEpoch: 40, producers: 5, traders: 5, seed: 20260617 });
  const last = history.at(-1);
  const secondHalf = history.slice(history.length / 2);

  // 1. correctness: every invariant held at every epoch under agent behavior
  assert.equal(violation, null, violation && `invariant ${violation.name} broke at epoch ${violation.epoch}: ${violation.detail}`);
  assert.equal(ex.totalPoe(), ex.minted, "PoE conserved (totalPoe === minted)");

  // 2. no deadlock: the market keeps trading right through the second half
  for (const h of secondHalf) assert.ok(h.volume > 0, `deadlock: epoch ${h.epoch} had no trades`);

  // 3. not collapsed and not runaway: players hold money, bounded by the faucet ceiling
  assert.ok(last.playerPoE > 1000, `economy collapsed: players hold only ${last.playerPoE}`);
  assert.ok(last.playerPoE < ex.minted, "player money supply stays under the minted ceiling");

  // 4. prices stay finite and sane (no blow-up, no collapse to zero)
  assert.ok(last.rumPx >= 1 && last.rumPx <= 24 * 10, `rum price out of range: ${last.rumPx}`);

  // 5. wealth not pathologically concentrated (a single whale + everyone-broke)
  assert.ok(last.gini >= 0 && last.gini < 0.9, `wealth concentration unhealthy: gini ${last.gini}`);

  // 6. the sinks actually drain: the crown's terminal balance grew over the run
  assert.ok(last.crown > history[3].crown, "crown sink did not drain over the run");
});

test("the sim is deterministic: same seed -> same history", () => {
  const a = runSim({ epochs: 8, ticksPerEpoch: 12, producers: 3, traders: 3, seed: 99 });
  const b = runSim({ epochs: 8, ticksPerEpoch: 12, producers: 3, traders: 3, seed: 99 });
  assert.deepEqual(a.history, b.history, "a seeded run must reproduce exactly (replayable)");
});
