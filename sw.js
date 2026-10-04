/* =========================================================
   sw.js — service worker, офлайн-поддержка
   Кэш оболочки приложения: предкэш ядра + cache-first с
   сетевым фолбэком. Шрифты Google кэшируются на лету,
   чтобы тёмная типографика работала офлайн.
   Меняйте CACHE_VERSION при обновлении ассетов.
   Сборка для Cloudflare (scripts/build-assets.mjs) дописывает к нему
   короткий commit: каждый deploy main = новый sw.js = обновление кэша.
   ========================================================= */

const CACHE_VERSION = 'lexlife-v48';
const FONT_CACHE = 'lexlife-fonts-v1';
/* Журнал показанных срабатываний (push/локально) — общий со страницей (js/services/occurrenceStore.js) */
const OCC_CACHE = 'lexlife-occ-v1';

const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/services/storage.js',
  './js/services/analytics.js',
  './js/services/waterImport.js',
  './js/services/attachments.js',
  './js/services/fullBackup.js',
  './js/services/preparedImport.js',
  './js/services/zip.js',
  './js/services/testsJournal.js',
  './js/services/notifySchedule.js',
  './js/services/notifier.js',
  './js/services/zonedSchedule.js',
  './js/services/pushClient.js',
  './js/services/occurrenceStore.js',
  './js/services/deployment.js',
  './js/services/homeSummary.js',
  './js/services/meds.js',
  './js/services/sleep.js',
  './js/ui/charts.js',
  './js/ui/docViewer.js',
  './js/ui/bottomNav.js',
  './js/vendor/pdfjs/pdf.min.js',
  './js/vendor/pdfjs/pdf.worker.min.js',
  './manifest.json',
  './build-info.json',
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
            .filter((k) => k !== CACHE_VERSION && k !== FONT_CACHE && k !== OCC_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* Маршрут внутри приложения (никаких внешних URL из payload) */
const safeRoute = (r) => (typeof r === 'string' && r.length <= 80 && /^#\/[\w\-/]*$/.test(r) ? r : '');
const occKey = (id) => new URL(`__occ/${encodeURIComponent(id)}`, self.registration.scope).href;

/* Web Push с сервера LexLife (Cloudflare Worker, cron раз в минуту).
   payload: { occurrenceId, type, title, body, target, scheduledAt }.
   Каждый push обязан показать уведомление (требование iOS). tag = occurrenceId:
   повтор той же occurrence (retry сервера, локальный показ) заменяет
   уведомление, а не добавляет второе. */
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { body: event.data ? event.data.text() : '' }; }
  if (!p || typeof p !== 'object') p = {};
  const occ = typeof p.occurrenceId === 'string' && p.occurrenceId.length <= 120 ? p.occurrenceId : '';
  const route = safeRoute(p.target) || safeRoute(p.route) || '#/notifications';
  event.waitUntil((async () => {
    if (occ) {
      try { await (await caches.open(OCC_CACHE)).put(occKey(occ), new Response(JSON.stringify({ via: 'push', at: Date.now() }))); } catch (e) { /* журнал не критичен */ }
    }
    await self.registration.showNotification(String(p.title || 'LexLife').slice(0, 80), {
      body: String(p.body || 'Напоминание').slice(0, 200),
      tag: occ || String(p.tag || 'lexlife-push'),
      icon: 'icons/lexlife-icon-192.png',
      badge: 'icons/lexlife-icon-192.png',
      data: { route, occurrenceId: occ, type: typeof p.type === 'string' ? p.type.slice(0, 20) : '' },
    });
  })());
});

/* Клик по уведомлению — открыть приложение на нужном экране */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const route = safeRoute(d.route);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ('focus' in c) {
          if (route) c.postMessage({ type: 'lexlife:open', route });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow('./' + route);
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

  /* Только свой origin; API сервера уведомлений — всегда сеть, без кэша */
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(new URL(self.registration.scope).pathname + 'api/')) return;

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
