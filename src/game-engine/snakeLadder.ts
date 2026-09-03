/**
 * Bangladeshi Snake & Ladders ("সাপ-লুডু") board definition.
 *
 * Lives in the game-engine layer (not in a React component) so that the
 * online service, the offline pass-and-play screen and the AI driver all
 * resolve snakes/ladders from exactly the same table.
 */

export const SNAKE_BOARD_SIZE = 100;
export const SNAKE_START_CELL = 1;

/** head -> tail */
export const SNAKES_MAP: Record<number, number> = {
  98: 79,
  95: 75,
  93: 73,
  87: 36,
  64: 60,
  62: 19,
  54: 34,
  17: 7,
};

/** bottom -> top */
export const LADDERS_MAP: Record<number, number> = {
  4: 14,
  9: 31,
  21: 42,
  28: 84,
  51: 67,
  72: 91,
  80: 99,
};

export type SnakeLadderEventType = 'LADDER' | 'SNAKE' | 'NORMAL';

/** Resolves the destination after applying any snake or ladder. */
export function resolveSnakeLadder(cell: number): {
  finalCell: number;
  eventType: SnakeLadderEventType;
} {
  if (LADDERS_MAP[cell] !== undefined) {
    return { finalCell: LADDERS_MAP[cell], eventType: 'LADDER' };
  }
  if (SNAKES_MAP[cell] !== undefined) {
    return { finalCell: SNAKES_MAP[cell], eventType: 'SNAKE' };
  }
  return { finalCell: cell, eventType: 'NORMAL' };
}

/**
 * Board numbering used by the 10x10 UI grid.
 * Row 0 is the top row; the board snakes (boustrophedon) like a classic
 * Snakes & Ladders board: row 0 runs 100 -> 91, row 1 runs 81 -> 90, ...
 */
export function getCellNumber(row: number, col: number): number {
  const r = Math.min(9, Math.max(0, row));
  const c = Math.min(9, Math.max(0, col));
  const fromBottom = 9 - r; // 0-based row index counting from the bottom
  const base = fromBottom * 10 + 1;
  return fromBottom % 2 === 0 ? base + c : base + (9 - c);
}

/** Inverse of getCellNumber: cell number -> [row, col]. */
export function getCellCoords(cell: number): [number, number] {
  const clamped = Math.min(SNAKE_BOARD_SIZE, Math.max(1, cell));
  const fromBottom = Math.floor((clamped - 1) / 10);
  const offset = (clamped - 1) % 10;
  const col = fromBottom % 2 === 0 ? offset : 9 - offset;
  const row = 9 - fromBottom;
  return [row, col];
}
