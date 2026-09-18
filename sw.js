// Service Worker untuk PWA
const CACHE_NAME = 'smartsocket-v4';

self.addEventListener('install', (e) => {
  console.log('[Service Worker] Installed');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[Service Worker] Activated');
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});