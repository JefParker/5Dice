// SyncWatch service worker. SyncWatch is served from its own origin
// (syncwatch.5dice.app) so it installs as its own app and never falls inside
// 5 Dice's scope. Only caches named 'syncwatch-…' are ever touched.
// Bump CACHE when SHELL changes.

const CACHE = 'syncwatch-v260925b';
const SHELL = ['./', 'SyncWatch.js', 'SyncWatch-firebase.js', 'SyncWatch.css', 'SyncWatch.json',
    'firebase-config.js', 'img/SyncWatch.ico', 'img/SyncWatch64.png', 'img/SyncWatch128.png',
    'img/SyncWatch192.png'];

// The Firebase SDK and fonts come from these; their urls are versioned or
// immutable, so a cached copy is always right.
const CDN_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', evt => {
    self.skipWaiting();
    evt.waitUntil(caches.open(CACHE).then(cache =>
        // 'reload' skips the HTTP cache, so a new worker never precaches stale files.
        cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', evt => {
    evt.waitUntil(caches.keys()
        .then(keys => Promise.all(keys
            .filter(key => key.startsWith('syncwatch-') && key !== CACHE)
            .map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', evt => {
    const req = evt.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (CDN_HOSTS.includes(url.hostname)) {
        evt.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
            if (res.ok || res.type === 'opaque') {
                const copy = res.clone();
                caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
            }
            return res;
        })));
        return;
    }

    if (url.origin !== location.origin) return;   // Firebase's own traffic, etc.

    // Our files: network first so an update shows up on the next load; the
    // cache is for offline. Pages load as './' whatever their ?id= says.
    const key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req;
    evt.respondWith(fetch(req).then(res => {
        if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(key, copy)).catch(() => {});
        }
        return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }).then(hit => hit || Response.error())));
});

self.addEventListener('notificationclick', evt => {
    evt.notification.close();
    evt.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
        const mine = windows.find(w => w.url.startsWith(self.registration.scope) && 'focus' in w);
        return mine ? mine.focus() : self.clients.openWindow(self.registration.scope);
    }));
});
