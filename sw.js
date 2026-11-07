/* Learnloop service worker: app shell cached up front, course JSON refreshed
 * from the network so new content shows up, fonts and scripts served offline. */
const VERSION = "learnloop-v2";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "vendor/marked.js",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2",
  "fonts/atkinson-hyperlegible-latin-700-normal.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "courses/catalog.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) {
    if (req.method !== "GET") return;
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ done: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    return;
  }
  if (req.method !== "GET") return;

  if (url.pathname.includes("/courses/") && url.pathname.endsWith(".json")) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && res.status === 200) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || new Response("Offline", { status: 503 });
  }
}
