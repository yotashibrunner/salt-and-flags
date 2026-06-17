# Slice: client UI catch-up (fleet, voyages, cargo, sites, shipyard, salvage, raid)

Status: **implemented**. The market client predated everything since located-inventory;
this brings it up to the server's full surface so the whole loop is playable in a browser.

## Added to the Market panel (`market.html` + `market.ts`)
- **Fleet & Voyages**: each ship with class, hull/maxHull, and location — "docked here",
  "docked at X", or "⛵ at sea → Y". Docked-here ships get **Load/Unload** (the selected
  commodity × the qty input) and a **Sail** dropdown of lane-connected islands (built from
  `/world` lanes) + Sail button. Hold contents + fill/cap shown.
- **Shipyard**: a Buy button per ship class at its price (disabled when unaffordable).
- **Resource Sites**: for each raw the island produces (server now sends `raws`), Build
  site / Extract.
- **Salvage**: a button per commodity in any wreck washed up here.
- **Go raiding**: sends `raid`; on `raid:ready` opens `pillage.html?ship=…&island=…`.

## Battle screen (`pillage.ts`)
Arriving with `?ship=&island=` now **creates a private** PillageRoom for that real ship
(the server spawns an NPC raider + persists the outcome via `hub.concludeBattle`); without
the params it joins the standalone sandbox as before.

## Interfaces synced
`Balances` (sites/wreck/ships), `ShipBalance` (dockedAt/voyage/hull/hold), and `Hello`
(shipCargo/shipPrice/raws) now match the server. MarketRoom's hello sends `raws`.

## Verification
Client `tsc --noEmit` clean and `vite build` succeeds (market 9.4 kB). Browser play is
manual (no headless UI test); server stays 72 unit tests green. The order book, balances,
stalls, and flag panels were already present and are unchanged.

## Follow-on
- Render ships/voyages on the world chart (`main.ts`) — positions + at-sea tracks.
- A proper battle UI polish + reconnect to an in-progress voyage/battle.
- Headless e2e for the new market controls (the existing `market.e2e.mjs` could extend).
