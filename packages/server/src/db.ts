// Postgres + Redis connectors. Both optional: if env is unset, the server still
// boots and serves the world map (so you can demo the map with no databases).
import pg from "pg";
import Redis from "ioredis";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

export const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : null;

export const hasDb = !!pool;

export async function migrate() {
  if (!pool) { console.error("DATABASE_URL not set"); process.exit(1); }
  const dir = join(__dirname, "../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await pool.query(readFileSync(join(dir, f), "utf8"));
    console.log(`migration ${f} applied`);
  }
  await pool.end();
}

if (process.argv[2] === "migrate") migrate();
