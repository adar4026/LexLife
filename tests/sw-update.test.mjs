/* =========================================================
   tests/sw-update.test.mjs — обновление открытой вкладки после deploy.
   sw.js (install / activate / message) в vm + js/services/swUpdate.js (решение вкладки),
   и протокол целиком: новый SW ↔ вкладка через настоящий MessageChannel.

   Что доказывается:
     • новый SW предкэширует оболочку мимо HTTP-кэша и сразу встаёт (skipWaiting);
     • activate удаляет ТОЛЬКО кэши прежних версий оболочки, текущий/шрифты/журнал/чужие — нет;
     • activate забирает вкладки (claim) и при обновлении сообщает им версию;
     • вкладка с новым кодом подтверждает и перезагружается сама — SW её не трогает;
     • вкладка со старым кодом (не ответила) перезагружается SW ровно один раз;
     • первая установка и повторный activate никого не перезагружают;
     • вкладка перезагружается максимум один раз; повтор той же версии — без цикла;
     • во время формы / несохранённого ввода перезагрузка откладывается до безопасного момента;
     • обычный запуск без новой версии — без перезагрузки;
     • SW не трогает localStorage / IndexedDB / push-подписку.
   Запуск:  node tests/sw-update.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeCaches, loadServiceWorker } from './helpers/fakeBrowser.mjs';
import {
  createUpdateController, isFormRoute, hasUnsavedInput, UPDATE_MSG, VERSION_MSG, RELOAD_KEY, UPDATE_CHECK_MS,
} from '../js/services/swUpdate.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SW_SRC = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const CUR = SW_SRC.match(/const CACHE_VERSION = '([^']+)';/)[1];
const SCOPE = 'https://lexlife.test/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* sessionStorage вкладки (переживает перезагрузку документа) */
const makeSession = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };

/* окно-клиент SW: onMessage(msg, ports) — как страница обрабатывает сообщение */
function windowClient(url, onMessage = null) {
  const c = {
    url, posted: [], navigated: [],
    postMessage(msg, ports = []) { c.posted.push(msg); if (onMessage) onMessage(msg, ports); },
    async navigate(u) { c.navigated.push(u); return c; },
  };
  return c;
}
/* вкладка с НОВЫМ кодом: тот же обработчик, что в js/app.js (listenSW) */
function newCodeTab(url, { session = makeSession(), isSafe = () => true } = {}) {
  const tab = { reloads: 0, session, results: [] };
  tab.updates = createUpdateController({ reload: () => { tab.reloads++; }, session, isSafe });
  tab.client = windowClient(url, (msg, ports) => {
    if (msg.type !== UPDATE_MSG) return;
    if (ports[0]) ports[0].postMessage({ ok: true });
    tab.results.push(tab.updates.onUpdateReady(msg.version));
  });
  return tab;
}
async function cachesWith(names) {
  const caches = createFakeCaches();
  for (const n of names) await (await caches.open(n)).put('https://lexlife.test/x', new Response('x'));
  return caches;
}

/* ---------- install ---------- */

test('install: оболочка предкэшируется мимо HTTP-кэша (cache:reload), затем skipWaiting', async () => {
  const caches = createFakeCaches();
  const sw = loadServiceWorker({ caches, scope: SCOPE });
  await sw.fire('install', {});
  const cached = await (await caches.open(CUR)).keys();
  const urls = cached.map((r) => r.url);
  for (const u of ['./', './index.html', './js/app.js', './js/services/swUpdate.js', './build-info.json', './css/styles.css']) assert.ok(urls.includes(u), u);
  const store = caches.stores.get(CUR);
  assert.ok([...store.values()].every((r) => r.cache === 'reload'), 'все запросы предкэша — cache:reload');
  assert.equal(sw.calls.skipWaiting, 1);
});

/* ---------- activate: кэши ---------- */

test('activate: удаляются только кэши прежних версий оболочки; текущий, шрифты, журнал, чужие — остаются', async () => {
  const caches = await cachesWith(['lexlife-v30', 'lexlife-v54', 'lexlife-v56-665112a', CUR, 'lexlife-fonts-v1', 'lexlife-occ-v1', 'other-app-cache']);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  await sw.fire('activate', {});
  const left = (await caches.keys()).sort();
  assert.deepEqual(left, [CUR, 'lexlife-fonts-v1', 'lexlife-occ-v1', 'other-app-cache'].sort());
  assert.equal(sw.calls.claim, 1);
});

test('activate: вариант CACHE_VERSION со суффиксом commit тоже считается прежней версией', async () => {
  const caches = await cachesWith([`${CUR}-aaaaaaa`, CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  await sw.fire('activate', {});
  assert.deepEqual(await caches.keys(), [CUR]);
});

/* ---------- activate: вкладки ---------- */

test('первая установка (прежних кэшей нет): claim, но никаких сообщений и перезагрузок', async () => {
  const caches = await cachesWith(['lexlife-fonts-v1']);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  const tab = newCodeTab(`${SCOPE}#/home`);
  const legacy = windowClient(`${SCOPE}#/meds`);
  sw.clients.push(tab.client, legacy);
  await sw.fire('activate', {});
  assert.equal(sw.calls.claim, 1);
  assert.equal(tab.client.posted.length, 0);
  assert.equal(legacy.posted.length, 0);
  assert.equal(legacy.navigated.length, 0);
  assert.equal(tab.reloads, 0);
});

test('обновление: вкладке с новым кодом приходит версия, она подтверждает и перезагружается сама — SW её не трогает', async () => {
  const caches = await cachesWith(['lexlife-v56-665112a', CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  const tab = newCodeTab(`${SCOPE}#/metric/water`);
  sw.clients.push(tab.client);
  await sw.fire('activate', {});
  assert.deepEqual(JSON.parse(JSON.stringify(tab.client.posted)), [{ type: UPDATE_MSG, version: CUR }]); // объект из vm — другой realm
  assert.deepEqual(tab.results, ['reload']);
  assert.equal(tab.reloads, 1);
  assert.equal(tab.client.navigated.length, 0, 'подтвердившую вкладку SW не перезагружает');
  assert.deepEqual(JSON.parse(JSON.stringify(sw.calls.matchAll)), [{ type: 'window' }]);
});

test('обновление: вкладка со старым кодом (не ответила) перезагружается SW один раз на свой же адрес', async () => {
  const caches = await cachesWith(['lexlife-v56-665112a', CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  const legacy = windowClient(`${SCOPE}#/metric/water`); // старый app.js: сообщение игнорирует
  sw.clients.push(legacy);
  await sw.fire('activate', {});
  assert.equal(legacy.posted.length, 1);
  assert.deepEqual(legacy.navigated, [`${SCOPE}#/metric/water`]);
});

test('обновление: смешанные вкладки — новая перезагружается сама, старая через SW, каждая один раз', async () => {
  const caches = await cachesWith(['lexlife-v54', CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  const tab = newCodeTab(`${SCOPE}#/home`);
  const legacy = windowClient(`${SCOPE}#/sleep`);
  const broken = windowClient(`${SCOPE}#/tests`);
  broken.postMessage = () => { throw new Error('detached'); };
  sw.clients.push(tab.client, legacy, broken);
  await sw.fire('activate', {});
  assert.equal(tab.reloads, 1);
  assert.equal(tab.client.navigated.length, 0);
  assert.deepEqual(legacy.navigated, [`${SCOPE}#/sleep`]);
  assert.deepEqual(broken.navigated, [`${SCOPE}#/tests`]);
});

test('без WindowClient.navigate (старый браузер): ничего не ломается, вкладка остаётся как была', async () => {
  const caches = await cachesWith(['lexlife-v54', CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  const legacy = windowClient(`${SCOPE}#/home`);
  delete legacy.navigate;
  sw.clients.push(legacy);
  await sw.fire('activate', {});
  assert.equal(legacy.posted.length, 1);
});

test('повторный activate той же версии: прежних кэшей уже нет — никто не перезагружается (нет цикла)', async () => {
  const caches = await cachesWith(['lexlife-v56-665112a', CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  const tab = newCodeTab(`${SCOPE}#/home`);
  const legacy = windowClient(`${SCOPE}#/meds`);
  sw.clients.push(tab.client, legacy);
  await sw.fire('activate', {});
  await sw.fire('activate', {});
  assert.equal(tab.client.posted.length, 1);
  assert.equal(tab.reloads, 1);
  assert.equal(legacy.navigated.length, 1);
});

test('вкладка с формой: подтверждает (SW не перезагружает), а сама перезагружается после ухода с формы', async () => {
  const caches = await cachesWith(['lexlife-v54', CUR]);
  const sw = loadServiceWorker({ caches, scope: SCOPE, timeScale: 0.01 });
  let route = '#/sleep/new';
  const tab = newCodeTab(`${SCOPE}${route}`, { isSafe: () => !isFormRoute(route) });
  sw.clients.push(tab.client);
  await sw.fire('activate', {});
  assert.deepEqual(tab.results, ['deferred']);
  assert.equal(tab.reloads, 0);
  assert.equal(tab.client.navigated.length, 0, 'SW не перезагружает вкладку с открытой формой');
  assert.equal(tab.updates.retry(), false, 'пока форма открыта — ждём');
  route = '#/sleep';
  assert.equal(tab.updates.retry(), true);
  assert.equal(tab.reloads, 1);
  assert.equal(tab.updates.retry(), false);
  assert.equal(tab.reloads, 1);
});

/* ---------- message: версия ---------- */

test('SW отвечает своей версией по запросу lexlife:version', async () => {
  const sw = loadServiceWorker({ scope: SCOPE });
  const ch = new MessageChannel();
  const got = new Promise((r) => { ch.port1.onmessage = (e) => { ch.port1.close(); r(e.data); }; });
  sw.listeners.message({ data: { type: VERSION_MSG }, ports: [ch.port2] });
  assert.deepEqual(JSON.parse(JSON.stringify(await got)), { type: VERSION_MSG, version: CUR });
});

test('протокол: строки сообщений в sw.js совпадают с js/services/swUpdate.js', () => {
  assert.match(SW_SRC, new RegExp(`const UPDATE_MSG = '${UPDATE_MSG}';`));
  assert.match(SW_SRC, new RegExp(`const VERSION_MSG = '${VERSION_MSG}';`));
});

test('SW не трогает пользовательские данные и push-подписку', () => {
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(SW_SRC), 'хранилища страницы');
  assert.ok(!/pushManager|unsubscribe|\.unregister\(/.test(SW_SRC), 'push-подписка и регистрация');
  assert.ok(!/client\.navigate|c\.navigate/.test(SW_SRC.replace(/function handOverClients[\s\S]*?\n}\n/, '')), 'navigate — только в handOverClients');
});

/* ---------- вкладка: createUpdateController ---------- */

test('вкладка: перезагрузка максимум одна на документ', () => {
  const session = makeSession();
  let reloads = 0;
  const u = createUpdateController({ reload: () => reloads++, session });
  assert.equal(u.onUpdateReady('v57-a'), 'reload');
  assert.equal(u.onUpdateReady('v57-a'), 'already');
  assert.equal(u.onUpdateReady('v57-b'), 'already');
  assert.equal(u.retry(), false);
  assert.equal(reloads, 1);
  assert.equal(session.getItem(RELOAD_KEY), 'v57-a');
});

test('вкладка: после перезагрузки повтор той же версии не перезагружает снова (нет цикла)', () => {
  const session = makeSession();
  let reloads = 0;
  createUpdateController({ reload: () => reloads++, session }).onUpdateReady('v57-a');
  /* новый документ в той же вкладке — тот же sessionStorage */
  const after = createUpdateController({ reload: () => reloads++, session });
  for (let i = 0; i < 5; i++) assert.equal(after.onUpdateReady('v57-a'), 'guard');
  assert.equal(after.retry(), false);
  assert.equal(reloads, 1);
  /* а следующая настоящая версия — снова ровно одна перезагрузка */
  assert.equal(after.onUpdateReady('v58-b'), 'reload');
  assert.equal(reloads, 2);
});

test('вкладка: обычный запуск без новой версии — перезагрузок нет', () => {
  let reloads = 0;
  const u = createUpdateController({ reload: () => reloads++, session: makeSession() });
  for (let i = 0; i < 10; i++) u.retry();
  assert.equal(reloads, 0);
  assert.equal(u.pending, null);
});

test('вкладка: несохранённый ввод откладывает перезагрузку до безопасного момента', () => {
  let safe = false;
  let reloads = 0;
  const u = createUpdateController({ reload: () => reloads++, session: makeSession(), isSafe: () => safe });
  assert.equal(u.onUpdateReady('v57-a'), 'deferred');
  assert.equal(u.pending, 'v57-a');
  assert.equal(u.retry(), false);
  assert.equal(u.retry(), false);
  safe = true;
  assert.equal(u.retry(), true);
  assert.equal(u.retry(), false);
  assert.equal(reloads, 1);
});

test('вкладка: sessionStorage недоступен (Safari private) — всё равно не больше одной перезагрузки на документ', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  let reloads = 0;
  const u = createUpdateController({ reload: () => reloads++, session: broken });
  assert.equal(u.onUpdateReady('v57-a'), 'reload');
  assert.equal(u.onUpdateReady('v57-a'), 'already');
  assert.equal(reloads, 1);
  assert.equal(createUpdateController({ reload: () => reloads++, session: null }).onUpdateReady('x'), 'reload');
});

test('вкладка: проверка sw.js при возврате в приложение — не чаще раза в минуту', () => {
  let t = 1_000_000;
  const u = createUpdateController({ reload: () => {}, session: makeSession(), now: () => t });
  assert.equal(u.shouldCheck(), true);
  t += 5_000;
  assert.equal(u.shouldCheck(), false);
  t += UPDATE_CHECK_MS;
  assert.equal(u.shouldCheck(), true);
});

test('маршруты-формы: перезагрузка во время них откладывается', () => {
  const forms = ['visit/new', 'visit/abc/edit', 'sleep/new', 'sleep/new/2026-10-01', 'sleep/s1', 'med/new', 'med/m1/edit', 'test/new', 'test/t1/edit', '#/med/new'];
  const screens = ['', 'home', 'meds', 'metric/water', 'water-log', 'sleep', 'sleep/settings', 'visit/abc', 'test/t1', 'test-history/hb', 'notifications'];
  for (const r of forms) assert.equal(isFormRoute(r), true, r);
  for (const r of screens) assert.equal(isFormRoute(r), false, r);
});

test('несохранённый ввод: значение поля отличается от исходного', () => {
  const field = (o) => ({ tagName: 'INPUT', type: 'text', value: '', defaultValue: '', ...o });
  const root = (list) => ({ querySelectorAll: () => list });
  assert.equal(hasUnsavedInput(null), false);
  assert.equal(hasUnsavedInput(root([field({ value: '07:00', defaultValue: '07:00' })])), false);
  assert.equal(hasUnsavedInput(root([field({ value: '72,4' })])), true);
  assert.equal(hasUnsavedInput(root([{ tagName: 'TEXTAREA', type: 'textarea', value: 'заметка', defaultValue: '' }])), true);
  assert.equal(hasUnsavedInput(root([field({ type: 'checkbox', checked: true, defaultChecked: false })])), true);
  assert.equal(hasUnsavedInput(root([field({ type: 'checkbox', checked: true, defaultChecked: true })])), false);
  assert.equal(hasUnsavedInput(root([{ tagName: 'SELECT', type: 'select-one', options: [{ selected: false, defaultSelected: true }, { selected: true, defaultSelected: false }] }])), true);
  assert.equal(hasUnsavedInput(root([{ tagName: 'SELECT', type: 'select-one', options: [{ selected: true, defaultSelected: true }] }])), false);
  assert.equal(hasUnsavedInput(root([field({ type: 'file', files: [{}] })])), true);
  assert.equal(hasUnsavedInput(root([field({ type: 'hidden', value: 'x' })])), false);
});

test('исходные значения формы (defaultValue) — не правка; изменённость виджета — data-unsaved', () => {
  /* как sleep/settings: сохранённое время записано в defaultValue → value следует за ним */
  const bed = { tagName: 'INPUT', type: 'time', defaultValue: '23:30', value: '23:30' };
  const form = (fields, unsaved = false) => ({ querySelectorAll: () => fields, querySelector: (sel) => (sel === '[data-unsaved]' && unsaved ? {} : null) });
  assert.equal(hasUnsavedInput(form([bed])), false, 'открыли экран — не изменено');
  assert.equal(hasUnsavedInput(form([{ ...bed, value: '22:45' }])), true, 'пользователь сменил время');
  assert.equal(hasUnsavedInput(form([bed], true)), true, 'степпер цели изменён');
  /* после сохранения экран заново заполняется уже новыми сохранёнными значениями */
  assert.equal(hasUnsavedInput(form([{ ...bed, defaultValue: '22:45', value: '22:45' }])), false, 'сохранено — снова не изменено');
});

test('несохранённый ввод управляет перезагрузкой: не изменено → reload, изменено → отложено', () => {
  let dirty = false;
  let reloads = 0;
  const isSafe = () => !hasUnsavedInput({ querySelectorAll: () => [], querySelector: () => (dirty ? {} : null) });
  const clean = createUpdateController({ reload: () => reloads++, session: makeSession(), isSafe });
  assert.equal(clean.onUpdateReady('v57-a'), 'reload');
  dirty = true;
  const edited = createUpdateController({ reload: () => reloads++, session: makeSession(), isSafe });
  assert.equal(edited.onUpdateReady('v57-b'), 'deferred');
  assert.equal(reloads, 1);
  dirty = false; // сохранили и ушли с экрана
  assert.equal(edited.retry(), true);
  assert.equal(reloads, 2);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL — ${name}`);
    console.error(`         ${err && err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
