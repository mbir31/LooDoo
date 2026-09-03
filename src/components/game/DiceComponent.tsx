import React, { useState } from 'react';
import { motion } from 'motion/react';
import { soundFx } from '../../utils/sound';
import { Language, PlayerColor } from '../../types';
import { getTranslation } from '../../i18n/translations';
import { Dices, Sparkles, AlertTriangle } from 'lucide-react';

interface DiceComponentProps {
  diceValue: number | null;
  isRolling: boolean;
  canRoll: boolean;
  consecutiveSixes: number;
  playerColor: PlayerColor;
  language: Language;
  onRoll: () => void;
}

// 6 Dot Patterns with percentage coordinates
const DOT_POSITIONS: Record<number, number[][]> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [28, 72], [72, 28], [72, 72]],
  5: [[28, 28], [28, 72], [50, 50], [72, 28], [72, 72]],
  6: [[28, 24], [28, 50], [28, 76], [72, 24], [72, 50], [72, 76]],
};

export const DiceComponent: React.FC<DiceComponentProps> = ({
  diceValue,
  isRolling,
  canRoll,
  consecutiveSixes,
  playerColor,
  language,
  onRoll,
}) => {
  const [animatingRoll, setAnimatingRoll] = useState(false);

  const handleRollClick = () => {
    if (!canRoll || isRolling || animatingRoll) return;

    soundFx.click();
    soundFx.diceRoll();
    setAnimatingRoll(true);

    onRoll();

    setTimeout(() => {
      setAnimatingRoll(false);
    }, 380);
  };

  const displayValue = diceValue ?? 1;
  const dots = DOT_POSITIONS[displayValue] || DOT_POSITIONS[1];

  const colorStyles = {
    red: {
      border: 'border-red-500 shadow-red-500/40',
      dotColor: displayValue === 6 ? '#dc2626' : '#171717',
      glow: 'shadow-[0_0_25px_rgba(239,68,68,0.5)]',
    },
    green: {
      border: 'border-emerald-500 shadow-emerald-500/40',
      dotColor: displayValue === 6 ? '#059669' : '#171717',
      glow: 'shadow-[0_0_25px_rgba(16,185,129,0.5)]',
    },
    yellow: {
      border: 'border-amber-400 shadow-amber-400/40',
      dotColor: displayValue === 6 ? '#d97706' : '#171717',
      glow: 'shadow-[0_0_25px_rgba(245,158,11,0.5)]',
    },
    blue: {
      border: 'border-blue-500 shadow-blue-500/40',
      dotColor: displayValue === 6 ? '#2563eb' : '#171717',
      glow: 'shadow-[0_0_25px_rgba(59,130,246,0.5)]',
    },
  }[playerColor] || {
    border: 'border-neutral-700 shadow-neutral-700/40',
    dotColor: '#171717',
    glow: '',
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-sm mx-auto">
      {/* 3 Consecutive Six Warning / Count Badge */}
      {consecutiveSixes > 0 && (
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black shadow-lg ${
            consecutiveSixes === 2
              ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-neutral-950 animate-bounce ring-2 ring-white'
              : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white'
          }`}
        >
          {consecutiveSixes === 2 ? (
            <AlertTriangle className="w-4 h-4 text-neutral-950" />
          ) : (
            <Sparkles className="w-4 h-4 text-amber-300" />
          )}
          <span>
            {getTranslation(language, 'consecutiveSixCount', { count: consecutiveSixes })}
          </span>
        </motion.div>
      )}

      {/* 3D Realistic Physical Dice */}
      <div className="relative flex items-center justify-center py-1">
        <motion.div
          id="loodoo-dice"
          data-testid="loodoo-dice"
          data-dice-value={isRolling || animatingRoll ? 'rolling' : (diceValue ?? 'none')}
          className={`w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-b from-white via-neutral-50 to-neutral-200 rounded-3xl p-2.5 border-4 ${colorStyles.border} shadow-2xl flex items-center justify-center cursor-pointer select-none relative ${colorStyles.glow}`}
          style={{
            transformStyle: 'preserve-3d',
            boxShadow: canRoll
              ? '0 20px 30px -10px rgba(0, 0, 0, 0.7), inset 0 2px 4px rgba(255, 255, 255, 0.9), inset 0 -3px 6px rgba(0, 0, 0, 0.15)'
              : '0 10px 20px -5px rgba(0, 0, 0, 0.6), inset 0 2px 4px rgba(255, 255, 255, 0.9)',
          }}
          animate={
            animatingRoll || isRolling
              ? {
                  rotate: [0, 180, 360, 540, 720],
                  scale: [1, 1.25, 0.88, 1.18, 1],
                  y: [0, -25, 5, -12, 0],
                }
              : canRoll
              ? {
                  scale: [1, 1.08, 1],
                  rotate: [0, -3, 3, 0],
                }
              : {}
          }
          transition={
            animatingRoll || isRolling
              ? { duration: 0.38, ease: 'easeInOut' }
              : canRoll
              ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' }
              : { duration: 0.2 }
          }
          onClick={handleRollClick}
        >
          {/* Subtle 3D Top Corner Gloss Highlight */}
          <div className="absolute top-1 left-2 right-2 h-1/4 bg-white/60 rounded-full blur-[0.5px] pointer-events-none" />

          {/* Dice SVG with debossed pips */}
          <svg className="w-full h-full" viewBox="0 0 100 100">
            {dots.map(([cx, cy], idx) => (
              <g key={idx}>
                {/* Pip Shadow/Deboss */}
                <circle
                  cx={cx}
                  cy={cy + 1}
                  r="9.5"
                  fill="rgba(0,0,0,0.25)"
                />
                {/* Pip Main Fill */}
                <circle
                  cx={cx}
                  cy={cy}
                  r="9"
                  fill={colorStyles.dotColor}
                />
                {/* Pip Specular reflection */}
                <circle
                  cx={cx - 2.5}
                  cy={cy - 2.5}
                  r="2.5"
                  fill="rgba(255,255,255,0.45)"
                />
              </g>
            ))}
          </svg>
        </motion.div>
      </div>

      {/* LARGER, HIGH-IMPACT ROLL DICE ACTION BUTTON */}
      <button
        id="roll-dice-btn"
        disabled={!canRoll || isRolling || animatingRoll}
        onClick={handleRollClick}
        className={`w-full py-4 sm:py-4.5 px-6 rounded-2xl font-black text-base sm:text-lg flex items-center justify-center gap-3 shadow-2xl transition-all active:scale-[0.96] ${
          canRoll && !isRolling && !animatingRoll
            ? 'bg-gradient-to-r from-red-600 via-amber-500 to-emerald-600 hover:brightness-115 text-white shadow-amber-500/40 cursor-pointer animate-pulse ring-2 ring-white/30'
            : 'bg-neutral-900 border border-neutral-800 text-neutral-500 cursor-not-allowed opacity-75'
        }`}
      >
        <Dices className="w-6 h-6 shrink-0" />
        <span className="tracking-wide">
          {isRolling || animatingRoll
            ? getTranslation(language, 'rolling')
            : getTranslation(language, 'rollDice')}
        </span>
      </button>
    </div>
  );
};

