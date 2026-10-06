/* =========================================================
   tests/push-client.test.mjs — фронтенд фоновых уведомлений
   (js/services/pushClient.js) против настоящего API Worker'а:
   клиент → handleApi → D1 (node:sqlite) → cron → push-сервис (заглушка)
   → расшифровка → sw.js push → журнал occurrence → локальный планировщик.

   Проверяет: включение, offline-изменения и их слияние, rev/409,
   backup/restore без переноса подписки, отключение (и offline),
   GitHub Pages без /api, потерю подписки, local/server dedupe.
   Синтетические данные. Время правил — локальное (TZ=Europe/Madrid).

   Запуск:  TZ=Europe/Madrid node tests/push-client.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { createPushClient, PUSH_KV, SYNC_FAIL_TEXT, SERVER_FALLBACK_MS, syncSnapshot } from '../js/services/pushClient.js';
import { createOccurrenceStore } from '../js/services/occurrenceStore.js';
import { createNotifier, armPatch } from '../js/services/notifier.js';
import { StorageService, MemoryDriver, parseBackup } from '../js/services/storage.js';
import { handleApi } from '../worker/api.js';
import { runCron } from '../worker/cron.js';
import { generateVapidKeys } from '../worker/webpush.js';
import { createD1 } from './helpers/d1.mjs';
import { createPushServer, decrypt } from './helpers/pushService.mjs';
import { createFakeCaches, createFakePushManager, loadServiceWorker } from './helpers/fakeBrowser.mjs';
import { migrationMode, isLegacyPages, NEW_HOME_URL, PRIMARY_URL, deploymentRole, serverPushAllowed } from '../js/services/deployment.js';
import { describeNotifyState } from '../js/services/notifier.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
/* структурированные логи Worker'а (worker/log.js) — не засоряют вывод тестов */
for (const k of ['log', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...x) => { if (!(typeof x[0] === 'string' && x[0].startsWith('{"evt"'))) orig(...x); };
}
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const VAPID = await generateVapidKeys();

function memKv() {
  const m = new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k) };
}

/* Сервер (общий для нескольких «устройств») */
function createServer() {
  const db = createD1();
  const push = createPushServer();
  const env = { DB: db, VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:test@example.invalid', PUSH_TEST_INTERVAL_SEC: '20' };
  const server = { db, push, env, clock: L(2031, 3, 10, 8, 0).getTime(), requests: [] };
  server.cron = (t) => runCron(env, t, { fetchImpl: push.fetchImpl });
  return server;
}

/* Устройство: localStorage + StorageService + PushManager + сеть (online/offline) */
async function createDevice(server, { pages = false, serverAllowed = true } = {}) {
  const kv = memKv();
  const storage = new StorageService(new MemoryDriver());
  storage.noDemoData = true;
  await storage.init();
  const { pm, calls, current } = await createFakePushManager();
  const net = { online: true };
  const fetchImpl = async (url, init) => {
    if (!net.online) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    server.requests.push(`${init.method} ${u.pathname}`);
    if (pages) return new Response('<h1>404</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } }); // GitHub Pages: /LexLife/api/* нет
    return handleApi(new Request(url, init), server.env, { now: server.clock, fetchImpl: server.push.fetchImpl });
  };
  const perm = { value: 'granted' };
  const client = createPushClient({
    kv, fetchImpl, apiBase: new URL(pages ? 'https://adar4026.github.io/LexLife/api/' : 'https://lexlife.test/api/'),
    getRules: () => storage.getNotifications(), timeZone: () => TZ,
    pushManager: async () => pm, permission: () => perm.value, now: () => server.clock, serverAllowed,
  });
  return { kv, storage, pm, calls, current, net, client, perm };
}
const ruleOf = async (dev, type) => (await dev.storage.getNotifications()).find((n) => n.type === type);
/* Включено только одно правило (остальные дефолтные тоже срабатывают в 09:00) */
async function onlyRule(dev, type, patch, at) {
  for (const n of await dev.storage.getNotifications()) {
    await dev.storage.updateNotification(n.id, n.type === type ? armPatch({ ...patch, enabled: true }, at) : { enabled: false });
  }
  return ruleOf(dev, type);
}
const serverRules = (server) => server.db.q('SELECT * FROM notification_rules ORDER BY client_rule_id');

/* ---------- включение ---------- */
test('enable: устройство + токен, подписка userVisibleOnly с VAPID-ключом, правила на сервере без текстов', async () => {
  const server = createServer(); const dev = await createDevice(server);
  const r = await dev.client.enable();
  assert.deepEqual(r, { ok: true, error: null });
  assert.match(dev.kv.get(PUSH_KV.deviceId), /^[0-9a-f-]{36}$/); assert.match(dev.kv.get(PUSH_KV.token), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(dev.calls.subscribe.length, 1);
  assert.equal(dev.calls.subscribe[0].userVisibleOnly, true);
  assert.equal(Buffer.from(dev.calls.subscribe[0].applicationServerKey).toString('base64url'), VAPID.publicKey);
  const local = await dev.storage.getNotifications();
  const rows = serverRules(server);
  assert.equal(rows.length, local.length);
  assert.ok(!JSON.stringify(rows).includes(local[0].text), 'тексты напоминаний остаются на устройстве');
  assert.equal(rows[0].timezone, TZ);
  const st = dev.client.state();
  assert.equal(st.enabled, true); assert.equal(st.subscription, 'active'); assert.ok(st.syncedAt); assert.equal(st.lastError, null);
  assert.equal(await dev.client.isServerPrimary(), true);
  assert.ok(!JSON.stringify(st).includes(dev.current().endpoint), 'endpoint не хранится в состоянии открытым текстом');
  /* повторное включение не плодит подписки и устройства */
  await dev.client.enable();
  assert.equal(dev.calls.subscribe.length, 1);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM devices')[0].n, 1);
});

test('GitHub Pages: /api нет → «нет на этом адресе», устройство не регистрируется, локальный режим как раньше', async () => {
  const server = createServer(); const dev = await createDevice(server, { pages: true });
  const cfg = await dev.client.config();
  assert.equal(cfg.available, false); assert.equal(cfg.offline, false);
  assert.deepEqual(await dev.client.enable(), { ok: false, error: 'backend_unavailable' });
  assert.equal(dev.kv.get(PUSH_KV.token), null);
  assert.equal(await dev.client.isServerPrimary(), false);
  assert.deepEqual(await dev.client.sync(), { ok: true, skipped: true });
});

/* ---------- синхронизация ---------- */
test('offline: несколько изменений времени → ошибка честно видна → при сети уходит одна, последняя версия', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const meds = await ruleOf(dev, 'meds');
  dev.net.online = false;
  for (const time of ['20:00', '20:30', '22:15']) {
    await dev.storage.updateNotification(meds.id, armPatch({ time }));
    const r = await dev.client.sync();
    assert.equal(r.ok, false); assert.equal(r.offline, true);
  }
  assert.equal(dev.client.state().lastError, SYNC_FAIL_TEXT);
  assert.equal(await dev.client.pendingSync(), true);
  assert.equal(await dev.client.isServerPrimary(), false, 'пока сервер не знает изменений, локальный планировщик не ждёт push');
  const before = server.requests.length;
  dev.net.online = true;
  assert.equal((await dev.client.sync()).ok, true);
  assert.deepEqual(server.requests.slice(before), ['POST /api/notifications/sync'], 'одна синхронизация');
  assert.equal(serverRules(server).find((r) => r.client_rule_id === meds.id).local_time, '22:15');
  assert.equal(dev.client.state().lastError, null);
  assert.equal(await dev.client.pendingSync(), false);
  /* без изменений — запросов нет; lastFiredAt (локальное состояние) — тоже не изменение */
  await dev.storage.updateNotification(meds.id, { lastFiredAt: new Date().toISOString() });
  const n = server.requests.length;
  assert.equal((await dev.client.sync()).upToDate, true);
  assert.equal(server.requests.length, n);
});

test('параллельные sync склеиваются; сервер получает финальную версию', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const w = await ruleOf(dev, 'weight');
  const before = server.requests.length;
  await dev.storage.updateNotification(w.id, armPatch({ time: '07:00' }));
  const p1 = dev.client.sync();
  await dev.storage.updateNotification(w.id, armPatch({ time: '07:30' }));
  const p2 = dev.client.sync();
  await dev.storage.updateNotification(w.id, armPatch({ time: '07:45' }));
  const p3 = dev.client.sync();
  await Promise.all([p1, p2, p3]);
  assert.ok(server.requests.length - before <= 2, String(server.requests.length - before));
  assert.equal(serverRules(server).find((r) => r.client_rule_id === w.id).local_time, '07:45');
});

test('rev: сервер знает более новый rev (другая вкладка) → 409 → повтор с большим rev', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  server.db.raw.prepare('UPDATE devices SET rules_rev = ?').run(server.clock + 10 ** 9);
  const meds = await ruleOf(dev, 'meds');
  await dev.storage.updateNotification(meds.id, armPatch({ time: '23:00' }));
  assert.equal((await dev.client.sync()).ok, true);
  assert.equal(serverRules(server).find((r) => r.client_rule_id === meds.id).local_time, '23:00');
});

test('смена timezone устройства (поездка) → пересинхронизация с новой timezone', async () => {
  const server = createServer(); const dev = await createDevice(server);
  let tz = TZ;
  const client = createPushClient({
    kv: dev.kv, fetchImpl: (u, i) => handleApi(new Request(u, i), server.env, { now: server.clock }), apiBase: new URL('https://lexlife.test/api/'),
    getRules: () => dev.storage.getNotifications(), timeZone: () => tz, pushManager: async () => dev.pm, permission: () => 'granted', now: () => server.clock,
  });
  await client.enable();
  tz = 'Asia/Tokyo';
  assert.equal(await client.pendingSync(), true);
  await client.sync();
  assert.ok(serverRules(server).every((r) => r.timezone === 'Asia/Tokyo'));
});

/* ---------- backup / restore ---------- */
test('backup не содержит device_id/токена/подписки; restore на новом устройстве → новая подписка, старый endpoint не восстанавливается', async () => {
  const server = createServer(); const a = await createDevice(server);
  await a.client.enable();
  const meds = await ruleOf(a, 'meds');
  await a.storage.updateNotification(meds.id, armPatch({ time: '06:40' }));
  await a.client.sync();
  const { json } = await a.storage.createBackup();
  for (const secret of [a.kv.get(PUSH_KV.token), a.kv.get(PUSH_KV.deviceId), a.current().endpoint, PUSH_KV.state]) assert.ok(!json.includes(secret), 'в бэкапе нет push-данных');

  const b = await createDevice(server);
  await b.storage.restoreBackup(await b.storage.prepareRestore(parseBackup(json)));
  assert.equal((await ruleOf(b, 'meds')).time, '06:40', 'правила восстановлены локально');
  assert.equal(b.kv.get(PUSH_KV.token), null, 'привязки к серверу нет');
  assert.equal(await b.client.isServerPrimary(), false);
  await b.client.enable();
  const devices = server.db.q('SELECT id FROM devices').map((r) => r.id);
  assert.equal(devices.length, 2); assert.notEqual(b.kv.get(PUSH_KV.deviceId), a.kv.get(PUSH_KV.deviceId));
  const subs = server.db.q('SELECT device_id, endpoint FROM push_subscriptions');
  assert.equal(subs.length, 2);
  assert.equal(subs.find((s) => s.device_id === b.kv.get(PUSH_KV.deviceId)).endpoint, b.current().endpoint);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM notification_rules WHERE device_id = ? AND local_time = ?', b.kv.get(PUSH_KV.deviceId), '06:40')[0].n, 1);
});

test('restore на том же устройстве меняет правила → они уходят на сервер при следующей синхронизации', async () => {
  const server = createServer(); const dev = await createDevice(server);
  const other = await createDevice(server);
  const p = await ruleOf(other, 'pressure');
  await other.storage.updateNotification(p.id, armPatch({ time: '11:11' }));
  const { json } = await other.storage.createBackup();
  await dev.client.enable();
  await dev.storage.restoreBackup(await dev.storage.prepareRestore(parseBackup(json)));
  assert.equal(await dev.client.pendingSync(), true);
  await dev.client.sync();
  const ids = (await dev.storage.getNotifications()).map((n) => n.id).sort();
  const rows = server.db.q('SELECT client_rule_id, local_time FROM notification_rules WHERE device_id = ? ORDER BY client_rule_id', dev.kv.get(PUSH_KV.deviceId));
  assert.deepEqual(rows.map((r) => r.client_rule_id), ids, 'зеркало = восстановленные правила (старые удалены)');
  assert.ok(rows.some((r) => r.local_time === '11:11'));
});

/* ---------- отключение ---------- */
test('disable: PushSubscription.unsubscribe() + сервер удаляет подписку и правила; локальные правила не тронуты', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const local = await dev.storage.getNotifications();
  assert.deepEqual(await dev.client.disable(), { ok: true, offline: false });
  assert.equal(dev.calls.unsubscribe, 1); assert.equal(dev.current(), null);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 0);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM notification_rules')[0].n, 0);
  assert.deepEqual(await dev.storage.getNotifications(), local);
  assert.equal(dev.client.state().enabled, false);
  assert.deepEqual(await dev.client.sync(), { ok: true, skipped: true });
});

test('disable offline → отмечено pendingUnsubscribe → сервер узнаёт при появлении сети', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  dev.net.online = false;
  const r = await dev.client.disable();
  assert.equal(r.ok, false); assert.equal(r.offline, true);
  assert.equal(dev.client.state().pendingUnsubscribe, true);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 1);
  dev.net.online = true;
  await dev.client.sync();
  assert.equal(server.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 0);
  assert.equal(dev.client.state().pendingUnsubscribe, false);
});

/* ---------- потеря подписки, устройство удалено на сервере ---------- */
test('checkSubscription: iOS сбросил подписку → новая подписка; сервер забыл устройство (401) → регистрация заново', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const firstEndpoint = dev.current().endpoint;
  dev.pm.drop();
  assert.equal((await dev.client.checkSubscription()).state, 'renewed');
  assert.notEqual(dev.current().endpoint, firstEndpoint);
  assert.deepEqual(server.db.q('SELECT endpoint FROM push_subscriptions').map((r) => r.endpoint), [dev.current().endpoint]);
  /* сервер удалил устройство (retention) */
  server.db.raw.prepare('DELETE FROM devices').run();
  const oldId = dev.kv.get(PUSH_KV.deviceId);
  dev.pm.drop();
  assert.equal((await dev.client.checkSubscription()).state, 'renewed');
  assert.notEqual(dev.kv.get(PUSH_KV.deviceId), oldId);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 1);
  /* без разрешения подписку не восстановить — честное «lost» */
  dev.pm.drop(); dev.perm.value = 'denied';
  assert.equal((await dev.client.checkSubscription()).state, 'lost');
  assert.equal(dev.client.state().subscription, 'lost');
});

test('snapshot для сервера: только поля расписания, стабильный порядок', () => {
  const s = syncSnapshot([{ id: 'b', type: 'meds', enabled: 1, repeat: 'weekly', time: '09:00', days: [3, 1], text: 'секрет', ref: { x: 1 }, lastFiredAt: 'x', channel: 'local' }, { id: 'a', type: 'water', enabled: false, repeat: 'interval', intervalMinutes: '90', startTime: '07:00', endTime: '23:00' }], 'Europe/Madrid');
  assert.deepEqual(s.rules.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(s.rules[1].days, [1, 3]); assert.equal(s.rules[1].enabled, true); assert.equal(s.rules[0].intervalMinutes, 90);
  assert.ok(!JSON.stringify(s).match(/секрет|lastFiredAt|channel|ref/));
});

/* ---------- сквозной путь и local/server dedupe ---------- */
test('сквозной путь: cron → push (расшифрован ключами браузера) → sw.js показывает с tag=occurrenceId → локальный планировщик не дублирует', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const meds = await onlyRule(dev, 'meds', { time: '09:00' }, L(2031, 3, 10, 8, 0));
  await dev.client.sync();
  /* cron в 09:00 → push-сервис */
  const stats = await server.cron(L(2031, 3, 10, 9, 0).getTime());
  assert.equal(stats.sent, 1);
  const payload = await decrypt(dev.current().ua, server.push.log.at(-1).body);
  assert.equal(payload.occurrenceId, `${meds.id}@2031-03-10T09:00`);
  /* push → Service Worker (тот же Cache API, что у страницы) */
  const caches = createFakeCaches();
  const sw = loadServiceWorker({ caches });
  await sw.pushJson(payload);
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].opts.tag, payload.occurrenceId);
  assert.equal(sw.shown[0].opts.body, 'Проверьте напоминание LexLife');
  assert.equal(sw.shown[0].opts.data.route, '#/meds');
  /* приложение открыто: локальный планировщик видит, что push уже был */
  const occ = createOccurrenceStore({ cachesApi: caches, base: 'https://lexlife.test/' });
  const shown = [];
  const notifier = createNotifier({ storage: dev.storage, show: async (r, at, id) => shown.push(id), permission: () => 'granted', now: () => L(2031, 3, 10, 9, 0, 30), occurrences: occ, deferMs: async () => ((await dev.client.isServerPrimary()) ? SERVER_FALLBACK_MS : 0) });
  await notifier.check(); await notifier.check();
  assert.deepEqual(shown, []);
  assert.equal(new Date((await ruleOf(dev, 'meds')).lastFiredAt).getTime(), L(2031, 3, 10, 9, 0).getTime());
});

test('push не пришёл: при активном push локальный показ ждёт 2 мин, затем запасной показ; push после этого заменяет тот же tag', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const water = await onlyRule(dev, 'water', { repeat: 'interval', intervalMinutes: 60, startTime: '09:00', endTime: '20:00' }, L(2031, 3, 10, 8, 0));
  await dev.client.sync();
  const caches = createFakeCaches();
  const occ = createOccurrenceStore({ cachesApi: caches, base: 'https://lexlife.test/' });
  let t = L(2031, 3, 10, 9, 0, 30);
  const shown = [];
  const notifier = createNotifier({ storage: dev.storage, show: async (r, at, id) => shown.push(id), permission: () => 'granted', now: () => t, occurrences: occ, deferMs: async () => ((await dev.client.isServerPrimary()) ? SERVER_FALLBACK_MS : 0) });
  await notifier.check();
  assert.deepEqual(shown, [], 'в первые 2 минуты ждём серверный push');
  t = L(2031, 3, 10, 9, 2, 5);
  await notifier.check(); await notifier.check();
  assert.deepEqual(shown, [`${water.id}@2031-03-10T09:00`], 'запасной локальный показ — один');
  /* опоздавший push той же occurrence: SW покажет с тем же tag (замена, не второе уведомление) */
  const sw = loadServiceWorker({ caches });
  await sw.pushJson({ occurrenceId: shown[0], type: 'water', title: 'LexLife', body: 'Пора выпить воду', target: '#/metric/water' });
  assert.equal(sw.shown[0].opts.tag, shown[0]);
});

test('открытие приложения после пропуска: push ушёл (sent) → локально НЕ показывается; не ушёл (failed) → один запасной показ', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const water = await onlyRule(dev, 'water', { repeat: 'interval', intervalMinutes: 60, startTime: '09:00', endTime: '20:00' }, L(2031, 3, 10, 8, 0));
  await dev.client.sync();
  /* 09:00: сервер отправил, iPhone «держит» push (SW не запускался — журнал occurrence пуст) */
  assert.equal((await server.cron(L(2031, 3, 10, 9, 0).getTime())).sent, 1);
  const caches = createFakeCaches();
  const occ = createOccurrenceStore({ cachesApi: caches, base: 'https://lexlife.test/' });
  let t = L(2031, 3, 10, 9, 6);
  server.clock = t.getTime();
  const shown = [];
  const notifier = createNotifier({
    storage: dev.storage, show: async (r, at, id) => shown.push(id), permission: () => 'granted', now: () => t, occurrences: occ,
    deferMs: async () => ((await dev.client.isServerPrimary()) ? SERVER_FALLBACK_MS : 0),
    serverCheck: (id) => dev.client.occurrenceStatus(id),
  });
  await notifier.check(); await notifier.check();
  assert.deepEqual(shown, [], 'push уже у iPhone: второго «💧 Вода» нет');
  assert.equal(new Date((await ruleOf(dev, 'water')).lastFiredAt).getTime(), L(2031, 3, 10, 9, 0).getTime());
  assert.ok(await occ.has(`${water.id}@2031-03-10T09:00`), 'отмечено как доставленное сервером');
  /* 10:00: push-сервис отказал (403) → сервер записал failed → запасной локальный показ, один */
  server.push.set(() => 403);
  await server.cron(L(2031, 3, 10, 10, 0).getTime());
  t = L(2031, 3, 10, 10, 4); server.clock = t.getTime();
  await notifier.check(); await notifier.check();
  assert.deepEqual(shown, [`${water.id}@2031-03-10T10:00`]);
  /* 11:00: сервер ещё повторяет (retry) → ждём; нет сети → iPhone push не получил → запасной показ */
  server.push.set(() => 503);
  await server.cron(L(2031, 3, 10, 11, 0).getTime());
  t = L(2031, 3, 10, 11, 2, 30); server.clock = t.getTime();
  await notifier.check();
  assert.equal(shown.length, 1, 'retry на сервере — локально не показываем');
  dev.net.online = false;
  t = L(2031, 3, 10, 11, 3); server.clock = t.getTime();
  await notifier.check();
  assert.deepEqual(shown.slice(1), [`${water.id}@2031-03-10T11:00`]);
  /* через 10 мин после срабатывания — уже ничего (старое не догоняется) */
  dev.net.online = true;
  t = L(2031, 3, 10, 12, 11); server.clock = t.getTime();
  await notifier.check();
  assert.equal(shown.length, 2);
});

test('checkSubscription при запуске: сервер снял подписку (410 / удалённая установка) → подписка отправляется снова, правила возвращаются', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  await onlyRule(dev, 'meds', { time: '09:00' }, L(2031, 3, 10, 8, 0));
  await dev.client.sync();
  assert.equal((await dev.client.checkSubscription()).state, 'ok');
  assert.ok(server.db.q('SELECT last_seen_at FROM devices')[0].last_seen_at, 'запуск отмечен на сервере');
  server.db.raw.prepare('DELETE FROM push_subscriptions').run();
  server.db.raw.prepare('UPDATE notification_rules SET next_fire_at = NULL').run();
  server.clock = L(2031, 3, 10, 12, 0).getTime();
  assert.equal((await dev.client.checkSubscription()).state, 'healed');
  assert.deepEqual(server.db.q('SELECT endpoint FROM push_subscriptions').map((r) => r.endpoint), [dev.current().endpoint]);
  assert.equal(server.db.q("SELECT next_fire_at FROM notification_rules WHERE enabled = 1")[0].next_fire_at, L(2031, 3, 11, 9, 0).getTime());
  /* без сети — просто ok, без лишних действий */
  dev.net.online = false;
  assert.equal((await dev.client.checkSubscription()).state, 'ok');
});

test('push выключен: локальный планировщик показывает сразу (как раньше)', async () => {
  const server = createServer(); const dev = await createDevice(server);
  const meds = await onlyRule(dev, 'meds', { time: '09:00' }, L(2031, 3, 10, 8, 0));
  const shown = [];
  const notifier = createNotifier({ storage: dev.storage, show: async (r, at, id) => shown.push(id), permission: () => 'granted', now: () => L(2031, 3, 10, 9, 0, 10), occurrences: createOccurrenceStore({ cachesApi: createFakeCaches(), base: 'https://lexlife.test/' }), deferMs: async () => ((await dev.client.isServerPrimary()) ? SERVER_FALLBACK_MS : 0) });
  await notifier.check();
  assert.deepEqual(shown, [`${meds.id}@2031-03-10T09:00`]);
});

test('тестовый push с клиента: проходит через Worker, второй сразу — 429 с retryAfter', async () => {
  const server = createServer(); const dev = await createDevice(server);
  await dev.client.enable();
  const r1 = await dev.client.testPush();
  assert.equal(r1.ok, true);
  const p = await decrypt(dev.current().ua, server.push.log.at(-1).body);
  assert.equal(p.type, 'test');
  const r2 = await dev.client.testPush();
  assert.equal(r2.status, 429); assert.ok(r2.data.retryAfter > 0);
  const st = await dev.client.status();
  assert.equal(st.data.subscription, 'active'); assert.ok(st.data.lastPushAt);
});

test('перенос: export на GitHub Pages, import на основном origin, иначе скрыт', () => {
  assert.equal(NEW_HOME_URL, PRIMARY_URL);
  const pages = new URL('https://adar4026.github.io/LexLife/#/home');
  const cf = new URL('https://lexlife.example.workers.dev/#/home');
  assert.equal(isLegacyPages(pages), true); assert.equal(isLegacyPages(cf), false);
  assert.equal(migrationMode(pages), 'export');
  assert.equal(migrationMode(pages, null), null);
  assert.equal(migrationMode(pages, cf.origin + '/'), 'export');
  assert.equal(migrationMode(cf, cf.origin + '/'), 'import');
  assert.equal(migrationMode(new URL('http://localhost:4173/'), cf.origin + '/'), null);
  assert.equal(migrationMode(cf, 'not a url'), null);
});

test('роль адреса: основной / резервный / dev / другой; серверный push только на основном и dev', () => {
  const at = (u) => new URL(u);
  assert.equal(deploymentRole(at('https://lexlife.alexus4026.workers.dev/#/home')), 'primary');
  assert.equal(deploymentRole(at('https://adar4026.github.io/LexLife/')), 'legacy');
  assert.equal(deploymentRole(at('http://127.0.0.1:8787/')), 'dev');
  assert.equal(deploymentRole(at('http://localhost:4173/')), 'dev');
  assert.equal(deploymentRole(at('https://abc123-lexlife.alexus4026.workers.dev/')), 'other', 'preview-версия Worker — не основной адрес');
  assert.equal(deploymentRole(null), 'other');
  assert.equal(serverPushAllowed(at('https://lexlife.alexus4026.workers.dev/')), true);
  assert.equal(serverPushAllowed(at('http://127.0.0.1:8787/')), true);
  assert.equal(serverPushAllowed(at('https://adar4026.github.io/LexLife/')), false);
  assert.equal(serverPushAllowed(at('https://evil.example/')), false);
});

test('резервная копия (GitHub Pages): ни одного запроса к /api, устройство не создаётся, правила не уходят', async () => {
  const server = createServer(); const dev = await createDevice(server, { pages: true, serverAllowed: false });
  assert.equal(dev.client.serverAllowed, false);
  const cfg = await dev.client.config();
  assert.equal(cfg.available, false); assert.equal(cfg.legacy, true); assert.equal(cfg.offline, false);
  assert.deepEqual(await dev.client.enable(), { ok: false, error: 'legacy' });
  assert.equal(await dev.client.ensureDevice(), false);
  for (let i = 0; i < 5; i++) assert.equal((await dev.client.sync({ force: true })).skipped, true); // нет retry-цикла
  assert.deepEqual(await dev.client.checkSubscription(), { state: 'off' });
  assert.equal(await dev.client.pendingSync(), false);
  assert.equal(await dev.client.isServerPrimary(), false);
  assert.equal((await dev.client.status()).ok, false);
  assert.equal((await dev.client.testPush()).ok, false);
  await dev.client.disable();
  assert.deepEqual(server.requests, [], 'нет сетевых запросов');
  assert.equal(dev.calls.subscribe.length, 0, 'push-подписка не создавалась');
  assert.equal(dev.kv.get(PUSH_KV.deviceId), null); assert.equal(dev.kv.get(PUSH_KV.token), null);
  assert.equal(server.db.q('SELECT COUNT(*) n FROM devices')[0].n, 0);
});

test('экран уведомлений на резервной копии: «Резервная версия», сервер не используется, ссылка на основной адрес', () => {
  const env = { supported: true, permission: 'granted', ios: true, standalone: true, swActive: true, pushSupported: true, subscribed: false,
    background: { backend: 'legacy', primaryHost: 'lexlife.alexus4026.workers.dev', enabled: false, subscription: 'none' } };
  const d = describeNotifyState(env);
  assert.equal(d.status.title, 'Резервная версия LexLife'); assert.equal(d.status.level, 'warn');
  assert.match(d.status.detail, /lexlife\.alexus4026\.workers\.dev/);
  assert.equal(d.items.find((i) => i.label === 'Сервер уведомлений').value, 'не используется (резервная версия)');
  assert.equal(d.active, false); assert.match(d.limit, /резервная копия/);
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`  ok — ${t.name}`); } catch (err) { failed++; console.log(`  FAIL — ${t.name}\n    ${err && err.stack}`); }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
