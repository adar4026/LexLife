/* =========================================================
   sw.js — service worker, офлайн-поддержка
   Кэш оболочки приложения: предкэш ядра + cache-first с
   сетевым фолбэком. Шрифты Google кэшируются на лету,
   чтобы тёмная типографика работала офлайн.
   Меняйте CACHE_VERSION при обновлении ассетов.
   ========================================================= */

const CACHE_VERSION = 'lexlife-v23';
const FONT_CACHE = 'lexlife-fonts-v1';

const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/services/storage.js',
  './js/services/analytics.js',
  './js/ui/charts.js',
  './manifest.json',
  './icons/lexlife-icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      /* cache: 'reload' — мимо HTTP-кэша браузера, чтобы новая версия не смешалась со старыми файлами */
      .then((cache) => cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION && k !== FONT_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* Клик по уведомлению — сфокусировать приложение (задел под центр уведомлений) */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((cs) => {
      for (const c of cs) if ('focus' in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow('./');
      return undefined;
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Шрифты Google — stale-while-revalidate в отдельном кэше */
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((res) => {
              if (res && res.status === 200) cache.put(request, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  /* Только свой origin */
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('./index.html');
          return undefined;
        });
    })
  );
});
