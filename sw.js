// Offline app shell. tools/build-site.mjs replaces VERSION with a content
// hash on deploy; tests check SHELL lists every app file.
const VERSION = "6e49312587dd";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/main.js", "js/model.js", "js/geo.js", "js/map.js", "js/feeds.js", "js/schedule.js", "js/coverage.js", "js/route.js", "js/live.js", "js/scheduled.js", "js/unofficial.js",
  "data/network.js", "data/places.js", "data/roads.js", "data/runtimes.js", "icons/places/index.js", "icons/icon.svg", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for same-origin files so updates show up; cache when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
