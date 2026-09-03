import { describe, it, expect } from 'vitest';

import {
  chooseBestToken,
  scoreLegalMoves,
} from '../src/game-engine/ai';
import {
  applyRollDice,
  applyTokenMove,
  createGameDocument,
  GameContext,
  getLegalMovesForCurrentPlayer,
} from '../src/game-engine/reducer';
import { getLegalMoves, getGlobalTrackIndex } from '../src/game-engine/engine';
import { validateGameDocument } from '../src/game-engine/validation';
import { GameDocument, RoomSettings, TokenZone } from '../src/types';
import { makeRng, rollDie } from './helpers/driver';

const UIDS = ['p1', 'p2', 'p3', 'p4'];
const SLOTS = { p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4' } as const;

function settings(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return {
    maxPlayers: 4,
    turnTimeoutSeconds: 30,
    strictThreeSixRule: true,
    allowBlockades: true,
    customNamesAllowed: true,
    gameMode: 'CLASSIC',
    ...overrides,
  } as RoomSettings;
}

function ctx(now = 0): GameContext {
  return { settings: settings(), slotMap: { ...SLOTS }, nameMap: {}, now };
}

type TokenSpec = { zone: TokenZone; progress: number };

/** Builds a 4-player game and overrides the token layout for the given players. */
function gameWithTokens(layout: Record<string, TokenSpec[]>): GameDocument {
  const base = createGameDocument({
    gameId: 'ai',
    roomId: 'ai-room',
    playerOrder: UIDS,
    settings: settings(),
    now: 0,
  });

  const tokens: GameDocument['tokens'] = {};
  for (const uid of UIDS) {
    const spec = layout[uid];
    const slot = SLOTS[uid as keyof typeof SLOTS];
    tokens[uid] = Object.fromEntries(
      Array.from({ length: 4 }, (_, id) => {
        const s = spec?.[id] ?? { zone: 'YARD' as TokenZone, progress: -1 };
        return [String(id), { id, zone: s.zone, progress: s.progress, slot }];
      })
    );
  }

  return { ...base, tokens, currentPlayerUid: 'p1' };
}

describe('AI (Play Alone bots) uses the shared rules engine', () => {
  it('only ever returns a token the engine considers legal', () => {
    // Walk a real match and re-ask the AI at every intermediate position for
    // every possible dice value: it must never invent a move.
    const rng = makeRng(2024);
    let game = createGameDocument({
      gameId: 'sweep',
      roomId: 'sweep-room',
      playerOrder: UIDS,
      settings: settings(),
      now: 0,
    });

    let now = 0;
    let checked = 0;

    for (let step = 0; step < 400 && game.status !== 'GAME_OVER'; step++) {
      now += 100;
      const c: GameContext = { ...ctx(), now };
      const uid = game.currentPlayerUid;
      const slot = SLOTS[uid as keyof typeof SLOTS];

      for (let dice = 1; dice <= 6; dice++) {
        const legal = getLegalMoves(uid, slot as never, dice, game.tokens, c.slotMap as never, c.settings);
        const choice = chooseBestToken(game, c, uid, dice);
        if (legal.length === 0) {
          expect(choice).toBeNull();
        } else {
          expect(legal).toContain(choice);
        }
        checked += 1;
      }

      const rolled = applyRollDice(game, c, uid, rollDie(rng));
      let next = rolled.game;
      if (next.status === 'AWAITING_TOKEN_SELECTION') {
        const legal = getLegalMovesForCurrentPlayer(next, c);
        if (legal.length === 0) break;
        next = applyTokenMove(next, c, uid, legal[Math.floor(rng() * legal.length)]).game;
      }
      expect(validateGameDocument(next)).toEqual([]);
      game = next;
    }

    expect(checked).toBeGreaterThan(1000);
  });

  it('returns null when no move is legal (all tokens in the yard, no six)', () => {
    const game = gameWithTokens({});
    expect(chooseBestToken(game, ctx(), 'p1', 3)).toBeNull();
    expect(chooseBestToken(game, ctx(), 'p1', 6)).not.toBeNull();
  });

  it('prefers a capture over a plain advance', () => {
    // p1 token 0 lands on global track index 9 where p2 token 0 is sitting.
    const game = gameWithTokens({
      p1: [
        { zone: 'TRACK', progress: 5 },
        { zone: 'TRACK', progress: 20 },
      ],
      p2: [{ zone: 'TRACK', progress: 48 }],
    });

    expect(getGlobalTrackIndex('P1', 5)).toBe(5);
    expect(getGlobalTrackIndex('P2', 48)).toBe(9);

    const scored = scoreLegalMoves(game, ctx(), 'p1', 4);
    expect(scored[0].tokenId).toBe(0);
    expect(scored[0].reason).toBe('capture');
    expect(chooseBestToken(game, ctx(), 'p1', 4)).toBe(0);
  });

  it('prefers finishing a token over any other move', () => {
    const game = gameWithTokens({
      p1: [
        { zone: 'TRACK', progress: 50 }, // 50 + 6 = 56 -> HOME
        { zone: 'TRACK', progress: 10 },
      ],
    });

    const scored = scoreLegalMoves(game, ctx(), 'p1', 6);
    expect(scored[0].tokenId).toBe(0);
    expect(scored[0].reason).toBe('home');
  });

  it('leaves the yard when a six is rolled and the move is accepted by the engine', () => {
    const game = gameWithTokens({});
    const rolled = applyRollDice(game, ctx(), 'p1', 6);
    expect(rolled.game.diceValue).toBe(6);
    expect(rolled.game.status).toBe('AWAITING_TOKEN_SELECTION');

    const choice = chooseBestToken(rolled.game, ctx(), 'p1', 6);
    expect(choice).not.toBeNull();

    const moved = applyTokenMove(rolled.game, ctx(), 'p1', choice!);
    expect(validateGameDocument(moved.game)).toEqual([]);
    const token = moved.game.tokens.p1[String(choice)];
    expect(token.zone).toBe('TRACK');
    expect(token.progress).toBe(0);
  });

  it('drives a whole 4-player match to a winner without an illegal move', () => {
    const rng = makeRng(99);
    let game = createGameDocument({
      gameId: 'ai-match',
      roomId: 'ai-room',
      playerOrder: UIDS,
      settings: settings(),
      now: 0,
    });

    let now = 0;
    let actions = 0;
    while (game.status !== 'GAME_OVER' && actions < 20000) {
      now += 100;
      const c: GameContext = { ...ctx(), now };
      const uid = game.currentPlayerUid;
      const rolled = applyRollDice(game, c, uid, rollDie(rng));
      let next = rolled.game;
      if (next.status === 'AWAITING_TOKEN_SELECTION') {
        const legal = getLegalMovesForCurrentPlayer(next, c);
        expect(legal.length).toBeGreaterThan(0);
        const pick = chooseBestToken(next, c, uid, next.diceValue!);
        expect(legal).toContain(pick);
        next = applyTokenMove(next, c, uid, pick!).game;
      }
      expect(validateGameDocument(next)).toEqual([]);
      game = next;
      actions += 1;
    }

    expect(game.status).toBe('GAME_OVER');
    expect(game.winnerUid).toBeTruthy();
  });

  it('does not treat a 2v2 partner as a threat', () => {
    // p1 (TEAM_1) moves to global 9; p3 is also TEAM_1 and sits within range,
    // while p2 (TEAM_2) sits far away. In team mode the AI must not panic.
    const layout = {
      p1: [{ zone: 'TRACK' as TokenZone, progress: 5 }],
      p2: [{ zone: 'TRACK' as TokenZone, progress: 30 }],
      p3: [{ zone: 'TRACK' as TokenZone, progress: 46 }], // global 7 -> 2 behind
    };

    const teamCtx: GameContext = {
      ...ctx(),
      settings: settings({ gameMode: 'TEAM' }),
    };
    const classicCtx: GameContext = { ...ctx(), settings: settings() };

    const teamScores = scoreLegalMoves(gameWithTokens(layout), teamCtx, 'p1', 4);
    const classicScores = scoreLegalMoves(gameWithTokens(layout), classicCtx, 'p1', 4);

    expect(teamScores[0].tokenId).toBe(0);
    expect(classicScores[0].tokenId).toBe(0);
    // Same landing square, but in team mode the partner is not counted as a
    // threat, so the move is rated at least as highly.
    expect(teamScores[0].score).toBeGreaterThanOrEqual(classicScores[0].score);
  });
});
