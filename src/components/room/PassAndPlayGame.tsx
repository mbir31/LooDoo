import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  PlayerColor,
  PlayerSlot,
  GameMode,
  Language,
  RoomPlayer,
  GameDocument,
  RoomSettings,
  UserProfile,
} from '../../types';
import { getTranslation } from '../../i18n/translations';
import {
  applyRollDice,
  applyTokenMove,
  canRoll,
  createGameDocument,
  GameContext,
  getLegalMovesForCurrentPlayer,
} from '../../game-engine/reducer';
import { chooseBestToken } from '../../game-engine/ai';
import { soundFx } from '../../utils/sound';
import { LudoBoard } from '../board/LudoBoard';
import { SnakeLadderBoard, LADDERS_MAP, SNAKES_MAP } from '../board/SnakeLadderBoard';
import { DiceComponent } from '../game/DiceComponent';
import { TurnIndicator } from '../game/TurnIndicator';
import { PlayerCard } from '../game/PlayerCard';
import { QuickReactions } from '../game/QuickReactions';
import { GameResultModal } from './GameResultModal';
import {
  Users,
  RotateCcw,
  Sparkles,
  Zap,
  Shield,
  Trophy,
  ArrowLeft,
  Crown,
  Volume2,
  Check,
} from 'lucide-react';

interface PassAndPlayGameProps {
  language: Language;
  onExit: () => void;
  currentUser: UserProfile;
}

interface LocalPlayerConfig {
  name: string;
  avatar: string;
  color: PlayerColor;
  slot: PlayerSlot;
}

const DEFAULT_PLAYERS_CONFIG: LocalPlayerConfig[] = [
  { name: 'খেলোয়াড় ১', avatar: '👑', color: 'red', slot: 'P1' },
  { name: 'খেলোয়াড় ২', avatar: '🦁', color: 'green', slot: 'P2' },
  { name: 'খেলোয়াড় ৩', avatar: '🐯', color: 'yellow', slot: 'P3' },
  { name: 'খেলোয়াড় ৪', avatar: '🦅', color: 'blue', slot: 'P4' },
];

export const PassAndPlayGame: React.FC<PassAndPlayGameProps> = ({
  language,
  onExit,
  currentUser,
}) => {
  // Setup Stage State
  const [playerCount, setPlayerCount] = useState<2 | 3 | 4>(4);
  const [selectedMode, setSelectedMode] = useState<GameMode>('CLASSIC');
  const [autoMoveSingle, setAutoMoveSingle] = useState(true);
  const [playersList, setPlayersList] = useState<LocalPlayerConfig[]>(DEFAULT_PLAYERS_CONFIG);

  // -------------------------------------------------------------------------
  // Authoritative game state. Offline pass-and-play uses the very same
  // reducer as online multiplayer and the AI bots, so the rules can never
  // drift apart. `isRolling` is pure presentation state and lives outside it.
  // -------------------------------------------------------------------------
  const [game, setGame] = useState<GameDocument | null>(null);
  const [isRolling, setIsRolling] = useState(false);

  const isPlaying = game !== null;
  const diceValue = game?.diceValue ?? null;
  const diceRolled = game?.diceRolled ?? false;
  const consecutiveSixes = game?.consecutiveSixes ?? 0;
  const winnerUid = game?.winnerUid ?? null;
  const rankings = game?.rankings ?? [];
  const turnMessage = game?.turnMessage ?? null;
  const tokens = game?.tokens ?? {};
  const snakePositions = game?.snakePositions ?? {};
  const snakeLastEvent = game?.snakeLastEvent ?? null;

  // Setup initial player records
  const activePlayers = useMemo(() => {
    return playersList.slice(0, playerCount);
  }, [playersList, playerCount]);

  const playerOrder = useMemo(() => {
    return activePlayers.map((p) => p.slot);
  }, [activePlayers]);

  const currentSlot: PlayerSlot = (game?.currentPlayerUid as PlayerSlot) || playerOrder[0] || 'P1';
  const currentPlayer = activePlayers.find((p) => p.slot === currentSlot) || activePlayers[0];

  const playersMap = useMemo(() => {
    const map: Record<string, RoomPlayer> = {};
    activePlayers.forEach((p) => {
      map[p.slot] = {
        uid: p.slot,
        playerId: p.slot,
        slot: p.slot,
        displayName: p.name,
        color: p.color,
        avatar: p.avatar,
        ready: true,
        connected: true,
        status: 'active',
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
    });
    return map;
  }, [activePlayers]);

  const slotMap = useMemo(() => {
    const map: Record<string, PlayerSlot> = {};
    activePlayers.forEach((p) => {
      map[p.slot] = p.slot;
    });
    return map;
  }, [activePlayers]);

  /** Room rules for this local match - identical shape to online rooms. */
  const settings: RoomSettings = useMemo(
    () => ({
      maxPlayers: playerCount,
      turnTimeoutSeconds: 30,
      strictThreeSixRule: true,
      allowBlockades: true,
      customNamesAllowed: true,
      gameMode: selectedMode,
      tokensToWin: selectedMode === 'RUSH' ? 2 : 4,
      autoMoveSingle,
    }),
    [playerCount, selectedMode, autoMoveSingle]
  );

  const buildCtx = useCallback(
    (now: number = Date.now()): GameContext => ({
      settings,
      slotMap,
      nameMap: Object.fromEntries(activePlayers.map((p) => [p.slot, p.name])),
      now,
    }),
    [settings, slotMap, activePlayers]
  );

  // Latest state ref, so delayed (animated) actions never act on stale state.
  const gameRef = useRef<GameDocument | null>(null);
  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  /** Start (or restart) the local match. */
  const handleStartGame = () => {
    soundFx.click();
    const now = Date.now();
    setIsRolling(false);
    setGame(
      createGameDocument({
        gameId: `local_${now}`,
        roomId: 'local_room',
        playerOrder,
        settings,
        now,
      })
    );
  };

  /** Legal moves for the player on turn (same helper as the online board). */
  const legalMoves = useMemo(() => {
    if (!game) return [];
    return getLegalMovesForCurrentPlayer(game, buildCtx());
  }, [game, buildCtx]);

  /** Audio / haptic feedback derived from the state transition. */
  const playRollFeedback = (next: GameDocument, dice: number) => {
    if (next.status === 'GAME_OVER') {
      soundFx.win();
      return;
    }
    if (next.lastAction === 'THREE_SIX_PENALTY' || next.lastAction === 'SNAKE_EXCEED_100') {
      soundFx.penalty();
      return;
    }
    if (next.snakeLastEvent?.type === 'LADDER') {
      soundFx.ladderClimb();
      return;
    }
    if (next.snakeLastEvent?.type === 'SNAKE') {
      soundFx.snakeBite();
      return;
    }
    if (dice === 6) {
      soundFx.sixRolled();
      return;
    }
    if (next.lastAction === 'NO_LEGAL_MOVES') {
      soundFx.penalty();
      return;
    }
    soundFx.tokenMoveSequence(dice);
  };

  // Roll Dice
  const handleRollDice = () => {
    const current = gameRef.current;
    if (!current || isRolling || winnerUid) return;
    if (!canRoll(current, currentSlot)) return;

    soundFx.diceRoll();
    setIsRolling(true);

    // Presentation delay only: the state transition itself is synchronous.
    setTimeout(() => {
      const live = gameRef.current;
      if (!live) {
        setIsRolling(false);
        return;
      }
      const val = Math.floor(Math.random() * 6) + 1;
      try {
        const result = applyRollDice(live, buildCtx(), currentSlot, val);
        setGame(result.game);
        playRollFeedback(result.game, val);
      } catch (err) {
        // The engine rejected the action (e.g. a second roll in the same turn).
        console.warn('[loodoo] illegal local roll ignored:', (err as Error)?.message);
      } finally {
        setIsRolling(false);
      }
    }, 450);
  };

  // Move Token
  const handleMoveToken = (tokenId: number) => {
    const current = gameRef.current;
    if (!current || winnerUid) return;
    if (current.status !== 'AWAITING_TOKEN_SELECTION' || current.diceValue === null) return;

    let next: GameDocument;
    let captured = 0;
    let reachedHome = false;
    try {
      const result = applyTokenMove(current, buildCtx(), currentSlot, tokenId);
      next = result.game;
      captured = result.captured.length;
      reachedHome = result.isHome;
    } catch (err) {
      console.warn('[loodoo] illegal local move ignored:', (err as Error)?.message);
      return;
    }

    setGame(next);

    if (next.status === 'GAME_OVER') {
      soundFx.win();
      return;
    }
    if (reachedHome) {
      soundFx.home();
    } else if (captured > 0) {
      soundFx.capture();
    } else {
      soundFx.tokenMoveSequence(current.diceValue);
    }
  };

  // Auto-move when a single legal move is available (optional quality-of-life).
  useEffect(() => {
    if (!game || !autoMoveSingle || selectedMode === 'SNAKE_LADDER') return;
    if (game.status !== 'AWAITING_TOKEN_SELECTION' || game.winnerUid) return;
    if (legalMoves.length !== 1) return;

    const timer = setTimeout(() => {
      handleMoveToken(legalMoves[0]);
    }, 550);
    return () => clearTimeout(timer);
  }, [game?.version, game?.status, legalMoves, autoMoveSingle, selectedMode]);

  const tokensToWin = settings.tokensToWin ?? 4;

  // The real authoritative document is handed to the board / widgets directly.
  const boardGame: GameDocument = game as GameDocument;

  // ================= SETUP SCREEN =================
  if (!isPlaying) {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-4 p-3 sm:p-4">
        {/* Header Bar */}
        <div className="flex items-center justify-between bg-neutral-950 border border-neutral-800 p-4 rounded-2xl shadow-xl">
          <button
            onClick={() => {
              soundFx.click();
              onExit();
            }}
            className="p-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-bold"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{language === 'bn' ? 'ফিরে যান' : 'Back'}</span>
          </button>
          <div className="text-center">
            <h2 className="font-black text-base sm:text-lg bg-gradient-to-r from-red-400 via-amber-300 to-emerald-400 bg-clip-text text-transparent">
              {language === 'bn' ? 'এক ফোনে খেলুন (Pass & Play)' : 'Offline Pass & Play'}
            </h2>
            <p className="text-[11px] text-neutral-400">
              {language === 'bn' ? 'ইন্টারনেট ছাড়াই সবাই একসাথে এক ডিভাইসে' : 'Play locally on 1 phone without internet'}
            </p>
          </div>
          <div className="w-16" />
        </div>

        {/* Game Mode Selector */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
          <label className="text-xs font-bold text-neutral-300 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>{language === 'bn' ? 'গেম মোড বেছে নিন' : 'Choose Game Mode'}</span>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                soundFx.click();
                setSelectedMode('CLASSIC');
              }}
              className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                selectedMode === 'CLASSIC'
                  ? 'bg-amber-950/40 border-amber-400 text-white shadow-md'
                  : 'bg-black border-neutral-800 text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Shield className="w-4 h-4 text-amber-400" />
                <p className="font-black text-xs text-white">{getTranslation(language, 'modeClassic')}</p>
              </div>
              <p className="text-[10px] text-neutral-400 mt-1">{getTranslation(language, 'modeClassicDesc')}</p>
            </button>

            <button
              onClick={() => {
                soundFx.click();
                setSelectedMode('RUSH');
              }}
              className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                selectedMode === 'RUSH'
                  ? 'bg-rose-950/40 border-rose-400 text-white shadow-md'
                  : 'bg-black border-neutral-800 text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-rose-400" />
                <p className="font-black text-xs text-white">{getTranslation(language, 'modeRush')}</p>
              </div>
              <p className="text-[10px] text-neutral-400 mt-1">{getTranslation(language, 'modeRushDesc')}</p>
            </button>

            <button
              onClick={() => {
                soundFx.click();
                setSelectedMode('SNAKE_LADDER');
              }}
              className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                selectedMode === 'SNAKE_LADDER'
                  ? 'bg-emerald-950/40 border-emerald-400 text-white shadow-md'
                  : 'bg-black border-neutral-800 text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm">🐍</span>
                <p className="font-black text-xs text-white">{getTranslation(language, 'snakeLadderMode')}</p>
              </div>
              <p className="text-[10px] text-neutral-400 mt-1">{getTranslation(language, 'snakeLadderModeDesc')}</p>
            </button>

            <button
              onClick={() => {
                soundFx.click();
                setSelectedMode('TEAM');
              }}
              className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                selectedMode === 'TEAM'
                  ? 'bg-blue-950/40 border-blue-400 text-white shadow-md'
                  : 'bg-black border-neutral-800 text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Users className="w-4 h-4 text-blue-400" />
                <p className="font-black text-xs text-white">
                  {language === 'bn' ? '২ বনাম ২ টিম মোড' : '2v2 Team Mode'}
                </p>
              </div>
              <p className="text-[10px] text-neutral-400 mt-1">
                {language === 'bn' ? 'লাল+হলুদ বনাম সবুজ+নীল দল' : 'Red+Yellow vs Green+Blue'}
              </p>
            </button>
          </div>
        </div>

        {/* Player Count Selection */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
          <label className="text-xs font-bold text-neutral-300 flex items-center gap-1.5">
            <Users className="w-4 h-4 text-amber-400" />
            <span>{language === 'bn' ? 'কতজন খেলবেন?' : 'How many players?'}</span>
          </label>

          <div className="grid grid-cols-3 gap-2">
            {[2, 3, 4].map((num) => (
              <button
                key={num}
                onClick={() => {
                  soundFx.click();
                  setPlayerCount(num as 2 | 3 | 4);
                }}
                className={`py-3 rounded-xl font-black text-sm border transition-all cursor-pointer ${
                  playerCount === num
                    ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-neutral-950 border-amber-400 shadow-md shadow-amber-500/20'
                    : 'bg-black border-neutral-800 text-neutral-300 hover:bg-neutral-900'
                }`}
              >
                {num} {language === 'bn' ? 'খেলোয়াড়' : 'Players'}
              </button>
            ))}
          </div>
        </div>

        {/* Player Customizer */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
          <label className="text-xs font-bold text-neutral-300">
            {language === 'bn' ? 'খেলোয়াড়দের নাম ও প্রোফাইল' : 'Player Names & Avatars'}
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {playersList.slice(0, playerCount).map((p, idx) => {
              const borderColors: Record<PlayerColor, string> = {
                red: 'border-red-500/50 bg-red-950/20',
                green: 'border-emerald-500/50 bg-emerald-950/20',
                yellow: 'border-amber-400/50 bg-amber-950/20',
                blue: 'border-blue-500/50 bg-blue-950/20',
              };

              return (
                <div
                  key={p.slot}
                  className={`p-2.5 rounded-xl border flex items-center gap-2.5 ${borderColors[p.color]}`}
                >
                  <span className="text-2xl p-1 bg-black rounded-lg border border-neutral-800 shadow">
                    {p.avatar}
                  </span>
                  <input
                    type="text"
                    maxLength={15}
                    value={p.name}
                    onChange={(e) => {
                      const updated = [...playersList];
                      updated[idx].name = e.target.value;
                      setPlayersList(updated);
                    }}
                    className="flex-1 bg-neutral-900 border border-neutral-750 rounded-lg px-3 py-1.5 text-xs font-bold text-white focus:outline-none focus:border-amber-400"
                    placeholder={`Player ${idx + 1}`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Start Game CTA */}
        <button
          onClick={handleStartGame}
          className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-red-600 via-amber-500 to-emerald-600 hover:brightness-110 active:scale-95 text-white font-black text-base shadow-xl shadow-amber-500/25 flex items-center justify-center gap-2 cursor-pointer transition-all"
        >
          <Crown className="w-5 h-5 text-amber-200" />
          <span>{language === 'bn' ? 'খেলা শুরু করুন' : 'Start Match'}</span>
        </button>
      </div>
    );
  }

  // ================= IN-GAME VIEW =================
  return (
    <div className="w-full max-w-4xl mx-auto flex flex-col gap-3 sm:gap-4 p-2 sm:p-4">
      {/* Top Header & Turn Bar */}
      <div className="flex items-center justify-between bg-neutral-950 border border-neutral-800 p-2.5 sm:p-3 rounded-2xl shadow-xl">
        <button
          onClick={() => {
            soundFx.click();
            setGame(null);
          }}
          className="p-1.5 sm:p-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors cursor-pointer flex items-center gap-1 text-xs font-bold"
        >
          <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          <span>{language === 'bn' ? 'সেটআপ' : 'Setup'}</span>
        </button>

        {/* Active Player Banner */}
        <div className="flex items-center gap-2 px-3 py-1 rounded-xl bg-black border border-neutral-800 shadow">
          <span className="text-lg">{currentPlayer.avatar}</span>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs sm:text-sm font-black text-white">{currentPlayer.name}</span>
              <span className="text-[10px] font-bold text-amber-400">
                ({currentPlayer.color.toUpperCase()})
              </span>
            </div>
            <p className="text-[10px] text-neutral-400">
              {language === 'bn' ? 'এর চাল' : "'s Turn"}
            </p>
          </div>
        </div>

        {/* Quick Reset */}
        <button
          onClick={handleStartGame}
          className="p-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors cursor-pointer"
          title="Restart"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Main Game Arena */}
      <div className="flex flex-col lg:flex-row items-center justify-center gap-4">
        {/* Game Board */}
        <div className="w-full max-w-[500px]">
          {selectedMode === 'SNAKE_LADDER' ? (
            <SnakeLadderBoard
              playerPositions={snakePositions}
              players={playersMap}
              playerOrder={playerOrder}
              currentPlayerUid={currentSlot}
              myUid={currentSlot}
              language={language}
              lastEvent={snakeLastEvent}
            />
          ) : (
            <LudoBoard
              game={boardGame}
              players={playersMap}
              currentPlayerUid={currentSlot}
              myUid={currentSlot}
              legalMoves={legalMoves}
              settings={settings}
              onTokenClick={handleMoveToken}
              disabled={!diceRolled}
              userTokenTheme={currentUser.tokenSkin || 'classic'}
            />
          )}
        </div>

        {/* Controls & Active Players Column */}
        <div className="w-full max-w-[340px] flex flex-col gap-3">
          {/* Turn Indicator Banner */}
          <TurnIndicator
            game={boardGame}
            players={playersMap}
            myUid={currentSlot}
            language={language}
            timeoutEnabled={false}
          />

          {/* Interactive 3D Dice Component & Quick Soundboard Action */}
          <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-2xl shadow-xl flex flex-col items-center gap-3">
            <DiceComponent
              diceValue={diceValue}
              isRolling={isRolling}
              canRoll={canRoll(boardGame, currentSlot) && !isRolling}
              consecutiveSixes={consecutiveSixes}
              playerColor={currentPlayer.color}
              language={language}
              onRoll={handleRollDice}
            />

            <div className="w-full flex items-center justify-between gap-2 pt-2 border-t border-neutral-850">
              <QuickReactions
                user={currentUser}
                onOfflineReaction={(emoji, taunt) => {
                  // Handled with sound and float
                }}
              />
              <button
                onClick={() => {
                  soundFx.click();
                  setGame(null);
                }}
                className="px-3 py-1.5 rounded-xl bg-neutral-900 hover:bg-neutral-850 text-neutral-300 text-xs font-bold border border-neutral-800 flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{language === 'bn' ? 'রিস্টার্ট' : 'Restart'}</span>
              </button>
            </div>
          </div>

          {/* Players Grid */}
          <div className="grid grid-cols-2 gap-2">
            {activePlayers.map((p) => {
              const isTurn = p.slot === currentSlot;
              const playerRecord = playersMap[p.slot];

              return (
                <PlayerCard
                  key={p.slot}
                  player={playerRecord}
                  isCurrentTurn={isTurn}
                  isAdmin={false}
                  game={boardGame}
                  language={language}
                  isMe={isTurn}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Screen Bottom Credit Footer */}
      <footer className="w-full py-4 text-center text-xs text-neutral-400 font-medium border-t border-neutral-900 mt-6 flex flex-col sm:flex-row items-center justify-center gap-1">
        <span>Built with love, for FnF, by</span>
        <span className="text-amber-400 font-bold tracking-wide">©munabbirMushran</span>
      </footer>

      {/* Result Modal upon Victory */}
      {winnerUid && (
        <GameResultModal
          game={boardGame}
          room={{
            roomId: 'pass_and_play',
            roomCode: 'LOCAL',
            adminUid: currentSlot,
            status: 'FINISHED',
            maxPlayers: playerCount,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            currentGameId: 'local_game',
            lastGameId: null,
            settings: {
              maxPlayers: playerCount,
              turnTimeoutSeconds: 30,
              strictThreeSixRule: true,
              allowBlockades: true,
              customNamesAllowed: true,
              gameMode: selectedMode,
              tokensToWin,
            },
          }}
          players={playersMap}
          currentUserUid={currentSlot}
          language={language}
          onBackToLobby={() => setGame(null)}
        />
      )}
    </div>
  );
};
