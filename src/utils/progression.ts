import { UserProfile, UserStats, GameMode } from '../types';
import { updateUserProfile } from '../services/authService';

export interface LevelInfo {
  level: number;
  titleBn: string;
  titleEn: string;
  currentXp: number;
  nextLevelXp: number;
  progressPercent: number;
}

export interface TrophyDefinition {
  id: string;
  titleBn: string;
  titleEn: string;
  descBn: string;
  descEn: string;
  icon: string;
  badgeColor: string;
  requiredCount: number;
}

export const ALL_TROPHIES: TrophyDefinition[] = [
  {
    id: 'six_king',
    titleBn: 'ছক্কার রাজা',
    titleEn: 'King of Sixes',
    descBn: 'যেকোনো খেলায় ১৫টি বা তার বেশি ছক্কা মারুন',
    descEn: 'Roll 15 or more sixes across your matches',
    icon: '👑',
    badgeColor: 'from-amber-400 to-yellow-600',
    requiredCount: 15,
  },
  {
    id: 'capture_master',
    titleBn: 'ক্যাপচার ওস্তাদ',
    titleEn: 'Capture Master',
    descBn: 'বিপক্ষ দলের ১০টি ঘুঁটি কেটে বোর্ডে রাজত্ব করুন',
    descEn: 'Capture 10 opponent tokens on the board',
    icon: '⚔️',
    badgeColor: 'from-rose-500 to-red-700',
    requiredCount: 10,
  },
  {
    id: 'unbeatable',
    titleBn: 'অপরাজিত নায়ক',
    titleEn: 'Unbeatable Streak',
    descBn: 'টানা ৩টি খেলায় জয়লাভ করুন',
    descEn: 'Achieve a winning streak of 3 consecutive matches',
    icon: '🛡️',
    badgeColor: 'from-emerald-400 to-teal-600',
    requiredCount: 3,
  },
  {
    id: 'quick_blitz',
    titleBn: 'বিদ্যুৎ গতি',
    titleEn: 'Blitz Master',
    descBn: 'কুইক রাশ (২-গুটি) মোডে দ্রুত জয় ছিনিয়ে নিন',
    descEn: 'Win a Quick Rush (2-token) match',
    icon: '⚡',
    badgeColor: 'from-sky-400 to-blue-600',
    requiredCount: 1,
  },
  {
    id: 'snake_champion',
    titleBn: 'সর্পজয়ী সম্রাট',
    titleEn: 'Snake Conqueror',
    descBn: '১০০-ঘরের সাপ-লুডু বোর্ডে প্রথম স্থান অর্জন করুন',
    descEn: 'Finish 1st in the 100-cell Snake & Ladders board',
    icon: '🐍',
    badgeColor: 'from-purple-400 to-indigo-600',
    requiredCount: 1,
  },
  {
    id: 'team_legend',
    titleBn: 'টিম লিজেন্ড',
    titleEn: 'Team Legend',
    descBn: '২ বনাম ২ দলীয় যুদ্ধে যৌথভাবে বিজয় অর্জন করুন',
    descEn: 'Win together in a 2v2 Tag-Team match',
    icon: '👥',
    badgeColor: 'from-amber-500 to-orange-600',
    requiredCount: 1,
  },
];

const LEVEL_TITLES: Array<{ minLevel: number; bn: string; en: string }> = [
  { minLevel: 1, bn: 'নবীন খেলোয়াড়', en: 'Novice Roller' },
  { minLevel: 3, bn: 'পাড়ার ওস্তাদ', en: 'Local Champion' },
  { minLevel: 6, bn: 'গ্রামীণ ওস্তাদ', en: 'Village Master' },
  { minLevel: 10, bn: 'নগর সম্রাট', en: 'City Emperor' },
  { minLevel: 15, bn: 'লুডু নবাব', en: 'Ludo Nawab' },
  { minLevel: 25, bn: 'লুডু কিংবদন্তি', en: 'Ludo Legend' },
];

export function calculateLevel(xp: number = 0): LevelInfo {
  // Base formula: Level = floor(sqrt(XP / 100)) + 1
  const level = Math.max(1, Math.floor(Math.sqrt(xp / 100)) + 1);
  const currentLevelBaseXp = Math.pow(level - 1, 2) * 100;
  const nextLevelXp = Math.pow(level, 2) * 100;
  const xpInCurrentLevel = xp - currentLevelBaseXp;
  const neededForNext = nextLevelXp - currentLevelBaseXp;
  const progressPercent = Math.min(100, Math.max(0, Math.round((xpInCurrentLevel / neededForNext) * 100)));

  let titleBn = 'নবীন খেলোয়াড়';
  let titleEn = 'Novice Roller';

  for (const t of LEVEL_TITLES) {
    if (level >= t.minLevel) {
      titleBn = t.bn;
      titleEn = t.en;
    }
  }

  return {
    level,
    titleBn,
    titleEn,
    currentXp: xp,
    nextLevelXp,
    progressPercent,
  };
}

export function evaluateTrophies(stats: UserStats, gameMode?: GameMode, won?: boolean): string[] {
  const earned = new Set<string>(stats.trophies || []);

  if (stats.sixesRolled >= 15) earned.add('six_king');
  if (stats.capturesMade >= 10) earned.add('capture_master');
  if ((stats.winStreak || 0) >= 3 || (stats.longestStreak || 0) >= 3) earned.add('unbeatable');
  if (won && gameMode === 'RUSH') earned.add('quick_blitz');
  if (won && gameMode === 'SNAKE_LADDER') earned.add('snake_champion');
  if (won && gameMode === 'TEAM') earned.add('team_legend');

  return Array.from(earned);
}

/**
 * XP earned for one match:
 *   base completion +50, win bonus +150, +25 per capture, +10 per six.
 * Shared by the award pipeline and the result screen so the number the player
 * sees is exactly the number their profile receives.
 */
export function computeMatchXp(won: boolean, capturesMade: number, sixesRolled: number): number {
  return 50 + (won ? 150 : 0) + capturesMade * 25 + sixesRolled * 10;
}

export async function awardMatchStats(
  user: UserProfile,
  matchStats: {
    won: boolean;
    sixesRolled: number;
    capturesMade: number;
    gameMode?: GameMode;
  }
): Promise<UserProfile> {
  const prevStats: UserStats = user.stats || {
    wins: 0,
    matchesPlayed: 0,
    sixesRolled: 0,
    capturesMade: 0,
    winStreak: 0,
    longestStreak: 0,
    xp: 0,
    level: 1,
    trophies: [],
  };

  const newWins = prevStats.wins + (matchStats.won ? 1 : 0);
  const newMatches = prevStats.matchesPlayed + 1;
  const newSixes = (prevStats.sixesRolled || 0) + matchStats.sixesRolled;
  const newCaptures = (prevStats.capturesMade || 0) + matchStats.capturesMade;
  const newStreak = matchStats.won ? (prevStats.winStreak || 0) + 1 : 0;
  const longestStreak = Math.max(prevStats.longestStreak || 0, newStreak);

  // Calculate XP gained (same formula shown on the result screen).
  const earnedXp = computeMatchXp(matchStats.won, matchStats.capturesMade, matchStats.sixesRolled);

  const totalXp = (prevStats.xp || 0) + earnedXp;
  const levelInfo = calculateLevel(totalXp);

  const updatedStats: UserStats = {
    wins: newWins,
    matchesPlayed: newMatches,
    sixesRolled: newSixes,
    capturesMade: newCaptures,
    winStreak: newStreak,
    longestStreak,
    xp: totalXp,
    level: levelInfo.level,
    trophies: prevStats.trophies || [],
  };

  updatedStats.trophies = evaluateTrophies(updatedStats, matchStats.gameMode, matchStats.won);

  const updatedUser: UserProfile = {
    ...user,
    stats: updatedStats,
  };

  try {
    await updateUserProfile(user.uid, { stats: updatedStats });
  } catch (e) {
    // Local persistence fallback
    try {
      localStorage.setItem(`loodoo_user_stats_${user.uid}`, JSON.stringify(updatedStats));
    } catch (err) {}
  }

  return updatedUser;
}
