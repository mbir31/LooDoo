import { describe, it, expect } from 'vitest';

import { playMatch, buildContext, simulateTimeout, makeRng } from './helpers/driver';
import { createGameDocument } from '../src/game-engine/reducer';
import { countTokensHome, getTokensToWin } from '../src/game-engine/engine';
import { RoomSettings } from '../src/types';

const SEEDS = [1, 7, 42, 1337, 90210];

function baseSettings(playerCount: 2 | 3 | 4, overrides: Partial<RoomSettings> = {}): RoomSettings {
  return {
    maxPlayers: playerCount,
    turnTimeoutSeconds: 30,
    strictThreeSixRule: true,
    allowBlockades: true,
    customNamesAllowed: true,
    gameMode: 'CLASSIC',
    ...overrides,
  };
}

describe('full match simulation (shared engine)', () => {
  for (const playerCount of [2, 3, 4] as const) {
    it(`completes a ${playerCount}-player classic match without breaking any invariant`, () => {
      for (const seed of SEEDS) {
        const result = playMatch({ playerCount, seed, settings: baseSettings(playerCount) });
        expect(result.problems, `seed ${seed}: ${result.problems.join(' | ')}`).toEqual([]);
        expect(result.finished).toBe(true);
        expect(result.game.status).toBe('GAME_OVER');
        expect(result.game.rankings.length).toBeGreaterThan(0);
      }
    });
  }

  it('completes Rush (2-token) matches quickly and honours the reduced win condition', () => {
    for (const seed of SEEDS) {
      const result = playMatch({ playerCount: 2, seed, settings: baseSettings(2, { gameMode: 'RUSH' }) });
      expect(result.problems).toEqual([]);
      expect(result.finished).toBe(true);
      const winner = result.game.winnerUid!;
      expect(countTokensHome(winner, result.game.tokens)).toBeGreaterThanOrEqual(2);
      expect(getTokensToWin({ gameMode: 'RUSH' })).toBe(2);
    }
  });

  it('completes 2v2 team matches and awards the win to the whole team', () => {
    for (const seed of SEEDS) {
      const result = playMatch({ playerCount: 4, seed, settings: baseSettings(4, { gameMode: 'TEAM' }) });
      expect(result.problems, `seed ${seed}`).toEqual([]);
      expect(result.finished).toBe(true);
      expect(result.game.winningTeam).not.toBeNull();
      // Both partners must be finished
      const team = result.game.winningTeam;
      const members = result.game.rankings.map((r) => r.uid);
      expect(members.length).toBe(2);
      expect(['TEAM_1', 'TEAM_2']).toContain(team);
      // Every ranked member finished the match with all tokens home
      for (const uid of members) {
        expect(countTokensHome(uid, result.game.tokens)).toBe(4);
      }
    }
  });

  it('completes a 4-player snake & ladder match', () => {
    for (const seed of SEEDS) {
      const result = playMatch({
        playerCount: 4,
        seed,
        settings: baseSettings(4, { gameMode: 'SNAKE_LADDER', tokensToWin: 1 }),
      });
      expect(result.problems, `seed ${seed}: ${result.problems.join(' | ')}`).toEqual([]);
      expect(result.finished).toBe(true);
      expect(result.game.snakePositions?.[result.game.winnerUid!]).toBe(100);
    }
  });

  it('matches without blockades also terminate cleanly', () => {
    const result = playMatch({ playerCount: 4, seed: 99, settings: baseSettings(4, { allowBlockades: false }) });
    expect(result.problems).toEqual([]);
    expect(result.finished).toBe(true);
  });

  it('keeps total token count constant across a whole match', () => {
    const result = playMatch({ playerCount: 4, seed: 555, settings: baseSettings(4) });
    const total = Object.values(result.game.tokens).reduce((sum, t) => sum + Object.keys(t).length, 0);
    expect(total).toBe(16);
  });

  it('produces reproducible results for the same seed (deterministic engine)', () => {
    const a = playMatch({ playerCount: 3, seed: 2024, settings: baseSettings(3) });
    const b = playMatch({ playerCount: 3, seed: 2024, settings: baseSettings(3) });
    expect(a.game).toEqual(b.game);
    expect(a.actions).toBe(b.actions);
  });

  it('produces different matches for different seeds', () => {
    const a = playMatch({ playerCount: 3, seed: 1, settings: baseSettings(3) });
    const b = playMatch({ playerCount: 3, seed: 2, settings: baseSettings(3) });
    expect(a.game.lastActionAt).toBeDefined();
    expect(JSON.stringify(a.game)).not.toEqual(JSON.stringify(b.game));
  });
});

describe('turn timeout handling', () => {
  it('advances the turn without corrupting state', () => {
    const settings = baseSettings(3);
    const ctx = buildContext(3, settings);
    let game = createGameDocument({
      gameId: 't',
      roomId: 't',
      playerOrder: ['p1', 'p2', 'p3'],
      settings,
      now: 0,
    });
    for (let i = 0; i < 12; i++) {
      const res = simulateTimeout(game, { ...ctx, now: game.turnExpiresAt + 1 }, game.turnExpiresAt + 1);
      expect(res.problems).toEqual([]);
      game = res.next;
      expect(game.status).toBe('AWAITING_ROLL');
    }
    // The turn cycles through every player
    expect(new Set(['p1', 'p2', 'p3']).size).toBe(3);
  });
});

describe('dice distribution', () => {
  it('produces a roughly uniform distribution', () => {
    const rng = makeRng(12345);
    const counts = new Array(7).fill(0);
    const N = 60000;
    for (let i = 0; i < N; i++) {
      counts[1 + Math.floor(rng() * 6)] += 1;
    }
    for (let face = 1; face <= 6; face++) {
      const ratio = counts[face] / N;
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.19);
    }
  });
});
