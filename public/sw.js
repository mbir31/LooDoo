// ---------------------------------------------------------------------------
// LooDoo : লুডু - Service Worker
//
// Offline strategy:
//   * navigation requests  -> network first, fall back to the cached app shell
//                             (so a cold start with no connectivity still boots)
//   * same-origin assets   -> stale-while-revalidate (hashed Vite bundles are
//                             immutable, so serving them from cache is safe and
//                             the revalidation picks up new deploys quietly)
//   * fonts (Google Fonts) -> stale-while-revalidate, so Bengali text keeps
//                             rendering offline
//   * everything else      -> passthrough (Firestore / Auth / WebRTC traffic is
//                             never cached; it must never be served stale)
// ---------------------------------------------------------------------------

const VERSION = 'loodoo-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One missing asset must not fail the whole install.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)
        )
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => undefined);
      }
      await self.clients.claim();
    })()
  );
});

// Lets the page activate a new worker immediately after an update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isCacheableAsset(url) {
  return (
    url.origin === self.location.origin &&
    /^.+\.(?:js|mjs|css|woff2?|ttf|png|jpe?g|svg|webp|json|ico)$/i.test(url.pathname)
  );
}

function isFont(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('offline');
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const preload = request.preloadResponse ? await request.preloadResponse : null;
    if (preload) return preload;
    const response = await fetch(request);
    // Only cache real, successful HTML navigations.
    if (response && response.ok && (response.type === 'basic' || response.type === 'default')) {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (err) {
    const fallback =
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      (await cache.match('/index.html', { ignoreSearch: true }));
    if (fallback) return fallback;
    return new Response('<h1>Offline</h1><p>LooDoo is offline. Reconnect to play online matches.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // Real-time traffic must never be intercepted.
  if (url.hostname.includes('googleapis.com') && !isFont(url)) return;
  if (url.hostname.includes('firestore.') || url.hostname.includes('firebaseio.')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isCacheableAsset(url) || isFont(url)) {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME_CACHE).catch(
        () =>
          new Response('', {
            status: 504,
            statusText: 'Offline',
          })
      )
    );
  }
});
