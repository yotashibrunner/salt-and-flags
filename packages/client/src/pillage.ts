// Pillage battle UI. Renders the board from the authoritative PillageRoom state
// and animates the server's resolution "script" (move frames, then broadsides).
// The client only sends intents (rig:clears, plot) — the server decides outcomes.

import { Client, Room } from "colyseus.js";
import { getIdentity } from "./identity";

const SERVER = (import.meta as any).env?.VITE_SERVER ?? "http://localhost:2567";
const RIG_MS = Number(new URLSearchParams(location.search).get("rig") ?? 12000);

// Same proven identity as the market (secret -> derived id), so battle plunder lands in
// this captain's wallet.
let SECRET = "";
const CELL = 46;
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N,E,S,W
const left = (h: number) => (h + 3) % 4, right = (h: number) => (h + 1) % 4;

const $ = (id: string) => document.getElementById(id)!;
const cv = $("board") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pose { col: number; row: number; heading: number; hull: number; }

let room: Room<any>;
let boardW = 6, boardH = 9;
let animating = false;
let view: Record<string, Pose> | null = null; // poses used while animating
let fireFx: { x0: number; y0: number; x1: number; y1: number; hit: boolean }[] = [];
let plot: ("F" | "L" | "R")[] = [];

function shipsFromState(): Record<string, Pose> {
  const s = room?.state?.ships; const out: Record<string, Pose> = {};
  if (!s) return out;
  for (const id of ["enemy", "player"]) {
    const sh = s.get(id);
    if (sh) out[id] = { col: sh.col, row: sh.row, heading: sh.heading, hull: sh.hull };
  }
  return out;
}

function drawShip(p: Pose, color: string) {
  const cx = p.col * CELL + CELL / 2, cy = p.row * CELL + CELL / 2;
  const [dx, dy] = DIR[p.heading];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, -CELL * 0.34); ctx.lineTo(CELL * 0.24, CELL * 0.30); ctx.lineTo(-CELL * 0.24, CELL * 0.30);
  ctx.closePath();
  ctx.fillStyle = p.hull > 0 ? color : "#555"; ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#ece6d4"; ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "center";
  ctx.fillText(p.hull > 0 ? String(p.hull) : "sunk", cx, cy - CELL * 0.40);
}

function draw() {
  cv.width = boardW * CELL; cv.height = boardH * CELL;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = "rgba(214,167,62,.12)"; ctx.lineWidth = 1;
  for (let x = 0; x <= boardW; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, boardH * CELL); ctx.stroke(); }
  for (let y = 0; y <= boardH; y++) { ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(boardW * CELL, y * CELL); ctx.stroke(); }
  for (const f of fireFx) {
    ctx.strokeStyle = f.hit ? "#e2643e" : "rgba(226,100,62,.4)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(f.x0, f.y0); ctx.lineTo(f.x1, f.y1); ctx.stroke();
  }
  const ships = view ?? shipsFromState();
  if (ships.enemy) drawShip(ships.enemy, "#e2643e");
  if (ships.player) drawShip(ships.player, "#5fd08a");
}

function hud() {
  const st = room?.state; if (!st) return;
  boardW = st.boardW || boardW; boardH = st.boardH || boardH;
  $("phase").textContent = st.phase;
  $("round").textContent = String(st.round);
  const me = st.ships.get("player");
  if (me) { $("wind").textContent = String(me.wind); $("powder").textContent = String(me.powder); $("hull").textContent = String(me.hull); }
  const rem = Math.max(0, Math.ceil((st.phaseEndsAt - Date.now()) / 1000));
  $("timer").textContent = st.phase === "rig" ? `rigging… ${rem}s` : st.phase === "plot" ? "PLOT — commit your turn" : st.phase === "resolve" ? "resolving…" : "";
  $("result").textContent = st.winner ? (st.winner === "player" ? "★ VICTORY" : "✖ DEFEAT") : "";
  const plotting = st.phase === "plot";
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".mv,#commit,#clearmoves"))) b.disabled = !plotting;
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-clear]"))) b.disabled = st.phase !== "rig";
}

function center(c: number, r: number): [number, number] { return [c * CELL + CELL / 2, r * CELL + CELL / 2]; }

async function animate(res: any) {
  animating = true; fireFx = [];
  const s = res.script;
  view = { player: { ...s.start.player }, enemy: { ...s.start.enemy } };
  draw(); await wait(250);

  for (const fr of s.frames) {
    for (const id of ["player", "enemy"]) {
      if (fr[id] && view![id]) { view![id].col = fr[id].col; view![id].row = fr[id].row; view![id].heading = fr[id].heading; }
    }
    draw(); await wait(350);
  }

  for (const f of s.fire) {
    const sh = view![f.shooter]; if (!sh) continue;
    const dirH = f.side === "port" ? left(sh.heading) : right(sh.heading);
    const [dx, dy] = DIR[dirH];
    const reach = f.target && view![f.target] ? Math.max(Math.abs(view![f.target].col - sh.col), Math.abs(view![f.target].row - sh.row)) : 3;
    const [x0, y0] = center(sh.col, sh.row);
    const [x1, y1] = center(sh.col + dx * reach, sh.row + dy * reach);
    fireFx = [{ x0, y0, x1, y1, hit: !!f.target }];
    if (f.target && view![f.target]) view![f.target].hull -= f.dmg;
    draw(); await wait(320); fireFx = [];
  }

  view = null; animating = false; draw(); // settle to authoritative state
}

function renderPlot() {
  const slots = [0, 1, 2, 3].map((i) => plot[i] ?? "—");
  $("plotmoves").textContent = slots.join(" ");
}

async function boot() {
  const client = new Client(SERVER);
  ({ secret: SECRET } = await getIdentity());
  // Arriving from "Go raiding" carries the real ship + locale: create a PRIVATE battle
  // for it (the server spawns an NPC raider and persists the outcome). Without them, the
  // standalone demo joins a shared sandbox room.
  const params = new URLSearchParams(location.search);
  const ship = params.get("ship"), isle = params.get("island");
  room = ship
    ? await client.create("pillage", { rigMs: RIG_MS, secret: SECRET, playerShipId: ship, island: isle ?? undefined })
    : await client.joinOrCreate("pillage", { rigMs: RIG_MS, secret: SECRET });

  room.onStateChange(() => { hud(); if (!animating) draw(); });
  room.onMessage("resolution", (res: any) => { animate(res); });
  room.onMessage("end", (m: { winner: string; bounty: number }) => {
    hud();
    if (m.winner === "player" && m.bounty) {
      $("msg").style.color = "#d6a73e";
      $("msg").textContent = `Plunder! +${m.bounty} PoE paid to your market wallet.`;
    }
  });

  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-clear]"))) {
    b.onclick = () => room.send("rig:clears", { [b.dataset.clear!]: 1 });
  }
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".mv"))) {
    b.onclick = () => { if (plot.length < 4) plot.push(b.dataset.mv as "F" | "L" | "R"); renderPlot(); };
  }
  ($("clearmoves") as HTMLButtonElement).onclick = () => { plot = []; renderPlot(); };
  ($("commit") as HTMLButtonElement).onclick = () => {
    room.send("plot", {
      moves: plot,
      ballsPort: Number(($("ballsPort") as HTMLInputElement).value) || 0,
      ballsStar: Number(($("ballsStar") as HTMLInputElement).value) || 0,
    });
    plot = []; renderPlot();
  };

  renderPlot();
  setInterval(hud, 250); // tick the rig countdown
}

boot().catch((e) => { $("msg").textContent = `connect failed: ${e?.message ?? e}`; $("msg").style.color = "#e2643e"; });
