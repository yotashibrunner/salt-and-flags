# Slice: live world map (control overlay, blockades, click-to-trade)

Status: **implemented**. Turns the static chart stub into a live strategic overview that
reflects the running game, and makes it the entry point into the market.

## Server
- `MarketHub.liveControl()` returns the overlay the static `/world` can't: islands whose
  control has CHANGED from their initial flag (conquest / blockade flips, from
  `ex.islandFlag`) and any active blockades with their meters (`ex.blockades`).
- `GET /world/state` serves it.

## Map (`main.ts`)
- Polls `/world/state` every 4s and overlays it on the cached `/world` geometry: each
  island is tinted by its CURRENT flag (live override ?? initial ?? region), contested
  islands get a dashed red ring + `⚔ <attacker> <meter>%`, and the HUD shows how many
  islands are under blockade.
- **Click an island → opens `market.html?island=<id>`** (world coords via the inverse draw
  transform; a press that moves <5px counts as a click, not a pan). The chart is now the
  navigation hub into trading.

## Verification
Client `tsc` + `vite build` clean; server `tsc` clean, 78 tests green. The map is visual
(manual to eyeball), but the data path (`liveControl` → `/world/state` → overlay) is
straightforward and the geometry/pan/zoom were already working.

## Follow-on
- Render the player's own fleet + voyages on the chart (needs the map to hold live
  per-player balances — e.g. a thin world room, or reuse the market connection).
- Animated voyage tracks; richer "gritty chart" art pass (parchment/ink) from the bible.
