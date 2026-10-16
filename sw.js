/* ===================================================================
   SELF-UNINSTALLING SERVICE WORKER
   ===================================================================
   An earlier version of this file called e.waitUntil() inside a .then(),
   which throws InvalidStateError and rejected the promise given to
   respondWith — so navigation requests failed and the app hung on its
   splash screen. A broken service worker also keeps control until it is
   explicitly replaced, which is why reinstalling did not help.

   This version exists only to undo that. It takes control, deletes every
   cache, unregisters itself, and reloads any open tab. After it has run
   once the app has no service worker at all: every request goes straight
   to the network and the browser's normal HTTP cache, which cannot wedge
   the app.

   What we lose: offline launching. The app still starts instantly,
   because the library, history and feeds are cached by app.js in
   localStorage — that work is independent of this file.
   =================================================================== */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch { /* keep going regardless */ }

    try { await self.registration.unregister(); } catch { /* ditto */ }

    // Reload any open tab so it loads without a controller.
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.navigate(c.url).catch(() => {});
    } catch { /* nothing open */ }
  })());
});

/* No fetch handler. Nothing is intercepted, so nothing here can stop a
   page from loading. This is deliberate — do not add one back without
   testing it against a real device first. */
