const CACHE_NAME = 'splitlite-v2';
const CROSS_ORIGIN_CACHEABLE = [
  'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
];
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/storage.js',
  './js/currency.js',
  './js/balances.js',
  './js/csv.js',
  './js/sync.js',
  './js/qr.js',
  './js/main.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  ...CROSS_ORIGIN_CACHEABLE,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === location.origin;
  const isCacheableCrossOrigin = CROSS_ORIGIN_CACHEABLE.includes(event.request.url);
  if (!isSameOrigin && !isCacheableCrossOrigin) return; // e.g. the live exchange-rate API — always hit network fresh

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
