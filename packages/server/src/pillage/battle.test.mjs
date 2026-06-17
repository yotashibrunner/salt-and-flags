import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRound, enemyPlot, legalizePlot, BOARD, MOVES_PER_ROUND } from "./battle.mjs";

const ship = (col, row, heading, hull = 16) => ({ col, row, heading, hull });
const noFire = { firePort: 0, fireStar: 0 };

test("forward move advances one cell along the heading", () => {
  const ships = { a: ship(3, 6, 0), b: ship(0, 0, 2) };
  const r = resolveRound(BOARD, ships, { a: { moves: ["F"], ...noFire }, b: { moves: [], ...noFire } });
  assert.deepEqual({ col: r.ships.a.col, row: r.ships.a.row }, { col: 3, row: 5 }, "moved north");
});

test("a turn move rotates then advances", () => {
  const ships = { a: ship(3, 6, 0), b: ship(0, 0, 2) };
  const r = resolveRound(BOARD, ships, { a: { moves: ["R"], ...noFire }, b: { moves: [], ...noFire } });
  assert.equal(r.ships.a.heading, 1, "now facing east");
  assert.deepEqual({ col: r.ships.a.col, row: r.ships.a.row }, { col: 4, row: 6 });
});

test("a move off the board is blocked (ship holds position)", () => {
  const ships = { a: ship(3, 0, 0), b: ship(0, 8, 2) }; // a at top row, facing north
  const r = resolveRound(BOARD, ships, { a: { moves: ["F"], ...noFire }, b: { moves: [], ...noFire } });
  assert.deepEqual({ col: r.ships.a.col, row: r.ships.a.row }, { col: 3, row: 0 }, "didn't sail off the edge");
  assert.equal(r.script.frames[0].a.blocked, true);
});

test("two ships cannot move into the same cell (both blocked)", () => {
  const ships = { a: ship(2, 4, 1), b: ship(4, 4, 3) }; // facing toward each other, target (3,4)
  const r = resolveRound(BOARD, ships, { a: { moves: ["F"], ...noFire }, b: { moves: ["F"], ...noFire } });
  assert.deepEqual([r.ships.a.col, r.ships.a.row], [2, 4], "a held");
  assert.deepEqual([r.ships.b.col, r.ships.b.row], [4, 4], "b held");
  assert.ok(r.script.frames[0].a.blocked && r.script.frames[0].b.blocked);
});

test("a broadside hits the first ship down its line of fire", () => {
  const ships = { a: ship(2, 4, 0), b: ship(3, 4, 0, 16) }; // a faces N -> starboard = east; b is 1 east
  const r = resolveRound(BOARD, ships, { a: { moves: [], firePort: 0, fireStar: 1 }, b: { moves: [], ...noFire } });
  assert.equal(r.ships.b.hull, 15, "b took 1 hull");
  const hit = r.script.fire.find((f) => f.shooter === "a" && f.side === "star");
  assert.equal(hit.target, "b");
  assert.equal(hit.dmg, 1);
});

test("a ship with hull <= 0 is reported sunk", () => {
  const ships = { a: ship(2, 4, 0), b: ship(3, 4, 0, 1) };
  const r = resolveRound(BOARD, ships, { a: { moves: [], firePort: 0, fireStar: 1 }, b: { moves: [], ...noFire } });
  assert.equal(r.ships.b.hull, 0);
  assert.deepEqual(r.sunk, ["b"]);
});

test("out-of-range / empty lines of fire miss", () => {
  const ships = { a: ship(0, 0, 0), b: ship(5, 8, 0) }; // far apart
  const r = resolveRound(BOARD, ships, { a: { moves: [], firePort: 2, fireStar: 2 }, b: { moves: [], ...noFire } });
  assert.equal(r.ships.b.hull, 16, "no hit");
  assert.ok(r.script.fire.every((f) => f.target === null));
});

test("resolution is deterministic: same inputs -> identical result", () => {
  const mk = () => ({ a: ship(2, 6, 0), b: ship(3, 2, 2) });
  const plots = { a: { moves: ["F", "R", "F"], firePort: 1, fireStar: 1 }, b: enemyPlot(BOARD, mk(), "b", "a") };
  const r1 = resolveRound(BOARD, mk(), plots);
  const r2 = resolveRound(BOARD, mk(), plots);
  assert.deepEqual(r1, r2);
});

test("legalizePlot clamps moves to wind and balls to powder", () => {
  const p = legalizePlot({ moves: ["F", "L", "R", "F", "F", "X"], ballsPort: 5, ballsStar: 5 }, 2, 3);
  assert.deepEqual(p.moves, ["F", "L"], "capped at wind (2) and only valid tokens");
  assert.equal(p.firePort, 3, "port took all powder");
  assert.equal(p.fireStar, 0, "none left for starboard");
});

test("enemy plot returns a full budget of legal moves aimed at the foe", () => {
  const ships = { me: ship(3, 8, 0), foe: ship(3, 1, 0) }; // foe far north
  const p = enemyPlot(BOARD, ships, "me", "foe");
  assert.equal(p.moves.length, MOVES_PER_ROUND);
  assert.ok(p.moves.every((m) => m === "F" || m === "L" || m === "R"));
});
