const CACHE_NAME = 'ittybitty-v1';

const SHELL_ASSETS = [
  '/ittybitty/',
  '/ittybitty/index.html',
  '/ittybitty/css/style.css',
  '/ittybitty/js/app.js',
  '/ittybitty/js/url.js',
  '/ittybitty/js/compress.js',
  '/ittybitty/js/crypto.js',
  '/ittybitty/js/render.js',
  '/ittybitty/js/share.js',
  '/ittybitty/lib/marked.min.js',
  '/ittybitty/lib/qrcode.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache cross-origin requests
  if (url.origin !== self.location.origin) return;

  // Cache-first for shell assets, network-first for others
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    )
  );
});
