import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import confetti from 'canvas-confetti';
import { GameDocument, RoomPlayer, Language, RoomDocument } from '../../types';
import { getTranslation } from '../../i18n/translations';
import { startRematch } from '../../services/gameService';
import { soundFx } from '../../utils/sound';
import { MatchSummaryGenerator } from '../../utils/MatchSummaryGenerator';
import {
  Trophy,
  RotateCcw,
  Home,
  Crown,
  Medal,
  Sparkles,
  Share2,
  Check,
  Copy,
  Download,
  Flame,
  Swords,
  Zap,
  Image as ImageIcon,
  Eye,
  X,
} from 'lucide-react';

interface GameResultModalProps {
  game: GameDocument;
  room: RoomDocument;
  players: Record<string, RoomPlayer>;
  currentUserUid: string;
  language: Language;
  onBackToLobby: () => void;
}

export const GameResultModal: React.FC<GameResultModalProps> = ({
  game,
  room,
  players,
  currentUserUid,
  language,
  onBackToLobby,
}) => {
  const winner = players[game.winnerUid || ''];
  const isAdmin = room.adminUid === currentUserUid;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadingImg, setDownloadingImg] = useState(false);
  const [previewCardUrl, setPreviewCardUrl] = useState<string | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  useEffect(() => {
    soundFx.win();

    // Custom Ludo festive color palette
    const colors = ['#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#fbbf24', '#ec4899'];
    let animationFrameId: number;

    const fireConfetti = canvasRef.current
      ? confetti.create(canvasRef.current, {
          resize: true,
          useWorker: true,
        })
      : confetti;

    // 1. Initial Grand Celebration Blast
    fireConfetti({
      particleCount: 120,
      spread: 80,
      origin: { y: 0.6 },
      colors,
      zIndex: 99999,
    });

    // 2. Left & Right Double Cannons
    const timer1 = setTimeout(() => {
      fireConfetti({
        particleCount: 80,
        angle: 60,
        spread: 65,
        origin: { x: 0.05, y: 0.65 },
        colors,
        zIndex: 99999,
      });
      fireConfetti({
        particleCount: 80,
        angle: 120,
        spread: 65,
        origin: { x: 0.95, y: 0.65 },
        colors,
        zIndex: 99999,
      });
    }, 350);

    // 3. Continuous Fireworks Shower for 3.5 seconds
    const end = Date.now() + 3500;
    const frame = () => {
      fireConfetti({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.7 },
        colors,
        zIndex: 99999,
      });
      fireConfetti({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.7 },
        colors,
        zIndex: 99999,
      });

      if (Date.now() < end) {
        animationFrameId = requestAnimationFrame(frame);
      }
    };
    frame();

    return () => {
      clearTimeout(timer1);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, []);

  const playerList = Object.values(players) as RoomPlayer[];

  // Generate and Download Canvas Image Card
  const handleDownloadImageCard = async () => {
    soundFx.click();
    setDownloadingImg(true);
    try {
      await MatchSummaryGenerator.downloadCard(
        { game, room, players, language },
        `LooDoo_${winner?.displayName || 'Match'}_Scorecard.png`
      );
    } catch (e) {
      console.error('Error generating image card:', e);
    } finally {
      setDownloadingImg(false);
    }
  };

  // Preview Image Card
  const handlePreviewImageCard = async () => {
    soundFx.click();
    try {
      const url = await MatchSummaryGenerator.generateDataUrl({ game, room, players, language });
      setPreviewCardUrl(url);
      setShowPreviewModal(true);
    } catch (e) {
      console.error('Error creating image card preview:', e);
    }
  };

  // Share Card directly with Web Share API or download
  const handleShareImageCard = async () => {
    soundFx.click();
    await MatchSummaryGenerator.shareCard({ game, room, players, language });
  };

  const handleShareSummary = async () => {
    soundFx.click();
    const shareText = `🎲 *LooDoo (লুডু) Match Summary*\n🏆 Winner: ${winner?.displayName || 'Champion'} 👑\n👥 Players: ${playerList.map((p) => p.displayName).join(', ')}\n⚡ Mode: ${room.settings?.gameMode || 'Classic'}\n\nPlay Real-Time Bangladeshi Ludo with friends! 🎮`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'LooDoo Match Scorecard',
          text: shareText,
          url: window.location.href,
        });
        return;
      } catch (err) {}
    }

    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      console.error(e);
    }
  };

  const handleWhatsAppShare = () => {
    soundFx.click();
    const shareText = encodeURIComponent(
      `🎲 *LooDoo (লুডু) Match Scorecard*\n🏆 Winner: ${winner?.displayName || 'Champion'} 👑\n👥 Players: ${playerList.map((p) => p.displayName).join(', ')}\nPlay Bangla & English Ludo Online: ${window.location.origin}`
    );
    window.open(`https://api.whatsapp.com/send?text=${shareText}`, '_blank');
  };

  const handleRematch = async () => {
    soundFx.click();
    if (!isAdmin) return;
    try {
      await startRematch(room.roomId, currentUserUid);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
      {/* Full-screen dedicated Confetti Canvas Overlay */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 w-full h-full z-10"
      />

      <motion.div
        initial={{ scale: 0.8, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="relative z-20 bg-neutral-950 border border-neutral-800 w-full max-w-md rounded-3xl p-5 sm:p-6 shadow-2xl flex flex-col items-center gap-4 text-center my-auto"
      >
        {/* Glowing Trophy Icon with Crown */}
        <div className="relative">
          <motion.div
            animate={{ y: [0, -8, 0], rotate: [0, -3, 3, 0] }}
            transition={{ repeat: Infinity, duration: 2.5, ease: 'easeInOut' }}
            className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-amber-400 via-orange-500 to-amber-600 flex items-center justify-center shadow-amber-500/50 shadow-2xl border-2 border-white/50"
          >
            <Trophy className="w-8 h-8 sm:w-10 sm:h-10 text-neutral-950" />
          </motion.div>
          <motion.div
            animate={{ scale: [1, 1.2, 1], opacity: [0.8, 1, 0.8] }}
            transition={{ repeat: Infinity, duration: 1.8 }}
            className="absolute -top-2 -right-2 bg-amber-400 text-neutral-950 p-1.5 rounded-full shadow-lg"
          >
            <Sparkles className="w-4 h-4 fill-neutral-950" />
          </motion.div>
        </div>

        {/* Winner Announcement */}
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-amber-400">
            {getTranslation(language, 'winnerTitle')}
          </span>
          <h2 className="text-2xl sm:text-3xl font-black bg-gradient-to-r from-white via-amber-100 to-amber-400 bg-clip-text text-transparent mt-1">
            {winner?.displayName || 'Player'}
          </h2>
          <p className="text-xs sm:text-sm text-neutral-400 mt-1">
            {getTranslation(language, 'playerWonMessage', {
              name: winner?.displayName || 'Player',
            })}
          </p>
        </div>

        {/* Level XP Earned Badge */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold">
          <Flame className="w-4 h-4 text-amber-400 fill-amber-400" />
          <span>+200 XP Awarded & Progress Saved! 🎖️</span>
        </div>

        {/* Players Summary List */}
        <div className="w-full bg-black/80 border border-neutral-800/80 rounded-2xl p-3 flex flex-col gap-2">
          {game.playerOrder.map((uid) => {
            const p = players[uid];
            const isWinner = uid === game.winnerUid;

            return (
              <div
                key={uid}
                className={`flex items-center justify-between p-2 rounded-xl text-sm transition-all ${
                  isWinner
                    ? 'bg-amber-500/20 border border-amber-500/40 font-bold shadow-inner'
                    : 'bg-neutral-900/60'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{p?.avatar || '👤'}</span>
                  <span className="text-white font-medium">{p?.displayName || 'Player'}</span>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  {isWinner ? (
                    <span className="flex items-center gap-1 text-amber-400 font-bold bg-amber-400/10 px-2 py-0.5 rounded-full border border-amber-400/30">
                      <Medal className="w-4 h-4" /> 1st Winner
                    </span>
                  ) : (
                    <span className="text-neutral-500">Runner-up</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Canvas Image Card Generator Banner */}
        <div className="w-full p-2.5 rounded-2xl bg-gradient-to-r from-amber-950/70 via-neutral-900 to-amber-950/70 border border-amber-500/40 flex flex-col gap-2 shadow-inner">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 text-xs font-bold text-amber-300">
              <ImageIcon className="w-4 h-4 text-amber-400" />
              <span>{language === 'bn' ? 'ম্যাচ স্কোরকার্ড ফটো কার্ড' : 'Match Infographic Card'}</span>
            </div>
            <button
              onClick={handlePreviewImageCard}
              className="text-[11px] text-amber-400 hover:text-amber-300 flex items-center gap-1 cursor-pointer underline"
            >
              <Eye className="w-3 h-3" />
              <span>{language === 'bn' ? 'প্রিভিউ দেখুন' : 'Preview'}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleDownloadImageCard}
              disabled={downloadingImg}
              className="py-2 px-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-neutral-950 font-black text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-md active:scale-95"
            >
              <Download className="w-4 h-4 text-neutral-950" />
              <span>{downloadingImg ? 'তৈরি হচ্ছে...' : (language === 'bn' ? 'ফটো কার্ড ডাউনলোড' : 'Download Card')}</span>
            </button>

            <button
              onClick={handleShareImageCard}
              className="py-2 px-3 rounded-xl bg-neutral-900 hover:bg-neutral-850 border border-amber-400/50 text-amber-300 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm active:scale-95"
            >
              <Share2 className="w-4 h-4" />
              <span>{language === 'bn' ? 'শেয়ার করুন' : 'Share Photo'}</span>
            </button>
          </div>
        </div>

        {/* Share Text & WhatsApp Buttons */}
        <div className="grid grid-cols-2 gap-2 w-full">
          <button
            onClick={handleShareSummary}
            className="py-2.5 px-3 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-neutral-750 text-neutral-300 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            <span>{copied ? 'Copied Text!' : 'Copy Summary'}</span>
          </button>

          <button
            onClick={handleWhatsAppShare}
            className="py-2.5 px-3 rounded-xl bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-500/50 text-emerald-300 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm"
          >
            <Share2 className="w-4 h-4" />
            <span>WhatsApp</span>
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center gap-2.5 w-full pt-1">
          <button
            onClick={onBackToLobby}
            className="w-full sm:w-auto px-4 py-3 rounded-xl bg-neutral-900 hover:bg-neutral-850 text-neutral-300 font-bold text-sm flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-95 border border-neutral-800"
          >
            <Home className="w-4 h-4" />
            <span>{getTranslation(language, 'backToLobby')}</span>
          </button>

          {isAdmin ? (
            <button
              onClick={handleRematch}
              className="w-full flex-1 py-3 rounded-xl bg-gradient-to-r from-red-600 via-amber-500 to-emerald-600 hover:brightness-110 text-white font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-xl shadow-amber-500/25 transition-all active:scale-95 cursor-pointer"
            >
              <RotateCcw className="w-5 h-5" />
              <span>{getTranslation(language, 'playAgain')}</span>
            </button>
          ) : (
            <div className="text-xs text-neutral-500 italic py-2">
              Waiting for admin to start rematch...
            </div>
          )}
        </div>
      </motion.div>

      {/* Full Resolution Scorecard Preview Modal */}
      <AnimatePresence>
        {showPreviewModal && previewCardUrl && (
          <div className="fixed inset-0 z-60 bg-black/95 backdrop-blur-lg flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative max-w-sm w-full bg-neutral-950 border border-amber-500/60 rounded-3xl p-4 shadow-2xl flex flex-col items-center gap-3 my-auto"
            >
              <div className="flex items-center justify-between w-full pb-2 border-b border-neutral-850">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                  <ImageIcon className="w-4 h-4" />
                  <span>{language === 'bn' ? 'ম্যাচ স্কোরকার্ড ফটো প্রিভিউ' : 'Scorecard Card Preview'}</span>
                </div>
                <button
                  onClick={() => setShowPreviewModal(false)}
                  className="p-1.5 rounded-full bg-neutral-900 text-neutral-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Rendered Canvas Image */}
              <div className="w-full rounded-2xl overflow-hidden border border-neutral-800 shadow-2xl bg-black">
                <img
                  src={previewCardUrl}
                  alt="LooDoo Match Scorecard"
                  className="w-full h-auto object-contain"
                />
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2 w-full pt-1">
                <button
                  onClick={handleDownloadImageCard}
                  className="py-2.5 px-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-neutral-950 font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
                >
                  <Download className="w-4 h-4" />
                  <span>{language === 'bn' ? 'ফটো ডাউনলোড' : 'Download PNG'}</span>
                </button>
                <button
                  onClick={handleShareImageCard}
                  className="py-2.5 px-3 rounded-xl bg-neutral-900 border border-neutral-750 text-amber-300 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Share2 className="w-4 h-4" />
                  <span>{language === 'bn' ? 'শেয়ার' : 'Share'}</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};



