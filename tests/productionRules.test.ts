import { describe, it, expect } from 'vitest';

import {
  applyForfeitTurn,
  applyRollDice,
  applyTokenMove,
  createGameDocument,
  GameContext,
} from '../src/game-engine/reducer';
import {
  computeFinalStandings,
  getNextPlayerUid,
  getTeamId,
  countTokensHome,
} from '../src/game-engine/engine';
import { GameDocument, PlayerSlot, RoomSettings } from '../src/types';

function settings(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return {
    maxPlayers: 4,
    turnTimeoutSeconds: 30,
    strictThreeSixRule: true,
    allowBlockades: false,
    customNamesAllowed: true,
    gameMode: 'CLASSIC',
    ...overrides,
  };
}

function ctxOf(overrides: Partial<GameContext> = {}): GameContext {
  const slotMap: Record<string, PlayerSlot> = { a: 'P1', b: 'P2', c: 'P3', d: 'P4' };
  return {
    settings: settings(),
    slotMap,
    nameMap: { a: 'Alpha', b: 'Beta', c: 'Gamma', d: 'Delta' },
    now: 1000,
    ...overrides,
  };
}

function game4(overrides: Partial<GameDocument> = {}): GameDocument {
  const base = createGameDocument({
    gameId: 'g',
    roomId: 'r',
    playerOrder: ['a', 'b', 'c', 'd'],
    settings: settings(),
    now: 0,
  });
  return { ...base, ...overrides };
}

describe('production rules: players leaving mid-match', () => {
  it('turn rotation never lands on a player who left', () => {
    const g = game4();
    // b and d left the room.
    expect(getNextPlayerUid(g.playerOrder, 'a', g.tokens, 4, ['b', 'd'])).toBe('c');
    expect(getNextPlayerUid(g.playerOrder, 'c', g.tokens, 4, ['b', 'd'])).toBe('a');
    expect(getNextPlayerUid(g.playerOrder, 'b', g.tokens, 4, ['b', 'd'])).toBe('c');
  });

  it('keeps the current player when everyone else is gone (no deadlock)', () => {
    const g = game4();
    expect(getNextPlayerUid(g.playerOrder, 'a', g.tokens, 4, ['b', 'c', 'd'])).toBe('a');
  });

  it('applyForfeitTurn passes the turn immediately when the turn owner leaves', () => {
    const g = game4();
    expect(g.currentPlayerUid).toBe('a');
    const next = applyForfeitTurn(g, ctxOf({ skipTurnUids: ['a'] }), 'a', 5000);
    expect(next).not.toBe(g);
    expect(next.currentPlayerUid).toBe('b');
    expect(next.diceRolled).toBe(false);
    expect(next.version).toBe(g.version + 1);
    expect(next.lastAction).toBe('PLAYER_FORFEIT_TURN');
  });

  it('applyForfeitTurn is a no-op for other players or finished games', () => {
    const g = game4();
    expect(applyForfeitTurn(g, ctxOf(), 'b', 5000)).toBe(g);

    const over = game4({ status: 'GAME_OVER', winnerUid: 'a', endedAt: 10 });
    expect(applyForfeitTurn(over, ctxOf(), 'a', 5000)).toBe(over);
  });

  it('a leaver keeps board presence: their tokens are still capturable', () => {
    // b left but their token still sits on a's landing cell.
    const g = game4();
    g.tokens['b']['0'] = { id: 0, zone: 'TRACK', progress: 4 }; // global 13+4=17
    g.tokens['a']['0'] = { id: 0, zone: 'TRACK', progress: 16 }; // one step behind? no - on global 16
    // a's start is 0 -> progress 17 lands on global 17 where b sits? b progress 4 -> global 13+4=17. a progress 17 -> global 17. Let's put a at 16 and roll 1.
    g.tokens['a']['0'] = { id: 0, zone: 'TRACK', progress: 16 };

    const ctx = ctxOf({ skipTurnUids: ['b'] }); // b is a leaver but stays in slotMap
    const rolled = applyRollDice(g, ctx, 'a', 1);
    expect(rolled.legalMoves).toContain(0);
    const moved = applyTokenMove(rolled.game, ctx, 'a', 0);
    expect(moved.captured).toEqual([{ uid: 'b', tokenId: 0, slot: 'P2' }]);
    expect(moved.game.tokens['b']['0'].zone).toBe('YARD');
    expect(moved.game.tokens['b']['0'].progress).toBe(-1);
  });
});

describe('production rules: snake & ladders three-six rule', () => {
  const snakeSettings = settings({ gameMode: 'SNAKE_LADDER', tokensToWin: 1 });

  it('a third consecutive six cancels the turn instead of rolling forever', () => {
    const g = createGameDocument({
      gameId: 's',
      roomId: 'r',
      playerOrder: ['a', 'b'],
      settings: snakeSettings,
      now: 0,
    });
    const ctx = ctxOf({ settings: snakeSettings, slotMap: { a: 'P1', b: 'P2' } });

    let state = { ...g, consecutiveSixes: 2, snakePositions: { a: 10, b: 1 } };
    const res = applyRollDice(state as GameDocument, ctx, 'a', 6);
    expect(res.action).toBe('THREE_SIX_PENALTY');
    expect(res.game.currentPlayerUid).toBe('b');
    expect(res.game.snakePositions?.a).toBe(10); // position untouched
    expect(res.game.consecutiveSixes).toBe(0);
  });

  it('two sixes still grant extra rolls in snake mode', () => {
    const g = createGameDocument({
      gameId: 's',
      roomId: 'r',
      playerOrder: ['a', 'b'],
      settings: snakeSettings,
      now: 0,
    });
    const ctx = ctxOf({ settings: snakeSettings, slotMap: { a: 'P1', b: 'P2' } });

    const state = { ...g, consecutiveSixes: 1, snakePositions: { a: 10, b: 1 } };
    const res = applyRollDice(state as GameDocument, ctx, 'a', 6);
    expect(res.action).toBe('SNAKE_MOVED_EXTRA_ROLL');
    expect(res.game.currentPlayerUid).toBe('a');
    expect(res.game.snakePositions?.a).toBe(16);
    expect(res.game.consecutiveSixes).toBe(2);
  });
});

describe('production rules: final standings & team champions', () => {
  it('computeFinalStandings ranks winners first then progress', () => {
    const g = game4({
      status: 'GAME_OVER',
      winnerUid: 'c',
      rankings: [{ uid: 'c', rank: 1, finishedAt: 100 }],
    });
    // b raced furthest after the winner, d barely started.
    (['0', '1', '2', '3'] as const).forEach((k) => {
      g.tokens['c'][k] = { id: Number(k), zone: 'HOME', progress: 56 };
    });
    g.tokens['b']['0'] = { id: 0, zone: 'HOME_PATH', progress: 53 };
    g.tokens['d']['0'] = { id: 0, zone: 'TRACK', progress: 2 };

    const standings = computeFinalStandings(g);
    expect(standings.map((s) => s.uid)).toEqual(['c', 'b', 'd', 'a']);
    expect(standings[0]).toMatchObject({ rank: 1, won: true });
    expect(standings[1]).toMatchObject({ rank: 2, won: false });
    expect(standings[3]).toMatchObject({ rank: 4, won: false });
  });

  it('both partners are champions with rank 1 in 2v2 Tag-Team', () => {
    const teamCtx = ctxOf({ settings: settings({ gameMode: 'TEAM' }) });
    const g = createGameDocument({
      gameId: 't',
      roomId: 'r',
      playerOrder: ['a', 'b', 'c', 'd'],
      settings: settings({ gameMode: 'TEAM' }),
      now: 0,
    });

    // Team 1 = a (P1) + c (P3). Bring every token home except c's last one.
    const homeToken = (id: number) => ({ id, zone: 'HOME' as const, progress: 56 });
    let state: GameDocument = {
      ...g,
      currentPlayerUid: 'c',
      tokens: {
        ...g.tokens,
        a: { '0': homeToken(0), '1': homeToken(1), '2': homeToken(2), '3': homeToken(3) },
        c: {
          '0': homeToken(0),
          '1': homeToken(1),
          '2': homeToken(2),
          '3': { id: 3, zone: 'HOME_PATH', progress: 55 }, // one step from home
        },
      },
    };

    // c rolls 1 and walks the last token home -> the whole team wins.
    const rolled = applyRollDice(state, teamCtx, 'c', 1);
    expect(rolled.legalMoves).toContain(3);
    const moved = applyTokenMove(rolled.game, teamCtx, 'c', 3);
    state = moved.game;

    expect(state.status).toBe('GAME_OVER');
    expect(state.winningTeam).toBe(getTeamId('P1'));
    expect(state.rankings).toHaveLength(2);
    // BOTH winners share rank 1 - the partner is a champion, not a runner-up.
    expect(state.rankings.every((r) => r.rank === 1)).toBe(true);

    const standings = computeFinalStandings(state);
    const winners = standings
      .filter((s) => s.won)
      .map((s) => s.uid)
      .sort();
    expect(winners).toEqual(['a', 'c']);
    expect(countTokensHome('a', state.tokens)).toBe(4);
  });

  it('snake standings order by board position', () => {
    const g = createGameDocument({
      gameId: 's',
      roomId: 'r',
      playerOrder: ['a', 'b', 'c'],
      settings: settings({ gameMode: 'SNAKE_LADDER' }),
      now: 0,
    });
    const finished: GameDocument = {
      ...g,
      gameMode: 'SNAKE_LADDER',
      status: 'GAME_OVER',
      winnerUid: 'b',
      rankings: [{ uid: 'b', rank: 1, finishedAt: 5 }],
      snakePositions: { a: 87, b: 100, c: 12 },
    };
    const standings = computeFinalStandings(finished);
    expect(standings.map((s) => s.uid)).toEqual(['b', 'a', 'c']);
  });
});
