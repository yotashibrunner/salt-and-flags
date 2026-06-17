// In-memory index of the generated world's islands, set once at boot from the
// cached world. The MarketRoom reads it to validate island ids and to seed each
// island's book from its produces/demands. Single-process, in-memory only.
import type { Island } from "@salt/shared";

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

export function setIslands(islands: Island[]) {
  index = new Map(
    islands.map((i) => [i.id, {
      id: i.id, name: i.name, region: i.region,
      produces: i.produces, demands: i.demands,
      controllingFlag: i.controllingFlag, taxRate: i.taxRate,
    }]),
  );
}

export function getIsland(id: string): IslandInfo | undefined {
  return index.get(id);
}

export function islandList(): IslandInfo[] {
  return [...index.values()];
}
