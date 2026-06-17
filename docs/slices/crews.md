# Slice: crews — player groups with a shared coffer

Status: **implemented**. Adds the cooperative-multiplayer layer (the schema's unused
`crews.coffers`): players form ad-hoc crews and pool PoE in a shared coffer for joint
ventures (e.g. saving for a galleon together).

## Mechanic
- A crew is `{ name, captain, members }`; its coffer is a `crew:{id}` account (reuses the
  located-account machinery). Distinct from flags — flags are pre-set factions fed by
  territory royalties; a crew is a small party with an explicit shared purse.
- `formCrew(player, name)` → captain + first member, creates the coffer. `joinCrew`.
- `crewDeposit(player, crew, amount)` — any member; `crewWithdraw` — captain only. Both
  are conserving transfers player↔coffer (`crew_deposit` / `crew_withdraw`), so total PoE
  is unchanged and the ledger stays zero-sum.
- `balancesOf().crews` lists the player's crews (name, coffer, members, captain). Recorded
  as `crew_form` / `crew_join` / `crew_deposit` / `crew_withdraw` intents; rebuilt on replay.

## Server + client
MarketRoom: `crew:form` / `crew:join` / `crew:deposit` / `crew:withdraw` messages. Market
client: a Crews panel — form by name, join by id, contribute (any member) / withdraw
(captain), coffer + roster shown.

## Invariants
`crew_deposit` / `crew_withdraw` added to the transfer reasons; the coffer is an ordinary
(non-system, non-terminal) account, so `poe_accounted` / `no_negative` / `reason_classified`
cover it with no special-casing.

## Tests
`crew.test.mjs`: pooling conserves PoE + zero-sum ledger; member/captain permission gates;
coffer-short guard; crews surface in balances; and a replay test (coffer + membership
rebuild identically). 74 server tests pass; server + client tsc + vite build clean.

## Follow-on
- Crew-owned ships / shared holds; direct a battle's plunder into the crew coffer.
- A crew can fly a flag (the schema's `crews.flag_id`) — tie crews to the faction system.
