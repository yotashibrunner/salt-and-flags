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
export const FINISHED: Set<string>;

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
  | { seq: number; kind: "ship"; id: string; owner: string; cls: string; dockedAt: string }
  | { seq: number; kind: "place"; owner: string; island: string; commodity: string; side: Side; price: number; qty: number; flag: string | null; rate: number }
  | { seq: number; kind: "cancel"; ref: number }
  | { seq: number; kind: "load"; owner: string; ship: string; commodity: string; qty: number; island: string }
  | { seq: number; kind: "unload"; owner: string; ship: string; commodity: string; qty: number; island: string }
  | { seq: number; kind: "move"; owner: string; ship: string; to: string }
  | { seq: number; kind: "build"; owner: string; island: string; recipe: string; to: string }
  | { seq: number; kind: "produce"; owner: string; island: string; recipe: string; ts: number }
  | { seq: number; kind: "pledge"; owner: string; flag: string }
  | { seq: number; kind: "payout"; flag: string }
  | { seq: number; kind: "seize"; owner: string; island: string; flag: string; cost: number }
  | { seq: number; kind: "award"; owner: string; amount: number };

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
  dockedAt: string;
  cargoCap: number;
  hold: Record<string, number>;
}

export interface Balances {
  poe: number;
  labor: number;
  holdings: Record<string, number>; // warehouse stock ON THIS ISLAND
  orders: RestingOrder[];
  stalls: string[]; // recipe ids this player owns a stall for on this island
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
  moveShip(playerId: string, shipId: string, toIsland: string): void;

  flush(): Promise<void>;

  depth(commodity: string, n?: number): Depth;
  balancesOf(playerId: string, now?: number): Balances;

  totalPoe(): number;
  totalUnits(commodity: string): number;
}

export function replay(ex: Exchange, intents: Intent[]): Exchange;
export function seededIslandsFrom(intents: Intent[]): Set<string>;
export function laborAt(ex: Exchange, owner: string, now: number): number;
