// Type declarations for economy.mjs (the canonical, money-safe matching engine).
// economy.mjs stays the source of truth (untouched JS + its node:test suite);
// this file only describes its shape so TypeScript callers (the Colyseus room)
// get full type-checking. Keep it in sync with economy.mjs.

export type Side = "buy" | "sell";

export interface Account {
  id: string;
  poe: number;
  inv: Record<string, number>;
}

export interface Order {
  id: number;
  owner: string;
  side: Side;
  price: number;
  qty: number;
  island: string;
  commodity: string;
  ts: number;
}

export interface Trade {
  island: string;
  commodity: string;
  price: number;
  qty: number;
  buyer: string;
  seller: string;
}

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface Depth {
  last: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export class Ledger {
  entries: Array<{ id: number; account: string; delta: number; reason: string; ref?: unknown }>;
  postPair(fromId: string, toId: string, amount: number, reason: string, ref?: unknown): void;
  sum(): number;
}

export interface Voyage { from: string; to: string; departAt: number; arriveAt: number; danger: number; }
export interface ShipRec { owner: string; cls: string; dockedAt: string | null; hull: number; maxHull: number; voyage: Voyage | null; }

export class Exchange {
  accounts: Map<string, Account>;
  openOrders: Map<number, Order>;
  trades: Trade[];
  ledger: Ledger;
  located: boolean;                       // when true, goods live in per-(owner,island) warehouses
  minted: number;                         // total PoE minted via account openings (faucet baseline)
  mintedUnits: Record<string, number>;    // total units minted via openings + production
  ships?: Map<string, ShipRec>;           // added by the Market layer (located inventory)
  _sid?: number;                          // ship-id counter (Market layer)
  upkeepTs?: Map<string, number>;         // `${owner}:${island}` -> last upkeep timestamp
  sites?: Map<string, { owner: string; island: string; commodity: string }>; // extraction sites
  crews?: Map<string, { name: string; captain: string; members: Set<string> }>; // player crews
  _cid?: number; // crew-id counter
  blockades?: Map<string, { attacker: string; defender: string | null; meter: number }>; // contested islands
  onboarded?: Set<string>; // players who have received their one-time starter ship + goods

  createAccount(id: string, poe?: number, inv?: Record<string, number>): Account;
  acct(id: string): Account;
  poeOf(id: string): number;
  invOf(id: string, commodity: string): number;

  whId(owner: string, island: string): string;
  mint(id: string, commodity: string, qty: number): void;
  burn(id: string, commodity: string, qty: number): void;

  totalPoe(): number;
  totalUnits(commodity: string): number;

  placeLimit(
    ownerId: string,
    island: string,
    commodity: string,
    side: Side,
    price: number,
    qty: number,
  ): Order;
  cancel(orderId: number): boolean;
  depth(island: string, commodity: string, n?: number): Depth;
}
