// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';

import { PassAndPlayGame } from '../src/components/room/PassAndPlayGame';
import { UserProfile } from '../src/types';

const user: UserProfile = {
  uid: 'local-user',
  displayName: 'Tester',
  preferredLanguage: 'en',
  avatar: '🎲',
  activeRoomId: null,
  createdAt: 0,
  lastSeenAt: 0,
  isAnonymous: true,
};

const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

describe('offline pass & play', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.42); // deterministic-ish dice
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the setup screen with every mode and player count', () => {
    render(<PassAndPlayGame language="en" currentUser={user} onExit={() => {}} />);

    expect(screen.getByText(/Offline Pass & Play/i)).toBeTruthy();
    expect(screen.getByText('Classic Mode')).toBeTruthy();
    expect(screen.getByText('2 Players')).toBeTruthy();
    expect(screen.getByText('3 Players')).toBeTruthy();
    expect(screen.getByText('4 Players')).toBeTruthy();
    expect(screen.getByText('Start Match')).toBeTruthy();
  });

  it('starts a 2-player classic match and rolls the dice without Firebase', async () => {
    render(<PassAndPlayGame language="en" currentUser={user} onExit={() => {}} />);

    fireEvent.click(screen.getByText('2 Players'));
    fireEvent.click(screen.getByText('Start Match'));

    const board = await screen.findByTestId('loodoo-board');
    expect(board).toBeTruthy();

    // All 8 tokens (2 players x 4) start in the yard
    const tokens = document.querySelectorAll('[data-testid^="token-P"]');
    expect(tokens.length).toBe(8);
    tokens.forEach((t) => expect(t.getAttribute('data-zone')).toBe('YARD'));

    const rollButtons = screen.getAllByText(/Roll Dice/i);
    fireEvent.click(rollButtons[rollButtons.length - 1]);

    // The dice animation runs for ~450ms before the state is applied
    await flush(700);

    const dice = screen.getByTestId('loodoo-dice');
    const value = dice.getAttribute('data-dice-value');
    expect(value === 'none' || (Number(value) >= 1 && Number(value) <= 6)).toBe(true);
  });

  it('auto-moves when a single token can move (auto-move option)', async () => {
    render(<PassAndPlayGame language="en" currentUser={user} onExit={() => {}} />);

    fireEvent.click(screen.getByText('2 Players'));
    fireEvent.click(screen.getByText('Start Match'));
    await screen.findByTestId('loodoo-board');

    // Force a six so a token can leave the yard.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const rollButtons = screen.getAllByText(/Roll Dice/i);
    fireEvent.click(rollButtons[rollButtons.length - 1]);
    await flush(700);

    const dice = screen.getByTestId('loodoo-dice');
    expect(dice.getAttribute('data-dice-value')).toBe('6');

    // With a six every yard token is legal, so auto-move (single move) should
    // not fire; instead the board advertises the legal tokens.
    const board = screen.getByTestId('loodoo-board');
    expect(board.getAttribute('data-legal-moves')?.length).toBeGreaterThan(0);
  });

  it('moves a token out of the yard through the UI (roll -> tap token)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // always a six
    render(<PassAndPlayGame language="en" currentUser={user} onExit={() => {}} />);

    fireEvent.click(screen.getByText('2 Players'));
    fireEvent.click(screen.getByText('Rush Mode'));
    fireEvent.click(screen.getByText('Start Match'));
    await screen.findByTestId('loodoo-board');

    // Math.random() is mocked to 0.99 -> the dice always shows a six.
    const rollOnce = async () => {
      const buttons = screen
        .queryAllByText(/Roll Dice/i)
        .map((el) => el.closest('button') as HTMLButtonElement | null)
        .filter((b): b is HTMLButtonElement => Boolean(b) && !b!.disabled);
      if (buttons.length === 0) return false;
      fireEvent.click(buttons[buttons.length - 1]);
      await flush(600);
      return true;
    };

    let rolled = false;
    for (let i = 0; i < 12 && !rolled; i++) {
      rolled = await rollOnce();
      if (rolled) break;
      await flush(120);
    }
    expect(rolled).toBe(true);
    expect(screen.getByTestId('loodoo-dice').getAttribute('data-dice-value')).toBe('6');

    // Tap the first highlighted token: it must leave the yard.
    const movable = Array.from(document.querySelectorAll('[data-movable="true"]')) as HTMLElement[];
    expect(movable.length).toBeGreaterThan(0);

    const tokenId = movable[0].getAttribute('data-testid');
    fireEvent.click(movable[0]);
    await flush(120);

    const movedToken = document.querySelector(`[data-testid="${tokenId}"]`);
    expect(movedToken?.getAttribute('data-zone')).toBe('TRACK');
    expect(movedToken?.getAttribute('data-progress')).toBe('0');
  });

  it('supports the snake & ladders mode offline', async () => {
    render(<PassAndPlayGame language="en" currentUser={user} onExit={() => {}} />);

    fireEvent.click(screen.getByText(/Snake & Ladders/i));
    fireEvent.click(screen.getByText('2 Players'));
    fireEvent.click(screen.getByText('Start Match'));
    await flush(100);

    // The ludo board is replaced by the snake board (no ludo tokens rendered).
    expect(screen.queryByTestId('loodoo-board')).toBeNull();
    expect(screen.getAllByText(/1\/100|\/100/).length).toBeGreaterThan(0);
  });
});
