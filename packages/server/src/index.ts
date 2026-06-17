import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
// colyseus ships as CommonJS; under Node ESM its named exports aren't detected,
// so take the runtime value off the default import.
import colyseusPkg from "colyseus";
const { Server } = colyseusPkg;
import { WebSocketTransport } from "@colyseus/ws-transport";
import { generateWorld } from "./world/worldgen.js";
import { setWorld } from "./world/registry.js";
import { PillageRoom } from "./rooms/PillageRoom.js";
import { MarketRoom } from "./rooms/MarketRoom.js";
import { MarketHub, setHub } from "./economy/hub.js";
import { PgStore } from "./economy/store.js";
import { hasDb, pool } from "./db.js";

const PORT = Number(process.env.PORT ?? 2567);
const SEED = Number(process.env.WORLD_SEED ?? 18327);

// Generate the big map once at boot and cache it.
const world = generateWorld(SEED);
setWorld(world); // index islands + the lane graph so MarketRoom can validate, price, and route voyages
console.log(`world ${SEED}: ${world.islands.length} islands, ${world.lanes.length} lanes, ${world.regions.length} regions`);

// One shared market engine for the whole server. Persisted to Postgres when a DB
// is configured (replayed on boot); pure in-memory otherwise.
const hub = new MarketHub(pool ? new PgStore(pool) : undefined);
await hub.init();
setHub(hub);
console.log(`market: ${hasDb ? "persistent (postgres)" : "in-memory only (no DATABASE_URL)"}`);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, db: hasDb }));
app.get("/world", (_req, res) => res.json(world));

const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define("pillage", PillageRoom);
// One market room instance per island, all sharing the hub's authoritative engine.
gameServer.define("market", MarketRoom).filterBy(["island"]);

server.listen(PORT, () => console.log(`Salt & Flags server on :${PORT}  (GET /world)`));
