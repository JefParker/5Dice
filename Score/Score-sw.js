 
 const staticCache = 'static-v260723a';
 const dynamicCache = 'dynamic-v260723a';
 const assets = ['index.html', 'Score.js', 'firebase-backend.js',
    'Score.css', 'Score.json',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400&display=swap',
    'https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400&display=swap',
    'fallback.html'];


self.addEventListener('install', evt => {
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
        })
    );
});

self.addEventListener('fetch', evt => {
    //console.log('fetch event', evt);
    // Only handle GET requests. cache.put() throws on POST/PUT and would break
    // Firebase and other non-GET traffic.
    if (evt.request.method !== 'GET') return;

    evt.respondWith(
        caches.match(evt.request).then(cacheRes => {
            return cacheRes || fetch(evt.request).then(fetchRes => {
                // Only cache successful, non-opaque responses so we don't poison the
                // cache with errors (4xx/5xx) or opaque cross-origin failures.
                if (fetchRes && fetchRes.ok) {
                    const resClone = fetchRes.clone();
                    caches.open(dynamicCache).then(cache => {
                        cache.put(evt.request.url, resClone);
                    });
                }
                return fetchRes;
            });
        }).catch(() => {
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
