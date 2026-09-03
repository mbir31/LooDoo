import { describe, it, expect } from 'vitest';

import {
  TRACK_LENGTH,
  TRACK_GRID_COORDINATES,
  SAFE_TRACK_INDICES,
  SLOT_START_TRACK_INDEX,
  HOME_PATH_START_PROGRESS,
  FINAL_HOME_PROGRESS,
  calculateTokenMove,
  createInitialTokens,
  getLegalMoves,
  getGlobalTrackIndex,
  getTokenGridCoordinates,
  isSafeTrackIndex,
  hasPlayerWon,
  countTokensHome,
  getNextPlayerUid,
  getTokensToWin,
  getWinningTeam,
  getTeamId,
  areTeammates,
} from './engine';
import { GameDocument, PlayerSlot, RoomSettings, TokenZone } from '../types';

const SETTINGS: RoomSettings = {
  maxPlayers: 4,
  turnTimeoutSeconds: 30,
  strictThreeSixRule: true,
  allowBlockades: false,
  customNamesAllowed: true,
  gameMode: 'CLASSIC',
};

function token(zone: TokenZone, progress: number) {
  return { id: 0, zone, progress };
}

function makeTokens(spec: Record<string, Array<[TokenZone, number]>>): GameDocument['tokens'] {
  const tokens: GameDocument['tokens'] = {};
  for (const [uid, list] of Object.entries(spec)) {
    tokens[uid] = {};
    list.forEach(([zone, progress], idx) => {
      tokens[uid][String(idx)] = { id: idx, zone, progress };
    });
  }
  return tokens;
}

const SLOTS: Record<string, PlayerSlot> = { a: 'P1', b: 'P2', c: 'P3', d: 'P4' };

describe('board geometry', () => {
  it('defines 52 unique track cells', () => {
    expect(TRACK_GRID_COORDINATES).toHaveLength(TRACK_LENGTH);
    const keys = TRACK_GRID_COORDINATES.map(([r, c]) => `${r},${c}`);
    expect(new Set(keys).size).toBe(TRACK_LENGTH);
  });

  it('places every cell inside the 15x15 grid', () => {
    for (const [r, c] of TRACK_GRID_COORDINATES) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(15);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(15);
    }
  });

  it('gives every player a distinct start 13 cells apart', () => {
    const starts = Object.values(SLOT_START_TRACK_INDEX);
    expect(new Set(starts).size).toBe(4);
    expect(starts.slice().sort((x, y) => x - y)).toEqual([0, 13, 26, 39]);
  });

  it('marks the 4 start cells and 4 star cells as safe', () => {
    expect(SAFE_TRACK_INDICES.size).toBe(8);
    for (const start of Object.values(SLOT_START_TRACK_INDEX)) {
      expect(isSafeTrackIndex(start)).toBe(true);
    }
    expect(isSafeTrackIndex(8)).toBe(true);
    expect(isSafeTrackIndex(21)).toBe(true);
    expect(isSafeTrackIndex(34)).toBe(true);
    expect(isSafeTrackIndex(47)).toBe(true);
    expect(isSafeTrackIndex(1)).toBe(false);
  });

  it('wraps the shared track correctly for every player', () => {
    expect(getGlobalTrackIndex('P1', 0)).toBe(0);
    expect(getGlobalTrackIndex('P1', 51)).toBeNull(); // home stretch is not on the ring
    expect(getGlobalTrackIndex('P2', 0)).toBe(13);
    expect(getGlobalTrackIndex('P2', 39)).toBe(0); // wraps past index 51
    expect(getGlobalTrackIndex('P2', 46)).toBe(7);
    expect(getGlobalTrackIndex('P4', 13)).toBe(0);
  });

  it('maps tokens to yard / track / home-path / home coordinates', () => {
    // Yard
    expect(getTokenGridCoordinates('P3', 0, 'YARD', -1)).toEqual([1.5, 10.5]);
    // Track cell 0 for P1 is the red start square
    expect(getTokenGridCoordinates('P1', 0, 'TRACK', 0)).toEqual([13, 6]);
    // Last ring cell before the home stretch
    expect(getTokenGridCoordinates('P1', 0, 'TRACK', 50)).toEqual([14, 7]);
    // Home stretch entry
    expect(getTokenGridCoordinates('P1', 0, 'HOME_PATH', 51)).toEqual([13, 7]);
    expect(getTokenGridCoordinates('P1', 0, 'HOME_PATH', 55)).toEqual([9, 7]);
    expect(getTokenGridCoordinates('P1', 0, 'HOME', FINAL_HOME_PROGRESS)).toEqual([7, 7]);
  });

  it('keeps every home-stretch cell inside the centre arms', () => {
    for (const slot of ['P1', 'P2', 'P3', 'P4'] as PlayerSlot[]) {
      for (let p = HOME_PATH_START_PROGRESS; p < FINAL_HOME_PROGRESS; p++) {
        const [r, c] = getTokenGridCoordinates(slot, 0, 'HOME_PATH', p);
        expect(r === 7 || c === 7).toBe(true);
      }
    }
  });
});

describe('leaving the yard', () => {
  it('requires a six', () => {
    const tokens = makeTokens({ a: [['YARD', -1]] });
    const blocked = calculateTokenMove(token('YARD', -1), 'P1', 'a', 3, tokens, SLOTS, SETTINGS);
    expect(blocked.canMove).toBe(false);
    expect(blocked.reason).toMatch(/6/);
  });

  it('enters the start square on a six and grants an extra turn', () => {
    const tokens = makeTokens({ a: [['YARD', -1]] });
    const move = calculateTokenMove(token('YARD', -1), 'P1', 'a', 6, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(true);
    expect(move.newZone).toBe('TRACK');
    expect(move.newProgress).toBe(0);
    expect(move.grantsExtraTurn).toBe(true);
  });

  it('cannot capture on its own start square (start is safe)', () => {
    // P2 has a token sitting on P1's start cell (global index 0)
    const tokens = makeTokens({
      a: [['YARD', -1], ['TRACK', 10]],
      b: [['TRACK', 39]], // 13 + 39 = 52 -> 0
    });
    const move = calculateTokenMove(token('YARD', -1), 'P1', 'a', 6, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(true);
    expect(move.capturedTokens).toHaveLength(0);
  });
});

describe('movement and exact home entry', () => {
  it('advances along the track', () => {
    const tokens = makeTokens({ a: [['TRACK', 5]] });
    const move = calculateTokenMove(token('TRACK', 5), 'P1', 'a', 3, tokens, SLOTS, SETTINGS);
    expect(move.newZone).toBe('TRACK');
    expect(move.newProgress).toBe(8);
    expect(move.grantsExtraTurn).toBe(false);
  });

  it('enters the home stretch after the last ring cell', () => {
    const tokens = makeTokens({ a: [['TRACK', 49]] });
    const move = calculateTokenMove(token('TRACK', 49), 'P1', 'a', 2, tokens, SLOTS, SETTINGS);
    expect(move.newZone).toBe('HOME_PATH');
    expect(move.newProgress).toBe(HOME_PATH_START_PROGRESS);
  });

  it('accepts an exact roll into home and grants an extra turn', () => {
    const tokens = makeTokens({ a: [['HOME_PATH', 55]] });
    const move = calculateTokenMove(token('HOME_PATH', 55), 'P1', 'a', 1, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(true);
    expect(move.newZone).toBe('HOME');
    expect(move.newProgress).toBe(FINAL_HOME_PROGRESS);
    expect(move.isHome).toBe(true);
    expect(move.grantsExtraTurn).toBe(true);
  });

  it('rejects overshooting home', () => {
    const tokens = makeTokens({ a: [['HOME_PATH', 54]] });
    const move = calculateTokenMove(token('HOME_PATH', 54), 'P1', 'a', 3, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(false);
    expect(move.reason).toMatch(/Overshoots/);
  });

  it('rejects moving a token that is already home', () => {
    const tokens = makeTokens({ a: [['HOME', FINAL_HOME_PROGRESS]] });
    const move = calculateTokenMove(token('HOME', FINAL_HOME_PROGRESS), 'P1', 'a', 2, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(false);
  });

  it('never produces an out-of-range progress value for any roll', () => {
    for (let progress = -1; progress <= FINAL_HOME_PROGRESS; progress++) {
      for (let dice = 1; dice <= 6; dice++) {
        const zone: TokenZone = progress === -1 ? 'YARD' : progress >= FINAL_HOME_PROGRESS ? 'HOME' : progress >= HOME_PATH_START_PROGRESS ? 'HOME_PATH' : 'TRACK';
        const move = calculateTokenMove(token(zone, progress), 'P1', 'a', dice, makeTokens({ a: [[zone, progress]] }), SLOTS, SETTINGS);
        if (!move.canMove) continue;
        expect(move.newProgress).toBeLessThanOrEqual(FINAL_HOME_PROGRESS);
        expect(move.newProgress).toBeGreaterThanOrEqual(-1);
      }
    }
  });
});

describe('capturing', () => {
  it('captures an opponent on a non-safe cell', () => {
    // P1 progress 4 + 1 -> global 5 ; P2 progress 44 -> (13+44)%52 = 5
    const tokens = makeTokens({
      a: [['TRACK', 4]],
      b: [['TRACK', 44]],
    });
    expect(getGlobalTrackIndex('P1', 5)).toBe(getGlobalTrackIndex('P2', 44));
    const move = calculateTokenMove(token('TRACK', 4), 'P1', 'a', 1, tokens, SLOTS, SETTINGS);
    expect(move.capturedTokens).toEqual([{ uid: 'b', tokenId: 0, slot: 'P2' }]);
    expect(move.grantsExtraTurn).toBe(true);
  });

  it('does not capture on safe (star / start) cells', () => {
    // global index 8 is a star cell: P1 progress 8, P2 progress 47 -> (13+47)%52 = 8
    const tokens = makeTokens({
      a: [['TRACK', 7]],
      b: [['TRACK', 47]],
    });
    expect(isSafeTrackIndex(getGlobalTrackIndex('P1', 8)!)).toBe(true);
    const move = calculateTokenMove(token('TRACK', 7), 'P1', 'a', 1, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(true);
    expect(move.capturedTokens).toHaveLength(0);
  });

  it('captures several opponents standing on the same cell', () => {
    const tokens = makeTokens({
      a: [['TRACK', 4]],
      b: [['TRACK', 44]], // (13+44)%52 = 5
      c: [['TRACK', 31]], // (26+31)%52 = 5
    });
    const move = calculateTokenMove(token('TRACK', 4), 'P1', 'a', 1, tokens, SLOTS, SETTINGS);
    expect(move.capturedTokens.map((c) => c.uid).sort()).toEqual(['b', 'c']);
  });

  it('never captures a team-mate in TEAM mode', () => {
    const teamSettings: RoomSettings = { ...SETTINGS, gameMode: 'TEAM' };
    // P1 (a) and P3 (c) are team-mates
    const tokens = makeTokens({
      a: [['TRACK', 4]],
      c: [['TRACK', 30]],
    });
    const move = calculateTokenMove(token('TRACK', 4), 'P1', 'a', 1, tokens, SLOTS, teamSettings);
    expect(areTeammates('P1', 'P3')).toBe(true);
    expect(move.capturedTokens).toHaveLength(0);
  });
});

describe('blockades', () => {
  const blockadeSettings: RoomSettings = { ...SETTINGS, allowBlockades: true };

  it('blocks a move onto a cell occupied by two opponent tokens', () => {
    const tokens = makeTokens({
      a: [['TRACK', 4]],
      b: [['TRACK', 44], ['TRACK', 44]],
    });
    const move = calculateTokenMove(token('TRACK', 4), 'P1', 'a', 1, tokens, SLOTS, blockadeSettings);
    expect(move.canMove).toBe(false);
    expect(move.reason).toMatch(/blockade/i);
  });

  it('counts tokens from different opponents towards a blockade', () => {
    const tokens = makeTokens({
      a: [['TRACK', 4]],
      b: [['TRACK', 44]],
      c: [['TRACK', 31]],
    });
    const move = calculateTokenMove(token('TRACK', 4), 'P1', 'a', 1, tokens, SLOTS, blockadeSettings);
    expect(move.canMove).toBe(false);
  });

  it('does not block on safe cells', () => {
    const tokens = makeTokens({
      a: [['TRACK', 7]],
      b: [['TRACK', 47], ['TRACK', 47]],
    });
    const move = calculateTokenMove(token('TRACK', 7), 'P1', 'a', 1, tokens, SLOTS, blockadeSettings);
    expect(move.canMove).toBe(true);
  });

  it('is ignored when blockades are disabled', () => {
    const tokens = makeTokens({
      a: [['TRACK', 4]],
      b: [['TRACK', 44], ['TRACK', 44]],
    });
    const move = calculateTokenMove(token('TRACK', 4), 'P1', 'a', 1, tokens, SLOTS, SETTINGS);
    expect(move.canMove).toBe(true);
    expect(move.capturedTokens).toHaveLength(2);
  });
});

describe('legal move enumeration', () => {
  it('returns nothing when every token is in the yard and no six was rolled', () => {
    const tokens = createInitialTokens(['a', 'b']);
    expect(getLegalMoves('a', 'P1', 3, tokens, SLOTS, SETTINGS)).toEqual([]);
  });

  it('returns all four tokens when a six is rolled from the yard', () => {
    const tokens = createInitialTokens(['a', 'b']);
    expect(getLegalMoves('a', 'P1', 6, tokens, SLOTS, SETTINGS)).toEqual([0, 1, 2, 3]);
  });

  it('excludes home tokens and overshooting tokens', () => {
    const tokens = makeTokens({
      a: [
        ['HOME', FINAL_HOME_PROGRESS],
        ['HOME_PATH', 55],
        ['TRACK', 4],
        ['YARD', -1],
      ],
    });
    // dice 2: token 1 (55) overshoots, token 2 (4) can move, token 3 needs a 6
    expect(getLegalMoves('a', 'P1', 2, tokens, SLOTS, SETTINGS)).toEqual([2]);
  });
});

describe('victory and turn order', () => {
  it('counts tokens at home', () => {
    const tokens = makeTokens({
      a: [
        ['HOME', FINAL_HOME_PROGRESS],
        ['HOME', FINAL_HOME_PROGRESS],
        ['TRACK', 3],
        ['YARD', -1],
      ],
    });
    expect(countTokensHome('a', tokens)).toBe(2);
    expect(hasPlayerWon('a', tokens, 4)).toBe(false);
    expect(hasPlayerWon('a', tokens, 2)).toBe(true);
  });

  it('skips players who already finished when advancing the turn', () => {
    const tokens = makeTokens({
      a: [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]],
      b: [['TRACK', 1], ['YARD', -1], ['YARD', -1], ['YARD', -1]],
      c: [['TRACK', 2], ['YARD', -1], ['YARD', -1], ['YARD', -1]],
    });
    expect(getNextPlayerUid(['a', 'b', 'c'], 'a', tokens, 4)).toBe('b');
    expect(getNextPlayerUid(['a', 'b', 'c'], 'b', tokens, 4)).toBe('c');
    expect(getNextPlayerUid(['a', 'b', 'c'], 'c', tokens, 4)).toBe('b');
  });

  it('honours the reduced win condition of Rush mode', () => {
    const tokens = makeTokens({
      a: [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['TRACK', 3], ['YARD', -1]],
      b: [['TRACK', 1], ['YARD', -1], ['YARD', -1], ['YARD', -1]],
    });
    // With 2 tokens to win player "a" is done and must be skipped.
    expect(getNextPlayerUid(['a', 'b'], 'b', tokens, 2)).toBe('b');
    // With the classic 4-token rule "a" is still playing.
    expect(getNextPlayerUid(['a', 'b'], 'b', tokens, 4)).toBe('a');
  });

  it('resolves win conditions per game mode', () => {
    expect(getTokensToWin({ gameMode: 'CLASSIC' })).toBe(4);
    expect(getTokensToWin({ gameMode: 'RUSH' })).toBe(2);
    expect(getTokensToWin({ gameMode: 'SNAKE_LADDER' })).toBe(1);
    expect(getTokensToWin({ gameMode: 'CLASSIC', tokensToWin: 3 })).toBe(3);
    expect(getTokensToWin(undefined)).toBe(4);
  });

  it('only declares a team winner when both partners are finished', () => {
    const onePartnerDone = makeTokens({
      a: [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]],
      c: [['TRACK', 3], ['YARD', -1], ['YARD', -1], ['YARD', -1]],
      b: [['TRACK', 1], ['YARD', -1], ['YARD', -1], ['YARD', -1]],
    });
    expect(getWinningTeam(onePartnerDone, SLOTS, 4)).toBeNull();

    const bothDone = makeTokens({
      a: [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]],
      c: [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]],
      b: [['TRACK', 1], ['YARD', -1], ['YARD', -1], ['YARD', -1]],
    });
    expect(getWinningTeam(bothDone, SLOTS, 4)).toBe('TEAM_1');
    expect(getTeamId('P1')).toBe('TEAM_1');
    expect(getTeamId('P3')).toBe('TEAM_1');
    expect(getTeamId('P2')).toBe('TEAM_2');
    expect(getTeamId('P4')).toBe('TEAM_2');
  });
});

describe('initial tokens', () => {
  it('puts four tokens in the yard for every player', () => {
    const tokens = createInitialTokens(['a', 'b', 'c', 'd']);
    expect(Object.keys(tokens)).toEqual(['a', 'b', 'c', 'd']);
    for (const uid of Object.keys(tokens)) {
      expect(Object.keys(tokens[uid])).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        expect(tokens[uid][String(i)]).toEqual({ id: i, zone: 'YARD', progress: -1 });
      }
    }
  });
});
