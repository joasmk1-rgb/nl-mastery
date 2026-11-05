// Service worker de NL Mastery (5 novembre 2026) : l'app s'installe sur l'écran d'accueil et
// s'ouvre sans tout retélécharger.
// - La page (index.html) : toujours le réseau d'abord (revalidation), le cache seulement hors
//   ligne. C'est elle qui porte le numéro de version (NLM_V) du code.
// - Le code et les styles versionnés (?v=) : le cache d'abord ; une nouvelle version = une
//   nouvelle adresse, l'ancienne est retirée du cache.
// - Les données du même site (CSV, JSON, icônes) : le cache tout de suite, mise à jour en
//   arrière-plan pour la fois suivante.
// - Tout le reste (Firebase, Gemini, polices) : jamais touché.
const CACHE = 'nlm-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function putVersioned(cache, req, res) {
    const url = new URL(req.url);
    const old = await cache.keys();
    await Promise.all(old.filter(k => { const u = new URL(k.url); return u.pathname === url.pathname && u.search !== url.search; }).map(k => cache.delete(k)));
    await cache.put(req, res);
}

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (req.mode === 'navigate') {
        e.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const key = url.origin + url.pathname;
            try {
                const res = await fetch(req, { cache: 'no-cache' });
                if (res.status === 200) cache.put(key, res.clone()).catch(() => {});
                return res;
            } catch (err) {
                return (await cache.match(key)) || Response.error();
            }
        })());
        return;
    }
    if (url.searchParams.has('v')) {
        e.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const hit = await cache.match(req);
            if (hit) return hit;
            const res = await fetch(req);
            if (res.status === 200) putVersioned(cache, req, res.clone()).catch(() => {});
            return res;
        })());
        return;
    }
    e.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        const net = fetch(req).then(res => { if (res.status === 200) cache.put(req, res.clone()).catch(() => {}); return res; });
        if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
        return net;
    })());
});
