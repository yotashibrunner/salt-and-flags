// ============================================================================
// MarketHub — owns the ONE shared Exchange for the whole server and hands out a
// per-island Market view over it. A single shared engine gives every player one
// global wallet + one ledger across all islands (which is what persistence and
// the DB schema assume). Books stay per-island (keyed island:commodity).
//
// On boot, init() replays the persisted intent log to rebuild all state. Islands
// are NPC-seeded lazily on first visit, unless they were already seeded (the log
// tells us). A module singleton (set in index.ts) lets each MarketRoom reach it.
// ============================================================================
import { Exchange } from "./economy.mjs";
import { Market, replay, seededIslandsFrom, LISTING_FEE_BPS, DEMAND_LEVY_BPS } from "./market.mjs";
import type { Store } from "./market.mjs";
import type { IslandInfo } from "../world/registry.js";

export class MarketHub {
  readonly ex = new Exchange();
  private markets = new Map<string, Market>();
  private seeded = new Set<string>();
  private system?: Market; // island-less view for cross-cutting ops (e.g. plunder)
  private seq = 0;

  constructor(private store?: Store) {}

  // A bare Market view over the shared engine for account-level ops that aren't
  // tied to an island (it injects the exchange, so it never seeds a fake book).
  private sys(): Market {
    if (!this.system) {
      this.system = new Market("__system__", { exchange: this.ex, store: this.store, nextSeq: () => ++this.seq });
    }
    return this.system;
  }

  // Pay battle plunder into a player's market wallet (ensuring they have one).
  async award(playerId: string, amount: number) {
    const s = this.sys();
    s.join(playerId); // give a fresh player normal starting balances before plunder
    s.award(playerId, amount);
    await s.flush();
  }

  // Current hull of a real ship (so a battle can start from its persisted condition).
  shipHull(shipId: string): number {
    return this.sys().shipHull(shipId);
  }

  // Persist a battle's outcome for a real ship: finalHull <= 0 sinks it
  // (loss-on-sinking — cargo burned, ship removed), otherwise records the damage.
  async resolveShip(shipId: string, finalHull: number) {
    const s = this.sys();
    s.resolveShip(shipId, finalHull);
    await s.flush();
  }

  // Rebuild all state from the persisted intent log (no-op without a store).
  async init() {
    if (!this.store) return;
    const intents = await this.store.loadIntents();
    replay(this.ex, intents);
    this.seeded = seededIslandsFrom(intents);
    this.seq = intents.reduce((m, it) => Math.max(m, it.seq), 0);
    console.log(`market: replayed ${intents.length} intents, ${this.seeded.size} islands seeded`);
  }

  // Get (creating + seeding on first visit) the Market view for one island.
  async market(info: IslandInfo): Promise<Market> {
    let m = this.markets.get(info.id);
    if (m) return m;
    m = new Market(info.id, {
      exchange: this.ex,
      store: this.store,
      produces: info.produces,
      demands: info.demands,
      flag: info.controllingFlag,
      taxRate: info.taxRate,
      listingFeeBps: LISTING_FEE_BPS, // the live economy charges a listing fee (a sink)
      demandLevyBps: DEMAND_LEVY_BPS, // and skims the demand premium (a sink)
      nextSeq: () => ++this.seq,
    });
    this.markets.set(info.id, m);
    if (!this.seeded.has(info.id)) {
      m.seedLiquidity();
      await m.flush(); // persist the seed so a restart doesn't re-seed
      this.seeded.add(info.id);
    }
    return m;
  }
}

// --- module singleton (set at boot in index.ts) ---
let hub: MarketHub | null = null;
export function setHub(h: MarketHub) { hub = h; }
export function getHub(): MarketHub {
  if (!hub) throw new Error("MarketHub not initialised");
  return hub;
}
