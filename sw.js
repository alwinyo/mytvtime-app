/* Caches the app shell so it opens instantly and works offline.
   Data (Supabase, TMDB) is never cached here — app.js handles that,
   so you never see a stale library. */
const SHELL = 'mytv-shell-v1';
const FILES = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;   // never touch Supabase or TMDB
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
