import { describe, it, expect } from 'vitest';

import {
  SNAKES_MAP,
  LADDERS_MAP,
  getCellNumber,
  getCellCoords,
  resolveSnakeLadder,
  SNAKE_BOARD_SIZE,
} from '../src/game-engine/snakeLadder';
import { applyRollDice, createGameDocument, GameContext } from '../src/game-engine/reducer';
import { validateGameDocument } from '../src/game-engine/validation';
import { GameDocument, PlayerSlot, RoomSettings } from '../src/types';

const SETTINGS: RoomSettings = {
  maxPlayers: 2,
  turnTimeoutSeconds: 30,
  strictThreeSixRule: true,
  allowBlockades: false,
  customNamesAllowed: true,
  gameMode: 'SNAKE_LADDER',
  tokensToWin: 1,
};

const SLOTS: Record<string, PlayerSlot> = { a: 'P1', b: 'P2' };

function ctx(): GameContext {
  return { settings: SETTINGS, slotMap: SLOTS, nameMap: { a: 'Red', b: 'Green' }, now: 1000 };
}

function newGame(): GameDocument {
  return createGameDocument({
    gameId: 'g',
    roomId: 'r',
    playerOrder: ['a', 'b'],
    settings: SETTINGS,
    now: 1000,
  });
}

function withPosition(game: GameDocument, uid: string, cell: number): GameDocument {
  return { ...game, snakePositions: { ...(game.snakePositions || {}), [uid]: cell } };
}

describe('snake & ladder board tables', () => {
  it('contains only in-range, non-overlapping snakes', () => {
    for (const [head, tail] of Object.entries(SNAKES_MAP)) {
      const h = Number(head);
      expect(h).toBeGreaterThan(1);
      expect(h).toBeLessThanOrEqual(SNAKE_BOARD_SIZE);
      expect(tail).toBeGreaterThan(0);
      expect(tail).toBeLessThan(h); // a snake always goes down
    }
  });

  it('contains only in-range ladders that climb', () => {
    for (const [bottom, top] of Object.entries(LADDERS_MAP)) {
      const b = Number(bottom);
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(SNAKE_BOARD_SIZE);
      expect(top).toBeGreaterThan(b);
      expect(top).toBeLessThanOrEqual(SNAKE_BOARD_SIZE);
    }
  });

  it('never places a snake head on a ladder bottom (no double events)', () => {
    for (const bottom of Object.keys(LADDERS_MAP)) {
      expect(SNAKES_MAP[Number(bottom)]).toBeUndefined();
    }
  });

  it('resolves snakes and ladders', () => {
    expect(resolveSnakeLadder(4)).toEqual({ finalCell: 14, eventType: 'LADDER' });
    expect(resolveSnakeLadder(17)).toEqual({ finalCell: 7, eventType: 'SNAKE' });
    expect(resolveSnakeLadder(3)).toEqual({ finalCell: 3, eventType: 'NORMAL' });
  });

  it('maps every cell 1..100 to a unique grid position and back', () => {
    const seen = new Set<string>();
    for (let cell = 1; cell <= 100; cell++) {
      const [row, col] = getCellCoords(cell);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(10);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(10);
      const key = `${row},${col}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(getCellNumber(row, col)).toBe(cell);
    }
    expect(seen.size).toBe(100);
  });

  it('puts cell 1 bottom-left and cell 100 top-left (classic boustrophedon)', () => {
    expect(getCellCoords(1)).toEqual([9, 0]);
    expect(getCellCoords(10)).toEqual([9, 9]);
    expect(getCellCoords(11)).toEqual([8, 9]);
    expect(getCellCoords(100)).toEqual([0, 0]);
  });
});

describe('snake & ladder dice rolls', () => {
  it('starts every player on cell 1', () => {
    const game = newGame();
    expect(game.snakePositions).toEqual({ a: 1, b: 1 });
    expect(validateGameDocument(game)).toEqual([]);
  });

  it('climbs a ladder', () => {
    const game = withPosition(newGame(), 'a', 1);
    const res = applyRollDice(game, ctx(), 'a', 3); // 1 + 3 = 4 -> ladder to 14
    expect(res.game.snakePositions?.a).toBe(14);
    expect(res.game.snakeLastEvent).toEqual({ type: 'LADDER', from: 4, to: 14, uid: 'a' });
    expect(res.game.currentPlayerUid).toBe('b');
    expect(res.game.status).toBe('AWAITING_ROLL');
  });

  it('slides down a snake', () => {
    const game = withPosition(newGame(), 'a', 15);
    const res = applyRollDice(game, ctx(), 'a', 2); // 15 + 2 = 17 -> snake to 7
    expect(res.game.snakePositions?.a).toBe(7);
    expect(res.game.snakeLastEvent).toEqual({ type: 'SNAKE', from: 17, to: 7, uid: 'a' });
  });

  it('keeps the turn when a six is rolled', () => {
    const game = withPosition(newGame(), 'a', 10);
    const res = applyRollDice(game, ctx(), 'a', 6);
    expect(res.game.snakePositions?.a).toBe(16);
    expect(res.game.currentPlayerUid).toBe('a');
    expect(res.game.status).toBe('AWAITING_ROLL');
    expect(res.game.diceRolled).toBe(false);
  });

  it('refuses to overshoot 100 but still grants the extra roll on a six', () => {
    const game = withPosition(newGame(), 'a', 97);
    const res = applyRollDice(game, ctx(), 'a', 6);
    expect(res.game.snakePositions?.a).toBe(97);
    expect(res.game.currentPlayerUid).toBe('a');
    expect(res.action).toBe('SNAKE_EXCEED_100');

    const res2 = applyRollDice(game, ctx(), 'a', 5);
    expect(res2.game.snakePositions?.a).toBe(97);
    expect(res2.game.currentPlayerUid).toBe('b');
  });

  it('wins by landing exactly on 100', () => {
    const game = withPosition(newGame(), 'a', 96);
    const res = applyRollDice(game, ctx(), 'a', 4);
    expect(res.game.snakePositions?.a).toBe(100);
    expect(res.game.status).toBe('GAME_OVER');
    expect(res.game.winnerUid).toBe('a');
    expect(res.game.rankings).toHaveLength(1);
  });

  it('wins by climbing a ladder to 100', () => {
    let game = withPosition(newGame(), 'a', 76);
    let res = applyRollDice(game, ctx(), 'a', 4); // 80 -> ladder to 99
    expect(res.game.snakePositions?.a).toBe(99);
    expect(res.game.status).toBe('AWAITING_ROLL');
    expect(res.game.currentPlayerUid).toBe('b'); // non-six passes the turn

    // b takes a turn, then a finishes with an exact 1.
    res = applyRollDice(res.game, ctx(), 'b', 2);
    expect(res.game.currentPlayerUid).toBe('a');

    const win = applyRollDice(res.game, ctx(), 'a', 1);
    expect(win.game.snakePositions?.a).toBe(100);
    expect(win.game.status).toBe('GAME_OVER');
    expect(win.game.winnerUid).toBe('a');
  });

  it('never allows a token to move once the match is over', () => {
    const game = withPosition(newGame(), 'a', 96);
    const res = applyRollDice(game, ctx(), 'a', 4);
    expect(() => applyRollDice(res.game, ctx(), 'b', 3)).toThrow();
  });
});
