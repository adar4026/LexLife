/* =========================================================
   worker/api.js — HTTP API фоновых уведомлений (тот же origin,
   что и приложение: CORS не нужен и не разрешается).

   GET  /api/status                 — здоровье: D1, VAPID настроен, сборка (без авторизации)
   GET  /api/config                 — публичный VAPID-ключ (без авторизации)
   POST /api/device/register        — новое устройство → токен (один раз)
   POST /api/push/subscribe         — PushSubscription текущего устройства
   POST /api/push/unsubscribe       — отключить фоновые уведомления
   GET  /api/push/status            — состояние для экрана уведомлений
   POST /api/notifications/sync     — полное зеркало правил (rev)
   POST /api/notifications/test     — тестовый push этому устройству
   GET  /api/push/deliveries        — журнал доставки устройства (?occurrence=<id> — одна)
   POST /api/push/ack               — Service Worker показал push (без авторизации:
                                      ключ доставки из зашифрованного payload)

   Всё, кроме config/register, требует Authorization: Bearer <id>.<token>.
   POST — только application/json (кросс-сайтовая форма не пройдёт).
   В ответах нет endpoint и ключей подписки.
   ========================================================= */

import { authenticate, sha256Hex, newToken, UUID_RE } from './auth.js';
import { normalizeRules, checkTimeZone, rowToRule, scheduleSignature, nextFireFor, RuleError } from './rules.js';
import { isAllowedEndpoint, validSubscriptionKeys } from './webpush.js';
import { pushToDevice, activeSubscription, ConfigError } from './delivery.js';
import { devTag } from './log.js';

export const MAX_BODY = 32 * 1024;
export const DEFAULT_TEST_INTERVAL_SEC = 20;

export const json = (status, data, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
const fail = (status, error, extra, headers) => json(status, { error, ...(extra || {}) }, headers);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'json_required');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'too_large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large');
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch { throw new HttpError(400, 'bad_json'); }
}

/* ---------- обработчики ---------- */

async function register(request, env, { now }) {
  const body = await readJson(request);
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: `register:${ip}` });
    if (!success) throw new HttpError(429, 'rate_limited');
  }
  const deviceId = body.deviceId == null ? crypto.randomUUID() : body.deviceId;
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) throw new HttpError(400, 'bad_device_id');
  const token = newToken();
  const r = await env.DB.prepare(`INSERT INTO devices (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
                                  ON CONFLICT (id) DO NOTHING`).bind(deviceId, await sha256Hex(token), now, now).run();
  /* занятый id не перевыпускается: иначе знание UUID давало бы чужой токен */
  if (r.meta.changes !== 1) throw new HttpError(409, 'device_exists');
  return json(201, { deviceId, token });
}

/* Пересчитать next_fire_at правил устройства, которые не запланированы
   (после потери/смены подписки), — только вперёд от now */
async function rearmDevice(db, deviceId, now) {
  const { results } = await db.prepare(`SELECT * FROM notification_rules WHERE device_id = ? AND enabled = 1
      AND (next_fire_at IS NULL OR next_fire_at < ?) AND completed_at IS NULL`).bind(deviceId, now).all();
  const stmts = results.map((row) => db.prepare('UPDATE notification_rules SET next_fire_at = ?, updated_at = ? WHERE id = ?')
    .bind(nextFireFor(rowToRule(row), now, row.timezone), now, row.id));
  if (stmts.length) await db.batch(stmts);
}

async function subscribe(request, env, device, { now }) {
  const body = await readJson(request);
  const endpoint = body.endpoint;
  const keys = body.keys || {};
  if (!isAllowedEndpoint(endpoint, { allowLocal: env.DEV_ALLOW_LOCAL_PUSH === '1' })) throw new HttpError(400, 'bad_endpoint');
  if (!validSubscriptionKeys(keys.p256dh, keys.auth)) throw new HttpError(400, 'bad_keys');
  const db = env.DB;
  await db.batch([
    /* одна активная подписка на устройство: старый endpoint удаляется */
    db.prepare('DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint <> ?').bind(device.id, endpoint),
    /* endpoint уже был у другого устройства этого браузера (restore/переустановка) — переходит сюда */
    db.prepare(`INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, active, created_at, updated_at, failure_count)
                VALUES (?, ?, ?, ?, 1, ?, ?, 0)
                ON CONFLICT (endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh,
                  auth = excluded.auth, active = 1, failure_count = 0, updated_at = excluded.updated_at`)
      .bind(device.id, endpoint, keys.p256dh, keys.auth, now, now),
    db.prepare('UPDATE devices SET updated_at = ? WHERE id = ?').bind(now, device.id),
  ]);
  await rearmDevice(db, device.id, now);
  return json(200, { subscription: 'active' });
}

async function unsubscribe(request, env, device, { now }) {
  await readJson(request);
  const db = env.DB;
  /* минимальное хранение: подписка и зеркало правил удаляются, устройство (токен) остаётся */
  await db.batch([
    db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').bind(device.id),
    db.prepare('DELETE FROM notification_rules WHERE device_id = ?').bind(device.id),
    db.prepare('UPDATE devices SET rules_rev = 0, last_sync_at = NULL, updated_at = ? WHERE id = ?').bind(now, device.id),
  ]);
  return json(200, { subscription: 'none' });
}

/* status вызывается и при каждом запуске приложения (pushClient.checkSubscription):
   last_seen_at — для диагностики (cron findStaleSubscriptions), подписки не удаляет */
async function status(env, device, { now }) {
  const db = env.DB;
  await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, device.id).run();
  const sub = await activeSubscription(db, device.id);
  const agg = await db.prepare(`SELECT COUNT(*) AS rules, SUM(enabled) AS enabled, MIN(CASE WHEN enabled = 1 THEN next_fire_at END) AS next_fire_at
                                FROM notification_rules WHERE device_id = ?`).bind(device.id).first();
  return json(200, {
    subscription: sub ? 'active' : 'none',
    lastPushAt: sub && sub.last_success_at ? new Date(sub.last_success_at).toISOString() : null,
    lastFailureAt: sub && sub.last_failure_at ? new Date(sub.last_failure_at).toISOString() : null,
    lastAckAt: sub && sub.last_ack_at ? new Date(sub.last_ack_at).toISOString() : null,
    lastSyncAt: device.last_sync_at ? new Date(device.last_sync_at).toISOString() : null,
    rulesRev: device.rules_rev,
    rules: agg.rules || 0,
    enabledRules: agg.enabled || 0,
    nextFireAt: agg.next_fire_at ? new Date(agg.next_fire_at).toISOString() : null,
    timezone: device.timezone,
  });
}

/* Полное зеркало правил устройства. rev монотонен: устаревший запрос
   (пришёл позже нового) ничего не меняет. Всё — одной транзакцией. */
async function sync(request, env, device, { now }) {
  const body = await readJson(request);
  const rev = body.rev;
  if (!Number.isSafeInteger(rev) || rev <= 0) throw new HttpError(400, 'bad_rev');
  let rules; let tz;
  try { tz = checkTimeZone(body.timezone); rules = normalizeRules(body.rules); } catch (e) {
    if (e instanceof RuleError) throw new HttpError(400, e.message.replace(/\s+/g, '_'));
    throw e;
  }
  if (rev < device.rules_rev) return fail(409, 'stale_rev', { rev: device.rules_rev });

  const db = env.DB;
  const { results: existing } = await db.prepare('SELECT * FROM notification_rules WHERE device_id = ?').bind(device.id).all();
  const byId = new Map(existing.map((row) => [row.client_rule_id, row]));
  const guard = 'EXISTS (SELECT 1 FROM devices WHERE id = ? AND rules_rev = ?)';

  const stmts = [
    db.prepare('UPDATE devices SET rules_rev = ?, timezone = ?, last_sync_at = ?, updated_at = ? WHERE id = ? AND rules_rev <= ?')
      .bind(rev, tz, now, now, device.id, rev),
  ];
  for (const r of rules) {
    const old = byId.get(r.id);
    const recompute = !old
      || scheduleSignature(rowToRule(old), old.timezone) !== scheduleSignature(r, tz)
      || (r.enabled && old.next_fire_at == null && old.completed_at == null);
    const next = nextFireFor(r, now, tz);
    const fireAt = r.repeat === 'once' ? nextFireFor({ ...r, enabled: true }, -8.64e15, tz) : null;
    stmts.push(db.prepare(`
      INSERT INTO notification_rules (device_id, client_rule_id, type, enabled, schedule_type, local_time, days_of_week,
        interval_minutes, window_start, window_end, once_date, timezone, next_fire_at, fire_at, completed_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE ${guard}
      ON CONFLICT (device_id, client_rule_id) DO UPDATE SET
        type = excluded.type, enabled = excluded.enabled, schedule_type = excluded.schedule_type,
        local_time = excluded.local_time, days_of_week = excluded.days_of_week, interval_minutes = excluded.interval_minutes,
        window_start = excluded.window_start, window_end = excluded.window_end, once_date = excluded.once_date,
        timezone = excluded.timezone,
        next_fire_at = CASE WHEN ? THEN excluded.next_fire_at ELSE notification_rules.next_fire_at END,
        fire_at = CASE WHEN ? THEN excluded.fire_at ELSE notification_rules.fire_at END,
        completed_at = CASE WHEN ? THEN NULL ELSE notification_rules.completed_at END,
        updated_at = excluded.updated_at`)
      .bind(device.id, r.id, r.type, r.enabled ? 1 : 0, r.repeat, r.time, r.days.length ? r.days.join(',') : null,
        r.intervalMinutes, r.startTime, r.endTime, r.date, tz, next, fireAt, now, now, device.id, rev,
        recompute ? 1 : 0, recompute ? 1 : 0, recompute ? 1 : 0));
  }
  stmts.push(db.prepare(`DELETE FROM notification_rules WHERE device_id = ?
      AND client_rule_id NOT IN (SELECT value FROM json_each(?)) AND ${guard}`)
    .bind(device.id, JSON.stringify(rules.map((r) => r.id)), device.id, rev));

  const res = await db.batch(stmts);
  if (res[0].meta.changes !== 1) {
    const cur = await db.prepare('SELECT rules_rev FROM devices WHERE id = ?').bind(device.id).first();
    return fail(409, 'stale_rev', { rev: cur ? cur.rules_rev : null });
  }
  return json(200, { rev, syncedAt: new Date(now).toISOString(), rules: rules.length });
}

async function testPush(request, env, device, { now, fetchImpl }) {
  await readJson(request);
  const intervalMs = (Number(env.PUSH_TEST_INTERVAL_SEC) || DEFAULT_TEST_INTERVAL_SEC) * 1000;
  const db = env.DB;
  if (!(await activeSubscription(db, device.id))) return fail(409, 'no_subscription');
  const gate = await db.prepare(`UPDATE devices SET last_test_push_at = ? WHERE id = ?
      AND (last_test_push_at IS NULL OR last_test_push_at <= ?)`).bind(now, device.id, now - intervalMs).run();
  if (gate.meta.changes !== 1) {
    const row = await db.prepare('SELECT last_test_push_at FROM devices WHERE id = ?').bind(device.id).first();
    const retryAfter = Math.max(1, Math.ceil(((row.last_test_push_at || now) + intervalMs - now) / 1000));
    return fail(429, 'rate_limited', { retryAfter }, { 'Retry-After': String(retryAfter) });
  }
  const payload = {
    v: 1, occurrenceId: `test@${now}`, type: 'test', title: 'LexLife',
    body: 'Фоновый push работает: сообщение прошло через сервер LexLife.',
    target: '#/notifications', scheduledAt: new Date(now).toISOString(),
  };
  const r = await pushToDevice(env, device.id, payload, { now, ttl: 120, fetchImpl });
  if (r.kind === 'ok') return json(200, { result: 'sent', sentAt: new Date(now).toISOString() });
  if (r.kind === 'no_subscription' || r.kind === 'gone') return fail(409, 'no_subscription');
  return fail(502, 'push_failed', { kind: r.kind, status: r.status });
}

/* Журнал доставки: почему конкретное срабатывание пришло / не пришло.
   Только своё устройство; без endpoint, ключей и ack_key. */
export const DELIVERY_REASON = {
  sent: 'push-сервис принял сообщение',
  claimed: 'отправляется',
  retry: 'временная ошибка push-сервиса, будет повтор',
  failed: 'не доставлено: ошибка push-сервиса или попытки исчерпаны',
  expired: 'не доставлено: окно повтора (10 мин) закрылось',
  skipped: 'пропущено: сервер опоздал больше чем на 10 мин, старое не отправляется',
  unknown: 'исход неизвестен: Worker прервался после отправки (повтора не было)',
};
const iso = (t) => (t ? new Date(t).toISOString() : null);
const deliveryView = (r) => ({
  occurrenceId: r.occurrence_id, type: r.type, status: r.status, reason: DELIVERY_REASON[r.status] || r.status,
  errorCode: r.error_code || null, attempts: r.attempts,
  scheduledAt: iso(r.scheduled_fire_at), sentAt: iso(r.sent_at), shownAt: iso(r.shown_at), ackedAt: iso(r.acked_at),
});
async function deliveries(request, env, device) {
  const occ = new URL(request.url).searchParams.get('occurrence');
  const db = env.DB;
  if (occ != null) {
    if (occ.length > 120) throw new HttpError(400, 'bad_occurrence');
    const row = await db.prepare(`SELECT d.*, r.type FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id
        WHERE r.device_id = ? AND d.occurrence_id = ? ORDER BY d.id DESC LIMIT 1`).bind(device.id, occ).first();
    return json(200, { delivery: row ? deliveryView(row) : null });
  }
  const { results } = await db.prepare(`SELECT d.*, r.type FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id
      WHERE r.device_id = ? ORDER BY d.scheduled_fire_at DESC, d.id DESC LIMIT 30`).bind(device.id).all();
  return json(200, { deliveries: results.map(deliveryView) });
}

/* Подтверждение показа от Service Worker'а. Ключ — 16 случайных байт из
   зашифрованного payload этой доставки: знает только получатель push. */
const ACK_KEY_RE = /^[A-Za-z0-9_-]{22}$/;
async function ack(request, env, { now }) {
  const body = await readJson(request);
  const id = body.d; const key = body.k;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof key !== 'string' || !ACK_KEY_RE.test(key)) throw new HttpError(400, 'bad_ack');
  const shown = Number.isFinite(body.shownAt) && body.shownAt > now - 30 * 86400000 && body.shownAt < now + 86400000 ? Math.round(body.shownAt) : now;
  const db = env.DB;
  const r = await db.prepare(`UPDATE notification_deliveries SET shown_at = COALESCE(shown_at, ?), acked_at = COALESCE(acked_at, ?)
      WHERE id = ? AND ack_key = ?`).bind(shown, now, id, key).run();
  if (r.meta.changes !== 1) return fail(404, 'unknown_delivery');
  const row = await db.prepare(`SELECT d.rule_id, d.scheduled_fire_at, d.sent_at, d.shown_at, d.occurrence_id, r.device_id, r.type
      FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id WHERE d.id = ?`).bind(id).first();
  if (row) {
    await db.prepare('UPDATE push_subscriptions SET last_ack_at = ? WHERE device_id = ? AND active = 1').bind(now, row.device_id).run();
    /* главный показатель доставки: насколько позже расписания iPhone реально показал уведомление */
    console.log(JSON.stringify({
      evt: 'ack', rule_id: row.rule_id, device: devTag(row.device_id), type: row.type, occurrence: row.occurrence_id,
      scheduled_at: iso(row.scheduled_fire_at), sent_lag_s: row.sent_at ? Math.round((row.sent_at - row.scheduled_fire_at) / 1000) : null,
      shown_lag_s: Math.round((row.shown_at - row.scheduled_fire_at) / 1000), ack_lag_s: Math.round((now - row.scheduled_fire_at) / 1000),
    }));
  }
  return json(200, { ok: true });
}

/* Здоровье сервиса для release-checklist и мониторинга. Без авторизации:
   только «работает / не работает» и номер сборки — ни устройств, ни ключей, ни счётчиков. */
async function health(request, env, { now }) {
  let db = 'error';
  try { const r = await env.DB.prepare('SELECT 1 AS ok').first(); if (r && r.ok === 1) db = 'ok'; } catch { db = 'error'; }
  let build = null;
  try {
    if (env.ASSETS) {
      const r = await env.ASSETS.fetch(new Request(new URL('/build-info.json', request.url)));
      if (r.ok) { const b = await r.json(); build = { version: b.version ?? null, sha: b.sha ?? null, builtAt: b.builtAt ?? null, cache: b.cache ?? null }; }
    }
  } catch { build = null; }
  const push = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT ? 'configured' : 'not_configured';
  const ok = db === 'ok' && push === 'configured';
  return json(ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', api: 1, db, push, build, time: new Date(now).toISOString() });
}

/* ---------- маршрутизация ---------- */

const ROUTES = {
  'GET /api/status': { auth: false, fn: (req, env, dev, opts) => health(req, env, opts) },
  'GET /api/config': { auth: false, fn: (req, env) => json(200, { vapidPublicKey: env.VAPID_PUBLIC_KEY || null, api: 1 }) },
  'POST /api/device/register': { auth: false, fn: (req, env, dev, opts) => register(req, env, opts) },
  'POST /api/push/subscribe': { auth: true, fn: subscribe },
  'POST /api/push/unsubscribe': { auth: true, fn: unsubscribe },
  'GET /api/push/status': { auth: true, fn: (req, env, dev, opts) => status(env, dev, opts) },
  'GET /api/push/deliveries': { auth: true, fn: (req, env, dev) => deliveries(req, env, dev) },
  'POST /api/push/ack': { auth: false, fn: (req, env, dev, opts) => ack(req, env, opts) },
  'POST /api/notifications/sync': { auth: true, fn: sync },
  'POST /api/notifications/test': { auth: true, fn: testPush },
};

export async function handleApi(request, env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  const route = ROUTES[`${request.method} ${url.pathname}`];
  if (!route) {
    const known = Object.keys(ROUTES).some((k) => k.endsWith(` ${url.pathname}`));
    return known ? fail(405, 'method_not_allowed') : fail(404, 'not_found');
  }
  try {
    let device = null;
    if (route.auth) {
      device = await authenticate(request, env.DB);
      if (!device) return fail(401, 'unauthorized', null, { 'WWW-Authenticate': 'Bearer' });
    }
    return await route.fn(request, env, device, { now, fetchImpl });
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.code);
    if (err instanceof ConfigError) return fail(503, 'push_not_configured');
    /* без деталей запроса: в логах не должно быть endpoint/токенов */
    console.error('[api] internal error', err && err.name);
    return fail(500, 'internal');
  }
}
