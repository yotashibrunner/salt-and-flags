// In-memory index of the generated world's islands, set once at boot from the
// cached world. The MarketRoom reads it to validate island ids and to seed each
// island's book from its produces/demands. Single-process, in-memory only.
import type { Island, World } from "@salt/shared";
import { REGION_THEMES } from "@salt/shared";

export interface IslandInfo {
  id: string;
  name: string;
  region: string;
  produces: string[];
  demands: string[];
  controllingFlag: string | null;
  taxRate: number;
}

let index = new Map<string, IslandInfo>();
let lanes = new Map<string, Map<string, number>>(); // island -> (neighbor -> lane distance)
const dangerByRegion = new Map(REGION_THEMES.map((t) => [t.id, t.danger]));

export function setIslands(islands: Island[]) {
  index = new Map(
    islands.map((i) => [i.id, {
      id: i.id, name: i.name, region: i.region,
      produces: i.produces, demands: i.demands,
      controllingFlag: i.controllingFlag, taxRate: i.taxRate,
    }]),
  );
}

// Index the whole world: islands + the lane graph (for sailing — you may only sail to a
// lane-connected island, and the lane's distance sets the voyage time).
export function setWorld(world: World) {
  setIslands(world.islands);
  lanes = new Map();
  for (const l of world.lanes) {
    if (!lanes.has(l.a)) lanes.set(l.a, new Map());
    if (!lanes.has(l.b)) lanes.set(l.b, new Map());
    lanes.get(l.a)!.set(l.b, l.dist);
    lanes.get(l.b)!.set(l.a, l.dist);
  }
}

export function getIsland(id: string): IslandInfo | undefined {
  return index.get(id);
}

export function islandList(): IslandInfo[] {
  return [...index.values()];
}

// Lane distance between two islands, or undefined if they aren't directly connected.
export function laneDist(a: string, b: string): number | undefined {
  return lanes.get(a)?.get(b);
}

// A route's danger (0..1), from the island's region theme. Used to weight transit encounters.
export function islandDanger(id: string): number {
  const info = index.get(id);
  return (info && dangerByRegion.get(info.region)) ?? 0.2;
}
