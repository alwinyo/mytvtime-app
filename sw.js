/* Caches the app shell so it opens instantly and works offline.
   Data (Supabase, TMDB) is never cached here — app.js handles that,
   so you never see a stale library. */
const SHELL = 'mytv-shell-v28';
const FILES = ['./', './index.html', './styles.css?v=28', './app.js?v=28', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // addAll fails as a unit; a single 404 would leave no cache at all.
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache-first for the shell, network for everything else.

   The previous version called e.waitUntil() inside a .then(), i.e. after the
   event handler had already returned. That throws InvalidStateError, which
   rejected the promise handed to respondWith, so the navigation itself failed
   and the app hung on its splash screen forever.

   Background refresh now runs as a plain detached promise. If anything here
   throws, we fall through to the network rather than breaking the page. */
function refreshInBackground(request) {
  fetch(request)
    .then((res) => {
      if (res && res.ok) caches.open(SHELL).then(c => c.put(request, res.clone())).catch(() => {});
    })
    .catch(() => {});
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (url.origin !== location.origin) return;      // never touch Supabase or TMDB

  e.respondWith((async () => {
    try {
      const hit = await caches.match(e.request, { ignoreSearch: false });
      if (hit) {
        refreshInBackground(e.request);
        return hit;
      }
      const res = await fetch(e.request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch {
      // Offline, or anything unexpected: serve the shell for a navigation,
      // otherwise let the request fail normally.
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
      return fetch(e.request);
    }
  })());
});
