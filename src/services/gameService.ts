/**
 * Room / game transport layer.
 *
 * Architecture (UI -> engine -> validation -> transport):
 *
 *   UI event
 *     -> services/gameService  (loads room + players, builds a GameContext)
 *     -> game-engine/reducer   (pure, authoritative state transition)
 *     -> game-engine/validation (shape + transition guards)
 *     -> local cache + BroadcastChannel + WebRTC DataChannel (instant)
 *     -> Firestore             (durable persistence, guarded by security rules)
 *
 * The service never invents game rules: every state change comes from the
 * shared reducer, so online, offline pass-and-play and the AI bots are
 * guaranteed to follow exactly the same rule set.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  orderBy,
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
  PlayerColor,
  PlayerSlot,
  ReactionEvent,
  GameHistoryRecord,
} from '../types';
import {
  applyRollDice,
  applyTokenMove,
  applyTurnTimeout,
  canMoveToken,
  canRoll,
  createGameDocument,
  GameContext,
  GameRuleError,
  getLegalMovesForCurrentPlayer,
} from '../game-engine/reducer';
import { countTokensHome, getTeamId } from '../game-engine/engine';
import { validateGameDocument, validateTransition } from '../game-engine/validation';
import { p2pMeshService, P2PMessage } from './p2pMeshService';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Cryptographically secure dice value 1..6 (only ever called by the actor). */
export function generateSecureDice(): number {
  const array = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(array);
    return 1 + Math.floor((array[0] / (0xffffffff + 1)) * 6);
  }
  return 1 + Math.floor(Math.random() * 6);
}

/** 6-digit room code, e.g. 482731. */
export function generateRoomCode(): string {
  const bytes = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return (100000 + (bytes[0] % 900000)).toString();
  }
  return Math.floor(100000 + Math.random() * 900000).toString();
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

/** Maximum number of rooms kept in the in-memory cache (prevents unbounded growth). */
const MAX_CACHED_ROOMS = 8;

// ---------------------------------------------------------------------------
// Local-first cache
// ---------------------------------------------------------------------------

export interface LocalRoomCache {
  room: RoomDocument;
  players: Record<string, RoomPlayer>;
  game: GameDocument | null;
  /** Highest version we produced locally but have not yet seen echoed by Firestore. */
  pendingVersion: number | null;
  updatedAt: number;
}

export const localStore = new Map<string, LocalRoomCache>();

function touchCache(roomId: string): void {
  // LRU eviction so a long session cannot leak memory.
  if (localStore.size <= MAX_CACHED_ROOMS) return;
  let oldestId: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [id, entry] of localStore.entries()) {
    if ((entry.updatedAt ?? 0) < oldestAt) {
      oldestAt = entry.updatedAt ?? 0;
      oldestId = id;
    }
  }
  if (oldestId && oldestId !== roomId) {
    disposeRoom(oldestId);
  }
}

/** Drops every cached artefact for a room (listeners, cache entry). */
export function disposeRoom(roomId: string): void {
  localStore.delete(roomId);
  const roomSub = sharedRoomSubs.get(roomId);
  if (roomSub) {
    roomSub.unsubscribeFirestore();
    sharedRoomSubs.delete(roomId);
  }
  const playersSub = sharedPlayersSubs.get(roomId);
  if (playersSub) {
    playersSub.unsubscribeFirestore();
    sharedPlayersSubs.delete(roomId);
  }
  for (const [key, sub] of sharedGameSubs.entries()) {
    if (key.startsWith(`${roomId}::`)) {
      sub.unsubscribeFirestore();
      sharedGameSubs.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Listener registries
// ---------------------------------------------------------------------------

type RoomListener = (room: RoomDocument | null) => void;
type PlayersListener = (players: Record<string, RoomPlayer>) => void;
type GameListener = (game: GameDocument | null) => void;

interface SharedSub {
  listeners: Set<any>;
  unsubscribeFirestore: Unsubscribe;
}

const sharedRoomSubs = new Map<string, SharedSub>();
const sharedPlayersSubs = new Map<string, SharedSub>();
const sharedGameSubs = new Map<string, SharedSub>(); // `${roomId}::${gameId}`

const syncErrorListeners = new Set<(info: { roomId: string; message: string }) => void>();

/** Subscribe to transport failures so the UI can show a "sync issue" hint. */
export function subscribeToSyncErrors(
  callback: (info: { roomId: string; message: string }) => void
): Unsubscribe {
  syncErrorListeners.add(callback);
  return () => {
    syncErrorListeners.delete(callback);
  };
}

function notifySyncError(roomId: string, err: unknown): void {
  const message = (err as Error)?.message || 'Sync failed';
  console.warn('[loodoo] Firestore sync issue:', message);
  syncErrorListeners.forEach((cb) => {
    try {
      cb({ roomId, message });
    } catch (_) {}
  });
}

function emit(listeners: Set<any>, payload: unknown): void {
  listeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error('[loodoo] listener error', err);
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-tab + P2P propagation
// ---------------------------------------------------------------------------

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
          pendingVersion: null,
          updatedAt: Date.now(),
        };
        localStore.set(roomId, cached);
      }
      if (!cached) return;
      if (type === 'ROOM_UPDATED' && data?.room) {
        cached.room = data.room;
        emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...cached.room });
      }
      if (type === 'PLAYERS_UPDATED' && data?.players) {
        cached.players = data.players;
        emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...cached.players });
      }
      if (type === 'GAME_UPDATED' && data?.game) {
        const incoming = data.game as GameDocument;
        if (isNewerGameState(cached.game, incoming)) {
          cached.game = { ...incoming };
          emit(sharedGameSubs.get(`${roomId}::${incoming.gameId}`)?.listeners ?? new Set(), { ...incoming });
        }
      }
    };
  }
} catch (_) {}

function broadcastLocalUpdate(type: string, roomId: string, data: any): void {
  try {
    crossTabChannel?.postMessage({ type, roomId, data });
  } catch (_) {}

  try {
    if (type === 'GAME_UPDATED' && data?.game) {
      p2pMeshService.broadcast('GAME_SYNC', { roomId, game: data.game });
    }
  } catch (_) {}
}

/**
 * Decides whether an incoming remote game document should replace the local one.
 * Local optimistic state is protected while it has not been echoed back yet.
 */
function isNewerGameState(local: GameDocument | null | undefined, incoming: GameDocument): boolean {
  if (!local) return true;
  if (local.gameId !== incoming.gameId) return true;
  const localPending = localStorePendingVersion(incoming.roomId);
  if (localPending !== null && incoming.version < localPending) return false;
  return incoming.version >= local.version;
}

function localStorePendingVersion(roomId: string): number | null {
  return localStore.get(roomId)?.pendingVersion ?? null;
}

// Incoming P2P game sync is validated before it can touch local state.
try {
  p2pMeshService.onMessage((msg: P2PMessage) => {
    if (msg.type !== 'GAME_SYNC' || !msg.payload?.game) return;
    const incomingGame = msg.payload.game as GameDocument;
    const roomId: string | undefined = msg.payload.roomId;
    if (!roomId || !incomingGame) return;

    const cached = localStore.get(roomId);
    if (!cached) return;

    // A peer may only push state for the room we are actually in.
    if (incomingGame.roomId !== roomId) return;
    // The sender must be a known participant of this room.
    if (!Object.values(cached.players).some((p) => p.uid === msg.senderUid)) return;

    const problems = validateGameDocument(incomingGame);
    if (problems.length > 0) {
      console.warn('[loodoo] rejected malformed P2P game state:', problems.join(', '));
      return;
    }

    if (!isNewerGameState(cached.game, incomingGame)) return;

    const transitionProblems = cached.game
      ? validateTransition(cached.game, incomingGame)
      : [];
    if (transitionProblems.length > 0) {
      // Not a single-step transition: treat it as a resync hint, not as a move.
      if (incomingGame.version <= (cached.game?.version ?? 0)) return;
      console.warn('[loodoo] P2P state accepted as resync:', transitionProblems.join(', '));
    }

    cached.game = { ...incomingGame };
    cached.updatedAt = Date.now();
    emit(sharedGameSubs.get(`${roomId}::${incomingGame.gameId}`)?.listeners ?? new Set(), { ...incomingGame });
  });
} catch (_) {}

// ---------------------------------------------------------------------------
// Firestore write helpers
// ---------------------------------------------------------------------------

function firestoreBackgroundSync(roomId: string, promise: Promise<any>): void {
  promise.catch((err) => {
    notifySyncError(roomId, err);
    // Try to recover the authoritative state after a rejected write.
    reconnectFirestoreAndSync(roomId).catch(() => {});
  });
}

/**
 * Persists an authoritative game document.
 * Returns a promise so callers can await durability when they need it.
 */
export function persistGame(roomId: string, game: GameDocument): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached) {
    cached.pendingVersion = Math.max(cached.pendingVersion ?? 0, game.version);
    cached.updatedAt = Date.now();
  }
  const write = setDoc(doc(db, 'rooms', roomId, 'games', game.gameId), game).then(() => {
    const c = localStore.get(roomId);
    if (c && c.pendingVersion !== null && game.version >= c.pendingVersion) {
      c.pendingVersion = null;
    }
  });
  firestoreBackgroundSync(roomId, write);
  return write;
}

// ---------------------------------------------------------------------------
// Subscriptions (one shared Firestore listener per resource, ref-counted)
// ---------------------------------------------------------------------------

function createSharedSub<T>(
  registry: Map<string, SharedSub>,
  key: string,
  attach: (onData: (payload: any) => void) => Unsubscribe
): { subscribe: (cb: T) => Unsubscribe; initial: () => void } {
  let sub = registry.get(key);

  if (!sub) {
    const listeners = new Set<any>();
    const unsubscribeFirestore = attach((payload) => emit(listeners, payload));
    sub = { listeners, unsubscribeFirestore };
    registry.set(key, sub);
  }

  const shared = sub;

  return {
    subscribe(cb: T) {
      shared.listeners.add(cb);
      return () => {
        shared.listeners.delete(cb);
        // Tear the Firestore listener down once nobody is listening.
        if (shared.listeners.size === 0) {
          shared.unsubscribeFirestore();
          registry.delete(key);
        }
      };
    },
    initial() {
      /* no-op hook kept for symmetry */
    },
  };
}

export function subscribeToRoom(
  roomId: string,
  callback: (room: RoomDocument | null) => void
): Unsubscribe {
  const shared = createSharedSub<RoomListener>(sharedRoomSubs, roomId, (onData) =>
    onSnapshot(
      doc(db, 'rooms', roomId),
      (snap) => {
        if (!snap.exists()) {
          onData(null);
          return;
        }
        const data = snap.data() as RoomDocument;
        let c = localStore.get(roomId);
        if (!c) {
          c = { room: { ...data }, players: {}, game: null, pendingVersion: null, updatedAt: Date.now() };
          localStore.set(roomId, c);
        } else {
          c.room = { ...data };
          c.updatedAt = Date.now();
        }
        touchCache(roomId);
        onData({ ...data });
      },
      (err) => notifySyncError(roomId, err)
    )
  );

  const unsubscribe = shared.subscribe(callback);

  const cached = localStore.get(roomId);
  if (cached?.room) callback({ ...cached.room });

  return unsubscribe;
}

export function subscribeToPlayers(
  roomId: string,
  callback: (players: Record<string, RoomPlayer>) => void
): Unsubscribe {
  const shared = createSharedSub<PlayersListener>(sharedPlayersSubs, roomId, (onData) =>
    onSnapshot(
      collection(db, 'rooms', roomId, 'players'),
      (snap) => {
        // A collection snapshot is authoritative and complete: replace, never merge,
        // otherwise players who left would linger forever in the cache.
        const pMap: Record<string, RoomPlayer> = {};
        snap.docs.forEach((d) => {
          pMap[d.id] = d.data() as RoomPlayer;
        });
        let c = localStore.get(roomId);
        if (!c) {
          c = { room: {} as RoomDocument, players: pMap, game: null, pendingVersion: null, updatedAt: Date.now() };
          localStore.set(roomId, c);
        } else {
          c.players = pMap;
          c.updatedAt = Date.now();
        }
        touchCache(roomId);
        onData({ ...pMap });
      },
      (err) => notifySyncError(roomId, err)
    )
  );

  const unsubscribe = shared.subscribe(callback);

  const cached = localStore.get(roomId);
  if (cached?.players && Object.keys(cached.players).length > 0) {
    callback({ ...cached.players });
  }

  return unsubscribe;
}

export function subscribeToGame(
  roomId: string,
  gameId: string,
  callback: (game: GameDocument | null) => void
): Unsubscribe {
  const key = `${roomId}::${gameId}`;
  const shared = createSharedSub<GameListener>(sharedGameSubs, key, (onData) =>
    onSnapshot(
      doc(db, 'rooms', roomId, 'games', gameId),
      (snap) => {
        if (!snap.exists()) {
          onData(null);
          return;
        }
        const data = snap.data() as GameDocument;
        const problems = validateGameDocument(data);
        if (problems.length > 0) {
          console.warn('[loodoo] ignoring invalid remote game document:', problems.join(', '));
          return;
        }
        const c = localStore.get(roomId);
        if (c) {
          if (!isNewerGameState(c.game, data)) return;
          c.game = { ...data };
          c.updatedAt = Date.now();
          if (c.pendingVersion !== null && data.version >= c.pendingVersion) {
            c.pendingVersion = null;
          }
        }
        touchCache(roomId);
        onData({ ...data });
      },
      (err) => notifySyncError(roomId, err)
    )
  );

  const unsubscribe = shared.subscribe(callback);

  const cached = localStore.get(roomId);
  if (cached?.game && cached.game.gameId === gameId) {
    callback({ ...cached.game });
  }

  return unsubscribe;
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

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

  const now = Date.now();
  const roomData: RoomDocument = {
    roomId,
    roomCode,
    adminUid: user.uid,
    status: 'OPEN',
    maxPlayers,
    createdAt: now,
    updatedAt: now,
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
    tokenTheme: (user.tokenSkin || user.tokenTheme) as RoomPlayer['tokenTheme'],
    teamId: getTeamId('P1'),
    ready: true,
    connected: true,
    status: 'active',
    joinedAt: now,
    lastSeenAt: now,
    sixesRolled: 0,
    capturesMade: 0,
  };

  localStore.set(roomId, {
    room: roomData,
    players: { [user.uid]: p1Player },
    game: null,
    pendingVersion: null,
    updatedAt: Date.now(),
  });
  touchCache(roomId);
  emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...roomData });
  emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { [user.uid]: { ...p1Player } });
  broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: roomData, players: { [user.uid]: p1Player } });

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
    notifySyncError(roomId, err);
  }

  return { roomId, roomCode, roomData, p1Player };
}

/**
 * Creates a Solo ("Play Alone") room with automated system bots and starts it
 * instantly. Bot turns are driven by the shared reducer + AI module.
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

  const p1Player: RoomPlayer = {
    uid: user.uid,
    playerId: `P1-${roomCode}`,
    slot: 'P1',
    displayName: user.displayName || 'Player 1',
    color: 'red',
    avatar: user.avatar || '🦁',
    tokenTheme: (user.tokenSkin || user.tokenTheme) as RoomPlayer['tokenTheme'],
    teamId: getTeamId('P1'),
    ready: true,
    connected: true,
    status: 'active',
    joinedAt: now,
    lastSeenAt: now,
    sixesRolled: 0,
    capturesMade: 0,
  };

  const botSlots: { slot: PlayerSlot; color: PlayerColor; name: string; avatar: string; uid: string }[] = [
    { slot: 'P2', color: 'green', name: 'রোবট সবুজ 🤖', avatar: '🤖', uid: `bot_${roomId}_p2` },
    { slot: 'P3', color: 'yellow', name: 'রোবট হলুদ ⚡', avatar: '⚡', uid: `bot_${roomId}_p3` },
    { slot: 'P4', color: 'blue', name: 'রোবট নীল 🎯', avatar: '🎯', uid: `bot_${roomId}_p4` },
  ];

  const selectedBots = botSlots.slice(0, botCount);
  const playersMap: Record<string, RoomPlayer> = { [user.uid]: p1Player };

  for (const bot of selectedBots) {
    playersMap[bot.uid] = {
      uid: bot.uid,
      playerId: `${bot.slot}-${roomCode}`,
      slot: bot.slot,
      displayName: bot.name,
      color: bot.color,
      avatar: bot.avatar,
      teamId: getTeamId(bot.slot),
      ready: true,
      connected: true,
      status: 'active',
      joinedAt: now,
      lastSeenAt: now,
      sixesRolled: 0,
      capturesMade: 0,
    };
  }

  const playerOrder = [user.uid, ...selectedBots.map((b) => b.uid)];
  const gameData = createGameDocument({ gameId, roomId, playerOrder, settings, now });

  localStore.set(roomId, {
    room: roomData,
    players: playersMap,
    game: gameData,
    pendingVersion: null,
    updatedAt: Date.now(),
  });
  touchCache(roomId);
  emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...roomData });
  emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...playersMap });
  emit(sharedGameSubs.get(`${roomId}::${gameId}`)?.listeners ?? new Set(), { ...gameData });
  broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: roomData, players: playersMap, game: gameData });
  broadcastLocalUpdate('GAME_UPDATED', roomId, { game: gameData });

  const writes: Promise<any>[] = [
    setDoc(roomRef, roomData),
    setDoc(doc(db, 'rooms', roomId, 'players', user.uid), p1Player),
    setDoc(doc(db, 'rooms', roomId, 'games', gameId), gameData),
  ];
  for (const bot of selectedBots) {
    writes.push(setDoc(doc(db, 'rooms', roomId, 'players', bot.uid), playersMap[bot.uid]));
  }
  firestoreBackgroundSync(roomId, Promise.all(writes));

  return { roomId, roomCode, roomData, playersMap, gameData };
}

/** Joins an existing room using its 6-digit code or room id. */
export async function joinRoom(
  codeOrId: string,
  user: UserProfile
): Promise<{ roomId: string; slot: PlayerSlot; roomData?: RoomDocument; player?: RoomPlayer }> {
  const cleanCode = codeOrId.trim();
  if (!cleanCode) throw new Error('errorRoomNotFound');

  // 1. Local cache first (0 ms, same device / same tab).
  let foundRoomId: string | null = null;
  let cachedEntry: LocalRoomCache | null = null;

  for (const [rId, cache] of localStore.entries()) {
    if (cache.room?.roomCode === cleanCode || rId === cleanCode) {
      foundRoomId = rId;
      cachedEntry = cache;
      break;
    }
  }

  let roomId = foundRoomId || cleanCode;
  let roomDoc: any = null;

  if (!cachedEntry) {
    try {
      const directSnap = await getDoc(doc(db, 'rooms', cleanCode));
      if (directSnap.exists()) {
        roomDoc = directSnap;
        roomId = directSnap.id;
      }
    } catch (e: any) {
      console.warn('Direct room lookup notice:', e?.message || e);
    }

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

  const currentRoom: RoomDocument =
    cachedEntry?.room || (roomDoc?.data() as RoomDocument);
  if (!currentRoom || currentRoom.status === 'ARCHIVED') {
    throw new Error('errorRoomNotFound');
  }

  let existingPlayers: RoomPlayer[] = [];
  if (cachedEntry) {
    existingPlayers = Object.values(cachedEntry.players || {});
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

  // Rejoining (refresh / reconnect) always succeeds.
  const existingPlayer = existingPlayers.find((p) => p.uid === user.uid);
  if (existingPlayer) {
    return { roomId, slot: existingPlayer.slot, roomData: currentRoom, player: existingPlayer };
  }

  // A match already in progress cannot be joined (it would desync the board).
  if (currentRoom.status === 'PLAYING') {
    throw new Error('errorGameAlreadyStarted');
  }

  const activePlayers = existingPlayers.filter((p) => p.status !== 'left');
  if (activePlayers.length >= (currentRoom.maxPlayers || 4)) {
    throw new Error('errorRoomFull');
  }

  const occupiedSlots = new Set(activePlayers.map((p) => p.slot));
  const availableSlot = ALL_SLOTS.slice(0, currentRoom.maxPlayers || 4).find(
    (slot) => !occupiedSlots.has(slot)
  );

  if (!availableSlot) {
    throw new Error('errorRoomFull');
  }

  const now = Date.now();
  const newPlayer: RoomPlayer = {
    uid: user.uid,
    playerId: `${availableSlot}-${currentRoom.roomCode}`,
    slot: availableSlot,
    displayName: user.displayName || 'Player',
    color: SLOT_COLORS[availableSlot],
    avatar: user.avatar || '🎲',
    tokenTheme: (user.tokenSkin || user.tokenTheme) as RoomPlayer['tokenTheme'],
    teamId: getTeamId(availableSlot),
    ready: false,
    connected: true,
    status: 'active',
    joinedAt: now,
    lastSeenAt: now,
    sixesRolled: 0,
    capturesMade: 0,
  };

  let cached = localStore.get(roomId);
  if (!cached) {
    cached = {
      room: currentRoom,
      players: {},
      game: null,
      pendingVersion: null,
      updatedAt: Date.now(),
    };
    localStore.set(roomId, cached);
  }
  cached.players = { ...cached.players, [user.uid]: newPlayer };
  cached.room = { ...currentRoom };
  cached.updatedAt = Date.now();
  touchCache(roomId);

  emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...cached.players });
  broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });

  try {
    await Promise.all([
      setDoc(doc(db, 'rooms', roomId, 'players', user.uid), newPlayer),
      updateDoc(doc(db, 'rooms', roomId), { updatedAt: Date.now() }).catch(() => {}),
      updateDoc(doc(db, 'users', user.uid), { activeRoomId: roomId, lastSeenAt: Date.now() }).catch(() => {}),
    ]);
  } catch (err: any) {
    notifySyncError(roomId, err);
  }

  return { roomId, slot: availableSlot, roomData: currentRoom, player: newPlayer };
}

/** Toggles the ready flag of a player. */
export async function togglePlayerReady(
  roomId: string,
  uid: string,
  ready: boolean
): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached && cached.players[uid]) {
    cached.players = {
      ...cached.players,
      [uid]: { ...cached.players[uid], ready, lastSeenAt: Date.now() },
    };
    cached.updatedAt = Date.now();
    emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...cached.players });
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });
  }

  firestoreBackgroundSync(
    roomId,
    updateDoc(doc(db, 'rooms', roomId, 'players', uid), { ready, lastSeenAt: Date.now() })
  );
}

/** Starts a new match inside a room (admin only). */
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
  if (cached && Object.keys(cached.players || {}).length >= 2) {
    players = Object.values(cached.players).filter((p) => p.status === 'active');
  } else {
    const snap = await getDocs(collection(db, 'rooms', roomId, 'players')).catch(() => null);
    if (snap) {
      players = snap.docs.map((d) => d.data() as RoomPlayer).filter((p) => p.status === 'active');
    }
  }

  if (players.length < 2) {
    throw new Error('errorMinimumPlayers');
  }

  players.sort((a, b) => a.slot.localeCompare(b.slot));
  const playerOrder = players.map((p) => p.uid);

  const gameId = `game_${Date.now()}`;
  const now = Date.now();
  const gameData = createGameDocument({ gameId, roomId, playerOrder, settings: roomData.settings, now });

  const updatedRoom: RoomDocument = {
    ...roomData,
    currentGameId: gameId,
    status: 'PLAYING',
    updatedAt: now,
  };

  let c = localStore.get(roomId);
  if (!c) {
    c = { room: updatedRoom, players: {}, game: gameData, pendingVersion: null, updatedAt: Date.now() };
    localStore.set(roomId, c);
  } else {
    c.room = updatedRoom;
    c.game = gameData;
    c.pendingVersion = null;
    c.updatedAt = Date.now();
  }
  touchCache(roomId);

  emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...updatedRoom });
  emit(sharedGameSubs.get(`${roomId}::${gameId}`)?.listeners ?? new Set(), { ...gameData });
  broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: { ...updatedRoom }, game: gameData });

  try {
    await Promise.all([
      setDoc(doc(db, 'rooms', roomId, 'games', gameId), gameData),
      updateDoc(doc(db, 'rooms', roomId), {
        currentGameId: gameId,
        status: 'PLAYING',
        updatedAt: now,
      }),
    ]);
  } catch (err: any) {
    notifySyncError(roomId, err);
  }

  return { gameId, gameData, roomData: updatedRoom };
}

// ---------------------------------------------------------------------------
// Authoritative actions
// ---------------------------------------------------------------------------

function buildContext(cached: LocalRoomCache | undefined, now: number): GameContext {
  const settings: RoomSettings = cached?.room?.settings || DEFAULT_SETTINGS;
  const slotMap: Record<string, PlayerSlot> = {};
  const nameMap: Record<string, string> = {};
  for (const p of Object.values(cached?.players || {})) {
    if (!p || p.status === 'left') continue;
    slotMap[p.uid] = p.slot;
    nameMap[p.uid] = p.displayName;
  }
  return { settings, slotMap, nameMap, now };
}

async function loadGame(roomId: string, gameId: string): Promise<GameDocument | null> {
  const cached = localStore.get(roomId);
  if (cached?.game && cached.game.gameId === gameId) return cached.game;

  const snap = await getDoc(doc(db, 'rooms', roomId, 'games', gameId)).catch(() => null);
  if (snap?.exists()) {
    const data = snap.data() as GameDocument;
    const problems = validateGameDocument(data);
    if (problems.length > 0) {
      console.warn('[loodoo] refusing to use invalid remote game:', problems.join(', '));
      return null;
    }
    if (cached) {
      cached.game = data;
      cached.updatedAt = Date.now();
    }
    return data;
  }
  return null;
}

/**
 * Rolls the dice for `user`.
 *
 * `expectedVersion` protects against stale/double submissions: if the caller
 * is acting on a game state that has already moved on, the action is rejected
 * instead of silently overwriting a newer state (last-write-wins bug).
 */
export async function rollDice(
  roomId: string,
  gameId: string,
  user: UserProfile,
  expectedVersion?: number
): Promise<{ diceValue: number; legalMoves: number[]; updatedGame: GameDocument }> {
  const cached = localStore.get(roomId);
  const game = await loadGame(roomId, gameId);
  if (!game) throw new Error('errorGameNotFound');

  if (typeof expectedVersion === 'number' && expectedVersion !== game.version) {
    throw new GameRuleError('errorStaleState');
  }
  if (!canRoll(game, user.uid)) {
    throw new GameRuleError(
      game.currentPlayerUid === user.uid ? 'errorDiceAlreadyRolled' : 'errorNotYourTurn'
    );
  }

  const ctx = buildContext(cached, Date.now());
  const diceValue = generateSecureDice();
  const result = applyRollDice(game, ctx, user.uid, diceValue);
  const updatedGame = result.game;

  commitGameState(roomId, updatedGame);
  return { diceValue, legalMoves: result.legalMoves, updatedGame };
}

/** Moves one of `user`'s tokens using the dice that is currently on the table. */
export async function moveToken(
  roomId: string,
  gameId: string,
  user: UserProfile,
  tokenId: number,
  expectedVersion?: number
): Promise<{ updatedGame: GameDocument }> {
  const cached = localStore.get(roomId);
  const game = await loadGame(roomId, gameId);
  if (!game) throw new Error('errorGameNotFound');

  if (typeof expectedVersion === 'number' && expectedVersion !== game.version) {
    throw new GameRuleError('errorStaleState');
  }
  if (!canMoveToken(game, user.uid, tokenId)) {
    throw new GameRuleError(
      game.currentPlayerUid === user.uid ? 'errorInvalidMove' : 'errorNotYourTurn'
    );
  }

  const ctx = buildContext(cached, Date.now());
  const result = applyTokenMove(game, ctx, user.uid, tokenId);
  const updatedGame = result.game;

  commitGameState(roomId, updatedGame);

  if (updatedGame.status === 'GAME_OVER') {
    finishMatch(roomId, updatedGame);
  }

  return { updatedGame };
}

/**
 * Advances a stalled turn.
 * Only the player who owns the turn (or the room admin) may trigger it, so
 * several clients cannot race to skip the same turn.
 */
export async function handleTurnTimeout(
  roomId: string,
  gameId: string,
  actorUid?: string
): Promise<boolean> {
  const cached = localStore.get(roomId);
  const game = await loadGame(roomId, gameId);
  if (!game || game.status === 'GAME_OVER' || game.winnerUid) return false;

  const now = Date.now();
  if (typeof game.turnExpiresAt === 'number' && now < game.turnExpiresAt) return false;

  if (actorUid) {
    const isAdmin = cached?.room?.adminUid === actorUid;
    const isOwner = game.currentPlayerUid === actorUid;
    if (!isAdmin && !isOwner) return false;
  }

  const ctx = buildContext(cached, now);
  const next = applyTurnTimeout(game, ctx, now);
  if (next === game) return false;

  commitGameState(roomId, next);
  return true;
}

/** Applies an authoritative state to the cache, broadcasts it and persists it. */
export function commitGameState(roomId: string, game: GameDocument): void {
  const cached = localStore.get(roomId);
  if (cached) {
    const problems = validateGameDocument(game);
    if (problems.length > 0) {
      console.error('[loodoo] refusing to commit invalid game state:', problems.join(', '));
      return;
    }
    if (cached.game && cached.game.gameId === game.gameId) {
      const transitionProblems = validateTransition(cached.game, game);
      if (transitionProblems.length > 0) {
        console.warn('[loodoo] suspicious transition ignored:', transitionProblems.join(', '));
        return;
      }
    }
    cached.game = game;
    cached.pendingVersion = Math.max(cached.pendingVersion ?? 0, game.version);
    cached.updatedAt = Date.now();
  }
  touchCache(roomId);

  emit(sharedGameSubs.get(`${roomId}::${game.gameId}`)?.listeners ?? new Set(), { ...game });
  broadcastLocalUpdate('GAME_UPDATED', roomId, { game });
  persistGame(roomId, game);
}

/** Marks the room as finished and stores a match history record. */
function finishMatch(roomId: string, game: GameDocument): void {
  const cached = localStore.get(roomId);
  if (!cached) return;

  cached.room = {
    ...cached.room,
    status: 'FINISHED',
    lastGameId: game.gameId,
    updatedAt: Date.now(),
  };
  emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...cached.room });

  const nameMap: Record<string, string> = {};
  const slotMap: Record<string, PlayerSlot> = {};
  for (const p of Object.values(cached.players)) {
    nameMap[p.uid] = p.displayName;
    slotMap[p.uid] = p.slot;
  }

  const historyRecord: GameHistoryRecord = {
    gameId: game.gameId,
    roomId,
    roomCode: cached.room.roomCode,
    playedAt: game.startedAt,
    durationSeconds: Math.max(0, Math.round((Date.now() - game.startedAt) / 1000)),
    winnerUid: game.winnerUid || '',
    winnerName: nameMap[game.winnerUid || ''] || 'Player',
    winnerColor: game.winnerUid ? SLOT_COLORS[slotMap[game.winnerUid] || 'P1'] : 'red',
    gameMode: cached.room.settings.gameMode || 'CLASSIC',
    sixesRolled: Object.values(game.stats || {}).reduce((sum, s) => sum + s.sixesRolled, 0),
    capturesMade: Object.values(game.stats || {}).reduce((sum, s) => sum + s.capturesMade, 0),
    players: game.playerOrder.map((pUid) => ({
      uid: pUid,
      displayName: nameMap[pUid] || 'Player',
      color: SLOT_COLORS[slotMap[pUid] || 'P1'],
      rank: game.rankings.find((r) => r.uid === pUid)?.rank,
      tokensHome: countTokensHome(pUid, game.tokens),
      sixesRolled: game.stats?.[pUid]?.sixesRolled ?? 0,
      capturesMade: game.stats?.[pUid]?.capturesMade ?? 0,
    })),
  };

  const now = Date.now();
  firestoreBackgroundSync(
    roomId,
    Promise.all([
      updateDoc(doc(db, 'rooms', roomId), {
        status: 'FINISHED',
        lastGameId: game.gameId,
        updatedAt: now,
      }).catch(() => {}),
      setDoc(doc(db, 'rooms', roomId, 'history', game.gameId), historyRecord).catch(() => {}),
    ])
  );
}

/** Starts a rematch in the same room (admin only). */
export async function startRematch(
  roomId: string,
  adminUid: string
): Promise<{ gameId: string; gameData: GameDocument; roomData: RoomDocument }> {
  return startGame(roomId, adminUid);
}

/** Leaves a room. The admin role is handed over when the admin leaves. */
export async function leaveRoom(roomId: string, uid: string): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached && cached.players[uid]) {
    cached.players = {
      ...cached.players,
      [uid]: {
        ...cached.players[uid],
        status: 'left',
        connected: false,
        ready: false,
        lastSeenAt: Date.now(),
      },
    };
    cached.updatedAt = Date.now();
    emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...cached.players });
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });

    // Hand the admin role over so the room never becomes unmanageable.
    let adminUpdate: Promise<any> | null = null;
    if (cached.room?.adminUid === uid) {
      const candidates = Object.values(cached.players)
        .filter((p) => p.status === 'active' && p.uid !== uid)
        .sort((a, b) => a.joinedAt - b.joinedAt);
      if (candidates.length > 0) {
        const nextAdmin = candidates[0];
        cached.room = { ...cached.room, adminUid: nextAdmin.uid, updatedAt: Date.now() };
        emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...cached.room });
        adminUpdate = updateDoc(doc(db, 'rooms', roomId), {
          adminUid: nextAdmin.uid,
          updatedAt: Date.now(),
        }).catch(() => {});
      }
    }

    firestoreBackgroundSync(
      roomId,
      Promise.all([
        updateDoc(doc(db, 'rooms', roomId, 'players', uid), {
          status: 'left',
          connected: false,
          ready: false,
          lastSeenAt: Date.now(),
        }).catch(() => {}),
        updateDoc(doc(db, 'users', uid), { activeRoomId: null, lastSeenAt: Date.now() }).catch(() => {}),
        ...(adminUpdate ? [adminUpdate] : []),
      ])
    );
    return;
  }

  firestoreBackgroundSync(
    roomId,
    Promise.all([
      updateDoc(doc(db, 'rooms', roomId, 'players', uid), {
        status: 'left',
        connected: false,
        ready: false,
        lastSeenAt: Date.now(),
      }).catch(() => {}),
      updateDoc(doc(db, 'users', uid), { activeRoomId: null, lastSeenAt: Date.now() }).catch(() => {}),
    ])
  );
}

/** Updates a player's display name / colour (admin may edit anybody). */
export async function updatePlayerConfig(
  roomId: string,
  uid: string,
  updates: { displayName?: string; color?: PlayerColor }
): Promise<void> {
  const safeUpdates: { displayName?: string; color?: PlayerColor } = {};
  if (typeof updates.displayName === 'string' && updates.displayName.trim().length > 0) {
    safeUpdates.displayName = updates.displayName.trim().slice(0, 24);
  }
  if (updates.color) safeUpdates.color = updates.color;

  const cached = localStore.get(roomId);
  if (cached && cached.players[uid]) {
    cached.players = {
      ...cached.players,
      [uid]: { ...cached.players[uid], ...safeUpdates, lastSeenAt: Date.now() },
    };
    cached.updatedAt = Date.now();
    emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...cached.players });
    broadcastLocalUpdate('PLAYERS_UPDATED', roomId, { players: cached.players });
  }

  firestoreBackgroundSync(
    roomId,
    updateDoc(doc(db, 'rooms', roomId, 'players', uid), {
      ...safeUpdates,
      lastSeenAt: Date.now(),
    })
  );
}

/** Merges room settings instead of replacing the whole settings map. */
export async function updateRoomSettings(
  roomId: string,
  settings: Partial<RoomSettings>
): Promise<void> {
  const cached = localStore.get(roomId);
  if (cached) {
    cached.room = {
      ...cached.room,
      settings: { ...cached.room.settings, ...settings },
      updatedAt: Date.now(),
    };
    cached.updatedAt = Date.now();
    emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...cached.room });
    broadcastLocalUpdate('ROOM_UPDATED', roomId, { room: cached.room });
  }

  const merged = cached?.room?.settings
    ? { ...cached.room.settings, ...settings }
    : { ...DEFAULT_SETTINGS, ...settings };

  firestoreBackgroundSync(
    roomId,
    updateDoc(doc(db, 'rooms', roomId), {
      settings: merged,
      updatedAt: Date.now(),
    })
  );
}

/** Broadcasts a reaction / soundboard clip and keeps the collection small. */
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

  try {
    p2pMeshService.broadcast('REACTION', { roomId, reaction });
  } catch (_) {}

  firestoreBackgroundSync(roomId, setDoc(reactionRef, reaction));

  // Best-effort cleanup so the reactions sub-collection cannot grow forever.
  void pruneReactions(roomId);
}

let lastReactionPrune = 0;
async function pruneReactions(roomId: string): Promise<void> {
  const now = Date.now();
  if (now - lastReactionPrune < 60_000) return;
  lastReactionPrune = now;
  try {
    const snap = await getDocs(
      query(collection(db, 'rooms', roomId, 'reactions'), orderBy('timestamp', 'asc'), limit(25))
    );
    const cutoff = now - 60_000;
    const deletions = snap.docs
      .filter((d) => (d.data()?.timestamp ?? 0) < cutoff)
      .map((d) => deleteDoc(d.ref).catch(() => {}));
    if (deletions.length > 0) await Promise.all(deletions);
  } catch (_) {
    // Cleanup is best-effort only.
  }
}

/** Forces a Firestore reconnect and re-syncs room / players / game state. */
export async function reconnectFirestoreAndSync(roomId?: string | null): Promise<{
  success: boolean;
  room?: RoomDocument | null;
  players?: Record<string, RoomPlayer>;
  game?: GameDocument | null;
  error?: string;
}> {
  try {
    try {
      await enableNetwork(db);
    } catch (netErr) {
      console.debug('enableNetwork notice:', netErr);
    }

    if (!roomId) {
      return { success: true };
    }

    const roomSnap = await getDoc(doc(db, 'rooms', roomId));
    if (!roomSnap.exists()) {
      return { success: false, error: 'Room not found' };
    }

    const roomData = roomSnap.data() as RoomDocument;
    const playersSnap = await getDocs(collection(db, 'rooms', roomId, 'players'));
    const playersMap: Record<string, RoomPlayer> = {};
    playersSnap.forEach((pDoc) => {
      playersMap[pDoc.id] = pDoc.data() as RoomPlayer;
    });

    let gameData: GameDocument | null = null;
    if (roomData.currentGameId) {
      const gameSnap = await getDoc(doc(db, 'rooms', roomId, 'games', roomData.currentGameId));
      if (gameSnap.exists()) {
        const candidate = gameSnap.data() as GameDocument;
        if (validateGameDocument(candidate).length === 0) {
          gameData = candidate;
        }
      }
    }

    let cached = localStore.get(roomId);
    if (!cached) {
      cached = { room: roomData, players: playersMap, game: gameData, pendingVersion: null, updatedAt: Date.now() };
      localStore.set(roomId, cached);
    } else {
      cached.room = roomData;
      if (Object.keys(playersMap).length > 0) cached.players = playersMap;
      // The server is authoritative: only adopt it when it is not older than
      // an optimistic local change we have not finished persisting.
      if (gameData && (!cached.game || gameData.version >= cached.game.version)) {
        cached.game = gameData;
      }
      cached.pendingVersion = null;
      cached.updatedAt = Date.now();
    }
    touchCache(roomId);

    emit(sharedRoomSubs.get(roomId)?.listeners ?? new Set(), { ...cached.room });
    emit(sharedPlayersSubs.get(roomId)?.listeners ?? new Set(), { ...cached.players });
    if (cached.game) {
      emit(sharedGameSubs.get(`${roomId}::${cached.game.gameId}`)?.listeners ?? new Set(), { ...cached.game });
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

/** Helper exposed for the UI: is it my turn to roll? */
export function canCurrentPlayerRoll(game: GameDocument | null, uid: string): boolean {
  return game ? canRoll(game, uid) : false;
}

/** Helper exposed for the UI: which tokens may move right now? */
export function getMovableTokens(
  game: GameDocument | null,
  settings: RoomSettings | undefined,
  slotMap: Record<string, PlayerSlot>
): number[] {
  if (!game || !settings) return [];
  return getLegalMovesForCurrentPlayer(game, { settings, slotMap, now: Date.now() });
}
