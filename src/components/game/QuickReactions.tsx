import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, ReactionEvent, VoiceClip } from '../../types';
import { sendReaction } from '../../services/gameService';
import { p2pMeshService } from '../../services/p2pMeshService';
import { soundFx } from '../../utils/sound';
import {
  isGlobalMuted,
  isPlayerMuted,
  isVoiceClipSupported,
  MAX_CLIP_MS,
  onMuteChange,
  playVoiceClip,
  sendVoiceClip,
  setGlobalMuted,
  startRecording,
  stopRecording,
  subscribeToVoiceClips,
  VoiceClipError,
} from '../../services/voiceClipService';
import { collection, onSnapshot, query, limit, orderBy } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { Mic, Smile, Volume2, VolumeX, Loader2 } from 'lucide-react';

interface QuickReactionsProps {
  roomId?: string;
  user?: UserProfile;
  onOfflineReaction?: (emoji: string) => void;
}

const EMOJI_LIST = ['👍', '😂', '😮', '❤️', '👏', '🎉', '🔥', '🎲', '😎', '💀', '😱', '👑', '🥳', '💥', '🏆', '🎯', '🤝', '⚡'];

const BANGLA_SECONDS = ['০', '১', '২', '৩'];

export const QuickReactions: React.FC<QuickReactionsProps> = ({ roomId, user, onOfflineReaction }) => {
  const [activeReactions, setActiveReactions] = useState<Array<ReactionEvent & { key: string }>>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [tab, setTab] = useState<'voice' | 'emoji'>('voice');
  const [micState, setMicState] = useState<'idle' | 'arming' | 'recording' | 'sending'>('idle');
  const [remainingMs, setRemainingMs] = useState(MAX_CLIP_MS);
  const [cooldownMs, setCooldownMs] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [muted, setMuted] = useState(isGlobalMuted());
  const [incomingClip, setIncomingClip] = useState<(VoiceClip & { key: string }) | null>(null);

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    holdTimerRef.current = null;
    tickRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearTimers();
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    },
    [clearTimers]
  );
  useEffect(() => onMuteChange(() => setMuted(isGlobalMuted())), []);

  // ---------------------------------------------------------------- reactions
  useEffect(() => {
    if (!roomId) return;

    const seenIds = new Set<string>();

    const triggerReaction = (data: ReactionEvent) => {
      if (!data?.id || seenIds.has(data.id)) return;
      seenIds.add(data.id);

      if (Date.now() - data.timestamp < 6000) {
        const reactionItem = { ...data, key: `${data.id}_${Date.now()}` };
        setActiveReactions((prev) => [...prev.slice(-4), reactionItem]);
        setTimeout(() => {
          setActiveReactions((prev) => prev.filter((r) => r.key !== reactionItem.key));
        }, 3000);
      }
    };

    // 1. Instant P2P reaction stream (< 20ms)
    const unsubP2P = p2pMeshService.onMessage((msg) => {
      if (msg.type === 'REACTION' && msg.payload?.reaction) {
        triggerReaction(msg.payload.reaction as ReactionEvent);
      }
    });

    // 2. Fallback Firestore realtime query
    const q = query(collection(db, 'rooms', roomId, 'reactions'), orderBy('timestamp', 'desc'), limit(5));
    const unsubFirestore = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') triggerReaction(change.doc.data() as ReactionEvent);
      });
    });

    // 3. Voice clips ("আওয়াজ দাও")
    const unsubVoice = subscribeToVoiceClips(roomId, (clip) => {
      if (isPlayerMuted(clip.uid) || isGlobalMuted()) return;
      const item = { ...clip, key: `${clip.clipId}_${Date.now()}` };
      setIncomingClip(item);
      playVoiceClip(clip);
      setTimeout(() => {
        setIncomingClip((prev) => (prev?.key === item.key ? null : prev));
      }, Math.max(1200, clip.durationMs));
    });

    return () => {
      unsubP2P();
      unsubFirestore();
      unsubVoice();
    };
  }, [roomId]);

  // ------------------------------------------------------------ voice: record
  const finishRecording = useCallback(async () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    clearTimers();

    let clip;
    try {
      clip = await stopRecording();
    } catch (err) {
      setMicState('idle');
      setMicError((err as VoiceClipError)?.code === 'too-large' ? 'clip-too-large' : 'record-failed');
      return;
    }

    setMicState('idle');
    setRemainingMs(MAX_CLIP_MS);
    if (!clip) return; // too short - silently ignore a stray tap

    const payload: VoiceClip = {
      clipId: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      uid: user?.uid || 'player',
      displayName: user?.displayName || 'Player',
      avatar: user?.avatar,
      mimeType: clip.mimeType,
      durationMs: clip.durationMs,
      data: clip.data,
      createdAt: Date.now(),
    };

    if (roomId) {
      const result = await sendVoiceClip(roomId, payload);
      if (result === 'cooldown') {
        setMicError('cooldown');
        setCooldownMs(4000);
      }
    } else {
      // Offline pass & play: just play it back for everyone on the device.
      playVoiceClip(payload);
      setIncomingClip({ ...payload, key: `local_${Date.now()}` });
      setTimeout(() => setIncomingClip(null), Math.max(1200, payload.durationMs));
    }
  }, [clearTimers, roomId, user]);

  const handleHoldStart = useCallback(
    async (event: React.PointerEvent) => {
      event.preventDefault();
      if (holdingRef.current || micState === 'recording' || micState === 'arming') return;
      if (cooldownMs > 0) {
        setMicError('cooldown');
        return;
      }
      holdingRef.current = true;
      setMicError(null);
      setMicState('arming');

      try {
        await startRecording();
      } catch (err) {
        holdingRef.current = false;
        setMicState('idle');
        setMicError((err as VoiceClipError)?.code === 'unsupported' ? 'unsupported' : 'permission-denied');
        return;
      }

      if (!holdingRef.current) {
        // Released before the mic was ready.
        await stopRecording();
        return;
      }

      soundFx.click();
      setMicState('recording');
      setRemainingMs(MAX_CLIP_MS);

      tickRef.current = setInterval(() => {
        setRemainingMs((prev) => Math.max(0, prev - 100));
      }, 100);

      // Hard 3 second cap.
      holdTimerRef.current = setTimeout(() => {
        void finishRecording();
      }, MAX_CLIP_MS);

      // Some browsers stop delivering pointer events on touch; also stop on
      // window-level release so a finger that slides off still sends.
      window.addEventListener('pointerup', handleHoldEnd as EventListener, { once: true });
    },
    [cooldownMs, finishRecording, micState]
  );

  const handleHoldEnd = useCallback(() => {
    window.removeEventListener('pointerup', handleHoldEnd as EventListener);
    if (!holdingRef.current) return;
    void finishRecording();
  }, [finishRecording]);

  useEffect(() => {
    if (cooldownMs <= 0) {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
      cooldownRef.current = null;
      return;
    }
    if (cooldownRef.current) return;
    cooldownRef.current = setInterval(() => {
      setCooldownMs((prev) => Math.max(0, prev - 100));
    }, 100);
  }, [cooldownMs]);

  const handleSendEmoji = async (emoji: string) => {
    soundFx.click();
    setShowPicker(false);

    if (roomId && user) {
      await sendReaction(roomId, user, emoji);
    } else if (onOfflineReaction) {
      onOfflineReaction(emoji);
    } else {
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

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const supported = isVoiceClipSupported();

  return (
    <>
      {/* Floating emoji reactions and "someone is speaking" banner */}
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
                <span className="text-xs font-black text-amber-300 max-w-[130px] truncate">{r.displayName}</span>
              </div>
            </motion.div>
          ))}

          {incomingClip && (
            <motion.div
              key={incomingClip.key}
              initial={{ y: 40, opacity: 0, scale: 0.8 }}
              animate={{ y: -30, opacity: 1, scale: 1 }}
              exit={{ y: -80, opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.25 }}
              className="absolute bg-neutral-950/95 border-2 border-emerald-400/80 px-4 py-2.5 rounded-2xl shadow-[0_12px_36px_rgba(0,0,0,0.9)] flex items-center gap-2.5 backdrop-blur-md"
            >
              <span className="text-2xl">{incomingClip.avatar || '🎤'}</span>
              <div className="flex flex-col">
                <span className="text-[11px] font-black text-emerald-300 truncate max-w-[130px]">
                  {incomingClip.displayName}
                </span>
                <span className="text-[10px] font-bold text-neutral-300">🔊 আওয়াজ দিলেন…</span>
              </div>
              <div className="flex items-end gap-0.5 h-5 ml-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <motion.span
                    key={i}
                    className="w-1 bg-emerald-400 rounded-full"
                    animate={{ height: ['30%', '100%', '45%', '85%', '30%'] }}
                    transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12 }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Trigger & drawer */}
      <div className="relative">
        <button
          id="quick-reactions-btn"
          onClick={() => setShowPicker(!showPicker)}
          className="px-3 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 border border-amber-400/60 text-white transition-all shadow-md active:scale-95 cursor-pointer flex items-center gap-1.5 text-xs font-bold ring-1 ring-amber-300/30"
          title="আওয়াজ দাও (Voice) & Reactions"
        >
          <Mic className="w-4 h-4 text-amber-200 animate-pulse" />
          <span className="hidden sm:inline">আওয়াজ দাও</span>
          <span className="sm:hidden inline">Awaz</span>
        </button>

        {showPicker && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            className="absolute bottom-12 right-0 w-[290px] sm:w-[330px] bg-neutral-950 border-2 border-amber-500/40 rounded-2xl p-3 shadow-2xl z-40 flex flex-col gap-2.5 backdrop-blur-xl"
          >
            {/* Header tabs + global mute */}
            <div className="flex items-center gap-1.5">
              <div className="flex flex-1 bg-neutral-900 p-1 rounded-xl border border-neutral-800">
                <button
                  type="button"
                  onClick={() => setTab('voice')}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    tab === 'voice'
                      ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-neutral-950 shadow font-black'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  <Mic className="w-3.5 h-3.5" />
                  আওয়াজ দাও
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
                  ইমোজি
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  setGlobalMuted(next);
                }}
                title={muted ? 'সব আওয়াজ চালু করুন' : 'সব আওয়াজ বন্ধ করুন'}
                className={`p-2 rounded-xl border cursor-pointer transition-all ${
                  muted
                    ? 'bg-red-950/60 border-red-700/70 text-red-300'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:text-white'
                }`}
              >
                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
            </div>

            {/* Tab 1: hold to talk */}
            {tab === 'voice' && (
              <div className="flex flex-col items-center gap-2 py-1">
                <p className="text-[11px] font-bold text-neutral-400 text-center leading-tight">
                  চেপে ধরে কথা বলুন — সর্বোচ্চ ৩ সেকেন্ড, সাথে সাথে সবাই শুনবে
                  <br />
                  <span className="text-neutral-500 font-semibold">Hold to talk (max 3s) — everyone hears it instantly</span>
                </p>

                <button
                  type="button"
                  data-testid="awaz-dao-button"
                  disabled={!supported || cooldownMs > 0}
                  onPointerDown={handleHoldStart}
                  onPointerUp={handleHoldEnd}
                  onPointerLeave={handleHoldEnd}
                  onPointerCancel={handleHoldEnd}
                  className={`select-none touch-none w-24 h-24 rounded-full flex flex-col items-center justify-center gap-1 font-black transition-all border-4 ${
                    micState === 'recording'
                      ? 'bg-red-600 border-red-300 text-white scale-105 shadow-[0_0_28px_rgba(239,68,68,0.6)]'
                      : cooldownMs > 0 || !supported
                        ? 'bg-neutral-900 border-neutral-800 text-neutral-600 cursor-not-allowed'
                        : 'bg-gradient-to-br from-amber-500 to-amber-700 border-amber-300 text-neutral-950 active:scale-95 cursor-pointer'
                  }`}
                >
                  {micState === 'arming' ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <Mic className="w-7 h-7" />
                  )}
                  <span className="text-[10px] font-black uppercase tracking-wide">
                    {micState === 'recording'
                      ? `${BANGLA_SECONDS[Math.min(3, secondsLeft)]}s`
                      : cooldownMs > 0
                        ? `${Math.ceil(cooldownMs / 1000)}s`
                        : 'HOLD'}
                  </span>
                </button>

                {/* Progress ring / countdown bar */}
                <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${micState === 'recording' ? 'bg-red-500' : 'bg-amber-500'}`}
                    style={{
                      width: `${
                        cooldownMs > 0
                          ? ((4000 - cooldownMs) / 4000) * 100
                          : micState === 'recording'
                            ? (remainingMs / MAX_CLIP_MS) * 100
                            : 100
                      }%`,
                    }}
                  />
                </div>

                {micError && (
                  <p className="text-[10px] font-bold text-amber-300 text-center">
                    {micError === 'permission-denied'
                      ? 'মাইক্রোফোনের অনুমতি পাওয়া যায়নি (mic permission denied)'
                      : micError === 'unsupported'
                        ? 'এই ব্রাউজারে রেকর্ডিং সাপোর্ট করে না (unsupported browser)'
                        : micError === 'cooldown'
                          ? 'একটু অপেক্ষা করুন — ৪ সেকেন্ড পর আবার চেষ্টা করুন'
                          : micError === 'clip-too-large'
                            ? 'রেকর্ডিং খুব বড় হয়ে গেছে'
                            : 'রেকর্ডিং ব্যর্থ হয়েছে, আবার চেষ্টা করুন'}
                  </p>
                )}
              </div>
            )}

            {/* Tab 2: emoji reactions */}
            {tab === 'emoji' && (
              <div className="grid grid-cols-6 gap-1.5">
                {EMOJI_LIST.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => handleSendEmoji(emoji)}
                    className="text-xl p-1.5 rounded-lg hover:bg-neutral-800 active:scale-90 transition-transform cursor-pointer"
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
}
