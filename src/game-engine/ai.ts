/**
 * LooDoo AI ("Play Alone" bots).
 *
 * The AI is deliberately a *client* of the shared engine: it may only choose
 * among moves returned by `getLegalMoves`, so it can never perform a move the
 * rules engine would reject. The exact same module drives:
 *   - the solo "Play Alone" bots,
 *   - the "auto move" helper used when only one legal move exists.
 */

import { GameDocument, PlayerSlot } from '../types';
import {
  calculateTokenMove,
  getLegalMoves,
  getGlobalTrackIndex,
  isSafeTrackIndex,
  areTeammates,
  FINAL_HOME_PROGRESS,
  HOME_PATH_START_PROGRESS,
  TRACK_LENGTH,
} from './engine';
import { GameContext } from './reducer';

export interface AiMoveScore {
  tokenId: number;
  score: number;
  reason: string;
}

/**
 * Scores every legal move and returns the best one (higher is better).
 */
export function scoreLegalMoves(
  game: GameDocument,
  ctx: GameContext,
  uid: string,
  diceValue: number
): AiMoveScore[] {
  const slot: PlayerSlot = ctx.slotMap[uid] || 'P1';
  const legalMoves = getLegalMoves(uid, slot, diceValue, game.tokens, ctx.slotMap, ctx.settings);
  const playerTokens = game.tokens?.[uid] || {};
  const scores: AiMoveScore[] = [];

  for (const tokenId of legalMoves) {
    const token = playerTokens[String(tokenId)] ?? playerTokens[tokenId];
    if (!token) continue;

    const move = calculateTokenMove(
      token,
      slot,
      uid,
      diceValue,
      game.tokens,
      ctx.slotMap,
      ctx.settings
    );
    if (!move.canMove) continue;

    let score = 10;
    let reason = 'advance';

    // 1. Reaching home is always the best possible outcome.
    if (move.isHome || move.newProgress === FINAL_HOME_PROGRESS) {
      score = 1000;
      reason = 'home';
    }
    // 2. Capturing an opponent token.
    else if (move.capturedTokens.length > 0) {
      score = 800 + move.capturedTokens.length * 10;
      reason = 'capture';
    }
    // 3. Leaving the yard (a 6 was rolled).
    else if (token.zone === 'YARD') {
      score = 600;
      reason = 'leave-yard';
    }
    // 4. Progress along the home stretch.
    else if (move.newZone === 'HOME_PATH') {
      score = 400 + move.newProgress;
      reason = 'home-stretch';
    } else {
      // 5. Advancing on the shared ring.
      score = 60 + move.newProgress;

      const targetIdx = getGlobalTrackIndex(slot, move.newProgress);
      if (targetIdx !== null) {
        // Landing on a safe cell protects the token.
        if (isSafeTrackIndex(targetIdx)) {
          score += 120;
          reason = 'safe-cell';
        } else {
          // Penalise landing right in front of an enemy token (danger zone).
          const threat = countEnemyThreats(game, ctx, uid, slot, targetIdx);
          score -= threat * 45;
          if (threat > 0) reason = 'danger';
        }
      }

      // Moving a token that is about to enter the home stretch is valuable.
      if (move.newProgress >= HOME_PATH_START_PROGRESS - 6) {
        score += 60;
      }
      // Slight preference for the most advanced token (shortens the game).
      score += Math.max(0, move.newProgress - (token.progress || 0));
    }

    scores.push({ tokenId, score, reason });
  }

  return scores.sort((a, b) => b.score - a.score);
}

/** How many enemy tokens sit 1..6 cells *behind* `targetIdx` and could capture us. */
function countEnemyThreats(
  game: GameDocument,
  ctx: GameContext,
  uid: string,
  slot: PlayerSlot,
  targetIdx: number
): number {
  let threats = 0;
  const teamMode = ctx.settings?.gameMode === 'TEAM';
  for (const [otherUid, tokens] of Object.entries(game.tokens || {})) {
    if (otherUid === uid) continue;
    const otherSlot = ctx.slotMap[otherUid];
    if (!otherSlot) continue;
    // In 2v2 a partner can never capture us, so it must not look like a threat.
    if (teamMode && areTeammates(slot, otherSlot)) continue;
    for (const t of Object.values(tokens || {})) {
      if (!t || t.zone !== 'TRACK') continue;
      const otherIdx = getGlobalTrackIndex(otherSlot, t.progress);
      if (otherIdx === null) continue;
      const distance = (targetIdx - otherIdx + TRACK_LENGTH) % TRACK_LENGTH;
      if (distance >= 1 && distance <= 6) threats += 1;
    }
  }
  return threats;
}

/** Returns the best token to move, or null when there is no legal move. */
export function chooseBestToken(
  game: GameDocument,
  ctx: GameContext,
  uid: string,
  diceValue: number
): number | null {
  const scored = scoreLegalMoves(game, ctx, uid, diceValue);
  return scored.length > 0 ? scored[0].tokenId : null;
}
