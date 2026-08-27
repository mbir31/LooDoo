import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  RoomDocument,
  RoomPlayer,
  UserProfile,
  Language,
  PlayerColor,
} from '../../types';
import { getTranslation } from '../../i18n/translations';
import {
  startGame,
  togglePlayerReady,
  updatePlayerConfig,
  leaveRoom,
} from '../../services/gameService';
import { soundFx } from '../../utils/sound';
import {
  Copy,
  Check,
  Share2,
  Play,
  LogOut,
  Settings,
  Crown,
  Sparkles,
  Users,
  Shield,
  Loader2,
} from 'lucide-react';
import { AdminSettingsModal } from './AdminSettingsModal';
import { VoicePanel } from '../game/VoicePanel';
import { InstallPwaButton } from '../ui/InstallPwaButton';

interface LobbyScreenProps {
  room: RoomDocument;
  players: Record<string, RoomPlayer>;
  currentUser: UserProfile;
  language: Language;
  onLeaveRoom: () => void;
  onGameStarted?: (gameData: any, roomData: RoomDocument) => void;
}

const SLOT_CONFIG: Record<string, { label: string; defaultColor: PlayerColor; border: string; bg: string }> = {
  P1: { label: 'Player 1', defaultColor: 'red', border: 'border-red-500', bg: 'bg-red-500/10' },
  P2: { label: 'Player 2', defaultColor: 'green', border: 'border-emerald-500', bg: 'bg-emerald-500/10' },
  P3: { label: 'Player 3', defaultColor: 'yellow', border: 'border-amber-400', bg: 'bg-amber-400/10' },
  P4: { label: 'Player 4', defaultColor: 'blue', border: 'border-blue-500', bg: 'bg-blue-500/10' },
};

export const LobbyScreen: React.FC<LobbyScreenProps> = ({
  room,
  players,
  currentUser,
  language,
  onLeaveRoom,
  onGameStarted,
}) => {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isAdmin = room.adminUid === currentUser.uid;
  const myPlayer = players[currentUser.uid];
  const activePlayers = (Object.values(players) as RoomPlayer[]).filter((p) => p.status === 'active');
  const allReady = activePlayers.length >= 2 && activePlayers.every((p) => p.ready || p.uid === room.adminUid);

  const handleCopyCode = async () => {
    soundFx.click();
    await navigator.clipboard.writeText(room.roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleShareInvite = async () => {
    soundFx.click();
    const joinUrl = `${window.location.origin}/?room=${room.roomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join LooDoo : লুডু Room',
          text: 'লুডো খেলবো, খেলতে চাইলে ক্লিক করো লিংকে -',
          url: joinUrl,
        });
        return;
      } catch (e) {}
    }
    await navigator.clipboard.writeText(joinUrl);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const handleToggleReady = async () => {
    soundFx.click();
    if (!myPlayer) return;
    await togglePlayerReady(room.roomId, currentUser.uid, !myPlayer.ready);
  };

  const handleStartGame = async () => {
    if (!isAdmin || isStarting) return;
    if (activePlayers.length < 2) {
      setErrorMsg(language === 'bn' ? 'খেলা শুরু করতে অন্তত ২ জন খেলোয়াড় প্রয়োজন।' : 'Minimum 2 players required to start.');
      return;
    }
    try {
      soundFx.click();
      setIsStarting(true);
      setErrorMsg(null);
      const res = await startGame(room.roomId, currentUser.uid);
      if (res && res.gameData && res.roomData && onGameStarted) {
        onGameStarted(res.gameData, res.roomData);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to start game');
      setIsStarting(false);
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-4 p-3 sm:p-4">
      {/* Header & 6-Digit Room Code Card */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-4 sm:p-5 shadow-2xl flex flex-col items-center gap-3">
        <div className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">
          {getTranslation(language, 'roomCode')}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-3xl sm:text-4xl font-black font-mono tracking-widest bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-transparent drop-shadow">
            {room.roomCode}
          </span>
          <button
            onClick={handleCopyCode}
            className="p-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-200 border border-neutral-750 transition-all active:scale-95 cursor-pointer"
            title={getTranslation(language, 'copyCode')}
          >
            {copiedCode ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5" />}
          </button>
        </div>

        {/* Share Button */}
        <button
          onClick={handleShareInvite}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 hover:from-amber-500/30 hover:to-orange-500/30 border border-amber-500/40 text-amber-300 text-xs sm:text-sm font-bold transition-all cursor-pointer shadow-sm"
        >
          {copiedInvite ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4" />}
          <span>{copiedInvite ? getTranslation(language, 'inviteCopied') : getTranslation(language, 'shareInvite')}</span>
        </button>
      </div>

      {/* Live Voice Chat in Lobby */}
      <VoicePanel
        roomId={room.roomId}
        myUid={currentUser.uid}
        language={language}
      />

      {/* Player Slots Grid */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-neutral-200">
            <Users className="w-4 h-4 text-amber-400" />
            <span>{getTranslation(language, 'players')} ({activePlayers.length}/{room.maxPlayers})</span>
          </div>

          {isAdmin && (
            <button
              onClick={() => setShowAdminModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-neutral-300 text-xs font-semibold border border-neutral-750 cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5 text-amber-400" />
              <span>{getTranslation(language, 'adminControls')}</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {['P1', 'P2', 'P3', 'P4'].slice(0, room.maxPlayers).map((slotKey) => {
            const player = (Object.values(players) as RoomPlayer[]).find((p) => p.slot === slotKey && p.status === 'active');
            const slotConfig = SLOT_CONFIG[slotKey];
            const isSlotAdmin = player && player.uid === room.adminUid;
            const isMe = player && player.uid === currentUser.uid;

            return (
              <div
                key={slotKey}
                className={`p-3 rounded-xl border-2 flex items-center justify-between gap-2 transition-all ${
                  player ? `${slotConfig.border} ${slotConfig.bg}` : 'border-dashed border-neutral-800 bg-black/40 text-neutral-600'
                }`}
              >
                {player ? (
                  <>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-black border border-neutral-700 flex items-center justify-center text-xl shadow">
                        {player.avatar || '👤'}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-white truncate">
                            {player.displayName}
                          </span>
                          {isSlotAdmin && <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                          {isMe && <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1 rounded">You</span>}
                        </div>
                        <span className="text-[11px] text-neutral-400 font-mono">{slotKey} • {player.color}</span>
                      </div>
                    </div>

                    <div className="shrink-0">
                      {isSlotAdmin ? (
                        <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-bold">
                          Admin
                        </span>
                      ) : player.ready ? (
                        <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold">
                          Ready ✓
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full bg-neutral-900 text-neutral-400 border border-neutral-800 text-xs">
                          Waiting...
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-neutral-500 text-xs italic py-2">
                    <span className="font-mono">{slotKey}</span>
                    <span>Waiting for player...</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {errorMsg && (
          <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 p-2.5 rounded-xl">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <button
          onClick={onLeaveRoom}
          className="w-full sm:w-auto px-4 py-3 rounded-xl bg-neutral-900 hover:bg-neutral-850 text-neutral-300 border border-neutral-800 font-bold text-sm flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-95"
        >
          <LogOut className="w-4 h-4 text-red-400" />
          <span>{getTranslation(language, 'leaveRoom')}</span>
        </button>

        {!isAdmin && myPlayer && (
          <button
            onClick={handleToggleReady}
            className={`w-full flex-1 py-3 rounded-xl font-bold text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg transition-all active:scale-95 cursor-pointer ${
              myPlayer.ready
                ? 'bg-neutral-900 text-amber-300 border border-amber-500/40 hover:bg-neutral-850'
                : 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:brightness-110 text-neutral-950 font-black shadow-emerald-600/30'
            }`}
          >
            {myPlayer.ready ? getTranslation(language, 'setNotReady') : getTranslation(language, 'setReady')}
          </button>
        )}

        {isAdmin && (
          <button
            onClick={handleStartGame}
            disabled={activePlayers.length < 2 || isStarting}
            className={`w-full flex-1 py-3 rounded-xl font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-xl transition-all active:scale-95 ${
              activePlayers.length >= 2 && !isStarting
                ? 'bg-gradient-to-r from-red-600 via-amber-500 to-emerald-600 text-white shadow-amber-500/25 hover:brightness-110 cursor-pointer animate-pulse'
                : 'bg-neutral-900 text-neutral-500 cursor-not-allowed border border-neutral-800'
            }`}
          >
            {isStarting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                <span>{language === 'bn' ? 'শুরু হচ্ছে...' : 'Starting Game...'}</span>
              </>
            ) : (
              <>
                <Play className="w-5 h-5 fill-current" />
                <span>{getTranslation(language, 'startGame')}</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* 1-Tap PWA Install Banner */}
      <InstallPwaButton language={language} variant="banner" />

      {/* Screen Bottom Credit Footer */}
      <footer className="w-full py-4 text-center text-xs text-neutral-400 font-medium border-t border-neutral-900 mt-4 flex flex-col sm:flex-row items-center justify-center gap-1">
        <span>Built with love, for FnF, by</span>
        <span className="text-amber-400 font-bold tracking-wide">©munabbirMushran</span>
      </footer>

      {/* Admin Settings Modal */}

      {showAdminModal && (
        <AdminSettingsModal
          room={room}
          players={players}
          language={language}
          onClose={() => setShowAdminModal(false)}
        />
      )}
    </div>
  );
};
