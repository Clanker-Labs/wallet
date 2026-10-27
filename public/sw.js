/*
 * wallet's service worker: the app opens without a connection and shows the
 * last version of each page you visited, read-only.
 *
 * - Pages: network first; the latest copy is kept for offline (30 pages).
 * - Built assets (/_next/static, icons): cache first — their names change
 *   with every build, so a cached one is never stale.
 * - /api/* is never cached: balances and actions always go to the server.
 * - Signing out clears everything (the page posts "wallet:clear").
 */
const VERSION = "wallet-v1";
const PAGES = `${VERSION}-pages`;
const ASSETS = `${VERSION}-assets`;
const MAX_PAGES = 30;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!key.startsWith(VERSION)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "wallet:clear") event.waitUntil(Promise.all([caches.delete(PAGES), caches.delete(ASSETS)]));
});

const OFFLINE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · wallet</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6fa;color:#101830}
@media (prefers-color-scheme:dark){body{background:#070b14;color:#e8ecf8}}main{max-width:22rem;padding:1.5rem;text-align:center}button{margin-top:1rem;padding:.55rem 1rem;border-radius:.6rem;border:0;background:#5b4fe9;color:#fff;font:inherit}</style>
<main><h1 style="font-size:1.1rem">You're offline</h1><p>This page hasn't been opened on this device yet, so there's no copy to show. Pages you've visited open offline.</p><button onclick="location.reload()">Try again</button></main></html>`;

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(k);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/") || /\.(svg|png|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES);
        try {
          const res = await fetch(req);
          // Only real pages: not redirects to the sign-in page, not errors.
          if (res.ok && !res.redirected && res.headers.get("content-type")?.includes("text/html")) {
            cache.put(req, res.clone()).then(() => trim(cache));
          }
          return res;
        } catch {
          const hit = (await cache.match(req)) ?? (await cache.match(new URL("/", self.location.origin)));
          return hit ?? new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
      })(),
    );
  }
});
