const CACHE = 'tasks-v1-100';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config/icons.js',
  'manifest.json',
  'https://unpkg.com/dexie@4.0.8/dist/dexie.min.js',
  'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
