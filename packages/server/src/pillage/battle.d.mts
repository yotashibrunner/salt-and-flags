// Type declarations for battle.mjs (deterministic pillage resolution).
export interface Board { w: number; h: number; }
export type Move = "F" | "L" | "R";

export interface Ship { col: number; row: number; heading: number; hull: number; }
export interface Plot { moves: Move[]; firePort: number; fireStar: number; }

export interface MoveFrameShip { col: number; row: number; heading: number; blocked: boolean; }
export type MoveFrame = Record<string, MoveFrameShip>;
export interface FireEvent { shooter: string; side: "port" | "star"; target: string | null; balls: number; dmg: number; }
export interface Script { start: Record<string, Ship>; frames: MoveFrame[]; fire: FireEvent[]; }

export interface RoundResult {
  ships: Record<string, Ship>;
  script: Script;
  sunk: string[];
}

export const BOARD: Board;
export const MOVES_PER_ROUND: number;
export const FIRE_RANGE: number;
export const BALL_DAMAGE: number;

export function resolveRound(board: Board, ships: Record<string, Ship>, plots: Record<string, Plot>): RoundResult;
export function enemyPlot(board: Board, ships: Record<string, Ship>, selfId: string, foeId: string, moveBudget?: number): Plot;
export function legalizePlot(plot: unknown, wind: number, powder: number): Plot;
