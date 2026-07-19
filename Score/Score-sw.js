 
 const staticCache = 'static-v260718b';
 const dynamicCache = 'dynamic-v260718b';
 const assets = ['index.html', 'Score.js', 'firebase-backend.js',
    'Score.css', 'Score.json',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400&display=swap',
    'https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400&display=swap',
    'fallback.html'];


self.addEventListener('install', evt => {
        evt.waitUntil(caches.open(staticCache).then(cache => {
            console.log('Caching shell assets');
            cache.addAll(assets);
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
    evt.respondWith(
        caches.match(evt.request).then(cacheRes => {
            return cacheRes || fetch(evt.request).then(fetchRes => {
                return caches.open(dynamicCache).then(cache => {
                    cache.put(evt.request.url, fetchRes.clone());
                    return fetchRes;
                })
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
