
 // 'score-' prefix: CacheStorage is shared with the root app's service worker,
 // and each worker only ever deletes its OWN older caches (see activate).
 const staticCache = 'score-static-v260917';
 const dynamicCache = 'score-dynamic-v260917';
 // Precache the SAME versioned URLs the page actually requests. When you bump a
 // ?v= number in index.html, bump it here too and bump the cache version
 // strings above. The ../ entries are ROOT-owned files: their ?v= must match
 // the root index.html / sw.js (push.sh checks), and they are served
 // network-first below so a root bump can never be shadowed by this cache.
 const assets = ['./', 'index.html',
    'Score.js?v=24', 'firebase-backend.js?v=14', 'Score.css?v=10',
    'forms.css', 'Score.json', '../dice3d.js?v=25',
    '../skins.css?v=8', '../skins.js?v=1',
    '../firebase-config.js',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400&display=swap',
    'fallback.html'];

// Cross-origin libraries needed to boot offline (opaque responses via no-cors).
const cdnAssets = [
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/cannon.js/0.6.2/cannon.min.js',
    'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js'];

// Keep the runtime cache from growing without bound.
const DYNAMIC_CACHE_MAX_ENTRIES = 60;
const trimCache = async (name, maxEntries) => {
    try {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.length > maxEntries) {
            await cache.delete(keys[0]);
            await trimCache(name, maxEntries);
        }
    } catch (e) { /* best-effort */ }
};

self.addEventListener('install', evt => {
        // Activate a freshly-installed SW immediately instead of waiting for every
        // controlled tab to close.
        self.skipWaiting();
        evt.waitUntil(caches.open(staticCache).then(cache => {
            console.log('Caching shell assets');
            return Promise.all([
                // cache: 'reload' bypasses the browser HTTP cache so a version
                // bump can't be satisfied by a stale local copy.
                cache.addAll(assets.map(u => new Request(u, { cache: 'reload' }))),
                Promise.all(cdnAssets.map(u =>
                    cache.add(new Request(u, { mode: 'no-cors' })).catch(() => {})))
            ]);
        })
    );
});

self.addEventListener('activate', evt => {
    evt.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(keys
                // Only retire our own older versions. The root app's cache
                // ('5dice-cache-…') lives in the same CacheStorage and must
                // survive a visit here.
                .filter(key => key.startsWith('score-') && key !== staticCache && key !== dynamicCache)
                .map(key => caches.delete(key))
            )
        }).then(() => self.clients.claim())
    );
});

// Root-owned files (../skins.css, ../dice3d.js, …) are versioned by the ROOT
// index.html, which this worker never sees. Cache-first would keep serving
// whatever copy was installed here until this file's bytes changed, so those
// go network-first: fresh when online, cached copy offline.
const scopePath = new URL(self.registration.scope).pathname;
function isRootOwned(url) {
    const u = new URL(url);
    return u.origin === self.location.origin && !u.pathname.startsWith(scopePath);
}

self.addEventListener('fetch', evt => {
    // Only handle GET requests. cache.put() throws on POST/PUT and would break
    // Firebase and other non-GET traffic.
    if (evt.request.method !== 'GET') return;

    // The Cache API only supports http/https. Requests with other schemes —
    // notably chrome-extension:// injected by browser extensions, plus data:,
    // blob:, etc. — throw "Request scheme is unsupported" on cache.put(). Ignore
    // them entirely and let the browser handle them normally.
    if (!/^https?:$/.test(new URL(evt.request.url).protocol)) return;

    // Navigations (the app shell) go network-first: cache-first meant a deploy
    // only reached existing installs when the SW file itself byte-changed.
    // Versioned assets stay cache-first — their URLs change on deploy.
    if (evt.request.mode === 'navigate') {
        evt.respondWith(
            fetch(evt.request).then(fetchRes => {
                if (fetchRes && fetchRes.ok) {
                    const resClone = fetchRes.clone();
                    caches.open(staticCache).then(cache => {
                        cache.put('index.html', resClone).catch(() => {});
                    });
                }
                return fetchRes;
            }).catch(async () => {
                return (await caches.match('index.html'))
                    || (await caches.match('./'))
                    || (await caches.match('fallback.html'))
                    || Response.error();
            })
        );
        return;
    }

    if (isRootOwned(evt.request.url)) {
        evt.respondWith(
            fetch(evt.request).then(fetchRes => {
                if (fetchRes && fetchRes.ok) {
                    const resClone = fetchRes.clone();
                    caches.open(dynamicCache).then(cache => {
                        cache.put(evt.request.url, resClone).catch(() => {});
                        trimCache(dynamicCache, DYNAMIC_CACHE_MAX_ENTRIES);
                    });
                }
                return fetchRes;
            }).catch(async () => {
                return (await caches.match(evt.request)) || Response.error();
            })
        );
        return;
    }

    evt.respondWith(
        caches.match(evt.request).then(cacheRes => {
            return cacheRes || fetch(evt.request).then(fetchRes => {
                // Only cache successful, non-opaque responses so we don't poison the
                // cache with errors (4xx/5xx) or opaque cross-origin failures.
                if (fetchRes && fetchRes.ok) {
                    const resClone = fetchRes.clone();
                    caches.open(dynamicCache).then(cache => {
                        // Guard against any remaining unsupported-scheme/opaque edge
                        // cases so a failed put never surfaces as an uncaught rejection.
                        cache.put(evt.request.url, resClone).catch(() => {});
                        trimCache(dynamicCache, DYNAMIC_CACHE_MAX_ENTRIES);
                    });
                }
                return fetchRes;
            });
        }).catch(async () => {
            // Offline fallback for non-navigations. Always return a real
            // Response — returning undefined produced "Failed to convert value
            // to Response" errors instead of a clean failure.
            if (evt.request.url.indexOf('.html') > -1) {
                return (await caches.match('fallback.html')) || Response.error();
            }
            return Response.error();
        })
    );
});

self.addEventListener('notificationclick', event => {
    const notification = event.notification;
    const action = event.action;
    if ('go' === action) {
        clients.openWindow('https://5dice.app/Score/');
        notification.close();
    }
    else {
        clients.openWindow('https://5dice.app/Score/');
        notification.close();
    }
});
