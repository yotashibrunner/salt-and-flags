// Big-map chart renderer. Fetches the generated world and draws it on a canvas
// with drag-to-pan and wheel/pinch zoom. Deliberately a dev stub — the gritty
// charted UI (parchment, ink, brass instruments) is the Phase 3 art pass.

const SERVER = (import.meta as any).env?.VITE_SERVER ?? "http://localhost:2567";

interface Island { id: string; name: string; x: number; y: number; size: number; region: string; controllingFlag: string | null; }
interface Lane { a: string; b: string; }
interface World { width: number; height: number; islands: Island[]; lanes: Lane[]; }

const REGION_COLOR: Record<string, string> = {
  tropic: "#2f8a6a", iron: "#8a5a3a", hemp: "#7a7a3a",
  timber: "#4a6a4a", north: "#5a7a8a", storm: "#3a4a5a",
};
const FLAG_COLOR: Record<string, string> = {
  wardens: "#2fae9a", gulls: "#e2643e", iron: "#e0a93b", sash: "#b56bd8", crown: "#d6a73e",
};

const cv = document.getElementById("chart") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
let world: World;
let cam = { x: 0, y: 0, scale: 0.18 };
const byId = new Map<string, Island>();

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", () => { resize(); draw(); });

function draw() {
  if (!world) return;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  // sea
  const g = ctx.createLinearGradient(0, 0, 0, innerHeight);
  g.addColorStop(0, "#0c2630"); g.addColorStop(1, "#06141a");
  ctx.fillStyle = g; ctx.fillRect(0, 0, innerWidth, innerHeight);

  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  ctx.scale(cam.scale, cam.scale);

  // lanes
  ctx.strokeStyle = "rgba(214,167,62,.22)"; ctx.lineWidth = 1.5 / cam.scale; ctx.setLineDash([6 / cam.scale, 5 / cam.scale]);
  for (const l of world.lanes) {
    const a = byId.get(l.a)!, b = byId.get(l.b)!;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // islands
  for (const is of world.islands) {
    const col = is.controllingFlag ? (FLAG_COLOR[is.controllingFlag] ?? "#9bb") : (REGION_COLOR[is.region] ?? "#789");
    const rad = (5 + is.size * 4) / cam.scale * cam.scale + is.size * 5;
    ctx.beginPath(); ctx.arc(is.x, is.y, 6 + is.size * 5, 0, 7);
    ctx.fillStyle = col; ctx.fill();
    if (is.controllingFlag) { ctx.lineWidth = 2 / cam.scale; ctx.strokeStyle = "#ece6d4"; ctx.stroke(); }
    if (cam.scale > 0.28) {
      ctx.fillStyle = "#ece6d4";
      ctx.font = `${12 / cam.scale}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(is.name, is.x, is.y + 22 + is.size * 4);
    }
  }
  ctx.restore();

  // HUD
  ctx.fillStyle = "#ece6d4";
  ctx.font = "13px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`Salt & Flags — ${world.islands.length} islands  ·  drag to sail the chart, scroll to zoom`, 14, 24);
}

// ---- pan / zoom ----
let dragging = false, lx = 0, ly = 0;
cv.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
addEventListener("pointerup", () => dragging = false);
addEventListener("pointermove", (e) => {
  if (!dragging) return;
  cam.x -= (e.clientX - lx); cam.y -= (e.clientY - ly);
  lx = e.clientX; ly = e.clientY; draw();
});
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const before = cam.scale;
  cam.scale = Math.max(0.08, Math.min(1.2, cam.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  // zoom toward cursor
  const k = cam.scale / before;
  cam.x = (cam.x + e.clientX) * k - e.clientX;
  cam.y = (cam.y + e.clientY) * k - e.clientY;
  draw();
}, { passive: false });

async function boot() {
  resize();
  world = await (await fetch(`${SERVER}/world`)).json();
  for (const is of world.islands) byId.set(is.id, is);
  // center camera on the world
  cam.x = world.width * cam.scale / 2 - innerWidth / 2;
  cam.y = world.height * cam.scale / 2 - innerHeight / 2;
  draw();
}
boot();
