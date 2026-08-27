import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot, collection, query, orderBy, limit } from 'firebase/firestore';
import { auth, db } from './firebase/config';
import {
  UserProfile,
  Language,
  RoomDocument,
  RoomPlayer,
  GameDocument,
  PlayerSlot,
} from './types';
import {
  getLocalGuestProfile,
  getOrCreateUserProfile,
  loginAsGuest,
  loginWithGoogle,
  updateUserProfile,
  ensurePersistentAuth,
} from './services/authService';
import {
  rollDice as serviceRollDice,
  moveToken as serviceMoveToken,
  leaveRoom as serviceLeaveRoom,
  startGame as serviceStartGame,
  joinRoom as serviceJoinRoom,
  createSoloRoom,
  handleTurnTimeout,
  subscribeToRoom,
  subscribeToPlayers,
  subscribeToGame,
  reconnectFirestoreAndSync,
} from './services/gameService';
import { p2pMeshService } from './services/p2pMeshService';
import { getLegalMoves, hasPlayerWon, countTokensHome } from './game-engine/engine';
import { getTranslation } from './i18n/translations';
import { soundFx } from './utils/sound';

// UI Components
import { Header } from './components/ui/Header';
import { LudoBoard } from './components/board/LudoBoard';
import { SnakeLadderBoard } from './components/board/SnakeLadderBoard';
import { DiceComponent } from './components/game/DiceComponent';
import { TurnIndicator } from './components/game/TurnIndicator';
import { PlayerCard } from './components/game/PlayerCard';
import { QuickReactions } from './components/game/QuickReactions';
import { LobbyScreen } from './components/room/LobbyScreen';
import { CreateRoomModal } from './components/room/CreateRoomModal';
import { JoinRoomModal } from './components/room/JoinRoomModal';
import { GameResultModal } from './components/room/GameResultModal';
import { HowToPlayModal } from './components/room/HowToPlayModal';
import { RoomHistoryModal } from './components/room/RoomHistoryModal';
import { EditProfileModal } from './components/room/EditProfileModal';
import { InstallPwaButton } from './components/ui/InstallPwaButton';
import { PassAndPlayGame } from './components/room/PassAndPlayGame';
import { TrophyModal } from './components/room/TrophyModal';
import { awardMatchStats } from './utils/progression';

import {
  PlusCircle,
  LogIn,
  BookOpen,
  History,
  RotateCcw,
  Sparkles,
  Swords,
  Trophy,
  Users,
  KeyRound,
  Edit3,
  Bot,
  WifiOff,
  Wifi,
  Radio,
  LogOut,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

export default function App() {
  const [user, setUser] = useState<UserProfile>(() => getLocalGuestProfile());
  const [authLoading, setAuthLoading] = useState(false);
  const [language, setLanguage] = useState<Language>(() => {
    const local = getLocalGuestProfile();
    return local.preferredLanguage || 'bn';
  });
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectSuccess, setReconnectSuccess] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  // Network offline detection
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setReconnectSuccess(true);
      setTimeout(() => setReconnectSuccess(false), 3000);
    };
    const handleOffline = () => {
      setIsOnline(false);
      setReconnectSuccess(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Active Room & Game State
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomDocument | null>(null);
  const [players, setPlayers] = useState<Record<string, RoomPlayer>>({});
  const [game, setGame] = useState<GameDocument | null>(null);

  // Local UI Interaction State
  const [isRolling, setIsRolling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Direct Inline Room ID Join State
  const [quickRoomCode, setQuickRoomCode] = useState('');
  const [quickJoinLoading, setQuickJoinLoading] = useState(false);
  const [quickJoinError, setQuickJoinError] = useState<string | null>(null);

  // Play Alone (Solo Mode) State
  const [soloLoading, setSoloLoading] = useState(false);
  const [soloError, setSoloError] = useState<string | null>(null);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showHowToPlay, setShowHowToPlay] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showTrophyModal, setShowTrophyModal] = useState(false);
  const [isPassAndPlayMode, setIsPassAndPlayMode] = useState(false);
  const [initialJoinCode, setInitialJoinCode] = useState('');

  const [authError, setAuthError] = useState<string | null>(null);

  // 1. Initial Authentication & Profile Sync
  useEffect(() => {
    // Check if URL has ?room=123456
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      setInitialJoinCode(roomParam);
      setQuickRoomCode(roomParam);
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: User | null) => {
      try {
        if (firebaseUser) {
          const profile = await getOrCreateUserProfile(firebaseUser);
          setUser(profile);
          setLanguage(profile.preferredLanguage || 'bn');

          if (roomParam) {
            setInitialJoinCode(roomParam);
            setShowJoinModal(true);
          } else if (profile.activeRoomId) {
            setCurrentRoomId(profile.activeRoomId);
          }
        } else {
          // Initialize automatic anonymous authentication for seamless multi-device Firestore sync
          try {
            await loginAsGuest();
          } catch (e) {
            console.debug('Guest anonymous auth notice:', e);
          }
        }
      } catch (err: any) {
        console.warn('Auth state sync notice:', err?.message || err);
      }
    });

    return () => unsubscribe();
  }, []);

  // 2. Real-time Room and Players synchronization
  useEffect(() => {
    if (!currentRoomId) {
      setRoom(null);
      setPlayers({});
      setGame(null);
      return;
    }

    const unsubRoom = subscribeToRoom(currentRoomId, (roomData) => {
      if (roomData) {
        setRoom({ ...roomData });
      }
    });

    const unsubPlayers = subscribeToPlayers(currentRoomId, (playersData) => {
      if (playersData && Object.keys(playersData).length > 0) {
        setPlayers({ ...playersData });
      }
    });

    return () => {
      unsubRoom();
      unsubPlayers();
    };
  }, [currentRoomId]);

  // Players alias for consistent board and UI mapping
  const mergedPlayers = players;

  // 3. Real-time Game Document synchronization
  useEffect(() => {
    if (!currentRoomId || !room?.currentGameId) {
      setGame(null);
      return;
    }

    const unsubGame = subscribeToGame(currentRoomId, room.currentGameId, (gameData) => {
      if (gameData) {
        setGame({ ...gameData });
      }
    });

    return () => unsubGame();
  }, [currentRoomId, room?.currentGameId]);

  // 4. Ultra-low latency WebRTC P2P Data Mesh lifecycle
  const [p2pConnectedPeers, setP2pConnectedPeers] = useState(0);
  const [p2pLatency, setP2pLatency] = useState(24);

  useEffect(() => {
    if (!currentRoomId || !user?.uid) {
      p2pMeshService.teardown();
      setP2pConnectedPeers(0);
      return;
    }

    p2pMeshService.initRoomMesh(currentRoomId, user.uid);

    const unsubStatus = p2pMeshService.onStatusChange((peers, latency) => {
      setP2pConnectedPeers(peers);
      setP2pLatency(latency);
    });

    return () => {
      unsubStatus();
      p2pMeshService.teardown();
    };
  }, [currentRoomId, user?.uid]);

  // Map uid to player slot
  const slotMap = useMemo(() => {
    const map: Record<string, PlayerSlot> = {};
    (Object.values(players) as RoomPlayer[]).forEach((p) => {
      map[p.uid] = p.slot;
    });
    return map;
  }, [players]);

  // Calculate Legal Moves for current user
  const legalMoves = useMemo(() => {
    if (
      !game ||
      !user ||
      game.currentPlayerUid !== user.uid ||
      game.status !== 'AWAITING_TOKEN_SELECTION' ||
      game.diceValue === null ||
      !room
    ) {
      return [];
    }

    const mySlot = slotMap[user.uid] || 'P1';
    return getLegalMoves(
      user.uid,
      mySlot,
      game.diceValue,
      game.tokens,
      slotMap,
      room.settings
    );
  }, [game, user, slotMap, room]);

  // Automated System Bot Logic - Fast & Snappy (< 350ms)
  useEffect(() => {
    if (!game || !room || !user) return;
    if (room.status !== 'PLAYING' || game.winnerUid) return;

    const currentUid = game.currentPlayerUid;
    const isBotTurn = currentUid.startsWith('bot_');
    if (!isBotTurn) return;

    // Room admin triggers bot moves
    if (room.adminUid !== user.uid) return;

    let timer: NodeJS.Timeout;

    // Phase 1: Automated bot rolls the dice (Fast 300ms)
    if (
      (game.status === 'AWAITING_ROLL' || game.status === 'EXTRA_ROLL') &&
      !game.diceRolled
    ) {
      timer = setTimeout(async () => {
        try {
          const botPlayer = players[currentUid];
          const botProfile = {
            uid: currentUid,
            displayName: botPlayer?.displayName || 'Robot 🤖',
            avatar: botPlayer?.avatar || '🤖',
          } as UserProfile;

          soundFx.diceRoll();
          const res = await serviceRollDice(room.roomId, game.gameId, botProfile, game.version);
          if (res?.updatedGame) {
            setGame(res.updatedGame);
          }
        } catch (err: any) {
          console.warn('Automated bot roll notice:', err?.message || err);
        }
      }, 300);
    }

    // Phase 2: Automated bot chooses best token and moves (Fast 250ms)
    else if (
      game.status === 'AWAITING_TOKEN_SELECTION' &&
      game.diceRolled &&
      game.diceValue !== null
    ) {
      timer = setTimeout(async () => {
        try {
          const botSlot = slotMap[currentUid] || 'P2';
          const botLegalMoves = getLegalMoves(
            currentUid,
            botSlot,
            game.diceValue!,
            game.tokens,
            slotMap,
            room.settings
          );

          if (botLegalMoves.length === 0) return;

          // AI Heuristic to choose optimal move
          let bestTokenId = botLegalMoves[0];
          let bestScore = -1;

          for (const tId of botLegalMoves) {
            const token =
              game.tokens[currentUid]?.[tId.toString()] ||
              game.tokens[currentUid]?.[tId];
            if (!token) continue;
            let score = 10;
            if (token.zone === 'YARD' && game.diceValue === 6) {
              score = 300; // Unlock new piece
            } else if (token.zone === 'HOME_PATH') {
              if (token.progress + game.diceValue === 56) {
                score = 1000; // Enters Home!
              } else {
                score = 400 + token.progress;
              }
            } else if (token.zone === 'TRACK') {
              score = 60 + token.progress;
            }
            if (score > bestScore) {
              bestScore = score;
              bestTokenId = tId;
            }
          }

          const botPlayer = players[currentUid];
          const botProfile = {
            uid: currentUid,
            displayName: botPlayer?.displayName || 'Robot 🤖',
          } as UserProfile;

          const res = await serviceMoveToken(
            room.roomId,
            game.gameId,
            botProfile,
            bestTokenId,
            game.version
          );
          if (res?.updatedGame) {
            setGame(res.updatedGame);
          }
        } catch (err: any) {
          console.warn('Automated bot move notice:', err?.message || err);
        }
      }, 250);
    }

    return () => clearTimeout(timer);
  }, [game, room, user, players, slotMap]);

  // Automated Turn Timeout auto-advance (Triggered by room admin if current player is inactive)
  useEffect(() => {
    if (!game || !room || !user || game.status === 'GAME_OVER' || room.status !== 'PLAYING') return;
    if (room.adminUid !== user.uid) return;

    const remainingMs = Math.max(100, game.turnExpiresAt - Date.now() + 500);
    const timer = setTimeout(() => {
      if (Date.now() >= game.turnExpiresAt && game.status !== 'GAME_OVER') {
        handleTurnTimeout(room.roomId, game.gameId).catch(() => {});
      }
    }, remainingMs);

    return () => clearTimeout(timer);
  }, [game?.turnExpiresAt, game?.turnNumber, game?.status, room?.roomId, room?.adminUid, user?.uid]);

  // Handlers
  const handlePlayAlone = async () => {
    if (!user) return;
    soundFx.click();
    setSoloLoading(true);
    setSoloError(null);
    try {
      // Start instant match with automated system in 0ms
      const result = await createSoloRoom(user, 1);
      setRoom(result.roomData);
      setPlayers(result.playersMap);
      setGame(result.gameData);
      setCurrentRoomId(result.roomId);
    } catch (err: any) {
      console.error('Play alone failed:', err);
      setSoloError(err.message || 'Could not start solo game');
    } finally {
      setSoloLoading(false);
    }
  };

  const handlePlaySnakeLadderAlone = async () => {
    if (!user) return;
    soundFx.click();
    setSoloLoading(true);
    setSoloError(null);
    try {
      const result = await createSoloRoom(user, 1, { gameMode: 'SNAKE_LADDER' });
      setRoom(result.roomData);
      setPlayers(result.playersMap);
      setGame(result.gameData);
      setCurrentRoomId(result.roomId);
    } catch (err: any) {
      console.error('Play Snake & Ladder alone failed:', err);
      setSoloError(err.message || 'Could not start Snake & Ladder game');
    } finally {
      setSoloLoading(false);
    }
  };
  const handleLanguageToggle = () => {
    const nextLang = language === 'bn' ? 'en' : 'bn';
    setLanguage(nextLang);
    if (user) {
      updateUserProfile(user.uid, { preferredLanguage: nextLang }).catch(() => {});
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      soundFx.click();
      setAuthError(null);
      const googleUser = await loginWithGoogle();
      const profile = await getOrCreateUserProfile(googleUser);
      setUser(profile);
    } catch (e: any) {
      if (e?.code !== 'auth/popup-closed-by-user') {
        console.warn('Google sign-in issue:', e);
        setAuthError(e?.message || 'Google sign-in could not be completed.');
      }
    }
  };

  const handleQuickJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = quickRoomCode.trim();
    if (!code || !user) return;
    soundFx.click();
    setQuickJoinLoading(true);
    setQuickJoinError(null);

    try {
      const result = await serviceJoinRoom(code, user);
      if (result.roomData) setRoom(result.roomData);
      if (result.player) {
        setPlayers((prev) => ({ ...prev, [user.uid]: result.player! }));
      }
      setCurrentRoomId(result.roomId);
      setQuickRoomCode('');
    } catch (err: any) {
      if (err.message === 'errorRoomNotFound') {
        setQuickJoinError(getTranslation(language, 'errorRoomNotFound'));
      } else if (err.message === 'errorRoomFull') {
        setQuickJoinError(getTranslation(language, 'errorRoomFull'));
      } else {
        setQuickJoinError(err.message || 'Failed to join room');
      }
    } finally {
      setQuickJoinLoading(false);
    }
  };

  const handleRollDice = async () => {
    if (!user || !game || !currentRoomId || isRolling) return;
    if (game.currentPlayerUid !== user.uid) return;

    try {
      // 1. Broadcast immediate roll start so all peers animate dice without lag
      p2pMeshService.broadcast('DICE_ROLL_START', { uid: user.uid, roomId: currentRoomId });

      // Haptic tactile feedback for dice roll on mobile devices
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(40);
        } catch {}
      }
      setIsRolling(true);
      setActionError(null);
      const res = await serviceRollDice(currentRoomId, game.gameId, user, game.version);
      if (res?.updatedGame) {
        setGame(res.updatedGame);
      }
    } catch (err: any) {
      setActionError(err.message || 'Failed to roll dice');
    } finally {
      setIsRolling(false);
    }
  };

  const handleTokenClick = async (tokenId: number) => {
    if (!user || !game || !currentRoomId) return;
    if (game.currentPlayerUid !== user.uid) return;
    if (!legalMoves.includes(tokenId)) return;

    try {
      // Haptic tactile feedback for token movement on mobile devices
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate([25, 35, 25]);
        } catch {}
      }
      setActionError(null);
      const res = await serviceMoveToken(currentRoomId, game.gameId, user, tokenId, game.version);
      if (res?.updatedGame) {
        setGame(res.updatedGame);
      }
    } catch (err: any) {
      setActionError(err.message || 'Failed to move token');
    }
  };

  const handleLeaveRoom = async () => {
    soundFx.click();
    if (confirm(getTranslation(language, 'confirmLeave'))) {
      if (currentRoomId && user) {
        await serviceLeaveRoom(currentRoomId, user.uid);
      }
      setCurrentRoomId(null);
      setRoom(null);
      setGame(null);
    }
  };

  // Manual Reconnect handler without full page reload
  const handleManualReconnect = async () => {
    if (isReconnecting) return;
    soundFx.click();
    setIsReconnecting(true);
    setReconnectError(null);

    try {
      // 1. Re-verify & establish persistent Firebase authentication
      await ensurePersistentAuth();

      // 2. Perform manual Firestore network reconnection & state re-initialization
      const syncResult = await reconnectFirestoreAndSync(currentRoomId);

      // 3. Verify online status
      const online = navigator.onLine;
      setIsOnline(online || syncResult.success);

      if (syncResult.success) {
        if (syncResult.room) setRoom(syncResult.room);
        if (syncResult.players && Object.keys(syncResult.players).length > 0) {
          setPlayers(syncResult.players);
        }
        if (syncResult.game) setGame(syncResult.game);

        setReconnectSuccess(true);
        setTimeout(() => {
          setReconnectSuccess(false);
        }, 3500);
      } else if (!online) {
        setReconnectError(
          language === 'bn'
            ? 'ইন্টারনেট সংযোগ পাওয়া যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।'
            : 'No internet connection detected. Please check your network and try again.'
        );
        setTimeout(() => setReconnectError(null), 4500);
      }
    } catch (err: any) {
      console.warn('Manual reconnect error:', err);
      setReconnectError(
        err?.message ||
          (language === 'bn' ? 'সংযোগ পুনঃস্থাপনে সমস্যা হয়েছে' : 'Reconnection attempt failed')
      );
      setTimeout(() => setReconnectError(null), 4500);
    } finally {
      setIsReconnecting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4 text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500 via-amber-500 to-emerald-500 p-1 flex items-center justify-center shadow-xl shadow-amber-500/20 animate-pulse">
          <div className="w-full h-full bg-black rounded-xl flex items-center justify-center text-2xl font-black text-amber-400">
            🎲
          </div>
        </div>
        <h1 className="text-xl font-black bg-gradient-to-r from-red-400 via-amber-300 to-emerald-400 bg-clip-text text-transparent mt-4">
          LooDoo : লুডু
        </h1>
        <p className="text-xs text-neutral-400 mt-1">Connecting...</p>
      </div>
    );
  }

  // PASS & PLAY OFFLINE SCREEN
  if (isPassAndPlayMode && user) {
    return (
      <PassAndPlayGame
        language={language}
        currentUser={user}
        onExit={() => setIsPassAndPlayMode(false)}
      />
    );
  }

  // Active game view vs Lobby vs Home Screen
  const isGameActive = room && game && (room.status === 'PLAYING' || room.status === 'FINISHED');
  const isLobbyActive = room && (!game || room.status === 'OPEN' || room.status === 'READY');

  const myPlayer = user ? players[user.uid] : null;
  const myColor = myPlayer?.color || 'red';

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex flex-col selection:bg-amber-500 selection:text-neutral-950 font-sans">
      {/* Top Navigation Header */}
      <Header
        user={user}
        language={language}
        onLanguageToggle={handleLanguageToggle}
        onEditProfile={() => setShowEditProfile(true)}
        onGoogleSignIn={handleGoogleSignIn}
        onHowToPlay={() => setShowHowToPlay(true)}
        roomCode={room?.roomCode}
      />

      {/* Offline Toast Banner & Reconnect Control */}
      {!isOnline ? (
        <div
          id="offline-detection-banner"
          className="bg-neutral-950/95 border-b border-amber-500/50 text-amber-200 px-3 sm:px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2.5 sticky top-0 z-50 backdrop-blur-md shadow-lg shadow-black/80 transition-all"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center shrink-0">
              <WifiOff className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 min-w-0">
              <span className="font-bold text-amber-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping inline-block" />
                {getTranslation(language, 'offline')}
              </span>
              <span className="text-neutral-300 text-xs truncate">
                {isReconnecting
                  ? getTranslation(language, 'reconnectingServer')
                  : getTranslation(language, 'offlineDesc')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-auto">
            <button
              id="offline-reconnect-now-btn"
              onClick={handleManualReconnect}
              disabled={isReconnecting}
              className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 hover:brightness-110 active:scale-95 disabled:opacity-60 text-neutral-950 font-black text-xs shadow-md shadow-amber-500/20 flex items-center gap-1.5 transition-all cursor-pointer border border-amber-300/40"
            >
              {isReconnecting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{getTranslation(language, 'reconnecting')}</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>{getTranslation(language, 'reconnectNow')}</span>
                </>
              )}
            </button>
          </div>

          {reconnectError && (
            <div className="w-full flex items-center gap-1.5 text-[11px] text-red-300 bg-red-950/70 border border-red-800/80 px-2.5 py-1 rounded-lg mt-0.5">
              <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
              <span>{reconnectError}</span>
            </div>
          )}
        </div>
      ) : reconnectSuccess ? (
        <div
          id="connection-restored-banner"
          className="bg-emerald-950/95 border-b border-emerald-500/50 text-emerald-200 px-4 py-2 text-xs flex items-center justify-center gap-2 sticky top-0 z-50 backdrop-blur-md shadow-lg shadow-black/80 transition-all animate-fadeIn"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="font-semibold">{getTranslation(language, 'connectionRestored')}</span>
        </div>
      ) : null}

      {/* Main Container */}
      <main className="flex-1 w-full max-w-6xl mx-auto p-2 sm:p-4 md:p-6 flex flex-col justify-center">
        {/* VIEW 1: Active Game Board Screen */}
        {isGameActive && game && room && user && (
          <div>
            {/* ================= DESKTOP 3-COLUMN LAYOUT (lg and above) ================= */}
            <div className="hidden lg:flex flex-row items-start justify-center gap-6 w-full">
              {/* Left Column: Player Cards, Reactions & Tools */}
              <div className="w-72 flex flex-col gap-3 shrink-0">
                <TurnIndicator
                  game={game}
                  players={mergedPlayers}
                  myUid={user.uid}
                  language={language}
                />

                <div className="grid grid-cols-1 gap-2">
                  {game.playerOrder.map((uid) => {
                    const p = mergedPlayers[uid] || players[uid];
                    if (!p) return null;
                    return (
                      <PlayerCard
                        key={uid}
                        player={p}
                        isCurrentTurn={game.currentPlayerUid === uid}
                        isAdmin={room.adminUid === uid}
                        game={game}
                        language={language}
                        isMe={uid === user.uid}
                      />
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-2 mt-1">
                  <QuickReactions roomId={room.roomId} user={user} />
                  <button
                    onClick={() => setShowHistoryModal(true)}
                    className="px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800 text-neutral-300 hover:text-white hover:border-neutral-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <History className="w-3.5 h-3.5 text-amber-400" />
                    <span>{getTranslation(language, 'myRooms')}</span>
                  </button>
                </div>
              </div>

              {/* Center Column: 15x15 Ludo Board or Snake & Ladder Board */}
              <div className="flex flex-col items-center gap-3 w-full max-w-[540px]">
                {room.settings.gameMode === 'SNAKE_LADDER' || game.gameMode === 'SNAKE_LADDER' ? (
                  <SnakeLadderBoard
                    playerPositions={game.snakePositions || {}}
                    players={mergedPlayers}
                    playerOrder={game.playerOrder}
                    currentPlayerUid={game.currentPlayerUid}
                    myUid={user.uid}
                    language={language}
                    lastEvent={game.snakeLastEvent}
                  />
                ) : (
                  <LudoBoard
                    game={game}
                    players={mergedPlayers}
                    currentPlayerUid={game.currentPlayerUid}
                    myUid={user.uid}
                    legalMoves={legalMoves}
                    onTokenClick={handleTokenClick}
                  />
                )}

                {actionError && (
                  <div className="text-xs text-red-400 bg-red-950/60 border border-red-800 px-3 py-1.5 rounded-lg text-center">
                    {actionError}
                  </div>
                )}
              </div>

              {/* Right Column: 3D Dice & Big Roll Button */}
              <div className="w-64 flex flex-col items-center justify-center p-4 rounded-2xl bg-neutral-950 border border-neutral-850 shadow-xl">
                <DiceComponent
                  diceValue={game.diceValue}
                  isRolling={isRolling}
                  canRoll={
                    game.currentPlayerUid === user.uid &&
                    (game.status === 'AWAITING_ROLL' || game.status === 'EXTRA_ROLL') &&
                    !game.diceRolled
                  }
                  consecutiveSixes={game.consecutiveSixes || 0}
                  playerColor={myColor}
                  language={language}
                  onRoll={handleRollDice}
                />
              </div>
            </div>

            {/* ================= MOBILE-OPTIMIZED SINGLE-VIEW LAYOUT (< lg) ================= */}
            <div className="flex lg:hidden flex-col items-center gap-3 w-full max-w-lg mx-auto">
              {/* Mobile 4-Player Compact Horizontal Status Strip */}
              <div className="w-full grid grid-cols-4 gap-1.5 bg-neutral-950 border border-neutral-850 p-2 rounded-2xl shadow">
                {game.playerOrder.map((uid) => {
                  const p = mergedPlayers[uid] || players[uid];
                  if (!p) return null;
                  const isCurrent = game.currentPlayerUid === uid;
                  const isMe = uid === user.uid;
                  const color = p.color || 'red';
                  const tokensHome = countTokensHome(uid, game.tokens);

                  const colorStyles = {
                    red: 'border-red-500 bg-red-950/30 text-red-400',
                    green: 'border-emerald-500 bg-emerald-950/30 text-emerald-400',
                    yellow: 'border-amber-400 bg-amber-950/30 text-amber-400',
                    blue: 'border-blue-500 bg-blue-950/30 text-blue-400',
                  }[color] || 'border-neutral-700 bg-neutral-900 text-neutral-300';

                  return (
                    <motion.div
                      key={uid}
                      animate={isCurrent ? { scale: [1, 1.05, 1], y: [0, -2, 0] } : { scale: 1, y: 0 }}
                      transition={isCurrent ? { repeat: Infinity, duration: 2, ease: 'easeInOut' } : { duration: 0.2 }}
                      className={`relative flex flex-col items-center justify-center p-1.5 rounded-xl border transition-all select-none ${
                        isCurrent
                          ? 'border-amber-400 bg-amber-950/50 ring-2 ring-amber-400/80 shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                          : colorStyles
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <span className="text-base sm:text-lg leading-none">{p.avatar || '👤'}</span>
                        <span className="text-[10px] font-black">{p.slot}</span>
                      </div>

                      <span className="text-[10px] font-bold text-white truncate max-w-[65px] text-center mt-0.5">
                        {isMe ? 'You' : p.displayName}
                      </span>

                      {/* Home Tokens / Snake Position Badge */}
                      <span className="text-[9px] font-mono font-bold text-neutral-300 mt-0.5">
                        {room.settings.gameMode === 'SNAKE_LADDER' || game.gameMode === 'SNAKE_LADDER'
                          ? `${game.snakePositions?.[uid] || 1}/100 🐍`
                          : `${tokensHome}/4 🏆`}
                      </span>
                    </motion.div>
                  );
                })}
              </div>

              {/* Mobile Quick Reactions & History Bar */}
              <div className="w-full flex items-center justify-between gap-2 px-1">
                <QuickReactions roomId={room.roomId} user={user} />
                <button
                  onClick={() => setShowHistoryModal(true)}
                  className="px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800 text-neutral-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
                  title={getTranslation(language, 'myRooms')}
                >
                  <History className="w-3.5 h-3.5 text-amber-400" />
                  <span>{getTranslation(language, 'myRooms')}</span>
                </button>
              </div>

              {/* Mobile Centered Board */}
              <div className="w-full flex flex-col items-center">
                {room.settings.gameMode === 'SNAKE_LADDER' || game.gameMode === 'SNAKE_LADDER' ? (
                  <SnakeLadderBoard
                    playerPositions={game.snakePositions || {}}
                    players={mergedPlayers}
                    playerOrder={game.playerOrder}
                    currentPlayerUid={game.currentPlayerUid}
                    myUid={user.uid}
                    language={language}
                    lastEvent={game.snakeLastEvent}
                  />
                ) : (
                  <LudoBoard
                    game={game}
                    players={mergedPlayers}
                    currentPlayerUid={game.currentPlayerUid}
                    myUid={user.uid}
                    legalMoves={legalMoves}
                    onTokenClick={handleTokenClick}
                  />
                )}

                {actionError && (
                  <div className="text-xs text-red-400 bg-red-950/60 border border-red-800 px-3 py-1 rounded-lg text-center mt-1">
                    {actionError}
                  </div>
                )}
              </div>

              {/* Mobile Action Dock: Turn Status + Large Dice Action + Reactions */}
              <div className="w-full flex flex-col gap-2.5 bg-neutral-950 border border-neutral-850 p-3 rounded-2xl shadow-xl">
                <TurnIndicator
                  game={game}
                  players={mergedPlayers}
                  myUid={user.uid}
                  language={language}
                />

                <DiceComponent
                  diceValue={game.diceValue}
                  isRolling={isRolling}
                  canRoll={
                    game.currentPlayerUid === user.uid &&
                    (game.status === 'AWAITING_ROLL' || game.status === 'EXTRA_ROLL') &&
                    !game.diceRolled
                  }
                  consecutiveSixes={game.consecutiveSixes || 0}
                  playerColor={myColor}
                  language={language}
                  onRoll={handleRollDice}
                />

                <div className="flex items-center justify-between gap-2 pt-1 border-t border-neutral-850">
                  <QuickReactions roomId={room.roomId} user={user} />
                  <button
                    onClick={handleLeaveRoom}
                    className="px-2.5 py-1.5 rounded-lg bg-red-950/40 border border-red-800/60 text-red-400 text-xs font-bold flex items-center gap-1 active:scale-95"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>{getTranslation(language, 'leaveRoom')}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 2: Room Lobby Screen */}
        {isLobbyActive && room && user && (
          <LobbyScreen
            room={room}
            players={mergedPlayers}
            currentUser={user}
            language={language}
            onLeaveRoom={handleLeaveRoom}
            onGameStarted={(gameData, roomData) => {
              setRoom({ ...roomData });
              setGame({ ...gameData });
            }}
          />
        )}

        {/* VIEW 3: Main Welcome Screen */}
        {!room && user && (
          <div className="w-full max-w-xl mx-auto flex flex-col items-center gap-5 py-4 sm:py-6 text-center">
            {/* Hero Ludo Logo */}
            <div className="relative">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl bg-gradient-to-br from-red-500 via-amber-500 via-emerald-500 to-blue-500 p-1 shadow-2xl shadow-amber-500/25 flex items-center justify-center">
                <div className="w-full h-full bg-black rounded-2xl flex items-center justify-center text-4xl sm:text-5xl drop-shadow">
                  🎲
                </div>
              </div>
              <span className="absolute -bottom-2 -right-2 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 text-neutral-950 text-[10px] font-black tracking-wider uppercase shadow-md">
                Bangladesh
              </span>
            </div>

            {/* Title & Tagline */}
            <div className="flex flex-col gap-1">
              <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-white">
                <span className="bg-gradient-to-r from-red-400 via-amber-300 to-emerald-400 bg-clip-text text-transparent">
                  LooDoo
                </span>{' '}
                :{' '}
                <span className="bg-gradient-to-r from-amber-400 to-yellow-300 bg-clip-text text-transparent">
                  লুডু
                </span>
              </h1>
              <p className="text-xs sm:text-sm text-neutral-400 max-w-sm mx-auto">
                {language === 'bn'
                  ? 'অনলাইন মাল্টিপ্লেয়ার লুডু ও সাপ-লুডু'
                  : 'Online multiplayer Ludo & Snake-Ladder'}
              </p>
            </div>

            {/* Current Player Profile Bar (Changeable Emoji Photo & Nickname) */}
            <div className="w-full bg-neutral-950 border border-neutral-800/80 rounded-2xl p-3 sm:p-3.5 flex items-center justify-between shadow-lg shadow-black/60">
              <div className="flex items-center gap-3">
                <button
                  id="home-avatar-btn"
                  onClick={() => {
                    soundFx.click();
                    setShowEditProfile(true);
                  }}
                  title={language === 'bn' ? 'ইমোজি পরিবর্তন করুন' : 'Change emoji avatar'}
                  className="relative group w-11 h-11 rounded-xl bg-black border border-neutral-700/80 hover:border-amber-400 flex items-center justify-center text-2xl shadow-inner cursor-pointer transition-all hover:scale-105 shrink-0"
                >
                  <span>{user.avatar || '🎲'}</span>
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 text-neutral-950 flex items-center justify-center text-[10px] shadow">
                    <Edit3 className="w-2.5 h-2.5" />
                  </div>
                </button>

                <div className="text-left flex flex-col min-w-0">
                  <span className="text-[11px] text-neutral-400 font-medium">
                    {language === 'bn' ? 'আপনার ডাকনাম' : 'Your Nickname'}
                  </span>
                  <span className="text-sm font-bold text-amber-400 truncate max-w-[150px] sm:max-w-[220px] flex items-center gap-1.5">
                    {user.displayName}
                    {user.isAnonymous && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400 font-normal border border-neutral-800">
                        {language === 'bn' ? 'গেস্ট' : 'Guest'}
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  id="home-trophy-btn"
                  onClick={() => {
                    soundFx.click();
                    setShowTrophyModal(true);
                  }}
                  className="px-2.5 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-all shadow-sm"
                  title="Level, XP & Trophies"
                >
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  <span>Lv.{user.stats?.level || 1}</span>
                </button>

                <button
                  id="home-edit-profile-btn"
                  onClick={() => {
                    soundFx.click();
                    setShowEditProfile(true);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-neutral-900 to-neutral-850 hover:from-neutral-850 hover:to-neutral-800 text-neutral-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all border border-neutral-750 shrink-0 shadow-sm"
                >
                  <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                  <span className="hidden sm:inline">{language === 'bn' ? 'নাম ও ইমোজি' : 'Edit Profile'}</span>
                </button>
              </div>
            </div>

            {/* DEDICATED 1-TAP INSTALL PWA ON HOME SCREEN BUTTON */}
            <InstallPwaButton language={language} variant="prominent" />

            {/* TWO EQUALLY SIZED AND DISTINCT ENTRY OPTIONS */}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full items-stretch">
              {/* Option 1: CREATE ROOM */}
              <div className="w-full bg-neutral-950 border border-neutral-800 hover:border-amber-500/50 rounded-3xl p-5 flex flex-col justify-between gap-4 shadow-xl shadow-black/80 transition-all text-left">
                <div className="flex flex-col gap-2">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-red-500/20 via-amber-500/20 to-orange-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shadow-inner">
                    <PlusCircle className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base sm:text-lg font-black text-white tracking-tight uppercase">
                      {getTranslation(language, 'createRoom')}
                    </h2>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      {language === 'bn'
                        ? 'নতুন রুম তৈরি করে বন্ধুদের আমন্ত্রণ জানান'
                        : 'Host a new custom match and invite your friends'}
                    </p>
                  </div>
                </div>

                <button
                  id="home-create-room-btn"
                  onClick={() => {
                    soundFx.click();
                    setShowCreateModal(true);
                  }}
                  className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-red-600 via-amber-500 to-emerald-600 hover:brightness-110 text-white font-black text-sm sm:text-base shadow-lg shadow-amber-500/25 flex items-center justify-center gap-2 transition-all active:scale-[0.98] cursor-pointer"
                >
                  <PlusCircle className="w-4 h-4 shrink-0" />
                  <span>{getTranslation(language, 'createRoom')}</span>
                </button>
              </div>

              {/* Option 2: JOIN ROOM */}
              <div className="w-full bg-neutral-950 border border-neutral-800 hover:border-emerald-500/50 rounded-3xl p-5 flex flex-col justify-between gap-4 shadow-xl shadow-black/80 transition-all text-left">
                <div className="flex flex-col gap-2">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-500/20 via-teal-500/20 to-cyan-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-inner">
                    <KeyRound className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base sm:text-lg font-black text-white tracking-tight uppercase">
                      {getTranslation(language, 'joinRoom')}
                    </h2>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      {language === 'bn'
                        ? 'রুম নম্বর দিয়ে সরাসরি খেলায় প্রবেশ করুন'
                        : 'Enter the room number to jump into an existing match'}
                    </p>
                  </div>
                </div>

                <form onSubmit={handleQuickJoin} className="flex flex-col gap-2.5">
                  <input
                    id="quick-room-code-input"
                    type="text"
                    maxLength={12}
                    value={quickRoomCode}
                    onChange={(e) => {
                      setQuickRoomCode(e.target.value);
                      setQuickJoinError(null);
                    }}
                    placeholder="enter room number"
                    className="w-full bg-black border border-neutral-700/80 rounded-xl px-3.5 py-2.5 text-center text-sm sm:text-base font-mono font-bold tracking-wider text-amber-400 placeholder:text-neutral-500 placeholder:font-sans placeholder:text-xs placeholder:tracking-normal focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    id="quick-room-join-btn"
                    type="submit"
                    disabled={quickJoinLoading || !quickRoomCode.trim()}
                    className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed text-neutral-950 font-black text-sm sm:text-base shadow-lg shadow-emerald-500/25 flex items-center justify-center gap-2 transition-all active:scale-[0.98] cursor-pointer"
                  >
                    {quickJoinLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        <span>{language === 'bn' ? 'যুক্ত হচ্ছে...' : 'Joining Room...'}</span>
                      </>
                    ) : (
                      <>
                        <LogIn className="w-4 h-4 shrink-0" />
                        <span>{getTranslation(language, 'joinRoom')}</span>
                      </>
                    )}
                  </button>
                  {quickJoinError && (
                    <div className="text-[11px] text-red-400 bg-red-950/60 border border-red-800/80 px-2.5 py-1.5 rounded-lg text-center">
                      {quickJoinError}
                    </div>
                  )}
                </form>
              </div>
            </div>

            {/* BOTTOM ACTIONS: PLAY ALONE, PASS & PLAY OFFLINE, TROPHIES & HOW TO PLAY */}
            <div className="w-full flex flex-col items-center gap-3 pt-1">
              <div className="flex flex-wrap items-center justify-center gap-2.5 w-full">
                {/* PASS & PLAY (OFFLINE 4-PLAYER ON 1 PHONE) */}
                <button
                  id="home-pass-and-play-btn"
                  onClick={() => {
                    soundFx.click();
                    setIsPassAndPlayMode(true);
                  }}
                  className="py-2.5 px-4 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 hover:brightness-115 active:scale-95 text-neutral-950 font-black text-xs sm:text-sm shadow-lg shadow-orange-500/25 flex items-center justify-center gap-2 border border-amber-300/40 cursor-pointer transition-all"
                >
                  <Sparkles className="w-4 h-4 text-neutral-950" />
                  <span>
                    {language === 'bn' ? 'এক ফোনে ৪ জন (Pass & Play)' : 'Offline Pass & Play'}
                  </span>
                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-black/20 text-neutral-950">
                    Offline
                  </span>
                </button>

                {/* PLAY ALONE / একলা খেলো BUTTON */}
                <button
                  id="home-play-alone-btn"
                  onClick={handlePlayAlone}
                  disabled={soloLoading}
                  className="py-2.5 px-4 rounded-2xl bg-gradient-to-r from-purple-600 via-pink-600 to-rose-500 hover:brightness-115 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed text-white font-black text-xs sm:text-sm shadow-lg shadow-pink-500/25 flex items-center justify-center gap-2 border border-pink-400/40 cursor-pointer transition-all"
                >
                  {soloLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-pink-200" />
                  ) : (
                    <Bot className="w-4 h-4 text-pink-200" />
                  )}
                  <span>
                    {soloLoading
                      ? (language === 'bn' ? 'শুরু হচ্ছে...' : 'Starting...')
                      : (language === 'bn' ? 'একলা খেলো' : 'Play Alone')}
                  </span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded-full bg-black/30 text-pink-100">
                    vs AI
                  </span>
                </button>

                {/* SNAKE & LADDER QUICK PLAY BUTTON */}
                <button
                  id="home-snake-ladder-btn"
                  onClick={handlePlaySnakeLadderAlone}
                  disabled={soloLoading}
                  className="py-2.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 via-teal-600 to-green-500 hover:brightness-115 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed text-white font-black text-xs sm:text-sm shadow-lg shadow-emerald-500/25 flex items-center justify-center gap-2 border border-emerald-400/40 cursor-pointer transition-all"
                >
                  <span className="text-base">🐍</span>
                  <span>
                    {language === 'bn' ? 'সাপ-লুডু খেলুন' : 'Snake & Ladders'}
                  </span>
                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-black/30 text-emerald-200">
                    Mode
                  </span>
                </button>
              </div>

              {soloError && (
                <div className="text-xs text-red-400 bg-red-950/60 border border-red-800 px-3 py-1.5 rounded-lg text-center">
                  {soloError}
                </div>
              )}

              {/* Secondary Utilities: Trophies, Badges & How to Play */}
              <div className="flex items-center gap-2">
                <button
                  id="home-trophies-bottom-btn"
                  onClick={() => {
                    soundFx.click();
                    setShowTrophyModal(true);
                  }}
                  className="py-1.5 px-3 rounded-xl bg-neutral-950 hover:bg-neutral-900 border border-neutral-800 text-amber-300 hover:text-amber-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all"
                >
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  <span>{language === 'bn' ? 'অর্জন ও ট্রফি' : 'Trophies & Badges'}</span>
                </button>

                <button
                  id="home-how-to-play-btn"
                  onClick={() => {
                    soundFx.click();
                    setShowHowToPlay(true);
                  }}
                  className="py-1.5 px-3 rounded-xl bg-neutral-950 hover:bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all"
                >
                  <BookOpen className="w-3.5 h-3.5 text-amber-400" />
                  <span>{getTranslation(language, 'howToPlay')}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Page Footer & Bottom Screen Credit */}
      <footer className="w-full py-4 text-center text-xs text-neutral-400 font-medium border-t border-neutral-900/80 mt-auto bg-neutral-950/80 backdrop-blur shrink-0 flex flex-col sm:flex-row items-center justify-center gap-1.5 z-10 px-4">
        <span>Built with love, for FnF, by</span>
        <span className="text-amber-400 font-bold tracking-wide">©munabbirMushran</span>
      </footer>

      {/* MODALS */}
      {/* Trophy & Progression Modal */}
      {showTrophyModal && user && (
        <TrophyModal
          user={user}
          language={language}
          onClose={() => setShowTrophyModal(false)}
        />
      )}
      {/* Create Room Modal */}
      {showCreateModal && user && (
        <CreateRoomModal
          user={user}
          language={language}
          onRoomCreated={(roomId, _roomCode, _gameMode, roomData, p1Player) => {
            if (roomData) setRoom(roomData);
            if (p1Player) setPlayers({ [p1Player.uid]: p1Player });
            setCurrentRoomId(roomId);
            setShowCreateModal(false);
          }}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {/* Join Room Modal */}
      {showJoinModal && user && (
        <JoinRoomModal
          user={user}
          language={language}
          initialCode={initialJoinCode}
          onJoined={(roomId) => {
            setShowJoinModal(false);
            setCurrentRoomId(roomId);
          }}
          onClose={() => setShowJoinModal(false)}
        />
      )}

      {/* How To Play Modal */}
      {showHowToPlay && (
        <HowToPlayModal
          language={language}
          onClose={() => setShowHowToPlay(false)}
        />
      )}

      {/* Room Match History Modal */}
      {showHistoryModal && room && (
        <RoomHistoryModal
          roomId={room.roomId}
          language={language}
          onClose={() => setShowHistoryModal(false)}
        />
      )}

      {/* Edit Profile Modal */}
      {showEditProfile && user && (
        <EditProfileModal
          user={user}
          language={language}
          onUpdate={(updated) => setUser(updated)}
          onClose={() => setShowEditProfile(false)}
        />
      )}

      {/* Victory / Game Result Modal */}
      {game && game.status === 'GAME_OVER' && room && user && (
        <GameResultModal
          game={game}
          room={room}
          players={players}
          currentUserUid={user.uid}
          language={language}
          onBackToLobby={() => {
            // Keep in room but let admin manage rematch
          }}
        />
      )}
    </div>
  );
}
