// ─── Service Worker — Workshop Radar ───────────────────────────────────────────
// Bump CACHE_NAME whenever you deploy new static assets (HTML, CSS, JS, images)
// so stale caches are evicted and all clients receive the updated files.
// For JSON-only updates you push to the repo, no bump is needed — the
// network-first strategy below handles those automatically.
const CACHE_NAME = 'workshopradar-v2';

// Every file the app needs to run fully offline
const PRECACHE_URLS = [
  './',
  './index.html',
  './archive.html',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/archive.js',
  './assets/js/qrcode.min.js',
  './conferences/cvpr2026/maps/room_coords.json',
  './conferences.json',
  './conferences/cvpr2026/data/workshops_tutorials.json',
  './assets/images/logo.png',
  './conferences/cvpr2026/maps/images/map_ballroom.png',
  './conferences/cvpr2026/maps/images/map_meeting.png',
  './conferences/cvpr2026/maps/images/map_exhibit.png',
  './conferences/eccv2026/data/workshops_tutorials.json',
];

// ── Install: pre-cache everything ─────────────────────────────────────────────
// Use cache:'reload' on precache requests so the SW always fetches fresh files
// from the network during install, bypassing the browser's HTTP cache.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(
        PRECACHE_URLS.map(u => new Request(u, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: evict old version caches, claim all open tabs immediately ────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch strategy ─────────────────────────────────────────────────────────────
//
//  Conference JSON and registry  →  NETWORK-FIRST
//    Always tries the network first so users automatically receive updates
//    whenever you push a new JSON to the repo.
//    Falls back to the cached version when offline.
//
//  Everything else (HTML, CSS, images, room coordinates)  →  CACHE-FIRST
//    Served instantly from cache; stale copies are refreshed in the background.
//
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;   // ignore third-party requests
  if (url.pathname.startsWith('/_vercel/')) return;  // Vercel serves these analytics assets directly

  // ── Network-first for all mutable/versioned files (JS, CSS, HTML, JSON) ──
  // Always try the network so updated files are picked up immediately.
  // Falls back to cache only when offline.
  if (url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('.json')) {
    // Use cache:'no-cache' to force revalidation with the server, bypassing
    // the browser's own HTTP cache (which could serve stale files despite max-age).
    const networkReq = new Request(event.request.url, { cache: 'no-cache' });
    event.respondWith(
      fetch(networkReq)
        .then(response => {
          if (response.ok) {
            const canonical = new Request(url.pathname);
            // Clone before returning the response: once the browser starts reading it,
            // cloning in a later cache promise throws "Response body is already used".
            const cacheCopy = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(canonical, cacheCopy))
              .catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(url.pathname) || await caches.match(event.request);
          return cached || new Response('Offline and not cached', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
    );
    return;
  }

  // ── Cache-first for immutable assets (images, fonts, etc.) ───────────────
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const cacheCopy = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(event.request, cacheCopy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => cached || new Response('Offline and not cached', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }));
      return cached || networkFetch;
    })
  );
});
