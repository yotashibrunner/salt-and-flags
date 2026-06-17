// Minimal live Market panel. Connects to the authoritative MarketRoom over
// Colyseus, renders the public order book from synced state, and shows this
// client's own balances/orders from private messages. The client only sends
// intents (placeLimit / cancel) — it never computes a price or a balance.
//
// Islands come from GET /world; picking one joins that island's market room.

import { Client, Room } from "colyseus.js";
import { getIdentity } from "./identity";

const SERVER = (import.meta as any).env?.VITE_SERVER ?? "http://localhost:2567";

// Proven identity: a secret in localStorage; the server derives our wallet id from it.
let SECRET = "";

interface Level { price: number; qty: number; }
interface RestingOrder { id: number; commodity: string; side: "buy" | "sell"; price: number; qty: number; }
interface ShipBalance { id: string; cls: string; dockedAt: string | null; voyage: { from: string; to: string; arriveAt: number } | null; cargoCap: number; hull: number; maxHull: number; hold: Record<string, number>; }
interface CrewView { id: string; name: string; coffer: number; members: number; captain: boolean; }
interface Balances { poe: number; labor: number; holdings: Record<string, number>; orders: RestingOrder[]; stalls: string[]; sites: string[]; wreck: Record<string, number>; crews: CrewView[]; ships: ShipBalance[]; pledged: boolean; myFlags: string[]; }
interface Recipe { id: string; stall: string; inputs: Record<string, number>; outputs: Record<string, number>; labor: number; }
interface Hello { playerId: string; island: string; islandName: string; region: string; commodities: string[]; produces: string[]; demands: string[]; recipes: Recipe[]; stallCost: number; flags: string[]; conquestCost: number; shipCargo: Record<string, number>; shipPrice: Record<string, number>; raws: string[]; }
interface WorldIsland { id: string; name: string; region: string; }
interface WorldLane { a: string; b: string; dist: number; }

const EMPTY_BALANCES: Balances = { poe: 0, labor: 0, holdings: {}, orders: [], stalls: [], sites: [], wreck: {}, crews: [], ships: [], pledged: false, myFlags: [] };

const $ = (id: string) => document.getElementById(id)!;
const islandSel = $("islandsel") as HTMLSelectElement, regionEl = $("region"), meEl = $("me"), msgEl = $("msg");
const commoditySel = $("commodity") as HTMLSelectElement, tagEl = $("tag");
const flagEl = $("flag");
const lastEl = $("last"), bidsEl = $("bids"), asksEl = $("asks");
const priceEl = $("price") as HTMLInputElement, qtyEl = $("qty") as HTMLInputElement;
const poeEl = $("poe"), laborEl = $("labor"), holdingsEl = $("holdings"), myordersEl = $("myorders");
const stallsEl = $("stalls"), flagPanelEl = $("flagpanel");
const fleetEl = $("fleet"), shipyardEl = $("shipyard"), sitesEl = $("sites"), salvageEl = $("salvage");
const raidBtn = $("raid") as HTMLButtonElement;
const crewsEl = $("crews"), blockadeEl = $("blockade");
const crewNameEl = $("crewname") as HTMLInputElement, crewJoinIdEl = $("crewjoinid") as HTMLInputElement, crewAmtEl = $("crewamt") as HTMLInputElement;

const client = new Client(SERVER);
let room: Room<any> | null = null;
let commodities: string[] = [];
let recipes: Recipe[] = [];
let stallCost = 0, conquestCost = 0;
let flags: string[] = [];
let produces = new Set<string>(), demands = new Set<string>();
let raws = new Set<string>();
let shipCargo: Record<string, number> = {}, shipPrice: Record<string, number> = {};
let islandName = new Map<string, string>();
let neighbors = new Map<string, string[]>(); // island -> lane-connected island ids
let balances: Balances = EMPTY_BALANCES;
let selected = "";
let island = ""; // the island this room is for

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
  renderBlockade();
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

function renderFleet() {
  const ships = balances.ships ?? [];
  fleetEl.innerHTML = ships.length ? ships.map((s) => {
    const fill = Object.values(s.hold).reduce((a, b) => a + b, 0);
    const where = s.voyage ? `⛵ at sea → ${islandName.get(s.voyage.to) ?? s.voyage.to}`
      : s.dockedAt === island ? "⚓ docked here"
      : `⚓ at ${islandName.get(s.dockedAt ?? "") ?? s.dockedAt}`;
    const hereDocked = !s.voyage && s.dockedAt === island;
    const nbrs = neighbors.get(island) ?? [];
    const sail = hereDocked && nbrs.length
      ? `<select data-dest="${s.id}">${nbrs.map((n) => `<option value="${n}">${islandName.get(n) ?? n}</option>`).join("")}</select><button data-sail="${s.id}">Sail</button>`
      : "";
    const cargo = hereDocked
      ? `<button data-load="${s.id}">Load ${selected}×${qtyEl.value}</button><button data-unload="${s.id}">Unload ${selected}×${qtyEl.value}</button>`
      : "";
    return `<div class="stall">
      <div class="name">${s.cls} · hull ${s.hull}/${s.maxHull} · ${where}</div>
      <div class="io">hold ${fill}/${s.cargoCap}: ${fmt(s.hold) || "empty"}</div>
      <div class="row" style="flex-wrap:wrap">${cargo} ${sail}</div>
    </div>`;
  }).join("") : `<div class="stall"><div class="name">No ships</div><div class="io">Buy one at the shipyard.</div></div>`;

  for (const b of Array.from(fleetEl.querySelectorAll<HTMLButtonElement>("button[data-load]")))
    b.onclick = () => room?.send("load", { shipId: b.dataset.load, commodity: selected, qty: Number(qtyEl.value) });
  for (const b of Array.from(fleetEl.querySelectorAll<HTMLButtonElement>("button[data-unload]")))
    b.onclick = () => room?.send("unload", { shipId: b.dataset.unload, commodity: selected, qty: Number(qtyEl.value) });
  for (const b of Array.from(fleetEl.querySelectorAll<HTMLButtonElement>("button[data-sail]"))) {
    const sel = fleetEl.querySelector<HTMLSelectElement>(`select[data-dest="${b.dataset.sail}"]`);
    b.onclick = () => room?.send("move", { shipId: b.dataset.sail, toIsland: sel?.value });
  }
  renderShipyard();
}

function renderShipyard() {
  shipyardEl.innerHTML = Object.entries(shipPrice)
    .map(([cls, price]) => `<button data-buy="${cls}" ${balances.poe >= price ? "" : "disabled"}>${cls} (${price})</button>`)
    .join("");
  for (const b of Array.from(shipyardEl.querySelectorAll<HTMLButtonElement>("button[data-buy]")))
    b.onclick = () => room?.send("buyShip", { cls: b.dataset.buy });
}

function renderSites() {
  const here = commodities.filter((c) => raws.has(c) && produces.has(c));
  sitesEl.innerHTML = here.length ? here.map((c) => {
    const owned = balances.sites.includes(c);
    const action = owned
      ? `<button class="buy" data-extract="${c}">Extract (labor + fee)</button>`
      : `<button class="sell" data-buildsite="${c}">Build site</button>`;
    return `<div class="stall"><div class="name">${c} ${owned ? "✓ site" : ""}</div><div class="io">renewable raw supply</div>${action}</div>`;
  }).join("") : `<div class="stall"><div class="name">No raw resources here</div></div>`;
  for (const b of Array.from(sitesEl.querySelectorAll<HTMLButtonElement>("button[data-buildsite]")))
    b.onclick = () => room?.send("buildSite", { commodity: b.dataset.buildsite });
  for (const b of Array.from(sitesEl.querySelectorAll<HTMLButtonElement>("button[data-extract]")))
    b.onclick = () => room?.send("extract", { commodity: b.dataset.extract });
}

function renderSalvage() {
  const w = Object.entries(balances.wreck ?? {});
  salvageEl.innerHTML = w.length
    ? w.map(([c, q]) => `<button data-salvage="${c}">Salvage ${q} ${c}</button>`).join("")
    : `<span style="color:#6f8a93">No wrecks washed up here.</span>`;
  for (const b of Array.from(salvageEl.querySelectorAll<HTMLButtonElement>("button[data-salvage]"))) {
    const c = b.dataset.salvage!;
    b.onclick = () => room?.send("salvage", { commodity: c, qty: balances.wreck[c] });
  }
}

function renderBlockade() {
  const meter = room?.state?.blockadeMeter ?? -1;
  if (meter >= 0) {
    const att = room!.state.blockadeAttacker as string;
    const def = (room!.state.blockadeDefender as string) || "unclaimed";
    const canPush = balances.myFlags.includes(att);
    const canDefend = room!.state.blockadeDefender && balances.myFlags.includes(room!.state.blockadeDefender);
    blockadeEl.innerHTML = `<span>⚔ <b>${att}</b> vs <b>${def}</b> — control <b>${meter}</b>/100</span>
      ${canPush ? `<button class="sell" id="bpush">Push ↑ (labor)</button>` : ""}
      ${canDefend ? `<button class="buy" id="bdefend">Defend ↓ (labor)</button>` : ""}`;
    const pu = document.getElementById("bpush"); if (pu) (pu as HTMLButtonElement).onclick = () => room?.send("blockade:push");
    const de = document.getElementById("bdefend"); if (de) (de as HTMLButtonElement).onclick = () => room?.send("blockade:defend");
  } else {
    const controller = (room?.state?.flag as string) ?? "";
    const mine = balances.myFlags.filter((f) => f !== controller);
    blockadeEl.innerHTML = mine.length
      ? `<span>Declare a blockade for:</span><select id="bflag">${mine.map((f) => `<option>${f}</option>`).join("")}</select><button class="sell" id="bdeclare">Declare blockade</button>`
      : `<span style="color:#6f8a93">Pledge to a flag that doesn't already hold this island to declare a blockade.</span>`;
    const dc = document.getElementById("bdeclare");
    if (dc) (dc as HTMLButtonElement).onclick = () => room?.send("blockade:declare", { flag: (document.getElementById("bflag") as HTMLSelectElement)?.value });
  }
}

function renderCrews() {
  const crews = balances.crews ?? [];
  crewsEl.innerHTML = crews.length ? crews.map((c) => `
    <div class="stall">
      <div class="name">${c.name} ${c.captain ? "· ⚓ captain" : ""}</div>
      <div class="io">coffer <b>${c.coffer}</b> PoE · ${c.members} crew · id <code>${c.id}</code></div>
      <div class="row">
        <button class="sell" data-deposit="${c.id}">Contribute</button>
        ${c.captain ? `<button class="buy" data-withdraw="${c.id}">Withdraw</button>` : ""}
      </div>
    </div>`).join("") : `<div class="stall"><div class="name">Not in a crew</div><div class="io">Form one or join by id.</div></div>`;
  for (const b of Array.from(crewsEl.querySelectorAll<HTMLButtonElement>("button[data-deposit]")))
    b.onclick = () => room?.send("crew:deposit", { crewId: b.dataset.deposit, amount: Number(crewAmtEl.value) });
  for (const b of Array.from(crewsEl.querySelectorAll<HTMLButtonElement>("button[data-withdraw]")))
    b.onclick = () => room?.send("crew:withdraw", { crewId: b.dataset.withdraw, amount: Number(crewAmtEl.value) });
}

function renderBalances() {
  poeEl.textContent = String(balances.poe);
  laborEl.textContent = String(balances.labor);
  renderStalls(); // affordability depends on holdings + labor
  renderSites();  // sites/extract affordability depends on balances
  renderFleet();  // ships/cargo/voyages + shipyard
  renderSalvage();
  renderCrews();
  renderBlockade();
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
  balances = EMPTY_BALANCES;
  island = islandId;
  renderBalances();
  try {
    room = await client.joinOrCreate("market", { island: islandId, secret: SECRET });
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
    raws = new Set(h.raws ?? []);
    shipCargo = h.shipCargo ?? {};
    shipPrice = h.shipPrice ?? {};
    island = h.island;
    commoditySel.innerHTML = commodities.map((c) => `<option value="${c}">${c}</option>`).join("");
    selected = commodities[0];
    commoditySel.value = selected;
    renderTag();
    renderBook();
    renderBalances();
  });
  room.onMessage("balances", (b: Balances) => { balances = b; renderBalances(); });
  room.onMessage("error", (e: { message: string }) => flash(e.message));
  // Going raiding: the server hands back the ship + locale; open the battle screen.
  room.onMessage("raid:ready", (m: { playerShipId: string; island: string }) => {
    window.open(`pillage.html?ship=${encodeURIComponent(m.playerShipId)}&island=${encodeURIComponent(m.island)}`, "_blank");
  });
  room.onStateChange(() => renderBook());
  room.send("sync"); // request initial snapshot now handlers are attached
}

async function boot() {
  ({ secret: SECRET } = await getIdentity());
  const world: { islands: WorldIsland[]; lanes: WorldLane[] } = await (await fetch(`${SERVER}/world`)).json();
  const islands = world.islands.slice().sort((a, b) => a.name.localeCompare(b.name));
  islandName = new Map(world.islands.map((i) => [i.id, i.name]));
  neighbors = new Map();
  for (const l of world.lanes ?? []) {
    if (!neighbors.has(l.a)) neighbors.set(l.a, []);
    if (!neighbors.has(l.b)) neighbors.set(l.b, []);
    neighbors.get(l.a)!.push(l.b);
    neighbors.get(l.b)!.push(l.a);
  }
  islandSel.innerHTML = islands.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");

  const wanted = new URLSearchParams(location.search).get("island");
  const start = islands.find((i) => i.id === wanted)?.id ?? islands[0]?.id;
  if (!start) return flash("no islands in world");
  islandSel.value = start;

  islandSel.onchange = () => joinIsland(islandSel.value);
  commoditySel.onchange = () => { selected = commoditySel.value; renderTag(); renderBook(); };
  ($("buy") as HTMLButtonElement).onclick = () => place("buy");
  ($("sell") as HTMLButtonElement).onclick = () => place("sell");
  raidBtn.onclick = () => room?.send("raid");
  ($("crewform") as HTMLButtonElement).onclick = () => { if (crewNameEl.value.trim()) room?.send("crew:form", { name: crewNameEl.value.trim() }); };
  ($("crewjoin") as HTMLButtonElement).onclick = () => { if (crewJoinIdEl.value.trim()) room?.send("crew:join", { crewId: crewJoinIdEl.value.trim() }); };

  await joinIsland(start);
}

boot().catch((e) => flash(`connect failed: ${e?.message ?? e}`));
