/**
 * Deterministic Ludo / Snake & Ladders state machine.
 *
 * This module is the ONE place where a game action (roll dice, move token,
 * turn timeout) is turned into the next authoritative game document.
 * It is used by:
 *   - online multiplayer       (services/gameService)
 *   - offline pass & play      (components/room/PassAndPlayGame)
 *   - AI / "Play Alone" bots   (App bot driver + game-engine/ai)
 *
 * It is pure: same (game, action, context) => same next state. No Date.now(),
 * no Math.random(), no I/O. Timestamps and dice values are passed in by the
 * caller so that behaviour can be replayed and unit tested.
 */

import {
  GameDocument,
  PlayerSlot,
  RoomSettings,
  TeamId,
  PlayerMatchStats,
} from '../types';
import {
  calculateTokenMove,
  createInitialTokens,
  getLegalMoves,
  getNextPlayerUid,
  getTokensToWin,
  getWinningTeam,
  getTeamId,
  getTeamMemberUids,
  hasPlayerWon,
  countTokensHome,
  TOKENS_PER_PLAYER,
} from './engine';
import { SNAKES_MAP, LADDERS_MAP } from './snakeLadder';

export type TurnMessageType = 'info' | 'penalty' | 'capture' | 'six' | 'home' | 'win';

export interface TurnMessage {
  en: string;
  bn: string;
  type: TurnMessageType;
}

/** Everything the reducer needs to know about the surrounding room. */
export interface GameContext {
  settings: RoomSettings;
  /** uid -> board slot */
  slotMap: Record<string, PlayerSlot>;
  /** uid -> display name (used for turn messages) */
  nameMap?: Record<string, string>;
  /** Timestamp used for every `lastActionAt` / `turnStartedAt` of the transition. */
  now: number;
}

export type GameActionKind =
  | 'GAME_STARTED'
  | 'DICE_ROLLED'
  | 'NO_LEGAL_MOVES'
  | 'DICE_ROLLED_EXTRA_NO_MOVES'
  | 'THREE_SIX_PENALTY'
  | 'TOKEN_MOVED'
  | 'EXTRA_TURN_GRANTED'
  | 'TURN_PASSED'
  | 'TURN_TIMEOUT'
  | 'GAME_FINISHED'
  | 'SNAKE_MOVED'
  | 'SNAKE_MOVED_EXTRA_ROLL'
  | 'SNAKE_EXCEED_100'
  | 'SNAKE_WIN';

export interface RollResult {
  game: GameDocument;
  diceValue: number;
  legalMoves: number[];
  action: GameActionKind;
}

export interface MoveResult {
  game: GameDocument;
  action: GameActionKind;
  captured: { uid: string; tokenId: number; slot: PlayerSlot }[];
  isHome: boolean;
  grantsExtraTurn: boolean;
  winningTeam: TeamId | null;
}

/** Error carrying a translation key so the UI can localise it. */
export class GameRuleError extends Error {
  public readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'GameRuleError';
    this.code = code;
  }
}

const isSnakeLadder = (settings: RoomSettings, game: GameDocument): boolean =>
  settings.gameMode === 'SNAKE_LADDER' || game.gameMode === 'SNAKE_LADDER';

function turnTimeoutMs(settings: RoomSettings): number {
  const seconds =
    typeof settings.turnTimeoutSeconds === 'number' && settings.turnTimeoutSeconds > 0
      ? settings.turnTimeoutSeconds
      : 30;
  return seconds * 1000;
}

function displayName(ctx: GameContext, uid: string | null | undefined): string {
  if (!uid) return 'Player';
  return ctx.nameMap?.[uid] || 'Player';
}

function emptyStats(playerOrder: string[]): Record<string, PlayerMatchStats> {
  const stats: Record<string, PlayerMatchStats> = {};
  for (const uid of playerOrder) {
    stats[uid] = { sixesRolled: 0, capturesMade: 0, tokensHome: 0 };
  }
  return stats;
}

function withStats(
  game: GameDocument,
  mutator: (stats: Record<string, PlayerMatchStats>) => void
): Record<string, PlayerMatchStats> {
  const base: Record<string, PlayerMatchStats> = {};
  for (const uid of game.playerOrder) {
    base[uid] = game.stats?.[uid] ?? { sixesRolled: 0, capturesMade: 0, tokensHome: 0 };
  }
  // Preserve counters for uids that are no longer in playerOrder (defensive).
  for (const [uid, value] of Object.entries(game.stats ?? {})) {
    if (!base[uid]) base[uid] = { ...value };
  }
  mutator(base);
  return base;
}

/** Recomputes every player's "tokens home" counter from the board. */
function syncTokensHome(
  stats: Record<string, PlayerMatchStats>,
  game: GameDocument
): void {
  for (const uid of Object.keys(stats)) {
    stats[uid] = { ...stats[uid], tokensHome: countTokensHome(uid, game.tokens) };
  }
}

function bumpVersion(game: GameDocument, ctx: GameContext, action: GameActionKind): number {
  return (typeof game.version === 'number' ? game.version : 0) + 1;
}

/**
 * Creates a fresh game document. Used by room start, rematch and solo (AI) rooms.
 */
export function createGameDocument(params: {
  gameId: string;
  roomId: string;
  playerOrder: string[];
  settings: RoomSettings;
  now: number;
  turnNumber?: number;
}): GameDocument {
  const { gameId, roomId, playerOrder, settings, now } = params;
  const tokens = createInitialTokens(playerOrder);
  const timeout = turnTimeoutMs(settings);
  const snakePositions: Record<string, number> = {};
  for (const uid of playerOrder) snakePositions[uid] = 1;

  return {
    gameId,
    roomId,
    gameMode: settings.gameMode || 'CLASSIC',
    winningTeam: null,
    status: 'AWAITING_ROLL',
    playerOrder: [...playerOrder],
    currentPlayerUid: playerOrder[0],
    turnNumber: params.turnNumber ?? 1,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    turnStartedAt: now,
    turnExpiresAt: now + timeout,
    winnerUid: null,
    rankings: [],
    tokens,
    stats: emptyStats(playerOrder),
    snakePositions,
    snakeLastEvent: null,
    version: 1,
    startedAt: now,
    endedAt: null,
    lastAction: 'GAME_STARTED',
    lastActionAt: now,
    lastCapturedToken: null,
    turnMessage: {
      en: 'Game started! Red player rolls first.',
      bn: 'খেলা শুরু হয়েছে! লাল খেলোয়াড় প্রথমে চালবেন।',
      type: 'info',
    },
  };
}

/** Can `uid` legally roll the dice right now? */
export function canRoll(game: GameDocument, uid: string): boolean {
  if (!game || game.status === 'GAME_OVER' || game.winnerUid) return false;
  if (game.currentPlayerUid !== uid) return false;
  if (game.diceRolled) return false;
  return game.status === 'AWAITING_ROLL' || game.status === 'EXTRA_ROLL';
}

/** Can `uid` legally move `tokenId` right now? */
export function canMoveToken(game: GameDocument, uid: string, tokenId: number): boolean {
  if (!game || game.status === 'GAME_OVER' || game.winnerUid) return false;
  if (game.currentPlayerUid !== uid) return false;
  if (!game.diceRolled || game.diceValue === null) return false;
  if (game.status !== 'AWAITING_TOKEN_SELECTION') return false;
  return Number.isInteger(tokenId) && tokenId >= 0 && tokenId < TOKENS_PER_PLAYER;
}

/**
 * Applies a dice roll to the authoritative state.
 * Throws GameRuleError when the action is not allowed.
 */
export function applyRollDice(
  game: GameDocument,
  ctx: GameContext,
  uid: string,
  diceValue: number
): RollResult {
  if (!game) throw new GameRuleError('errorInvalidMove', 'Game not found');
  if (game.status === 'GAME_OVER' || game.winnerUid) {
    throw new GameRuleError('errorGameAlreadyStarted', 'The match is already over');
  }
  if (game.currentPlayerUid !== uid) {
    throw new GameRuleError('errorNotYourTurn');
  }
  if (game.diceRolled || (game.status !== 'AWAITING_ROLL' && game.status !== 'EXTRA_ROLL')) {
    throw new GameRuleError('errorNotYourTurn', 'Dice has already been rolled');
  }
  if (!Number.isInteger(diceValue) || diceValue < 1 || diceValue > 6) {
    throw new GameRuleError('errorInvalidMove', 'Invalid dice value');
  }

  const now = ctx.now;
  const timeout = turnTimeoutMs(ctx.settings);
  const tokensToWin = getTokensToWin(ctx.settings);

  if (isSnakeLadder(ctx.settings, game)) {
    return applySnakeRoll(game, ctx, uid, diceValue, tokensToWin);
  }

  const slot = ctx.slotMap[uid] || 'P1';
  const consecutiveSixes = diceValue === 6 ? (game.consecutiveSixes || 0) + 1 : 0;

  // Authentic Bangladeshi rule: three consecutive sixes cancel the turn.
  if (diceValue === 6 && consecutiveSixes >= 3 && ctx.settings.strictThreeSixRule) {
    const nextUid = getNextPlayerUid(game.playerOrder, uid, game.tokens, tokensToWin);
    const nextGame: GameDocument = {
      ...game,
      diceValue,
      diceRolled: false,
      consecutiveSixes: 0,
      currentPlayerUid: nextUid,
      turnNumber: game.turnNumber + 1,
      status: 'AWAITING_ROLL',
      turnStartedAt: now,
      turnExpiresAt: now + timeout,
      version: bumpVersion(game, ctx, 'THREE_SIX_PENALTY'),
      lastAction: 'THREE_SIX_PENALTY',
      lastActionAt: now,
      stats: withStats(game, (s) => {
        if (s[uid]) s[uid] = { ...s[uid], sixesRolled: s[uid].sixesRolled + 1 };
      }),
      turnMessage: {
        en: 'Three 6s in a row! Turn cancelled and passed.',
        bn: 'পরপর ৩ বার ৬! চাল বাতিল এবং পরবর্তী খেলোয়াড়ের পালা।',
        type: 'penalty',
      },
    };
    return { game: nextGame, diceValue, legalMoves: [], action: 'THREE_SIX_PENALTY' };
  }

  const legalMoves = getLegalMoves(uid, slot, diceValue, game.tokens, ctx.slotMap, ctx.settings);
  const stats = withStats(game, (s) => {
    if (diceValue === 6 && s[uid]) {
      s[uid] = { ...s[uid], sixesRolled: s[uid].sixesRolled + 1 };
    }
  });

  if (legalMoves.length === 0) {
    if (diceValue === 6) {
      const nextGame: GameDocument = {
        ...game,
        diceValue,
        diceRolled: false,
        consecutiveSixes,
        status: 'EXTRA_ROLL',
        turnStartedAt: now,
        turnExpiresAt: now + timeout,
        version: bumpVersion(game, ctx, 'DICE_ROLLED_EXTRA_NO_MOVES'),
        lastAction: 'DICE_ROLLED_EXTRA_NO_MOVES',
        lastActionAt: now,
        stats,
        turnMessage: {
          en: 'Rolled 6 with no movable tokens! Roll again.',
          bn: '৬ পড়েছে কিন্তু চালার মতো ঘুঁটি নেই! আবার চালুন।',
          type: 'six',
        },
      };
      return { game: nextGame, diceValue, legalMoves: [], action: 'DICE_ROLLED_EXTRA_NO_MOVES' };
    }

    const nextUid = getNextPlayerUid(game.playerOrder, uid, game.tokens, tokensToWin);
    const nextGame: GameDocument = {
      ...game,
      diceValue,
      diceRolled: false,
      consecutiveSixes: 0,
      currentPlayerUid: nextUid,
      turnNumber: game.turnNumber + 1,
      status: 'AWAITING_ROLL',
      turnStartedAt: now,
      turnExpiresAt: now + timeout,
      version: bumpVersion(game, ctx, 'NO_LEGAL_MOVES'),
      lastAction: 'NO_LEGAL_MOVES',
      lastActionAt: now,
      stats,
      turnMessage: {
        en: `Rolled ${diceValue}. No legal moves available. Turn passed.`,
        bn: `${diceValue} পড়েছে। চাল দেওয়ার ঘুঁটি নেই, চাল পাস হয়েছে।`,
        type: 'info',
      },
    };
    return { game: nextGame, diceValue, legalMoves: [], action: 'NO_LEGAL_MOVES' };
  }

  const nextGame: GameDocument = {
    ...game,
    diceValue,
    diceRolled: true,
    consecutiveSixes,
    status: 'AWAITING_TOKEN_SELECTION',
    turnStartedAt: now,
    turnExpiresAt: now + timeout,
    version: bumpVersion(game, ctx, 'DICE_ROLLED'),
    lastAction: 'DICE_ROLLED',
    lastActionAt: now,
    stats,
    turnMessage: {
      en: `Rolled ${diceValue}. Select a highlighted token to move.`,
      bn: `${diceValue} পড়েছে। চালার জন্য হাইলাইট করা ঘুঁটি নির্বাচন করুন।`,
      type: diceValue === 6 ? 'six' : 'info',
    },
  };
  return { game: nextGame, diceValue, legalMoves, action: 'DICE_ROLLED' };
}

/** Snake & Ladders branch of the dice roll. */
function applySnakeRoll(
  game: GameDocument,
  ctx: GameContext,
  uid: string,
  diceValue: number,
  tokensToWin: number
): RollResult {
  const now = ctx.now;
  const timeout = turnTimeoutMs(ctx.settings);
  const curPos = game.snakePositions?.[uid] ?? 1;
  const newPos = curPos + diceValue;
  const name = displayName(ctx, uid);

  if (newPos > 100) {
    // Cannot overshoot 100 - a six still grants another roll.
    const keepTurn = diceValue === 6;
    const nextUid = keepTurn ? uid : getNextPlayerUid(game.playerOrder, uid, game.tokens, tokensToWin);
    const nextGame: GameDocument = {
      ...game,
      diceValue,
      diceRolled: false,
      consecutiveSixes: keepTurn ? (game.consecutiveSixes || 0) + 1 : 0,
      currentPlayerUid: nextUid,
      turnNumber: keepTurn ? game.turnNumber : game.turnNumber + 1,
      status: 'AWAITING_ROLL',
      turnStartedAt: now,
      turnExpiresAt: now + timeout,
      version: bumpVersion(game, ctx, 'SNAKE_EXCEED_100'),
      lastAction: 'SNAKE_EXCEED_100',
      lastActionAt: now,
      turnMessage: keepTurn
        ? {
            en: 'Rolled 6! Cannot exceed 100, but 6 gives you another roll.',
            bn: '৬ পড়েছে! ১০০ অতিক্রম করা যাবে না, কিন্তু ৬ পাওয়ায় আবার চালুন।',
            type: 'six',
          }
        : {
            en: `Rolled ${diceValue}. Cannot exceed 100! Turn passed.`,
            bn: `${diceValue} পড়েছে। ১০০ অতিক্রম করা যাবে না! চাল পাস হয়েছে।`,
            type: 'penalty',
          },
    };
    return { game: nextGame, diceValue, legalMoves: [], action: 'SNAKE_EXCEED_100' };
  }

  let finalPos = newPos;
  let eventType: 'LADDER' | 'SNAKE' | 'NORMAL' = 'NORMAL';
  if (LADDERS_MAP[newPos]) {
    finalPos = LADDERS_MAP[newPos];
    eventType = 'LADDER';
  } else if (SNAKES_MAP[newPos]) {
    finalPos = SNAKES_MAP[newPos];
    eventType = 'SNAKE';
  }

  const snakePositions = { ...(game.snakePositions || {}), [uid]: finalPos };
  const snakeLastEvent = { type: eventType, from: newPos, to: finalPos, uid };

  if (finalPos === 100) {
    const nextGame: GameDocument = {
      ...game,
      diceValue,
      diceRolled: true,
      consecutiveSixes: 0,
      status: 'GAME_OVER',
      winnerUid: uid,
      rankings: [...game.rankings, { uid, rank: game.rankings.length + 1, finishedAt: now }],
      endedAt: now,
      version: bumpVersion(game, ctx, 'SNAKE_WIN'),
      lastAction: 'SNAKE_WIN',
      lastActionAt: now,
      snakePositions,
      snakeLastEvent,
      stats: syncStatsHome(game, snakePositions),
      turnMessage: {
        en: `🏆 ${name} reached 100 and WON the game!`,
        bn: `🏆 ${name} ১০০ নম্বরে পৌঁছে বিজয়ী হলেন!`,
        type: 'win',
      },
    };
    return { game: nextGame, diceValue, legalMoves: [], action: 'SNAKE_WIN' };
  }

  if (diceValue === 6) {
    const nextGame: GameDocument = {
      ...game,
      diceValue,
      diceRolled: false,
      consecutiveSixes: (game.consecutiveSixes || 0) + 1,
      status: 'AWAITING_ROLL',
      turnStartedAt: now,
      turnExpiresAt: now + timeout,
      version: bumpVersion(game, ctx, 'SNAKE_MOVED_EXTRA_ROLL'),
      lastAction: 'SNAKE_MOVED_EXTRA_ROLL',
      lastActionAt: now,
      snakePositions,
      snakeLastEvent,
      stats: syncStatsHome(game, snakePositions),
      turnMessage: {
        en: `Rolled 6! Moved to ${finalPos}. Roll again!`,
        bn: `৬ পড়েছে! ${finalPos} নম্বরে গেলেন। আবার চালুন!`,
        type: 'six',
      },
    };
    return { game: nextGame, diceValue, legalMoves: [], action: 'SNAKE_MOVED_EXTRA_ROLL' };
  }

  const nextUid = getNextPlayerUid(game.playerOrder, uid, game.tokens, tokensToWin);
  const nextGame: GameDocument = {
    ...game,
    diceValue,
    diceRolled: false,
    consecutiveSixes: 0,
    currentPlayerUid: nextUid,
    turnNumber: game.turnNumber + 1,
    status: 'AWAITING_ROLL',
    turnStartedAt: now,
    turnExpiresAt: now + timeout,
    version: bumpVersion(game, ctx, 'SNAKE_MOVED'),
    lastAction: 'SNAKE_MOVED',
    lastActionAt: now,
    snakePositions,
    snakeLastEvent,
    stats: syncStatsHome(game, snakePositions),
    turnMessage: {
      en: `${name} rolled ${diceValue} and moved to ${finalPos}.`,
      bn: `${name} ${diceValue} ফেলে ${finalPos} নম্বরে গেলেন।`,
      type: eventType === 'LADDER' ? 'home' : eventType === 'SNAKE' ? 'penalty' : 'info',
    },
  };
  return { game: nextGame, diceValue, legalMoves: [], action: 'SNAKE_MOVED' };
}

function syncStatsHome(
  game: GameDocument,
  snakePositions: Record<string, number>
): Record<string, PlayerMatchStats> {
  const base = withStats(game, () => {});
  for (const uid of Object.keys(base)) {
    base[uid] = { ...base[uid], tokensHome: snakePositions[uid] ?? 1 };
  }
  return base;
}

/**
 * Applies a token move to the authoritative state.
 * Throws GameRuleError when the move is not legal.
 */
export function applyTokenMove(
  game: GameDocument,
  ctx: GameContext,
  uid: string,
  tokenId: number
): MoveResult {
  if (!game) throw new GameRuleError('errorInvalidMove', 'Game not found');
  if (game.status === 'GAME_OVER' || game.winnerUid) {
    throw new GameRuleError('errorGameAlreadyStarted', 'The match is already over');
  }
  if (game.currentPlayerUid !== uid) {
    throw new GameRuleError('errorNotYourTurn');
  }
  if (!game.diceRolled || game.diceValue === null || game.status !== 'AWAITING_TOKEN_SELECTION') {
    throw new GameRuleError('errorInvalidMove', 'Dice not rolled');
  }

  const playerTokens = game.tokens?.[uid];
  if (!playerTokens) throw new GameRuleError('errorInvalidMove', 'Tokens not found for player');

  const token = playerTokens[String(tokenId)] ?? playerTokens[tokenId];
  if (!token) throw new GameRuleError('errorInvalidMove', 'Token does not exist');

  const slot = ctx.slotMap[uid] || 'P1';
  const moveCalc = calculateTokenMove(
    token,
    slot,
    uid,
    game.diceValue,
    game.tokens,
    ctx.slotMap,
    ctx.settings
  );

  if (!moveCalc.canMove) {
    throw new GameRuleError('errorInvalidMove', moveCalc.reason || 'Illegal move');
  }

  const now = ctx.now;
  const timeout = turnTimeoutMs(ctx.settings);
  const tokensToWin = getTokensToWin(ctx.settings);

  const tokens: GameDocument['tokens'] = {};
  for (const [pUid, pTokens] of Object.entries(game.tokens)) {
    const copy: GameDocument['tokens'][string] = {};
    for (const [key, value] of Object.entries(pTokens || {})) {
      copy[key] = { ...value };
    }
    tokens[pUid] = copy;
  }

  tokens[uid][String(tokenId)] = {
    id: tokenId,
    zone: moveCalc.newZone,
    progress: moveCalc.newProgress,
  };

  let lastCapturedToken: GameDocument['lastCapturedToken'] = null;
  for (const cap of moveCalc.capturedTokens) {
    if (!tokens[cap.uid]) continue;
    tokens[cap.uid][String(cap.tokenId)] = { id: cap.tokenId, zone: 'YARD', progress: -1 };
    lastCapturedToken = { capturedUid: cap.uid, tokenId: cap.tokenId };
  }

  const stats = withStats(game, (s) => {
    if (moveCalc.capturedTokens.length > 0 && s[uid]) {
      s[uid] = {
        ...s[uid],
        capturesMade: s[uid].capturesMade + moveCalc.capturedTokens.length,
      };
    }
  });

  const isTeamMode = ctx.settings.gameMode === 'TEAM' || game.gameMode === 'TEAM';
  const winningTeam = isTeamMode ? getWinningTeam(tokens, ctx.slotMap, tokensToWin) : null;
  const personalWin = !isTeamMode && hasPlayerWon(uid, tokens, tokensToWin);
  const isFinished = Boolean(winningTeam || personalWin);

  const baseUpdate = {
    tokens,
    lastCapturedToken,
    stats: (() => {
      const next: Record<string, PlayerMatchStats> = { ...stats };
      syncTokensHome(next, { ...game, tokens });
      return next;
    })(),
  };

  if (isFinished) {
    const finishedUids = winningTeam
      ? getTeamMemberUids(winningTeam, ctx.slotMap)
      : [uid];
    const rankings = [...game.rankings];
    for (const memberUid of finishedUids) {
      if (!rankings.some((r) => r.uid === memberUid)) {
        rankings.push({ uid: memberUid, rank: rankings.length + 1, finishedAt: now });
      }
    }

    const winnerName = winningTeam
      ? finishedUids.map((u) => displayName(ctx, u)).join(' + ')
      : displayName(ctx, uid);

    const nextGame: GameDocument = {
      ...game,
      ...baseUpdate,
      winningTeam: winningTeam ?? null,
      winnerUid: uid,
      rankings,
      status: 'GAME_OVER',
      endedAt: now,
      version: bumpVersion(game, ctx, 'GAME_FINISHED'),
      lastAction: 'GAME_FINISHED',
      lastActionAt: now,
      turnMessage: winningTeam
        ? {
            en: `🏆 Team ${winningTeam === 'TEAM_1' ? 'Red + Yellow' : 'Green + Blue'} (${winnerName}) wins the match! 🎉`,
            bn: `🏆 দল ${winningTeam === 'TEAM_1' ? 'লাল + হলুদ' : 'সবুজ + নীল'} (${winnerName}) ম্যাচ জিতেছে! 🎉`,
            type: 'win',
          }
        : {
            en: `${winnerName} won the match! 🎉`,
            bn: `${winnerName} খেলায় বিজয়ী হয়েছেন! 🎉`,
            type: 'win',
          },
    };

    return {
      game: nextGame,
      action: 'GAME_FINISHED',
      captured: moveCalc.capturedTokens,
      isHome: moveCalc.isHome,
      grantsExtraTurn: false,
      winningTeam,
    };
  }

  if (moveCalc.grantsExtraTurn) {
    const nextGame: GameDocument = {
      ...game,
      ...baseUpdate,
      diceValue: null,
      diceRolled: false,
      status: 'AWAITING_ROLL',
      turnStartedAt: now,
      turnExpiresAt: now + timeout,
      version: bumpVersion(game, ctx, 'EXTRA_TURN_GRANTED'),
      lastAction: 'EXTRA_TURN_GRANTED',
      lastActionAt: now,
      turnMessage: moveCalc.capturedTokens.length > 0
        ? {
            en: 'Captured token! Extra roll granted.',
            bn: 'ঘুঁটি কেটে অতিরিক্ত চাল পেয়েছেন!',
            type: 'capture',
          }
        : moveCalc.isHome
        ? {
            en: 'Token reached Home! Extra roll granted.',
            bn: 'ঘুঁটি ঘরে ঢুকে অতিরিক্ত চাল পেয়েছেন!',
            type: 'home',
          }
        : {
            en: 'Rolled 6! Extra roll granted.',
            bn: '৬ ফেলায় অতিরিক্ত চাল পেয়েছেন!',
            type: 'six',
          },
    };

    return {
      game: nextGame,
      action: 'EXTRA_TURN_GRANTED',
      captured: moveCalc.capturedTokens,
      isHome: moveCalc.isHome,
      grantsExtraTurn: true,
      winningTeam: null,
    };
  }

  const nextUid = getNextPlayerUid(game.playerOrder, uid, tokens, tokensToWin);
  const nextGame: GameDocument = {
    ...game,
    ...baseUpdate,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    currentPlayerUid: nextUid,
    turnNumber: game.turnNumber + 1,
    status: 'AWAITING_ROLL',
    turnStartedAt: now,
    turnExpiresAt: now + timeout,
    version: bumpVersion(game, ctx, 'TURN_PASSED'),
    lastAction: 'TURN_PASSED',
    lastActionAt: now,
    turnMessage: {
      en: `Turn passed to ${displayName(ctx, nextUid)}.`,
      bn: `${displayName(ctx, nextUid)}-এর চাল।`,
      type: 'info',
    },
  };

  return {
    game: nextGame,
    action: 'TURN_PASSED',
    captured: moveCalc.capturedTokens,
    isHome: moveCalc.isHome,
    grantsExtraTurn: false,
    winningTeam: null,
  };
}

/**
 * Applies a turn timeout. Only valid once the turn window has actually expired.
 */
export function applyTurnTimeout(game: GameDocument, ctx: GameContext, now: number): GameDocument {
  if (!game || game.status === 'GAME_OVER' || game.winnerUid) return game;
  if (typeof game.turnExpiresAt === 'number' && now < game.turnExpiresAt) return game;

  const timeout = turnTimeoutMs(ctx.settings);
  const tokensToWin = getTokensToWin(ctx.settings);
  const nextUid = getNextPlayerUid(game.playerOrder, game.currentPlayerUid, game.tokens, tokensToWin);

  return {
    ...game,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    currentPlayerUid: nextUid,
    turnNumber: game.turnNumber + 1,
    status: 'AWAITING_ROLL',
    turnStartedAt: now,
    turnExpiresAt: now + timeout,
    version: bumpVersion(game, ctx, 'TURN_TIMEOUT'),
    lastAction: 'TURN_TIMEOUT',
    lastActionAt: now,
    turnMessage: {
      en: 'Turn timed out! Passed to next player.',
      bn: 'সময় শেষ! চাল পরবর্তী খেলোয়াড়কে দেওয়া হয়েছে।',
      type: 'penalty',
    },
  };
}

/** Convenience helper used by the UI and by the AI driver. */
export function getLegalMovesForCurrentPlayer(
  game: GameDocument,
  ctx: GameContext
): number[] {
  if (!game || !game.diceRolled || game.diceValue === null) return [];
  if (isSnakeLadder(ctx.settings, game)) return [];
  const uid = game.currentPlayerUid;
  const slot = ctx.slotMap[uid] || 'P1';
  return getLegalMoves(uid, slot, game.diceValue, game.tokens, ctx.slotMap, ctx.settings);
}

/** Team-mate of `uid` in 2v2 mode (null when not applicable). */
export function getPartnerUid(uid: string, slotMap: Record<string, PlayerSlot>): string | null {
  const slot = slotMap[uid];
  if (!slot) return null;
  const team = getTeamId(slot);
  return Object.keys(slotMap).find((other) => other !== uid && getTeamId(slotMap[other]) === team) ?? null;
}
