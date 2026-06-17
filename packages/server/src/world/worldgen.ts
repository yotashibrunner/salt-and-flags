// ============================================================================
// BIG MAP — deterministic world generator
// 24 ocean regions in a 6x4 grid, each with 2-5 islands, plus a sea-lane graph.
// Same seed -> same world. ~70 islands.
// ============================================================================
import {
  World, Region, Island, Lane, REGION_THEMES, RegionTheme,
} from "@salt/shared";

// --- seeded RNG (mulberry32) ---
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIX = ["Salt", "Black", "Gull", "Iron", "Coral", "Storm", "Wreck", "Tortuga",
  "Dead", "Bone", "Rum", "Cutlass", "Maroon", "Skull", "Tide", "Brine", "Shoal",
  "Fog", "Kraken", "Gallows", "Mutiny", "Verd", "Ash", "Pearl"];
const SUFFIX = ["haven", "rock", "spit", "cay", "reach", "hollow", "point", "shoal",
  "bar", "isle", "berth", "landing", "wharf", "deep", "bay", "head", "cove", "anchor"];

function pick<T>(r: () => number, arr: T[]): T { return arr[Math.floor(r() * arr.length)]; }

export function generateWorld(seed = 18327): World {
  const r = rng(seed);
  const COLS = 6, ROWS = 4;
  const REGION_W = 1000, REGION_H = 1000;
  const width = COLS * REGION_W, height = ROWS * REGION_H;

  const regions: Region[] = [];
  const islands: Island[] = [];
  const usedNames = new Set<string>();

  let flagPool = ["wardens", "gulls", "iron", "sash", "crown", null, null, null, null];

  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const theme: RegionTheme = REGION_THEMES[Math.floor(r() * REGION_THEMES.length)];
      const rid = `r${gx}_${gy}`;
      const cx = gx * REGION_W + REGION_W / 2;
      const cy = gy * REGION_H + REGION_H / 2;
      regions.push({ id: rid, theme: theme.id, name: theme.name, cx, cy });

      const count = 2 + Math.floor(r() * 4); // 2..5
      for (let i = 0; i < count; i++) {
        let name = "";
        do { name = pick(r, PREFIX) + " " + pick(r, SUFFIX); } while (usedNames.has(name));
        usedNames.add(name);

        // jitter island within its region cell, keep off the edges
        const x = gx * REGION_W + 120 + r() * (REGION_W - 240);
        const y = gy * REGION_H + 120 + r() * (REGION_H - 240);
        const size = 1 + Math.floor(r() * 3);
        const flag = pick(r, flagPool);

        islands.push({
          id: `${rid}_i${i}`,
          name, x: Math.round(x), y: Math.round(y), size,
          region: theme.id,
          produces: theme.produces.slice(),
          demands: theme.demands.slice(),
          controllingFlag: flag,
          taxRate: flag ? +(0.02 + r() * 0.06).toFixed(3) : 0,
        });
      }
    }
  }

  // --- sea lanes: connect each island to its nearest few neighbours ---
  const lanes: Lane[] = [];
  const seen = new Set<string>();
  const MAX_LANE = 700; // don't draw lanes across the whole ocean
  for (const a of islands) {
    const near = islands
      .filter((b) => b.id !== a.id)
      .map((b) => ({ b, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 3);
    for (const { b, d } of near) {
      if (d > MAX_LANE) continue;
      const key = [a.id, b.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      lanes.push({ a: a.id, b: b.id, dist: Math.round(d) });
    }
  }

  return { seed, width, height, regions, islands, lanes };
}
