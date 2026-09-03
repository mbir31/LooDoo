/**
 * @vitest-environment jsdom
 *
 * UI level regression for the "আওয়াজ দাও" hold-to-talk button: the panel
 * opens, holding the mic records, releasing delivers the clip and the incoming
 * banner appears - with every browser API faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { fakeFirestoreModule, resetFakeDb } from './helpers/fakeFirestore';

const broadcasted: any[] = [];
const meshListeners = new Set<(msg: any) => void>();

vi.mock('firebase/firestore', () => fakeFirestoreModule());
vi.mock('../src/firebase/config', () => ({ db: {}, auth: {}, app: {} }));
vi.mock('../src/services/p2pMeshService', () => ({
  p2pMeshService: {
    broadcast: (type: string, payload: any) => broadcasted.push({ type, payload }),
    onMessage: (cb: (msg: any) => void) => {
      meshListeners.add(cb);
      return () => meshListeners.delete(cb);
    },
    getConnectedPeersCount: () => 0,
  },
}));

class FakeMediaRecorder {
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: any) => void) | null = null;
  onstop: (() => void) | null = null;

  static isTypeSupported() {
    return true;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048).fill(9)], { type: this.mimeType }) });
    setTimeout(() => this.onstop?.(), 0);
  }
}

const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('আওয়াজ দাও button', () => {
  beforeEach(() => {
    resetFakeDb();
    broadcasted.length = 0;
    meshListeners.clear();
    localStorage.clear();
    (globalThis as any).MediaRecorder = FakeMediaRecorder;
    (globalThis as any).Audio = class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play() {
        return Promise.resolve();
      }
      pause() {}
    };
    (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:fake');
    (globalThis as any).URL.revokeObjectURL = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] })) },
    });
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as any).MediaRecorder;
    vi.clearAllMocks();
  });

  it('records while held and plays the clip back when released', async () => {
    const { QuickReactions } = await import('../src/components/game/QuickReactions');
    const user = { uid: 'p1', displayName: 'Red', avatar: '🦁' } as any;

    render(<QuickReactions user={user} />);

    fireEvent.click(screen.getByTitle(/আওয়াজ দাও/));
    const button = await screen.findByTestId('awaz-dao-button');
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('HOLD');

    // Press and hold: the countdown replaces the HOLD label.
    fireEvent.pointerDown(button);
    await waitFor(() => expect(button.textContent).toMatch(/[০-৩]s/), { timeout: 2000 });
    // Hold past the 400ms minimum so the clip is real.
    await flush(500);

    // Release: the clip is delivered (offline -> played back on this device).
    fireEvent.pointerUp(button);
    await waitFor(() => expect(screen.getByText(/আওয়াজ দিলেন/)).toBeTruthy(), { timeout: 2000 });
    expect(button.textContent).toContain('HOLD');
  });

  it('does not send anything for a stray tap (too short)', async () => {
    const { QuickReactions } = await import('../src/components/game/QuickReactions');
    const onOfflineReaction = vi.fn();
    render(<QuickReactions user={{ uid: 'p1', displayName: 'Red' } as any} onOfflineReaction={onOfflineReaction} />);

    fireEvent.click(screen.getByTitle(/আওয়াজ দাও/));
    const button = await screen.findByTestId('awaz-dao-button');

    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);

    await flush(60);
    expect(screen.queryByText(/আওয়াজ দিলেন/)).toBeNull();
  });

  it('disables the mic on browsers without recording support', async () => {
    delete (globalThis as any).MediaRecorder;
    const { QuickReactions } = await import('../src/components/game/QuickReactions');
    render(<QuickReactions user={{ uid: 'p1', displayName: 'Red' } as any} />);

    fireEvent.click(screen.getByTitle(/আওয়াজ দাও/));
    const button = await screen.findByTestId('awaz-dao-button');
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.pointerDown(button);
    await flush(50);
    expect(screen.queryByText(/আওয়াজ দিলেন/)).toBeNull();
  });

  it('still offers emoji reactions after the soundboard was removed', async () => {
    const { QuickReactions } = await import('../src/components/game/QuickReactions');
    const onOfflineReaction = vi.fn();
    render(<QuickReactions user={{ uid: 'p1', displayName: 'Red' } as any} onOfflineReaction={onOfflineReaction} />);

    fireEvent.click(screen.getByTitle(/আওয়াজ দাও/));
    fireEvent.click(await screen.findByText('ইমোজি'));
    fireEvent.click(await screen.findByText('🔥'));
    expect(onOfflineReaction).toHaveBeenCalledWith('🔥');
  });
});
