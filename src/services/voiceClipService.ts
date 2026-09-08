/**
 * "আওয়াজ দাও" (Awaz Dao) - 3 second voice clips.
 *
 * Press and hold the mic button, say something, release: the recording is sent
 * to everyone in the room and played immediately.
 *
 * Transport strategy (same as reactions):
 *   1. WebRTC data mesh - instant (<100ms), payload never touches the database.
 *   2. Firestore - fallback for peers that are not on the mesh yet. Documents
 *      are deleted as soon as they are consumed and pruned if they go stale,
 *      so nothing is stored long term.
 *
 * Recordings are chunked before they go over a data channel: browsers cap a
 * single data-channel message (16 KB is the safe limit), and 3s of Opus is
 * ~12 KB -> ~16 KB of base64.
 */

import {
  collection,
  doc,
  orderBy,
  limit,
  query,
  where,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { p2pMeshService } from './p2pMeshService';
import { VoiceClip } from '../types';

/** Hold-to-talk limits. */
export const MAX_CLIP_MS = 3000;
export const MIN_CLIP_MS = 400;
/** Rules-side tolerance for the auto-stop overshoot. */
export const MAX_STORED_CLIP_MS = 4000;
export const SEND_COOLDOWN_MS = 4000;
export const MAX_CLIP_BYTES = 24 * 1024;
/** Base64 characters per data-channel frame (8 KB -> well under the 16 KB cap). */
export const CHUNK_CHARS = 8 * 1024;
/** A clip older than this is garbage, not a live message. */
const CLIP_TTL_MS = 60_000;
/** Incomplete chunk sets are dropped after this long. */
const REASSEMBLY_TIMEOUT_MS = 5000;

const MUTE_STORAGE_KEY = 'loodoo_voice_mute_v1';

export type VoiceClipErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'recording-failed'
  | 'too-short'
  | 'too-large'
  | 'cooldown';

export class VoiceClipError extends Error {
  constructor(public code: VoiceClipErrorCode, message?: string) {
    super(message || code);
    this.name = 'VoiceClipError';
  }
}

type RecordedClip = Pick<VoiceClip, 'data' | 'mimeType' | 'durationMs'>;

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

let cachedStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStartedAt = 0;

export function isVoiceClipSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
}

function pickMimeType(): string | undefined {
  if (typeof window.MediaRecorder === 'undefined') return undefined;
  const isTypeSupported = (window.MediaRecorder as any).isTypeSupported;
  if (typeof isTypeSupported !== 'function') return undefined;
  for (const type of PREFERRED_MIME_TYPES) {
    try {
      if (isTypeSupported.call(window.MediaRecorder, type)) return type;
    } catch (_) {
      /* ignore */
    }
  }
  return undefined;
}

async function getMicrophoneStream(): Promise<MediaStream> {
  if (cachedStream && cachedStream.getTracks().some((t) => t.readyState === 'live')) {
    return cachedStream;
  }
  if (!isVoiceClipSupported()) throw new VoiceClipError('unsupported');
  try {
    cachedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    throw new VoiceClipError('permission-denied', (err as Error)?.message);
  }
  return cachedStream;
}

/** Starts recording. Throws VoiceClipError('permission-denied' | 'unsupported'). */
export async function startRecording(): Promise<void> {
  if (!isVoiceClipSupported()) throw new VoiceClipError('unsupported');
  if (recorder && recorder.state !== 'inactive') return;

  const stream = await getMicrophoneStream();
  const mimeType = pickMimeType();

  try {
    recorder = new window.MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 32_000,
    });
  } catch (err) {
    recorder = new window.MediaRecorder(stream);
  }

  recordedChunks = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  recorder.start();
  recordingStartedAt = Date.now();
}

/** Stops recording and resolves with the clip, or null when it was too short. */
export async function stopRecording(): Promise<RecordedClip | null> {
  const active = recorder;
  if (!active || active.state === 'inactive') return null;

  const blob = await new Promise<Blob | null>((resolve) => {
    let settled = false;
    const finish = (value: Blob | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    active.onstop = () => {
      const type = active.mimeType || 'audio/webm';
      const data = new Blob(recordedChunks, { type });
      finish(data.size > 0 ? data : null);
    };
    // Never hang the UI if the recorder misbehaves.
    setTimeout(() => finish(null), 1500);
    try {
      active.stop();
    } catch (_) {
      finish(null);
    }
  });

  recorder = null;
  recordedChunks = [];
  const durationMs = Date.now() - recordingStartedAt;

  if (!blob || durationMs < MIN_CLIP_MS) return null;

  const data = await blobToBase64(blob);
  if (byteLengthOfBase64(data) > MAX_CLIP_BYTES) {
    throw new VoiceClipError('too-large');
  }

  return { data, mimeType: blob.type || 'audio/webm', durationMs: Math.min(durationMs, MAX_STORED_CLIP_MS) };
}

/** Throws away the current recording without sending it. */
export async function cancelRecording(): Promise<void> {
  const active = recorder;
  recorder = null;
  recordedChunks = [];
  if (active && active.state !== 'inactive') {
    try {
      active.stop();
    } catch (_) {
      /* ignore */
    }
  }
}

export function isRecording(): boolean {
  return !!recorder && recorder.state !== 'inactive';
}

/** Releases the microphone. Called when leaving a room. */
export function releaseMicrophone(): void {
  cancelRecording();
  if (cachedStream) {
    cachedStream.getTracks().forEach((track) => track.stop());
    cachedStream = null;
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new VoiceClipError('recording-failed'));
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(new VoiceClipError('recording-failed'));
    }
  });
}

export function byteLengthOfBase64(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'audio/webm' }));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

let lastSentAt = 0;

export function msUntilNextClip(): number {
  return Math.max(0, SEND_COOLDOWN_MS - (Date.now() - lastSentAt));
}

export function sendVoiceClip(
  roomId: string,
  clip: VoiceClip
): Promise<'p2p' | 'firestore' | 'cooldown'> {
  if (msUntilNextClip() > 0) return Promise.resolve('cooldown');
  lastSentAt = Date.now();

  try {
    if (p2pMeshService.getConnectedPeersCount() > 0) {
      broadcastClip(clip);
      return Promise.resolve('p2p');
    }
  } catch (_) {
    // Fall through to the Firestore path.
  }

  return writeClipToFirestore(roomId, clip).then(() => 'firestore' as const);
}

function broadcastClip(clip: VoiceClip): void {
  const total = Math.max(1, Math.ceil(clip.data.length / CHUNK_CHARS));
  const { data, ...meta } = clip;
  for (let seq = 0; seq < total; seq++) {
    p2pMeshService.broadcast('VOICE_CLIP', {
      clipId: clip.clipId,
      seq,
      total,
      chunk: data.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS),
      meta: seq === 0 ? meta : undefined,
    });
  }
}

async function writeClipToFirestore(roomId: string, clip: VoiceClip): Promise<void> {
  const ref = doc(collection(db, 'rooms', roomId, 'voiceClips'), clip.clipId);
  await setDoc(ref, clip);
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

interface PendingClip {
  meta?: Omit<VoiceClip, 'data'>;
  chunks: string[];
  received: number;
  total: number;
  timer: ReturnType<typeof setTimeout>;
}

export function subscribeToVoiceClips(
  roomId: string,
  onClip: (clip: VoiceClip) => void
): () => void {
  const seen = new Set<string>();
  const pending = new Map<string, PendingClip>();

  const deliver = (clip: VoiceClip) => {
    if (!clip?.clipId || seen.has(clip.clipId)) return;
    if (Date.now() - clip.createdAt > CLIP_TTL_MS) return;
    seen.add(clip.clipId);
    if (seen.size > 64) seen.delete(seen.values().next().value as string);
    onClip(clip);
  };

  const unsubP2P = p2pMeshService.onMessage((message) => {
    if (message.type !== 'VOICE_CLIP') return;
    const payload = message.payload as
      | { clipId: string; seq: number; total: number; chunk: string; meta?: Omit<VoiceClip, 'data'> }
      | undefined;
    if (!payload || typeof payload.clipId !== 'string') return;

    const { clipId, seq, total, chunk, meta } = payload;
    if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 0 || total < 1) return;
    if (total > 32 || seq >= total) return;

    let entry = pending.get(clipId);
    if (!entry) {
      entry = {
        chunks: new Array<string>(total),
        received: 0,
        total,
        timer: setTimeout(() => pending.delete(clipId), REASSEMBLY_TIMEOUT_MS),
      };
      pending.set(clipId, entry);
    }
    if (entry.total !== total || entry.chunks[seq] !== undefined) return;

    entry.chunks[seq] = chunk ?? '';
    entry.received += 1;
    if (meta) entry.meta = meta;

    if (entry.received === entry.total) {
      clearTimeout(entry.timer);
      pending.delete(clipId);
      if (!entry.meta) return;
      deliver({ ...entry.meta, data: entry.chunks.join('') });
    }
  });

  const clipsQuery = query(
    collection(db, 'rooms', roomId, 'voiceClips'),
    orderBy('createdAt', 'desc'),
    limit(3)
  );

  const unsubFirestore = onSnapshot(clipsQuery, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const clip = change.doc.data() as VoiceClip;
      deliver(clip);
      // Ephemeral: consume and remove so nothing is retained.
      deleteDoc(change.doc.ref).catch(() => {});
    });
  });

  // Best-effort cleanup of clips nobody consumed (sender closed the tab, ...).
  void pruneStaleClips(roomId);

  return () => {
    unsubP2P();
    unsubFirestore();
    pending.forEach((entry) => clearTimeout(entry.timer));
    pending.clear();
  };
}

async function pruneStaleClips(roomId: string): Promise<void> {
  try {
    const stale = await getDocs(
      query(
        collection(db, 'rooms', roomId, 'voiceClips'),
        where('createdAt', '<', Date.now() - CLIP_TTL_MS)
      )
    );
    await Promise.all(stale.docs.map((d) => deleteDoc(d.ref).catch(() => undefined)));
  } catch (_) {
    // Cleanup is best-effort only.
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

const playbackQueue: Array<{ url: string; clip: VoiceClip }> = [];
const recentlyPlayedClips = new Set<string>();
let currentAudio: HTMLAudioElement | null = null;
let onPlaybackChange: ((clip: VoiceClip | null) => void) | null = null;

export function setPlaybackListener(listener: ((clip: VoiceClip | null) => void) | null): void {
  onPlaybackChange = listener;
}

export function playVoiceClip(clip: VoiceClip): boolean {
  if (!clip?.data || isGlobalMuted() || isPlayerMuted(clip.uid)) return false;

  if (clip.clipId) {
    if (recentlyPlayedClips.has(clip.clipId)) return false;
    recentlyPlayedClips.add(clip.clipId);
    setTimeout(() => recentlyPlayedClips.delete(clip.clipId), 15_000);
  }

  let url: string;
  try {
    url = base64ToBlobUrl(clip.data, clip.mimeType);
  } catch (_) {
    return false;
  }

  playbackQueue.push({ url, clip });
  // Never let a spam of clips build a backlog.
  while (playbackQueue.length > 3) {
    const dropped = playbackQueue.shift();
    if (dropped) URL.revokeObjectURL(dropped.url);
  }
  pumpPlayback();
  return true;
}

function pumpPlayback(): void {
  if (currentAudio) return;
  const next = playbackQueue.shift();
  if (!next) {
    onPlaybackChange?.(null);
    return;
  }

  try {
    const audio = new Audio(next.url);
    currentAudio = audio;
    onPlaybackChange?.(next.clip);
    const finish = () => {
      URL.revokeObjectURL(next.url);
      currentAudio = null;
      pumpPlayback();
    };
    audio.onended = finish;
    audio.onerror = finish;
    void audio.play().catch(finish);
  } catch (_) {
    URL.revokeObjectURL(next.url);
    currentAudio = null;
    pumpPlayback();
  }
}

// ---------------------------------------------------------------------------
// Muting (per player + global)
// ---------------------------------------------------------------------------

interface MuteState {
  global: boolean;
  players: Record<string, boolean>;
}

const muteListeners = new Set<() => void>();

function readMuteState(): MuteState {
  try {
    const raw = localStorage.getItem(MUTE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MuteState;
      return { global: !!parsed?.global, players: parsed?.players || {} };
    }
  } catch (_) {
    /* ignore */
  }
  return { global: false, players: {} };
}

let muteState: MuteState = readMuteState();

function writeMuteState(): void {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify(muteState));
  } catch (_) {
    /* ignore */
  }
  muteListeners.forEach((cb) => {
    try {
      cb();
    } catch (_) {
      /* ignore */
    }
  });
}

export function isGlobalMuted(): boolean {
  return muteState.global;
}

export function setGlobalMuted(muted: boolean): void {
  muteState = { ...muteState, global: muted };
  writeMuteState();
  if (muted && currentAudio) {
    try {
      currentAudio.pause();
    } catch (_) {
      /* ignore */
    }
  }
}

export function isPlayerMuted(uid: string): boolean {
  return !!muteState.players[uid];
}

export function setPlayerMuted(uid: string, muted: boolean): void {
  const players = { ...muteState.players };
  if (muted) players[uid] = true;
  else delete players[uid];
  muteState = { ...muteState, players };
  writeMuteState();
  if (muted && currentAudio && playbackQueue.length === 0) {
    try {
      currentAudio.pause();
    } catch (_) {
      /* ignore */
    }
  }
}

export function onMuteChange(callback: () => void): () => void {
  muteListeners.add(callback);
  return () => muteListeners.delete(callback);
}
