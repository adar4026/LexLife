/* =========================================================
   sw.js — service worker, офлайн-поддержка
   Кэш оболочки приложения: предкэш ядра + cache-first с
   сетевым фолбэком. Шрифты Google кэшируются на лету,
   чтобы тёмная типографика работала офлайн.
   Меняйте CACHE_VERSION при обновлении ассетов.
   Сборка для Cloudflare (scripts/build-assets.mjs) дописывает к нему
   короткий commit: каждый deploy main = новый sw.js = обновление кэша.

   Обновление открытых вкладок (js/services/swUpdate.js): документ, загруженный
   из кэша прежней версии, сам не перезагружается. Новый SW в activate (только при
   обновлении — были кэши прежних версий) спрашивает каждую вкладку через
   MessageChannel; ответившая перезагрузится сама (с учётом незаконченной формы),
   не ответившая (старый код) — перезагружается здесь, один раз, WindowClient.navigate().
   ========================================================= */

const CACHE_VERSION = 'lexlife-v65';
const FONT_CACHE = 'lexlife-fonts-v1';
/* Журнал показанных срабатываний (push/локально) — общий со страницей (js/services/occurrenceStore.js) */
const OCC_CACHE = 'lexlife-occ-v1';
/* Кэши оболочки приложения любой версии (lexlife-v57, lexlife-v57-abc1234 …).
   Удаляются только они: шрифты, журнал срабатываний и чужие кэши origin не трогаем. */
const APP_CACHE_RE = /^lexlife-v\d/;
/* Протокол обновления — те же строки, что в js/services/swUpdate.js */
const UPDATE_MSG = 'lexlife:update-ready';
const VERSION_MSG = 'lexlife:version';
const UPDATE_ACK_MS = 3000;

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
  './js/services/swUpdate.js',
  './js/services/homeSummary.js',
  './js/services/meds.js',
  './js/services/sleep.js',
  './js/services/activity.js',
  './js/services/visitKinds.js',
  './js/services/historyImport.js',
  './js/services/journals.js',
  './js/services/metricPeriods.js',
  './js/services/waist.js',
  './js/services/workouts.js',
  './js/ui/charts.js',
  './js/ui/healthChart.js',
  './js/ui/docViewer.js',
  './js/ui/bottomNav.js',
  './js/ui/backNav.js',
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

/* Вкладка подтвердила, что перезагрузится сама (true), или промолчала (false — старый код) */
function askClient(client) {
  return new Promise((resolve) => {
    let done = false;
    const ch = new MessageChannel();
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ch.port1.close(); } catch (e) { /* уже закрыт */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), UPDATE_ACK_MS);
    ch.port1.onmessage = (e) => finish(!!(e.data && e.data.ok));
    try { client.postMessage({ type: UPDATE_MSG, version: CACHE_VERSION }, [ch.port2]); } catch (e) { finish(false); }
  });
}

/* Вкладки, открытые до этой версии, переходят на неё: сами или (старый код) через navigate.
   navigate() не ждём: навигация ждёт конца activate, ожидание дало бы взаимную блокировку. */
async function handOverClients() {
  const wins = await self.clients.matchAll({ type: 'window' });
  const acked = await Promise.all(wins.map(askClient));
  wins.forEach((c, i) => {
    if (!acked[i] && typeof c.navigate === 'function') c.navigate(c.url).catch(() => {});
  });
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter((k) => APP_CACHE_RE.test(k) && k !== CACHE_VERSION);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
    /* первая установка (прежних кэшей нет) — документ уже из сети, перезагружать нечего */
    if (stale.length) await handOverClients();
  })());
});

/* Версия этого SW — для «О приложении», диагностики и проверки обновления */
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === VERSION_MSG && event.ports && event.ports[0]) event.ports[0].postMessage({ type: VERSION_MSG, version: CACHE_VERSION });
});

/* Маршрут внутри приложения (никаких внешних URL из payload) */
const safeRoute = (r) => (typeof r === 'string' && r.length <= 80 && /^#\/[\w\-/]*$/.test(r) ? r : '');
const occKey = (id) => new URL(`__occ/${encodeURIComponent(id)}`, self.registration.scope).href;

/* Web Push с сервера LexLife (Cloudflare Worker, cron раз в минуту).
   payload: { occurrenceId, type, title, body, target, scheduledAt, ack? }.
   Каждый push обязан показать уведомление (требование iOS).

   Порядок важен: showNotification — ПЕРВЫМ, до любого обращения к хранилищу
   или сети. На iPhone SW будится в фоне; ожидание Cache API перед показом
   может задержать уведомление до открытия приложения (тогда приходит пачка).
   Потом, без влияния на показ (каждый шаг с тайм-аутом):
   - журнал occurrence (локальный планировщик не покажет то же второй раз);
   - старые уведомления того же правила закрываются: после долгого сна iPhone
     отдаёт накопленные push разом, на экране остаётся одно, последнее
     (iOS игнорирует замену по tag);
   - подтверждение серверу (POST api/push/ack): журнал доставки знает,
     когда iPhone реально показал уведомление. */
const STEP_MS = 4000;
function withTimeout(p, ms = STEP_MS) {
  let timer;
  const stop = new Promise((r) => { timer = setTimeout(r, ms); });
  return Promise.race([Promise.resolve(p).catch(() => undefined), stop]).finally(() => clearTimeout(timer));
}
const ruleOf = (occ) => (occ && occ.includes('@') ? occ.slice(0, occ.lastIndexOf('@')) : '');
const validAck = (a) => (a && Number.isSafeInteger(a.d) && a.d > 0 && typeof a.k === 'string' && /^[A-Za-z0-9_-]{22}$/.test(a.k) ? { d: a.d, k: a.k } : null);

async function closeOlderOfRule(occ, scheduledAt) {
  const rule = ruleOf(occ);
  if (!rule || !scheduledAt || typeof self.registration.getNotifications !== 'function') return;
  const same = (await self.registration.getNotifications()).filter((n) => n.data && ruleOf(n.data.occurrenceId) === rule && n.data.scheduledAt);
  const newest = same.reduce((m, n) => (n.data.scheduledAt > m ? n.data.scheduledAt : m), scheduledAt);
  /* остаётся только самое позднее срабатывание (пришедшее раньше более старое — тоже закрывается) */
  for (const n of same) if (n.data.scheduledAt < newest) n.close();
}

self.addEventListener('push', (event) => {
  const shownAt = Date.now();
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { body: event.data ? event.data.text() : '' }; }
  if (!p || typeof p !== 'object') p = {};
  const occ = typeof p.occurrenceId === 'string' && p.occurrenceId.length <= 120 ? p.occurrenceId : '';
  const route = safeRoute(p.target) || safeRoute(p.route) || '#/notifications';
  const scheduledAt = typeof p.scheduledAt === 'string' && p.scheduledAt.length <= 40 ? p.scheduledAt : '';
  const ack = validAck(p.ack);
  const shown = self.registration.showNotification(String(p.title || 'LexLife').slice(0, 80), {
    body: String(p.body || 'Напоминание').slice(0, 200),
    tag: occ || String(p.tag || 'lexlife-push'),
    icon: 'icons/lexlife-icon-192.png',
    badge: 'icons/lexlife-icon-192.png',
    timestamp: Date.parse(scheduledAt) || shownAt,
    data: { route, occurrenceId: occ, scheduledAt, type: typeof p.type === 'string' ? p.type.slice(0, 20) : '' },
  });
  event.waitUntil((async () => {
    await shown;
    const after = [];
    if (occ) {
      after.push(withTimeout(caches.open(OCC_CACHE).then((c) => c.put(occKey(occ), new Response(JSON.stringify({ via: 'push', at: shownAt }))))));
      after.push(withTimeout(closeOlderOfRule(occ, scheduledAt)));
    }
    if (ack) {
      after.push(withTimeout(fetch(new URL('api/push/ack', self.registration.scope).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d: ack.d, k: ack.k, shownAt }),
        credentials: 'omit', cache: 'no-store', keepalive: true,
      })));
    }
    await Promise.all(after);
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
