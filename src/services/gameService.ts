import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  limit,
  onSnapshot,
  Unsubscribe,
  enableNetwork,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  UserProfile,
  RoomDocument,
  RoomPlayer,
  RoomSettings,
  GameDocument,
  GameEvent,
  GameEventType,
  PlayerColor,
  PlayerSlot,
  ReactionEvent,
  GameHistoryRecord,
} from '../types';
import {
  createInitialTokens,
  calculateTokenMove,
  getLegalMoves,
  hasPlayerWon,
  getNextPlayerUid,
  countTokensHome,
} from '../game-engine/engine';
import { SNAKES_MAP, LADDERS_MAP } from '../components/board/SnakeLadderBoard';

// Helper to generate cryptographically secure dice value 1..6
export function generateSecureDice(): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return 1 + Math.floor((array[0] / (0xffffffff + 1)) * 6);
}

// Generate 6-digit room code e.g. 482731
export function generateRoomCode(): string {
  const num = Math.floor(100000 + Math.random() * 900000);
  return num.toString();
}

const DEFAULT_SETTINGS: RoomSettings = {
  maxPlayers: 4,
  turnTimeoutSeconds: 30,
  strictThreeSixRule: true, // Authentic Bangladeshi 3x consecutive 6 cancels turn
  allowBlockades: false,
  customNamesAllowed: true,
};

const SLOT_COLORS: Record<PlayerSlot, PlayerColor> = {
  P1: 'red',
  P2: 'green',
  P3: 'yellow',
  P4: 'blue',
};

const ALL_SLOTS: PlayerSlot[] = ['P1', 'P2', 'P3', 'P4'];

/**
 * High-speed Zero-Latency Memory & Cross-Tab Realtime Synchronization Engine
 */
interface LocalRoomCache {
  room: RoomDocument;
  players: Record<string, RoomPlayer>;
  game: GameDocument | null;
  events: GameEvent[];
}

export const localStore = new Map<string, LocalRoomCache>();

// Listener subscribers
const roomListeners = new Map<string, Set<(room: RoomDocument | null) => void>>();
const playersListeners = new Map<string, Set<(players: Record<string, RoomPlayer>) => void>>();
const gameListeners = new Map<string, Set<(game: GameDocument | null) => void>>();

function notifyRoomSubscribers(roomId: string, room: RoomDocument | null) {
  const cloned = room ? { ...room } : null;
  roomListeners.get(roomId)?.forEach((cb) => {
    try {
      cb(cloned ? { ...cloned } : null);
    } catch (_) {}
  });
}

function notifyPlayersSubscribers(roomId: string, players: Record<string, RoomPlayer>) {
  const cloned = { ...players };
  playersListeners.get(roomId)?.forEach((cb) => {
    try {
      cb({ ...cloned });
    } catch (_) {}
  });
}

function notifyGameSubscribers(roomId: string, game: GameDocument | null) {
  const cloned = game ? { ...game } : null;
  gameListeners.get(roomId)?.forEach((cb) => {
    try {
      cb(cloned ? { ...cloned } : null);
    } catch (_) {}
  });
}

// Cross-tab broadcast channel for instant multi-tab synchronization
let crossTabChannel: BroadcastChannel | null = null;
try {
  if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
    crossTabChannel = new BroadcastChannel('loodoo_sync_channel');
    crossTabChannel.onmessage = (event) => {
      const { type, roomId, data } = event.data || {};
      if (!roomId) return;
      let cached = localStore.get(roomId);
      if (!cached && data?.room) {
        cached = {
          room: data.room,
          players: data.players || {},
          game: data.game || null,
          events: [],
        };
        localStore.set(roomId, cached);
      }
      if (cached) {
        if (type === 'ROOM_UPDATED' && data?.room) {
          cached.room = data.room;
          notifyRoomSubscribers(roomId, cached.room);
        }
        if (type === 'PLAYERS_UPDATED' && data?.players) {
          cached.players = data.players;
          notifyPlayersSubscribers(roomId, cached.players);
        }
        if (type === 'GAME_UPDATED' && data?.game) {
          cached.game = data.game;
          notifyGameSubscribers(roomId, cached.game);
        }
      }
    };
  }
} catch (_) {}

function broadcastLocalUpdate(type: string, roomId: string, data: any) {
  try {
    crossTabChannel?.postMessage({ type, roomId, data });
  } catch (_) {}
}

/**
 * Non-blocking background Firestore write wrapper
 */
function firestoreBackgroundSync(promise: Promise<any>): void {
  promise.catch((err) => {
    // Non-blocking sync notice
    console.debug('Firestore sync notice:', err?.message || err);
  });
}

/**
 * Subscriptions with Hybrid Local-First & Firestore Realtime Sync
 */
export function subscribeToRoom(
  roomId: string,
  callback: (room: RoomDocument | null) => void
): Unsubscribe {
  if (!roomListeners.has(roomId)) {
    roomListeners.set(roomId, new Set());
  }
  roomListeners.get(roomId)!.add(callback);

  // Send cached value instantly (0ms)
  const cached = localStore.get(roomId);
  if (cached?.room) {
    callback({ ...cached.room });
  }

  // Hook Firestore snapshot
  const roomRef = doc(db, 'rooms', roomId);
  const unsubFirestore = onSnapshot(
    roomRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data() as RoomDocument;
        let c = localStore.get(roomId);
        if (!c) {
          c = { room: { ...data }, players: {}, game: null, events: [] };
          localStore.set(roomId, c);
        } else {
          c.room = { ...data };
        }
        callback({ ...data });
      }
    },
    () => {}
  );

  return () => {
    roomListeners.get(roomId)?.delete(callback);
    unsubFirestore();
  };
}

export function subscribeToPlayers(
  roomId: string,
  callback: (players: Record<string, RoomPlayer>) => void
): Unsubscribe {
  if (!playersListeners.has(roomId)) {
    playersListeners.set(roomId, new Set());
  }
  playersListeners.get(roomId)!.add(callback);

  // Send cached value instantly (0ms)
  const cached = localStore.get(roomId);
  if (cached?.players && Object.keys(cached.players).length > 0) {
    callback({ ...cached.players });
  }

  const playersRef = collection(db, 'rooms', roomId, 'players');
  const unsubFirestore = onSnapshot(
    playersRef,
    (snap) => {
      const pMap: Record<string, RoomPlayer> = {};
      snap.docs.forEach((d) => {
        pMap[d.id] = d.data() as RoomPlayer;
      });
      if (Object.keys(pMap).length > 0) {
        let c = localStore.get(roomId);
        if (c) {
          c.players = { ...c.players, ...pMap };
        }
        callback({ ...pMap });
      }
    },
    () => {}
  );

  return () => {
    playersListeners.get(roomId)?.delete(callback);
    unsubFirestore();
  };
}

export function subscribeToGame(
  roomId: string,
  gameId: string,
  callback: (game: GameDocument | null) => void
): Unsubscribe {
  if (!gameListeners.has(roomId)) {
    gameListeners.set(roomId, new Set());
  }
  gameListeners.get(roomId)!.add(callback);

  // Send cached value instantly (0ms)
  const cached = localStore.get(roomId);
  if (cached?.game && cached.game.gameId === gameId) {
    callback({ ...cached.game });
  }

  const gameRef = doc(db, 'rooms', roomId, 'games', gameId);
  const unsubFirestore = onSnapshot(
    gameRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data() as GameDocument;
        let c = localStore.get(roomId);
        if (c) {
          // If remote version is newer or equal, update
          if (!c.game || data.version >= c.game.version) {
            c.game = { ...data };
            callback({ ...data });
          }
        } else {
          callback({ ...data });
        }
      }
    },
    () => {}
  );

  return () => {
    gameListeners.get(roomId)?.delete(callback);
    unsubFirestore();
  };
}

/**
 * Creates a persistent Room in 0ms (Instant local + background Firestore sync)
 */
export async function createRoom(
  user: UserProfile,
  maxPlayers: 2 | 3 | 4 = 4,
  customSettings?: Partial<RoomSettings>
): Promise<{ roomId: string; roomCode: string; roomData: RoomDocument; p1Player: RoomPlayer }> {
  const roomCode = generateRoomCode();
  const roomId = roomCode;
  const roomRef = doc(db, 'rooms', roomId);

  const settings: RoomSettings = {
    ...DEFAULT_SETTINGS,
    maxPlayers,
    ...customSettings,
  };

  const roomData: RoomDocument = {
    roomId,
    roomCode,
    adminUid: user.uid,
    status: 'OPEN',
    maxPlayers,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentGameId: null,
    lastGameId: null,
    settings,
  };

  const p1Player: RoomPlayer = {
    uid: user.uid,
    playerId: `P1-${roomCode}`,
    slot: 'P1',
    displayName: user.displayName || 'Player 1',
    color: 'red',
    avatar: user.avatar || '🦁',
    ready: true,
    connected: true,
    status: 'active',
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    voiceEnabled: false,
  };

  // 1. Instant local state & broadcast (0ms)
  localStore.set(roomId, {
    room: roomData,
    players: { [user.uid]: p1Player },
    game: null,
    events: [],
  });
  notifyRoomSubscribers(roomId, roomData);
  notifyPlayersSubscribers(roomId, { [user.uid]: p1Player });
  broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: roomData, players: { [user.uid]: p1Player } });

  // 2. Immediate Firestore sync with robust write
  const playerRef = doc(db, 'rooms', roomId, 'players', user.uid);
  try {
    await Promise.all([
      setDoc(roomRef, roomData),
      setDoc(playerRef, p1Player),
      updateDoc(doc(db, 'users', user.uid), {
        activeRoomId: roomId,
        lastSeenAt: Date.now(),
      }).catch(() => {}),
    ]);
  } catch (err: any) {
    console.warn('Firestore room creation sync notice:', err?.message || err);
  }

  return { roomId, roomCode, roomData, p1Player };
}

/**
 * Creates a Solo Room with automated system bot players and starts the game in 0ms!
 */
export async function createSoloRoom(
  user: UserProfile,
  botCount: 1 | 3 = 1,
  customSettings?: Partial<RoomSettings>
): Promise<{
  roomId: string;
  roomCode: string;
  roomData: RoomDocument;
  playersMap: Record<string, RoomPlayer>;
  gameData: GameDocument;
}> {
  const roomCode = generateRoomCode();
  const roomId = roomCode;
  const roomRef = doc(db, 'rooms', roomId);
  const maxPlayers = (botCount === 1 ? 2 : 4) as 2 | 4;

  const settings: RoomSettings = {
    ...DEFAULT_SETTINGS,
    maxPlayers,
    turnTimeoutSeconds: 30,
    strictThreeSixRule: true,
    ...customSettings,
  };

  const gameId = `game_${Date.now()}`;
  const now = Date.now();

  const roomData: RoomDocument = {
    roomId,
    roomCode,
    adminUid: user.uid,
    status: 'PLAYING',
    maxPlayers,
    createdAt: now,
    updatedAt: now,
    currentGameId: gameId,
    lastGameId: null,
    settings,
  };

  // 1. Human Player (P1)
  const p1Player: RoomPlayer = {
    uid: user.uid,
    playerId: `P1-${roomCode}`,
    slot: 'P1',
    displayName: user.displayName || 'Player 1',
    color: 'red',
    avatar: user.avatar || '🦁',
    ready: true,
    connected: true,
    status: 'active',
    joinedAt: now,
    lastSeenAt: now,
    voiceEnabled: false,
  };

  // 2. Automated System Bot Players
  const botSlots: { slot: PlayerSlot; color: PlayerColor; name: string; avatar: string; uid: string }[] = [
    { slot: 'P2', color: 'green', name: 'রোবট সবুজ 🤖', avatar: '🤖', uid: `bot_${roomId}_p2` },
    { slot: 'P3', color: 'yellow', name: 'রোবট হলুদ ⚡', avatar: '⚡', uid: `bot_${roomId}_p3` },
    { slot: 'P4', color: 'blue', name: 'রোবট নীল 🎯', avatar: '🎯', uid: `bot_${roomId}_p4` },
  ];

  const selectedBots = botSlots.slice(0, botCount);
  const playersMap: Record<string, RoomPlayer> = { [user.uid]: p1Player };

  for (const bot of selectedBots) {
    const botPlayer: RoomPlayer = {
      uid: bot.uid,
      playerId: `${bot.slot}-${roomCode}`,
      slot: bot.slot,
      displayName: bot.name,
      color: bot.color,
      avatar: bot.avatar,
      ready: true,
      connected: true,
      status: 'active',
      joinedAt: now,
      lastSeenAt: now,
      voiceEnabled: false,
    };
    playersMap[bot.uid] = botPlayer;
  }

  // 3. Initialize Game Document
  const playerOrder = [user.uid, ...selectedBots.map((b) => b.uid)];
  const initialTokens = createInitialTokens(playerOrder);
  const turnTimeout = (settings.turnTimeoutSeconds || 30) * 1000;

  const initialSnakePositions: Record<string, number> = {};
  playerOrder.forEach((uid) => {
    initialSnakePositions[uid] = 1;
  });

  const gameData: GameDocument = {
    gameId,
    roomId,
    gameMode: settings.gameMode || 'CLASSIC',
    status: 'AWAITING_ROLL',
    playerOrder,
    currentPlayerUid: playerOrder[0],
    turnNumber: 1,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    turnStartedAt: now,
    turnExpiresAt: now + turnTimeout,
    winnerUid: null,
    rankings: [],
    tokens: initialTokens,
    snakePositions: initialSnakePositions,
    snakeLastEvent: null,
    version: 1,
    startedAt: now,
    endedAt: null,
    lastAction: 'GAME_STARTED',
    lastActionAt: now,
    turnMessage: {
      en: 'Game started! Red rolls first.',
      bn: 'খেলা শুরু হয়েছে! লাল খেলোয়াড় প্রথমে চালবেন।',
      type: 'info',
    },
  };

  // 4. Update local cache immediately (0ms)
  localStore.set(roomId, {
    room: roomData,
    players: playersMap,
    game: gameData,
    events: [],
  });
  notifyRoomSubscribers(roomId, roomData);
  notifyPlayersSubscribers(roomId, playersMap);
  notifyGameSubscribers(roomId, gameData);
  broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: roomData, players: playersMap, game: gameData });

  // 5. Background sync
  const writes: Promise<any>[] = [
    setDoc(roomRef, roomData),
    setDoc(doc(db, 'rooms', roomId, 'players', user.uid), p1Player),
    setDoc(doc(db, 'rooms', roomId, 'games', gameId), gameData),
  ];
  for (const bot of selectedBots) {
    writes.push(setDoc(doc(db, 'rooms', roomId, 'players', bot.uid), playersMap[bot.uid]));
  }
  firestoreBackgroundSync(Promise.all(writes));

  return { roomId, roomCode, roomData, playersMap, gameData };
}

/**
 * Joins an existing room using 6-digit code or Room ID
 */
export async function joinRoom(
  codeOrId: string,
  user: UserProfile
): Promise<{ roomId: string; slot: PlayerSlot; roomData?: RoomDocument; player?: RoomPlayer }> {
  const cleanCode = codeOrId.trim();

  // 1. Check local cache first (0ms)
  let foundRoomId: string | null = null;
  let cachedEntry: LocalRoomCache | null = null;

  for (const [rId, cache] of localStore.entries()) {
    if (cache.room.roomCode === cleanCode || rId === cleanCode) {
      foundRoomId = rId;
      cachedEntry = cache;
      break;
    }
  }

  let roomId = foundRoomId || cleanCode;
  let roomDoc: any = null;

  if (!cachedEntry) {
    // 2. Direct document lookup (Instant O(1) by 6-digit room code)
    try {
      const directSnap = await getDoc(doc(db, 'rooms', cleanCode));
      if (directSnap.exists()) {
        roomDoc = directSnap;
        roomId = directSnap.id;
      }
    } catch (e: any) {
      console.warn('Direct room lookup notice:', e?.message || e);
    }

    // 3. Fallback direct lookup with calculated roomId
    if (!roomDoc || !roomDoc.exists()) {
      try {
        const idSnap = await getDoc(doc(db, 'rooms', roomId));
        if (idSnap.exists()) {
          roomDoc = idSnap;
          roomId = idSnap.id;
        }
      } catch (e: any) {}
    }

    // 4. Fallback query by roomCode field
    if (!roomDoc || !roomDoc.exists()) {
      try {
        const q = query(collection(db, 'rooms'), where('roomCode', '==', cleanCode), limit(1));
        const snap = await getDocs(q);
        if (snap && !snap.empty) {
          roomDoc = snap.docs[0];
          roomId = roomDoc.id;
        }
      } catch (e: any) {
        console.warn('Room query lookup notice:', e?.message || e);
      }
    }

    if (!roomDoc || !roomDoc.exists()) {
      throw new Error('errorRoomNotFound');
    }
  }

  const currentRoom: RoomDocument = cachedEntry?.room || (roomDoc?.data() as RoomDocument);
  if (!currentRoom || currentRoom.status === 'ARCHIVED') {
    throw new Error('errorRoomNotFound');
  }

  let existingPlayers: RoomPlayer[] = [];
  if (cachedEntry) {
    existingPlayers = Object.values(cachedEntry.players);
  } else {
    try {
      const playersSnap = await getDocs(collection(db, 'rooms', roomId, 'players'));
      if (playersSnap && !playersSnap.empty) {
        existingPlayers = playersSnap.docs.map((d) => d.data() as RoomPlayer);
      }
    } catch (e: any) {
      console.warn('Players fetch notice:', e?.message || e);
    }
  }

  const existingPlayer = existingPlayers.find((p) => p.uid === user.uid);
  if (existingPlayer) {
    return { roomId, slot: existingPlayer.slot, roomData: currentRoom, player: existingPlayer };
  }

  const activePlayers = existingPlayers.filter((p) => p.status !== 'left');
  if (activePlayers.length >= currentRoom.maxPlayers) {
    throw new Error('errorRoomFull');
  }

  const occupiedSlots = new Set(activePlayers.map((p) => p.slot));
  const availableSlot = ALL_SLOTS.slice(0, currentRoom.maxPlayers).find((slot) => !occupiedSlots.has(slot));

  if (!availableSlot) {
    throw new Error('errorRoomFull');
  }

  const assignedColor = SLOT_COLORS[availableSlot];
  const newPlayer: RoomPlayer = {
    uid: user.uid,
    playerId: `${availableSlot}-${currentRoom.roomCode}`,
    slot: availableSlot,
    displayName: user.displayName || 'Player',
    color: assignedColor,
    avatar: user.avatar || '🎲',
    ready: false,
    connected: true,
    status: 'active',
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    voiceEnabled: false,
  };

  // Instant local update (0ms)
  let cached = localStore.get(roomId);
  if (!cached) {
    cached = { room: currentRoom, players: {}, game: null, events: [] };
    localStore.set(roomId, cached);
  }
  cached.players[user.uid] = newPlayer;
  notifyPlayersSubscribers(roomId, cached.players);
  broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });

  // Immediate Firestore write
  try {
    await Promise.all([
      setDoc(doc(db, 'rooms', roomId, 'players', user.uid), newPlayer),
      updateDoc(doc(db, 'rooms', roomId), { updatedAt: Date.now() }).catch(() => {}),
      updateDoc(doc(db, 'users', user.uid), { activeRoomId: roomId, lastSeenAt: Date.now() }).catch(() => {}),
    ]);
  } catch (err: any) {
    console.warn('Firestore player join write notice:', err?.message || err);
  }

  return { roomId, slot: availableSlot, roomData: currentRoom, player: newPlayer };
}

/**
 * Toggle Ready state (0ms instant)
 */
export async function togglePlayerReady(
  roomId: string,
  uid: string,
  ready: boolean
): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached && cached.players[uid]) {
    cached.players[uid].ready = ready;
    cached.players[uid].lastSeenAt = Date.now();
    notifyPlayersSubscribers(roomId, cached.players);
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });
  }

  firestoreBackgroundSync(
    updateDoc(doc(db, 'rooms', roomId, 'players', uid), { ready, lastSeenAt: Date.now() })
  );
}

/**
 * Starts a new Game inside a Room (0ms instant)
 */
export async function startGame(
  roomId: string,
  adminUid: string
): Promise<{ gameId: string; gameData: GameDocument; roomData: RoomDocument }> {
  const cached = localStore.get(roomId);
  let roomData = cached?.room;

  if (!roomData) {
    const snap = await getDoc(doc(db, 'rooms', roomId)).catch(() => null);
    if (snap?.exists()) roomData = snap.data() as RoomDocument;
  }

  if (!roomData) throw new Error('errorRoomNotFound');
  if (roomData.adminUid !== adminUid) throw new Error('errorNotAdmin');

  let players: RoomPlayer[] = [];
  if (cached && Object.keys(cached.players).length >= 2) {
    players = Object.values(cached.players).filter((p) => p.status === 'active');
  } else {
    const snap = await getDocs(collection(db, 'rooms', roomId, 'players')).catch(() => null);
    if (snap) {
      players = snap.docs.map((d) => d.data() as RoomPlayer).filter((p) => p.status === 'active');
    }
  }

  if (players.length < 2) {
    throw new Error('Minimum 2 players required to start');
  }

  players.sort((a, b) => a.slot.localeCompare(b.slot));
  const playerOrder = players.map((p) => p.uid);

  const gameId = `game_${Date.now()}`;
  const initialTokens = createInitialTokens(playerOrder);
  const turnTimeout = (roomData.settings.turnTimeoutSeconds || 30) * 1000;
  const now = Date.now();

  const initialSnakePositions: Record<string, number> = {};
  playerOrder.forEach((uid) => {
    initialSnakePositions[uid] = 1;
  });

  const gameData: GameDocument = {
    gameId,
    roomId,
    gameMode: roomData.settings.gameMode || 'CLASSIC',
    status: 'AWAITING_ROLL',
    playerOrder,
    currentPlayerUid: playerOrder[0],
    turnNumber: 1,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    turnStartedAt: now,
    turnExpiresAt: now + turnTimeout,
    winnerUid: null,
    rankings: [],
    tokens: initialTokens,
    snakePositions: initialSnakePositions,
    snakeLastEvent: null,
    version: 1,
    startedAt: now,
    endedAt: null,
    lastAction: 'GAME_STARTED',
    lastActionAt: now,
    turnMessage: {
      en: 'Game started! Red player rolls first.',
      bn: 'খেলা শুরু হয়েছে! লাল খেলোয়াড় প্রথমে চালবেন।',
      type: 'info',
    },
  };

  const updatedRoom: RoomDocument = {
    ...roomData,
    currentGameId: gameId,
    status: 'PLAYING',
    updatedAt: now,
  };

  // Instant local update (0ms)
  let c = localStore.get(roomId);
  if (!c) {
    c = { room: updatedRoom, players: {}, game: gameData, events: [] };
    localStore.set(roomId, c);
  } else {
    c.room = updatedRoom;
    c.game = gameData;
  }

  notifyRoomSubscribers(roomId, { ...updatedRoom });
  notifyGameSubscribers(roomId, { ...gameData });
  broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: updatedRoom, game: gameData });
  broadcastLocalUpdate('GAME_UPDATED', roomId, { game: gameData });

  // Direct Firestore sync
  const gameRef = doc(db, 'rooms', roomId, 'games', gameId);
  const roomRef = doc(db, 'rooms', roomId);
  try {
    await Promise.all([
      setDoc(gameRef, gameData),
      updateDoc(roomRef, {
        currentGameId: gameId,
        status: 'PLAYING',
        updatedAt: now,
      }),
    ]);
  } catch (err: any) {
    console.warn('Firestore game start sync notice:', err?.message || err);
  }

  return { gameId, gameData, roomData: updatedRoom };
}

/**
 * Roll Dice (Zero-Latency Local Engine + Fast Broadcast + Async Sync)
 */
export async function rollDice(
  roomId: string,
  gameId: string,
  user: UserProfile,
  expectedVersion: number
): Promise<{ diceValue: number; legalMoves: number[]; updatedGame: GameDocument }> {
  let cached = localStore.get(roomId);
  let game = cached?.game;

  if (!game || game.gameId !== gameId) {
    const snap = await getDoc(doc(db, 'rooms', roomId, 'games', gameId)).catch(() => null);
    if (snap?.exists()) {
      game = snap.data() as GameDocument;
      if (cached) cached.game = game;
    }
  }

  if (!game) throw new Error('Game not found');
  if (game.currentPlayerUid !== user.uid) {
    throw new Error('errorNotYourTurn');
  }

  const room = cached?.room || {
    settings: DEFAULT_SETTINGS,
  } as RoomDocument;

  // Build slotMap and nameMap
  const slotMap: Record<string, PlayerSlot> = {};
  const nameMap: Record<string, string> = {};
  if (cached?.players) {
    Object.values(cached.players).forEach((p) => {
      slotMap[p.uid] = p.slot;
      nameMap[p.uid] = p.displayName;
    });
  }

  const playerSlot = slotMap[user.uid] || 'P1';

  // Compute secure random dice in 0ms
  const diceValue = generateSecureDice();
  const now = Date.now();
  const turnTimeout = (room.settings.turnTimeoutSeconds || 30) * 1000;

  let consecutiveSixes = (game.consecutiveSixes || 0) + (diceValue === 6 ? 1 : - (game.consecutiveSixes || 0));
  if (diceValue !== 6) consecutiveSixes = 0;

  let updatedGame: GameDocument;

  // 1. Mandatory 3-Consecutive Sixes Penalty Rule
  if (consecutiveSixes === 3 && room.settings.strictThreeSixRule) {
    const nextUid = getNextPlayerUid(game.playerOrder, user.uid, game.tokens);
    updatedGame = {
      ...game,
      diceValue: 6,
      diceRolled: false,
      consecutiveSixes: 0,
      currentPlayerUid: nextUid,
      turnNumber: game.turnNumber + 1,
      status: 'AWAITING_ROLL',
      turnStartedAt: now,
      turnExpiresAt: now + turnTimeout,
      version: game.version + 1,
      lastAction: 'THREE_SIX_PENALTY',
      lastActionAt: now,
      turnMessage: {
        en: 'Three 6s in a row! Turn cancelled and passed.',
        bn: 'পরপর ৩ বার ৬! চাল বাতিল এবং পরবর্তী খেলোয়াড়ের পালা।',
        type: 'penalty',
      },
    };

    // Update memory & notify
    if (cached) cached.game = updatedGame;
    notifyGameSubscribers(roomId, updatedGame);
    broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });

    // Background write
    firestoreBackgroundSync(setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame));
    return { diceValue, legalMoves: [], updatedGame };
  }

  // 1.5. Special Snake & Ladder Game Mode Engine
  const isSnakeLadder = room.settings.gameMode === 'SNAKE_LADDER' || game.gameMode === 'SNAKE_LADDER';
  if (isSnakeLadder) {
    const curPos = game.snakePositions?.[user.uid] || 1;
    const newPos = curPos + diceValue;

    if (newPos > 100) {
      // Exceeds 100 - cannot move
      let nextUid = user.uid;
      let msg: {
        en: string;
        bn: string;
        type: 'info' | 'penalty' | 'capture' | 'six' | 'home' | 'win';
      } = {
        en: `Rolled ${diceValue}. Cannot exceed 100! Turn passed.`,
        bn: `${diceValue} পড়েছে। ১০০ অতিক্রম করা যাবে না! চাল পাস হয়েছে।`,
        type: 'penalty',
      };

      if (diceValue === 6) {
        msg = {
          en: `Rolled 6! Cannot exceed 100, but 6 gives you another roll.`,
          bn: `৬ পড়েছে! ১০০ অতিক্রম করা যাবে না, কিন্তু ৬ পাওয়ায় আবার চালুন।`,
          type: 'six',
        };
      } else {
        nextUid = getNextPlayerUid(game.playerOrder, user.uid, game.tokens);
      }

      updatedGame = {
        ...game,
        diceValue,
        diceRolled: false,
        consecutiveSixes: diceValue === 6 ? consecutiveSixes : 0,
        currentPlayerUid: nextUid,
        turnNumber: game.turnNumber + 1,
        status: 'AWAITING_ROLL',
        turnStartedAt: now,
        turnExpiresAt: now + turnTimeout,
        version: game.version + 1,
        lastAction: 'SNAKE_EXCEED_100',
        lastActionAt: now,
        turnMessage: msg,
      };
    } else {
      let finalPos = newPos;
      let eventType: 'LADDER' | 'SNAKE' | 'NORMAL' = 'NORMAL';

      if (LADDERS_MAP[newPos]) {
        finalPos = LADDERS_MAP[newPos];
        eventType = 'LADDER';
      } else if (SNAKES_MAP[newPos]) {
        finalPos = SNAKES_MAP[newPos];
        eventType = 'SNAKE';
      }

      const updatedPositions = {
        ...(game.snakePositions || {}),
        [user.uid]: finalPos,
      };

      const hasWon = finalPos === 100;

      if (hasWon) {
        updatedGame = {
          ...game,
          diceValue,
          diceRolled: true,
          consecutiveSixes: 0,
          status: 'GAME_OVER',
          winnerUid: user.uid,
          rankings: [{ uid: user.uid, rank: 1, finishedAt: now }],
          endedAt: now,
          version: game.version + 1,
          lastAction: 'SNAKE_WIN',
          lastActionAt: now,
          snakePositions: updatedPositions,
          snakeLastEvent: {
            type: eventType,
            from: newPos,
            to: finalPos,
            uid: user.uid,
          },
          turnMessage: {
            en: `🏆 ${nameMap[user.uid] || 'Player'} reached 100 and WON the game!`,
            bn: `🏆 ${nameMap[user.uid] || 'খেলোয়াড়'} ১০০ নম্বরে পৌঁছে বিজয়ী হলেন!`,
            type: 'win',
          },
        };
      } else if (diceValue === 6) {
        updatedGame = {
          ...game,
          diceValue,
          diceRolled: false,
          consecutiveSixes,
          status: 'AWAITING_ROLL',
          turnStartedAt: now,
          turnExpiresAt: now + turnTimeout,
          version: game.version + 1,
          lastAction: 'SNAKE_MOVED_EXTRA_ROLL',
          lastActionAt: now,
          snakePositions: updatedPositions,
          snakeLastEvent: {
            type: eventType,
            from: newPos,
            to: finalPos,
            uid: user.uid,
          },
          turnMessage: {
            en: `Rolled 6! Moved to ${finalPos}. Roll again!`,
            bn: `৬ পড়েছে! ${finalPos} নম্বরে গেলেন। আবার চালুন!`,
            type: 'six',
          },
        };
      } else {
        const nextUid = getNextPlayerUid(game.playerOrder, user.uid, game.tokens);
        updatedGame = {
          ...game,
          diceValue,
          diceRolled: false,
          consecutiveSixes: 0,
          currentPlayerUid: nextUid,
          turnNumber: game.turnNumber + 1,
          status: 'AWAITING_ROLL',
          turnStartedAt: now,
          turnExpiresAt: now + turnTimeout,
          version: game.version + 1,
          lastAction: 'SNAKE_MOVED',
          lastActionAt: now,
          snakePositions: updatedPositions,
          snakeLastEvent: {
            type: eventType,
            from: newPos,
            to: finalPos,
            uid: user.uid,
          },
          turnMessage: {
            en: `${nameMap[user.uid] || 'Player'} rolled ${diceValue} and moved to ${finalPos}.`,
            bn: `${nameMap[user.uid] || 'খেলোয়াড়'} ${diceValue} ফেলে ${finalPos} নম্বরে গেলেন।`,
            type: eventType === 'LADDER' ? 'home' : eventType === 'SNAKE' ? 'penalty' : 'info',
          },
        };
      }
    }

    if (cached) cached.game = updatedGame;
    notifyGameSubscribers(roomId, updatedGame);
    broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });
    firestoreBackgroundSync(setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame));
    return { diceValue, legalMoves: [], updatedGame };
  }

  // 2. Compute Legal Moves
  const legalMoves = getLegalMoves(
    user.uid,
    playerSlot,
    diceValue,
    game.tokens,
    slotMap,
    room.settings
  );

  // If NO legal moves available:
  if (legalMoves.length === 0) {
    if (diceValue === 6) {
      // Extra roll granted
      updatedGame = {
        ...game,
        diceValue,
        diceRolled: false,
        consecutiveSixes,
        status: 'EXTRA_ROLL',
        turnStartedAt: now,
        turnExpiresAt: now + turnTimeout,
        version: game.version + 1,
        lastAction: 'DICE_ROLLED_EXTRA_NO_MOVES',
        lastActionAt: now,
        turnMessage: {
          en: 'Rolled 6 with no movable tokens! Roll again.',
          bn: '৬ পড়েছে কিন্তু চালার মতো ঘুঁটি নেই! আবার চালুন।',
          type: 'six',
        },
      };
    } else {
      // Turn passes to next player
      const nextUid = getNextPlayerUid(game.playerOrder, user.uid, game.tokens);
      updatedGame = {
        ...game,
        diceValue,
        diceRolled: false,
        consecutiveSixes: 0,
        currentPlayerUid: nextUid,
        turnNumber: game.turnNumber + 1,
        status: 'AWAITING_ROLL',
        turnStartedAt: now,
        turnExpiresAt: now + turnTimeout,
        version: game.version + 1,
        lastAction: 'NO_LEGAL_MOVES',
        lastActionAt: now,
        turnMessage: {
          en: `Rolled ${diceValue}. No legal moves available. Turn passed.`,
          bn: `${diceValue} পড়েছে। চাল দেওয়ার ঘুঁটি নেই, চাল পাস হয়েছে।`,
          type: 'info',
        },
      };
    }

    if (cached) cached.game = updatedGame;
    notifyGameSubscribers(roomId, updatedGame);
    broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });
    firestoreBackgroundSync(setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame));
    return { diceValue, legalMoves: [], updatedGame };
  }

  // 3. Legal moves available -> AWAITING_TOKEN_SELECTION
  updatedGame = {
    ...game,
    diceValue,
    diceRolled: true,
    consecutiveSixes,
    status: 'AWAITING_TOKEN_SELECTION',
    turnStartedAt: now,
    turnExpiresAt: now + turnTimeout,
    version: game.version + 1,
    lastAction: 'DICE_ROLLED',
    lastActionAt: now,
    turnMessage: {
      en: `Rolled ${diceValue}. Select a highlighted token to move.`,
      bn: `${diceValue} পড়েছে। চালার জন্য হাইলাইট করা ঘুঁটি নির্বাচন করুন।`,
      type: diceValue === 6 ? 'six' : 'info',
    },
  };

  if (cached) cached.game = updatedGame;
  notifyGameSubscribers(roomId, updatedGame);
  broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });
  firestoreBackgroundSync(setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame));

  return { diceValue, legalMoves, updatedGame };
}

/**
 * Move Token (Zero-Latency Local Engine + Fast Broadcast + Async Sync)
 */
export async function moveToken(
  roomId: string,
  gameId: string,
  user: UserProfile,
  tokenId: number,
  expectedVersion: number
): Promise<{ updatedGame: GameDocument }> {
  let cached = localStore.get(roomId);
  let game = cached?.game;

  if (!game || game.gameId !== gameId) {
    const snap = await getDoc(doc(db, 'rooms', roomId, 'games', gameId)).catch(() => null);
    if (snap?.exists()) {
      game = snap.data() as GameDocument;
      if (cached) cached.game = game;
    }
  }

  if (!game) throw new Error('Game not found');
  if (game.currentPlayerUid !== user.uid) {
    throw new Error('errorNotYourTurn');
  }
  if (!game.diceRolled || game.diceValue === null) {
    throw new Error('Dice not rolled');
  }

  const room = cached?.room || { settings: DEFAULT_SETTINGS, roomCode: '000000' } as RoomDocument;

  const slotMap: Record<string, PlayerSlot> = {};
  const nameMap: Record<string, string> = {};
  if (cached?.players) {
    Object.values(cached.players).forEach((p) => {
      slotMap[p.uid] = p.slot;
      nameMap[p.uid] = p.displayName;
    });
  }

  const playerSlot = slotMap[user.uid] || 'P1';
  const playerTokens = game.tokens[user.uid];
  if (!playerTokens) throw new Error('Tokens not found for player');

  const token = playerTokens[tokenId.toString()] || playerTokens[tokenId];
  if (!token) throw new Error('Token does not exist');

  // Calculate move in 0ms
  const moveCalc = calculateTokenMove(
    token,
    playerSlot,
    user.uid,
    game.diceValue,
    game.tokens,
    slotMap,
    room.settings
  );

  if (!moveCalc.canMove) {
    throw new Error(moveCalc.reason || 'errorInvalidMove');
  }

  const updatedTokens: GameDocument['tokens'] = JSON.parse(JSON.stringify(game.tokens));
  updatedTokens[user.uid][tokenId.toString()] = {
    id: tokenId,
    zone: moveCalc.newZone,
    progress: moveCalc.newProgress,
  };

  const now = Date.now();
  const turnTimeout = (room.settings.turnTimeoutSeconds || 30) * 1000;

  // Handle captures
  let lastCapturedToken: GameDocument['lastCapturedToken'] = null;
  if (moveCalc.capturedTokens.length > 0) {
    for (const cap of moveCalc.capturedTokens) {
      updatedTokens[cap.uid][cap.tokenId.toString()] = {
        id: cap.tokenId,
        zone: 'YARD',
        progress: -1,
      };
      lastCapturedToken = {
        capturedUid: cap.uid,
        tokenId: cap.tokenId,
      };
    }
  }

  // Check win condition
  const tokensToWin = room.settings.tokensToWin || (room.settings.gameMode === 'RUSH' ? 2 : 4);
  const won = hasPlayerWon(user.uid, updatedTokens, tokensToWin);

  let updatedGame: GameDocument;

  if (won) {
    const updatedRankings = [
      ...game.rankings,
      { uid: user.uid, rank: game.rankings.length + 1, finishedAt: now },
    ];

    updatedGame = {
      ...game,
      tokens: updatedTokens,
      winnerUid: user.uid,
      rankings: updatedRankings,
      status: 'GAME_OVER',
      endedAt: now,
      version: game.version + 1,
      lastAction: 'GAME_FINISHED',
      lastActionAt: now,
      turnMessage: {
        en: `${nameMap[user.uid] || 'Player'} won the match! 🎉`,
        bn: `${nameMap[user.uid] || 'খেলোয়াড়'} খেলায় বিজয়ী হয়েছেন! 🎉`,
        type: 'win',
      },
    };

    if (cached) {
      cached.game = updatedGame;
      cached.room.status = 'FINISHED';
      cached.room.lastGameId = gameId;
    }

    notifyGameSubscribers(roomId, updatedGame);
    if (cached) notifyRoomSubscribers(roomId, cached.room);
    broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });

    // History record
    const historyRecord: GameHistoryRecord = {
      gameId,
      roomId,
      roomCode: room.roomCode,
      playedAt: game.startedAt,
      durationSeconds: Math.round((now - game.startedAt) / 1000),
      winnerUid: user.uid,
      winnerName: nameMap[user.uid] || 'Player',
      winnerColor: slotMap[user.uid] ? SLOT_COLORS[slotMap[user.uid]] : 'red',
      gameMode: room.settings.gameMode || 'CLASSIC',
      players: game.playerOrder.map((pUid) => ({
        uid: pUid,
        displayName: nameMap[pUid] || 'Player',
        color: slotMap[pUid] ? SLOT_COLORS[slotMap[pUid]] : 'red',
        tokensHome: countTokensHome(pUid, updatedTokens),
      })),
    };

    firestoreBackgroundSync(
      Promise.all([
        setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame),
        updateDoc(doc(db, 'rooms', roomId), { status: 'FINISHED', lastGameId: gameId, updatedAt: now }).catch(() => {}),
        setDoc(doc(db, 'rooms', roomId, 'history', gameId), historyRecord).catch(() => {}),
      ])
    );

    return { updatedGame };
  }

  // Extra Turn vs Next Player
  if (moveCalc.grantsExtraTurn) {
    updatedGame = {
      ...game,
      tokens: updatedTokens,
      diceValue: null,
      diceRolled: false,
      status: 'AWAITING_ROLL',
      lastCapturedToken,
      turnStartedAt: now,
      turnExpiresAt: now + turnTimeout,
      version: game.version + 1,
      lastAction: 'EXTRA_TURN_GRANTED',
      lastActionAt: now,
      turnMessage: {
        en: moveCalc.capturedTokens.length > 0
          ? 'Captured token! Extra roll granted.'
          : game.diceValue === 6
          ? 'Rolled 6! Extra roll granted.'
          : 'Token reached Home! Extra roll granted.',
        bn: moveCalc.capturedTokens.length > 0
          ? 'ঘুঁটি কেটে অতিরিক্ত চাল পেয়েছেন!'
          : game.diceValue === 6
          ? '৬ ফেলায় অতিরিক্ত চাল পেয়েছেন!'
          : 'ঘুঁটি ঘরে ঢুকে অতিরিক্ত চাল পেয়েছেন!',
        type: moveCalc.capturedTokens.length > 0 ? 'capture' : 'six',
      },
    };
  } else {
    const nextUid = getNextPlayerUid(game.playerOrder, user.uid, updatedTokens, tokensToWin);
    updatedGame = {
      ...game,
      tokens: updatedTokens,
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      currentPlayerUid: nextUid,
      turnNumber: game.turnNumber + 1,
      status: 'AWAITING_ROLL',
      lastCapturedToken,
      turnStartedAt: now,
      turnExpiresAt: now + turnTimeout,
      version: game.version + 1,
      lastAction: 'TURN_PASSED',
      lastActionAt: now,
      turnMessage: {
        en: `Turn passed to ${nameMap[nextUid] || 'next player'}.`,
        bn: `${nameMap[nextUid] || 'পরবর্তী খেলোয়াড়'}-এর চাল।`,
        type: 'info',
      },
    };
  }

  if (cached) cached.game = updatedGame;
  notifyGameSubscribers(roomId, updatedGame);
  broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });
  firestoreBackgroundSync(setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame));

  return { updatedGame };
}

/**
 * Handle Turn Timeout safely in 0ms
 */
export async function handleTurnTimeout(roomId: string, gameId: string): Promise<void> {
  const cached = localStore.get(roomId);
  const game = cached?.game;
  if (!game || game.status === 'GAME_OVER') return;

  const now = Date.now();
  if (now < game.turnExpiresAt) return;

  const room = cached?.room || { settings: DEFAULT_SETTINGS } as RoomDocument;
  const turnTimeout = (room.settings.turnTimeoutSeconds || 30) * 1000;
  const tokensToWin = room.settings.tokensToWin || (room.settings.gameMode === 'RUSH' ? 2 : 4);

  const nextUid = getNextPlayerUid(game.playerOrder, game.currentPlayerUid, game.tokens, tokensToWin);

  const nameMap: Record<string, string> = {};
  if (cached?.players) {
    Object.values(cached.players).forEach((p) => {
      nameMap[p.uid] = p.displayName;
    });
  }

  const updatedGame: GameDocument = {
    ...game,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    currentPlayerUid: nextUid,
    turnNumber: game.turnNumber + 1,
    status: 'AWAITING_ROLL',
    turnStartedAt: now,
    turnExpiresAt: now + turnTimeout,
    version: game.version + 1,
    lastAction: 'TURN_TIMEOUT',
    lastActionAt: now,
    turnMessage: {
      en: 'Turn timed out! Passed to next player.',
      bn: 'সময় শেষ! চাল পরবর্তী খেলোয়াড়কে দেওয়া হয়েছে।',
      type: 'penalty',
    },
  };

  if (cached) cached.game = updatedGame;
  notifyGameSubscribers(roomId, updatedGame);
  broadcastLocalUpdate('GAME_UPDATED', roomId, { game: updatedGame });
  firestoreBackgroundSync(setDoc(doc(db, 'rooms', roomId, 'games', gameId), updatedGame));
}

/**
 * Start Rematch in same Room (0ms)
 */
export async function startRematch(
  roomId: string,
  adminUid: string
): Promise<{ gameId: string; gameData: GameDocument; roomData: RoomDocument }> {
  return await startGame(roomId, adminUid);
}

/**
 * Leave Room (0ms)
 */
export async function leaveRoom(roomId: string, uid: string): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached && cached.players[uid]) {
    cached.players[uid].status = 'left';
    cached.players[uid].connected = false;
    cached.players[uid].ready = false;
    notifyPlayersSubscribers(roomId, cached.players);
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });
  }

  firestoreBackgroundSync(
    Promise.all([
      updateDoc(doc(db, 'rooms', roomId, 'players', uid), {
        status: 'left',
        connected: false,
        ready: false,
        lastSeenAt: Date.now(),
      }).catch(() => {}),
      updateDoc(doc(db, 'users', uid), {
        activeRoomId: null,
        lastSeenAt: Date.now(),
      }).catch(() => {}),
    ])
  );
}

/**
 * Update player customization (displayName, color) in 0ms
 */
export async function updatePlayerConfig(
  roomId: string,
  uid: string,
  updates: { displayName?: string; color?: PlayerColor }
): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached && cached.players[uid]) {
    if (updates.displayName) cached.players[uid].displayName = updates.displayName;
    if (updates.color) cached.players[uid].color = updates.color;
    cached.players[uid].lastSeenAt = Date.now();
    notifyPlayersSubscribers(roomId, cached.players);
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });
  }

  firestoreBackgroundSync(
    updateDoc(doc(db, 'rooms', roomId, 'players', uid), {
      ...updates,
      lastSeenAt: Date.now(),
    })
  );
}

/**
 * Update room settings in 0ms
 */
export async function updateRoomSettings(
  roomId: string,
  settings: Partial<RoomSettings>
): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached) {
    cached.room.settings = { ...cached.room.settings, ...settings };
    cached.room.updatedAt = Date.now();
    notifyRoomSubscribers(roomId, cached.room);
    broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: cached.room });
  }

  firestoreBackgroundSync(
    updateDoc(doc(db, 'rooms', roomId), {
      settings,
      updatedAt: Date.now(),
    })
  );
}

/**
 * Send Reaction (0ms)
 */
export async function sendReaction(
  roomId: string,
  user: UserProfile,
  emoji: string,
  taunt?: { id: string; textBn: string; textEn: string }
): Promise<void> {
  const reactionRef = doc(collection(db, 'rooms', roomId, 'reactions'));
  const reaction: ReactionEvent = {
    id: reactionRef.id,
    uid: user.uid,
    displayName: user.displayName,
    emoji,
    tauntId: taunt?.id,
    tauntTextBn: taunt?.textBn,
    tauntTextEn: taunt?.textEn,
    timestamp: Date.now(),
  };
  firestoreBackgroundSync(setDoc(reactionRef, reaction));
}

/**
 * Manually trigger Firestore network reconnect and re-sync room, players, and game state
 */
export async function reconnectFirestoreAndSync(roomId?: string | null): Promise<{
  success: boolean;
  room?: RoomDocument | null;
  players?: Record<string, RoomPlayer>;
  game?: GameDocument | null;
  error?: string;
}> {
  try {
    // 1. Force enable network in Firestore SDK
    try {
      await enableNetwork(db);
    } catch (netErr) {
      console.debug('enableNetwork notice:', netErr);
    }

    if (!roomId) {
      return { success: true };
    }

    // 2. Fetch fresh room doc from Firestore
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);

    if (!roomSnap.exists()) {
      return { success: false, error: 'Room not found' };
    }

    const roomData = roomSnap.data() as RoomDocument;

    // 3. Fetch players collection
    const playersRef = collection(db, 'rooms', roomId, 'players');
    const playersSnap = await getDocs(playersRef);
    const playersMap: Record<string, RoomPlayer> = {};
    playersSnap.forEach((pDoc) => {
      playersMap[pDoc.id] = pDoc.data() as RoomPlayer;
    });

    // 4. Fetch current game if present
    let gameData: GameDocument | null = null;
    if (roomData.currentGameId) {
      const gameRef = doc(db, 'rooms', roomId, 'games', roomData.currentGameId);
      const gameSnap = await getDoc(gameRef);
      if (gameSnap.exists()) {
        gameData = gameSnap.data() as GameDocument;
      }
    }

    // 5. Update local memory cache and notify all active listeners
    let cached = localStore.get(roomId);
    if (!cached) {
      cached = {
        room: roomData,
        players: playersMap,
        game: gameData,
        events: [],
      };
      localStore.set(roomId, cached);
    } else {
      cached.room = roomData;
      if (Object.keys(playersMap).length > 0) cached.players = playersMap;
      if (gameData) cached.game = gameData;
    }

    notifyRoomSubscribers(roomId, cached.room);
    notifyPlayersSubscribers(roomId, cached.players);
    notifyGameSubscribers(roomId, cached.game);
    broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: cached.room });
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });
    if (cached.game) {
      broadcastLocalUpdate('GAME_UPDATED', roomId, { game: cached.game });
    }

    return {
      success: true,
      room: cached.room,
      players: cached.players,
      game: cached.game,
    };
  } catch (err: any) {
    console.warn('Manual Firestore sync notice:', err);
    const cached = roomId ? localStore.get(roomId) : undefined;
    return {
      success: false,
      room: cached?.room,
      players: cached?.players,
      game: cached?.game,
      error: err?.message || 'Reconnection error',
    };
  }
}

