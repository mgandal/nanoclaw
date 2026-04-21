// NanoClaw Cockpit service worker.
// Three caching strategies:
//   1. Hashed app shell (JS/CSS/HTML):        cache-first; vite hash invalidates.
//   2. /data/snapshot.json + /data/heartbeat: stale-while-revalidate (5-min).
//   3. /data/pages/*.md:                       cache-first session cache.
//
// No offline writes. No cross-origin caching. No precache manifest — if the
// user is offline on first visit, the app fails rather than serving a blank
// cached shell (spec §non-goals: this is a read-only live cockpit).

const SW_VERSION = 'cockpit-v1';
const DATA_CACHE = `${SW_VERSION}-data`;
const PAGES_CACHE = `${SW_VERSION}-pages`;
const SHELL_CACHE = `${SW_VERSION}-shell`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => !n.startsWith(SW_VERSION)).map(n => caches.delete(n))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/data/snapshot.json' || url.pathname === '/data/heartbeat.txt') {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }
  if (url.pathname.startsWith('/data/pages/')) {
    event.respondWith(cacheFirst(req, PAGES_CACHE));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
  // Everything else (/data/snapshot-*.json history, etc.): just passthrough.
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);  // network failed, serve cached
  return cached || networkPromise;
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
