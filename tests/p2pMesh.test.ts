/**
 * P2P (WebRTC) regression suite.
 *
 * Requirement: Firebase is only a *signalling* channel and the voice/reaction
 * layer must never be able to break gameplay. These tests exercise the mesh
 * with a fake WebRTC stack and the in-memory Firestore double, including the
 * case where WebRTC is missing entirely (older browsers / blocked by policy).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeFirestoreModule, getFakeDb, peekDoc, resetFakeDb } from './helpers/fakeFirestore';

vi.mock('firebase/firestore', () => fakeFirestoreModule());
vi.mock('../src/firebase/config', () => ({
  db: {},
  auth: {},
  app: {},
}));

// ---------------------------------------------------------------------------
// Fake WebRTC stack
// ---------------------------------------------------------------------------

interface FakeChannel {
  label: string;
  readyState: RTCDataChannelState;
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
  failNextSend?: boolean;
}

const channels: FakeChannel[] = [];

function makeChannel(label: string): FakeChannel {
  const channel: FakeChannel = {
    label,
    readyState: 'connecting',
    sent: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    send(data: string) {
      if (this.failNextSend) throw new Error('channel closed');
      this.sent.push(data);
    },
    close() {
      this.readyState = 'closed';
    },
  };
  channels.push(channel);
  return channel;
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescription | null = null;
  localDescription: RTCSessionDescription | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onicecandidate: ((event: { candidate: any }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor(public config: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeChannel {
    return makeChannel(label);
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer' };
  }
  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = (desc as RTCSessionDescription) ?? null;
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc as RTCSessionDescription;
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
}

const webrtcGlobals = {
  RTCPeerConnection: FakeRTCPeerConnection,
  RTCSessionDescription: class {
    constructor(public init: any) {}
    get type() {
      return this.init?.type;
    }
  },
  RTCIceCandidate: class {
    constructor(public init: any) {}
    toJSON() {
      return this.init;
    }
  },
};

async function loadService() {
  vi.resetModules();
  const mod = await import('../src/services/p2pMeshService');
  return mod.p2pMeshService;
}

const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('P2P mesh (WebRTC signalling over Firestore)', () => {
  beforeEach(() => {
    resetFakeDb();
    channels.length = 0;
    FakeRTCPeerConnection.instances.length = 0;
    Object.assign(globalThis as any, webrtcGlobals);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers presence for the local player when the mesh starts', async () => {
    const service = await loadService();
    await service.initRoomMesh('room1', 'uid-a');

    const presence = peekDoc('rooms/room1/p2pPresence/uid-a') as any;
    expect(presence).toBeTruthy();
    expect(presence.uid).toBe('uid-a');
    expect(service.getConnectedPeersCount()).toBe(0);

    service.teardown();
  });

  it('survives a browser without WebRTC support (gameplay must continue)', async () => {
    (globalThis as any).RTCPeerConnection = undefined;
    (globalThis as any).RTCSessionDescription = undefined;

    const service = await loadService();
    await expect(service.initRoomMesh('room2', 'uid-a')).resolves.toBeUndefined();

    // Presence is still published and no peer connection was attempted.
    expect(peekDoc('rooms/room2/p2pPresence/uid-a')).toBeTruthy();
    expect(FakeRTCPeerConnection.instances.length).toBe(0);

    // Broadcasting without any channel is a no-op, never a throw.
    expect(() => service.broadcast('REACTION', { emoji: '🔥' })).not.toThrow();

    // ... and an incoming signal cannot crash the client either.
    await service.initRoomMesh('room2', 'uid-a');
    service.teardown();
  });

  it('offers a connection to a newly discovered peer (lower uid dials)', async () => {
    const service = await loadService();
    await service.initRoomMesh('room3', 'aaa');
    await flush();

    // A peer with a lexicographically greater uid joins: `aaa` must dial.
    const { setDoc, doc } = await import('firebase/firestore');
    await setDoc(doc({} as any, 'rooms/room3/p2pPresence/zzz'), { uid: 'zzz', joinedAt: Date.now() });
    await flush(20);

    const signals = [...getFakeDb().docs.entries()].filter(([path]) =>
      path.startsWith('rooms/room3/p2pSignals/')
    );
    expect(signals.length).toBeGreaterThan(0);
    const offer = signals.map(([, data]) => data as any).find((s) => s.type === 'OFFER');
    expect(offer).toBeTruthy();
    expect(offer.fromUid).toBe('aaa');
    expect(offer.toUid).toBe('zzz');

    service.teardown();
  });

  it('broadcasts over open data channels and ignores a broken channel', async () => {
    const service = await loadService();
    await service.initRoomMesh('room4', 'aaa');
    await flush();

    const { setDoc, doc } = await import('firebase/firestore');
    await setDoc(doc({} as any, 'rooms/room4/p2pPresence/zzz'), { uid: 'zzz', joinedAt: Date.now() });
    await flush(20);

    const channel = channels[0];
    expect(channel).toBeTruthy();
    channel.readyState = 'open';
    channel.onopen?.();

    service.broadcast('REACTION', { emoji: '🎉' });
    expect(channel.sent.length).toBeGreaterThan(0);
    const last = JSON.parse(channel.sent[channel.sent.length - 1]);
    expect(last.type).toBe('REACTION');
    expect(last.senderUid).toBe('aaa');
    expect(last.payload.emoji).toBe('🎉');

    // A channel that throws on send must not break the broadcast loop.
    channel.failNextSend = true;
    expect(() => service.broadcast('PING')).not.toThrow();

    service.teardown();
  });

  it('consumes incoming signals so the collection cannot grow forever', async () => {
    const service = await loadService();
    await service.initRoomMesh('room5', 'aaa');
    await flush();

    const { setDoc, doc } = await import('firebase/firestore');
    const signalId = 'sig-1';
    await setDoc(doc({} as any, 'rooms/room5/p2pSignals', signalId), {
      id: signalId,
      fromUid: 'zzz',
      toUid: 'aaa',
      type: 'OFFER',
      payload: { type: 'offer', sdp: 'remote' },
      createdAt: Date.now(),
    });
    await flush(30);

    expect(peekDoc(`rooms/room5/p2pSignals/${signalId}`)).toBeUndefined();
    // An answer is written back to the caller.
    const answers = [...getFakeDb().docs.values()].filter(
      (d: any) => d.type === 'ANSWER' && d.toUid === 'zzz'
    );
    expect(answers.length).toBe(1);

    service.teardown();
  });

  it('answers an ICE candidate before the remote description arrives without crashing', async () => {
    const service = await loadService();
    await service.initRoomMesh('room6', 'aaa');
    await flush();

    const { setDoc, doc } = await import('firebase/firestore');
    await setDoc(doc({} as any, 'rooms/room6/p2pSignals/cand'), {
      id: 'cand',
      fromUid: 'zzz',
      toUid: 'aaa',
      type: 'ICE_CANDIDATE',
      payload: { candidate: 'candidate:1 1 udp' },
      createdAt: Date.now(),
    });
    await flush(20);

    // Buffered, then deleted - no exception surfaces to the caller.
    expect(peekDoc('rooms/room6/p2pSignals/cand')).toBeUndefined();

    service.teardown();
  });

  it('removes presence on teardown and stops signalling', async () => {
    const service = await loadService();
    await service.initRoomMesh('room7', 'aaa');
    await flush();
    expect(peekDoc('rooms/room7/p2pPresence/aaa')).toBeTruthy();

    service.teardown();
    await flush(20);
    expect(peekDoc('rooms/room7/p2pPresence/aaa')).toBeUndefined();

    const writesBefore = getFakeDb().writes;
    service.broadcast('REACTION', { emoji: '😅' });
    expect(getFakeDb().writes).toBe(writesBefore);
  });

  it('carries chunked "আওয়াজ দাও" voice clips over the real data channel', async () => {
    const service = await loadService();
    await service.initRoomMesh('room9', 'aaa');
    await flush();

    const { setDoc, doc } = await import('firebase/firestore');
    await setDoc(doc({} as any, 'rooms/room9/p2pPresence/zzz'), { uid: 'zzz', joinedAt: Date.now() });
    await flush(20);

    const channel = channels[0];
    channel.readyState = 'open';
    channel.onopen?.();

    const heard: any[] = [];
    service.onMessage((msg) => {
      if (msg.type === 'VOICE_CLIP') heard.push(msg);
    });

    const data = 'y'.repeat(20_000); // ~2.5 frames of 8 KB
    const CHUNK = 8 * 1024;
    const total = Math.ceil(data.length / CHUNK);
    for (let seq = 0; seq < total; seq++) {
      service.broadcast('VOICE_CLIP', {
        clipId: 'clip-42',
        seq,
        total,
        chunk: data.slice(seq * CHUNK, (seq + 1) * CHUNK),
        meta: seq === 0 ? { clipId: 'clip-42', uid: 'aaa', displayName: 'A', mimeType: 'audio/webm', durationMs: 2000, createdAt: Date.now() } : undefined,
      });
    }

    // The channel also carries the latency PING sent when it opened.
    const frames = channel.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'VOICE_CLIP');
    expect(frames.length).toBe(total);
    for (const frame of frames) {
      expect(JSON.stringify(frame).length).toBeLessThan(16 * 1024); // data-channel safe limit
    }

    // Feed the frames back in as if the peer received them.
    frames.forEach((frame) => channel.onmessage?.({ data: JSON.stringify(frame) }));

    expect(heard.length).toBe(total);
    expect(heard[0].payload.seq).toBe(0);
    expect(heard[heard.length - 1].payload.seq).toBe(total - 1);

    service.teardown();
  });

  it('a throwing P2P layer never blocks a reaction from being sent', async () => {
    const service = await loadService();
    await service.initRoomMesh('room8', 'aaa');
    const boom = vi.spyOn(service, 'broadcast').mockImplementation(() => {
      throw new Error('data channel exploded');
    });

    // No `vi.resetModules()` here: gameService must share this exact instance.
    const gameService = await import('../src/services/gameService');
    await expect(
      gameService.sendReaction('room8', { uid: 'aaa', displayName: 'A' } as any, '🔥')
    ).resolves.toBeUndefined();
    await flush(30);

    const reactions = [...getFakeDb().docs.entries()].filter(([path]) =>
      path.startsWith('rooms/room8/reactions/')
    );
    expect(reactions.length).toBe(1);
    const reaction = reactions[0][1] as any;
    expect(reaction.emoji).toBe('🔥');
    expect(reaction.uid).toBe('aaa');
    expect(boom).toHaveBeenCalled();
  });
});
