const APP_CACHE = "calstat-app-v14";
const FIREBASE_CACHE = "calstat-firebase-modules-v1";
const FIREBASE_VERSION = "12.15.0";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./styles/base.css",
  "./styles/components.css",
  "./styles/layout.css",
  "./styles/responsive.css",
  "./js/app.js",
  "./js/firebase-config.js",
  "./js/firebase.js",
  "./js/store.js",
  "./js/calculations.js",
  "./js/charts.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache =>
      cache.addAll(APP_SHELL.map(url => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            ![APP_CACHE, FIREBASE_CACHE].includes(key) && (
              key.startsWith("calstat-app-") ||
              key.startsWith("calstat-firebase-") ||
              key.startsWith("mass-track-app-") ||
              key.startsWith("mass-track-firebase-") ||
              key.startsWith("firebase-weight-tracker") ||
              key.startsWith("weight-tracker-shell-")
            )
          )
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Cache the Firebase JavaScript SDK modules for offline app startup.
  // Firestore/Auth network traffic is intentionally not intercepted.
  if (
    url.hostname === "www.gstatic.com" &&
    url.pathname.startsWith(`/firebasejs/${FIREBASE_VERSION}/`)
  ) {
    event.respondWith(
      caches.open(FIREBASE_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(APP_CACHE).then(cache => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkRequest = fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(APP_CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      });

      return cached ?? networkRequest;
    })
  );
});
