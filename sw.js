const CACHE = 'tasks-v1-127';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config/icons.js',
  'manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://unpkg.com/dexie@4.0.8/dist/dexie.min.js',
  'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js',
];

self.addEventListener('install', (e) => {
  // Fetch with cache:'reload' so the browser HTTP cache (GitHub Pages serves
  // app.js/style.css with max-age=600) can't feed addAll a stale copy right
  // after a deploy — otherwise a new CACHE name captures old assets and the
  // version bumps without the content changing.
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok && res.type !== 'opaque') throw new Error('install fetch failed: ' + url);
      await c.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Wiki sync hits api.github.com with auth — never cache, always go to network.
  // Caching authed responses leaks tokens between sessions and serves stale feeds.
  const url = new URL(e.request.url);
  if (url.host === 'api.github.com') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
