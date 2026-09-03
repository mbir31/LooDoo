import React, { useMemo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  PlayerColor,
  PlayerSlot,
  TokenZone,
  GameDocument,
  RoomPlayer,
  RoomSettings,
  TokenTheme,
} from '../../types';
import {
  getTokenGridCoordinates,
  getProjectedLandingInfo,
} from '../../game-engine/engine';
import { Star, Trophy, Sparkles, Zap, Shield, Swords } from 'lucide-react';
import { soundFx } from '../../utils/sound';
import { BoardToken } from './BoardToken';

interface LudoBoardProps {
  game: GameDocument;
  players: Record<string, RoomPlayer>;
  currentPlayerUid: string;
  myUid: string;
  legalMoves: number[];
  onTokenClick: (tokenId: number) => void;
  disabled?: boolean;
  userTokenTheme?: TokenTheme;
  /** Room rules used for the ghost landing preview (blockades, team mode...). */
  settings?: RoomSettings;
}

const COLOR_MAP: Record<PlayerColor, {
  yardBg: string;
  yardBorder: string;
  homeFill: string;
  pathBg: string;
  pathBorder: string;
  tokenGradient: string;
  tokenBorder: string;
  tokenGlow: string;
  tokenHighlight: string;
  ring: string;
  name: string;
}> = {
  red: {
    yardBg: 'bg-gradient-to-br from-rose-500 via-red-600 to-red-700',
    yardBorder: 'border-red-800',
    homeFill: '#dc2626',
    pathBg: 'bg-gradient-to-r from-red-600 to-rose-500',
    pathBorder: 'border-red-600',
    tokenGradient: 'from-rose-400 via-red-500 to-red-700',
    tokenBorder: 'border-red-900',
    tokenGlow: 'rgba(239, 68, 68, 0.6)',
    tokenHighlight: 'bg-rose-200',
    ring: 'ring-red-400',
    name: 'Red',
  },
  green: {
    yardBg: 'bg-gradient-to-br from-emerald-500 via-emerald-600 to-emerald-700',
    yardBorder: 'border-emerald-800',
    homeFill: '#059669',
    pathBg: 'bg-gradient-to-b from-emerald-600 to-teal-500',
    pathBorder: 'border-emerald-600',
    tokenGradient: 'from-emerald-300 via-emerald-500 to-emerald-700',
    tokenBorder: 'border-emerald-900',
    tokenGlow: 'rgba(16, 185, 129, 0.6)',
    tokenHighlight: 'bg-emerald-200',
    ring: 'ring-emerald-400',
    name: 'Green',
  },
  yellow: {
    yardBg: 'bg-gradient-to-br from-amber-400 via-amber-500 to-yellow-600',
    yardBorder: 'border-amber-700',
    homeFill: '#d97706',
    pathBg: 'bg-gradient-to-l from-amber-500 to-yellow-400',
    pathBorder: 'border-amber-500',
    tokenGradient: 'from-yellow-200 via-amber-400 to-amber-600',
    tokenBorder: 'border-amber-800',
    tokenGlow: 'rgba(245, 158, 11, 0.6)',
    tokenHighlight: 'bg-yellow-100',
    ring: 'ring-amber-300',
    name: 'Yellow',
  },
  blue: {
    yardBg: 'bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-700',
    yardBorder: 'border-blue-800',
    homeFill: '#2563eb',
    pathBg: 'bg-gradient-to-t from-blue-600 to-indigo-500',
    pathBorder: 'border-blue-600',
    tokenGradient: 'from-sky-300 via-blue-500 to-blue-700',
    tokenBorder: 'border-blue-900',
    tokenGlow: 'rgba(59, 130, 246, 0.6)',
    tokenHighlight: 'bg-sky-200',
    ring: 'ring-blue-400',
    name: 'Blue',
  },
};

export const LudoBoard: React.FC<LudoBoardProps> = ({
  game,
  players,
  currentPlayerUid,
  myUid,
  legalMoves,
  onTokenClick,
  disabled = false,
  userTokenTheme = 'classic',
  settings,
}) => {
  const isMyTurn = currentPlayerUid === myUid;
  const isAwaitingTokenSelection = game.status === 'AWAITING_TOKEN_SELECTION';

  const [hoveredTokenId, setHoveredTokenId] = useState<number | null>(null);

  // Helper to extract player assigned to each Yard color
  const getYardPlayer = (color: PlayerColor) => {
    if (!players) return null;
    const playerList = Object.values(players) as any[];

    const slotByColor: Record<PlayerColor, PlayerSlot> = {
      red: 'P1',
      green: 'P2',
      yellow: 'P3',
      blue: 'P4',
    };
    const targetSlot = slotByColor[color];

    // 1. Check by explicit color
    let p = playerList.find((item) => item && (item.color === color || item.playerColor === color));

    // 2. Fallback check by slot
    if (!p) {
      p = playerList.find((item) => item && item.slot === targetSlot);
    }

    // 3. Fallback direct key in players object
    if (!p && (players as any)[targetSlot]) {
      p = (players as any)[targetSlot];
    }
    if (!p && (players as any)[color]) {
      p = (players as any)[color];
    }

    if (!p) return null;

    const rawName =
      p.displayName ||
      p.name ||
      (targetSlot === 'P1'
        ? 'Player 1'
        : targetSlot === 'P2'
        ? 'Player 2'
        : targetSlot === 'P3'
        ? 'Player 3'
        : 'Player 4');
    const uid = p.uid || p.id || targetSlot;
    const isMe = uid === myUid;
    const isCurrentTurn = currentPlayerUid === uid || currentPlayerUid === targetSlot;

    return {
      name: rawName,
      avatar: p.avatar,
      isMe,
      isCurrentTurn,
      slot: p.slot || targetSlot,
    };
  };

  // Map uid to slot
  const slotMap = useMemo(() => {
    const map: Record<string, PlayerSlot> = {};
    (Object.values(players) as RoomPlayer[]).forEach((p) => {
      map[p.uid] = p.slot;
    });
    return map;
  }, [players]);

  // Aggregate all tokens on board to calculate stacked tokens per coordinate
  const { allTokensList } = useMemo(() => {
    const list: Array<{
      uid: string;
      tokenId: number;
      slot: PlayerSlot;
      color: PlayerColor;
      theme: TokenTheme;
      zone: TokenZone;
      progress: number;
      coords: [number, number];
      isMovable: boolean;
      stackIndex: number;
      stackTotal: number;
    }> = [];

    const coordMap = new Map<string, number>();

    if (game && game.tokens) {
      for (const [uid, pTokens] of Object.entries(game.tokens)) {
        const p = players[uid];
        const slot = slotMap[uid] || 'P1';
        const color = p?.color || (slot === 'P1' ? 'red' : slot === 'P2' ? 'green' : slot === 'P3' ? 'yellow' : 'blue');
        const theme: TokenTheme = p?.tokenTheme || (uid === myUid ? userTokenTheme : 'classic');

        for (let tid = 0; tid < 4; tid++) {
          const t = pTokens[tid.toString()] || pTokens[tid];
          if (!t) continue;

          const coords = getTokenGridCoordinates(slot, t.id, t.zone, t.progress);
          const coordKey = `${coords[0]}_${coords[1]}`;
          const currentCount = coordMap.get(coordKey) || 0;
          coordMap.set(coordKey, currentCount + 1);

          const isMovable =
            isMyTurn &&
            isAwaitingTokenSelection &&
            uid === myUid &&
            legalMoves.includes(t.id) &&
            !disabled;

          list.push({
            uid,
            tokenId: t.id,
            slot,
            color,
            theme,
            zone: t.zone,
            progress: t.progress,
            coords,
            isMovable,
            stackIndex: currentCount,
            stackTotal: 1,
          });
        }
      }
    }

    // Update stack totals
    list.forEach((item) => {
      const coordKey = `${item.coords[0]}_${item.coords[1]}`;
      item.stackTotal = coordMap.get(coordKey) || 1;
    });

    return { allTokensList: list };
  }, [game, players, slotMap, isMyTurn, isAwaitingTokenSelection, myUid, legalMoves, disabled, userTokenTheme]);

  // Projected Landing Info for hover preview (or if only 1 move available)
  const activePreviewTokenId = hoveredTokenId !== null ? hoveredTokenId : (legalMoves.length === 1 ? legalMoves[0] : null);

  const landingPreview = useMemo(() => {
    if (!isMyTurn || !isAwaitingTokenSelection || activePreviewTokenId === null || !game?.diceValue) return null;
    const myTokens = game.tokens[myUid];
    if (!myTokens) return null;
    const token = myTokens[activePreviewTokenId.toString()] || myTokens[activePreviewTokenId];
    if (!token) return null;
    const mySlot = slotMap[myUid] || 'P1';

    // The preview must follow the real room rules, otherwise it can advertise
    // a move the engine would reject (e.g. onto a blockade).
    const previewSettings: RoomSettings = settings || {
      maxPlayers: 4,
      turnTimeoutSeconds: 30,
      strictThreeSixRule: true,
      allowBlockades: false,
      customNamesAllowed: true,
    };

    return getProjectedLandingInfo(
      token,
      mySlot,
      myUid,
      game.diceValue,
      game.tokens,
      slotMap,
      previewSettings
    );
  }, [isMyTurn, isAwaitingTokenSelection, activePreviewTokenId, game, myUid, slotMap, settings]);

  // Visual Effect Triggers: Capture Blast & Home Entrance
  const [captureFx, setCaptureFx] = useState<{ x: number; y: number } | null>(null);
  const [homeFx, setHomeFx] = useState<boolean>(false);

  useEffect(() => {
    if (game?.lastCapturedToken) {
      setCaptureFx({ x: 50, y: 50 });
      const t = setTimeout(() => setCaptureFx(null), 1200);
      return () => clearTimeout(t);
    }
  }, [game?.lastCapturedToken, game?.lastActionAt]);

  useEffect(() => {
    if (game?.lastAction === 'EXTRA_TURN_GRANTED' && game?.turnMessage?.type === 'home') {
      setHomeFx(true);
      const t = setTimeout(() => setHomeFx(false), 1600);
      return () => clearTimeout(t);
    }
  }, [game?.lastAction, game?.lastActionAt]);

  // Cell helper definitions for the 15x15 grid
  const getCellType = (r: number, c: number) => {
    if (r >= 0 && r <= 5 && c >= 0 && c <= 5) return 'yard_green';
    if (r >= 0 && r <= 5 && c >= 9 && c <= 14) return 'yard_yellow';
    if (r >= 9 && r <= 14 && c >= 0 && c <= 5) return 'yard_red';
    if (r >= 9 && r <= 14 && c >= 9 && c <= 14) return 'yard_blue';

    if (r >= 6 && r <= 8 && c >= 6 && c <= 8) return 'center_home';

    if (r === 7 && c >= 1 && c <= 5) return 'home_path_green';
    if (c === 7 && r >= 1 && r <= 5) return 'home_path_yellow';
    if (r === 7 && c >= 9 && c <= 13) return 'home_path_blue';
    if (c === 7 && r >= 9 && r <= 13) return 'home_path_red';

    if (r === 13 && c === 6) return 'start_red';
    if (r === 6 && c === 1) return 'start_green';
    if (r === 1 && c === 8) return 'start_yellow';
    if (r === 8 && c === 13) return 'start_blue';

    if (r === 8 && c === 2) return 'star';
    if (r === 2 && c === 6) return 'star';
    if (r === 6 && c === 12) return 'star';
    if (r === 12 && c === 8) return 'star';

    return 'track_normal';
  };

  return (
    <div
      id="loodoo-board-container"
      data-testid="loodoo-board"
      data-legal-moves={legalMoves.join(',')}
      className="relative w-full max-w-[min(96vw,520px)] aspect-square mx-auto rounded-2xl sm:rounded-3xl p-2 sm:p-3.5 bg-gradient-to-b from-neutral-900 via-neutral-950 to-black shadow-2xl select-none touch-manipulation border-2 sm:border-4 border-neutral-800 ring-1 ring-neutral-700/50"
      style={{
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.9), inset 0 2px 4px rgba(255, 255, 255, 0.1)',
      }}
    >
      {/* 3D Realistic Board Canvas (15x15 Grid Layout) */}
      <div className="relative w-full h-full bg-[#f8f9fa] rounded-2xl overflow-hidden shadow-2xl grid grid-cols-15 grid-rows-15 border-2 border-neutral-800">
        
        {/* ================= 4 REALISTIC YARDS ================= */}
        {/* Top-Left: Green Yard */}
        {(() => {
          const greenPlayer = getYardPlayer('green');
          return (
            <div className="absolute top-0 left-0 w-[40%] h-[40%] bg-gradient-to-br from-emerald-500 via-emerald-600 to-emerald-700 p-2 sm:p-3 flex items-center justify-center border-r-4 border-b-4 border-neutral-900 shadow-lg z-0">
              <div className="w-full h-full bg-white/95 rounded-2xl shadow-inner flex items-center justify-center border-4 border-emerald-700/40 p-2 relative overflow-hidden">
                <div className="absolute inset-0 bg-radial from-emerald-100/60 to-transparent pointer-events-none" />
                
                {/* 4 Token Sockets */}
                <div className="grid grid-cols-2 grid-rows-2 gap-3 sm:gap-4 w-4/5 h-4/5">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="rounded-full bg-gradient-to-b from-neutral-100 to-neutral-200 border-2 border-emerald-500/80 shadow-[inset_0_3px_6px_rgba(0,0,0,0.35)] flex items-center justify-center ring-2 ring-emerald-600/30"
                    >
                      <div className="w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-emerald-500/25 border border-emerald-600/40 shadow-inner" />
                    </div>
                  ))}
                </div>

                {/* Engraved Player Name in Green Text */}
                {greenPlayer && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5 p-1">
                    <div
                      className={`max-w-[90%] px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg bg-gradient-to-b from-white/95 via-white/90 to-emerald-50/80 border border-emerald-600/35 shadow-[inset_0_1.5px_3px_rgba(4,120,87,0.22),0_1px_1px_rgba(255,255,255,0.9)] flex items-center justify-center gap-1 transition-all ${
                        greenPlayer.isCurrentTurn ? 'ring-2 ring-emerald-500/60 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : ''
                      }`}
                      style={{
                        textShadow: '0 1px 0 rgba(255,255,255,0.95), 0 -0.5px 0.5px rgba(0,0,0,0.18)',
                      }}
                      title={greenPlayer.name}
                    >
                      {greenPlayer.avatar && (
                        <span className="text-[10px] sm:text-xs leading-none shrink-0 drop-shadow-xs">
                          {greenPlayer.avatar}
                        </span>
                      )}
                      <span className="text-[9px] sm:text-[11px] font-black tracking-tight text-emerald-700 uppercase truncate max-w-[65px] sm:max-w-[85px]">
                        {greenPlayer.name}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Top-Right: Yellow Yard */}
        {(() => {
          const yellowPlayer = getYardPlayer('yellow');
          return (
            <div className="absolute top-0 right-0 w-[40%] h-[40%] bg-gradient-to-br from-amber-400 via-amber-500 to-yellow-600 p-2 sm:p-3 flex items-center justify-center border-l-4 border-b-4 border-neutral-900 shadow-lg z-0">
              <div className="w-full h-full bg-white/95 rounded-2xl shadow-inner flex items-center justify-center border-4 border-amber-600/40 p-2 relative overflow-hidden">
                <div className="absolute inset-0 bg-radial from-amber-100/60 to-transparent pointer-events-none" />
                
                {/* 4 Token Sockets */}
                <div className="grid grid-cols-2 grid-rows-2 gap-3 sm:gap-4 w-4/5 h-4/5">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="rounded-full bg-gradient-to-b from-neutral-100 to-neutral-200 border-2 border-amber-500/80 shadow-[inset_0_3px_6px_rgba(0,0,0,0.35)] flex items-center justify-center ring-2 ring-amber-600/30"
                    >
                      <div className="w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-amber-500/25 border border-amber-600/40 shadow-inner" />
                    </div>
                  ))}
                </div>

                {/* Engraved Player Name in Yellow/Amber Text */}
                {yellowPlayer && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5 p-1">
                    <div
                      className={`max-w-[90%] px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg bg-gradient-to-b from-white/95 via-white/90 to-amber-50/80 border border-amber-500/35 shadow-[inset_0_1.5px_3px_rgba(180,83,9,0.22),0_1px_1px_rgba(255,255,255,0.9)] flex items-center justify-center gap-1 transition-all ${
                        yellowPlayer.isCurrentTurn ? 'ring-2 ring-amber-500/60 shadow-[0_0_8px_rgba(245,158,11,0.4)]' : ''
                      }`}
                      style={{
                        textShadow: '0 1px 0 rgba(255,255,255,0.95), 0 -0.5px 0.5px rgba(0,0,0,0.18)',
                      }}
                      title={yellowPlayer.name}
                    >
                      {yellowPlayer.avatar && (
                        <span className="text-[10px] sm:text-xs leading-none shrink-0 drop-shadow-xs">
                          {yellowPlayer.avatar}
                        </span>
                      )}
                      <span className="text-[9px] sm:text-[11px] font-black tracking-tight text-amber-700 uppercase truncate max-w-[65px] sm:max-w-[85px]">
                        {yellowPlayer.name}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Bottom-Left: Red Yard */}
        {(() => {
          const redPlayer = getYardPlayer('red');
          return (
            <div className="absolute bottom-0 left-0 w-[40%] h-[40%] bg-gradient-to-br from-rose-500 via-red-600 to-red-700 p-2 sm:p-3 flex items-center justify-center border-r-4 border-t-4 border-neutral-900 shadow-lg z-0">
              <div className="w-full h-full bg-white/95 rounded-2xl shadow-inner flex items-center justify-center border-4 border-red-700/40 p-2 relative overflow-hidden">
                <div className="absolute inset-0 bg-radial from-rose-100/60 to-transparent pointer-events-none" />
                
                {/* 4 Token Sockets */}
                <div className="grid grid-cols-2 grid-rows-2 gap-3 sm:gap-4 w-4/5 h-4/5">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="rounded-full bg-gradient-to-b from-neutral-100 to-neutral-200 border-2 border-red-500/80 shadow-[inset_0_3px_6px_rgba(0,0,0,0.35)] flex items-center justify-center ring-2 ring-red-600/30"
                    >
                      <div className="w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-red-500/25 border border-red-600/40 shadow-inner" />
                    </div>
                  ))}
                </div>

                {/* Engraved Player Name in Red Text */}
                {redPlayer && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5 p-1">
                    <div
                      className={`max-w-[90%] px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg bg-gradient-to-b from-white/95 via-white/90 to-rose-50/80 border border-red-500/35 shadow-[inset_0_1.5px_3px_rgba(185,28,28,0.22),0_1px_1px_rgba(255,255,255,0.9)] flex items-center justify-center gap-1 transition-all ${
                        redPlayer.isCurrentTurn ? 'ring-2 ring-red-500/60 shadow-[0_0_8px_rgba(239,68,68,0.4)]' : ''
                      }`}
                      style={{
                        textShadow: '0 1px 0 rgba(255,255,255,0.95), 0 -0.5px 0.5px rgba(0,0,0,0.18)',
                      }}
                      title={redPlayer.name}
                    >
                      {redPlayer.avatar && (
                        <span className="text-[10px] sm:text-xs leading-none shrink-0 drop-shadow-xs">
                          {redPlayer.avatar}
                        </span>
                      )}
                      <span className="text-[9px] sm:text-[11px] font-black tracking-tight text-red-700 uppercase truncate max-w-[65px] sm:max-w-[85px]">
                        {redPlayer.name}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Bottom-Right: Blue Yard */}
        {(() => {
          const bluePlayer = getYardPlayer('blue');
          return (
            <div className="absolute bottom-0 right-0 w-[40%] h-[40%] bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-700 p-2 sm:p-3 flex items-center justify-center border-l-4 border-t-4 border-neutral-900 shadow-lg z-0">
              <div className="w-full h-full bg-white/95 rounded-2xl shadow-inner flex items-center justify-center border-4 border-blue-700/40 p-2 relative overflow-hidden">
                <div className="absolute inset-0 bg-radial from-blue-100/60 to-transparent pointer-events-none" />
                
                {/* 4 Token Sockets */}
                <div className="grid grid-cols-2 grid-rows-2 gap-3 sm:gap-4 w-4/5 h-4/5">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="rounded-full bg-gradient-to-b from-neutral-100 to-neutral-200 border-2 border-blue-500/80 shadow-[inset_0_3px_6px_rgba(0,0,0,0.35)] flex items-center justify-center ring-2 ring-blue-600/30"
                    >
                      <div className="w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-blue-500/25 border border-blue-600/40 shadow-inner" />
                    </div>
                  ))}
                </div>

                {/* Engraved Player Name in Blue Text */}
                {bluePlayer && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5 p-1">
                    <div
                      className={`max-w-[90%] px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg bg-gradient-to-b from-white/95 via-white/90 to-blue-50/80 border border-blue-500/35 shadow-[inset_0_1.5px_3px_rgba(29,78,216,0.22),0_1px_1px_rgba(255,255,255,0.9)] flex items-center justify-center gap-1 transition-all ${
                        bluePlayer.isCurrentTurn ? 'ring-2 ring-blue-500/60 shadow-[0_0_8px_rgba(59,130,246,0.4)]' : ''
                      }`}
                      style={{
                        textShadow: '0 1px 0 rgba(255,255,255,0.95), 0 -0.5px 0.5px rgba(0,0,0,0.18)',
                      }}
                      title={bluePlayer.name}
                    >
                      {bluePlayer.avatar && (
                        <span className="text-[10px] sm:text-xs leading-none shrink-0 drop-shadow-xs">
                          {bluePlayer.avatar}
                        </span>
                      )}
                      <span className="text-[9px] sm:text-[11px] font-black tracking-tight text-blue-700 uppercase truncate max-w-[65px] sm:max-w-[85px]">
                        {bluePlayer.name}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ================= 3D CENTER HOME TRIANGLE ================= */}
        <div className="absolute top-[40%] left-[40%] w-[20%] h-[20%] border-4 border-neutral-900 z-0 overflow-hidden shadow-2xl bg-neutral-950">
          <svg className="w-full h-full" viewBox="0 0 100 100">
            <defs>
              <linearGradient id="grad-green" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#10b981" />
                <stop offset="100%" stopColor="#047857" />
              </linearGradient>
              <linearGradient id="grad-yellow" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#d97706" />
              </linearGradient>
              <linearGradient id="grad-blue" x1="0%" y1="100%" x2="0%" y2="0%">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#1d4ed8" />
              </linearGradient>
              <linearGradient id="grad-red" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#b91c1c" />
              </linearGradient>
            </defs>
            {/* Top Yellow Triangle */}
            <polygon points="0,0 100,0 50,50" fill="url(#grad-yellow)" stroke="#b45309" strokeWidth="1.5" />
            {/* Right Blue Triangle */}
            <polygon points="100,0 100,100 50,50" fill="url(#grad-blue)" stroke="#1e40af" strokeWidth="1.5" />
            {/* Bottom Red Triangle */}
            <polygon points="0,100 100,100 50,50" fill="url(#grad-red)" stroke="#991b1b" strokeWidth="1.5" />
            {/* Left Green Triangle */}
            <polygon points="0,0 0,100 50,50" fill="url(#grad-green)" stroke="#065f46" strokeWidth="1.5" />
          </svg>

          {/* 3D Golden Medallion Trophy in Center */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-gradient-to-b from-amber-200 via-amber-400 to-amber-600 shadow-xl flex items-center justify-center border-2 border-white ring-2 ring-amber-700/60">
              <Trophy className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-neutral-950 drop-shadow" />
            </div>
          </div>
        </div>

        {/* ================= 15x15 GRID CELLS ================= */}
        {Array.from({ length: 15 }).map((_, r) =>
          Array.from({ length: 15 }).map((_, c) => {
            const cellType = getCellType(r, c);

            if (
              cellType.startsWith('yard') ||
              cellType === 'center_home'
            ) {
              return (
                <div
                  key={`${r}-${c}`}
                  className="w-full h-full pointer-events-none"
                  style={{ gridRow: r + 1, gridColumn: c + 1 }}
                />
              );
            }

            let cellClass = 'border border-neutral-300 flex items-center justify-center relative shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] ';
            let cellContent: React.ReactNode = null;

            if (cellType === 'start_red') {
              cellClass += 'bg-gradient-to-br from-rose-500 to-red-600 text-white font-bold border-red-700';
              cellContent = <Star className="w-3 h-3 sm:w-4 sm:h-4 fill-white text-white drop-shadow-md" />;
            } else if (cellType === 'start_green') {
              cellClass += 'bg-gradient-to-br from-emerald-400 to-emerald-600 text-white font-bold border-emerald-700';
              cellContent = <Star className="w-3 h-3 sm:w-4 sm:h-4 fill-white text-white drop-shadow-md" />;
            } else if (cellType === 'start_yellow') {
              cellClass += 'bg-gradient-to-br from-amber-400 to-yellow-500 text-white font-bold border-amber-600';
              cellContent = <Star className="w-3 h-3 sm:w-4 sm:h-4 fill-white text-white drop-shadow-md" />;
            } else if (cellType === 'start_blue') {
              cellClass += 'bg-gradient-to-br from-sky-400 to-blue-600 text-white font-bold border-blue-700';
              cellContent = <Star className="w-3 h-3 sm:w-4 sm:h-4 fill-white text-white drop-shadow-md" />;
            } else if (cellType === 'home_path_red') {
              cellClass += 'bg-gradient-to-t from-red-500 to-rose-600 border-red-600 shadow-inner';
            } else if (cellType === 'home_path_green') {
              cellClass += 'bg-gradient-to-r from-emerald-500 to-teal-600 border-emerald-600 shadow-inner';
            } else if (cellType === 'home_path_yellow') {
              cellClass += 'bg-gradient-to-b from-amber-400 to-yellow-500 border-amber-500 shadow-inner';
            } else if (cellType === 'home_path_blue') {
              cellClass += 'bg-gradient-to-l from-blue-500 to-indigo-600 border-blue-600 shadow-inner';
            } else if (cellType === 'star') {
              cellClass += 'bg-gradient-to-b from-white to-amber-50/80';
              cellContent = (
                <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-amber-400/20 flex items-center justify-center border border-amber-400/40 shadow-sm">
                  <Star className="w-3 h-3 sm:w-3.5 sm:h-3.5 fill-amber-400 text-amber-500 drop-shadow-sm" />
                </div>
              );
            } else {
              cellClass += 'bg-gradient-to-b from-white to-neutral-100 hover:bg-neutral-50 transition-colors';
            }

            if (r === 7 && c === 0) {
              cellClass += ' bg-emerald-50';
              cellContent = <span className="text-[11px] sm:text-xs font-black text-emerald-600 drop-shadow-sm">➔</span>;
            } else if (r === 0 && c === 7) {
              cellClass += ' bg-amber-50';
              cellContent = <span className="text-[11px] sm:text-xs font-black text-amber-600 drop-shadow-sm">⬇</span>;
            } else if (r === 7 && c === 14) {
              cellClass += ' bg-blue-50';
              cellContent = <span className="text-[11px] sm:text-xs font-black text-blue-600 drop-shadow-sm">⬅</span>;
            } else if (r === 14 && c === 7) {
              cellClass += ' bg-rose-50';
              cellContent = <span className="text-[11px] sm:text-xs font-black text-red-600 drop-shadow-sm">⬆</span>;
            }

            return (
              <div
                key={`${r}-${c}`}
                className={cellClass}
                style={{ gridRow: r + 1, gridColumn: c + 1 }}
              >
                {cellContent}
              </div>
            );
          })
        )}

        {/* ================= GHOST LANDING TILE PREVIEW ================= */}
        {landingPreview && (
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            className="absolute z-15 pointer-events-none flex items-center justify-center"
            style={{
              left: `${(landingPreview.targetCoord[1] / 15) * 100}%`,
              top: `${(landingPreview.targetCoord[0] / 15) * 100}%`,
              width: `${(1 / 15) * 100}%`,
              height: `${(1 / 15) * 100}%`,
            }}
          >
            <div className={`relative w-[92%] h-[92%] rounded-xl flex items-center justify-center border-2 ${
              landingPreview.isCapture
                ? 'border-red-500 bg-red-500/30 animate-ping'
                : landingPreview.isHome
                ? 'border-amber-400 bg-amber-400/30 animate-pulse'
                : 'border-cyan-400 bg-cyan-400/25 animate-pulse'
            }`}>
              {landingPreview.isCapture && (
                <Swords className="w-3.5 h-3.5 text-red-500 drop-shadow animate-bounce" />
              )}
              {landingPreview.isHome && (
                <Trophy className="w-3.5 h-3.5 text-amber-400 drop-shadow animate-bounce" />
              )}
              {landingPreview.isSafe && !landingPreview.isHome && (
                <Shield className="w-3 h-3 text-emerald-400 drop-shadow" />
              )}
            </div>
          </motion.div>
        )}

        {/* ================= 3D REALISTIC TOKENS LAYER WITH SMOOTH GLIDING ================= */}
        {allTokensList.map((tokenItem) => {
          const { uid, tokenId, slot, color, theme, zone, progress, isMovable, coords, stackIndex, stackTotal } = tokenItem;

          return (
            <BoardToken
              key={`${uid}-${tokenId}`}
              uid={uid}
              tokenId={tokenId}
              slot={slot}
              color={color}
              theme={theme}
              zone={zone}
              progress={progress}
              coords={coords}
              isMovable={isMovable}
              stackIndex={stackIndex}
              stackTotal={stackTotal}
              onClick={() => {
                if (isMovable) {
                  soundFx.click();
                  onTokenClick(tokenId);
                }
              }}
              onHoverStart={() => {
                if (isMovable) setHoveredTokenId(tokenId);
              }}
              onHoverEnd={() => {
                if (hoveredTokenId === tokenId) setHoveredTokenId(null);
              }}
            />
          );
        })}

        {/* ================= VISUAL ACTION EFFECTS OVERLAY ================= */}
        {/* 1. Capture Blast Shockwave */}
        <AnimatePresence>
          {captureFx && (
            <motion.div
              initial={{ scale: 0.2, opacity: 1 }}
              animate={{ scale: 2.2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: 'easeOut' }}
              className="absolute inset-0 flex items-center justify-center pointer-events-none z-30"
            >
              <div className="w-32 h-32 rounded-full border-4 border-red-500 bg-red-500/20 shadow-[0_0_50px_rgba(239,68,68,0.8)] flex items-center justify-center">
                <Zap className="w-10 h-10 text-amber-300 animate-spin" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 2. Home Victory Sparkle Burst */}
        <AnimatePresence>
          {homeFx && (
            <motion.div
              initial={{ scale: 0.5, opacity: 1 }}
              animate={{ scale: 1.6, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.2, ease: 'easeOut' }}
              className="absolute top-[40%] left-[40%] w-[20%] h-[20%] flex items-center justify-center pointer-events-none z-30"
            >
              <div className="w-full h-full rounded-full border-4 border-amber-400 bg-amber-400/30 shadow-[0_0_40px_rgba(251,191,36,0.9)] flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-amber-300 animate-bounce" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

