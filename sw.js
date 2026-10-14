/* Caches the app shell so it opens instantly and works offline.
   Data (Supabase, TMDB) is never cached here — app.js handles that,
   so you never see a stale library. */
const SHELL = 'mytv-shell-v27';
const FILES = ['./', './index.html', './styles.css?v=27', './app.js?v=27', './manifest.webmanifest'];

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

/* Cache-first for the shell.

   This used to be network-first, so every launch waited on the network for the
   HTML, CSS and JavaScript before it could even start — on a slow connection
   that delay came before any of the app's own loading.

   Cache-first is safe here because the filenames carry a version (?v=27) and
   the cache name changes with each release: a new build is a different URL in
   a different cache, so you can never be served stale code. Anything not in
   the cache still falls through to the network. */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;   // never touch Supabase or TMDB

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Refresh the entry quietly for next time; the user is not kept waiting.
        e.waitUntil(
          fetch(e.request)
            .then(res => res.ok && caches.open(SHELL).then(c => c.put(e.request, res.clone())))
            .catch(() => {})
        );
        return hit;
      }
      return fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
