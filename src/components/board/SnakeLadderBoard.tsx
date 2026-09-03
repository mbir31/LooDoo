import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RoomPlayer, PlayerSlot, PlayerColor, Language } from '../../types';
import { soundFx } from '../../utils/sound';
import {
  Crown,
  Sparkles,
  Trophy,
  Info,
  Flame,
  Zap,
  Eye,
  ShieldAlert,
  ArrowUpRight,
  Flag,
} from 'lucide-react';

export interface SnakeLadderBoardProps {
  playerPositions: Record<string, number>; // uid -> 1..100
  players: Record<string, RoomPlayer>;
  playerOrder: string[];
  currentPlayerUid: string;
  myUid: string;
  language: Language;
  onTileClick?: (tileNumber: number) => void;
  lastEvent?: {
    type: 'LADDER' | 'SNAKE' | 'NORMAL';
    from: number;
    to: number;
    uid: string;
  } | null;
}

// Classical Bangladeshi Snake & Ladder (সাপ লুডু) Map.
// The tables live in the game-engine so that the rules engine, the online
// service, the AI driver and this board can never drift apart.
import {
  SNAKES_MAP as ENGINE_SNAKES_MAP,
  LADDERS_MAP as ENGINE_LADDERS_MAP,
  getCellCoords,
} from '../../game-engine/snakeLadder';

export const SNAKES_MAP: Record<number, number> = ENGINE_SNAKES_MAP;
export const LADDERS_MAP: Record<number, number> = ENGINE_LADDERS_MAP;

// Rich Bangladeshi Snake Vernacular Metadata
export interface SnakeInfo {
  head: number;
  tail: number;
  nameBn: string;
  nameEn: string;
  typeBn: string;
  dangerBadge: string;
  gradientId: string;
  eyeColor: string;
  tongueColor: string;
}

export const BANGLADESHI_SNAKES: Record<number, SnakeInfo> = {
  98: {
    head: 98,
    tail: 79,
    nameBn: 'বিষাক্ত কালনাগিনী',
    nameEn: 'Queen Black Krait',
    typeBn: 'মারাত্মক বিষধর',
    dangerBadge: '💀 চরম বিপদ',
    gradientId: 'snakeBlackKrait',
    eyeColor: '#facc15',
    tongueColor: '#ef4444',
  },
  95: {
    head: 95,
    tail: 75,
    nameBn: 'রাজকীয় পদ্মগোখরো',
    nameEn: 'Spectacled Cobra',
    typeBn: 'ফণা তোলা গোখরো',
    dangerBadge: '⚡ বিষাক্ত ছোবল',
    gradientId: 'snakeRedCobra',
    eyeColor: '#fbbf24',
    tongueColor: '#dc2626',
  },
  93: {
    head: 93,
    tail: 73,
    nameBn: 'হলুদ শঙ্খিনী সাপ',
    nameEn: 'Banded Krait',
    typeBn: 'ডোরাকাটা শঙ্খিনী',
    dangerBadge: '⚠️ সাবধান!',
    gradientId: 'snakeYellowKrait',
    eyeColor: '#ef4444',
    tongueColor: '#b91c1c',
  },
  87: {
    head: 87,
    tail: 36,
    nameBn: 'সুন্দরবনের মহা অজগর',
    nameEn: 'Giant Python (-51 Squares)',
    typeBn: 'দৈত্যাকার অজগর',
    dangerBadge: '😱 ৫১ ঘর নিচে পতন!',
    gradientId: 'snakeGiantPython',
    eyeColor: '#38bdf8',
    tongueColor: '#ef4444',
  },
  64: {
    head: 64,
    tail: 60,
    nameBn: 'সবুজ ঘাস সাপ',
    nameEn: 'Green Grass Snake',
    typeBn: 'ছোট ঘাস সাপ',
    dangerBadge: '🐍 ছোট গর্ত',
    gradientId: 'snakeGreenGrass',
    eyeColor: '#fbbf24',
    tongueColor: '#ef4444',
  },
  62: {
    head: 62,
    tail: 19,
    nameBn: 'ভয়ংকর চন্দ্রবোড়া (রাসেল ভাইপার)',
    nameEn: "Russell's Viper (-43 Squares)",
    typeBn: 'তীব্র বিষধর ভাইপার',
    dangerBadge: '🩸 ৪৩ ঘর পিছলে যাওয়া!',
    gradientId: 'snakePurpleViper',
    eyeColor: '#f43f5e',
    tongueColor: '#991b1b',
  },
  54: {
    head: 54,
    tail: 34,
    nameBn: 'নদীর ঢোঁড়া সাপ',
    nameEn: 'Chequered Keelback',
    typeBn: 'জলাশয়ের ঢোঁড়া',
    dangerBadge: '💧 ২০ ঘর নিচে নামা',
    gradientId: 'snakeWaterSnake',
    eyeColor: '#facc15',
    tongueColor: '#ef4444',
  },
  17: {
    head: 17,
    tail: 7,
    nameBn: 'গ্রাম্য দাঁড়াশ সাপ',
    nameEn: 'Common Rat Snake',
    typeBn: 'ছোট দাঁড়াশ',
    dangerBadge: '⚠️ ১০ ঘর নিচে',
    gradientId: 'snakeRatSnake',
    eyeColor: '#fbbf24',
    tongueColor: '#dc2626',
  },
};

// Rich Bangladeshi Ladder Vernacular Metadata
export interface LadderInfo {
  bottom: number;
  top: number;
  nameBn: string;
  nameEn: string;
  typeBn: string;
  boostText: string;
  rungsCount: number;
  woodColor: string;
}

export const BANGLADESHI_LADDERS: Record<number, LadderInfo> = {
  4: {
    bottom: 4,
    top: 14,
    nameBn: 'গ্রাম্য বাঁশের মই',
    nameEn: 'Bamboo Ladder',
    typeBn: 'ছোট বাঁশের মই',
    boostText: '+১০ ঘর জাম্প',
    rungsCount: 4,
    woodColor: '#f59e0b',
  },
  9: {
    bottom: 9,
    top: 31,
    nameBn: 'পাকা সেগুন কাঠের মই',
    nameEn: 'Teak Wood Ladder',
    typeBn: 'মজবুত কাঠের মই',
    boostText: '+২২ ঘর জাম্প',
    rungsCount: 6,
    woodColor: '#d97706',
  },
  21: {
    bottom: 21,
    top: 42,
    nameBn: 'পল্লী মজবুত মই',
    nameEn: 'Sturdy Village Ladder',
    typeBn: 'বাঁশের বড় মই',
    boostText: '+২১ ঘর লাফ',
    rungsCount: 6,
    woodColor: '#b45309',
  },
  28: {
    bottom: 28,
    top: 84,
    nameBn: 'আকাশ ছোঁয়া মহা মই',
    nameEn: 'Grand Sky Ladder (+56 Squares)',
    typeBn: 'বিশাল সোনার সিঁড়ি',
    boostText: '🚀 +৫৬ ঘর বিশাল উল্লম্ফন!',
    rungsCount: 13,
    woodColor: '#fbbf24',
  },
  51: {
    bottom: 51,
    top: 67,
    nameBn: 'পদ্মা সেতু মই',
    nameEn: 'Padma Bridge Ladder',
    typeBn: 'সোনালী মই',
    boostText: '+১৬ ঘর এগিয়ে যান',
    rungsCount: 5,
    woodColor: '#f59e0b',
  },
  72: {
    bottom: 72,
    top: 91,
    nameBn: 'বিজয়ের সোনার মই',
    nameEn: 'Golden Victory Ladder',
    typeBn: 'স্বর্ণালী মই',
    boostText: '+১৯ ঘর বিজয়ের পথে',
    rungsCount: 6,
    woodColor: '#facc15',
  },
  80: {
    bottom: 80,
    top: 99,
    nameBn: 'চূড়ান্ত রাজকীয় মই',
    nameEn: 'Royal Final Ascent Ladder',
    typeBn: '১০০ নম্বরের তোরণ',
    boostText: '👑 ৯৯ ঘরে রাজকীয় প্রবেশ!',
    rungsCount: 7,
    woodColor: '#fbbf24',
  },
};

// Bengali Numerals converter
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
export function toBengaliNumber(num: number): string {
  return num
    .toString()
    .split('')
    .map((d) => BN_DIGITS[parseInt(d, 10)] || d)
    .join('');
}

// Map tile index 1..100 to grid row and column (0..9)
// Row 0 is Top (tiles 100..91)
// Row 9 is Bottom (tiles 1..10)
export function getTileGridPosition(tile: number): { row: number; col: number } {
  // Delegates to the shared engine helper; grid layout docs live there.
  const [row, col] = getCellCoords(tile);
  return { row, col };
}

export const SnakeLadderBoard: React.FC<SnakeLadderBoardProps> = ({
  playerPositions,
  players,
  playerOrder,
  currentPlayerUid,
  myUid,
  language,
  onTileClick,
  lastEvent,
}) => {
  const [inspectedTile, setInspectedTile] = useState<number | null>(null);
  const [boardTheme, setBoardTheme] = useState<'vintage' | 'terracotta' | 'festive'>('vintage');

  // Trigger dedicated sound effects on snake and ladder events
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'SNAKE') {
      soundFx.snakeBite();
    } else if (lastEvent.type === 'LADDER') {
      soundFx.ladderClimb();
    }
  }, [lastEvent]);

  // Generate 100 tiles data
  const tiles = useMemo(() => {
    const arr = [];
    for (let i = 1; i <= 100; i++) {
      const pos = getTileGridPosition(i);
      const snake = BANGLADESHI_SNAKES[i];
      const ladder = BANGLADESHI_LADDERS[i];

      const isSnakeTail = Object.values(SNAKES_MAP).includes(i);
      const isLadderTop = Object.values(LADDERS_MAP).includes(i);

      arr.push({
        num: i,
        row: pos.row,
        col: pos.col,
        snake,
        ladder,
        isSnakeTail,
        isLadderTop,
      });
    }
    return arr;
  }, []);

  // Theme palettes with authentic Bangladeshi tones
  const themeStyles = {
    vintage: {
      boardFrame: 'from-amber-950 via-yellow-950 to-stone-950 border-amber-500/60 shadow-amber-950/80',
      headerBg: 'from-amber-900/60 to-yellow-900/60 text-amber-200 border-amber-600/40',
      gridBg: 'bg-[#18110b]',
      tileRed: 'bg-[#450a0a]/90 text-rose-100 border-red-800/50',
      tileGreen: 'bg-[#052e16]/90 text-emerald-100 border-emerald-800/50',
      tileYellow: 'bg-[#451a03]/90 text-amber-100 border-amber-800/50',
      tileBlue: 'bg-[#172554]/90 text-sky-100 border-blue-800/50',
      parchmentOverlay: 'bg-[radial-gradient(#ffffff0a_1px,transparent_1px)] [background-size:8px_8px]',
    },
    terracotta: {
      boardFrame: 'from-[#7c2d12] via-[#431407] to-[#1c1917] border-[#ea580c]/60 shadow-orange-950/80',
      headerBg: 'from-orange-900/70 to-red-900/70 text-orange-200 border-orange-600/40',
      gridBg: 'bg-[#1c0f0a]',
      tileRed: 'bg-[#5c1d11]/90 text-orange-100 border-orange-800/50',
      tileGreen: 'bg-[#143a29]/90 text-emerald-100 border-emerald-800/50',
      tileYellow: 'bg-[#5a2e0e]/90 text-amber-100 border-yellow-800/50',
      tileBlue: 'bg-[#1e293b]/90 text-slate-100 border-slate-700/50',
      parchmentOverlay: 'bg-[radial-gradient(#ea580c10_1px,transparent_1px)] [background-size:8px_8px]',
    },
    festive: {
      boardFrame: 'from-[#3b0764] via-[#1e1b4b] to-[#022c22] border-fuchsia-500/60 shadow-purple-950/80',
      headerBg: 'from-fuchsia-900/60 to-indigo-900/60 text-fuchsia-200 border-fuchsia-600/40',
      gridBg: 'bg-[#0f0c1b]',
      tileRed: 'bg-[#4a044e]/90 text-fuchsia-100 border-fuchsia-800/50',
      tileGreen: 'bg-[#064e3b]/90 text-emerald-100 border-emerald-800/50',
      tileYellow: 'bg-[#713f12]/90 text-amber-100 border-amber-800/50',
      tileBlue: 'bg-[#1e1b4b]/90 text-indigo-100 border-indigo-800/50',
      parchmentOverlay: 'bg-[radial-gradient(#a855f710_1px,transparent_1px)] [background-size:8px_8px]',
    },
  }[boardTheme];

  return (
    <div
      id="bangladeshi-snake-ladder-board-container"
      className="relative w-full max-w-[540px] mx-auto flex flex-col items-center select-none"
    >
      {/* Authentic Carved Wood & Terracotta Board Frame */}
      <div
        className={`relative w-full aspect-square rounded-[28px] p-2 sm:p-3.5 bg-gradient-to-br ${themeStyles.boardFrame} border-[5px] sm:border-[6px] shadow-2xl flex flex-col overflow-hidden transition-all duration-300`}
      >
        {/* Brass Filigree Corner Ornaments (ঐতিহ্যবাহী পিতলের কোনা বন্ধনী) */}
        <div className="absolute top-1 left-1 w-6 h-6 border-t-2 border-l-2 border-amber-400/80 rounded-tl-xl pointer-events-none z-30" />
        <div className="absolute top-1 right-1 w-6 h-6 border-t-2 border-r-2 border-amber-400/80 rounded-tr-xl pointer-events-none z-30" />
        <div className="absolute bottom-1 left-1 w-6 h-6 border-b-2 border-l-2 border-amber-400/80 rounded-bl-xl pointer-events-none z-30" />
        <div className="absolute bottom-1 right-1 w-6 h-6 border-b-2 border-r-2 border-amber-400/80 rounded-br-xl pointer-events-none z-30" />

        {/* Top Ornate Header Banner */}
        <div className="relative w-full px-2 py-1 mb-1 rounded-xl bg-gradient-to-r from-amber-950/80 via-neutral-950/90 to-amber-950/80 border border-amber-500/30 flex items-center justify-between z-30 shadow-sm">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm sm:text-base">🐍</span>
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[11px] sm:text-xs font-black tracking-wide bg-gradient-to-r from-amber-200 via-yellow-300 to-amber-400 bg-clip-text text-transparent truncate">
                {language === 'bn' ? 'ঐতিহ্যবাহী বাংলাদেশি সাপ লুডু' : 'Bangladeshi Snake & Ladder'}
              </span>
              <span className="text-[8px] sm:text-[9px] text-amber-300/70 font-mono">
                ১০০ ঘরের ক্লাসিক সাপ-মই খেলা
              </span>
            </div>
          </div>

          {/* Quick Board Style Switcher */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => {
                soundFx.click();
                setBoardTheme(boardTheme === 'vintage' ? 'terracotta' : boardTheme === 'terracotta' ? 'festive' : 'vintage');
              }}
              className="px-2 py-0.5 rounded-lg bg-neutral-900/90 border border-amber-500/30 text-[9px] sm:text-[10px] text-amber-300 hover:text-white hover:border-amber-400 transition flex items-center gap-1 cursor-pointer"
              title="Change Board Style"
            >
              <Sparkles className="w-2.5 h-2.5 text-amber-400" />
              <span>{boardTheme === 'vintage' ? 'ভিন্টেজ' : boardTheme === 'terracotta' ? 'পোড়ামাটি' : 'উৎসব'}</span>
            </button>
          </div>
        </div>

        {/* 10x10 Grid Board Canvas with Authentic Bangladeshi Quadrant Patterns */}
        <div
          className={`relative w-full flex-1 rounded-2xl ${themeStyles.gridBg} grid grid-cols-10 grid-rows-10 gap-0.5 sm:gap-[3px] p-1 sm:p-1.5 border-2 border-neutral-700/80 overflow-hidden shadow-inner`}
        >
          {/* Subtle Nakshi Kantha Texture Overlay */}
          <div className={`absolute inset-0 pointer-events-none z-0 opacity-40 ${themeStyles.parchmentOverlay}`} />

          {tiles.map((tile) => {
            const isWinnerSquare = tile.num === 100;
            const isStartSquare = tile.num === 1;
            const isSnakeHead = Boolean(tile.snake);
            const isLadderBottom = Boolean(tile.ladder);

            // Vibrant 4-color authentic Bangladeshi checkerboard sequence
            let cellStyle = themeStyles.tileYellow;
            const sum = tile.row + tile.col;
            if (sum % 4 === 0) cellStyle = themeStyles.tileRed;
            else if (sum % 4 === 1) cellStyle = themeStyles.tileGreen;
            else if (sum % 4 === 2) cellStyle = themeStyles.tileYellow;
            else cellStyle = themeStyles.tileBlue;

            if (isWinnerSquare) {
              cellStyle =
                'bg-gradient-to-br from-amber-400 via-yellow-500 to-amber-600 text-neutral-950 border-amber-300 ring-2 ring-yellow-300/80 shadow-lg shadow-amber-500/50 font-black';
            } else if (isStartSquare) {
              cellStyle =
                'bg-gradient-to-br from-emerald-600 via-teal-700 to-emerald-800 text-emerald-100 border-emerald-400 ring-1 ring-emerald-300/70 font-black';
            } else if (isSnakeHead) {
              cellStyle = `${cellStyle} ring-1 ring-rose-500/60 shadow-[0_0_8px_rgba(239,68,68,0.25)]`;
            } else if (isLadderBottom) {
              cellStyle = `${cellStyle} ring-1 ring-amber-400/60 shadow-[0_0_8px_rgba(245,158,11,0.25)]`;
            }

            const isInspected = inspectedTile === tile.num;

            return (
              <div
                key={tile.num}
                id={`snake-tile-${tile.num}`}
                onClick={() => {
                  soundFx.click();
                  setInspectedTile(inspectedTile === tile.num ? null : tile.num);
                  if (onTileClick) onTileClick(tile.num);
                }}
                className={`relative rounded sm:rounded-md border flex flex-col justify-between p-0.5 sm:p-1 transition-all duration-150 cursor-pointer overflow-hidden z-1 ${cellStyle} ${
                  isInspected ? 'ring-2 ring-white scale-105 z-20 shadow-xl' : 'hover:brightness-110'
                }`}
                style={{
                  gridRow: tile.row + 1,
                  gridColumn: tile.col + 1,
                }}
              >
                {/* Tile Header: Bengali Numeral (Large) + English Numeral (Subtle) */}
                <div className="flex items-start justify-between w-full leading-none z-2">
                  <span
                    className={`font-black tracking-tighter ${
                      isWinnerSquare
                        ? 'text-neutral-950 text-[10px] sm:text-xs'
                        : 'text-neutral-100 text-[9px] sm:text-[11px]'
                    }`}
                  >
                    {toBengaliNumber(tile.num)}
                  </span>
                  <span
                    className={`text-[6px] sm:text-[7px] font-mono opacity-60 ${
                      isWinnerSquare ? 'text-neutral-900 font-bold' : 'text-neutral-300'
                    }`}
                  >
                    {tile.num}
                  </span>
                </div>

                {/* Center Badge / Special Tile Motif */}
                <div className="flex-1 flex items-center justify-center relative z-2 my-auto">
                  {isWinnerSquare ? (
                    <div className="flex flex-col items-center justify-center animate-bounce">
                      <Crown className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-neutral-950 fill-amber-300" />
                      <span className="text-[6px] sm:text-[7px] font-black uppercase text-neutral-950 leading-none mt-0.5">
                        {language === 'bn' ? 'বিজয়' : 'HOME'}
                      </span>
                    </div>
                  ) : isStartSquare ? (
                    <div className="flex flex-col items-center justify-center">
                      <Flag className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-emerald-200 fill-emerald-300 animate-pulse" />
                      <span className="text-[5px] sm:text-[6px] font-black uppercase text-emerald-200 leading-none">
                        {language === 'bn' ? 'শুরু' : 'START'}
                      </span>
                    </div>
                  ) : isSnakeHead ? (
                    <span
                      className="text-[10px] sm:text-xs filter drop-shadow-md animate-pulse"
                      title={tile.snake?.nameBn}
                    >
                      🐍
                    </span>
                  ) : isLadderBottom ? (
                    <span
                      className="text-[10px] sm:text-xs filter drop-shadow-md"
                      title={tile.ladder?.nameBn}
                    >
                      🪜
                    </span>
                  ) : tile.isSnakeTail ? (
                    <span className="text-[7px] sm:text-[8px] opacity-40 font-mono text-rose-300">
                      ⤓
                    </span>
                  ) : tile.isLadderTop ? (
                    <span className="text-[7px] sm:text-[8px] opacity-50 font-mono text-amber-300">
                      ⭐
                    </span>
                  ) : null}
                </div>

                {/* Bottom Tile Destination Hints for Quick Reading */}
                {isSnakeHead && tile.snake && (
                  <div className="w-full flex items-center justify-end leading-none z-2">
                    <span className="text-[6px] sm:text-[7px] font-black text-rose-300 bg-rose-950/80 px-0.5 rounded border border-rose-700/50">
                      ↓{toBengaliNumber(tile.snake.tail)}
                    </span>
                  </div>
                )}
                {isLadderBottom && tile.ladder && (
                  <div className="w-full flex items-center justify-end leading-none z-2">
                    <span className="text-[6px] sm:text-[7px] font-black text-amber-300 bg-amber-950/80 px-0.5 rounded border border-amber-600/50">
                      ↑{toBengaliNumber(tile.ladder.top)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}

          {/* SVG Overlay: Handcrafted Bangladeshi Wooden/Bamboo Ladders & Serpentine Snakes */}
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none z-10 overflow-visible"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
          >
            <defs>
              {/* Bamboo & Wood Gradients */}
              <linearGradient id="bambooPoleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#fef08a" />
                <stop offset="25%" stopColor="#f59e0b" />
                <stop offset="70%" stopColor="#b45309" />
                <stop offset="100%" stopColor="#78350f" />
              </linearGradient>

              <linearGradient id="goldenLadderGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#fef08a" />
                <stop offset="50%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#d97706" />
              </linearGradient>

              {/* Snake Scales & Body Gradients */}
              <linearGradient id="snakeBlackKrait" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#18181b" />
                <stop offset="35%" stopColor="#facc15" />
                <stop offset="70%" stopColor="#27272a" />
                <stop offset="100%" stopColor="#09090b" />
              </linearGradient>

              <linearGradient id="snakeRedCobra" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#dc2626" />
                <stop offset="40%" stopColor="#ef4444" />
                <stop offset="70%" stopColor="#991b1b" />
                <stop offset="100%" stopColor="#450a0a" />
              </linearGradient>

              <linearGradient id="snakeYellowKrait" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="40%" stopColor="#fbbf24" />
                <stop offset="70%" stopColor="#b45309" />
                <stop offset="100%" stopColor="#78350f" />
              </linearGradient>

              <linearGradient id="snakeGiantPython" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#15803d" />
                <stop offset="35%" stopColor="#22c55e" />
                <stop offset="70%" stopColor="#14532d" />
                <stop offset="100%" stopColor="#052e16" />
              </linearGradient>

              <linearGradient id="snakeGreenGrass" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#16a34a" />
                <stop offset="50%" stopColor="#4ade80" />
                <stop offset="100%" stopColor="#14532d" />
              </linearGradient>

              <linearGradient id="snakePurpleViper" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#9333ea" />
                <stop offset="40%" stopColor="#c084fc" />
                <stop offset="75%" stopColor="#581c87" />
                <stop offset="100%" stopColor="#3b0764" />
              </linearGradient>

              <linearGradient id="snakeWaterSnake" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#0284c7" />
                <stop offset="50%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#075985" />
              </linearGradient>

              <linearGradient id="snakeRatSnake" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ea580c" />
                <stop offset="50%" stopColor="#fb923c" />
                <stop offset="100%" stopColor="#9a3412" />
              </linearGradient>

              {/* 3D Drop Shadow Filter for Realistic Elevation */}
              <filter id="boardShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="3" dy="6" stdDeviation="4" floodColor="#000000" floodOpacity="0.75" />
              </filter>
            </defs>

            {/* ================= 1. RENDER BANGLADESHI LADDERS (বাঁশের ও কাঠের মই) ================= */}
            {Object.entries(BANGLADESHI_LADDERS).map(([bottomStr, ladder]) => {
              const startPos = getTileGridPosition(ladder.bottom);
              const endPos = getTileGridPosition(ladder.top);

              // Grid percentage to 1000x1000 coordinate system
              const x1 = (startPos.col + 0.5) * 100;
              const y1 = (startPos.row + 0.5) * 100;
              const x2 = (endPos.col + 0.5) * 100;
              const y2 = (endPos.row + 0.5) * 100;

              // Calculate angle and normal vector for 3D parallel wooden rails
              const dx = x2 - x1;
              const dy = y2 - y1;
              const length = Math.hypot(dx, dy);
              const angle = Math.atan2(dy, dx);
              const perpX = -Math.sin(angle);
              const perpY = Math.cos(angle);

              // Rail offset width (18px for wide sturdy look)
              const railDist = 18;

              // Left rail
              const lx1 = x1 + perpX * railDist;
              const ly1 = y1 + perpY * railDist;
              const lx2 = x2 + perpX * railDist;
              const ly2 = y2 + perpY * railDist;

              // Right rail
              const rx1 = x1 - perpX * railDist;
              const ry1 = y1 - perpY * railDist;
              const rx2 = x2 - perpX * railDist;
              const ry2 = y2 - perpY * railDist;

              // Generate steps / rungs (ধাপ)
              const rungs = [];
              const rungCount = Math.max(3, Math.min(ladder.rungsCount, 16));
              for (let step = 1; step <= rungCount; step++) {
                const frac = step / (rungCount + 1);
                const stepLx = lx1 + (lx2 - lx1) * frac;
                const stepLy = ly1 + (ly2 - ly1) * frac;
                const stepRx = rx1 + (rx2 - rx1) * frac;
                const stepRy = ry1 + (ry2 - ry1) * frac;
                rungs.push({
                  id: step,
                  x1: stepLx,
                  y1: stepLy,
                  x2: stepRx,
                  y2: stepRy,
                });
              }

              const isHighlighted = inspectedTile === ladder.bottom || inspectedTile === ladder.top;

              return (
                <g
                  key={`ladder-full-${ladder.bottom}-${ladder.top}`}
                  filter="url(#boardShadow)"
                  className="transition-all duration-200"
                  opacity={isHighlighted ? 1 : 0.92}
                >
                  {/* Subtle glowing halo when inspected */}
                  {isHighlighted && (
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="#fbbf24"
                      strokeWidth="52"
                      strokeLinecap="round"
                      opacity="0.4"
                      className="animate-pulse"
                    />
                  )}

                  {/* Parallel Left and Right Bamboo/Wood Poles */}
                  <line
                    x1={lx1}
                    y1={ly1}
                    x2={lx2}
                    y2={ly2}
                    stroke="url(#bambooPoleGrad)"
                    strokeWidth="8"
                    strokeLinecap="round"
                  />
                  <line
                    x1={rx1}
                    y1={ry1}
                    x2={rx2}
                    y2={ry2}
                    stroke="url(#bambooPoleGrad)"
                    strokeWidth="8"
                    strokeLinecap="round"
                  />

                  {/* Ladder Wooden Rungs with Brass Joint Caps */}
                  {rungs.map((r) => (
                    <g key={`rung-${ladder.bottom}-${r.id}`}>
                      <line
                        x1={r.x1}
                        y1={r.y1}
                        x2={r.x2}
                        y2={r.y2}
                        stroke="url(#goldenLadderGrad)"
                        strokeWidth="6"
                        strokeLinecap="round"
                      />
                      {/* Left and Right Joint rivets */}
                      <circle cx={r.x1} cy={r.y1} r="3.5" fill="#facc15" stroke="#78350f" strokeWidth="1" />
                      <circle cx={r.x2} cy={r.y2} r="3.5" fill="#facc15" stroke="#78350f" strokeWidth="1" />
                    </g>
                  ))}

                  {/* Ladder Foot (গোড়া) Marker */}
                  <circle cx={x1} cy={y1} r="9" fill="#f59e0b" stroke="#78350f" strokeWidth="2" opacity="0.8" />
                  {/* Ladder Top (মাথা) Golden Star Indicator */}
                  <circle cx={x2} cy={y2} r="10" fill="#facc15" stroke="#92400e" strokeWidth="2" />
                </g>
              );
            })}

            {/* ================= 2. RENDER BANGLADESHI SNAKES (সাপ ও বিষধর গোখরো) ================= */}
            {Object.entries(BANGLADESHI_SNAKES).map(([headStr, snake]) => {
              const startPos = getTileGridPosition(snake.head);
              const endPos = getTileGridPosition(snake.tail);

              const hX = (startPos.col + 0.5) * 100;
              const hY = (startPos.row + 0.5) * 100;
              const tX = (endPos.col + 0.5) * 100;
              const tY = (endPos.row + 0.5) * 100;

              // Generate organic serpentine curved waves
              const dx = tX - hX;
              const dy = tY - hY;
              const dist = Math.hypot(dx, dy);

              // Wave control points for authentic sinuous snake body
              const waveAmp = (snake.head % 2 === 0 ? 1 : -1) * Math.min(75, dist * 0.28);
              const cp1X = hX + dx * 0.25 - (dy / dist) * waveAmp;
              const cp1Y = hY + dy * 0.25 + (dx / dist) * waveAmp;
              const cp2X = hX + dx * 0.75 + (dy / dist) * (waveAmp * 0.8);
              const cp2Y = hY + dy * 0.75 - (dx / dist) * (waveAmp * 0.8);

              // Sinuous spline path
              const pathD = `M ${hX} ${hY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${tX} ${tY}`;

              // Direction angle of the snake head for fangs & eyes
              const headAngle = Math.atan2(cp1Y - hY, cp1X - hX);
              const hoodPerpX = -Math.sin(headAngle) * 16;
              const hoodPerpY = Math.cos(headAngle) * 16;

              const isHighlighted = inspectedTile === snake.head || inspectedTile === snake.tail;

              return (
                <g
                  key={`snake-full-${snake.head}-${snake.tail}`}
                  filter="url(#boardShadow)"
                  className="transition-all duration-200"
                  opacity={isHighlighted ? 1 : 0.95}
                >
                  {/* Danger aura when inspected */}
                  {isHighlighted && (
                    <path
                      d={pathD}
                      stroke="#ef4444"
                      strokeWidth="36"
                      fill="none"
                      strokeLinecap="round"
                      opacity="0.4"
                      className="animate-pulse"
                    />
                  )}

                  {/* Outer Textured Snake Body */}
                  <path
                    d={pathD}
                    stroke={`url(#${snake.gradientId})`}
                    strokeWidth="15"
                    fill="none"
                    strokeLinecap="round"
                  />

                  {/* Inner Snake Dorsal Scales / Ridge Pattern */}
                  <path
                    d={pathD}
                    stroke="#ffffff"
                    strokeWidth="3.5"
                    strokeDasharray="6 8"
                    fill="none"
                    strokeLinecap="round"
                    opacity="0.6"
                  />

                  {/* Snake Tail Taper */}
                  <circle cx={tX} cy={tY} r="5" fill="#000000" opacity="0.7" />

                  {/* Snake Cobra Hood & Head at (hX, hY) */}
                  <g transform={`translate(${hX}, ${hY})`}>
                    {/* Pulsing warning hazard aura around head */}
                    <circle cx="0" cy="0" r="22" fill="#ef4444" opacity="0.2" className="animate-ping" />

                    {/* Diamond Hood Shape */}
                    <polygon
                      points={`0,-18 16,0 0,20 -16,0`}
                      fill={`url(#${snake.gradientId})`}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      transform={`rotate(${(headAngle * 180) / Math.PI + 90})`}
                    />

                    {/* Dangerous Glowing Eyes */}
                    <circle cx="-5" cy="-2" r="3.5" fill={snake.eyeColor} stroke="#000000" strokeWidth="1" />
                    <circle cx="5" cy="-2" r="3.5" fill={snake.eyeColor} stroke="#000000" strokeWidth="1" />
                    {/* Slit Pupils */}
                    <ellipse cx="-5" cy="-2" rx="1" ry="2.5" fill="#000000" />
                    <ellipse cx="5" cy="-2" rx="1" ry="2.5" fill="#000000" />

                    {/* Red Bifurcated Flickering Tongue */}
                    <path
                      d="M 0 14 L 0 24 M 0 24 L -4 29 M 0 24 L 4 29"
                      stroke={snake.tongueColor}
                      strokeWidth="2"
                      strokeLinecap="round"
                      fill="none"
                      transform={`rotate(${(headAngle * 180) / Math.PI - 90})`}
                    />
                  </g>
                </g>
              );
            })}
          </svg>

          {/* ================= 3. PLAYER TOKENS WITH REALTIME HOVER & TURN BEACONS ================= */}
          {playerOrder.map((uid) => {
            const player = players[uid];
            if (!player) return null;

            const currentTile = playerPositions[uid] || 1;
            const pos = getTileGridPosition(currentTile);
            const isCurrent = uid === currentPlayerUid;
            const isMe = uid === myUid;

            // Offset multiple players occupying the same square
            const sharedPlayersOnTile = playerOrder.filter(
              (oUid) => (playerPositions[oUid] || 1) === currentTile
            );
            const offsetIndex = sharedPlayersOnTile.indexOf(uid);
            const totalShared = sharedPlayersOnTile.length;
            const offsetX = totalShared > 1 ? (offsetIndex - (totalShared - 1) / 2) * 10 : 0;
            const offsetY = totalShared > 1 ? (offsetIndex % 2 === 0 ? -5 : 5) : 0;

            const colorMap: Record<PlayerColor, { bg: string; ring: string; border: string; glow: string }> = {
              red: {
                bg: 'from-rose-500 via-red-600 to-rose-900',
                ring: 'ring-rose-400',
                border: 'border-rose-300',
                glow: 'shadow-rose-500/80',
              },
              green: {
                bg: 'from-emerald-400 via-emerald-600 to-teal-900',
                ring: 'ring-emerald-400',
                border: 'border-emerald-300',
                glow: 'shadow-emerald-500/80',
              },
              yellow: {
                bg: 'from-amber-300 via-amber-500 to-yellow-800',
                ring: 'ring-amber-300',
                border: 'border-amber-200',
                glow: 'shadow-amber-500/80',
              },
              blue: {
                bg: 'from-sky-400 via-blue-600 to-indigo-900',
                ring: 'ring-sky-400',
                border: 'border-sky-300',
                glow: 'shadow-sky-500/80',
              },
            };

            const pColor = colorMap[player.color || 'red'];

            return (
              <motion.div
                key={`player-token-${uid}`}
                layout
                transition={{
                  type: 'spring',
                  stiffness: 280,
                  damping: 22,
                }}
                className="absolute z-20 pointer-events-none flex items-center justify-center"
                style={{
                  left: `${pos.col * 10}%`,
                  top: `${pos.row * 10}%`,
                  width: '10%',
                  height: '10%',
                  transform: `translate(${offsetX}px, ${offsetY}px)`,
                }}
              >
                {/* Active Turn Radiant Pulse Ring */}
                {isCurrent && (
                  <motion.div
                    animate={{ scale: [1, 1.45, 1], opacity: [0.9, 0.2, 0.9] }}
                    transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
                    className={`absolute inset-0 rounded-full border-2 ${pColor.border} bg-amber-400/20 pointer-events-none`}
                  />
                )}

                <motion.div
                  animate={
                    isCurrent
                      ? {
                          scale: [1, 1.22, 1],
                          y: [0, -4, 0],
                        }
                      : {}
                  }
                  transition={isCurrent ? { repeat: Infinity, duration: 1.5, ease: 'easeInOut' } : {}}
                  className={`relative w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br ${pColor.bg} border-2 ${pColor.border} shadow-xl flex items-center justify-center text-xs sm:text-sm font-black text-white ${
                    isCurrent ? `ring-3 ${pColor.ring} ${pColor.glow} shadow-lg` : ''
                  }`}
                >
                  <span className="select-none text-[11px] sm:text-sm">{player.avatar || '👤'}</span>

                  {/* You Badge */}
                  {isMe && (
                    <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-amber-400 rounded-full border border-black text-[7px] font-black text-black flex items-center justify-center shadow">
                      ★
                    </span>
                  )}

                  {/* Current Square Tooltip On Token */}
                  <span className="absolute -bottom-2 bg-black/90 text-[7px] text-amber-300 font-mono px-1 rounded-full border border-neutral-700">
                    {toBengaliNumber(currentTile)}
                  </span>
                </motion.div>
              </motion.div>
            );
          })}

          {/* ================= 4. DYNAMIC CELEBRATION & BENGALI TOAST OVERLAYS ================= */}
          <AnimatePresence>
            {lastEvent && (
              <motion.div
                initial={{ scale: 0.7, opacity: 0, y: -20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.8, opacity: 0, y: -15 }}
                transition={{ type: 'spring', damping: 18 }}
                className="absolute inset-x-2 top-2 z-40 pointer-events-none flex justify-center"
              >
                {lastEvent.type === 'LADDER' && (
                  <div className="bg-gradient-to-r from-emerald-950 via-teal-950 to-emerald-950 border-2 border-amber-400 px-4 py-2 rounded-2xl shadow-2xl flex items-center gap-3 text-emerald-200 backdrop-blur-md">
                    <span className="text-2xl animate-bounce">🪜</span>
                    <div className="text-left">
                      <p className="text-xs sm:text-sm font-black text-amber-300">
                        {language === 'bn' ? 'সাবাশ! মই বেয়ে তরতরিয়ে উপরে উঠলেন!' : 'Climbed up the Ladder!'}
                      </p>
                      <p className="text-[10px] sm:text-xs text-emerald-300 font-mono font-bold">
                        {toBengaliNumber(lastEvent.from)} ➔ {toBengaliNumber(lastEvent.to)} ({language === 'bn' ? 'উপরে লাফ' : 'Ascent'})
                      </p>
                    </div>
                  </div>
                )}

                {lastEvent.type === 'SNAKE' && (
                  <div className="bg-gradient-to-r from-red-950 via-rose-950 to-red-950 border-2 border-rose-500 px-4 py-2 rounded-2xl shadow-2xl flex items-center gap-3 text-red-200 backdrop-blur-md">
                    <span className="text-2xl animate-pulse">🐍</span>
                    <div className="text-left">
                      <p className="text-xs sm:text-sm font-black text-rose-300">
                        {language === 'bn' ? 'আহারে! সাপের মুখে কাটা পড়লেন!' : 'Bitten by a Snake!'}
                      </p>
                      <p className="text-[10px] sm:text-xs text-red-300 font-mono font-bold">
                        {toBengaliNumber(lastEvent.from)} ➔ {toBengaliNumber(lastEvent.to)} ({language === 'bn' ? 'নিচে পতন' : 'Slide down'})
                      </p>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Interactive Tile Inspector Details Bar */}
        {inspectedTile && (
          <div className="mt-1.5 p-2 rounded-xl bg-black/90 border border-amber-500/40 text-xs flex items-center justify-between gap-2 z-30 animate-fadeIn">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono font-bold text-amber-300 text-sm">
                ঘর #{toBengaliNumber(inspectedTile)} ({inspectedTile})
              </span>
              {BANGLADESHI_SNAKES[inspectedTile] && (
                <span className="text-rose-300 text-[11px] font-semibold truncate">
                  🐍 {BANGLADESHI_SNAKES[inspectedTile].nameBn} ➔ ঘর {toBengaliNumber(BANGLADESHI_SNAKES[inspectedTile].tail)}
                </span>
              )}
              {BANGLADESHI_LADDERS[inspectedTile] && (
                <span className="text-emerald-300 text-[11px] font-semibold truncate">
                  🪜 {BANGLADESHI_LADDERS[inspectedTile].nameBn} ➔ ঘর {toBengaliNumber(BANGLADESHI_LADDERS[inspectedTile].top)}
                </span>
              )}
              {!BANGLADESHI_SNAKES[inspectedTile] && !BANGLADESHI_LADDERS[inspectedTile] && (
                <span className="text-neutral-400 text-[11px]">
                  {inspectedTile === 100
                    ? '🏆 চূড়ান্ত বিজয়ী ঘর (Home)'
                    : inspectedTile === 1
                    ? '🚩 খেলার শুরু (Start)'
                    : 'সাধারণ ঘর'}
                </span>
              )}
            </div>
            <button
              onClick={() => setInspectedTile(null)}
              className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 hover:text-white text-[10px]"
            >
              বন্ধ করুন
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

