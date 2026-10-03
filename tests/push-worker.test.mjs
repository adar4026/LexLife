/* =========================================================
   tests/push-worker.test.mjs — Cloudflare Worker фоновых уведомлений:
   API (регистрация, токен, подписка, sync, тестовый push, rate limit),
   cron (due, claim, дубли, параллельные запуски, 410/5xx/сеть, retry,
   опоздание), расписание в timezone (Europe/Madrid DST, полночь, год),
   приватность (нет endpoint/текста в ответах и payload), статика/headers.

   Без сети и без Cloudflare: D1 = node:sqlite с настоящими миграциями,
   push-сервис = заглушка fetch, payload реально шифруется и
   расшифровывается ключами «браузера». Только синтетические данные.

   Запуск:  node tests/push-worker.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { handleApi } from '../worker/api.js';
import { runCron, maintenance, MAX_ATTEMPTS, STUCK_CLAIM_MS } from '../worker/cron.js';
import { generateVapidKeys } from '../worker/webpush.js';
import { sha256Hex } from '../worker/auth.js';
import worker from '../worker/index.js';
import { zonedToUtc, wallLabel } from '../js/services/zonedSchedule.js';
import { NOTIF_GRACE_MS } from '../js/services/notifySchedule.js';
import { createD1 } from './helpers/d1.mjs';
import { makeUserAgent, decrypt, verifyVapid, createPushServer } from './helpers/pushService.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TZ = 'Europe/Madrid';
const M = (y, mo, d, h = 0, mi = 0) => zonedToUtc(y, mo, d, h, mi, TZ); // локальное время Мадрида → UTC мс
const MIN = 60000;
const VAPID = await generateVapidKeys();

async function setup({ responder } = {}) {
  const db = createD1();
  const push = createPushServer(responder);
  const env = { DB: db, VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:test@example.invalid', PUSH_TEST_INTERVAL_SEC: '20' };
  let clock = M(2031, 3, 10, 8, 0);
  const call = async (method, path, { body, auth, now = clock, ct = 'application/json', raw } = {}) => {
    const headers = {};
    if (ct) headers['Content-Type'] = ct;
    if (auth) headers.Authorization = `Bearer ${auth.deviceId}.${auth.token}`;
    const init = { method, headers };
    if (method !== 'GET') init.body = raw != null ? raw : JSON.stringify(body || {});
    const res = await handleApi(new Request(`https://lexlife.test${path}`, init), env, { now, fetchImpl: push.fetchImpl });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };
  const cron = (now) => runCron(env, now, { fetchImpl: push.fetchImpl });
  const device = async () => (await call('POST', '/api/device/register', { body: { deviceId: crypto.randomUUID() } })).data;
  const subscribed = async (opts = {}) => {
    const auth = await device();
    const ua = await makeUserAgent();
    const endpoint = `https://web.push.apple.com/QH${crypto.randomUUID()}`;
    const r = await call('POST', '/api/push/subscribe', { auth, body: { endpoint, keys: { p256dh: ua.p256dh, auth: ua.auth } }, ...opts });
    assert.equal(r.status, 200);
    return { auth, ua, endpoint };
  };
  let rev = 0;
  const sync = (auth, rules, { tz = TZ, now = clock, r } = {}) => call('POST', '/api/notifications/sync', { auth, now, body: { rev: r ?? ++rev + 1000, timezone: tz, rules } });
  return { db, env, push, call, cron, device, subscribed, sync, setClock: (t) => { clock = t; } };
}

const R = (o) => ({ id: 'r1', type: 'meds', enabled: true, repeat: 'daily', time: '09:00', days: [], intervalMinutes: 120, startTime: '07:00', endTime: '23:00', date: null, ...o });

/* Прогнать cron каждую минуту в [from, to) — как Cron Trigger «* * * * *» */
async function cronEveryMinute(s, from, to) {
  for (let t = from; t < to; t += MIN) await s.cron(t);
}
const sentPayloads = async (s, ua) => Promise.all(s.push.log.filter((x) => x.status >= 200 && x.status < 300).map((x) => decrypt(ua, x.body)));

/* ---------- регистрация и токен ---------- */
test('register: выдаёт токен, в D1 только SHA-256; повтор того же device_id → 409; неверный UUID → 400', async () => {
  const s = await setup();
  const id = crypto.randomUUID();
  const r = await s.call('POST', '/api/device/register', { body: { deviceId: id } });
  assert.equal(r.status, 201); assert.equal(r.data.deviceId, id); assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/);
  const row = s.db.q('SELECT * FROM devices')[0];
  assert.equal(row.token_hash, await sha256Hex(r.data.token));
  assert.ok(!JSON.stringify(s.db.q('SELECT * FROM devices')).includes(r.data.token), 'исходный токен не хранится');
  const again = await s.call('POST', '/api/device/register', { body: { deviceId: id } });
  assert.equal(again.status, 409, 'знание UUID не даёт нового токена');
  assert.equal((await s.call('POST', '/api/device/register', { body: { deviceId: 'not-a-uuid' } })).status, 400);
  assert.equal((await s.call('POST', '/api/device/register', { body: {}, ct: 'text/plain' })).status, 415, 'только JSON (нет простых кросс-сайтовых форм)');
  const gen = await s.call('POST', '/api/device/register', { body: {} });
  assert.equal(gen.status, 201); assert.match(gen.data.deviceId, /^[0-9a-f-]{36}$/);
});

test('auth: без заголовка / чужой токен / мусор / токен в URL → 401; верный → 200', async () => {
  const s = await setup();
  const a = await s.device(); const b = await s.device();
  assert.equal((await s.call('GET', '/api/push/status')).status, 401);
  assert.equal((await s.call('GET', '/api/push/status', { auth: { deviceId: a.deviceId, token: b.token } })).status, 401);
  assert.equal((await s.call('GET', '/api/push/status', { auth: { deviceId: a.deviceId, token: 'x' } })).status, 401);
  assert.equal((await s.call('GET', `/api/push/status?token=${a.token}`)).status, 401);
  for (const path of ['/api/push/subscribe', '/api/push/unsubscribe', '/api/notifications/sync', '/api/notifications/test']) {
    assert.equal((await s.call('POST', path, { body: {} })).status, 401, path);
    assert.equal((await s.call('POST', path, { body: {}, auth: { deviceId: a.deviceId, token: b.token } })).status, 401, path);
  }
  const ok = await s.call('GET', '/api/push/status', { auth: a });
  assert.equal(ok.status, 200); assert.equal(ok.data.subscription, 'none');
});

/* ---------- подписка ---------- */
test('subscribe: только push-сервисы браузеров и корректные ключи; endpoint не возвращается', async () => {
  const s = await setup();
  const auth = await s.device(); const ua = await makeUserAgent();
  const keys = { p256dh: ua.p256dh, auth: ua.auth };
  for (const endpoint of ['https://evil.example/push', 'http://web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'http://127.0.0.1:9/x', 'javascript:alert(1)']) {
    assert.equal((await s.call('POST', '/api/push/subscribe', { auth, body: { endpoint, keys } })).status, 400, endpoint);
  }
  assert.equal((await s.call('POST', '/api/push/subscribe', { auth, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'AAAA', auth: ua.auth } } })).status, 400);
  const ok = await s.call('POST', '/api/push/subscribe', { auth, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys } });
  assert.equal(ok.status, 200);
  const st = await s.call('GET', '/api/push/status', { auth });
  assert.equal(st.data.subscription, 'active');
  assert.ok(!JSON.stringify([ok.data, st.data]).includes('fcm.googleapis.com'), 'endpoint не выдаётся наружу');
});

test('resubscribe тем же endpoint — одна строка; новый endpoint заменяет старый; endpoint переходит к новому устройству', async () => {
  const s = await setup();
  const auth = await s.device(); const ua = await makeUserAgent();
  const keys = { p256dh: ua.p256dh, auth: ua.auth };
  const e1 = 'https://web.push.apple.com/one'; const e2 = 'https://web.push.apple.com/two';
  await s.call('POST', '/api/push/subscribe', { auth, body: { endpoint: e1, keys } });
  await s.call('POST', '/api/push/subscribe', { auth, body: { endpoint: e1, keys } });
  assert.equal(s.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 1);
  await s.call('POST', '/api/push/subscribe', { auth, body: { endpoint: e2, keys } });
  assert.deepEqual(s.db.q('SELECT endpoint FROM push_subscriptions').map((r) => r.endpoint), [e2], 'старый endpoint удалён');
  const other = await s.device();
  await s.call('POST', '/api/push/subscribe', { auth: other, body: { endpoint: e2, keys } });
  const rows = s.db.q('SELECT device_id FROM push_subscriptions');
  assert.equal(rows.length, 1); assert.equal(rows[0].device_id, other.deviceId, 'UNIQUE endpoint: подписка у текущего устройства');
});

test('unsubscribe: подписка и зеркало правил удаляются, устройство остаётся; cron больше ничего не шлёт', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  const r = await s.call('POST', '/api/push/unsubscribe', { auth });
  assert.equal(r.status, 200);
  assert.equal(s.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 0);
  assert.equal(s.db.q('SELECT COUNT(*) n FROM notification_rules')[0].n, 0);
  assert.equal(s.db.q('SELECT COUNT(*) n FROM devices')[0].n, 1);
  await s.cron(M(2031, 3, 10, 9, 0));
  assert.equal(s.push.log.length, 0);
});

/* ---------- синхронизация правил ---------- */
test('sync: правила сохраняются без текста; next_fire_at в UTC из локального времени и timezone', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  const r = await s.sync(auth, [R({ id: 'm1', time: '21:00', text: 'Метформин 500 мг' }), R({ id: 'w1', type: 'water', repeat: 'interval', intervalMinutes: 120, startTime: '08:00', endTime: '22:00' })]);
  assert.equal(r.status, 200); assert.equal(r.data.rules, 2);
  const rows = s.db.q('SELECT * FROM notification_rules ORDER BY client_rule_id');
  assert.ok(!JSON.stringify(rows).includes('Метформин'), 'текст напоминания не попадает на сервер');
  const m1 = rows.find((x) => x.client_rule_id === 'm1');
  assert.equal(m1.next_fire_at, M(2031, 3, 10, 21, 0)); assert.equal(m1.timezone, TZ); assert.equal(m1.local_time, '21:00');
  assert.equal(rows.find((x) => x.client_rule_id === 'w1').next_fire_at, M(2031, 3, 10, 10, 0), 'вода: следующий слот после 08:00');
  const st = await s.call('GET', '/api/push/status', { auth });
  assert.equal(st.data.rules, 2); assert.equal(st.data.enabledRules, 2); assert.ok(st.data.lastSyncAt);
});

test('sync: неверные данные → 400, ничего не меняется', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R()]);
  const bad = [
    [R({ type: 'diagnosis' })], [R({ time: '25:00' })], [R({ repeat: 'hourly' })], [R({ id: '../x' })],
    [R({ repeat: 'interval', intervalMinutes: 5 })], [R({ repeat: 'weekly', days: [9] })], [R({ repeat: 'once', date: '2031-13-01' })],
    [R(), R()], 'nope', Array.from({ length: 30 }, (_, i) => R({ id: `r${i}` })),
  ];
  for (const rules of bad) assert.equal((await s.sync(auth, rules)).status, 400, JSON.stringify(rules).slice(0, 60));
  assert.equal((await s.sync(auth, [R()], { tz: 'Mars/Olympus' })).status, 400);
  assert.equal(s.db.q('SELECT COUNT(*) n FROM notification_rules')[0].n, 1);
});

test('sync: устаревший rev (пришёл позже нового) → 409 и не перезаписывает новое', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  assert.equal((await s.sync(auth, [R({ time: '10:00' })], { r: 200 })).status, 200);
  const stale = await s.sync(auth, [R({ time: '07:00' })], { r: 150 });
  assert.equal(stale.status, 409); assert.equal(stale.data.rev, 200);
  assert.equal(s.db.q('SELECT local_time FROM notification_rules')[0].local_time, '10:00');
  assert.equal((await s.sync(auth, [R({ time: '10:00' })], { r: 200 })).status, 200, 'повтор того же rev идемпотентен');
});

test('sync: удаление правила (нет в списке), выключение (next_fire_at NULL), неизменное расписание сохраняет next_fire_at', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ id: 'a', time: '09:00' }), R({ id: 'b', time: '10:00' })]);
  /* cron уже сдвинул a на завтра — повторная синхронизация того же расписания не должна вернуть сегодняшние 09:00 */
  await s.cron(M(2031, 3, 10, 9, 0));
  const nextA = s.db.q("SELECT next_fire_at FROM notification_rules WHERE client_rule_id = 'a'")[0].next_fire_at;
  assert.equal(nextA, M(2031, 3, 11, 9, 0));
  await s.sync(auth, [R({ id: 'a', time: '09:00' }), R({ id: 'b', time: '10:00', enabled: false })], { now: M(2031, 3, 10, 9, 0) + 5000 });
  const rows = Object.fromEntries(s.db.q('SELECT client_rule_id, enabled, next_fire_at FROM notification_rules').map((r) => [r.client_rule_id, r]));
  assert.equal(rows.a.next_fire_at, nextA, 'не пересчитано — не будет второго 09:00');
  assert.equal(rows.b.enabled, 0); assert.equal(rows.b.next_fire_at, null);
  await s.sync(auth, [R({ id: 'a', time: '09:00' })]);
  assert.deepEqual(s.db.q('SELECT client_rule_id FROM notification_rules').map((r) => r.client_rule_id), ['a'], 'b удалено');
});

/* ---------- тестовый push ---------- */
test('test push: только своему устройству, payload зашифрован, VAPID подписан; rate limit 20 с', async () => {
  const s = await setup();
  const { auth, ua, endpoint } = await s.subscribed();
  const other = await s.subscribed();
  const t0 = M(2031, 3, 10, 12, 0);
  const r = await s.call('POST', '/api/notifications/test', { auth, now: t0, body: { endpoint: other.endpoint } });
  assert.equal(r.status, 200); assert.equal(r.data.result, 'sent');
  assert.equal(s.push.log.length, 1); assert.equal(s.push.log[0].url, endpoint, 'чужой endpoint из тела запроса игнорируется');
  const h = s.push.log[0].headers;
  assert.equal(h['Content-Encoding'], 'aes128gcm'); assert.ok(Number(h.TTL) > 0);
  const claims = await verifyVapid(h.Authorization, VAPID.publicKey, endpoint);
  assert.ok(claims && claims.sub === 'mailto:test@example.invalid' && claims.exp > t0 / 1000);
  const p = await decrypt(ua, s.push.log[0].body);
  assert.equal(p.type, 'test'); assert.equal(p.target, '#/notifications'); assert.match(p.occurrenceId, /^test@/);
  const again = await s.call('POST', '/api/notifications/test', { auth, now: t0 + 5000 });
  assert.equal(again.status, 429); assert.equal(again.data.retryAfter, 15); assert.equal(again.headers.get('Retry-After'), '15');
  assert.equal(s.push.log.length, 1);
  assert.equal((await s.call('POST', '/api/notifications/test', { auth, now: t0 + 20000 })).status, 200);
  const nosub = await s.device();
  assert.equal((await s.call('POST', '/api/notifications/test', { auth: nosub })).status, 409);
});

test('test push: VAPID не настроен → 503 без утечки деталей', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  delete s.env.VAPID_PRIVATE_KEY;
  const r = await s.call('POST', '/api/notifications/test', { auth });
  assert.equal(r.status, 503); assert.equal(r.data.error, 'push_not_configured');
});

/* ---------- cron ---------- */
test('cron: due-выборка использует частичный индекс по next_fire_at (без скана таблицы)', async () => {
  const s = await setup();
  const plan = s.db.raw.prepare(`EXPLAIN QUERY PLAN SELECT r.* FROM notification_rules r
    WHERE r.enabled = 1 AND r.next_fire_at IS NOT NULL AND r.next_fire_at <= ?
      AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.device_id = r.device_id AND s.active = 1)
    ORDER BY r.next_fire_at LIMIT ?`).all(0, 40).map((x) => x.detail).join(' | ');
  assert.match(plan, /idx_notification_rules_due/, plan);
  assert.ok(!/SCAN r\b(?! USING)/.test(plan), plan);
});

test('cron: ежедневное правило — ровно один push в 09:00 по Мадриду, payload нейтральный, next_fire_at → завтра', async () => {
  const s = await setup();
  const { auth, ua } = await s.subscribed();
  await s.sync(auth, [R({ id: 'm1', type: 'meds', time: '09:00', text: 'Метформин 500 мг' })]);
  await cronEveryMinute(s, M(2031, 3, 10, 8, 55), M(2031, 3, 10, 9, 10));
  const p = await sentPayloads(s, ua);
  assert.equal(p.length, 1);
  assert.deepEqual(Object.keys(p[0]).sort(), ['body', 'occurrenceId', 'scheduledAt', 'target', 'title', 'type', 'v']);
  assert.equal(p[0].body, 'Проверьте напоминание LexLife'); assert.equal(p[0].target, '#/meds');
  assert.equal(p[0].occurrenceId, 'm1@2031-03-10T09:00'); assert.equal(p[0].scheduledAt, new Date(M(2031, 3, 10, 9, 0)).toISOString());
  assert.ok(!JSON.stringify(p).includes('Метформин'));
  assert.equal(s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at, M(2031, 3, 11, 9, 0));
  const d = s.db.q('SELECT * FROM notification_deliveries');
  assert.equal(d.length, 1); assert.equal(d[0].status, 'sent'); assert.equal(d[0].attempts, 1);
  assert.ok(s.push.log[0].headers.Topic && s.push.log[0].headers.Topic.length <= 32, 'Topic для схлопывания дублей у push-сервиса');
  assert.equal((await s.call('GET', '/api/push/status', { auth })).data.lastPushAt, new Date(M(2031, 3, 10, 9, 0)).toISOString());
});

test('дубли: два параллельных cron, повторный trigger той же минуты, повтор после успеха — один push', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ id: 'a', time: '09:00' }), R({ id: 'b', type: 'water', repeat: 'interval', intervalMinutes: 60, startTime: '09:00', endTime: '12:00' })]);
  const t = M(2031, 3, 10, 9, 0);
  const [x, y] = await Promise.all([s.cron(t), s.cron(t)]);
  assert.equal(x.claimed + y.claimed, 2, 'каждая occurrence занята ровно одним запуском');
  assert.equal(x.lost + y.lost, 2);
  await s.cron(t); await s.cron(t + 30000); await s.cron(t + MIN);
  assert.equal(s.push.log.length, 2);
  assert.equal(s.db.q("SELECT COUNT(*) n FROM notification_deliveries WHERE status = 'sent'")[0].n, 2);
  /* прямая попытка вставить ту же occurrence ещё раз запрещена схемой */
  const rule = s.db.q("SELECT id FROM notification_rules WHERE client_rule_id = 'a'")[0];
  assert.throws(() => s.db.raw.prepare(`INSERT INTO notification_deliveries (rule_id, scheduled_fire_at, occurrence_id, status, created_at) VALUES (?, ?, 'x', 'claimed', 0)`).run(rule.id, t), /UNIQUE/);
});

test('cron: 410 Gone → подписка удалена, правила сняты с расписания; повторная подписка возвращает их', async () => {
  const s = await setup({ responder: () => 410 });
  const { auth, ua } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  await s.cron(M(2031, 3, 10, 9, 0));
  assert.equal(s.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 0);
  assert.equal(s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at, null);
  const d = s.db.q('SELECT status, error_code FROM notification_deliveries')[0];
  assert.equal(d.status, 'failed'); assert.equal(d.error_code, 'gone:410');
  await cronEveryMinute(s, M(2031, 3, 11, 8, 59), M(2031, 3, 11, 9, 2));
  assert.equal(s.push.log.length, 1, 'на удалённую подписку больше не шлём');
  s.push.set(() => 201);
  await s.call('POST', '/api/push/subscribe', { auth, now: M(2031, 3, 11, 12, 0), body: { endpoint: 'https://web.push.apple.com/new', keys: { p256dh: ua.p256dh, auth: ua.auth } } });
  assert.equal(s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at, M(2031, 3, 12, 9, 0));
});

test('cron: временная ошибка 500 → retry через 1 мин → доставлено; одна occurrence', async () => {
  const s = await setup({ responder: (url, n) => (n === 0 ? 500 : 201) });
  const { auth, ua } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  await cronEveryMinute(s, M(2031, 3, 10, 9, 0), M(2031, 3, 10, 9, 5));
  assert.deepEqual(s.push.log.map((x) => x.status), [500, 201]);
  const d = s.db.q('SELECT * FROM notification_deliveries');
  assert.equal(d.length, 1); assert.equal(d[0].status, 'sent'); assert.equal(d[0].attempts, 2);
  const p = await sentPayloads(s, ua);
  assert.equal(p[0].occurrenceId, 'r1@2031-03-10T09:00', 'повтор — та же occurrence (тот же tag в SW)');
  const sub = s.db.q('SELECT failure_count, last_failure_at, last_success_at FROM push_subscriptions')[0];
  assert.equal(sub.failure_count, 0); assert.ok(sub.last_failure_at && sub.last_success_at);
});

test('cron: сеть недоступна / 503 постоянно → не больше MAX_ATTEMPTS попыток, затем failed; без бесконечных повторов', async () => {
  const s = await setup({ responder: (url, n) => (n % 2 ? 503 : 'network') });
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  await cronEveryMinute(s, M(2031, 3, 10, 9, 0), M(2031, 3, 10, 9, 30));
  assert.equal(s.push.log.length, MAX_ATTEMPTS);
  const d = s.db.q('SELECT status, attempts FROM notification_deliveries')[0];
  assert.equal(d.status, 'failed'); assert.equal(d.attempts, MAX_ATTEMPTS);
  assert.equal(s.db.q('SELECT failure_count FROM push_subscriptions')[0].failure_count, MAX_ATTEMPTS);
});

test('cron: 403 (неверный VAPID) три раза подряд → подписка деактивирована', async () => {
  const s = await setup({ responder: () => 403 });
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ type: 'water', repeat: 'interval', intervalMinutes: 60, startTime: '09:00', endTime: '20:00' })]);
  await cronEveryMinute(s, M(2031, 3, 10, 9, 0), M(2031, 3, 10, 14, 0));
  assert.equal(s.push.log.length, 3);
  assert.equal(s.db.q('SELECT COUNT(*) n FROM push_subscriptions')[0].n, 0);
});

test('cron: опоздание больше 10 мин (cron стоял) → skipped без push, следующее — по расписанию', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  await s.cron(M(2031, 3, 10, 9, 0) + NOTIF_GRACE_MS + MIN);
  assert.equal(s.push.log.length, 0);
  assert.equal(s.db.q('SELECT status FROM notification_deliveries')[0].status, 'skipped');
  assert.equal(s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at, M(2031, 3, 11, 9, 0));
});

test('Worker оборвался после claim: строка claimed не повторяется, через 5 мин помечается unknown', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  const t = M(2031, 3, 10, 9, 0);
  const rule = s.db.q('SELECT id FROM notification_rules')[0];
  /* имитация: claim прошёл, отправка не завершилась (next_fire_at уже сдвинут) */
  s.db.raw.prepare(`INSERT INTO notification_deliveries (rule_id, scheduled_fire_at, occurrence_id, status, created_at) VALUES (?, ?, 'r1@2031-03-10T09:00', 'claimed', ?)`).run(rule.id, t, t);
  s.db.raw.prepare('UPDATE notification_rules SET next_fire_at = ? WHERE id = ?').run(M(2031, 3, 11, 9, 0), rule.id);
  await cronEveryMinute(s, t, t + 8 * MIN);
  assert.equal(s.push.log.length, 0, 'максимум одна доставка: неизвестный исход не повторяется');
  await maintenance(s.db, t + STUCK_CLAIM_MS + MIN);
  assert.equal(s.db.q('SELECT status FROM notification_deliveries')[0].status, 'unknown');
});

test('cron: изменение правила между выборкой и claim — старое время не отправляется', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  const t = M(2031, 3, 10, 9, 0);
  /* sync с новым временем «вклинивается» после SELECT due */
  const origBatch = s.db.batch.bind(s.db);
  let once = true;
  s.db.batch = async (stmts) => { if (once) { once = false; await s.sync(auth, [R({ time: '18:00' })], { now: t }); } return origBatch(stmts); };
  await s.cron(t);
  s.db.batch = origBatch;
  assert.equal(s.push.log.length, 0);
  assert.equal(s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at, M(2031, 3, 10, 18, 0));
});

/* ---------- расписание в timezone ---------- */
test('еженедельное (пн, ср 08:00) и будни: только нужные дни недели за 2 недели', async () => {
  const s = await setup();
  const { auth, ua } = await s.subscribed();
  await s.sync(auth, [R({ id: 'w', type: 'weight', repeat: 'weekly', days: [1, 3], time: '08:00' }), R({ id: 'p', type: 'pressure', repeat: 'weekdays', time: '07:30' })], { now: M(2031, 3, 10, 7, 0) });
  for (let day = 10; day < 24; day++) {
    for (const [h, mi] of [[7, 30], [8, 0]]) await s.cron(M(2031, 3, day, h, mi));
  }
  const p = await sentPayloads(s, ua);
  const w = p.filter((x) => x.type === 'weight').map((x) => x.occurrenceId);
  assert.deepEqual(w, ['w@2031-03-10T08:00', 'w@2031-03-12T08:00', 'w@2031-03-17T08:00', 'w@2031-03-19T08:00']); // 10.03.2031 — понедельник
  assert.equal(p.filter((x) => x.type === 'pressure').length, 10, 'будни: 10 из 14 дней');
});

test('разовое правило: срабатывает один раз, completed_at, дальше ничего', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ id: 'o', type: 'tests', repeat: 'once', date: '2031-03-12', time: '07:45' })]);
  assert.equal(s.db.q('SELECT fire_at FROM notification_rules')[0].fire_at, M(2031, 3, 12, 7, 45));
  await cronEveryMinute(s, M(2031, 3, 12, 7, 40), M(2031, 3, 12, 7, 55));
  await s.cron(M(2031, 3, 13, 7, 45));
  assert.equal(s.push.log.length, 1);
  const r = s.db.q('SELECT next_fire_at, completed_at FROM notification_rules')[0];
  assert.equal(r.next_fire_at, null); assert.ok(r.completed_at);
  /* повторная синхронизация без изменений не «перезапускает» выполненное разовое правило */
  await s.sync(auth, [R({ id: 'o', type: 'tests', repeat: 'once', date: '2031-03-12', time: '07:45' })], { now: M(2031, 3, 12, 8, 0) });
  assert.ok(s.db.q('SELECT completed_at FROM notification_rules')[0].completed_at);
  /* прошедшая дата → не планируется */
  await s.sync(auth, [R({ id: 'o', type: 'tests', repeat: 'once', date: '2031-03-01', time: '07:45' })], { now: M(2031, 3, 12, 8, 0) });
  assert.equal(s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at, null);
});

test('вода: окно через полночь 22:00–02:00 каждый час → 22,23,00,01,02; выключение останавливает', async () => {
  const s = await setup();
  const { auth, ua } = await s.subscribed();
  const water = R({ id: 'wa', type: 'water', repeat: 'interval', intervalMinutes: 60, startTime: '22:00', endTime: '02:00' });
  await s.sync(auth, [water], { now: M(2031, 3, 10, 21, 0) });
  await cronEveryMinute(s, M(2031, 3, 10, 21, 50), M(2031, 3, 11, 2, 30));
  const p = await sentPayloads(s, ua);
  assert.deepEqual(p.map((x) => x.occurrenceId), ['wa@2031-03-10T22:00', 'wa@2031-03-10T23:00', 'wa@2031-03-11T00:00', 'wa@2031-03-11T01:00', 'wa@2031-03-11T02:00']);
  assert.ok(p.every((x) => x.body === 'Пора выпить воду' && x.target === '#/metric/water'));
  await s.sync(auth, [{ ...water, enabled: false }], { now: M(2031, 3, 11, 12, 0) });
  await cronEveryMinute(s, M(2031, 3, 11, 21, 55), M(2031, 3, 11, 23, 5));
  assert.equal(s.push.log.length, 5);
});

test('Europe/Madrid DST: весной 02:30 не существует → 03:30; осенью 02:30 дважды → один push; ежедневно 1 раз в сутки', async () => {
  const s = await setup();
  const { auth, ua } = await s.subscribed();
  await s.sync(auth, [R({ id: 'd', time: '02:30' }), R({ id: 'n', time: '09:00' })], { now: M(2031, 3, 29, 12, 0) });
  /* 30.03.2031 — переход на летнее время (02:00 → 03:00) */
  await cronEveryMinute(s, Date.UTC(2031, 2, 29, 23, 0), Date.UTC(2031, 2, 30, 9, 0));
  let p = await sentPayloads(s, ua);
  assert.deepEqual(p.map((x) => x.occurrenceId), ['d@2031-03-30T03:30', 'n@2031-03-30T09:00']);
  assert.equal(p[0].scheduledAt, '2031-03-30T01:30:00.000Z');
  assert.equal(p[1].scheduledAt, '2031-03-30T07:00:00.000Z', '09:00 CEST = 07:00 UTC (а не «+24 ч» от 08:00 UTC)');
  /* 26.10.2031 — возврат на зимнее (03:00 → 02:00): 02:30 бывает дважды */
  await s.sync(auth, [R({ id: 'd', time: '02:30' }), R({ id: 'n', time: '09:00' })], { now: M(2031, 10, 25, 12, 0) });
  s.push.log.length = 0;
  await cronEveryMinute(s, Date.UTC(2031, 9, 25, 22, 0), Date.UTC(2031, 9, 26, 9, 0));
  p = await sentPayloads(s, ua);
  assert.deepEqual(p.map((x) => x.occurrenceId), ['d@2031-10-26T02:30', 'n@2031-10-26T09:00']);
  assert.equal(p[0].scheduledAt, '2031-10-26T00:30:00.000Z', 'первое 02:30 (CEST)');
  assert.equal(p[1].scheduledAt, '2031-10-26T08:00:00.000Z', '09:00 CET = 08:00 UTC');
});

test('смена года и другая timezone устройства: 31.12 23:30 → 01.01 08:00; America/New_York', async () => {
  const s = await setup();
  const { auth, ua } = await s.subscribed();
  const NY = 'America/New_York';
  await s.sync(auth, [R({ id: 'y', time: '08:00' })], { tz: NY, now: zonedToUtc(2031, 12, 31, 23, 30, NY) });
  const next = s.db.q('SELECT next_fire_at FROM notification_rules')[0].next_fire_at;
  assert.equal(wallLabel(next, NY), '2032-01-01T08:00');
  await s.cron(next);
  assert.equal((await sentPayloads(s, ua))[0].occurrenceId, 'y@2032-01-01T08:00');
});

/* ---------- обслуживание и приватность ---------- */
test('maintenance: журнал старше 30 дней удаляется, брошенные устройства без подписки — через 90 дней', async () => {
  const s = await setup();
  const { auth } = await s.subscribed();
  await s.sync(auth, [R({ time: '09:00' })]);
  await s.cron(M(2031, 3, 10, 9, 0));
  const idle = await s.device();
  s.db.raw.prepare('UPDATE devices SET updated_at = 0 WHERE id = ?').run(idle.deviceId);
  await maintenance(s.db, M(2031, 4, 20, 0, 0));
  assert.equal(s.db.q('SELECT COUNT(*) n FROM notification_deliveries')[0].n, 0);
  assert.deepEqual(s.db.q('SELECT id FROM devices').map((r) => r.id), [auth.deviceId], 'активное устройство остаётся');
});

test('приватность: в D1 нет медицинских полей; ответы API без endpoint/ключей', async () => {
  const s = await setup();
  const cols = s.db.q("SELECT name FROM pragma_table_info('notification_rules')").map((r) => r.name).join(',');
  assert.ok(!/text|note|value|dose|name|diagnos/i.test(cols.replace(/client_rule_id|timezone|local_time/g, '')), cols);
  const tables = s.db.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
  assert.deepEqual(tables, ['devices', 'notification_deliveries', 'notification_rules', 'push_subscriptions']);
  const { auth, ua } = await s.subscribed();
  const all = JSON.stringify([await s.call('GET', '/api/push/status', { auth }), await s.sync(auth, [R()])]);
  assert.ok(!all.includes('push.apple.com') && !all.includes(ua.p256dh) && !all.includes(ua.auth));
});

/* ---------- Worker: статика, маршруты, headers ---------- */
test('Worker fetch: /index.html без редиректа, security headers, /api JSON 404, POST к статике → 405', async () => {
  const seen = [];
  const env = {
    DB: createD1(), VAPID_PUBLIC_KEY: VAPID.publicKey,
    ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }); } },
  };
  const get = (p, init) => worker.fetch(new Request(`https://lexlife.test${p}`, init), env, {});
  const r1 = await get('/index.html');
  assert.equal(r1.status, 200); assert.equal(seen[0], '/');
  for (const h of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) assert.ok(r1.headers.get(h), h);
  assert.match(r1.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal((await get('/sw.js')).headers.get('Cache-Control'), 'no-cache');
  const api = await get('/api/nope');
  assert.equal(api.status, 404); assert.equal(api.headers.get('Cache-Control'), 'no-store'); assert.ok(api.headers.get('Content-Security-Policy'));
  assert.equal((await get('/api/config')).status, 200);
  assert.equal((await get('/api/config', { method: 'POST' })).status, 405);
  assert.equal((await get('/', { method: 'POST' })).status, 405);
  assert.ok(!(await get('/api/config')).headers.get('Access-Control-Allow-Origin'), 'CORS не открыт');
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`  ok — ${t.name}`); } catch (err) { failed++; console.log(`  FAIL — ${t.name}\n    ${err && err.stack}`); }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
