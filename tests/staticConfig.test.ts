import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { extractMatchStats } from '../src/utils/MatchSummaryGenerator';
import { createGameDocument } from '../src/game-engine/reducer';
import { GameDocument, RoomDocument, RoomPlayer, RoomSettings } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('Firestore security rules', () => {
  const rules = read('firestore.rules');

  it('is a rules_version 2 file with a service block', () => {
    expect(rules).toMatch(/rules_version\s*=\s*'2'/);
    expect(rules).toMatch(/service\s+cloud\.firestore\s*\{/);
    expect(rules).toMatch(/match\s+\/databases\/\{database\}\/documents\s*\{/);
  });

  it('no longer grants open read/write to everyone', () => {
    // The previous rules were `allow read, write: if true` - the single most
    // dangerous line in the repository (anyone could rewrite any document).
    expect(rules).not.toMatch(/allow\s+read,\s*write:\s*if\s+true/);
    expect(rules).not.toMatch(/allow\s+write:\s*if\s+true/);
    expect(rules).not.toMatch(/allow\s+read:\s*if\s+true/);
  });

  it('never allows deleting rooms, games or history documents', () => {
    for (const block of ['games/{gameId}', 'history/{gameId}', 'match /rooms/{roomId}']) {
      const start = rules.indexOf(block);
      expect(start, `missing block ${block}`).toBeGreaterThan(-1);
      const slice = rules.slice(start, start + 4000);
      const hasDeleteFalse =
        /allow\s+delete:\s*if\s+false/.test(slice) ||
        /allow\s+update,\s*delete:\s*if\s+false/.test(slice) ||
        /allow\s+delete,\s*update:\s*if\s+false/.test(slice);
      expect(hasDeleteFalse, `${block} must never allow deletes`).toBe(true);
    }
  });

  it('locks user profiles to their owner', () => {
    const users = rules.slice(rules.indexOf('/users/{uid}'));
    expect(users.slice(0, 900)).toMatch(/allow\s+read:\s*if\s+signedIn\(\)\s*&&\s*me\(\)\s*==\s*uid/);
    expect(users.slice(0, 900)).toMatch(/allow\s+create:\s*if\s+signedIn\(\)\s*&&\s*me\(\)\s*==\s*uid/);
    expect(users.slice(0, 900)).toMatch(/allow\s+delete:\s*if\s+false/);
  });

  it('enforces one-version-at-a-time updates on game documents', () => {
    expect(rules).toMatch(/after\.version\s*==\s*before\.version\s*\+\s*1/);
    expect(rules).toMatch(/before\.currentPlayerUid\s*==\s*me\(\)/);
    expect(rules).toMatch(/before\.status\s*==\s*'GAME_OVER'\s*&&\s*after\.status\s*!=\s*'GAME_OVER'/);
  });

  it('only lets room members post reactions and P2P signals', () => {
    const reactions = rules.slice(rules.indexOf('/reactions/{reactionId}'));
    expect(reactions.slice(0, 900)).toMatch(/isRoomMember\(roomId\)/);
    const signals = rules.slice(rules.indexOf('/p2pSignals/{signalId}'));
    expect(signals.slice(0, 900)).toMatch(/fromUid\s*==\s*me\(\)/);
  });
});

describe('PWA installability', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  const indexHtml = read('index.html');

  it('declares the required manifest fields', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBeTruthy();
    expect(manifest.background_color).toBeTruthy();
  });

  it('ships PNG icons in both install sizes plus the vector original', () => {
    const sizes = manifest.icons.map((i: any) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      expect(fs.existsSync(path.join(ROOT, 'public', icon.src.replace(/^\//, '')))).toBe(true);
    }
  });

  it('keeps the duplicated manifest copies in sync', () => {
    expect(read('public/manifest.json')).toBe(read('public/manifest.webmanifest'));
  });

  it('wires iOS Add-to-Home-Screen up with a PNG touch icon', () => {
    expect(indexHtml).toMatch(/<link rel="apple-touch-icon"/);
    expect(indexHtml).toMatch(/apple-mobile-web-app-capable/);
    expect(indexHtml).toMatch(/apple-mobile-web-app-status-bar-style/);
    expect(indexHtml).toMatch(/apple-mobile-web-app-title/);
    expect(fs.existsSync(path.join(ROOT, 'public/apple-touch-icon.png'))).toBe(true);
  });

  it('requests a full-bleed, safe-area aware viewport', () => {
    expect(indexHtml).toMatch(/width=device-width/);
    expect(indexHtml).toMatch(/viewport-fit=cover/);
  });
});

describe('service worker', () => {
  const sw = read('public/sw.js');

  it('precaches the app shell and tolerates a failed asset', () => {
    expect(sw).toMatch(/addEventListener\('install'/);
    expect(sw).toMatch(/\/index\.html/);
    expect(sw).toMatch(/\.catch\(\(\) => undefined\)/);
  });

  it('caches static assets at runtime so hashed bundles work offline', () => {
    // The previous worker precached 4 files and cached nothing else, so an
    // offline cold start rendered a blank screen.
    expect(sw).toMatch(/staleWhileRevalidate/);
    expect(sw).toMatch(/js\|mjs\|css\|woff2\?/);
    expect(sw).toMatch(/cache\.put\(request/);
  });

  it('falls back to the cached shell for navigations', () => {
    expect(sw).toMatch(/request\.mode === 'navigate'/);
    expect(sw).toMatch(/cache\.match\('\/index\.html'\)/);
  });

  it('never intercepts real-time traffic', () => {
    expect(sw).toMatch(/request\.method !== 'GET'/);
    expect(sw).toMatch(/firestore\.|firebaseio\./);
  });

  it('cleans up old caches on activation', () => {
    expect(sw).toMatch(/addEventListener\('activate'/);
    expect(sw).toMatch(/caches\.delete/);
    expect(sw).toMatch(/clients\.claim\(\)/);
  });

  it('is registered only in production builds', () => {
    // Comments describe the old bug, so only look at actual code.
    const main = read('src/main.tsx')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(main).toMatch(/import\.meta\.env\.PROD/);
    // `process` does not exist in the browser bundle.
    expect(main).not.toMatch(/process\.env/);
  });
});

describe('match summary scorecard', () => {
  const settings: RoomSettings = {
    maxPlayers: 2,
    turnTimeoutSeconds: 30,
    strictThreeSixRule: true,
    allowBlockades: true,
    customNamesAllowed: true,
    gameMode: 'CLASSIC',
  };

  function buildGame(stats: GameDocument['stats']): {
    game: GameDocument;
    room: RoomDocument;
    players: Record<string, RoomPlayer>;
  } {
    const base = createGameDocument({
      gameId: 'g1',
      roomId: 'r1',
      playerOrder: ['p1', 'p2'],
      settings,
      now: 0,
    });
    // `tokensHome` is read from the board, so put the winner's tokens home.
    const tokens = { ...base.tokens };
    tokens.p1 = Object.fromEntries(
      Object.entries(tokens.p1).map(([key, t]) => [key, { ...t, zone: 'HOME' as const, progress: 56 }])
    );
    tokens.p2 = Object.fromEntries(
      Object.entries(tokens.p2).map(([key, t], idx) => [
        key,
        { ...t, zone: idx < 2 ? ('HOME' as const) : ('YARD' as const), progress: idx < 2 ? 56 : -1 },
      ])
    );

    const game: GameDocument = {
      ...base,
      tokens,
      status: 'GAME_OVER',
      winnerUid: 'p1',
      endedAt: base.startedAt + 600_000,
      rankings: [{ uid: 'p1', rank: 1, finishedAt: base.startedAt + 600_000 }],
      stats,
    };
    const now = Date.now();
    const room: RoomDocument = {
      roomId: 'r1',
      roomCode: '123456',
      adminUid: 'p1',
      status: 'FINISHED',
      maxPlayers: 2,
      createdAt: now,
      updatedAt: now,
      currentGameId: 'g1',
      lastGameId: 'g1',
      settings,
    };
    const players: Record<string, RoomPlayer> = {
      p1: {
        uid: 'p1',
        playerId: 'P1-123456',
        slot: 'P1',
        displayName: 'Red',
        color: 'red',
        avatar: '🦁',
        ready: true,
        connected: true,
        status: 'active',
        joinedAt: now,
        lastSeenAt: now,
      },
      p2: {
        uid: 'p2',
        playerId: 'P2-123456',
        slot: 'P2',
        displayName: 'Green',
        color: 'green',
        avatar: '🐯',
        ready: true,
        connected: true,
        status: 'active',
        joinedAt: now,
        lastSeenAt: now,
      },
    };
    return { game, room, players };
  }

  it('reports the real counters the engine recorded (never random numbers)', () => {
    const { game, room, players } = buildGame({
      p1: { sixesRolled: 4, capturesMade: 3, tokensHome: 4 },
      p2: { sixesRolled: 1, capturesMade: 0, tokensHome: 2 },
    });

    const first = extractMatchStats({ game, room, players }).playerStats.find((p) => p.uid === 'p1')!;
    const second = extractMatchStats({ game, room, players }).playerStats.find((p) => p.uid === 'p2')!;

    expect(first.sixesRolled).toBe(4);
    expect(first.capturesMade).toBe(3);
    expect(first.tokensHome).toBe(4);
    expect(second.sixesRolled).toBe(1);
    expect(second.capturesMade).toBe(0);
    expect(second.tokensHome).toBe(2);

    // Deterministic: same input, same output (the old code called Math.random).
    expect(extractMatchStats({ game, room, players }).totalSixes).toBe(5);
    expect(extractMatchStats({ game, room, players }).totalCaptures).toBe(3);
  });

  it('falls back to zeroes instead of inventing numbers when stats are missing', () => {
    const { game, room, players } = buildGame(undefined);
    const p1 = extractMatchStats({ game, room, players }).playerStats.find((p) => p.uid === 'p1')!;
    expect(p1.sixesRolled).toBe(0);
    expect(p1.capturesMade).toBe(0);
  });

  it('does not call Math.random anywhere in the scorecard generator', () => {
    expect(read('src/utils/MatchSummaryGenerator.ts')).not.toMatch(/Math\.random/);
  });
});
