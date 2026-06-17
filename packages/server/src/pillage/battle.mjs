// ============================================================================
// Salt & Flags — pillage battle resolution (pure, DETERMINISTIC).
// One round = each ship executes its plotted moves sub-step by sub-step (with
// edge + ship collisions), then loaded broadsides fire down their line of sight.
// No RNG: same board + ships + plots => same script + outcome, so every client
// replays an identical cinematic. The Colyseus PillageRoom is a thin adapter.
// Runnable with: node --test
// ============================================================================

// headings: 0=N, 1=E, 2=S, 3=W
const DIR = [{ dc: 0, dr: -1 }, { dc: 1, dr: 0 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }];
const left = (h) => (h + 3) % 4;
const right = (h) => (h + 1) % 4;

export const BOARD = { w: 6, h: 9 };   // narrow channel
export const MOVES_PER_ROUND = 4;       // move slots a captain plots
export const FIRE_RANGE = 3;            // cells a broadside reaches
export const BALL_DAMAGE = 1;           // hull lost per ball that connects

function onBoard(c, r, board) { return c >= 0 && c < board.w && r >= 0 && r < board.h; }

// One plotted move from a ship's current pose. F = ahead; L/R = turn then ahead.
function applyMove(ship, mv) {
  const h = mv === "L" ? left(ship.heading) : mv === "R" ? right(ship.heading) : ship.heading;
  const d = DIR[h];
  return { col: ship.col + d.dc, row: ship.row + d.dr, heading: h };
}

// Trace a broadside from `ship` along heading `dirH`; return the id of the first
// living ship hit within range, or null.
function traceFire(ship, dirH, board, ids, cur, selfId) {
  const d = DIR[dirH];
  let c = ship.col, r = ship.row;
  for (let k = 1; k <= FIRE_RANGE; k++) {
    c += d.dc; r += d.dr;
    if (!onBoard(c, r, board)) break;
    for (const other of ids) {
      if (other === selfId) continue;
      if (cur[other].hull > 0 && cur[other].col === c && cur[other].row === r) return other;
    }
  }
  return null;
}

// Resolve one round. `ships` = { id: {col,row,heading,hull} }, `plots` =
// { id: { moves: ("F"|"L"|"R")[], firePort, fireStar } }. Returns the updated
// ships, a replay script (move frames + fire events), and any sunk ids.
export function resolveRound(board, ships, plots) {
  const ids = Object.keys(ships);
  const cur = {};
  const start = {};
  for (const id of ids) { cur[id] = { ...ships[id] }; start[id] = { ...ships[id] }; }

  const frames = [];
  const maxLen = Math.max(0, ...ids.map((id) => (plots[id]?.moves || []).length));

  for (let i = 0; i < maxLen; i++) {
    // 1) intended next pose for each ship (null = no move / blocked by edge)
    const intent = {};
    for (const id of ids) {
      const mv = (plots[id]?.moves || [])[i];
      if (!mv || cur[id].hull <= 0) { intent[id] = null; continue; }
      const nxt = applyMove(cur[id], mv);
      intent[id] = onBoard(nxt.col, nxt.row, board) ? nxt : null;
    }
    // 2) resolve collisions: a ship is blocked if its target is another ship's
    //    target, or a cell another ship currently occupies (no swaps/stacking).
    const frame = {};
    for (const id of ids) {
      const nxt = intent[id];
      let blocked = !nxt;
      if (nxt) {
        for (const other of ids) {
          if (other === id) continue;
          if (intent[other] && intent[other].col === nxt.col && intent[other].row === nxt.row) blocked = true;
          if (cur[other].col === nxt.col && cur[other].row === nxt.row) blocked = true;
        }
      }
      frame[id] = blocked
        ? { col: cur[id].col, row: cur[id].row, heading: cur[id].heading, blocked: true }
        : { col: nxt.col, row: nxt.row, heading: nxt.heading, blocked: false };
    }
    for (const id of ids) { cur[id].col = frame[id].col; cur[id].row = frame[id].row; cur[id].heading = frame[id].heading; }
    frames.push(frame);
  }

  // 3) broadsides fire (resting side sets nothing; damage applied immediately so a
  //    ship sunk by the first volley can't return fire — order is id order, stable)
  const fire = [];
  for (const id of ids) {
    if (cur[id].hull <= 0) continue;
    const p = plots[id] || {};
    for (const [side, balls] of [["port", p.firePort || 0], ["star", p.fireStar || 0]]) {
      if (balls <= 0) continue;
      const dirH = side === "port" ? left(cur[id].heading) : right(cur[id].heading);
      const target = traceFire(cur[id], dirH, board, ids, cur, id);
      if (target) {
        const dmg = balls * BALL_DAMAGE;
        cur[target].hull -= dmg;
        fire.push({ shooter: id, side, target, balls, dmg });
      } else {
        fire.push({ shooter: id, side, target: null, balls, dmg: 0 });
      }
    }
  }

  const sunk = ids.filter((id) => cur[id].hull <= 0);
  return { ships: cur, script: { start, frames, fire }, sunk };
}

// Deterministic enemy captain: turn toward the foe and sail in, firing both
// broadsides. Pure (no RNG) so resolution stays reproducible.
export function enemyPlot(board, ships, selfId, foeId, moveBudget = MOVES_PER_ROUND) {
  const foe = ships[foeId];
  let sim = { ...ships[selfId] };
  const moves = [];
  for (let i = 0; i < moveBudget; i++) {
    const dc = foe.col - sim.col, dr = foe.row - sim.row;
    const want = Math.abs(dr) >= Math.abs(dc) ? (dr < 0 ? 0 : 2) : (dc > 0 ? 1 : 3);
    const mv = sim.heading === want ? "F" : left(sim.heading) === want ? "L" : "R";
    moves.push(mv);
    const nxt = applyMove(sim, mv);
    if (onBoard(nxt.col, nxt.row, board)) sim = { ...sim, ...nxt };
  }
  return { moves, firePort: 2, fireStar: 2 };
}

// Clamp a captain's plot to what the ship can actually do this round.
export function legalizePlot(plot, wind, powder) {
  const moves = (Array.isArray(plot?.moves) ? plot.moves : [])
    .filter((m) => m === "F" || m === "L" || m === "R")
    .slice(0, Math.min(MOVES_PER_ROUND, wind));
  const firePort = Math.max(0, Math.min(Math.floor(plot?.ballsPort || 0), powder));
  const fireStar = Math.max(0, Math.min(Math.floor(plot?.ballsStar || 0), powder - firePort));
  return { moves, firePort, fireStar };
}
