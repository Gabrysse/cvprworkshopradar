// ─── Service Worker — CVPR 2026 Workshops & Tutorials ─────────────────────────
// Bump CACHE_NAME whenever you deploy new static assets (HTML, CSS, JS, images)
// so stale caches are evicted and all clients receive the updated files.
// For JSON-only updates you push to the repo, no bump is needed — the
// network-first strategy below handles those automatically.
const CACHE_NAME = 'cvpr2026-v2';

// Every file the app needs to run fully offline
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './room_coords.json',
  './cvpr2026_workshops_tutorials.json',
  './imgs/logo.png',
  './imgs/map_ballroom.png',
  './imgs/map_meeting.png',
  './imgs/map_exhibit.png',
];

// ── Install: pre-cache everything ─────────────────────────────────────────────
// After this completes the app is available offline on all subsequent visits.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())   // activate immediately, don't wait for old tabs to close
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
//  cvpr2026_workshops_tutorials.json  →  NETWORK-FIRST
//    Always tries the network first so users automatically receive updates
//    whenever you push a new JSON to the repo.
//    Falls back to the cached version when offline.
//
//  Everything else (HTML, CSS, JS, images, room_coords.json)  →  CACHE-FIRST
//    Served instantly from cache; stale copies are refreshed in the background.
//
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;   // ignore third-party requests

  // ── Network-first for the mutable data JSON ──────────────────────────────
  if (url.pathname.includes('cvpr2026_workshops_tutorials.json')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            // Always cache under the canonical path so ?t=… cache-bust variants
            // (used by the manual Refresh button) don't create duplicate entries.
            const canonical = new Request(url.pathname);
            caches.open(CACHE_NAME).then(cache => cache.put(canonical, response.clone()));
          }
          return response;
        })
        .catch(() =>
          // Offline fallback: canonical path first, then exact request URL
          caches.match(url.pathname).then(r => r || caches.match(event.request))
        )
    );
    return;
  }

  // ── Cache-first with background revalidation for static assets ───────────
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
