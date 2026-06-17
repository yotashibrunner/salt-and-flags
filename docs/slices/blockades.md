# Slice: blockades — contested island control (the last unused schema table)

Status: **implemented**. Adds `blockades` (the schema's final unused table) as a
labor-driven tug-of-war for an island — a contested alternative to the instant `seize`,
tying crew effort + the flag economy together.

## Mechanic
- An attacking flag **declares** a blockade on an island it doesn't control (a PoE sink →
  warchest, `BLOCKADE_COST` 200, reason `blockade`). The control meter starts at 50.
- Pledged attackers **push** (meter +10), the controller's defenders **defend** (meter
  −10). Each push spends `BLOCKADE_LABOR` (8) — an attrition contest gated by labor regen,
  not money. Resolves on the meter: ≥100 the attacker seizes the island (royalties reroute
  via the `islandFlag` override, like a seize); ≤0 the defenders hold and it lifts. No
  timer needed.
- One blockade per island; gated on pledge + not-already-controller. Unclaimed islands
  have no defenders (attacker just pushes to 100). Recorded as `blockade_declare` /
  `blockade_push` intents — meter + flip rebuild on replay (labor ts on each push).

## Server + client
MarketRoom: `blockade:declare` / `blockade:push` / `blockade:defend` messages + the meter
in room state (`blockadeMeter`/`Attacker`/`Defender`, public). Market client: a Blockade
panel — declare for a pledged flag, or push/defend with the live meter when one's active.

## Invariants
The declaration fee is a `blockade` SINK (added to the taxonomy → warchest, a terminal
sink). Pushes move only the meter + labor (no ledger), so conservation is untouched.

## Tests
`blockade.test.mjs`: a full tug-of-war that flips the island (labor-gated, with pledge
gating + a defender push); declaration gating (pledged / not-already-held / one-at-a-time);
and a replay test (in-progress meter + warchest rebuild identically). 77 server tests pass;
server + client tsc + vite build clean.

## Follow-on
- Tie pushes to combat: a won PillageRoom battle near the island pushes the meter (instead
  of / in addition to the labor grind) — the hub.concludeBattle hook is the seam.
- A scheduled window (`blockades.scheduled_at`) for timed contests rather than pure meter.
