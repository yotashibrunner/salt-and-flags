// ============================================================================
// MarketRoom — one authoritative commodities exchange per island.
// Defined with .filterBy(["island"]) so each island gets its own room instance,
// and each instance owns ONE Market (which owns ONE economy-engine Exchange).
//
// Clients send intents only (placeLimit / cancel). The room validates against
// server-side accounts (keyed by a stable player id from onAuth), applies via the
// engine, and broadcasts:
//   • public order-book depth + last price  -> Colyseus schema state (auto-synced)
//   • each client's own PoE + holdings + resting orders -> private "balances" msg
// The client never computes a price or a balance — the server is authoritative.
// ============================================================================
// colyseus is CommonJS: take the runtime Room class off the default import and
// keep Client as a type-only import (erased at runtime, so no ESM-interop issue).
import colyseusPkg from "colyseus";
import type { Client } from "colyseus";
const { Room } = colyseusPkg;
import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";
import type { Market } from "../economy/market.mjs";
import { STALL_COST, CONQUEST_COST, FLAGS, SHIP_CARGO } from "../economy/market.mjs";
import { getHub } from "../economy/hub.js";
import { getIsland } from "../world/registry.js";

class LevelState extends Schema {
  @type("number") price = 0;
  @type("number") qty = 0;
}

class BookState extends Schema {
  @type("number") last = 0;
  @type([LevelState]) bids = new ArraySchema<LevelState>();
  @type([LevelState]) asks = new ArraySchema<LevelState>();
}

class MarketState extends Schema {
  @type("string") island = "";
  @type("string") islandName = "";
  @type("string") region = "";
  @type("string") flag = "";              // controlling flag id ("" if unclaimed)
  @type("number") taxRate = 0;            // commerce tax rate on this island's trades
  @type("number") flagTreasury = 0;       // PoE the controlling flag has collected
  @type("number") flagMembers = 0;        // players pledged to the controlling flag
  @type(["string"]) commodities = new ArraySchema<string>();
  @type(["string"]) produces = new ArraySchema<string>();
  @type(["string"]) demands = new ArraySchema<string>();
  @type({ map: BookState }) books = new MapSchema<BookState>(); // key: commodity
}

interface PlaceLimitMsg { commodity: string; side: "buy" | "sell"; price: number; qty: number; }
interface CancelMsg { orderId: number; }
interface ProduceMsg { recipeId: string; }
interface BuildMsg { recipeId: string; }
interface PledgeMsg { flag?: string; }
interface SeizeMsg { flag: string; }
interface CargoMsg { shipId: string; commodity: string; qty: number; }
interface MoveMsg { shipId: string; toIsland: string; }

export class MarketRoom extends Room<MarketState> {
  maxClients = 64;
  private market!: Market;

  async onCreate(options: { island?: string } = {}) {
    const info = getIsland(String(options.island));
    if (!info) throw new Error(`unknown island: ${options.island}`); // rejects the join

    this.market = await getHub().market(info); // shared engine; seeded+persisted on first visit

    this.setState(new MarketState());
    this.state.island = info.id;
    this.state.islandName = info.name;
    this.state.region = info.region;
    this.state.flag = info.controllingFlag ?? "";
    this.state.taxRate = info.taxRate;
    this.state.flagTreasury = this.market.flagTreasury();
    this.state.flagMembers = this.market.flagMemberCount();
    for (const c of info.produces) this.state.produces.push(c);
    for (const c of info.demands) this.state.demands.push(c);
    for (const c of this.market.commodities) {
      this.state.commodities.push(c);
      this.state.books.set(c, new BookState());
      this.syncBook(c);
    }

    this.onMessage<PlaceLimitMsg>("placeLimit", async (client, msg) => {
      try {
        const commodity = String(msg?.commodity);
        const side = msg?.side === "sell" ? "sell" : "buy";
        this.market.placeLimit(this.pid(client), commodity, side, Number(msg?.price), Number(msg?.qty));
        await this.market.flush(); // durable before we broadcast success
        this.syncFlag(); // trade tax may have fed the flag
        this.syncBook(commodity);
        this.pushBalances(); // a fill can touch the taker AND resting makers
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<CancelMsg>("cancel", async (client, msg) => {
      try {
        const commodity = this.market.cancel(this.pid(client), Number(msg?.orderId));
        await this.market.flush();
        if (commodity) this.syncBook(commodity);
        this.pushBalances();
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<BuildMsg>("build", async (client, msg) => {
      try {
        this.market.build(this.pid(client), String(msg?.recipeId));
        await this.market.flush();
        this.syncFlag(); // levy went to the flag
        this.pushBalances(); // build changes the player's PoE + owned stalls
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<PledgeMsg>("pledge", async (client, msg) => {
      try {
        this.market.pledge(this.pid(client), msg?.flag);
        await this.market.flush();
        this.syncFlag();
        this.pushBalances(); // pledged status changed
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<SeizeMsg>("seize", async (client, msg) => {
      try {
        this.market.seize(this.pid(client), String(msg?.flag));
        await this.market.flush();
        this.syncFlag(); // controlling flag (and its treasury/members) changed
        this.pushBalances();
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage("payout", async (client) => {
      try {
        this.market.payout(this.pid(client));
        await this.market.flush();
        this.syncFlag();
        this.pushBalances(); // members' PoE changed (those in this room; others on the next tick)
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<ProduceMsg>("produce", async (client, msg) => {
      try {
        this.market.produce(this.pid(client), String(msg?.recipeId));
        await this.market.flush();
        this.pushBalances(); // production changes the player's holdings + labor, not the book
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    // --- cargo: move goods between this port's warehouse and a docked ship's hold,
    // and sail a ship to another port (instant stub). All change located inventory
    // only (no book/PoE), so just resync the acting client's balances. ---
    this.onMessage<CargoMsg>("load", async (client, msg) => {
      try {
        this.market.loadCargo(this.pid(client), String(msg?.shipId), String(msg?.commodity), Number(msg?.qty));
        await this.market.flush();
        this.pushBalances();
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<CargoMsg>("unload", async (client, msg) => {
      try {
        this.market.unloadCargo(this.pid(client), String(msg?.shipId), String(msg?.commodity), Number(msg?.qty));
        await this.market.flush();
        this.pushBalances();
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    this.onMessage<MoveMsg>("move", async (client, msg) => {
      try {
        this.market.moveShip(this.pid(client), String(msg?.shipId), String(msg?.toIsland));
        await this.market.flush();
        this.pushBalances(); // the ship (and its hold) leaves this port's view
      } catch (e) {
        client.send("error", { message: errMsg(e) });
      }
    });

    // The client requests its initial snapshot once it has attached handlers,
    // which avoids racing the onJoin send against the client's listener setup.
    this.onMessage("sync", (client) => this.sendHello(client));

    // Labor regenerates over time; push fresh (server-computed) balances on a tick
    // so clients see it climb without ever computing a balance themselves. Also
    // refresh the flag treasury (it can grow from builds on its other islands).
    this.clock.setInterval(() => {
      this.pushBalances();
      this.syncFlag();
    }, 2000);
  }

  // Stable cross-island identity: the client presents a player id (persisted in
  // its localStorage, sent on every join). All accounts/holdings/labor/stalls/flag
  // membership key off this — so one player has ONE wallet on every island and
  // across reconnects, not a fresh per-room sessionId account. (Identity is by
  // assertion for now; verifying a signed credential is a later hardening.)
  onAuth(client: Client, options: { playerId?: string }) {
    const raw = typeof options?.playerId === "string" ? options.playerId.trim() : "";
    if (!raw) throw new Error("missing playerId");
    return { playerId: raw.slice(0, 64) };
  }

  private pid(client: Client): string {
    return (client.auth as { playerId: string }).playerId;
  }

  async onJoin(client: Client) {
    this.market.join(this.pid(client));
    await this.market.flush(); // persist the new account before play
  }

  onLeave() {
    // Intentionally keep the player's account + resting orders so escrow stays
    // consistent and no pieces of eight leave the system on disconnect.
  }

  // --- public book -> schema state (Colyseus diffs + broadcasts automatically) ---
  private syncBook(commodity: string) {
    const d = this.market.depth(commodity);
    const b = this.state.books.get(commodity);
    if (!b) return;
    b.last = d.last;
    b.bids.splice(0);
    for (const l of d.bids) { const x = new LevelState(); x.price = l.price; x.qty = l.qty; b.bids.push(x); }
    b.asks.splice(0);
    for (const l of d.asks) { const x = new LevelState(); x.price = l.price; x.qty = l.qty; b.asks.push(x); }
  }

  private syncFlag() {
    this.state.flag = this.market.flag ?? ""; // conquest can change the controller
    this.state.flagTreasury = this.market.flagTreasury();
    this.state.flagMembers = this.market.flagMemberCount();
  }

  private sendHello(client: Client) {
    client.send("hello", {
      playerId: this.pid(client),
      island: this.state.island,
      islandName: this.state.islandName,
      region: this.state.region,
      commodities: this.market.commodities,
      produces: [...this.state.produces],
      demands: [...this.state.demands],
      recipes: this.market.recipes,
      stallCost: STALL_COST,
      flags: FLAGS,
      conquestCost: CONQUEST_COST,
      shipCargo: SHIP_CARGO, // cargo capacity per ship class (for the load/sail UI)
    });
    this.sendBalances(client);
  }

  // --- private balances -> per-client message ---
  private sendBalances(client: Client) {
    client.send("balances", this.market.balancesOf(this.pid(client)));
  }
  private pushBalances() {
    for (const client of this.clients) this.sendBalances(client);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
