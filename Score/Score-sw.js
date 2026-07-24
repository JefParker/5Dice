 
 const staticCache = 'static-v260724k';
 const dynamicCache = 'dynamic-v260724k';
 // Precache the SAME versioned URLs the page actually requests. The previous list
 // cached bare names (e.g. 'Score.js') while index.html loads 'Score.js?v=10', so
 // caches.match() (which compares the query string) never matched and the precache
 // was dead weight. When you bump a ?v= number in index.html, bump it here too and
 // bump the cache version strings above.
 const assets = ['./', 'index.html',
    'Score.js?v=13', 'firebase-backend.js?v=8', 'Score.css?v=5',
    'forms.css', 'Score.json',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400&display=swap',
    'https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400&display=swap',
    'fallback.html'];


self.addEventListener('install', evt => {
        // Activate a freshly-installed SW immediately instead of waiting for every
        // controlled tab to close. Without this, a new version sits in "waiting"
        // and the old cached code keeps running until all tabs are shut — which is
        // exactly how stale Score.js kept being served after updates.
        self.skipWaiting();
        evt.waitUntil(caches.open(staticCache).then(cache => {
            console.log('Caching shell assets');
            return cache.addAll(assets);
        })
    );
});

self.addEventListener('activate', evt => {
    evt.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(keys
                .filter(key => key !== staticCache && key !== dynamicCache)
                .map(key => caches.delete(key))
            )
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', evt => {
    //console.log('fetch event', evt);
    // Only handle GET requests. cache.put() throws on POST/PUT and would break
    // Firebase and other non-GET traffic.
    if (evt.request.method !== 'GET') return;

    // The Cache API only supports http/https. Requests with other schemes —
    // notably chrome-extension:// injected by browser extensions, plus data:,
    // blob:, etc. — throw "Request scheme is unsupported" on cache.put(). Ignore
    // them entirely and let the browser handle them normally.
    if (!/^https?:$/.test(new URL(evt.request.url).protocol)) return;

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
                    });
                }
                return fetchRes;
            });
        }).catch(async () => {
            // Offline fallback. Page navigations request the directory URL (e.g.
            // /Score/), not literally "index.html", so serve the cached app shell.
            if (evt.request.mode === 'navigate') {
                return (await caches.match('index.html'))
                    || (await caches.match('./'))
                    || (await caches.match('fallback.html'));
            }
            if (evt.request.url.indexOf('.html') > -1) {
                return caches.match('fallback.html');
            }
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
