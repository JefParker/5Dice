const CACHE_NAME = '5dice-cache-v132';

// Precache the SAME versioned URLs index.html actually requests. Unversioned
// entries used to coexist with runtime-cached ?v= entries, and the offline
// fallback (ignoreSearch) returned whichever was inserted first — the frozen
// install-time copy. Keep these in sync with the ?v= numbers in index.html.
const urlsToCache = [
  './',
  './index.html',
  './styles.css?v=42',
  './skins.css?v=6',
  './skins.js?v=1',
  './app.js?v=53',
  './passkey.js?v=1',
  './voice-chat.js?v=1',
  './five-dice.js?v=38',
  './backgammon.js?v=2',
  './backgammon3d.js?v=12',
  './bg-game.js?v=18',
  './dice3d.js?v=24',
  './firebase-game-backend.js?v=31',
  './firebase-config.js',
  './manifest.json',
  './images/icon-192x192.png',
  './images/icon-512x512.png',
  './images/screenshot-mobile.png',
  './images/screenshot-desktop.png'
];

// Cross-origin libraries the app needs to boot offline (script tags without
// crossorigin produce opaque responses, cached via no-cors requests).
const cdnUrlsToCache = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/cannon.js/0.6.2/cannon.min.js',
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all([
      // cache: 'reload' bypasses the browser HTTP cache, so a CACHE_NAME bump
      // can never repopulate the new cache from stale locally-cached copies.
      cache.addAll(urlsToCache.map(u => new Request(u, { cache: 'reload' }))),
      // Best-effort: CDN failures shouldn't fail the whole install.
      Promise.all(cdnUrlsToCache.map(u =>
        cache.add(new Request(u, { mode: 'no-cors' })).catch(() => {})
      ))
    ]))
  );
});

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        const isBasicOk = networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic';
        // Opaque CDN responses (status 0) are still valid for script tags —
        // cache them so three.js/cannon.js/confetti work offline.
        const isCdnOpaque = networkResponse && networkResponse.type === 'opaque' &&
          CDN_HOSTS.includes(new URL(event.request.url).hostname);
        if (isBasicOk || isCdnOpaque) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache).catch(() => {});
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // Exact match first (correct version); ignoreSearch only as a last
        // resort so a version-bumped URL still gets *something* offline.
        const exact = await caches.match(event.request);
        if (exact) return exact;
        const loose = await caches.match(event.request, { ignoreSearch: true });
        return loose || Response.error();
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('SW deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
