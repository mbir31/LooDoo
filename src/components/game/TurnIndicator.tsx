import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { GameDocument, RoomPlayer, Language, PlayerColor } from '../../types';
import { getTranslation } from '../../i18n/translations';
import { Clock, Sparkles, AlertCircle, Trophy, Swords } from 'lucide-react';
import { handleTurnTimeout } from '../../services/gameService';

interface TurnIndicatorProps {
  game: GameDocument;
  players: Record<string, RoomPlayer>;
  myUid: string;
  language: Language;
  /** Offline pass-and-play has no server room: never call the timeout service. */
  timeoutEnabled?: boolean;
}

const COLOR_THEME: Record<PlayerColor, {
  text: string;
  border: string;
  glow: string;
  badgeBg: string;
}> = {
  red: {
    text: 'text-red-400',
    border: 'border-red-500/60',
    glow: 'shadow-[0_0_20px_rgba(239,68,68,0.25)]',
    badgeBg: 'bg-red-500/20 text-red-300 border-red-500/40',
  },
  green: {
    text: 'text-emerald-400',
    border: 'border-emerald-500/60',
    glow: 'shadow-[0_0_20px_rgba(16,185,129,0.25)]',
    badgeBg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  },
  yellow: {
    text: 'text-amber-300',
    border: 'border-amber-400/60',
    glow: 'shadow-[0_0_20px_rgba(245,158,11,0.25)]',
    badgeBg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  },
  blue: {
    text: 'text-sky-400',
    border: 'border-blue-500/60',
    glow: 'shadow-[0_0_20px_rgba(59,130,246,0.25)]',
    badgeBg: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  },
};

export const TurnIndicator: React.FC<TurnIndicatorProps> = ({
  game,
  players,
  myUid,
  language,
  timeoutEnabled = true,
}) => {
  const [timeLeft, setTimeLeft] = useState(30);

  const currentPlayer = players[game.currentPlayerUid];
  const isMyTurn = game.currentPlayerUid === myUid;
  const playerColor = (currentPlayer?.color as PlayerColor) || 'red';
  const theme = COLOR_THEME[playerColor] || COLOR_THEME.red;

  useEffect(() => {
    const checkTimer = () => {
      const remaining = Math.max(0, Math.ceil((game.turnExpiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);

      // The service only accepts a timeout from the player owning the turn or
      // the room admin, so several clients cannot skip the same turn twice.
      if (timeoutEnabled && remaining === 0 && game.status !== 'GAME_OVER') {
        handleTurnTimeout(game.roomId, game.gameId, myUid).catch(() => {});
      }
    };

    checkTimer();
    const interval = setInterval(checkTimer, 1000);
    return () => clearInterval(interval);
  }, [game.turnExpiresAt, game.roomId, game.gameId, game.status, myUid, timeoutEnabled]);

  const totalTime = 30;
  const progressPercent = Math.min(100, Math.max(0, (timeLeft / totalTime) * 100));

  // Determine message icon
  const msgType = game.turnMessage?.type || 'info';

  return (
    <motion.div
      key={game.currentPlayerUid}
      initial={{ opacity: 0.7, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 450, damping: 28 }}
      className={`w-full bg-neutral-950/95 backdrop-blur-sm border rounded-2xl p-3 shadow-lg flex flex-col gap-2.5 transition-colors relative overflow-hidden ${theme.border} ${theme.glow}`}
    >
      {/* Animated Subtle Turn Pulse Backdrop */}
      <motion.div
        key={`pulse-${game.currentPlayerUid}`}
        initial={{ opacity: 0.6, scale: 0.8 }}
        animate={{ opacity: 0, scale: 2 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent pointer-events-none"
      />

      {/* Top Row: Turn Info & Timer */}
      <div className="flex items-center justify-between gap-2 relative z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          <motion.div
            key={`avatar-${game.currentPlayerUid}`}
            initial={{ scale: 0.6, rotate: -15 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className="w-10 h-10 rounded-xl bg-neutral-900 border border-neutral-750 flex items-center justify-center text-xl shrink-0 shadow-inner relative"
          >
            <span>{currentPlayer?.avatar || '👤'}</span>
            <span className={`absolute -bottom-1 -right-1 text-[8px] font-black px-1 rounded uppercase tracking-tighter ${theme.badgeBg}`}>
              {currentPlayer?.slot || 'P1'}
            </span>
          </motion.div>

          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-1.5">
              <motion.span
                key={`name-${game.currentPlayerUid}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
                className={`font-black text-sm sm:text-base truncate ${theme.text}`}
              >
                {isMyTurn
                  ? (language === 'bn' ? '🎯 আপনার চাল!' : '🎯 Your Turn!')
                  : getTranslation(language, 'waitingForTurn', {
                      name: currentPlayer?.displayName || 'Player',
                    })}
              </motion.span>

              {isMyTurn && (
                <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-black bg-amber-400 text-neutral-950 animate-bounce">
                  ROLL
                </span>
              )}
            </div>

            <span className="text-[10px] text-neutral-400 truncate">
              {currentPlayer?.displayName || 'Player'}
            </span>
          </div>
        </div>

        {/* Turn Timer Badge */}
        <motion.div
          animate={timeLeft <= 5 ? { scale: [1, 1.08, 1] } : {}}
          transition={timeLeft <= 5 ? { repeat: Infinity, duration: 0.6 } : {}}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-mono font-bold border shrink-0 ${
            timeLeft <= 5
              ? 'bg-red-950/90 border-red-500 text-red-400 shadow-md shadow-red-500/20'
              : 'bg-neutral-900 border-neutral-750 text-neutral-300'
          }`}
        >
          <Clock className={`w-3.5 h-3.5 ${timeLeft <= 5 ? 'text-red-400 animate-spin' : 'text-neutral-400'}`} />
          <span>{timeLeft}s</span>
        </motion.div>
      </div>

      {/* Timer Progress Bar */}
      <div className="w-full bg-neutral-900 h-1.5 rounded-full overflow-hidden">
        <motion.div
          className={`h-full transition-all duration-300 ${
            timeLeft <= 5 ? 'bg-red-500' : 'bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500'
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Game Turn Announcement Message */}
      {game.turnMessage && (
        <motion.div
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-xs font-semibold ${
            msgType === 'penalty'
              ? 'bg-red-950/70 text-red-200 border border-red-800/80'
              : msgType === 'capture'
              ? 'bg-amber-950/70 text-amber-200 border border-amber-800/80'
              : msgType === 'six'
              ? 'bg-emerald-950/70 text-emerald-200 border border-emerald-800/80'
              : msgType === 'win'
              ? 'bg-amber-900/80 text-amber-100 border border-amber-600'
              : 'bg-neutral-900/80 text-neutral-300 border border-neutral-800'
          }`}
        >
          {msgType === 'penalty' && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
          {msgType === 'capture' && <Swords className="w-4 h-4 text-amber-400 shrink-0" />}
          {msgType === 'six' && <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />}
          {msgType === 'win' && <Trophy className="w-4 h-4 text-amber-400 shrink-0" />}
          <span className="truncate">
            {language === 'bn' ? game.turnMessage.bn : game.turnMessage.en}
          </span>
        </motion.div>
      )}
    </motion.div>
  );
};
