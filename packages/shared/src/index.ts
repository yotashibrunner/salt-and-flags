// ============================================================================
// Salt & Flags — shared types & data (server + client both import this)
// ============================================================================

// ---------- Commodities & production chains ----------
export type Tier = "raw" | "refined" | "finished";

export interface Commodity {
  id: string;
  name: string;
  tier: Tier;
}

export const COMMODITIES: Commodity[] = [
  { id: "hemp",     name: "Hemp",      tier: "raw" },
  { id: "wood",     name: "Wood",      tier: "raw" },
  { id: "ironore",  name: "Iron Ore",  tier: "raw" },
  { id: "sugar",    name: "Sugar Cane",tier: "raw" },
  { id: "cloth",    name: "Cloth",     tier: "refined" },
  { id: "iron",     name: "Iron",      tier: "refined" },
  { id: "planks",   name: "Planks",    tier: "refined" },
  { id: "rum",      name: "Rum",       tier: "finished" },
  { id: "sailcloth",name: "Sailcloth", tier: "finished" },
  { id: "shot",     name: "Cannon Shot",tier: "finished" },
];

// recipe: inputs + labor -> outputs, run at a player-owned stall
export interface Recipe {
  id: string;
  stall: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  labor: number;
}

export const RECIPES: Recipe[] = [
  { id: "distill", stall: "Distillery", inputs: { sugar: 3 },  outputs: { rum: 2 },       labor: 4 },
  { id: "weave",   stall: "Weavery",    inputs: { hemp: 3 },   outputs: { cloth: 2 },     labor: 3 },
  { id: "tailor",  stall: "Sail Loft",  inputs: { cloth: 2 },  outputs: { sailcloth: 1 }, labor: 5 },
  { id: "saw",     stall: "Sawmill",    inputs: { wood: 3 },   outputs: { planks: 2 },    labor: 3 },
  { id: "smelt",   stall: "Foundry",    inputs: { ironore: 3 },outputs: { iron: 2 },      labor: 4 },
  { id: "cast",    stall: "Ironworks",  inputs: { iron: 2 },   outputs: { shot: 3 },      labor: 6 },
];

// ---------- Ships ----------
export interface ShipClass {
  id: string;
  name: string;
  hull: number;
  sail: number;
  cargo: number;
  gunsPerSide: number;
  crewSlots: number;
  soloable: boolean;
}

export const SHIP_CLASSES: ShipClass[] = [
  { id: "sloop",   name: "Sloop",   hull: 16, sail: 10, cargo: 60,  gunsPerSide: 2, crewSlots: 3,  soloable: true  },
  { id: "brig",    name: "Brigantine", hull: 28, sail: 14, cargo: 140, gunsPerSide: 4, crewSlots: 6,  soloable: false },
  { id: "frigate", name: "Frigate", hull: 44, sail: 18, cargo: 220, gunsPerSide: 6, crewSlots: 10, soloable: false },
  { id: "galleon", name: "Galleon", hull: 70, sail: 16, cargo: 400, gunsPerSide: 9, crewSlots: 16, soloable: false },
];

// ---------- World map ----------
export interface RegionTheme {
  id: string;
  name: string;
  color: string;          // chart tint
  produces: string[];     // raw/refined commodity ids abundant here
  demands: string[];      // finished goods that fetch a premium here
  danger: number;         // 0..1, drives weather/encounter frequency
}

export const REGION_THEMES: RegionTheme[] = [
  { id: "tropic",  name: "The Tropic Reach", color: "#2f8a6a", produces: ["sugar", "wood"],    demands: ["shot", "iron"],     danger: 0.2 },
  { id: "iron",    name: "The Iron Coast",   color: "#8a5a3a", produces: ["ironore", "iron"],  demands: ["rum", "sailcloth"], danger: 0.4 },
  { id: "hemp",    name: "The Hemp Flats",   color: "#7a7a3a", produces: ["hemp", "cloth"],    demands: ["rum", "shot"],      danger: 0.3 },
  { id: "timber",  name: "The Timberlands",  color: "#4a6a4a", produces: ["wood", "planks"],   demands: ["iron", "rum"],      danger: 0.3 },
  { id: "north",   name: "The Frozen North", color: "#5a7a8a", produces: ["ironore"],          demands: ["rum", "cloth", "sailcloth"], danger: 0.6 },
  { id: "storm",   name: "The Storm Expanse",color: "#3a4a5a", produces: ["sugar", "hemp"],    demands: ["shot", "sailcloth"],danger: 0.85 },
];

export interface Island {
  id: string;
  name: string;
  x: number;
  y: number;
  size: number;            // 1..3 (hamlet..port city)
  region: string;          // RegionTheme.id
  produces: string[];
  demands: string[];
  controllingFlag: string | null;
  taxRate: number;
}

export interface Lane {
  a: string;
  b: string;
  dist: number;
}

export interface Region {
  id: string;
  theme: string;
  name: string;
  cx: number;
  cy: number;
}

export interface World {
  seed: number;
  width: number;
  height: number;
  regions: Region[];
  islands: Island[];
  lanes: Lane[];
}
