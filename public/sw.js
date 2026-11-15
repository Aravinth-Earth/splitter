/**
 * Splitter — the shell that can open without a network.
 *
 * Same-origin GETs use the network first and fall back to the last good copy, so a normal load
 * stays fresh and an offline load still paints. API and WebSocket traffic is never cached; the
 * app's own store holds the sealed group state.
 *
 * Bump VERSION when the shell file list changes; activate removes every older cache.
 */

const VERSION = 'splitter-shell-v1';
const SHELL = [
  '/',
  '/app.js',
  '/style.css',
  '/calc.js',
  '/cache.js',
  '/charts.js',
  '/crypto.js',
  '/expense.js',
  '/export.js',
  '/merge.js',
  '/store.js',
  '/sync.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
