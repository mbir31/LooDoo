import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { RoomPlayer, PlayerColor, Language, GameDocument } from '../../types';
import { getTranslation } from '../../i18n/translations';
import { countTokensHome } from '../../game-engine/engine';
import { Trophy, Wifi, WifiOff, Crown, Volume2, VolumeX } from 'lucide-react';
import { isPlayerMuted, setPlayerMuted } from '../../services/voiceClipService';

interface PlayerCardProps {
  player: RoomPlayer;
  isCurrentTurn: boolean;
  isAdmin: boolean;
  game?: GameDocument | null;
  language: Language;
  isMe: boolean;
  /** Shows the per-player "mute their voice clips" toggle (online + offline). */
  showVoiceMute?: boolean;
}

const COLOR_BORDER: Record<PlayerColor, string> = {
  red: 'border-red-500 bg-red-950/20 shadow-red-500/10',
  green: 'border-emerald-500 bg-emerald-950/20 shadow-emerald-500/10',
  yellow: 'border-amber-400 bg-amber-950/20 shadow-amber-400/10',
  blue: 'border-blue-500 bg-blue-950/20 shadow-blue-500/10',
};

const COLOR_PILL: Record<PlayerColor, string> = {
  red: 'bg-red-500 text-white',
  green: 'bg-emerald-500 text-white',
  yellow: 'bg-amber-400 text-stone-950 font-black',
  blue: 'bg-blue-500 text-white',
};

export const PlayerCard: React.FC<PlayerCardProps> = ({
  player,
  isCurrentTurn,
  isAdmin,
  game,
  language,
  isMe,
  showVoiceMute = true,
}) => {
  const color = player.color || 'red';
  const tokensHome = game ? countTokensHome(player.uid, game.tokens) : 0;
  const [voiceMuted, setVoiceMuted] = useState(() => isPlayerMuted(player.uid));

  useEffect(() => {
    setVoiceMuted(isPlayerMuted(player.uid));
  }, [player.uid]);

  return (
    <motion.div
      id={`player-card-${player.uid}`}
      animate={
        isCurrentTurn
          ? {
              scale: [1, 1.02, 1],
              borderColor: ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'],
            }
          : {}
      }
      transition={
        isCurrentTurn
          ? { repeat: Infinity, duration: 2.5, ease: 'easeInOut' }
          : { duration: 0.2 }
      }
      className={`relative p-2 sm:p-2.5 rounded-xl border-2 transition-all select-none ${
        COLOR_BORDER[color]
      } ${
        isCurrentTurn
          ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-black shadow-lg'
          : 'bg-neutral-950 border-neutral-800'
      }`}
    >
      <div className="flex items-center gap-2">
        {/* Avatar & Slot */}
        <div className="relative shrink-0">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-black border border-neutral-700 flex items-center justify-center text-lg sm:text-xl shadow">
            {player.avatar || '👤'}
          </div>
          <span
            className={`absolute -bottom-1 -right-1 text-[9px] font-black px-1 rounded shadow ${COLOR_PILL[color]}`}
          >
            {player.slot}
          </span>
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="text-xs sm:text-sm font-bold text-white truncate">
              {player.displayName}
            </span>
            {isMe && (
              <span className="text-[9px] bg-neutral-800 text-neutral-300 px-1 rounded">
                You
              </span>
            )}
            {isAdmin && (
              <span title="Admin" className="shrink-0 inline-flex">
                <Crown className="w-3 h-3 text-amber-400" />
              </span>
            )}
          </div>

          {/* Tokens Home count / Snake Position or Connection status */}
          <div className="flex items-center justify-between text-[11px] text-neutral-400 mt-0.5">
            <div className="flex items-center gap-1">
              <Trophy className="w-3 h-3 text-amber-400" />
              <span className="font-semibold text-neutral-300">
                {game?.gameMode === 'SNAKE_LADDER' || game?.snakePositions
                  ? `${game?.snakePositions?.[player.uid] || 1}/100`
                  : `${tokensHome}/4`}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {!isMe && showVoiceMute && (
                <button
                  type="button"
                  data-testid={`voice-mute-${player.uid}`}
                  aria-pressed={voiceMuted}
                  title={voiceMuted ? 'এর আওয়াজ চালু করুন (unmute voice)' : 'এর আওয়াজ বন্ধ করুন (mute voice)'}
                  onClick={(event) => {
                    event.stopPropagation();
                    const next = !voiceMuted;
                    setVoiceMuted(next);
                    setPlayerMuted(player.uid, next);
                  }}
                  className={`cursor-pointer transition-colors ${
                    voiceMuted ? 'text-red-400 hover:text-red-300' : 'text-neutral-500 hover:text-neutral-200'
                  }`}
                >
                  {voiceMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
              )}
              {player.connected ? (
                <span title="Connected" className="inline-flex">
                  <Wifi className="w-3 h-3 text-emerald-400" />
                </span>
              ) : (
                <span title="Disconnected" className="inline-flex">
                  <WifiOff className="w-3 h-3 text-red-400" />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
