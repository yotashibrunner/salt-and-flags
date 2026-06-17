# Slice: interactive battles (encounters → real fights → economy outcomes)

Status: **implemented** (server side). Connects the fully-built turn-based battle engine
(`battle.mjs`, deterministic + tested) to the economy: a battle now fights a REAL enemy
ship and its outcome moves real PoE/cargo/ships.

## What's wired
- **Raider ships**: `Market.spawnRaider(cls, dockedAt, cargo)` / `hub.spawnRaider(island)`
  create an NPC enemy ship (owner `RAIDER`, a system account) with a minted cargo hold,
  recorded as a `raider` intent. Its cargo becomes salvage when the ship is sunk.
- **PillageRoom** now: seeds the player's real hull from `ex`; if given a `playerShipId`
  + `island` but no opponent, it spawns a raider to fight; and on battle end routes the
  whole outcome through `hub.concludeBattle`.
- **`hub.concludeBattle(winner, …)`** (the one place battle economics live): a win pays
  plunder to each crew member and SINKS the enemy raider (cargo → a salvageable wreck at
  the island) while persisting the player's damage; a loss sinks the player ship
  (loss-on-sinking). All conserving + persisted (reuses `award` / `resolveShip` /
  `applyScuttle`).
- **Entry point**: `MarketRoom`'s `raid` message — if the captain has a ship docked here,
  it returns `raid:ready {playerShipId, island}` for the client to open a PillageRoom.

So the loop is reachable: sail in → `raid` → fight a raider → win (plunder + salvage its
wreck) or lose (your ship sunk, partial cargo washes up).

## Testable vs manual
The economic substance is unit-tested (`battle-economy.test.mjs`): raider spawns as a real
ship with cargo; a win sinks it into a salvageable wreck + pays plunder; a loss sinks the
player ship; and a restart replays raider-spawn-then-defeat identically. The turn-by-turn
PillageRoom + `hub.concludeBattle` are TypeScript Colyseus glue (typecheck-only, like all
rooms) and need a live client to play — the client battle screen is the next slice.

## Known edges (noted, deferred)
- A raider whose battle is abandoned (client disconnects mid-fight) lingers with its
  minted cargo (a small unsalvaged-goods leak) — a room-dispose cleanup is a later polish.
- Plunder is still a flat `PLUNDER_BOUNTY`; scaling it to the enemy's cargo value is future tuning.

## Tests
`battle-economy.test.mjs` (4): raider spawn; win → enemy wreck + plunder + salvage; loss →
player sunk; replay. 72 tests pass; tsc clean.
