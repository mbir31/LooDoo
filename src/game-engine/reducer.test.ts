import { describe, it, expect } from 'vitest';

import {
  applyRollDice,
  applyTokenMove,
  applyTurnTimeout,
  canMoveToken,
  canRoll,
  createGameDocument,
  GameContext,
  GameRuleError,
  getLegalMovesForCurrentPlayer,
} from './reducer';
import { FINAL_HOME_PROGRESS, countTokensHome, getTokensToWin } from './engine';
import { validateGameDocument, validateTransition } from './validation';
import { GameDocument, PlayerSlot, RoomSettings } from '../types';

const SETTINGS: RoomSettings = {
  maxPlayers: 4,
  turnTimeoutSeconds: 30,
  strictThreeSixRule: true,
  allowBlockades: true,
  customNamesAllowed: true,
  gameMode: 'CLASSIC',
};

const SLOTS: Record<string, PlayerSlot> = { a: 'P1', b: 'P2', c: 'P3', d: 'P4' };
const NAMES: Record<string, string> = { a: 'Red', b: 'Green', c: 'Yellow', d: 'Blue' };

function ctx(overrides: Partial<GameContext> = {}): GameContext {
  return {
    settings: SETTINGS,
    slotMap: SLOTS,
    nameMap: NAMES,
    now: 1_000_000,
    ...overrides,
  };
}

function newGame(playerOrder = ['a', 'b'], overrides: Partial<RoomSettings> = {}): GameDocument {
  return createGameDocument({
    gameId: 'g1',
    roomId: 'r1',
    playerOrder,
    settings: { ...SETTINGS, ...overrides },
    now: 1_000_000,
  });
}

/** Places a player's tokens directly (used to set up scenarios). */
function setTokens(game: GameDocument, uid: string, specs: Array<[GameDocument['tokens'][string][string]['zone'], number]>): GameDocument {
  const tokens = JSON.parse(JSON.stringify(game.tokens)) as GameDocument['tokens'];
  specs.forEach(([zone, progress], idx) => {
    tokens[uid][String(idx)] = { id: idx, zone, progress };
  });
  return { ...game, tokens };
}

describe('createGameDocument', () => {
  it('starts with every token in the yard and red to move', () => {
    const game = newGame(['a', 'b', 'c', 'd']);
    expect(game.status).toBe('AWAITING_ROLL');
    expect(game.currentPlayerUid).toBe('a');
    expect(game.diceValue).toBeNull();
    expect(game.version).toBe(1);
    expect(game.rankings).toEqual([]);
    for (const uid of game.playerOrder) {
      expect(countTokensHome(uid, game.tokens)).toBe(0);
      expect(game.stats?.[uid]).toEqual({ sixesRolled: 0, capturesMade: 0, tokensHome: 0 });
    }
  });

  it('produces a structurally valid document', () => {
    expect(validateGameDocument(newGame(['a', 'b', 'c']))).toEqual([]);
  });
});

describe('action guards', () => {
  it('only lets the current player roll once per turn', () => {
    const game = newGame();
    expect(canRoll(game, 'a')).toBe(true);
    expect(canRoll(game, 'b')).toBe(false);

    const rolled = applyRollDice(game, ctx(), 'a', 6).game;
    expect(canRoll(rolled, 'a')).toBe(false);
    expect(() => applyRollDice(rolled, ctx(), 'a', 6)).toThrow(GameRuleError);
  });

  it('rejects a roll from a player who is not on turn with a localisable code', () => {
    const game = newGame();
    try {
      applyRollDice(game, ctx(), 'b', 3);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GameRuleError);
      expect((err as GameRuleError).code).toBe('errorNotYourTurn');
    }
  });

  it('rejects invalid dice values', () => {
    const game = newGame();
    for (const bad of [0, 7, -1, 2.5, Number.NaN]) {
      expect(() => applyRollDice(game, ctx(), 'a', bad)).toThrow(GameRuleError);
    }
  });

  it('requires a rolled dice before a token can move', () => {
    const game = newGame();
    expect(canMoveToken(game, 'a', 0)).toBe(false);
    const rolled = applyRollDice(game, ctx(), 'a', 6).game;
    expect(canMoveToken(rolled, 'a', 0)).toBe(true);
    expect(canMoveToken(rolled, 'b', 0)).toBe(false);
  });

  it('rejects moving a token that is not a legal move', () => {
    const game = setTokens(newGame(), 'a', [['TRACK', 4], ['YARD', -1], ['YARD', -1], ['YARD', -1]]);
    const rolled = applyRollDice(game, ctx(), 'a', 2).game;
    // Token 0 is legal; nothing else can move with a 2.
    expect(() => applyTokenMove(rolled, ctx(), 'a', 1)).toThrow(GameRuleError);
  });

  it('refuses any action after the match is over', () => {
    let game = newGame();
    game = { ...game, status: 'GAME_OVER', winnerUid: 'a' };
    expect(() => applyRollDice(game, ctx(), 'a', 6)).toThrow(GameRuleError);
    expect(() => applyTokenMove(game, ctx(), 'a', 0)).toThrow(GameRuleError);
  });
});

describe('dice roll outcomes', () => {
  it('passes the turn when no token can move', () => {
    const game = newGame();
    const res = applyRollDice(game, ctx(), 'a', 3);
    expect(res.action).toBe('NO_LEGAL_MOVES');
    expect(res.game.currentPlayerUid).toBe('b');
    expect(res.game.status).toBe('AWAITING_ROLL');
    expect(res.game.turnNumber).toBe(2);
    expect(res.game.version).toBe(game.version + 1);
  });

  it('grants another roll when a six cannot be used', () => {
    // a has all tokens home except one blocked far away? use a yard-only board:
    const game = newGame();
    const res = applyRollDice(game, ctx(), 'a', 6);
    // from the yard a six is always playable, so force the "no move" case:
    const stuckGame = setTokens(game, 'a', [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]]);
    expect(res.legalMoves).toEqual([0, 1, 2, 3]);

    const stuckRoll = applyRollDice(stuckGame, ctx(), 'a', 6);
    expect(stuckRoll.action).toBe('DICE_ROLLED_EXTRA_NO_MOVES');
    expect(stuckRoll.game.currentPlayerUid).toBe('a');
    expect(stuckRoll.game.status).toBe('EXTRA_ROLL');
    expect(stuckRoll.game.consecutiveSixes).toBe(1);
  });

  it('cancels the turn on the third consecutive six', () => {
    let game = newGame();
    // Three sixes in a row with no legal move keeps the turn and then cancels it.
    game = applyRollDice(game, ctx(), 'a', 6).game; // rolled, awaiting selection
    // Roll 1: legal -> move out of the yard
    game = applyTokenMove(game, ctx(), 'a', 0).game;
    // Now roll 6 -> move token 0 (or release another) ... force the counter instead
    game = setTokens(game, 'a', [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]]);
    // The yard exit above already consumed the first six of the streak.
    let res = applyRollDice(game, ctx(), 'a', 6);
    expect(res.game.consecutiveSixes).toBe(2);
    res = applyRollDice(res.game, ctx(), 'a', 6);
    expect(res.action).toBe('THREE_SIX_PENALTY');
    expect(res.game.currentPlayerUid).toBe('b');
    expect(res.game.consecutiveSixes).toBe(0);
    expect(res.game.turnMessage?.type).toBe('penalty');
  });

  it('does not cancel the turn when the three-six rule is disabled', () => {
    const relaxed = ctx({ settings: { ...SETTINGS, strictThreeSixRule: false } });
    let game = newGame();
    game = setTokens(game, 'a', [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]]);
    let res = applyRollDice(game, relaxed, 'a', 6);
    res = applyRollDice(res.game, relaxed, 'a', 6);
    res = applyRollDice(res.game, relaxed, 'a', 6);
    expect(res.action).not.toBe('THREE_SIX_PENALTY');
    expect(res.game.currentPlayerUid).toBe('a');
  });

  it('resets the six counter as soon as a non-six is rolled', () => {
    let game = newGame();
    game = applyRollDice(game, ctx(), 'a', 6).game;
    game = applyTokenMove(game, ctx(), 'a', 0).game;
    expect(game.consecutiveSixes).toBe(1);
    const res = applyRollDice(game, ctx(), 'a', 2);
    expect(res.game.consecutiveSixes).toBe(0);
  });

  it('counts sixes in the match statistics', () => {
    let game = newGame();
    game = applyRollDice(game, ctx(), 'a', 6).game;
    game = applyTokenMove(game, ctx(), 'a', 0).game;
    expect(game.stats?.a.sixesRolled).toBe(1);
    game = applyRollDice(game, ctx(), 'a', 3).game;
    expect(game.stats?.a.sixesRolled).toBe(1);
  });
});

describe('token movement outcomes', () => {
  it('keeps the turn after a capture and records the statistic', () => {
    let game = newGame();
    game = setTokens(game, 'a', [['TRACK', 4], ['YARD', -1], ['YARD', -1], ['YARD', -1]]);
    game = setTokens(game, 'b', [['TRACK', 44], ['YARD', -1], ['YARD', -1], ['YARD', -1]]);
    game = applyRollDice(game, ctx(), 'a', 1).game;
    const res = applyTokenMove(game, ctx(), 'a', 0);
    expect(res.captured).toHaveLength(1);
    expect(res.game.tokens.b['0']).toEqual({ id: 0, zone: 'YARD', progress: -1 });
    expect(res.game.currentPlayerUid).toBe('a');
    expect(res.game.status).toBe('AWAITING_ROLL');
    expect(res.game.stats?.a.capturesMade).toBe(1);
    expect(res.game.lastCapturedToken).toEqual({ capturedUid: 'b', tokenId: 0 });
    expect(res.game.turnMessage?.type).toBe('capture');
  });

  it('keeps the turn when a token enters home', () => {
    let game = newGame();
    game = setTokens(game, 'a', [['HOME_PATH', 55], ['YARD', -1], ['YARD', -1], ['YARD', -1]]);
    game = applyRollDice(game, ctx(), 'a', 1).game;
    const res = applyTokenMove(game, ctx(), 'a', 0);
    expect(res.isHome).toBe(true);
    expect(res.game.currentPlayerUid).toBe('a');
    expect(res.game.stats?.a.tokensHome).toBe(1);
  });

  it('passes the turn on a plain move and clears the dice', () => {
    let game = newGame();
    game = setTokens(game, 'a', [['TRACK', 4], ['YARD', -1], ['YARD', -1], ['YARD', -1]]);
    game = applyRollDice(game, ctx(), 'a', 3).game;
    const res = applyTokenMove(game, ctx(), 'a', 0);
    expect(res.game.currentPlayerUid).toBe('b');
    expect(res.game.diceValue).toBeNull();
    expect(res.game.diceRolled).toBe(false);
    expect(res.game.status).toBe('AWAITING_ROLL');
  });

  it('declares the winner as soon as the required tokens are home', () => {
    let game = newGame(['a', 'b'], { gameMode: 'RUSH' });
    expect(getTokensToWin({ gameMode: 'RUSH' })).toBe(2);
    game = setTokens(game, 'a', [['HOME', FINAL_HOME_PROGRESS], ['HOME_PATH', 55], ['YARD', -1], ['YARD', -1]]);
    game = applyRollDice(game, ctx({ settings: { ...SETTINGS, gameMode: 'RUSH' } }), 'a', 1).game;
    const res = applyTokenMove(game, ctx({ settings: { ...SETTINGS, gameMode: 'RUSH' } }), 'a', 1);
    expect(res.action).toBe('GAME_FINISHED');
    expect(res.game.status).toBe('GAME_OVER');
    expect(res.game.winnerUid).toBe('a');
    expect(res.game.endedAt).not.toBeNull();
    expect(res.game.rankings).toHaveLength(1);
  });

  it('awards the win to the whole team in 2v2 mode', () => {
    const teamCtx = ctx({ settings: { ...SETTINGS, gameMode: 'TEAM' } });
    let game = newGame(['a', 'b', 'c', 'd'], { gameMode: 'TEAM' });
    game = setTokens(game, 'a', [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME_PATH', 55]]);
    game = setTokens(game, 'c', [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS]]);
    game = applyRollDice(game, teamCtx, 'a', 1).game;
    const res = applyTokenMove(game, teamCtx, 'a', 3);
    expect(res.winningTeam).toBe('TEAM_1');
    expect(res.game.status).toBe('GAME_OVER');
    expect(res.game.winningTeam).toBe('TEAM_1');
    // Both partners are ranked
    expect(res.game.rankings.map((r) => r.uid).sort()).toEqual(['a', 'c']);
  });

  it('does not award a team win while any partner still has tokens out', () => {
    const teamCtx = ctx({ settings: { ...SETTINGS, gameMode: 'TEAM' } });
    let game = newGame(['a', 'b', 'c', 'd'], { gameMode: 'TEAM' });
    game = setTokens(game, 'a', [['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME', FINAL_HOME_PROGRESS], ['HOME_PATH', 55]]);
    game = setTokens(game, 'c', [['TRACK', 3], ['YARD', -1], ['YARD', -1], ['YARD', -1]]);
    game = applyRollDice(game, teamCtx, 'a', 1).game;
    const res = applyTokenMove(game, teamCtx, 'a', 3);
    expect(res.winningTeam).toBeNull();
    expect(res.game.status).not.toBe('GAME_OVER');
  });
});

describe('turn timeout', () => {
  it('does nothing before the turn expires', () => {
    const game = newGame();
    expect(applyTurnTimeout(game, ctx(), 1_000_001)).toBe(game);
  });

  it('passes the turn once the window has elapsed', () => {
    const game = newGame();
    const expired = game.turnExpiresAt + 1;
    const next = applyTurnTimeout(game, ctx(), expired);
    expect(next.currentPlayerUid).toBe('b');
    expect(next.lastAction).toBe('TURN_TIMEOUT');
    expect(next.version).toBe(game.version + 1);
    expect(next.diceValue).toBeNull();
  });

  it('never touches a finished game', () => {
    const game = { ...newGame(), status: 'GAME_OVER' as const, winnerUid: 'a' };
    expect(applyTurnTimeout(game, ctx(), game.turnExpiresAt + 5000)).toBe(game);
  });
});

describe('state integrity across a transition', () => {
  it('produces documents that pass structural and transition validation', () => {
    let game = newGame(['a', 'b', 'c']);
    let res = applyRollDice(game, ctx(), 'a', 6);
    expect(validateGameDocument(res.game)).toEqual([]);
    expect(validateTransition(game, res.game)).toEqual([]);
    game = res.game;

    const moved = applyTokenMove(game, ctx(), 'a', 0);
    expect(validateGameDocument(moved.game)).toEqual([]);
    expect(validateTransition(game, moved.game)).toEqual([]);
  });

  it('always increments the version by exactly one', () => {
    let game = newGame(['a', 'b']);
    for (let i = 0; i < 6; i++) {
      const before = game.version;
      const rolled = applyRollDice(game, ctx(), game.currentPlayerUid, 6);
      expect(rolled.game.version).toBe(before + 1);
      game = rolled.game;
      const moves = getLegalMovesForCurrentPlayer(game, ctx());
      if (moves.length === 0) continue;
      const moved = applyTokenMove(game, ctx(), game.currentPlayerUid, moves[0]);
      expect(moved.game.version).toBe(before + 2);
      game = moved.game;
    }
  });
});
