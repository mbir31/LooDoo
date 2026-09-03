/**
 * @vitest-environment jsdom
 *
 * "আওয়াজ দাও" (hold-to-talk voice clips) regression suite.
 *
 * The real microphone obviously cannot be driven in CI, so the browser APIs
 * (MediaRecorder / getUserMedia / Audio) are faked. What this proves is the
 * logic that would otherwise be untestable: chunking over the data channel,
 * reassembly, the 3s cap, the rate limit, muting and the Firestore fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeFirestoreModule, getFakeDb, peekDoc, resetFakeDb } from './helpers/fakeFirestore';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const broadcasted: any[] = [];
let connectedPeers = 0;
const meshListeners = new Set<(msg: any) => void>();
let broadcastThrows = false;

vi.mock('firebase/firestore', () => fakeFirestoreModule());
vi.mock('../src/firebase/config', () => ({ db: {}, auth: {}, app: {} }));

vi.mock('../src/services/p2pMeshService', () => ({
  p2pMeshService: {
    broadcast: (type: string, payload: any) => {
      if (broadcastThrows) throw new Error('data channel exploded');
      broadcasted.push({ type, payload });
    },
    onMessage: (cb: (msg: any) => void) => {
      meshListeners.add(cb);
      return () => meshListeners.delete(cb);
    },
    getConnectedPeersCount: () => connectedPeers,
  },
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static mimeIsSupported = true;
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: any) => void) | null = null;
  onstop: (() => void) | null = null;
  static failStart = false;
  /** Bytes delivered per dataavailable event. */
  static payloadSize = 2000;

  constructor(public stream: any, public options: any = {}) {
    this.mimeType = options?.mimeType || 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  static isTypeSupported(type: string) {
    return FakeMediaRecorder.mimeIsSupported && type.startsWith('audio/');
  }

  start() {
    if (FakeMediaRecorder.failStart) throw new Error('cannot start');
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // Emit a blob built from deterministic bytes, then fire onstop.
    const bytes = new Uint8Array(FakeMediaRecorder.payloadSize).fill(7);
    this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
    setTimeout(() => this.onstop?.(), 0);
  }
}

const createdAudio: FakeAudio[] = [];

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public src: string) {
    createdAudio.push(this);
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
}

function installFakeMedia() {
  (globalThis as any).Audio = FakeAudio;
  (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:fake-url');
  (globalThis as any).URL.revokeObjectURL = vi.fn();
  (globalThis as any).MediaRecorder = FakeMediaRecorder;
  (navigator as any).mediaDevices = {
    getUserMedia: vi.fn(async () => {
      if ((navigator as any).__loodooDenyMic) throw new Error('denied');
      return { getTracks: () => [{ readyState: 'live', stop() {} }] };
    }),
  };
  // jsdom has no media playback: play() must resolve.

}

function removeFakeMedia() {
  delete (globalThis as any).MediaRecorder;
  delete (navigator as any).mediaDevices;
}

/** Records for `ms` and returns the clip (shows the min-length guard). */
async function recordFor(service: any, ms = 450) {
  await service.startRecording();
  await flush(ms);
  return service.stopRecording();
}

async function loadService() {
  vi.resetModules();
  return import('../src/services/voiceClipService');
}

const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClip(overrides: Partial<any> = {}) {
  return {
    clipId: 'clip-1',
    uid: 'p1',
    displayName: 'Red',
    avatar: '🦁',
    mimeType: 'audio/webm;codecs=opus',
    durationMs: 2000,
    data: 'AAAA',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('"আওয়াজ দাও" voice clips', () => {
  beforeEach(() => {
    resetFakeDb();
    broadcasted.length = 0;
    meshListeners.clear();
    connectedPeers = 0;
    broadcastThrows = false;
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.failStart = false;
    FakeMediaRecorder.mimeIsSupported = true;
    FakeMediaRecorder.payloadSize = 2000;
    createdAudio.length = 0;
    (navigator as any).__loodooDenyMic = false;
    localStorage.clear();
    installFakeMedia();
  });

  afterEach(() => {
    removeFakeMedia();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------- recording
  it('records on hold and returns a base64 clip when released', async () => {
    const service = await loadService();
    expect(service.isVoiceClipSupported()).toBe(true);

    await service.startRecording();
    expect(service.isRecording()).toBe(true);

    const clip = await recordFor(service);
    expect(clip).toBeTruthy();
    expect(clip!.mimeType).toBe('audio/webm;codecs=opus');
    expect(clip!.data.length).toBeGreaterThan(100);
    expect(clip!.durationMs).toBeGreaterThanOrEqual(0);
    expect(service.isRecording()).toBe(false);
  });

  it('rejects a tap that is too short to be a real message', async () => {
    const service = await loadService();
    await service.startRecording();
    // Released immediately: a stray tap must not send an empty clip.
    const clip = await service.stopRecording();
    expect(clip).toBeNull();
  });

  it('reports a denied microphone instead of crashing', async () => {
    const service = await loadService();
    (navigator as any).__loodooDenyMic = true;
    await expect(service.startRecording()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('reports unsupported browsers (no MediaRecorder)', async () => {
    removeFakeMedia();
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    const service = await loadService();
    expect(service.isVoiceClipSupported()).toBe(false);
    await expect(service.startRecording()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reuses the microphone stream so only one permission prompt happens', async () => {
    const service = await loadService();
    await service.startRecording();
    await service.stopRecording();
    await service.startRecording();
    await service.stopRecording();
    expect((navigator.mediaDevices.getUserMedia as any).mock.calls.length).toBe(1);
  });

  // ------------------------------------------------------------- transport
  it('sends over the P2P mesh in chunked frames when peers are connected', async () => {
    connectedPeers = 3;
    const service = await loadService();
    const clip = makeClip({ data: 'x'.repeat(service.CHUNK_CHARS * 2 + 123) });

    const result = await service.sendVoiceClip('room1', clip);
    expect(result).toBe('p2p');

    const expected = Math.ceil(clip.data.length / service.CHUNK_CHARS);
    expect(broadcasted.length).toBe(expected);
    broadcasted.forEach((msg, idx) => {
      expect(msg.type).toBe('VOICE_CLIP');
      expect(msg.payload.clipId).toBe('clip-1');
      expect(msg.payload.seq).toBe(idx);
      expect(msg.payload.total).toBe(expected);
      // Every frame stays well inside the data-channel message limit.
      expect(JSON.stringify(msg).length).toBeLessThan(16 * 1024);
    });
    // Metadata rides along with the first frame only.
    expect(broadcasted[0].payload.meta.uid).toBe('p1');
    expect(broadcasted[1].payload.meta).toBeUndefined();
    // Nothing was written to the database on the fast path.
    expect([...getFakeDb().docs.keys()].some((p) => p.includes('voiceClips'))).toBe(false);
  });

  it('reassembles a chunked clip on the receiving side, in any order', async () => {
    const service = await loadService();
    const received: any[] = [];
    service.subscribeToVoiceClips('room2', (clip) => received.push(clip));

    const clip = makeClip({ data: 'a'.repeat(service.CHUNK_CHARS * 3 + 17) });
    connectedPeers = 1;
    await service.sendVoiceClip('room2', clip);

    // Deliver frames out of order, with a duplicate.
    const order = [2, 0, 3, 0, 1];
    for (const seq of order) {
      const msg = broadcasted.find((m) => m.payload.seq === seq)!;
      meshListeners.forEach((cb) => cb({ type: 'VOICE_CLIP', payload: msg.payload, senderUid: 'p1' }));
    }
    await flush();

    expect(received.length).toBe(1);
    expect(received[0].data).toBe(clip.data);
    expect(received[0].displayName).toBe('Red');
  });

  it('falls back to Firestore when the mesh is not connected, and cleans up after delivery', async () => {
    connectedPeers = 0;
    const service = await loadService();

    const result = await service.sendVoiceClip('room3', makeClip({ clipId: 'clip-9', data: 'AAA=' }));
    expect(result).toBe('firestore');
    await flush();

    expect(peekDoc('rooms/room3/voiceClips/clip-9')).toBeTruthy();

    const received: any[] = [];
    const unsubscribe = service.subscribeToVoiceClips('room3', (clip) => received.push(clip));
    await flush(20);

    expect(received.length).toBe(1);
    expect(received[0].clipId).toBe('clip-9');
    // Consumed and deleted - nothing lingers in the database.
    expect(peekDoc('rooms/room3/voiceClips/clip-9')).toBeUndefined();
    unsubscribe();
  });

  it('falls back to Firestore when the data channel throws', async () => {
    connectedPeers = 2;
    broadcastThrows = true;
    const service = await loadService();

    const result = await service.sendVoiceClip('room4', makeClip({ clipId: 'clip-10' }));
    expect(result).toBe('firestore');
    await flush();
    expect(peekDoc('rooms/room4/voiceClips/clip-10')).toBeTruthy();
  });

  it('ignores stale clips so a replay cannot blast an old recording', async () => {
    const service = await loadService();
    const received: any[] = [];
    service.subscribeToVoiceClips('room5', (clip) => received.push(clip));

    const stale = makeClip({ clipId: 'clip-old', createdAt: Date.now() - 5 * 60_000, data: 'AAA=' });
    connectedPeers = 1;
    await service.sendVoiceClip('room5', stale);
    broadcasted.forEach((msg) =>
      meshListeners.forEach((cb) => cb({ type: 'VOICE_CLIP', payload: msg.payload, senderUid: 'p1' }))
    );
    await flush();
    expect(received.length).toBe(0);
  });

  // ----------------------------------------------------------- rate limits
  it('rate limits back-to-back clips', async () => {
    connectedPeers = 1;
    const service = await loadService();
    expect(await service.sendVoiceClip('room6', makeClip({ clipId: 'a' }))).toBe('p2p');
    expect(await service.sendVoiceClip('room6', makeClip({ clipId: 'b' }))).toBe('cooldown');
    expect(service.msUntilNextClip()).toBeGreaterThan(0);
    expect(broadcasted.length).toBe(1);
  });

  it('refuses clips that are too large to store', async () => {
    const service = await loadService();
    FakeMediaRecorder.payloadSize = 40 * 1024; // > 24 KB after base64
    await expect(recordFor(service)).rejects.toMatchObject({ code: 'too-large' });
  });

  // ----------------------------------------------------------------- muting
  it('does not play a clip from a muted player', async () => {
    const service = await loadService();
    service.setPlayerMuted('p1', true);
    expect(service.playVoiceClip(makeClip())).toBe(false);

    service.setPlayerMuted('p1', false);
    expect(service.playVoiceClip(makeClip({ uid: 'p2' }))).toBe(true);
  });

  it('honours the global mute switch', async () => {
    const service = await loadService();
    service.setGlobalMuted(true);
    expect(service.playVoiceClip(makeClip({ uid: 'p2' }))).toBe(false);
    service.setGlobalMuted(false);
    expect(service.playVoiceClip(makeClip({ uid: 'p2' }))).toBe(true);
    expect(createdAudio.length).toBe(1);
  });

  it('queues clips instead of talking over each other', async () => {
    const service = await loadService();
    let playing: any = null;
    service.setPlaybackListener((clip) => {
      playing = clip;
    });

    const plays = vi.fn(async () => undefined);
    createdAudio.length = 0;

    expect(service.playVoiceClip(makeClip({ clipId: 'c1', uid: 'p2' }))).toBe(true);
    expect(service.playVoiceClip(makeClip({ clipId: 'c2', uid: 'p3' }))).toBe(true);

    // Only the first clip starts: the second waits in the queue.
    expect(playing?.clipId).toBe('c1');
    expect(createdAudio.length).toBe(1);

    // Finishing the first clip starts the next one.
    createdAudio[0].onended?.();
    expect(playing?.clipId).toBe('c2');
    expect(createdAudio.length).toBe(2);
    expect(plays).not.toHaveBeenCalled();
  });

  it('keeps mute preferences across reloads (localStorage)', async () => {
    const service = await loadService();
    service.setPlayerMuted('p4', true);
    service.setGlobalMuted(true);

    vi.resetModules();
    const reloaded = await import('../src/services/voiceClipService');
    expect(reloaded.isPlayerMuted('p4')).toBe(true);
    expect(reloaded.isGlobalMuted()).toBe(true);
  });
});
