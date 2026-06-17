# Slice: captain names (human identity over the crypto id)

Status: **implemented**. Adds the schema's `players.name` as a real feature: a unique,
claimable, renameable display name layered on the proven player id — so captains read as
"Blackbeard", not `p_9f3a…`.

## Mechanic
- `setName(player, name)` claims a name (trimmed, ≤ `NAME_MAX` 24, non-empty), **unique**
  across players (`ex.nameOwners` enforces one owner per name). Renaming frees the old
  name for others; re-claiming your own current name is idempotent. No PoE, so it never
  touches the ledger. Recorded as a `name` intent; the name + uniqueness map rebuild on
  replay. `nameOf(player)` resolves it; `balancesOf().name` surfaces it.

## Wiring
- MarketRoom `setName` message; hello/balances carry the name. Market client: a "captain
  name" input in the header; the "you:" label shows the name once set (else the short id).

## Tests
`name.test.mjs`: claim + uniqueness rejection + empty-name guard; rename frees the old
name (and idempotent self-claim); and a restart test (current name replays, freed name is
re-claimable on the rebuilt engine). 84 server tests pass; server + client tsc + vite build clean.

## Follow-on
- Resolve names in rosters (crew members, flag rolls, trade history) — needs the client to
  fetch other players' names (a lookup endpoint or echo in those payloads).
- Multiple characters per player + appearance (`characters.appearance`) on top of this id.
