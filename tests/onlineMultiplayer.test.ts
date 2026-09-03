// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetFakeDb, getFakeDb, peekDoc, fakeFirestoreModule } from './helpers/fakeFirestore';
import { UserProfile, GameDocument, RoomDocument, RoomPlayer } from '../src/types';

vi.mock('firebase/firestore', () => fakeFirestoreModule());
vi.mock('../src/firebase/config', () => ({
  db: { __fake: true },
  auth: { currentUser: null },
  googleProvider: {},
  default: {},
}));

interface Client {
  service: typeof import('../src/services/gameService');
  user: UserProfile;
  roomId: string | null;
  game: GameDocument | null;
  room: RoomDocument | null;
  players: Record<string, RoomPlayer>;
  unsubs: Array<() => void>;
}

let clientSeq = 0;

const flush = async (ms = 0) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Creates an isolated "browser" instance: a fresh copy of the service module
 * (fresh local cache) talking to the shared fake Firestore.
 */
async function createClient(name: string): Promise<Client> {
  vi.resetModules();
  const service = await import('../src/services/gameService');
  const user: UserProfile = {
    uid: `uid_${name}_${++clientSeq}`,
    displayName: name,
    preferredLanguage: 'en',
    avatar: '🎲',
    activeRoomId: null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    isAnonymous: true,
  };

  const client: Client = {
    service,
    user,
    roomId: null,
    game: null,
    room: null,
    players: {},
    unsubs: [],
  };
  return client;
}

/** Subscribes a client to a room exactly like App.tsx does. */
async function joinRoomAs(client: Client, roomId: string): Promise<void> {
  client.roomId = roomId;
  let gameUnsub: (() => void) | null = null;
  let watchedGameId: string | null = null;

  const watchGame = (gameId: string | null) => {
    if (gameId === watchedGameId) return;
    watchedGameId = gameId;
    if (gameUnsub) gameUnsub();
    gameUnsub = null;
    if (!gameId) return;
    gameUnsub = client.service.subscribeToGame(roomId, gameId, (game) => {
      if (game) client.game = game;
    });
    client.unsubs.push(gameUnsub);
  };

  client.unsubs.push(
    client.service.subscribeToRoom(roomId, (room) => {
      if (room) {
        client.room = room;
        watchGame(room.currentGameId);
      }
    })
  );
  client.unsubs.push(
    client.service.subscribeToPlayers(roomId, (players) => {
      if (players && Object.keys(players).length > 0) client.players = players;
    })
  );
  await flush(5);
  watchGame(client.room?.currentGameId ?? null);
  await flush(5);
}

function cleanupClient(client: Client): void {
  client.unsubs.forEach((u) => u());
  client.unsubs = [];
}

describe('online multiplayer (2/3/4 players)', () => {
  beforeEach(() => {
    resetFakeDb();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('creates a room, lets 3 players join and starts a synchronised match', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 4, { gameMode: 'CLASSIC' });
    expect(created.roomCode).toMatch(/^\d{6}$/);

    const players: Client[] = [host];
    for (const name of ['Green', 'Yellow']) {
      const c = await createClient(name);
      const joined = await c.service.joinRoom(created.roomCode, c.user);
      expect(joined.roomId).toBe(created.roomId);
      await joinRoomAs(c, joined.roomId);
      players.push(c);
    }
    await joinRoomAs(host, created.roomId);

    // The host sees every player
    expect(Object.keys(host.players).length).toBe(3);
    expect(Object.values(host.players).map((p) => p.slot).sort()).toEqual(['P1', 'P2', 'P3']);

    // Starting the match is admin-only
    await expect(host.service.startGame(created.roomId, players[1].user.uid)).rejects.toThrow(
      'errorNotAdmin'
    );

    const started = await host.service.startGame(created.roomId, host.user.uid);
    expect(started.gameData.playerOrder).toHaveLength(3);
    expect(started.gameData.currentPlayerUid).toBe(host.user.uid);

    // Everyone receives the game document through the room subscription
    await flush(20);

    for (const c of players) {
      expect(c.game?.gameId).toBe(started.gameId);
      expect(c.game?.playerOrder).toHaveLength(3);
    }
  });

  it('rejects joining a room that is already playing', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 4);

    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);

    await host.service.startGame(created.roomId, host.user.uid);

    const latecomer = await createClient('Late');
    await expect(latecomer.service.joinRoom(created.roomCode, latecomer.user)).rejects.toThrow(
      'errorGameAlreadyStarted'
    );
  });

  it('synchronises dice rolls and token moves between two clients', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);

    const guest = await createClient('Guest');
    const joined = await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, joined.roomId);
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(20);

    // Only the player on turn may roll
    await expect(
      guest.service.rollDice(created.roomId, started.gameId, guest.user, host.game!.version)
    ).rejects.toBeTruthy();

    // Force a six so the host can leave the yard.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const cryptoMock = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(((arr: any) => {
        arr[0] = 4294960000; // -> dice 6
        return arr;
      }) as any);

    const rolled = await host.service.rollDice(
      created.roomId,
      started.gameId,
      host.user,
      host.game!.version
    );
    expect(rolled.diceValue).toBe(6);
    expect(rolled.legalMoves).toEqual([0, 1, 2, 3]);

    await flush(10);
    // The guest sees the dice and whose turn it is
    expect(guest.game?.diceValue).toBe(6);
    expect(guest.game?.status).toBe('AWAITING_TOKEN_SELECTION');
    expect(guest.game?.currentPlayerUid).toBe(host.user.uid);

    // The guest may not move the host's token
    await expect(
      guest.service.moveToken(created.roomId, started.gameId, guest.user, 0, guest.game!.version)
    ).rejects.toBeTruthy();

    const moved = await host.service.moveToken(
      created.roomId,
      started.gameId,
      host.user,
      0,
      host.game!.version
    );
    expect(moved.updatedGame.tokens[host.user.uid]['0']).toEqual({
      id: 0,
      zone: 'TRACK',
      progress: 0,
    });

    await flush(10);
    expect(guest.game?.tokens[host.user.uid]['0'].zone).toBe('TRACK');
    // Six grants an extra roll: still the host's turn
    expect(guest.game?.currentPlayerUid).toBe(host.user.uid);

    spy.mockRestore();
    cryptoMock.mockRestore();
  });

  it('rejects stale actions (double tap / outdated client state)', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(10);

    const roll = await host.service.rollDice(
      created.roomId,
      started.gameId,
      host.user,
      host.game!.version
    );
    // Replaying the same (now outdated) version must be refused.
    await expect(
      host.service.rollDice(created.roomId, started.gameId, host.user, host.game!.version - 1)
    ).rejects.toMatchObject({ code: 'errorStaleState' });

    if (roll.legalMoves.length > 0) {
      const staleVersion = host.game!.version;
      await host.service.moveToken(created.roomId, started.gameId, host.user, roll.legalMoves[0], staleVersion);
      await expect(
        host.service.moveToken(created.roomId, started.gameId, host.user, roll.legalMoves[0], staleVersion)
      ).rejects.toMatchObject({ code: 'errorStaleState' });
    }
  });

  it('synchronises a capture to every client and records the statistic', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(10);

    // Place the host token one step away from the guest token (P2 progress 44 == global 5)
    const game = host.game!;
    game.tokens[host.user.uid]['0'] = { id: 0, zone: 'TRACK', progress: 4 };
    game.tokens[guest.user.uid]['0'] = { id: 0, zone: 'TRACK', progress: 44 };
    host.service.commitGameState(created.roomId, { ...game, version: game.version + 1 });
    await flush(10);

    const diceMock = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: any) => {
      arr[0] = 715827882; // ~1/6 -> dice 2
      return arr;
    }) as any);

    const roll = await host.service.rollDice(created.roomId, started.gameId, host.user, host.game!.version);
    const move = await host.service.moveToken(
      created.roomId,
      started.gameId,
      host.user,
      0,
      host.game!.version
    );
    expect(move.updatedGame.tokens[guest.user.uid]['0'].zone).toBe('YARD');
    expect(move.updatedGame.stats?.[host.user.uid].capturesMade).toBe(1);

    await flush(10);
    expect(guest.game?.tokens[guest.user.uid]['0'].zone).toBe('YARD');
    expect(guest.game?.lastCapturedToken).toEqual({ capturedUid: guest.user.uid, tokenId: 0 });

    diceMock.mockRestore();
    void roll;
  });

  it('only lets the turn owner or the admin advance a stalled turn', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 3);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(10);

    // Not expired yet -> no-op
    expect(
      await host.service.handleTurnTimeout(created.roomId, started.gameId, host.user.uid)
    ).toBe(false);

    // Force the turn to be expired
    host.service.commitGameState(created.roomId, {
      ...host.game!,
      turnExpiresAt: Date.now() - 1000,
      version: host.game!.version + 1,
    });
    await flush(5);

    // A bystander cannot skip somebody else's turn
    expect(
      await guest.service.handleTurnTimeout(created.roomId, started.gameId, guest.user.uid)
    ).toBe(false);

    // The admin can
    expect(
      await host.service.handleTurnTimeout(created.roomId, started.gameId, host.user.uid)
    ).toBe(true);
    expect(host.game?.currentPlayerUid).not.toBe(host.user.uid);

    await flush(10);
    expect(guest.game?.currentPlayerUid).toBe(host.game?.currentPlayerUid);
  });

  it('supports rematch: a new game document replaces the finished one', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    const first = await host.service.startGame(created.roomId, host.user.uid);
    await flush(10);

    const rematch = await host.service.startRematch(created.roomId, host.user.uid);
    expect(rematch.gameId).not.toBe(first.gameId);
    expect(rematch.roomData.status).toBe('PLAYING');

    await flush(10);
    const hostGame = peekDoc(`rooms/${created.roomId}/games/${rematch.gameId}`) as GameDocument;
    expect(hostGame.version).toBe(1);
    expect(hostGame.status).toBe('AWAITING_ROLL');
    expect(hostGame.playerOrder).toHaveLength(2);

    const roomDoc = peekDoc(`rooms/${created.roomId}`) as RoomDocument;
    expect(roomDoc.currentGameId).toBe(rematch.gameId);
  });

  it('hands the admin role over when the admin leaves', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    await host.service.leaveRoom(created.roomId, host.user.uid);
    await flush(20);

    const roomDoc = peekDoc(`rooms/${created.roomId}`) as RoomDocument;
    expect(roomDoc.adminUid).toBe(guest.user.uid);

    const playerDoc = peekDoc(`rooms/${created.roomId}/players/${host.user.uid}`) as RoomPlayer;
    expect(playerDoc.status).toBe('left');
  });

  it('recovers the authoritative state after a reconnect', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(10);
    await host.service.rollDice(created.roomId, started.gameId, host.user, host.game!.version);
    await flush(10);

    // Simulate a client that lost its local cache (page refresh)
    const refreshed = await createClient('HostAgain');
    const resync = await refreshed.service.reconnectFirestoreAndSync(created.roomId);
    expect(resync.success).toBe(true);
    expect(resync.game?.gameId).toBe(started.gameId);
    expect(resync.game?.version).toBe(host.game?.version);
  });

  it('plays a complete 4-player online match with every client in sync', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 4, { gameMode: 'CLASSIC' });

    const clients: Client[] = [host];
    for (const name of ['P2', 'P3', 'P4']) {
      const c = await createClient(name);
      const joined = await c.service.joinRoom(created.roomCode, c.user);
      await joinRoomAs(c, joined.roomId);
      clients.push(c);
    }
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(20);

    const byUid = new Map<string, Client>();
    clients.forEach((c) => byUid.set(c.user.uid, c));

    let actions = 0;
    let guard = 0;

    while (guard++ < 5000) {
      const leader = host.game;
      if (!leader || leader.status === 'GAME_OVER') break;

      const actor = byUid.get(leader.currentPlayerUid);
      if (!actor) throw new Error('unknown player on turn');

      const version = leader.version;
      const roll = await actor.service.rollDice(
        created.roomId,
        started.gameId,
        actor.user,
        version
      );
      actions += 1;

      if (roll.legalMoves.length > 0 && roll.updatedGame.status === 'AWAITING_TOKEN_SELECTION') {
        const tokenId = roll.legalMoves[Math.floor(Math.random() * roll.legalMoves.length)];
        await actor.service.moveToken(
          created.roomId,
          started.gameId,
          actor.user,
          tokenId,
          roll.updatedGame.version
        );
        actions += 1;
      }

      await flush(1);

      // Every client must converge on the same authoritative document.
      for (const c of clients) {
        expect(c.game?.version).toBe(host.game?.version);
        expect(c.game?.currentPlayerUid).toBe(host.game?.currentPlayerUid);
        expect(JSON.stringify(c.game?.tokens)).toBe(JSON.stringify(host.game?.tokens));
      }
    }

    expect(host.game?.status).toBe('GAME_OVER');
    expect(host.game?.winnerUid).toBeTruthy();
    expect(host.game?.rankings.length).toBe(1);
    expect(host.game?.stats?.[host.game!.winnerUid!].tokensHome).toBe(4);
    expect(actions).toBeGreaterThan(20);

    // The room is marked finished and a history record exists.
    await flush(20);
    const roomDoc = peekDoc(`rooms/${created.roomId}`) as RoomDocument;
    expect(roomDoc.status).toBe('FINISHED');
    expect(peekDoc(`rooms/${created.roomId}/history/${started.gameId}`)).toBeTruthy();
  });

  it('never writes a malformed game document', async () => {
    const host = await createClient('Host');
    const created = await host.service.createRoom(host.user, 2);
    const guest = await createClient('Guest');
    await guest.service.joinRoom(created.roomCode, guest.user);
    await joinRoomAs(guest, created.roomId);
    await joinRoomAs(host, created.roomId);

    const started = await host.service.startGame(created.roomId, host.user.uid);
    await flush(10);

    const valid = host.game!;
    const before = JSON.stringify(valid);

    // Tampered: a token teleported home and the version jumped backwards.
    host.service.commitGameState(created.roomId, {
      ...valid,
      version: valid.version + 5,
      tokens: {
        ...valid.tokens,
        [host.user.uid]: {
          ...valid.tokens[host.user.uid],
          '0': { id: 0, zone: 'HOME', progress: 56 },
        },
      },
    });

    await flush(10);
    // The invalid transition is refused: the local state is untouched.
    expect(JSON.stringify(host.game)).toBe(before);
    expect(host.game?.tokens[host.user.uid]['0'].zone).toBe('YARD');
  });
});
