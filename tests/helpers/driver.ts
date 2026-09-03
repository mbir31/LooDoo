/**
 * Headless match driver used by the regression suite.
 *
 * It drives matches *exactly* the way the UI does:
 *   1. roll dice  -> applyRollDice
 *   2. pick token -> chooseBestToken (same helper the AI / auto-move uses)
 *   3. move       -> applyTokenMove
 *
 * Because online multiplayer, offline pass-and-play and the AI all funnel through
 * the same reducer, these simulations prove the three modes share one rule set.
 */

import { GameDocument, PlayerSlot, RoomSettings } from '../../src/types';
import {
  applyRollDice,
  applyTokenMove,
  applyTurnTimeout,
  createGameDocument,
  GameContext,
  getLegalMovesForCurrentPlayer,
} from '../../src/game-engine/reducer';
import { chooseBestToken } from '../../src/game-engine/ai';
import { validateGameDocument, validateTransition } from '../../src/game-engine/validation';
import {
  countTokensHome,
  FINAL_HOME_PROGRESS,
  getTokensToWin,
  TOKENS_PER_PLAYER,
} from '../../src/game-engine/engine';

/** Small deterministic PRNG (mulberry32) so failures can be reproduced. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollDie(rng: () => number): number {
  return 1 + Math.floor(rng() * 6);
}

export interface SimOptions {
  playerCount: 2 | 3 | 4;
  settings?: Partial<RoomSettings>;
  seed?: number;
  maxActions?: number;
  ctx?: Partial<GameContext>;
}

export interface SimResult {
  game: GameDocument;
  actions: number;
  problems: string[];
  finished: boolean;
}

const ALL_SLOTS: PlayerSlot[] = ['P1', 'P2', 'P3', 'P4'];

export function buildContext(playerCount: number, settings: RoomSettings): GameContext {
  const uids = Array.from({ length: playerCount }, (_, i) => `p${i + 1}`);
  const slotMap: Record<string, PlayerSlot> = {};
  const nameMap: Record<string, string> = {};
  uids.forEach((uid, idx) => {
    slotMap[uid] = ALL_SLOTS[idx];
    nameMap[uid] = `Player ${idx + 1}`;
  });
  return { settings, slotMap, nameMap, now: 0 };
}

/**
 * Plays a complete match. Any invariant violation is collected in `problems`
 * instead of throwing, so a single test can report everything at once.
 */
export function playMatch(options: SimOptions): SimResult {
  const { playerCount } = options;
  const settings: RoomSettings = {
    maxPlayers: playerCount,
    turnTimeoutSeconds: 30,
    strictThreeSixRule: true,
    allowBlockades: true,
    customNamesAllowed: true,
    gameMode: 'CLASSIC',
    ...options.settings,
  };

  const rng = makeRng(options.seed ?? 1);
  const uids = Array.from({ length: playerCount }, (_, i) => `p${i + 1}`);
  const problems: string[] = [];
  const isSnake = settings.gameMode === 'SNAKE_LADDER';

  let game = createGameDocument({
    gameId: 'sim',
    roomId: 'sim-room',
    playerOrder: uids,
    settings,
    now: 0,
  });

  const maxActions = options.maxActions ?? 40000;
  let actions = 0;
  let now = 0;

  while (game.status !== 'GAME_OVER' && actions < maxActions) {
    now += 100;
    const ctx: GameContext = { settings, slotMap: buildContext(playerCount, settings).slotMap, nameMap: {}, now };
    const uid = game.currentPlayerUid;

    const before = game;
    let next: GameDocument;
    try {
      const rolled = applyRollDice(game, ctx, uid, rollDie(rng));
      next = rolled.game;

      problems.push(...validateTransition(before, next).map((p) => `action ${actions} roll: ${p}`));

      if (isSnake) {
        game = next;
        actions += 1;
        continue;
      }

      if (next.status === 'AWAITING_TOKEN_SELECTION') {
        const legal = getLegalMovesForCurrentPlayer(next, ctx);
        if (legal.length === 0) {
          problems.push(`action ${actions}: awaiting selection with no legal moves`);
          break;
        }
        const choice = chooseBestToken(next, ctx, uid, next.diceValue!);
        if (choice === null || !legal.includes(choice)) {
          problems.push(`action ${actions}: AI chose an illegal token (${choice})`);
          break;
        }
        const moved = applyTokenMove(next, ctx, uid, choice);
        problems.push(...validateTransition(next, moved.game).map((p) => `action ${actions} move: ${p}`));
        next = moved.game;
      }
    } catch (err) {
      problems.push(`action ${actions}: threw ${(err as Error).message}`);
      break;
    }

    problems.push(...validateGameDocument(next).map((p) => `action ${actions}: ${p}`));

    // Invariants
    for (const p of next.playerOrder) {
      const home = countTokensHome(p, next.tokens);
      if (home > TOKENS_PER_PLAYER) problems.push(`action ${actions}: ${p} has ${home} tokens home`);
    }
    if (!isSnake) {
      const totalTokens = Object.values(next.tokens).reduce(
        (sum, tokens) => sum + Object.keys(tokens).length,
        0
      );
      if (totalTokens !== playerCount * TOKENS_PER_PLAYER) {
        problems.push(`action ${actions}: token count drifted (${totalTokens})`);
      }
      for (const p of next.playerOrder) {
        for (const t of Object.values(next.tokens[p])) {
          if (t.progress > FINAL_HOME_PROGRESS || t.progress < -1) {
            problems.push(`action ${actions}: out of range progress ${t.progress}`);
          }
        }
      }
    }
    if (next.version !== game.version + 1 && next.version !== game.version + 2) {
      problems.push(`action ${actions}: unexpected version jump ${game.version} -> ${next.version}`);
    }
    if (!next.playerOrder.includes(next.currentPlayerUid)) {
      problems.push(`action ${actions}: current player not in player order`);
    }

    game = next;
    actions += 1;
  }

  if (actions >= maxActions) {
    problems.push('match did not terminate within the action budget');
  }

  // Final state sanity
  if (game.status === 'GAME_OVER') {
    if (!game.winnerUid) problems.push('finished match has no winner');
    if (game.rankings.length === 0) problems.push('finished match has no rankings');
    if (game.endedAt === null || game.endedAt === undefined) problems.push('finished match has no endedAt');
  }

  const tokensToWin = getTokensToWin(settings);
  if (
    game.status === 'GAME_OVER' &&
    settings.gameMode !== 'TEAM' &&
    settings.gameMode !== 'SNAKE_LADDER' &&
    countTokensHome(game.winnerUid!, game.tokens) < tokensToWin
  ) {
    problems.push('winner does not satisfy the win condition');
  }

  return { game, actions, problems, finished: game.status === 'GAME_OVER' };
}

/** Convenience: verify a timeout transition keeps the state valid. */
export function simulateTimeout(game: GameDocument, ctx: GameContext, now: number) {
  const next = applyTurnTimeout(game, ctx, now);
  return { next, problems: [...validateGameDocument(next), ...validateTransition(game, next)] };
}
