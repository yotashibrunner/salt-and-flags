# Salt & Flags — skeleton

Turn-based, player-economy pirate MMO. Gritty Age-of-Piracy feel. No microtransactions.
This is the **Phase 0 scaffold** from the build bible: a TypeScript monorepo with an
authoritative server, a persistent schema, the economy matching engine, a pillage room
state machine, and a **big procedurally-generated world map** with a client that renders it.

## Layout

```
salt-and-flags/
  packages/
    shared/   # types & data shared by server + client (commodities, ships, map)
    server/   # Colyseus + Express authoritative server
      src/world/worldgen.ts      # BIG MAP: ~70 islands across 24 ocean regions
      src/economy/matchingEngine.ts  # order-book engine (the economy core)
      src/rooms/PillageRoom.ts   # RIG -> PLOT -> RESOLVE turn machine (stub)
      migrations/0001_init.sql   # full schema
    client/   # PWA stub that fetches /world and renders the chart (pan/zoom)
  docker-compose.yml             # local Postgres + Redis
```

## Run it (map demo works with no database)

```bash
npm install

# server (serves the generated world at GET /world)
npm run dev:server          # http://localhost:2567/world , /health

# client (renders the big map; drag to pan, scroll/pinch to zoom)
npm run dev:client          # http://localhost:5173
```

For the economy/persistence work, bring up the databases and migrate:

```bash
docker compose up -d        # postgres:5432, redis:6379
npm run migrate
```

## Where to go next (drive Claude Code one slice at a time)
1. Wire `matchingEngine` to Postgres (`orders`, `trades`, `ledger`) — write tests first.
2. Flesh out `PillageRoom` resolution (deterministic movement + line-of-fire).
3. Replace the map stub renderer with the gritty chart UI from the bible.
4. Auth + character + port free-roam.

See `salt-and-flags-build-bible.md` for the full spec.
