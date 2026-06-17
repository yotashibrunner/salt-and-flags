# Slice: proven identity (stateless crypto, no more wallet impersonation)

Status: **implemented**. Closes the audit/code-flagged gap: identity was by *assertion*
(the client sent any `playerId` it liked over localStorage), so anyone could claim — and
spend from — another captain's wallet. Now a player id is *derived* from a secret only
that captain holds.

## Mechanic (stateless, no token store)
- The client keeps a long random **secret** in localStorage and presents it on every join.
- The server derives the public id as `playerIdFromSecret(secret)` = `p_` + first 24 hex of
  `SHA-256("salt-and-flags:" + secret)` (Web Crypto — `crypto.subtle`, present in Node 20+
  AND browsers, so server and client agree). `onAuth` (both MarketRoom + PillageRoom) now
  requires `secret` and returns the derived id; the asserted-`playerId` path is gone.
- You can't claim another id without its secret (that's inverting SHA-256), so wallets
  can't be hijacked. No server-side token table needed — the id *is* the commitment.
  (Sybil — minting fresh secrets — remains inherent to anonymous play; this closes
  impersonation, not anonymity.)

## Wiring
- Server: `identity.mjs` (+ `.d.mts`); both rooms' `onAuth` are now async and secret-based.
- Client: `identity.ts` (`getIdentity()` — secret in localStorage, migrates a legacy
  `salt.playerId` by adopting it as the secret); `market.ts` + `pillage.ts` send `secret`.
- e2e harnesses send `secret` instead of `playerId`.

## Tests
`identity.test.mjs`: deterministic (same secret → same id, well-formed), distinct ids for
distinct secrets, and that presenting the id as a secret doesn't reproduce it. 81 server
tests pass; server + client tsc + vite build clean.

## Follow-on
- True accounts/characters (the schema's `players`/`characters`): display names, multiple
  characters per player, server-side registry — building on this id as the key.
- Signed-message auth (sign a nonce with the secret) so the secret never crosses the wire.
