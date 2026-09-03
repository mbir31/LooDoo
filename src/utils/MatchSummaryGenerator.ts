import { GameDocument, RoomDocument, RoomPlayer, Language } from '../types';

export interface MatchSummaryData {
  game: GameDocument;
  room: RoomDocument;
  players: Record<string, RoomPlayer>;
  language?: Language;
}

export interface PlayerMatchStat {
  uid: string;
  displayName: string;
  avatar: string;
  color: string;
  slot: string;
  isWinner: boolean;
  rank: number;
  tokensHome: number;
  tokensTotal: number;
  sixesRolled: number;
  capturesMade: number;
}

/**
 * Extracts and prepares summary metrics for each player
 */
export function extractMatchStats(data: MatchSummaryData): {
  playerStats: PlayerMatchStat[];
  winner: PlayerMatchStat | null;
  totalDurationMin: number;
  gameModeLabel: string;
  totalTurns: number;
  totalSixes: number;
  totalCaptures: number;
} {
  const { game, room, players, language = 'bn' } = data;

  const playerStats: PlayerMatchStat[] = game.playerOrder.map((uid, idx) => {
    const p = players[uid];
    const isWinner = uid === game.winnerUid;
    const playerTokens = game.tokens[uid] || {};
    const tokensList = Object.values(playerTokens);
    const tokensHome = tokensList.filter((t) => t.zone === 'HOME').length;
    const tokensTotal = tokensList.length || 4;

    // Real counters only: the engine keeps them in `game.stats` (per match) and
    // the room player document mirrors them. Never invent numbers - a scorecard
    // that lies about sixes/captures breaks trust in the result.
    const engineStats = game.stats?.[uid];
    const sixesRolled = engineStats?.sixesRolled ?? p?.sixesRolled ?? 0;
    const capturesMade = engineStats?.capturesMade ?? p?.capturesMade ?? 0;

    const rankingEntry = game.rankings?.find((r) => r.uid === uid);
    const rank = isWinner ? 1 : rankingEntry ? rankingEntry.rank : idx + 2;

    const colorHexMap: Record<string, string> = {
      RED: '#ef4444',
      GREEN: '#10b981',
      YELLOW: '#eab308',
      BLUE: '#3b82f6',
      P1: '#ef4444',
      P2: '#10b981',
      P3: '#eab308',
      P4: '#3b82f6',
    };

    return {
      uid,
      displayName: p?.displayName || `Player ${idx + 1}`,
      avatar: p?.avatar || '👤',
      color: colorHexMap[p?.color || p?.slot || 'RED'] || '#f59e0b',
      slot: p?.slot || `P${idx + 1}`,
      isWinner,
      rank,
      tokensHome,
      tokensTotal,
      sixesRolled,
      capturesMade,
    };
  });

  const winner = playerStats.find((p) => p.isWinner) || playerStats[0] || null;

  const startTime = game.startedAt || room.createdAt || Date.now() - 600000;
  const endTime = game.endedAt || Date.now();
  const totalDurationMin = Math.max(1, Math.round((endTime - startTime) / 60000));

  const modeMap: Record<string, { en: string; bn: string }> = {
    CLASSIC: { en: 'Classic 4-Token', bn: 'ক্লাসিক ৪-গুটি ম্যাচ' },
    RUSH: { en: 'Quick 2-Token Rush', bn: '২-গুটির কুইক রাশ' },
    SNAKE_LADDER: { en: 'Snakes & Ladders', bn: 'ঐতিহ্যবাহী সাপ-লুডু' },
    TEAM: { en: '2v2 Tag-Team', bn: '২ বনাম ২ টিম ম্যাচ' },
  };

  const currentMode = room.settings?.gameMode || game.gameMode || 'CLASSIC';
  const gameModeLabel = language === 'bn' ? modeMap[currentMode]?.bn || 'লুডু ম্যাচ' : modeMap[currentMode]?.en || 'Ludo Match';

  const totalTurns = game.turnNumber || playerStats.length * 8;
  const totalSixes = playerStats.reduce((acc, p) => acc + p.sixesRolled, 0);
  const totalCaptures = playerStats.reduce((acc, p) => acc + p.capturesMade, 0);

  return {
    playerStats,
    winner,
    totalDurationMin,
    gameModeLabel,
    totalTurns,
    totalSixes,
    totalCaptures,
  };
}

/**
 * MatchSummaryGenerator using HTML5 Canvas API
 * Creates a high-resolution, exportable 1080x1350 PNG image card
 */
export class MatchSummaryGenerator {
  /**
   * Generates a styled Canvas containing the full match infographic
   */
  public static generateCanvas(data: MatchSummaryData): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    const width = 1080;
    const height = 1350;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const stats = extractMatchStats(data);
    const { playerStats, winner, totalDurationMin, gameModeLabel, totalTurns, totalSixes, totalCaptures } = stats;

    // 1. Background Gradient & Canvas Base
    const bgGrad = ctx.createRadialGradient(width / 2, height / 3, 50, width / 2, height / 2, 850);
    bgGrad.addColorStop(0, '#1c1917'); // Dark warm stone
    bgGrad.addColorStop(0.5, '#0c0a09');
    bgGrad.addColorStop(1, '#050505');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Decorative Royal Border Pattern
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 4;
    ctx.strokeRect(30, 30, width - 60, height - 60);

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(42, 42, width - 84, height - 84);

    // Corner Ornaments
    const drawCorner = (x: number, y: number, angle: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(25, 0);
      ctx.lineTo(0, 25);
      ctx.closePath();
      ctx.fillStyle = 'rgba(245, 158, 11, 0.4)';
      ctx.fill();
      ctx.restore();
    };

    drawCorner(42, 42, 0);
    drawCorner(width - 42, 42, Math.PI / 2);
    drawCorner(width - 42, height - 42, Math.PI);
    drawCorner(42, height - 42, -Math.PI / 2);

    // 2. Top Header & Title
    ctx.textAlign = 'center';

    // Game Title
    ctx.font = '900 46px "Hind Siliguri", "Segoe UI", sans-serif';
    const goldGrad = ctx.createLinearGradient(width / 2 - 200, 0, width / 2 + 200, 0);
    goldGrad.addColorStop(0, '#fef08a');
    goldGrad.addColorStop(0.5, '#f59e0b');
    goldGrad.addColorStop(1, '#ea580c');
    ctx.fillStyle = goldGrad;
    ctx.fillText('🎲 LooDoo : লুডু 🎲', width / 2, 115);

    // Subtitle & Mode Badge
    ctx.font = '600 22px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#a8a29e';
    ctx.fillText('OFFICIAL MATCH SCORECARD & HIGHLIGHTS', width / 2, 155);

    // Pill Badge for Mode
    const badgeText = `⚡ ${gameModeLabel}  •  ⏱️ ${totalDurationMin} min match`;
    ctx.font = 'bold 20px "Hind Siliguri", sans-serif';
    const badgeWidth = ctx.measureText(badgeText).width + 40;
    ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(width / 2 - badgeWidth / 2, 175, badgeWidth, 38, 19);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fde68a';
    ctx.fillText(badgeText, width / 2, 201);

    // 3. Winner Spotlight Section (Hero Card)
    const heroY = 245;
    const heroHeight = 270;
    const heroWidth = width - 140;

    // Glowing Hero Box
    const heroGrad = ctx.createLinearGradient(70, heroY, 70 + heroWidth, heroY + heroHeight);
    heroGrad.addColorStop(0, 'rgba(245, 158, 11, 0.22)');
    heroGrad.addColorStop(0.5, 'rgba(234, 88, 12, 0.12)');
    heroGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
    ctx.fillStyle = heroGrad;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(70, heroY, heroWidth, heroHeight, 28);
    ctx.fill();
    ctx.stroke();

    // Crown Icon & Avatar
    ctx.font = '72px "Segoe UI Emoji", sans-serif';
    ctx.fillText('👑', width / 2, heroY + 70);

    ctx.font = '54px "Segoe UI Emoji", sans-serif';
    ctx.fillText(winner?.avatar || '👤', width / 2, heroY + 135);

    // Winner Name
    ctx.font = '900 40px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(winner?.displayName || 'Champion', width / 2, heroY + 185);

    // Winner Tag
    ctx.font = 'bold 22px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('🏆 MATCH CHAMPION (প্রথম বিজয়ী) 🏆', width / 2, heroY + 225);

    // 4. Quick Match Metrics Bar (3 Metric Pillars)
    const statBarY = 545;
    const statBoxWidth = (width - 140 - 30) / 3;
    const statHeight = 105;

    const renderMetricBox = (x: number, title: string, value: string | number, sub: string, color: string) => {
      ctx.fillStyle = 'rgba(24, 24, 27, 0.85)';
      ctx.strokeStyle = 'rgba(82, 82, 91, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, statBarY, statBoxWidth, statHeight, 20);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.font = 'bold 16px "Hind Siliguri", sans-serif';
      ctx.fillStyle = '#a1a1aa';
      ctx.fillText(title, x + statBoxWidth / 2, statBarY + 30);

      ctx.font = '900 32px "Hind Siliguri", sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(String(value), x + statBoxWidth / 2, statBarY + 68);

      ctx.font = '500 14px "Hind Siliguri", sans-serif';
      ctx.fillStyle = '#71717a';
      ctx.fillText(sub, x + statBoxWidth / 2, statBarY + 92);
    };

    renderMetricBox(70, '🎲 TOTAL 6s ROLLED', totalSixes, 'ছক্কার বন্যা', '#f59e0b');
    renderMetricBox(70 + statBoxWidth + 15, '⚔️ TOKENS CAPTURED', totalCaptures, 'ঘুঁটি কাটা হয়েছে', '#ef4444');
    renderMetricBox(70 + (statBoxWidth + 15) * 2, '⚡ TOTAL TURNS', totalTurns, 'মোট চাল খেলা হয়েছে', '#10b981');

    // 5. Individual Player Scorecards Section
    const playersY = 680;
    ctx.textAlign = 'left';
    ctx.font = 'bold 22px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('📊 খেলোয়াড়দের স্কোর ও পারফরম্যান্স (PLAYER SCORECARDS)', 70, playersY);

    const playerRowHeight = 92;
    const playerRowGap = 14;

    playerStats.forEach((p, idx) => {
      const rowY = playersY + 20 + idx * (playerRowHeight + playerRowGap);
      const rowWidth = width - 140;

      // Card Background
      ctx.fillStyle = p.isWinner ? 'rgba(245, 158, 11, 0.12)' : 'rgba(24, 24, 27, 0.7)';
      ctx.strokeStyle = p.isWinner ? '#f59e0b' : 'rgba(63, 63, 70, 0.5)';
      ctx.lineWidth = p.isWinner ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.roundRect(70, rowY, rowWidth, playerRowHeight, 18);
      ctx.fill();
      ctx.stroke();

      // Color Tag Bar on Left
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.roundRect(70, rowY, 12, playerRowHeight, [18, 0, 0, 18]);
      ctx.fill();

      // Rank Badge
      ctx.textAlign = 'center';
      ctx.font = 'bold 22px "Hind Siliguri", sans-serif';
      ctx.fillStyle = p.isWinner ? '#f59e0b' : '#71717a';
      ctx.fillText(`#${p.rank}`, 115, rowY + 54);

      // Player Avatar & Name
      ctx.font = '36px "Segoe UI Emoji", sans-serif';
      ctx.fillText(p.avatar, 165, rowY + 58);

      ctx.textAlign = 'left';
      ctx.font = '900 24px "Hind Siliguri", sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.displayName, 205, rowY + 45);

      // Subtitle with Slot / Status
      ctx.font = '600 15px "Hind Siliguri", sans-serif';
      ctx.fillStyle = p.isWinner ? '#fbbf24' : '#a1a1aa';
      const statusLabel = p.isWinner
        ? '🏆 Winner • All tokens reached Home!'
        : `${p.tokensHome}/${p.tokensTotal} Tokens Home • Runner-up`;
      ctx.fillText(statusLabel, 205, rowY + 72);

      // Mini Stats on Right (6s, Captures)
      const rightX = 70 + rowWidth - 25;
      ctx.textAlign = 'right';

      ctx.font = 'bold 18px "Hind Siliguri", sans-serif';
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(`🎲 ${p.sixesRolled} Sixes`, rightX, rowY + 42);

      ctx.font = 'bold 16px "Hind Siliguri", sans-serif';
      ctx.fillStyle = '#f87171';
      ctx.fillText(`⚔️ ${p.capturesMade} Captures`, rightX, rowY + 70);
    });

    // 6. Bengali Quote / Fun Banner
    const quoteY = 1140;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(70, quoteY, width - 140, 75, 18);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'italic bold 20px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#fde68a';
    ctx.fillText('✨ "ছক্কার খেলা, বন্ধুর মেলা — বাংলাদেশের আসল লুডু!" ✨', width / 2, quoteY + 44);

    // 7. Footer & Credit
    const footerY = 1260;
    ctx.font = '600 18px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#78716c';
    ctx.fillText('Built with love, for FnF, by ©munabbirMushran', width / 2, footerY);

    ctx.font = 'bold 16px "Hind Siliguri", sans-serif';
    ctx.fillStyle = '#eab308';
    ctx.fillText('🎮 Play Free Online & Offline: https://loodoo.vercel.app', width / 2, footerY + 28);

    return canvas;
  }

  /**
   * Generates a Data URL of the summary image
   */
  public static async generateDataUrl(data: MatchSummaryData): Promise<string> {
    const canvas = this.generateCanvas(data);
    return canvas.toDataURL('image/png', 0.95);
  }

  /**
   * Generates a PNG Blob of the summary image
   */
  public static async generateBlob(data: MatchSummaryData): Promise<Blob | null> {
    const canvas = this.generateCanvas(data);
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.95);
    });
  }

  /**
   * Triggers a direct browser file download for the PNG image card
   */
  public static async downloadCard(data: MatchSummaryData, customFilename?: string): Promise<void> {
    const canvas = this.generateCanvas(data);
    const filename = customFilename || `LooDoo_Match_Summary_${Date.now()}.png`;

    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Shares the image card using Web Share API Level 2 (files) or falls back to download/clipboard
   */
  public static async shareCard(data: MatchSummaryData): Promise<boolean> {
    try {
      const blob = await this.generateBlob(data);
      if (!blob) return false;

      const file = new File([blob], `LooDoo_Scorecard_${Date.now()}.png`, { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'LooDoo Match Scorecard',
          text: `🎲 Check out our Ludo match result! Winner: ${data.players[data.game.winnerUid || '']?.displayName || 'Champion'} 👑`,
        });
        return true;
      }
    } catch (e) {
      console.warn('Native file share failed, falling back to download:', e);
    }

    // Fallback: download card
    await this.downloadCard(data);
    return false;
  }
}
