/**
 * Structural + transition validation for authoritative game documents.
 *
 * Used in three places:
 *   1. before a local action is applied (defensive),
 *   2. before an incoming Firestore snapshot is accepted,
 *   3. before a peer-to-peer (WebRTC DataChannel) state push is accepted.
 *
 * Without this, any peer (or anyone with the project API key) could push an
 * arbitrary "you lost" document straight into the game room.
 */

import { GameDocument, PlayerSlot, TokenZone } from '../types';
import {
  FINAL_HOME_PROGRESS,
  HOME_PATH_START_PROGRESS,
  LAST_TRACK_PROGRESS,
  TOKENS_PER_PLAYER,
} from './engine';

const VALID_STATUSES = new Set([
  'WAITING_FOR_PLAYERS',
  'READY_CHECK',
  'STARTING',
  'AWAITING_ROLL',
  'DICE_ROLLED',
  'AWAITING_TOKEN_SELECTION',
  'MOVING_TOKEN',
  'RESOLVING_CAPTURE',
  'EXTRA_ROLL',
  'PLAYER_FINISHED',
  'GAME_OVER',
  'REMATCH',
]);

const VALID_ZONES = new Set<TokenZone>(['YARD', 'TRACK', 'HOME_PATH', 'HOME']);
const VALID_SLOTS = new Set<PlayerSlot>(['P1', 'P2', 'P3', 'P4']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the *shape* of a game document. Returns a list of problems ([] = valid). */
export function validateGameDocument(doc: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(doc)) return ['not-an-object'];

  const g = doc as Partial<GameDocument>;

  if (typeof g.gameId !== 'string' || g.gameId.length === 0) problems.push('bad-gameId');
  if (typeof g.roomId !== 'string' || g.roomId.length === 0) problems.push('bad-roomId');
  if (!Array.isArray(g.playerOrder) || g.playerOrder.length < 2 || g.playerOrder.length > 4) {
    problems.push('bad-playerOrder');
  } else if (new Set(g.playerOrder).size !== g.playerOrder.length) {
    problems.push('duplicate-playerOrder');
  }
  if (typeof g.currentPlayerUid !== 'string') problems.push('bad-currentPlayerUid');
  else if (Array.isArray(g.playerOrder) && !g.playerOrder.includes(g.currentPlayerUid)) {
    problems.push('currentPlayer-not-in-order');
  }
  if (typeof g.status !== 'string' || !VALID_STATUSES.has(g.status)) problems.push('bad-status');
  if (typeof g.version !== 'number' || !Number.isFinite(g.version) || g.version < 0) {
    problems.push('bad-version');
  }
  if (typeof g.turnNumber !== 'number' || !Number.isFinite(g.turnNumber) || g.turnNumber < 0) {
    problems.push('bad-turnNumber');
  }
  if (g.diceValue !== null && g.diceValue !== undefined) {
    if (!Number.isInteger(g.diceValue) || g.diceValue < 1 || g.diceValue > 6) {
      problems.push('bad-diceValue');
    }
  }
  if (typeof g.diceRolled !== 'boolean') problems.push('bad-diceRolled');
  if (typeof g.consecutiveSixes === 'number' && (g.consecutiveSixes < 0 || g.consecutiveSixes > 3)) {
    problems.push('bad-consecutiveSixes');
  }
  if (g.winnerUid !== null && g.winnerUid !== undefined) {
    if (typeof g.winnerUid !== 'string') problems.push('bad-winnerUid');
    else if (Array.isArray(g.playerOrder) && !g.playerOrder.includes(g.winnerUid)) {
      problems.push('winner-not-in-order');
    }
  }

  // Tokens
  if (!isPlainObject(g.tokens)) {
    problems.push('bad-tokens');
  } else {
    const playerOrder = Array.isArray(g.playerOrder) ? g.playerOrder : [];
    const tokenOwners = Object.keys(g.tokens);
    if (tokenOwners.length !== playerOrder.length) problems.push('token-owner-count');
    for (const uid of playerOrder) {
      const playerTokens = (g.tokens as Record<string, unknown>)[uid];
      if (!isPlainObject(playerTokens)) {
        problems.push(`bad-tokens-${uid}`);
        continue;
      }
      const keys = Object.keys(playerTokens);
      if (keys.length !== TOKENS_PER_PLAYER) problems.push(`bad-token-count-${uid}`);
      for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
        const t = playerTokens[String(i)] as Record<string, unknown> | undefined;
        if (!isPlainObject(t)) {
          problems.push(`missing-token-${uid}-${i}`);
          continue;
        }
        if (t.id !== i) problems.push(`bad-token-id-${uid}-${i}`);
        if (typeof t.zone !== 'string' || !VALID_ZONES.has(t.zone as TokenZone)) {
          problems.push(`bad-token-zone-${uid}-${i}`);
          continue;
        }
        const progress = t.progress;
        if (typeof progress !== 'number' || !Number.isFinite(progress)) {
          problems.push(`bad-token-progress-${uid}-${i}`);
          continue;
        }
        if (t.zone === 'YARD' && progress !== -1) problems.push(`yard-progress-${uid}-${i}`);
        if (t.zone === 'TRACK' && (progress < 0 || progress > LAST_TRACK_PROGRESS)) {
          problems.push(`track-progress-${uid}-${i}`);
        }
        if (t.zone === 'HOME_PATH' && (progress < HOME_PATH_START_PROGRESS || progress > FINAL_HOME_PROGRESS - 1)) {
          problems.push(`homepath-progress-${uid}-${i}`);
        }
        if (t.zone === 'HOME' && progress !== FINAL_HOME_PROGRESS) {
          problems.push(`home-progress-${uid}-${i}`);
        }
      }
    }
  }

  // Rankings
  if (g.rankings !== undefined) {
    if (!Array.isArray(g.rankings)) problems.push('bad-rankings');
    else {
      for (const r of g.rankings) {
        if (!isPlainObject(r) || typeof r.uid !== 'string' || typeof r.rank !== 'number') {
          problems.push('bad-ranking-entry');
        }
      }
    }
  }

  // Snake & ladder positions
  if (g.snakePositions !== undefined) {
    if (!isPlainObject(g.snakePositions)) problems.push('bad-snakePositions');
    else {
      for (const value of Object.values(g.snakePositions)) {
        if (typeof value !== 'number' || value < 1 || value > 100) {
          problems.push('bad-snake-position');
        }
      }
    }
  }

  return problems;
}

/** Slot map sanity check. */
export function validateSlotMap(slotMap: unknown, playerOrder: string[]): string[] {
  const problems: string[] = [];
  if (!isPlainObject(slotMap)) return ['bad-slotMap'];
  const usedSlots = new Set<PlayerSlot>();
  for (const uid of playerOrder) {
    const slot = (slotMap as Record<string, unknown>)[uid];
    if (typeof slot !== 'string' || !VALID_SLOTS.has(slot as PlayerSlot)) {
      problems.push(`bad-slot-${uid}`);
      continue;
    }
    if (usedSlots.has(slot as PlayerSlot)) problems.push(`duplicate-slot-${slot}`);
    usedSlots.add(slot as PlayerSlot);
  }
  return problems;
}

/**
 * Validates that `next` is a plausible single-step transition from `prev`.
 * Returns a list of problems ([] = acceptable).
 *
 * This intentionally validates invariants that hold for *every* legal action:
 * version increments by exactly one, the roster never changes, tokens only
 * change for the actor (+ captured opponents), etc.
 */
export function validateTransition(prev: GameDocument, next: GameDocument): string[] {
  const problems: string[] = [];

  if (prev.gameId !== next.gameId) problems.push('gameId-changed');
  if (prev.roomId !== next.roomId) problems.push('roomId-changed');
  if (next.version !== prev.version + 1) problems.push('version-not-incremented');
  if (prev.startedAt !== next.startedAt) problems.push('startedAt-changed');

  const orderChanged =
    prev.playerOrder.length !== next.playerOrder.length ||
    prev.playerOrder.some((uid, idx) => uid !== next.playerOrder[idx]);
  if (orderChanged) problems.push('playerOrder-changed');

  if (!next.playerOrder.includes(next.currentPlayerUid)) problems.push('currentPlayer-not-in-order');
  if (prev.status === 'GAME_OVER' && next.status !== 'GAME_OVER') problems.push('revived-finished-game');
  if (prev.winnerUid && next.winnerUid && prev.winnerUid !== next.winnerUid) {
    problems.push('winner-changed');
  }

  // Token roster must stay identical.
  const prevUids = Object.keys(prev.tokens).sort();
  const nextUids = Object.keys(next.tokens).sort();
  if (prevUids.length !== nextUids.length || prevUids.some((uid, idx) => uid !== nextUids[idx])) {
    problems.push('token-roster-changed');
    return problems;
  }

  // At most one player's tokens move forward; other changes must be captures
  // (a token returning to the yard).
  let advanced = 0;
  for (const uid of prevUids) {
    for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
      const before = prev.tokens[uid]?.[String(i)];
      const after = next.tokens[uid]?.[String(i)];
      if (!before || !after) continue;
      if (before.zone === after.zone && before.progress === after.progress) continue;
      const beforeRank = rankToken(before);
      const afterRank = rankToken(after);
      if (afterRank > beforeRank) {
        advanced += 1;
      } else if (!(after.zone === 'YARD' && after.progress === -1)) {
        problems.push(`illegal-token-regression-${uid}-${i}`);
      }
    }
  }
  if (advanced > 1) problems.push('multiple-tokens-advanced');

  return problems;
}

/** Yard < track/home-path < home, used to detect regressions. */
function rankToken(token: { zone: TokenZone; progress: number }): number {
  const base = token.zone === 'YARD' ? 0 : token.zone === 'TRACK' ? 100 : token.zone === 'HOME_PATH' ? 200 : 300;
  return base + (token.zone === 'YARD' ? 0 : Math.max(0, token.progress));
}

export function isGameDocumentValid(doc: unknown): boolean {
  return validateGameDocument(doc).length === 0;
}
