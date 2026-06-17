// Type declarations for market.mjs (the per-island authoritative market core).
import type { Exchange, Order, Side, Depth } from "./economy.mjs";

export const MARKET_COMMODITIES: string[];
export const BASE_PRICE: Record<string, number>;
export const NEW_PLAYER_POE: number;
export const PRODUCE_FACTOR: number;
export const DEMAND_FACTOR: number;
export const LABOR_START: number;
export const LABOR_MAX: number;
export const LABOR_REGEN_MS: number;
export const STALL_COST: number;
export const UNCLAIMED_TREASURY: string;
export const CONQUEST_COST: number;
export const WARCHEST: string;
export const FLAGS: string[];
export const BOUNTY: string;
export const BOUNTY_RESERVE: number;
export const SHIP_CARGO: Record<string, number>;
export const DEMAND: string;
export const DEMAND_RESERVE: number;
export const DEMAND_CAP: number;
export const DEMAND_LEVY_BPS: number;
export const FINISHED: Set<string>;
export const SHIP_HULL: Record<string, number>;
export const REPAIR_PER_HULL: number;
export const SHIP_PRICE: Record<string, number>;
export const SHIP_SAIL: Record<string, number>;
export const TRAVEL_MS_PER_DIST: number;
export function voyageEncounter(shipId: string, departAt: number, danger: number, hull: number, maxHull: number): { hit: boolean; sunk: boolean; hull: number; dmg: number };
export const CROWN: string;
export const SINK_BURN_BPS: number;
export const LISTING_FEE_BPS: number;
export const UPKEEP_PERIOD_MS: number;
export const UPKEEP_STALL: number;
export const UPKEEP_SHIP: number;
export const UPKEEP_SITE: number;
export const RAWS: Set<string>;
export const SITE_COST: number;
export const EXTRACT_LABOR: number;
export const EXTRACT_YIELD: number;
export const EXTRACT_FEE: number;
export function isSystemOwner(id: string): boolean;

export interface Recipe {
  id: string;
  stall: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  labor: number;
}
export const RECIPES: Recipe[];

// --- persistence shapes ---
export type Intent =
  | { seq: number; kind: "account"; owner: string; poe: number; ts: number }
  | { seq: number; kind: "grant"; owner: string; island: string; inv: Record<string, number> }
  | { seq: number; kind: "onboard"; owner: string; island: string; inv: Record<string, number>; cls: string; ship: string }
  | { seq: number; kind: "buyship"; owner: string; cls: string; ship: string; price: number; flag: string | null; island: string }
  | { seq: number; kind: "place"; owner: string; island: string; commodity: string; side: Side; price: number; qty: number; flag: string | null; rate: number; fee: number; levy: number }
  | { seq: number; kind: "cancel"; ref: number }
  | { seq: number; kind: "load"; owner: string; ship: string; commodity: string; qty: number; island: string }
  | { seq: number; kind: "unload"; owner: string; ship: string; commodity: string; qty: number; island: string }
  | { seq: number; kind: "sail"; owner: string; ship: string; to: string; from: string; departAt: number; arriveAt: number; danger: number }
  | { seq: number; kind: "arrive"; ship: string; to: string; hull: number; sunk: boolean }
  | { seq: number; kind: "build"; owner: string; island: string; recipe: string; to: string }
  | { seq: number; kind: "produce"; owner: string; island: string; recipe: string; ts: number }
  | { seq: number; kind: "site"; owner: string; island: string; commodity: string; to: string }
  | { seq: number; kind: "extract"; owner: string; island: string; commodity: string; fee: number; flag: string | null; ts: number }
  | { seq: number; kind: "pledge"; owner: string; flag: string }
  | { seq: number; kind: "payout"; flag: string }
  | { seq: number; kind: "seize"; owner: string; island: string; flag: string; cost: number }
  | { seq: number; kind: "award"; owner: string; amount: number }
  | { seq: number; kind: "upkeep"; owner: string; island: string; amount: number; flag: string | null; ts: number }
  | { seq: number; kind: "repair"; owner: string; ship: string; flag: string | null }
  | { seq: number; kind: "hull"; ship: string; hull: number }
  | { seq: number; kind: "scuttle"; ship: string };

export interface LedgerRow { account: string; delta: number; reason: string; }
export interface TradeRow { island: string; commodity: string; price: number; qty: number; buyer: string; seller: string; }
export interface Batch { intents: Intent[]; trades: TradeRow[]; ledger: LedgerRow[]; }

// A persistence backend. Implemented by PgStore (Postgres) and by an in-memory
// double in the tests. Markets only depend on this interface.
export interface Store {
  persist(batch: Batch): Promise<void>;
  loadIntents(): Promise<Intent[]>;
}

export interface MarketOptions {
  commodities?: string[];
  basePrice?: Record<string, number>;
  newPlayerPoe?: number;
  newPlayerInv?: Record<string, number>;
  produces?: string[];
  demands?: string[];
  flag?: string | null;       // island's controlling flag (levy + tax destination)
  taxRate?: number;           // commerce tax skimmed from sellers (0 = none)
  listingFeeBps?: number;     // fee on placing an order, in basis points (0 = none)
  demandLevyBps?: number;     // sink skimmed from demand sales, in basis points (0 = none)
  seedLevels?: number;
  seedQty?: number;
  exchange?: Exchange;        // shared engine (hub); omit for a standalone market
  store?: Store;             // attach to persist; omit for in-memory only
  nextSeq?: () => number;    // global op sequence source (for replay ordering)
  now?: () => number;        // wall clock (ms) for labor regen; injectable for tests
}

export interface RestingOrder {
  id: number;
  commodity: string;
  side: Side;
  price: number;
  qty: number;
}

export interface ShipBalance {
  id: string;
  cls: string;
  dockedAt: string | null; // null while at sea
  voyage: { from: string; to: string; arriveAt: number } | null;
  cargoCap: number;
  hull: number;
  maxHull: number;
  hold: Record<string, number>;
}

export interface Balances {
  poe: number;
  labor: number;
  holdings: Record<string, number>; // warehouse stock ON THIS ISLAND
  orders: RestingOrder[];
  stalls: string[]; // recipe ids this player owns a stall for on this island
  sites: string[];  // raw commodities this player owns an extraction site for here
  ships: ShipBalance[]; // the captain's whole fleet + each hold's contents
  pledged: boolean; // pledged to this island's controlling flag?
  myFlags: string[]; // every flag this player is pledged to
}

export interface Stall { owner: string; island: string; recipe: string; stall: string; }

export class Market {
  readonly island: string;
  readonly commodities: string[];
  readonly recipes: Recipe[];
  readonly ex: Exchange;

  constructor(island: string, opts?: MarketOptions);

  seedPrice(commodity: string): number;
  seedLiquidity(levels?: number, qty?: number): void;
  restockDemand(): string[]; // top up finished-goods demand bids; returns touched commodities

  hasPlayer(playerId: string): boolean;
  join(playerId: string): void;

  placeLimit(playerId: string, commodity: string, side: Side, price: number, qty: number): Order;
  build(playerId: string, recipeId: string): Stall;
  buildSite(playerId: string, commodity: string): { owner: string; island: string; commodity: string };
  extract(playerId: string, commodity: string): void;
  buyShip(playerId: string, cls: string): string;
  readonly flag: string | null;
  flagTreasury(): number;
  flagMemberCount(): number;
  flagsOf(playerId: string): string[];
  isPledged(playerId: string, flag?: string | null): boolean;
  pledge(playerId: string, flag?: string | null): void;
  seize(playerId: string, flag: string): string;
  award(playerId: string, amount: number): void;
  payout(playerId: string): number;
  produce(playerId: string, recipeId: string): Recipe;
  cancel(playerId: string, orderId: number): string | null;

  loadCargo(playerId: string, shipId: string, commodity: string, qty: number): void;
  unloadCargo(playerId: string, shipId: string, commodity: string, qty: number): void;
  moveShip(playerId: string, shipId: string, toIsland: string, dist?: number, danger?: number): { arriveAt: number };
  tickVoyages(now?: number): Array<{ ship: string; to: string; sunk: boolean; hit: boolean }>;
  tickUpkeep(now?: number): string[];                 // charge due rent; returns owners charged
  repairShip(playerId: string, shipId: string): number; // repair at port; returns PoE charged
  resolveShip(shipId: string, finalHull: number): void; // persist a battle outcome (sink if <=0)
  shipHull(shipId: string): number;

  flush(): Promise<void>;

  depth(commodity: string, n?: number): Depth;
  balancesOf(playerId: string, now?: number): Balances;

  totalPoe(): number;
  totalUnits(commodity: string): number;
}

export function replay(ex: Exchange, intents: Intent[]): Exchange;
export function seededIslandsFrom(intents: Intent[]): Set<string>;
export function laborAt(ex: Exchange, owner: string, now: number): number;
