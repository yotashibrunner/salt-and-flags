// Minimal live Market panel. Connects to the authoritative MarketRoom over
// Colyseus, renders the public order book from synced state, and shows this
// client's own balances/orders from private messages. The client only sends
// intents (placeLimit / cancel) — it never computes a price or a balance.
//
// Islands come from GET /world; picking one joins that island's market room.

import { Client, Room } from "colyseus.js";

const SERVER = (import.meta as any).env?.VITE_SERVER ?? "http://localhost:2567";

// Stable identity: a player id persisted in localStorage and sent on every join,
// so this player has one wallet across every island and across reloads.
const PLAYER_ID = (() => {
  let id = localStorage.getItem("salt.playerId");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("salt.playerId", id); }
  return id;
})();

interface Level { price: number; qty: number; }
interface RestingOrder { id: number; commodity: string; side: "buy" | "sell"; price: number; qty: number; }
interface Balances { poe: number; labor: number; holdings: Record<string, number>; orders: RestingOrder[]; stalls: string[]; pledged: boolean; myFlags: string[]; }
interface Recipe { id: string; stall: string; inputs: Record<string, number>; outputs: Record<string, number>; labor: number; }
interface Hello { playerId: string; island: string; islandName: string; region: string; commodities: string[]; produces: string[]; demands: string[]; recipes: Recipe[]; stallCost: number; flags: string[]; conquestCost: number; }
interface WorldIsland { id: string; name: string; region: string; }

const $ = (id: string) => document.getElementById(id)!;
const islandSel = $("islandsel") as HTMLSelectElement, regionEl = $("region"), meEl = $("me"), msgEl = $("msg");
const commoditySel = $("commodity") as HTMLSelectElement, tagEl = $("tag");
const flagEl = $("flag");
const lastEl = $("last"), bidsEl = $("bids"), asksEl = $("asks");
const priceEl = $("price") as HTMLInputElement, qtyEl = $("qty") as HTMLInputElement;
const poeEl = $("poe"), laborEl = $("labor"), holdingsEl = $("holdings"), myordersEl = $("myorders");
const stallsEl = $("stalls"), flagPanelEl = $("flagpanel");

const client = new Client(SERVER);
let room: Room<any> | null = null;
let commodities: string[] = [];
let recipes: Recipe[] = [];
let stallCost = 0, conquestCost = 0;
let flags: string[] = [];
let produces = new Set<string>(), demands = new Set<string>();
let balances: Balances = { poe: 0, labor: 0, holdings: {}, orders: [], stalls: [], pledged: false, myFlags: [] };
let selected = "";

function flash(text: string, isError = true) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "#e2643e" : "#5fd08a";
  if (text) setTimeout(() => { if (msgEl.textContent === text) msgEl.textContent = ""; }, 4000);
}

function renderTag() {
  tagEl.textContent = produces.has(selected) ? "· produced here (cheap)"
    : demands.has(selected) ? "· wanted here (premium)" : "";
  tagEl.style.color = produces.has(selected) ? "#5fd08a" : demands.has(selected) ? "#e2643e" : "#6f8a93";
}

function renderFlag() {
  const flag = room?.state?.flag, treasury = room?.state?.flagTreasury ?? 0, rate = room?.state?.taxRate ?? 0;
  flagEl.textContent = flag
    ? `${flag} · tax ${(rate * 100).toFixed(1)}% · treasury ${treasury} PoE`
    : "unclaimed (no tax)";

  const members = room?.state?.flagMembers ?? 0;
  if (!flag) {
    flagPanelEl.innerHTML = `<span>This island is unclaimed — no flag to pledge to.</span>`;
    return;
  }
  const share = members ? Math.floor(treasury / members) : 0;
  const opts = flags.map((f) => `<option value="${f}"${balances.myFlags.includes(f) ? " selected" : ""}>${f}${balances.myFlags.includes(f) ? " ✓" : ""}</option>`).join("");
  flagPanelEl.innerHTML = `
    <span><b>${flag}</b> · ${members} pledged · treasury <b>${treasury}</b> PoE${members ? ` · payout ≈ ${share}/member` : ""}</span>
    ${balances.pledged ? `<button class="buy" id="payout">Pay out treasury</button> <span style="color:#5fd08a">✓ pledged</span>` : ""}
    <span style="margin-left:auto">conquest:</span>
    <select id="conqflag">${opts}</select>
    <button id="pledgesel">Pledge</button>
    <button class="sell" id="seizesel">Seize this island (${conquestCost} PoE)</button>`;
  const sel = document.getElementById("conqflag") as HTMLSelectElement | null;
  const po = document.getElementById("payout");
  if (po) (po as HTMLButtonElement).onclick = () => room?.send("payout");
  const pls = document.getElementById("pledgesel");
  if (pls) (pls as HTMLButtonElement).onclick = () => room?.send("pledge", { flag: sel?.value });
  const sz = document.getElementById("seizesel");
  if (sz) (sz as HTMLButtonElement).onclick = () => room?.send("seize", { flag: sel?.value });
}

function renderBook() {
  renderFlag();
  const book = room?.state?.books?.get(selected);
  lastEl.textContent = book && book.last ? String(book.last) : "—";
  const bids: Level[] = book ? [...book.bids].map((l: any) => ({ price: l.price, qty: l.qty })) : [];
  const asks: Level[] = book ? [...book.asks].map((l: any) => ({ price: l.price, qty: l.qty })) : [];
  bidsEl.innerHTML = bids.map((l) => `<tr class="bid"><td>${l.qty}</td><td>${l.price}</td></tr>`).join("") || `<tr><td colspan=2>—</td></tr>`;
  asksEl.innerHTML = asks.map((l) => `<tr class="ask"><td>${l.price}</td><td>${l.qty}</td></tr>`).join("") || `<tr><td colspan=2>—</td></tr>`;
}

const fmt = (m: Record<string, number>) => Object.entries(m).map(([c, q]) => `${q} ${c}`).join(" + ");

function renderStalls() {
  stallsEl.innerHTML = recipes.map((r) => {
    const owned = balances.stalls.includes(r.id);
    const canRun = balances.labor >= r.labor &&
      Object.entries(r.inputs).every(([c, q]) => (balances.holdings[c] ?? 0) >= q);
    const action = owned
      ? `<button class="buy" data-run="${r.id}" ${canRun ? "" : "disabled"}>Run</button>`
      : `<button class="sell" data-build="${r.id}" ${balances.poe >= stallCost ? "" : "disabled"}>Build (${stallCost} PoE)</button>`;
    return `<div class="stall">
      <div class="name">${r.stall} ${owned ? "✓ owned" : ""}</div>
      <div class="io">${fmt(r.inputs)} + ${r.labor} labor → ${fmt(r.outputs)}</div>
      ${action}
    </div>`;
  }).join("");
  for (const btn of Array.from(stallsEl.querySelectorAll<HTMLButtonElement>("button[data-run]"))) {
    btn.onclick = () => room?.send("produce", { recipeId: btn.dataset.run });
  }
  for (const btn of Array.from(stallsEl.querySelectorAll<HTMLButtonElement>("button[data-build]"))) {
    btn.onclick = () => room?.send("build", { recipeId: btn.dataset.build });
  }
}

function renderBalances() {
  poeEl.textContent = String(balances.poe);
  laborEl.textContent = String(balances.labor);
  renderStalls(); // affordability depends on holdings + labor
  renderFlag();   // pledged status / payout button depends on balances
  holdingsEl.innerHTML = commodities
    .map((c) => `<div>${c}</div><div style="text-align:right">${balances.holdings[c] ?? 0}</div>`)
    .join("");
  myordersEl.innerHTML = balances.orders.length
    ? balances.orders
        .map((o) => `<tr><td><button class="x" data-id="${o.id}">✕</button></td><td>${o.side}</td><td>${o.commodity}</td><td style="text-align:right">${o.qty} @ ${o.price}</td></tr>`)
        .join("")
    : `<tr><td>— no resting orders —</td></tr>`;
  for (const btn of Array.from(myordersEl.querySelectorAll<HTMLButtonElement>(".x"))) {
    btn.onclick = () => room?.send("cancel", { orderId: Number(btn.dataset.id) });
  }
}

function place(side: "buy" | "sell") {
  if (!room) return;
  const price = Number(priceEl.value), qty = Number(qtyEl.value);
  if (!Number.isInteger(price) || price <= 0 || !Number.isInteger(qty) || qty <= 0) {
    return flash("price and qty must be positive whole numbers");
  }
  room.send("placeLimit", { commodity: selected, side, price, qty });
}

async function joinIsland(islandId: string) {
  if (room) { try { await room.leave(); } catch { /* ignore */ } room = null; }
  balances = { poe: 0, labor: 0, holdings: {}, orders: [], stalls: [], pledged: false, myFlags: [] };
  renderBalances();
  try {
    room = await client.joinOrCreate("market", { island: islandId, playerId: PLAYER_ID });
  } catch (e: any) {
    return flash(`join failed: ${e?.message ?? e}`);
  }

  room.onMessage("hello", (h: Hello) => {
    regionEl.textContent = `(${h.region})`;
    meEl.textContent = h.playerId.slice(0, 8);
    commodities = h.commodities;
    recipes = h.recipes;
    stallCost = h.stallCost;
    conquestCost = h.conquestCost;
    flags = h.flags;
    produces = new Set(h.produces);
    demands = new Set(h.demands);
    commoditySel.innerHTML = commodities.map((c) => `<option value="${c}">${c}</option>`).join("");
    selected = commodities[0];
    commoditySel.value = selected;
    renderTag();
    renderBook();
    renderBalances();
  });
  room.onMessage("balances", (b: Balances) => { balances = b; renderBalances(); });
  room.onMessage("error", (e: { message: string }) => flash(e.message));
  room.onStateChange(() => renderBook());
  room.send("sync"); // request initial snapshot now handlers are attached
}

async function boot() {
  const world: { islands: WorldIsland[] } = await (await fetch(`${SERVER}/world`)).json();
  const islands = world.islands.slice().sort((a, b) => a.name.localeCompare(b.name));
  islandSel.innerHTML = islands.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");

  const wanted = new URLSearchParams(location.search).get("island");
  const start = islands.find((i) => i.id === wanted)?.id ?? islands[0]?.id;
  if (!start) return flash("no islands in world");
  islandSel.value = start;

  islandSel.onchange = () => joinIsland(islandSel.value);
  commoditySel.onchange = () => { selected = commoditySel.value; renderTag(); renderBook(); };
  ($("buy") as HTMLButtonElement).onclick = () => place("buy");
  ($("sell") as HTMLButtonElement).onclick = () => place("sell");

  await joinIsland(start);
}

boot().catch((e) => flash(`connect failed: ${e?.message ?? e}`));
