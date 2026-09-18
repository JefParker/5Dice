const CACHE_NAME = '5dice-cache-v160';

// Precache the SAME versioned URLs index.html actually requests. Unversioned
// entries used to coexist with runtime-cached ?v= entries, and the offline
// fallback (ignoreSearch) returned whichever was inserted first — the frozen
// install-time copy. Keep these in sync with the ?v= numbers in index.html.
const urlsToCache = [
  './',
  './index.html',
  './styles.css?v=50',
  './skins.css?v=8',
  './skins.js?v=1',
  './app.js?v=61',
  './passkey.js?v=1',
  './voice-chat.js?v=2',
  './five-dice.js?v=45',
  './backgammon.js?v=2',
  './backgammon3d.js?v=22',
  './bg-game.js?v=23',
  './dice3d.js?v=25',
  './firebase-game-backend.js?v=33',
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
        // An invite link (?join=<roomId>) is a one-shot url — caching each one
        // would pile up a copy of index.html per invite for no benefit.
        const isInvite = new URL(event.request.url).searchParams.has('join');
        if ((isBasicOk || isCdnOpaque) && !isInvite) {
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

// CacheStorage is shared by every service worker on the origin, and the Score
// Sheet (/Score/) runs its own. Deleting "everything that isn't mine" here
// used to wipe Score's precache, and Score's activate wiped this one — so
// visiting the Score Sheet silently broke the main app offline, and vice
// versa. Each worker now only retires its OWN older versions; Score's caches
// are all prefixed 'score-'.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && !cacheName.startsWith('score-')) {
            console.log('SW deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// --- TURN REMINDERS (Web Push) ---
// push-worker/ sends { title, body, url, tag } encrypted for this device once
// an opponent finishes their turn. Always show something: iOS revokes push
// permission after a few pushes that produce no notification, so "skip it if
// the app is on screen" is decided by the SENDER (pushSubs active flag), not
// here. `tag` collapses repeats for the same room into one banner.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* plain text or empty */ }
  const title = data.title || 'Your turn';
  const options = {
    body: data.body || "It's your turn to play.",
    tag: data.tag || 'turn',
    renotify: true,
    icon: './images/icon-192x192.png',
    badge: './images/icon-192x192.png',
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the banner: bring the open app forward if there is one and tell it
// which room the tap was about (app.js joins it if it isn't there already —
// the player may have gone back to the lobby, or be in another room), else
// open a fresh window on the room's join link. The Score Sheet is a window on
// this origin too, but it can't join a game, so it is never the one focused.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.location.href).href;
  const roomId = new URL(target).searchParams.get('join');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const app = clientList.filter(c => 'focus' in c && !new URL(c.url).pathname.includes('/Score/'));
      const existing = app.find(c => c.focused) || app[0];
      if (!existing) return self.clients.openWindow(target);
      if (roomId) existing.postMessage({ type: 'open-room', roomId });
      return existing.focus();
    })
  );
});
