import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, ReactionEvent } from '../../types';
import { sendReaction } from '../../services/gameService';
import { p2pMeshService } from '../../services/p2pMeshService';
import { soundFx } from '../../utils/sound';
import { collection, onSnapshot, query, limit, orderBy } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { Smile, Volume2, Sparkles, MessageSquare, Play, VolumeX, Flame, Zap } from 'lucide-react';

interface QuickReactionsProps {
  roomId?: string;
  user?: UserProfile;
  onOfflineReaction?: (emoji: string, taunt?: { id: string; textBn: string; textEn: string }) => void;
}

const EMOJI_LIST = ['👍', '😂', '😮', '❤️', '👏', '🎉', '🔥', '🎲', '😎', '💀', '😱', '👑', '🥳', '💥', '🏆', '🎯', '🤝', '⚡'];

export interface BanglaSoundboardClip {
  id: string;
  emoji: string;
  textBn: string;
  textEn: string;
  tag?: string;
}

export const BANGLA_SOUNDBOARD_CLIPS: BanglaSoundboardClip[] = [
  { id: 'chokka_maro', emoji: '🎲', textBn: 'ছক্কা মার রে ভাই!', textEn: 'Roll a six, brother!', tag: 'Dice' },
  { id: 'ghuti_katar_ostad', emoji: '⚔️', textBn: 'ঘুঁটি কাটার ওস্তাদ আমি!', textEn: 'I am the capture master!', tag: 'Attack' },
  { id: 'palabi_kothay', emoji: '🏃', textBn: 'পালাবি কোথায় এবার?', textEn: 'Where will you run now?', tag: 'Taunt' },
  { id: 'dhora_khaili', emoji: '💀', textBn: 'ধরা খাইলিরে ভাই!', textEn: 'Caught you red-handed!', tag: 'Trap' },
  { id: 'kop_samlao', emoji: '🎯', textBn: 'কোপ সামলাও!', textEn: 'Brace for impact!', tag: 'Attack' },
  { id: 'ki_chal_dilen', emoji: '😲', textBn: 'আরে ভাই কি চাল দিলেন!', textEn: 'What a move brother!', tag: 'Shock' },
  { id: 'shabdhane_chalis', emoji: '⚠️', textBn: 'একটু সাবধানে চালিস ভাই!', textEn: 'Play carefully brother!', tag: 'Caution' },
  { id: 'ludu_raja', emoji: '👑', textBn: 'লুডু খেলার রাজা আমি!', textEn: 'I am the King of Ludo!', tag: 'Royal' },
  { id: 'match_jome_geche', emoji: '🔥', textBn: 'ম্যাচ কিন্তু জমে গেছে!', textEn: 'Match is on fire!', tag: 'Hype' },
  { id: 'taratari_chalao', emoji: '⚡', textBn: 'চালাও চালাও তাড়াতাড়ি!', textEn: 'Hurry up and move!', tag: 'Speed' },
  { id: 'chokka_chara_goti_nai', emoji: '🚀', textBn: 'ছক্কা ছাড়া গতি নেই!', textEn: 'No progress without a six!', tag: 'Dice' },
  { id: 'party_hobe', emoji: '🎉', textBn: 'আজকে রাতে পার্টি হবে!', textEn: 'Party tonight!', tag: 'Win' },
  { id: 'eta_ki_holo', emoji: '😱', textBn: 'আরে ভাই এটা কি হলো?!', textEn: 'What just happened?!', tag: 'Shock' },
  { id: 'ami_jitbo', emoji: '🏆', textBn: 'জিতবো কিন্তু আজ আমিই!', textEn: 'Victory will be mine today!', tag: 'Win' },
];

export const QuickReactions: React.FC<QuickReactionsProps> = ({ roomId, user, onOfflineReaction }) => {
  const [activeReactions, setActiveReactions] = useState<Array<ReactionEvent & { key: string }>>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [tab, setTab] = useState<'soundboard' | 'emoji'>('soundboard');
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;

    const seenIds = new Set<string>();

    const triggerReaction = (data: ReactionEvent) => {
      if (!data?.id || seenIds.has(data.id)) return;
      seenIds.add(data.id);

      if (Date.now() - data.timestamp < 6000) {
        const reactionItem = { ...data, key: `${data.id}_${Date.now()}` };
        setActiveReactions((prev) => [...prev.slice(-4), reactionItem]);

        if (data.tauntTextBn) {
          soundFx.playTaunt(data.tauntId || 'chokka_maro', data.tauntTextBn, data.tauntTextEn);
        }

        setTimeout(() => {
          setActiveReactions((prev) => prev.filter((r) => r.key !== reactionItem.key));
        }, 3500);
      }
    };

    // 1. Instant P2P Reaction Stream (< 20ms)
    const unsubP2P = p2pMeshService.onMessage((msg) => {
      if (msg.type === 'REACTION' && msg.payload?.reaction) {
        triggerReaction(msg.payload.reaction as ReactionEvent);
      }
    });

    // 2. Fallback Firestore Realtime Query
    const q = query(
      collection(db, 'rooms', roomId, 'reactions'),
      orderBy('timestamp', 'desc'),
      limit(5)
    );

    const unsubFirestore = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as ReactionEvent;
          triggerReaction(data);
        }
      });
    });

    return () => {
      unsubP2P();
      unsubFirestore();
    };
  }, [roomId]);

  // Preview sound effect & voice locally without sending to room
  const handlePreviewClip = (e: React.MouseEvent, clip: BanglaSoundboardClip) => {
    e.stopPropagation();
    setPlayingClipId(clip.id);
    soundFx.playTaunt(clip.id, clip.textBn, clip.textEn);
    setTimeout(() => {
      setPlayingClipId((prev) => (prev === clip.id ? null : prev));
    }, 1800);
  };

  // Broadcast emoji
  const handleSendEmoji = async (emoji: string) => {
    soundFx.click();
    setShowPicker(false);

    if (roomId && user) {
      await sendReaction(roomId, user, emoji);
    } else if (onOfflineReaction) {
      onOfflineReaction(emoji);
    } else {
      // Local visual float
      const localItem: ReactionEvent & { key: string } = {
        id: 'local',
        key: `local_${Date.now()}`,
        uid: user?.uid || 'player',
        displayName: user?.displayName || 'Player',
        emoji,
        timestamp: Date.now(),
      };
      setActiveReactions((prev) => [...prev.slice(-3), localItem]);
      setTimeout(() => {
        setActiveReactions((prev) => prev.filter((r) => r.key !== localItem.key));
      }, 3000);
    }
  };

  // Broadcast soundboard clip (plays audio + floats banner)
  const handleSendSoundboardClip = async (clip: BanglaSoundboardClip) => {
    soundFx.click();
    setShowPicker(false);

    // Trigger immediate local audio
    soundFx.playTaunt(clip.id, clip.textBn, clip.textEn);

    if (roomId && user) {
      await sendReaction(roomId, user, clip.emoji, {
        id: clip.id,
        textBn: clip.textBn,
        textEn: clip.textEn,
      });
    } else if (onOfflineReaction) {
      onOfflineReaction(clip.emoji, {
        id: clip.id,
        textBn: clip.textBn,
        textEn: clip.textEn,
      });
    } else {
      // Local floating speech bubble
      const localItem: ReactionEvent & { key: string } = {
        id: clip.id,
        key: `local_${Date.now()}`,
        uid: user?.uid || 'player',
        displayName: user?.displayName || 'Player',
        emoji: clip.emoji,
        tauntId: clip.id,
        tauntTextBn: clip.textBn,
        tauntTextEn: clip.textEn,
        timestamp: Date.now(),
      };
      setActiveReactions((prev) => [...prev.slice(-3), localItem]);
      setTimeout(() => {
        setActiveReactions((prev) => prev.filter((r) => r.key !== localItem.key));
      }, 3500);
    }
  };

  return (
    <>
      {/* Floating Reaction Animations & Bangla Speech Bubbles over board */}
      <div className="fixed inset-0 pointer-events-none z-50 flex items-center justify-center overflow-hidden">
        <AnimatePresence>
          {activeReactions.map((r, idx) => (
            <motion.div
              key={r.key}
              initial={{ y: 80, opacity: 0, scale: 0.6 }}
              animate={{ y: -110 - idx * 38, opacity: 1, scale: 1.12 }}
              exit={{ y: -190, opacity: 0, scale: 0.8 }}
              transition={{ duration: 3.2, ease: 'easeOut' }}
              className="absolute bg-neutral-950/95 border-2 border-amber-400/90 px-4 py-2 rounded-2xl shadow-[0_12px_36px_rgba(0,0,0,0.9)] flex flex-col items-center gap-1.5 backdrop-blur-md"
            >
              <div className="flex items-center gap-2">
                <span className="text-2xl animate-bounce">{r.emoji}</span>
                <span className="text-xs font-black text-amber-300 max-w-[130px] truncate">
                  {r.displayName}
                </span>
              </div>
              {r.tauntTextBn && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/25 rounded-xl border border-amber-400/50 shadow-inner">
                  <Volume2 className="w-3.5 h-3.5 text-amber-300 animate-pulse shrink-0" />
                  <span className="text-xs font-bold text-amber-100 font-serif leading-tight">
                    {r.tauntTextBn}
                  </span>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Emoji / Soundboard Trigger & Popover Drawer */}
      <div className="relative">
        <button
          id="quick-reactions-btn"
          onClick={() => setShowPicker(!showPicker)}
          className="px-3 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 border border-amber-400/60 text-white transition-all shadow-md active:scale-95 cursor-pointer flex items-center gap-1.5 text-xs font-bold ring-1 ring-amber-300/30"
          title="Bangla Fun Soundboard & Reactions"
        >
          <Volume2 className="w-4 h-4 text-amber-200 animate-pulse" />
          <span className="hidden sm:inline">সাউন্ডবোর্ড (Soundboard)</span>
          <span className="sm:hidden inline">Soundboard</span>
        </button>

        {showPicker && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            className="absolute bottom-12 right-0 w-[310px] sm:w-[360px] bg-neutral-950 border-2 border-amber-500/40 rounded-2xl p-3 shadow-2xl z-40 flex flex-col gap-2.5 backdrop-blur-xl"
          >
            {/* Header Tabs */}
            <div className="flex bg-neutral-900 p-1 rounded-xl border border-neutral-800">
              <button
                type="button"
                onClick={() => setTab('soundboard')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  tab === 'soundboard'
                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-neutral-950 shadow font-black'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Volume2 className="w-3.5 h-3.5" />
                বাংলা সাউন্ডবোর্ড
              </button>
              <button
                type="button"
                onClick={() => setTab('emoji')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  tab === 'emoji'
                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-neutral-950 shadow font-black'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Smile className="w-3.5 h-3.5" />
                ইমোজি রিঅ্যাকশন
              </button>
            </div>

            {/* Tab 1: Bangla Fun Soundboard */}
            {tab === 'soundboard' && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between px-1 text-[11px] text-amber-300 font-semibold">
                  <span>🎙️ বাংলা ফান ডায়লগ ও সাউন্ড ক্লিপ:</span>
                  <span className="text-[10px] text-neutral-400">ট্যাপ করে শোনান</span>
                </div>

                <div className="grid grid-cols-1 gap-1.5 max-h-[260px] overflow-y-auto pr-1">
                  {BANGLA_SOUNDBOARD_CLIPS.map((clip) => {
                    const isPlaying = playingClipId === clip.id;

                    return (
                      <div
                        key={clip.id}
                        className={`w-full p-2 rounded-xl border flex items-center justify-between gap-2 transition-all text-xs group cursor-pointer ${
                          isPlaying
                            ? 'bg-amber-500/20 border-amber-400 text-amber-100 shadow-md ring-1 ring-amber-400/50'
                            : 'bg-neutral-900 hover:bg-neutral-850 border-neutral-800 hover:border-amber-500/50 text-neutral-200'
                        }`}
                        onClick={() => handleSendSoundboardClip(clip)}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <span className="text-xl group-hover:scale-125 transition-transform shrink-0">
                            {clip.emoji}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="font-bold text-white text-xs truncate group-hover:text-amber-300">
                                {clip.textBn}
                              </p>
                              {clip.tag && (
                                <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-neutral-800 text-neutral-400 shrink-0 font-medium">
                                  {clip.tag}
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-neutral-400 truncate">{clip.textEn}</p>
                          </div>
                        </div>

                        {/* Local Preview Audio Button */}
                        <button
                          type="button"
                          onClick={(e) => handlePreviewClip(e, clip)}
                          className={`p-1.5 rounded-lg border transition-all shrink-0 cursor-pointer ${
                            isPlaying
                              ? 'bg-amber-500 text-neutral-950 border-amber-400 shadow-sm animate-pulse'
                              : 'bg-neutral-800 hover:bg-amber-950/60 border-neutral-700 text-neutral-300 hover:text-amber-300'
                          }`}
                          title="Preview Audio Clip"
                        >
                          <Volume2 className={`w-3.5 h-3.5 ${isPlaying ? 'animate-bounce' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tab 2: Standard Emojis */}
            {tab === 'emoji' && (
              <div className="grid grid-cols-6 gap-1.5 max-h-[240px] overflow-y-auto p-1">
                {EMOJI_LIST.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => handleSendEmoji(emoji)}
                    className="h-10 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-amber-500/50 flex items-center justify-center text-xl transition-transform hover:scale-125 active:scale-90 cursor-pointer"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </>
  );
};


