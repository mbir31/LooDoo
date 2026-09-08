import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RoomPlayer, PlayerColor, Language } from '../../types';
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
  HelpCircle,
  Compass,
  Layers,
  ChevronRight,
  X,
  Footprints,
  TrendingUp,
  TrendingDown,
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
// Sourced from engine to guarantee zero drift with the rules engine.
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
  fallCount: number;
  loreBn: string;
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
    fallCount: 19,
    loreBn: 'শতবর্ষী কালো ফণা, ৯৮ নম্বর ঘরে ওত পেতে থাকা রাজকীয় কালনাগিনী।',
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
    fallCount: 20,
    loreBn: 'চওড়া ফণায় পদ্ম আঁকা রাজকীয় গোখরো, নিমেষেই নামিয়ে দেয় ৭৫ ঘরে।',
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
    fallCount: 20,
    loreBn: 'হলুদ-কালো বলয়যুক্ত শান্ত কিন্তু অচিন্তনীয় ক্ষিপ্র শঙ্খিনী সাপ।',
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
    fallCount: 51,
    loreBn: 'সুন্দরবনের সবচেয়ে বড় সাপ—এক কামড়ে ৮৭ ঘর থেকে সোজা ৩৬ ঘরে টেনে নেয়!',
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
    fallCount: 4,
    loreBn: 'গ্রামের মেঠোপথের নিরীহ সবুজ সাপ, সামান্য ৪ ঘর নিচে নামিয়ে দেয়।',
  },
  62: {
    head: 62,
    tail: 19,
    nameBn: 'ভয়ংকর রাসেল ভাইপার (চন্দ্রবোড়া)',
    nameEn: "Russell's Viper (-43 Squares)",
    typeBn: 'তীব্র বিষধর ভাইপার',
    dangerBadge: '🩸 ৪৩ ঘর পিছলে যাওয়া!',
    gradientId: 'snakePurpleViper',
    eyeColor: '#f43f5e',
    tongueColor: '#991b1b',
    fallCount: 43,
    loreBn: 'ভয়ানক হিসহিস শব্দকারী চন্দ্রবোড়া, ৬২ নম্বর থেকে সোজা ১৯ ঘরে ফেলে দেয়।',
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
    fallCount: 20,
    loreBn: 'পদ্মা-মেঘনার চরের জলঢোঁড়া, পিছলে ৩৪ নম্বরের জলে ফেলে দেয়।',
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
    fallCount: 10,
    loreBn: 'শুরুর দিকে ফাঁদ পেতে থাকা দ্রুতগতির চঞ্চল দাঁড়াশ সাপ।',
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
  jumpCount: number;
  loreBn: string;
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
    jumpCount: 10,
    loreBn: 'গ্রামের উঠোনের হালকা কাঁচা বাঁশের মই, শুরুতেই তরতরিয়ে ১০ ঘর উপরে!',
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
    jumpCount: 22,
    loreBn: 'ভারী সেগুন কাঠের সিঁড়ি, নিমেষেই ৯ ঘর থেকে ৩১ ঘরে পৌঁছে দেয়।',
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
    jumpCount: 21,
    loreBn: 'ধানের গোলার পাশে রাখা পোক্ত মই, তরতরিয়ে নিয়ে যায় ৪২ ঘরে।',
  },
  28: {
    bottom: 28,
    top: 84,
    nameBn: 'আকাশ ছোঁয়া মহা মই',
    nameEn: 'Grand Sky Ladder (+56 Squares)',
    typeBn: 'বিশাল সোনার সিঁড়ি',
    boostText: '🚀 +৫৬ ঘর বিশাল উল্লম্ফন!',
    rungsCount: 14,
    woodColor: '#fbbf24',
    jumpCount: 56,
    loreBn: 'খেলার সবচেয়ে বড় মই! এক দমে ২৮ থেকে সোজা ৮৪ ঘরের বিজয় শিখরে!',
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
    jumpCount: 16,
    loreBn: 'উদ্বেগ কাটিয়ে দ্রুতগতিতে ৫১ থেকে ৬৭ ঘরে পার করে দেয়।',
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
    jumpCount: 19,
    loreBn: 'চরম উত্তেজনায় ৭২ থেকে সোজা ৯১ ঘরে রাজকীয় উত্তরণ!',
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
    jumpCount: 19,
    loreBn: 'বিজয়ের ঠিক এক ঘর আগে ৯৯ নম্বরের দুয়ারে এনে দেয় এই সোনার মই।',
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
  const [row, col] = getCellCoords(tile);
  return { row, col };
}

type BoardThemeKey = 'heritage' | 'obsidian' | 'royal';

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
  const [boardTheme, setBoardTheme] = useState<BoardThemeKey>('heritage');
  const [showPathGuides, setShowPathGuides] = useState<boolean>(false);
  const [showLegendModal, setShowLegendModal] = useState<boolean>(false);

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

  // Modern, high-contrast, polished theme styling palettes
  const themeStyles = {
    heritage: {
      nameBn: 'ঐতিহ্যবাহী স্বর্ণালী',
      nameEn: 'Heritage Gold',
      boardWrapper:
        'bg-gradient-to-b from-[#25150d] via-[#1a0e08] to-[#100703] border-[#b45309]/60 shadow-[0_24px_60px_rgba(0,0,0,0.85),inset_0_1px_1px_rgba(251,191,36,0.3)]',
      headerBg: 'bg-[#180d07]/90 border-amber-500/30 text-amber-200',
      gridBg: 'bg-[#140b06]',
      gridBorder: 'border-amber-900/40',
      tileRed:
        'bg-gradient-to-br from-[#4c1216] via-[#3d0d11] to-[#2b080b] border-rose-900/50 text-rose-100 hover:border-rose-500/50',
      tileGreen:
        'bg-gradient-to-br from-[#0c3a23] via-[#082b19] to-[#041c10] border-emerald-900/50 text-emerald-100 hover:border-emerald-500/50',
      tileYellow:
        'bg-gradient-to-br from-[#4a2b0a] via-[#382006] to-[#261403] border-amber-900/50 text-amber-100 hover:border-amber-500/50',
      tileBlue:
        'bg-gradient-to-br from-[#122b4d] via-[#0d1e38] to-[#081324] border-sky-900/50 text-sky-100 hover:border-sky-500/50',
      numPrimary: 'text-neutral-100',
      numSecondary: 'text-neutral-400',
      overlayTexture: 'bg-[radial-gradient(#f59e0b12_1px,transparent_1px)] [background-size:10px_10px]',
      cornerAccents: 'border-amber-400/70',
    },
    obsidian: {
      nameBn: 'অবসিডিয়ান নিয়ন',
      nameEn: 'Obsidian Neon',
      boardWrapper:
        'bg-gradient-to-b from-[#141522] via-[#0d0e17] to-[#07080d] border-cyan-500/40 shadow-[0_24px_60px_rgba(0,0,0,0.9),inset_0_1px_1px_rgba(56,189,248,0.25)]',
      headerBg: 'bg-[#0e101a]/90 border-cyan-500/30 text-cyan-200',
      gridBg: 'bg-[#090b12]',
      gridBorder: 'border-slate-800/60',
      tileRed:
        'bg-gradient-to-br from-[#380e22] via-[#2a0918] to-[#1c050f] border-rose-900/40 text-rose-100 hover:border-rose-400/50',
      tileGreen:
        'bg-gradient-to-br from-[#073629] via-[#04281e] to-[#021812] border-emerald-800/40 text-emerald-100 hover:border-emerald-400/50',
      tileYellow:
        'bg-gradient-to-br from-[#382806] via-[#291d03] to-[#1b1201] border-yellow-800/40 text-amber-100 hover:border-yellow-400/50',
      tileBlue:
        'bg-gradient-to-br from-[#0f244a] via-[#0a1833] to-[#060e1f] border-cyan-800/40 text-cyan-100 hover:border-cyan-400/50',
      numPrimary: 'text-slate-100',
      numSecondary: 'text-slate-400',
      overlayTexture: 'bg-[radial-gradient(#38bdf812_1px,transparent_1px)] [background-size:10px_10px]',
      cornerAccents: 'border-cyan-400/70',
    },
    royal: {
      nameBn: 'রাজকীয় রত্ন',
      nameEn: 'Royal Gem',
      boardWrapper:
        'bg-gradient-to-b from-[#2d0e42] via-[#1a0728] to-[#0e0216] border-fuchsia-500/40 shadow-[0_24px_60px_rgba(0,0,0,0.92),inset_0_1px_1px_rgba(232,121,249,0.3)]',
      headerBg: 'bg-[#1a082b]/90 border-fuchsia-500/30 text-fuchsia-200',
      gridBg: 'bg-[#10031c]',
      gridBorder: 'border-purple-900/40',
      tileRed:
        'bg-gradient-to-br from-[#450e20] via-[#330816] to-[#20040d] border-rose-800/50 text-rose-100 hover:border-rose-400/50',
      tileGreen:
        'bg-gradient-to-br from-[#0a3832] via-[#062924] to-[#031815] border-teal-800/50 text-teal-100 hover:border-teal-400/50',
      tileYellow:
        'bg-gradient-to-br from-[#4e3207] via-[#3a2404] to-[#251601] border-amber-700/50 text-amber-100 hover:border-amber-400/50',
      tileBlue:
        'bg-gradient-to-br from-[#29135c] via-[#1d0c43] to-[#12062b] border-purple-800/50 text-purple-100 hover:border-purple-400/50',
      numPrimary: 'text-fuchsia-100',
      numSecondary: 'text-purple-300/70',
      overlayTexture: 'bg-[radial-gradient(#c084fc12_1px,transparent_1px)] [background-size:10px_10px]',
      cornerAccents: 'border-fuchsia-400/70',
    },
  }[boardTheme];

  return (
    <div
      id="bangladeshi-snake-ladder-board-container"
      className="relative w-full max-w-[540px] mx-auto flex flex-col items-center select-none"
    >
      {/* Outer Polished Bezel Card */}
      <div
        className={`relative w-full aspect-square rounded-[26px] p-2 sm:p-3.5 border-[3px] sm:border-[4px] flex flex-col overflow-hidden transition-all duration-300 ${themeStyles.boardWrapper}`}
      >
        {/* Sleek Precision Chamfer Corner Accents */}
        <div className={`absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 ${themeStyles.cornerAccents} rounded-tl-lg pointer-events-none z-30`} />
        <div className={`absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 ${themeStyles.cornerAccents} rounded-tr-lg pointer-events-none z-30`} />
        <div className={`absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 ${themeStyles.cornerAccents} rounded-bl-lg pointer-events-none z-30`} />
        <div className={`absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 ${themeStyles.cornerAccents} rounded-br-lg pointer-events-none z-30`} />

        {/* Minimalist Top Control Ribbon */}
        <div
          className={`relative w-full px-2.5 py-1 mb-1.5 rounded-xl border backdrop-blur-md flex items-center justify-between z-30 shadow-md ${themeStyles.headerBg}`}
        >
          {/* Title & Badge */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-amber-500/20 border border-amber-400/40 flex items-center justify-center shrink-0">
              <span className="text-sm">🐍</span>
            </div>
            <div className="flex flex-col leading-tight min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs sm:text-sm font-black tracking-tight text-white truncate">
                  {language === 'bn' ? 'সাপ-লুডু' : 'Snakes & Ladders'}
                </span>
                <span className="px-1.5 py-0.2 rounded-full bg-amber-400/20 border border-amber-400/40 text-[9px] font-bold text-amber-300 font-mono">
                  {language === 'bn' ? '১০০ ঘর' : '100 Cells'}
                </span>
              </div>
            </div>
          </div>

          {/* Controls: Paths, Rules, Theme */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            {/* Show Paths Toggle */}
            <button
              onClick={() => {
                soundFx.click();
                setShowPathGuides((prev) => !prev);
              }}
              className={`px-2 py-1 rounded-lg border text-[10px] font-bold transition flex items-center gap-1 cursor-pointer ${
                showPathGuides
                  ? 'bg-amber-400 text-neutral-950 border-amber-300 shadow-sm shadow-amber-400/40'
                  : 'bg-neutral-900/80 text-neutral-300 border-neutral-700/60 hover:text-white hover:border-neutral-500'
              }`}
              title={language === 'bn' ? 'সব সাপ ও মইয়ের পথ দেখাও' : 'Toggle Path Guides'}
            >
              <Compass className="w-3 h-3" />
              <span className="hidden sm:inline">{language === 'bn' ? 'পথ' : 'Paths'}</span>
            </button>

            {/* Rules / Legend Modal Trigger */}
            <button
              onClick={() => {
                soundFx.click();
                setShowLegendModal(true);
              }}
              className="p-1 sm:px-2 sm:py-1 rounded-lg bg-neutral-900/80 border border-neutral-700/60 text-neutral-300 hover:text-white hover:border-neutral-500 text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
              title={language === 'bn' ? 'সাপ ও মইয়ের পূর্ণ তালিকা' : 'View Legend & Lore'}
            >
              <HelpCircle className="w-3 h-3 text-amber-400" />
              <span className="hidden sm:inline">{language === 'bn' ? 'নিয়ম' : 'Guide'}</span>
            </button>

            {/* Theme Switcher Button */}
            <button
              onClick={() => {
                soundFx.click();
                setBoardTheme((prev) =>
                  prev === 'heritage' ? 'obsidian' : prev === 'obsidian' ? 'royal' : 'heritage'
                );
              }}
              className="px-2 py-1 rounded-lg bg-neutral-900/80 border border-neutral-700/60 text-amber-300 hover:text-white hover:border-amber-400/80 text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
              title={language === 'bn' ? 'থিম পরিবর্তন' : 'Switch Theme'}
            >
              <Sparkles className="w-3 h-3 text-amber-400" />
              <span className="truncate max-w-[58px] sm:max-w-none">
                {boardTheme === 'heritage' ? 'স্বর্ণালী' : boardTheme === 'obsidian' ? 'নিয়ন' : 'রাজকীয়'}
              </span>
            </button>
          </div>
        </div>

        {/* 10x10 Grid Board Canvas */}
        <div
          className={`relative w-full flex-1 rounded-2xl ${themeStyles.gridBg} grid grid-cols-10 grid-rows-10 gap-[2px] sm:gap-[3px] p-1 sm:p-1.5 border ${themeStyles.gridBorder} overflow-hidden shadow-inner`}
          style={{
            gridTemplateColumns: 'repeat(10, minmax(0, 1fr))',
            gridTemplateRows: 'repeat(10, minmax(0, 1fr))',
          }}
        >
          {/* Subtle Authentic Textile Overlay */}
          <div className={`absolute inset-0 pointer-events-none z-0 opacity-40 ${themeStyles.overlayTexture}`} />

          {/* 100 Board Cells */}
          {tiles.map((tile) => {
            const isWinnerSquare = tile.num === 100;
            const isStartSquare = tile.num === 1;
            const isSnakeHead = Boolean(tile.snake);
            const isLadderBottom = Boolean(tile.ladder);

            // Modern 4-color checkerboard rhythmic sequence
            let cellStyle = themeStyles.tileYellow;
            const sum = tile.row + tile.col;
            if (sum % 4 === 0) cellStyle = themeStyles.tileRed;
            else if (sum % 4 === 1) cellStyle = themeStyles.tileGreen;
            else if (sum % 4 === 2) cellStyle = themeStyles.tileYellow;
            else cellStyle = themeStyles.tileBlue;

            if (isWinnerSquare) {
              cellStyle =
                'bg-gradient-to-br from-amber-400 via-yellow-500 to-amber-600 text-neutral-950 border-amber-300 ring-2 ring-yellow-300/90 shadow-lg shadow-amber-500/40 font-black';
            } else if (isStartSquare) {
              cellStyle =
                'bg-gradient-to-br from-emerald-600 via-teal-700 to-emerald-800 text-emerald-100 border-emerald-400 ring-1.5 ring-emerald-300/80 font-black';
            } else if (isSnakeHead) {
              cellStyle = `${cellStyle} ring-1 ring-rose-500/70 shadow-[0_0_10px_rgba(244,63,94,0.3)]`;
            } else if (isLadderBottom) {
              cellStyle = `${cellStyle} ring-1 ring-amber-400/70 shadow-[0_0_10px_rgba(245,158,11,0.3)]`;
            }

            const isInspected = inspectedTile === tile.num;
            const isConnectedToInspected =
              inspectedTile !== null &&
              ((tile.snake && tile.snake.tail === inspectedTile) ||
                (tile.ladder && tile.ladder.top === inspectedTile) ||
                (BANGLADESHI_SNAKES[inspectedTile]?.tail === tile.num) ||
                (BANGLADESHI_LADDERS[inspectedTile]?.top === tile.num));

            return (
              <div
                key={tile.num}
                id={`snake-tile-${tile.num}`}
                onClick={() => {
                  soundFx.click();
                  setInspectedTile(inspectedTile === tile.num ? null : tile.num);
                  if (onTileClick) onTileClick(tile.num);
                }}
                className={`relative rounded-[5px] sm:rounded-[7px] border flex flex-col justify-between p-0.5 sm:p-1 transition-all duration-200 cursor-pointer overflow-hidden z-1 ${cellStyle} ${
                  isInspected
                    ? 'ring-2 ring-white scale-105 z-20 shadow-2xl brightness-125'
                    : isConnectedToInspected
                    ? 'ring-2 ring-amber-300/90 scale-102 z-15 brightness-115'
                    : 'hover:brightness-110 active:scale-95'
                }`}
                style={{
                  gridRow: tile.row + 1,
                  gridColumn: tile.col + 1,
                }}
              >
                {/* Tile Top Header: Bengali Numeral (Crisp & Bold) + Small English Index */}
                <div className="flex items-start justify-between w-full leading-none z-2">
                  <span
                    className={`font-black tracking-tight ${
                      isWinnerSquare
                        ? 'text-neutral-950 text-[10px] sm:text-[12px]'
                        : `${themeStyles.numPrimary} text-[9px] sm:text-[11px]`
                    }`}
                  >
                    {toBengaliNumber(tile.num)}
                  </span>
                  <span
                    className={`text-[6px] sm:text-[7.5px] font-mono opacity-60 ${
                      isWinnerSquare ? 'text-neutral-900 font-bold' : themeStyles.numSecondary
                    }`}
                  >
                    {tile.num}
                  </span>
                </div>

                {/* Tile Center Emblem / Landmark Motif */}
                <div className="flex-1 flex items-center justify-center relative z-2 my-auto">
                  {isWinnerSquare ? (
                    <div className="flex flex-col items-center justify-center animate-bounce">
                      <Crown className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-neutral-950 fill-amber-300" />
                      <span className="text-[5.5px] sm:text-[7px] font-black uppercase text-neutral-950 leading-none mt-0.5">
                        {language === 'bn' ? 'বিজয়' : 'HOME'}
                      </span>
                    </div>
                  ) : isStartSquare ? (
                    <div className="flex flex-col items-center justify-center">
                      <Flag className="w-2.5 h-2.5 sm:w-3.5 sm:h-3.5 text-emerald-200 fill-emerald-300 animate-pulse" />
                      <span className="text-[5px] sm:text-[6.5px] font-black uppercase text-emerald-200 leading-none">
                        {language === 'bn' ? 'শুরু' : 'START'}
                      </span>
                    </div>
                  ) : isSnakeHead ? (
                    <div className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-rose-950/70 border border-rose-500/60 flex items-center justify-center shadow-sm">
                      <span className="text-[10px] sm:text-xs filter drop-shadow animate-pulse">🐍</span>
                    </div>
                  ) : isLadderBottom ? (
                    <div className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-amber-950/70 border border-amber-500/60 flex items-center justify-center shadow-sm">
                      <span className="text-[10px] sm:text-xs filter drop-shadow">🪜</span>
                    </div>
                  ) : tile.isSnakeTail ? (
                    <div className="w-3 h-3 rounded-full bg-rose-900/30 border border-rose-500/30 flex items-center justify-center">
                      <span className="text-[7px] font-bold text-rose-300">↓</span>
                    </div>
                  ) : tile.isLadderTop ? (
                    <div className="w-3 h-3 rounded-full bg-amber-400/20 border border-amber-400/40 flex items-center justify-center">
                      <span className="text-[7px] font-bold text-amber-300">★</span>
                    </div>
                  ) : null}
                </div>

                {/* Bottom Destination Indicators */}
                {isSnakeHead && tile.snake && (
                  <div className="w-full flex items-center justify-end leading-none z-2">
                    <span className="text-[6px] sm:text-[7.5px] font-black text-rose-200 bg-rose-950/90 px-1 py-0.2 rounded border border-rose-700/60 shadow-xs">
                      ↓{toBengaliNumber(tile.snake.tail)}
                    </span>
                  </div>
                )}
                {isLadderBottom && tile.ladder && (
                  <div className="w-full flex items-center justify-end leading-none z-2">
                    <span className="text-[6px] sm:text-[7.5px] font-black text-amber-200 bg-amber-950/90 px-1 py-0.2 rounded border border-amber-600/60 shadow-xs">
                      ↑{toBengaliNumber(tile.ladder.top)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}

          {/* SVG Overlay: Handcrafted Bangladeshi Wooden Ladders & Curved Serpentine Snakes */}
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none z-10 overflow-visible"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
          >
            <defs>
              {/* Realistic Bamboo & Hardwood Rails Gradients */}
              <linearGradient id="bambooPoleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#fde68a" />
                <stop offset="25%" stopColor="#f59e0b" />
                <stop offset="65%" stopColor="#b45309" />
                <stop offset="100%" stopColor="#78350f" />
              </linearGradient>

              <linearGradient id="goldenLadderGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#fef08a" />
                <stop offset="45%" stopColor="#fbbf24" />
                <stop offset="85%" stopColor="#d97706" />
                <stop offset="100%" stopColor="#92400e" />
              </linearGradient>

              {/* Realistic Vernacular Snakes Gradients */}
              <linearGradient id="snakeBlackKrait" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#09090b" />
                <stop offset="20%" stopColor="#facc15" />
                <stop offset="45%" stopColor="#18181b" />
                <stop offset="75%" stopColor="#eab308" />
                <stop offset="100%" stopColor="#0a0a0c" />
              </linearGradient>

              <linearGradient id="snakeRedCobra" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="35%" stopColor="#dc2626" />
                <stop offset="70%" stopColor="#991b1b" />
                <stop offset="100%" stopColor="#450a0a" />
              </linearGradient>

              <linearGradient id="snakeYellowKrait" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="35%" stopColor="#fbbf24" />
                <stop offset="65%" stopColor="#78350f" />
                <stop offset="100%" stopColor="#292524" />
              </linearGradient>

              <linearGradient id="snakeGiantPython" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#16a34a" />
                <stop offset="30%" stopColor="#22c55e" />
                <stop offset="65%" stopColor="#15803d" />
                <stop offset="100%" stopColor="#052e16" />
              </linearGradient>

              <linearGradient id="snakeGreenGrass" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#22c55e" />
                <stop offset="50%" stopColor="#4ade80" />
                <stop offset="100%" stopColor="#166534" />
              </linearGradient>

              <linearGradient id="snakePurpleViper" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a855f7" />
                <stop offset="35%" stopColor="#c084fc" />
                <stop offset="70%" stopColor="#6b21a8" />
                <stop offset="100%" stopColor="#3b0764" />
              </linearGradient>

              <linearGradient id="snakeWaterSnake" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#0284c7" />
                <stop offset="45%" stopColor="#38bdf8" />
                <stop offset="80%" stopColor="#0369a1" />
                <stop offset="100%" stopColor="#082f49" />
              </linearGradient>

              <linearGradient id="snakeRatSnake" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ea580c" />
                <stop offset="40%" stopColor="#fb923c" />
                <stop offset="75%" stopColor="#c2410c" />
                <stop offset="100%" stopColor="#7c2d12" />
              </linearGradient>

              {/* 3D Depth Drop Shadow for realistic floating elevation */}
              <filter id="boardShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="3" dy="6" stdDeviation="4" floodColor="#000000" floodOpacity="0.8" />
              </filter>
            </defs>

            {/* ================= 1. RENDER BANGLADESHI LADDERS (বাঁশের ও কাঠের মই) ================= */}
            {Object.entries(BANGLADESHI_LADDERS).map(([bottomStr, ladder]) => {
              const startPos = getTileGridPosition(ladder.bottom);
              const endPos = getTileGridPosition(ladder.top);

              // Scale to 1000x1000 grid coordinate space
              const x1 = (startPos.col + 0.5) * 100;
              const y1 = (startPos.row + 0.5) * 100;
              const x2 = (endPos.col + 0.5) * 100;
              const y2 = (endPos.row + 0.5) * 100;

              // Orthogonal normal vector for 3D parallel wooden rails
              const dx = x2 - x1;
              const dy = y2 - y1;
              const angle = Math.atan2(dy, dx);
              const perpX = -Math.sin(angle);
              const perpY = Math.cos(angle);

              // Spacing between rails
              const railDist = 17;

              // Left and right rail paths
              const lx1 = x1 + perpX * railDist;
              const ly1 = y1 + perpY * railDist;
              const lx2 = x2 + perpX * railDist;
              const ly2 = y2 + perpY * railDist;

              const rx1 = x1 - perpX * railDist;
              const ry1 = y1 - perpY * railDist;
              const rx2 = x2 - perpX * railDist;
              const ry2 = y2 - perpY * railDist;

              // Compute rungs along the ladder
              const rungs = [];
              const rungCount = Math.max(3, Math.min(ladder.rungsCount, 15));
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

              const isHighlighted =
                inspectedTile === ladder.bottom ||
                inspectedTile === ladder.top ||
                showPathGuides;

              return (
                <g
                  key={`ladder-full-${ladder.bottom}-${ladder.top}`}
                  filter="url(#boardShadow)"
                  className="transition-all duration-300"
                  opacity={isHighlighted ? 1 : 0.9}
                >
                  {/* Glowing Aura when Active or Inspected */}
                  {isHighlighted && (
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="#fbbf24"
                      strokeWidth="50"
                      strokeLinecap="round"
                      opacity="0.35"
                      className="animate-pulse"
                    />
                  )}

                  {/* Parallel Left & Right Rails */}
                  <line
                    x1={lx1}
                    y1={ly1}
                    x2={lx2}
                    y2={ly2}
                    stroke="url(#bambooPoleGrad)"
                    strokeWidth="7.5"
                    strokeLinecap="round"
                  />
                  <line
                    x1={rx1}
                    y1={ry1}
                    x2={rx2}
                    y2={ry2}
                    stroke="url(#bambooPoleGrad)"
                    strokeWidth="7.5"
                    strokeLinecap="round"
                  />

                  {/* Specular Edge Highlights on Rails */}
                  <line
                    x1={lx1 + perpX * 1.5}
                    y1={ly1 + perpY * 1.5}
                    x2={lx2 + perpX * 1.5}
                    y2={ly2 + perpY * 1.5}
                    stroke="#fef08a"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    opacity="0.6"
                  />

                  {/* Ladder Rungs with Brass Joint Caps */}
                  {rungs.map((r) => (
                    <g key={`rung-${ladder.bottom}-${r.id}`}>
                      <line
                        x1={r.x1}
                        y1={r.y1}
                        x2={r.x2}
                        y2={r.y2}
                        stroke="url(#goldenLadderGrad)"
                        strokeWidth="5.5"
                        strokeLinecap="round"
                      />
                      {/* Brass joint rivets */}
                      <circle cx={r.x1} cy={r.y1} r="3" fill="#facc15" stroke="#78350f" strokeWidth="1" />
                      <circle cx={r.x2} cy={r.y2} r="3" fill="#facc15" stroke="#78350f" strokeWidth="1" />
                    </g>
                  ))}

                  {/* Ladder Foot (গোড়া) Launchpad Disc */}
                  <circle cx={x1} cy={y1} r="9" fill="#f59e0b" stroke="#78350f" strokeWidth="2" opacity="0.9" />
                  <circle cx={x1} cy={y1} r="4" fill="#ffffff" opacity="0.7" />

                  {/* Ladder Top Landing Beacon */}
                  <circle cx={x2} cy={y2} r="10" fill="#facc15" stroke="#92400e" strokeWidth="2" />
                  <circle cx={x2} cy={y2} r="5" fill="#fef08a" />
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

              // Generate organic serpentine curves
              const dx = tX - hX;
              const dy = tY - hY;
              const dist = Math.hypot(dx, dy);

              // Multi-segment wave amplitude
              const waveAmp = (snake.head % 2 === 0 ? 1 : -1) * Math.min(72, dist * 0.26);
              const cp1X = hX + dx * 0.25 - (dy / dist) * waveAmp;
              const cp1Y = hY + dy * 0.25 + (dx / dist) * waveAmp;
              const cp2X = hX + dx * 0.75 + (dy / dist) * (waveAmp * 0.85);
              const cp2Y = hY + dy * 0.75 - (dx / dist) * (waveAmp * 0.85);

              // Sinuous spline path
              const pathD = `M ${hX} ${hY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${tX} ${tY}`;

              // Entry angle of head
              const headAngle = Math.atan2(cp1Y - hY, cp1X - hX);

              const isHighlighted =
                inspectedTile === snake.head ||
                inspectedTile === snake.tail ||
                showPathGuides;

              return (
                <g
                  key={`snake-full-${snake.head}-${snake.tail}`}
                  filter="url(#boardShadow)"
                  className="transition-all duration-300"
                  opacity={isHighlighted ? 1 : 0.94}
                >
                  {/* Warning Aura when Active or Inspected */}
                  {isHighlighted && (
                    <path
                      d={pathD}
                      stroke="#ef4444"
                      strokeWidth="38"
                      fill="none"
                      strokeLinecap="round"
                      opacity="0.38"
                      className="animate-pulse"
                    />
                  )}

                  {/* Outer Textured Snake Muscular Body */}
                  <path
                    d={pathD}
                    stroke={`url(#${snake.gradientId})`}
                    strokeWidth="15"
                    fill="none"
                    strokeLinecap="round"
                  />

                  {/* Dorsal Reptilian Ridge Pattern */}
                  <path
                    d={pathD}
                    stroke="#ffffff"
                    strokeWidth="3.2"
                    strokeDasharray="5 7"
                    fill="none"
                    strokeLinecap="round"
                    opacity="0.65"
                  />

                  {/* Slender Tail Coiling Tip */}
                  <circle cx={tX} cy={tY} r="4.5" fill="#000000" opacity="0.8" />

                  {/* Flared Cobra Hood & Head */}
                  <g transform={`translate(${hX}, ${hY})`}>
                    {/* Danger head pulse */}
                    <circle cx="0" cy="0" r="22" fill="#ef4444" opacity="0.25" className="animate-ping" />

                    {/* Flared Diamond/Oval Hood */}
                    <polygon
                      points="0,-18 16,0 0,20 -16,0"
                      fill={`url(#${snake.gradientId})`}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      transform={`rotate(${(headAngle * 180) / Math.PI + 90})`}
                    />

                    {/* Piercing Glowing Eyes */}
                    <circle cx="-5" cy="-2" r="3.2" fill={snake.eyeColor} stroke="#000000" strokeWidth="1" />
                    <circle cx="5" cy="-2" r="3.2" fill={snake.eyeColor} stroke="#000000" strokeWidth="1" />
                    {/* Vertical Slit Pupils */}
                    <ellipse cx="-5" cy="-2" rx="0.9" ry="2.2" fill="#000000" />
                    <ellipse cx="5" cy="-2" rx="0.9" ry="2.2" fill="#000000" />

                    {/* Flickering Bifurcated Tongue */}
                    <path
                      d="M 0 13 L 0 23 M 0 23 L -4 28 M 0 23 L 4 28"
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

          {/* ================= 3. PLAYER TOKENS WITH 3D PEDESTALS & TURN BEACONS ================= */}
          {playerOrder.map((uid) => {
            const player = players[uid];
            if (!player) return null;

            const currentTile = playerPositions[uid] || 1;
            const pos = getTileGridPosition(currentTile);
            const isCurrent = uid === currentPlayerUid;
            const isMe = uid === myUid;

            // Offset multiple players occupying the same square cleanly
            const sharedPlayersOnTile = playerOrder.filter(
              (oUid) => (playerPositions[oUid] || 1) === currentTile
            );
            const offsetIndex = sharedPlayersOnTile.indexOf(uid);
            const totalShared = sharedPlayersOnTile.length;
            const offsetX = totalShared > 1 ? (offsetIndex - (totalShared - 1) / 2) * 11 : 0;
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
                  stiffness: 300,
                  damping: 24,
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
                {/* Active Turn Pulse Ring */}
                {isCurrent && (
                  <motion.div
                    animate={{ scale: [1, 1.45, 1], opacity: [0.9, 0.25, 0.9] }}
                    transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
                    className={`absolute inset-0 rounded-full border-2 ${pColor.border} bg-amber-400/20 pointer-events-none`}
                  />
                )}

                {/* 3D Sculpted Token Body */}
                <motion.div
                  animate={
                    isCurrent
                      ? {
                          scale: [1, 1.2, 1],
                          y: [0, -4, 0],
                        }
                      : {}
                  }
                  transition={isCurrent ? { repeat: Infinity, duration: 1.5, ease: 'easeInOut' } : {}}
                  className={`relative w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br ${pColor.bg} border-2 ${pColor.border} shadow-xl flex items-center justify-center text-xs sm:text-sm font-black text-white ${
                    isCurrent ? `ring-2 sm:ring-3 ${pColor.ring} ${pColor.glow} shadow-lg` : ''
                  }`}
                >
                  <span className="select-none text-[11px] sm:text-sm">{player.avatar || '👤'}</span>

                  {/* You Star Badge */}
                  {isMe && (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-400 rounded-full border border-neutral-950 text-[7px] font-black text-neutral-950 flex items-center justify-center shadow">
                      ★
                    </span>
                  )}

                  {/* Current Square Tooltip On Token Foot */}
                  <span className="absolute -bottom-2 bg-neutral-950/95 text-[7px] text-amber-300 font-mono px-1 rounded-full border border-neutral-700 shadow">
                    {toBengaliNumber(currentTile)}
                  </span>
                </motion.div>
              </motion.div>
            );
          })}

          {/* ================= 4. DYNAMIC CELEBRATION TOAST OVERLAYS ================= */}
          <AnimatePresence>
            {lastEvent && (
              <motion.div
                initial={{ scale: 0.75, opacity: 0, y: -20 }}
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
                        {toBengaliNumber(lastEvent.from)} ➔ {toBengaliNumber(lastEvent.to)} (
                        {language === 'bn' ? 'উপরে লাফ' : 'Ascent'})
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
                        {toBengaliNumber(lastEvent.from)} ➔ {toBengaliNumber(lastEvent.to)} (
                        {language === 'bn' ? 'নিচে পতন' : 'Slide down'})
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
          <div className="mt-1.5 p-2 rounded-xl bg-neutral-950/95 border border-amber-500/40 text-xs flex items-center justify-between gap-2 z-30 animate-fadeIn">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono font-bold text-amber-300 text-xs sm:text-sm shrink-0">
                ঘর #{toBengaliNumber(inspectedTile)} ({inspectedTile})
              </span>
              {BANGLADESHI_SNAKES[inspectedTile] && (
                <div className="flex items-center gap-1.5 min-w-0 text-rose-300 text-[11px] font-semibold truncate">
                  <TrendingDown className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                  <span className="truncate">
                    {BANGLADESHI_SNAKES[inspectedTile].nameBn} ➔ ঘর {toBengaliNumber(BANGLADESHI_SNAKES[inspectedTile].tail)}
                  </span>
                  <span className="text-[9px] px-1 rounded bg-rose-950 border border-rose-800 shrink-0">
                    -{toBengaliNumber(BANGLADESHI_SNAKES[inspectedTile].fallCount)}
                  </span>
                </div>
              )}
              {BANGLADESHI_LADDERS[inspectedTile] && (
                <div className="flex items-center gap-1.5 min-w-0 text-emerald-300 text-[11px] font-semibold truncate">
                  <TrendingUp className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                  <span className="truncate">
                    {BANGLADESHI_LADDERS[inspectedTile].nameBn} ➔ ঘর {toBengaliNumber(BANGLADESHI_LADDERS[inspectedTile].top)}
                  </span>
                  <span className="text-[9px] px-1 rounded bg-emerald-950 border border-emerald-800 shrink-0">
                    +{toBengaliNumber(BANGLADESHI_LADDERS[inspectedTile].jumpCount)}
                  </span>
                </div>
              )}
              {!BANGLADESHI_SNAKES[inspectedTile] && !BANGLADESHI_LADDERS[inspectedTile] && (
                <span className="text-neutral-400 text-[11px] truncate">
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
              className="p-1 rounded-lg bg-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-700 text-[10px] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Modern Vernacular Legend & Rules Modal */}
      <AnimatePresence>
        {showLegendModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 15 }}
              className="relative w-full max-w-lg max-h-[85vh] bg-gradient-to-b from-neutral-900 via-neutral-950 to-neutral-950 border border-amber-500/40 rounded-2xl shadow-2xl p-4 sm:p-5 flex flex-col overflow-hidden text-neutral-100"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-black text-amber-300">
                      {language === 'bn' ? 'সাপ-লুডুর সকল সাপ ও মই' : 'Snakes & Ladders Directory'}
                    </h3>
                    <p className="text-xs text-neutral-400">
                      {language === 'bn' ? 'ঐতিহ্যবাহী বাংলাদেশি লোকগাথা ও ঘরের বিবরণ' : 'Bengali vernacular lore & specifications'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowLegendModal(false)}
                  className="p-1.5 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto py-3 space-y-4 text-xs pr-1">
                {/* Ladders Section */}
                <div>
                  <h4 className="font-bold text-amber-400 text-xs uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{language === 'bn' ? 'মইসমূহ (উপরে ওঠার সিঁড়ি)' : 'Ladders (Ascent Paths)'}</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {Object.values(BANGLADESHI_LADDERS).map((lad) => (
                      <div
                        key={lad.bottom}
                        className="p-2 rounded-xl bg-neutral-900/90 border border-emerald-900/50 flex flex-col justify-between"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-emerald-300 text-xs">{lad.nameBn}</span>
                          <span className="px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono text-[10px] font-black">
                            {lad.boostText}
                          </span>
                        </div>
                        <p className="text-[10px] text-neutral-400 leading-snug">{lad.loreBn}</p>
                        <div className="mt-1.5 pt-1 border-t border-neutral-800 text-[9px] text-neutral-300 font-mono flex items-center justify-between">
                          <span>ঘর {toBengaliNumber(lad.bottom)} ({lad.bottom})</span>
                          <span>➔</span>
                          <span className="text-amber-300 font-bold">ঘর {toBengaliNumber(lad.top)} ({lad.top})</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Snakes Section */}
                <div>
                  <h4 className="font-bold text-rose-400 text-xs uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
                    <span>{language === 'bn' ? 'সাপসমূহ (নিচে পড়ার ফাঁদ)' : 'Snakes (Danger Traps)'}</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {Object.values(BANGLADESHI_SNAKES).map((snk) => (
                      <div
                        key={snk.head}
                        className="p-2 rounded-xl bg-neutral-900/90 border border-rose-950 flex flex-col justify-between"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-rose-300 text-xs">{snk.nameBn}</span>
                          <span className="px-1.5 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-800 font-mono text-[10px] font-black">
                            {snk.dangerBadge}
                          </span>
                        </div>
                        <p className="text-[10px] text-neutral-400 leading-snug">{snk.loreBn}</p>
                        <div className="mt-1.5 pt-1 border-t border-neutral-800 text-[9px] text-neutral-300 font-mono flex items-center justify-between">
                          <span>ঘর {toBengaliNumber(snk.head)} ({snk.head})</span>
                          <span>➔</span>
                          <span className="text-rose-400 font-bold">ঘর {toBengaliNumber(snk.tail)} ({snk.tail})</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="pt-3 border-t border-neutral-800 flex justify-end">
                <button
                  onClick={() => setShowLegendModal(false)}
                  className="px-4 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold text-xs transition cursor-pointer"
                >
                  {language === 'bn' ? 'বুঝেছি' : 'Got it'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
