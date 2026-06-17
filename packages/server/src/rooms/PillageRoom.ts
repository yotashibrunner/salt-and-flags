// ============================================================================
// PillageRoom — one turn-based sea battle (authoritative).
// Phase machine: RIG -> PLOT -> RESOLVE -> (next round | END).
// Co-op: each connected crew member streams puzzle results during RIG, which
// the server tallies into shared ship resources (wind / powder / repair / pumps).
//
// Resolution is delegated to the deterministic core in ../pillage/battle.mjs, so
// the server computes one authoritative round and broadcasts a replay "script"
// every client animates identically. (The math lives in battle.mjs; this room is
// the Colyseus adapter + phase clock.)
// ============================================================================
// colyseus is CommonJS: take the runtime Room class off the default import and
// keep Client as a type-only import (erased at runtime, so no ESM-interop issue).
import colyseusPkg from "colyseus";
import type { Client } from "colyseus";
const { Room } = colyseusPkg;
import { Schema, type, MapSchema } from "@colyseus/schema";
import { resolveRound as resolveBattleRound, enemyPlot, legalizePlot, BOARD, MOVES_PER_ROUND } from "../pillage/battle.mjs";
import type { Ship } from "../pillage/battle.mjs";
import { getHub } from "../economy/hub.js";
import { playerIdFromSecret } from "../identity.mjs";

class ShipState extends Schema {
  @type("number") col = 0;
  @type("number") row = 0;
  @type("number") heading = 0;
  @type("number") hull = 16;
  @type("number") wind = 0;     // movement tokens (from sailing puzzles)
  @type("number") powder = 0;   // loaded shot (from gunnery puzzles)
  @type("number") repair = 0;   // (from carpentry)
  @type("number") flood = 0;    // (bilging counters this)
}

class BattleState extends Schema {
  @type("string") phase = "rig";        // rig | plot | resolve | end
  @type("number") round = 1;
  @type("number") phaseEndsAt = 0;
  @type("number") boardW = BOARD.w;
  @type("number") boardH = BOARD.h;
  @type("string") winner = "";
  @type({ map: ShipState }) ships = new MapSchema<ShipState>();
}

const RIG_MS = 20000;
const RESOLVE_MS = 1500;
const PLUNDER_BOUNTY = 500; // PoE awarded to each winning crew member, via the market ledger

interface PlotMsg { moves: string[]; ballsPort: number; ballsStar: number; }
interface ShipSetup { col?: number; row?: number; heading?: number; hull?: number; }

export class PillageRoom extends Room<BattleState> {
  maxClients = 16;
  private rigMs = RIG_MS;
  private enemyMoveBudget = MOVES_PER_ROUND;
  // When a real ship is sailed into the battle, its hull seeds the fight and the
  // outcome is persisted: a loss SINKS it (cargo burned, ship removed), a win records
  // the remaining damage. Omitted (the default / tests) => combat has no economy effect.
  private playerShipId?: string;
  private enemyShipId?: string;
  private island?: string; // where the battle happens (enemy wreck/salvage lands here)

  // Proven identity (shared with the market): the id is derived from the client's secret,
  // so plunder is paid to the same wallet the captain trades with and can't be hijacked.
  async onAuth(_client: Client, options: { secret?: string }) {
    const secret = typeof options?.secret === "string" ? options.secret.trim() : "";
    if (!secret) throw new Error("missing secret");
    return { playerId: await playerIdFromSecret(secret) };
  }
  private pid(client: Client): string {
    return (client.auth as { playerId: string }).playerId;
  }

  async onCreate(options: { rigMs?: number; enemyMoveBudget?: number; playerShipId?: string; enemyShipId?: string; island?: string; setup?: { player?: ShipSetup; enemy?: ShipSetup } } = {}) {
    this.rigMs = options.rigMs ?? RIG_MS;
    if (options.enemyMoveBudget !== undefined) this.enemyMoveBudget = options.enemyMoveBudget;
    this.playerShipId = options.playerShipId;
    this.enemyShipId = options.enemyShipId;
    this.island = options.island;
    this.setState(new BattleState());
    const me = new ShipState(); me.col = 3; me.row = 6; me.heading = 0;  // facing north, toward the foe
    const foe = new ShipState(); foe.col = 3; foe.row = 1; foe.heading = 2; // facing south
    applySetup(me, options.setup?.player);   // test seam: position/hull overrides
    applySetup(foe, options.setup?.enemy);
    // a real ship brings its persisted hull into the fight
    if (this.playerShipId) me.hull = getHub().shipHull(this.playerShipId) || me.hull;
    // with a real captain + a locale but no opponent, conjure an NPC raider to fight
    if (this.playerShipId && !this.enemyShipId && this.island) {
      this.enemyShipId = await getHub().spawnRaider(this.island);
      foe.hull = getHub().shipHull(this.enemyShipId) || foe.hull;
    }
    this.state.ships.set("player", me);
    this.state.ships.set("enemy", foe);

    // During RIG, crew clients report puzzle clears; tally into shared resources.
    this.onMessage("rig:clears", (_client, msg: { wind?: number; powder?: number; repair?: number; pumps?: number }) => {
      if (this.state.phase !== "rig") return;
      const s = this.state.ships.get("player")!;
      s.wind = Math.min(4, s.wind + (msg.wind ?? 0));
      s.powder = Math.min(4, s.powder + (msg.powder ?? 0));
      s.repair += msg.repair ?? 0;
      s.flood = Math.max(0, s.flood - (msg.pumps ?? 0));
    });

    // Captain submits the plotted turn (only honored during PLOT).
    this.onMessage<PlotMsg>("plot", (_client, msg) => {
      if (this.state.phase !== "plot") return;
      this.resolveRound(msg);
    });

    this.startRig();
  }

  startRig() {
    this.state.phase = "rig";
    const me = this.state.ships.get("player")!;
    me.wind = 0; me.powder = 0;
    this.state.phaseEndsAt = Date.now() + this.rigMs;
    this.clock.setTimeout(() => this.toPlot(), this.rigMs);
  }

  toPlot() {
    if (this.state.phase !== "rig") return;
    this.state.phase = "plot";
  }

  resolveRound(plot: PlotMsg) {
    this.state.phase = "resolve";
    const me = this.state.ships.get("player")!;
    const foe = this.state.ships.get("enemy")!;

    const ships: Record<string, Ship> = {
      player: { col: me.col, row: me.row, heading: me.heading, hull: me.hull },
      enemy: { col: foe.col, row: foe.row, heading: foe.heading, hull: foe.hull },
    };
    const playerPlot = legalizePlot(plot, me.wind, me.powder); // validate moves<=wind, balls<=powder
    const enemy = enemyPlot(BOARD, ships, "enemy", "player", this.enemyMoveBudget);

    const result = resolveBattleRound(BOARD, ships, { player: playerPlot, enemy });
    applyShip(me, result.ships.player);
    applyShip(foe, result.ships.enemy);

    // Every client replays this exact script -> identical cinematic.
    this.broadcast("resolution", { round: this.state.round, script: result.script, plots: { player: playerPlot, enemy } });

    this.clock.setTimeout(() => {
      if (foe.hull <= 0) { void this.endBattle("player"); return; }
      if (me.hull <= 0) { void this.endBattle("enemy"); return; }
      this.state.round++;
      this.startRig();
    }, RESOLVE_MS);
  }

  async endBattle(winner: string) {
    this.state.phase = "end";
    this.state.winner = winner;

    // Economy hook: apply the whole battle outcome through the hub (conserving + persisted):
    // a win pays plunder to each crew member and SINKS the enemy raider (its cargo washes
    // up as a salvageable wreck) while keeping the player's damage; a loss sinks the player
    // ship (loss-on-sinking — cargo burned/salvaged, ship removed).
    const recipients = winner === "player" ? [...new Set(this.clients.map((c) => this.pid(c)))] : [];
    try {
      const me = this.state.ships.get("player")!;
      await getHub().concludeBattle(winner === "player" ? "player" : "enemy", {
        playerShipId: this.playerShipId,
        playerHull: me.hull,
        enemyShipId: this.enemyShipId,
        plunderTo: recipients,
        plunder: PLUNDER_BOUNTY,
        island: this.island, // a win here advances a blockade on this island, if any
      });
    } catch (e) { console.error("battle outcome persist failed:", e); }

    this.broadcast("end", { winner, bounty: winner === "player" ? PLUNDER_BOUNTY : 0, recipients });
  }

  onJoin(_client: Client) { /* assign client to a station */ }
  onLeave(_client: Client) { /* free the station; pause if captain drops */ }
}

function applyShip(s: ShipState, r: Ship) {
  s.col = r.col; s.row = r.row; s.heading = r.heading; s.hull = r.hull;
}

function applySetup(s: ShipState, setup?: ShipSetup) {
  if (!setup) return;
  if (setup.col !== undefined) s.col = setup.col;
  if (setup.row !== undefined) s.row = setup.row;
  if (setup.heading !== undefined) s.heading = setup.heading;
  if (setup.hull !== undefined) s.hull = setup.hull;
}
