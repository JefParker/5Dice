// Replaces the old SyncWatch service worker at 5dice.app/SyncWatch/ (see
// _redirects). It deletes SyncWatch's caches on this origin, unregisters
// itself, and sends any open SyncWatch window to syncwatch.5dice.app.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', evt => {
    evt.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith('syncwatch-')).map(key => caches.delete(key)));
        await self.registration.unregister();
        const windows = await self.clients.matchAll({ type: 'window' });
        await Promise.all(windows.map(w => {
            const url = new URL(w.url);
            return w.navigate('https://syncwatch.5dice.app' + url.pathname.replace(/^\/SyncWatch/, '') + url.search).catch(() => {});
        }));
    })());
});
