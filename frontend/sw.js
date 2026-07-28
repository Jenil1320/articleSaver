/* Folio service worker.

   The shell is pre-cached so the app opens with no network. Article text lives in
   IndexedDB, not here. Media is cached as it is seen, which is what makes a saved
   article render completely when offline.

   API calls are never served stale: a wrong answer about your library is worse than
   an honest failure, and the app already falls back to its local mirror. */

const VERSION = 'folio-v1';
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/db.js',
  '/js/reader.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API. The app has its own offline mirror and knows how to use it.
  if (url.pathname.startsWith('/api/')) return;

  // Media: serve from cache first, then fill the cache in the background.
  if (url.pathname.startsWith('/media/')) {
    event.respondWith(
      caches.open(MEDIA).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  // Navigation: try the network so a new build is picked up, fall back to the shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          caches.open(SHELL).then((c) => c.put('/index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Everything else in the shell: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || network;
    }),
  );
});
