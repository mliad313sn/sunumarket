/* Service worker — FR-45/DC-15: static cache-first, catalogue GET cache
 * (stale-while-revalidate), tiny footprint. Order POSTs made offline are
 * queued in localStorage by the app (see lib/offline-queue.ts) and flushed
 * on 'online' — safe because the API is idempotent by key (ADR-0012). */
const STATIC_CACHE = "sunu-static-v1";
const API_CACHE = "sunu-api-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Catalogue reads: stale-while-revalidate so browsing works on flaky 2G.
  if (url.pathname.startsWith("/api/marketplace") || url.pathname.startsWith("/api/products")) {
    event.respondWith(
      caches.open(API_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const network = fetch(event.request)
          .then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached ?? network;
      })
    );
    return;
  }

  // Static: cache-first.
  if (url.origin === location.origin && !url.pathname.startsWith("/api/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ??
          fetch(event.request).then((res) => {
            if (res.ok) caches.open(STATIC_CACHE).then((c) => c.put(event.request, res.clone()));
            return res;
          })
      )
    );
  }
});
