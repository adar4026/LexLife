/* =========================================================
   worker/cron.js — один Cron Trigger раз в минуту обрабатывает
   все правила всех устройств.

   1. now (UTC)
   2. due: enabled AND next_fire_at <= now (частичный индекс)
   3. атомарный claim (одна транзакция D1):
        INSERT delivery (UNIQUE rule_id + scheduled_fire_at)
        + сдвиг next_fire_at на следующее срабатывание
      Второй параллельный запуск получит конфликт UNIQUE → пропуск.
   4. отправка push; результат пишется в delivery
   5. временная ошибка (429/5xx/сеть) → retry с backoff, максимум
      MAX_ATTEMPTS попыток и только в пределах окна опоздания.

   next_fire_at сдвигается при claim, а не после успешной отправки:
   иначе упавшая отправка навсегда «застряла» бы на занятой occurrence.
   Повторы идут из таблицы deliveries. Если Worker оборвался между
   claim и результатом, строка остаётся 'claimed' и НЕ повторяется
   (максимум одна доставка), позже помечается 'unknown'.

   Старое не догоняется: опоздание ≥ NOTIF_GRACE_MS → 'skipped' без push,
   TTL push = остаток того же окна (push-сервис выбросит сообщение, а не
   доставит его через час). Повторы — только 'retry' (429/5xx/сеть) и
   только внутри окна. Открытие приложения сервер вообще не видит.

   Каждое решение — структурированный лог (worker/log.js): rule_id,
   device, scheduled_at, actual_at, lag_s, decision, status, host.
   Payload несёт ack {d, k}: Service Worker после показа подтверждает
   его (POST /api/push/ack) → shown_at / acked_at в журнале доставки.
   ========================================================= */

import { NOTIF_GRACE_MS } from '../js/services/notifySchedule.js';
import { wallLabel, occurrenceId } from '../js/services/zonedSchedule.js';
import { rowToRule, nextFireFor, PUSH_TEXT, PUSH_TARGET } from './rules.js';
import { pushToDevice, dropSubscription } from './delivery.js';
import { b64uEncode } from './webpush.js';
import { logDelivery } from './log.js';

export const CRON_BATCH = 40;
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [60000, 120000];
export const STUCK_CLAIM_MS = 5 * 60000;
export const DELIVERY_RETENTION_MS = 30 * 86400000;
export const IDLE_DEVICE_RETENTION_MS = 90 * 86400000;
/* «Призрачная» подписка: PWA удалён с экрана «Домой», а Apple продолжает
   отвечать 201. Снимается, только если за GHOST_AFTER_MS устройство ни разу
   не открывало приложение, ни один push не подтверждён Service Worker'ом
   и было не меньше GHOST_MIN_SENT доставок с ack (т. е. новым кодом).
   Живая установка, снятая по ошибке, восстанавливается при следующем
   запуске: pushClient.checkSubscription() → status 'none' → подписка заново. */
export const GHOST_AFTER_MS = 7 * 86400000;
export const GHOST_MIN_SENT = 10;
const CONCURRENCY = 6;

const newAckKey = () => b64uEncode(crypto.getRandomValues(new Uint8Array(16)));

export function buildPayload(type, fireAt, occ, ack = null) {
  const p = {
    v: 1, occurrenceId: occ, type, title: 'LexLife',
    body: PUSH_TEXT[type] || 'У вас есть напоминание LexLife',
    target: PUSH_TARGET[type] || '#/notifications',
    scheduledAt: new Date(fireAt).toISOString(),
  };
  if (ack && ack.k) p.ack = { d: ack.d, k: ack.k };
  return p;
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/* Итог попытки → статус delivery */
async function finish(db, deliveryId, attempts, scheduled, res, now, stats, ctx) {
  const log = (decision, reason) => logDelivery({ ...ctx, decision, reason, scheduled, now, attempt: attempts, status: res.status, host: res.host });
  if (res.kind === 'ok') {
    log('sent');
    stats.sent++;
    await db.prepare(`UPDATE notification_deliveries SET status = 'sent', attempts = ?, sent_at = ?, error_code = NULL WHERE id = ?`)
      .bind(attempts, now, deliveryId).run();
    return;
  }
  const backoff = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  const code = res.kind === 'no_subscription' ? 'no_subscription' : `${res.kind}:${res.status}`;
  if (res.kind === 'retry' && attempts < MAX_ATTEMPTS && now + backoff < scheduled + NOTIF_GRACE_MS) {
    stats.retrying++;
    log('retry', `${code}; next_attempt_at=${new Date(now + backoff).toISOString()}`);
    await db.prepare(`UPDATE notification_deliveries SET status = 'retry', attempts = ?, next_attempt_at = ?, error_code = ? WHERE id = ?`)
      .bind(attempts, now + backoff, code, deliveryId).run();
    return;
  }
  stats.failed++;
  log(res.kind === 'gone' ? 'gone' : res.kind === 'no_subscription' ? 'no_subscription' : 'failed',
    res.kind === 'retry' ? `${code}; повтор вне окна ${NOTIF_GRACE_MS / 60000} мин или попытки исчерпаны` : code);
  await db.prepare(`UPDATE notification_deliveries SET status = 'failed', attempts = ?, next_attempt_at = NULL, error_code = ? WHERE id = ?`)
    .bind(attempts, code, deliveryId).run();
}

const ttlFor = (scheduled, now) => Math.max(60, Math.round((scheduled + NOTIF_GRACE_MS - now) / 1000));

async function processDue(env, row, now, stats, fetchImpl) {
  const db = env.DB;
  const fireAt = row.next_fire_at;
  const rule = rowToRule(row);
  const late = now - fireAt >= NOTIF_GRACE_MS; // как у локального планировщика: старое не догоняем
  const next = rule.repeat === 'once' ? null : nextFireFor(rule, Math.max(now, fireAt), row.timezone);
  const occ = occurrenceId(row.client_rule_id, wallLabel(fireAt, row.timezone));
  const ackKey = late ? null : newAckKey();
  const ctx = { ruleId: row.id, deviceId: row.device_id, type: row.type, occurrence: occ };

  const [ins] = await db.batch([
    db.prepare(`INSERT INTO notification_deliveries (rule_id, scheduled_fire_at, occurrence_id, status, attempts, created_at, error_code, ack_key)
                SELECT ?, ?, ?, ?, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_rules WHERE id = ? AND next_fire_at = ?)
                ON CONFLICT (rule_id, scheduled_fire_at) DO NOTHING`)
      .bind(row.id, fireAt, occ, late ? 'skipped' : 'claimed', now, late ? 'late' : null, ackKey, row.id, fireAt),
    db.prepare(`UPDATE notification_rules
                SET next_fire_at = ?, completed_at = CASE WHEN schedule_type = 'once' THEN ? ELSE completed_at END, updated_at = ?
                WHERE id = ? AND next_fire_at = ?`)
      .bind(next, now, now, row.id, fireAt),
  ]);
  if (ins.meta.changes !== 1) { // занято другим запуском / правило изменилось
    stats.lost++;
    logDelivery({ ...ctx, decision: 'lost_race', reason: 'occurrence уже взята другим запуском или правило изменилось', scheduled: fireAt, now });
    return;
  }
  if (late) {
    stats.skipped++;
    logDelivery({ ...ctx, decision: 'skipped_late', reason: `опоздание ≥ ${NOTIF_GRACE_MS / 60000} мин: старое не догоняем`, scheduled: fireAt, now });
    return;
  }
  stats.claimed++;
  const delivery = await db.prepare('SELECT id FROM notification_deliveries WHERE rule_id = ? AND scheduled_fire_at = ?').bind(row.id, fireAt).first();
  let res;
  try {
    res = await pushToDevice(env, row.device_id, buildPayload(row.type, fireAt, occ, { d: delivery.id, k: ackKey }), { now, fetchImpl, ttl: ttlFor(fireAt, now) });
  } catch (err) {
    res = { kind: 'error', status: err && err.code === 'push_not_configured' ? 'config' : 'exception' };
  }
  await finish(db, delivery.id, 1, fireAt, res, now, stats, ctx);
}

async function processRetry(env, d, now, stats, fetchImpl) {
  const db = env.DB;
  const ctx = { ruleId: d.rule_id, deviceId: d.device_id, type: d.type, occurrence: d.occurrence_id };
  if (now - d.scheduled_fire_at >= NOTIF_GRACE_MS) {
    await db.prepare(`UPDATE notification_deliveries SET status = 'expired', next_attempt_at = NULL WHERE id = ? AND status = 'retry'`).bind(d.id).run();
    stats.expired++;
    logDelivery({ ...ctx, decision: 'expired', reason: 'окно повтора закрылось', scheduled: d.scheduled_fire_at, now, attempt: d.attempts });
    return;
  }
  const claim = await db.prepare(`UPDATE notification_deliveries SET status = 'claimed', next_attempt_at = NULL WHERE id = ? AND status = 'retry'`).bind(d.id).run();
  if (claim.meta.changes !== 1) {
    stats.lost++;
    logDelivery({ ...ctx, decision: 'lost_race', reason: 'повтор уже взят другим запуском', scheduled: d.scheduled_fire_at, now });
    return;
  }
  let res;
  try {
    res = await pushToDevice(env, d.device_id, buildPayload(d.type, d.scheduled_fire_at, d.occurrence_id, { d: d.id, k: d.ack_key }), { now, fetchImpl, ttl: ttlFor(d.scheduled_fire_at, now) });
  } catch (err) {
    res = { kind: 'error', status: err && err.code === 'push_not_configured' ? 'config' : 'exception' };
  }
  await finish(db, d.id, d.attempts + 1, d.scheduled_fire_at, res, now, stats, ctx);
}

/* Подписки удалённых установок PWA (см. GHOST_AFTER_MS) */
export async function dropGhostSubscriptions(db, now) {
  const since = now - GHOST_AFTER_MS;
  const { results } = await db.prepare(`
    SELECT s.id, s.device_id FROM push_subscriptions s JOIN devices dv ON dv.id = s.device_id
    WHERE s.active = 1 AND s.created_at < ?
      AND COALESCE(dv.last_seen_at, 0) < ? AND COALESCE(s.last_ack_at, 0) < ?
      AND (SELECT COUNT(*) FROM notification_deliveries x JOIN notification_rules r ON r.id = x.rule_id
           WHERE r.device_id = s.device_id AND x.status = 'sent' AND x.ack_key IS NOT NULL AND x.created_at >= ?) >= ?
      AND NOT EXISTS (SELECT 1 FROM notification_deliveries x JOIN notification_rules r ON r.id = x.rule_id
           WHERE r.device_id = s.device_id AND x.acked_at IS NOT NULL AND x.created_at >= ?)`)
    .bind(since, since, since, since, GHOST_MIN_SENT, since).all();
  for (const sub of results) {
    await dropSubscription(db, sub, now);
    logDelivery({ decision: 'ghost_dropped', deviceId: sub.device_id, now, reason: `${GHOST_AFTER_MS / 86400000} дн.: приложение не открывалось, ни один push не подтверждён` });
  }
  return results.length;
}

/* Обслуживание (раз в час): зависшие claim, срок хранения журнала, брошенные устройства */
export async function maintenance(db, now) {
  await db.batch([
    db.prepare(`UPDATE notification_deliveries SET status = 'unknown' WHERE status = 'claimed' AND created_at < ?`).bind(now - STUCK_CLAIM_MS),
    db.prepare(`UPDATE notification_deliveries SET status = 'expired', next_attempt_at = NULL WHERE status = 'retry' AND scheduled_fire_at < ?`).bind(now - NOTIF_GRACE_MS),
    db.prepare('DELETE FROM notification_deliveries WHERE created_at < ?').bind(now - DELIVERY_RETENTION_MS),
    db.prepare(`DELETE FROM devices WHERE updated_at < ?
                AND NOT EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.device_id = devices.id AND s.active = 1)`)
      .bind(now - IDLE_DEVICE_RETENTION_MS),
  ]);
  await dropGhostSubscriptions(db, now);
}

export async function runCron(env, now = Date.now(), { fetchImpl = fetch } = {}) {
  const db = env.DB;
  const stats = { due: 0, claimed: 0, sent: 0, skipped: 0, lost: 0, retrying: 0, failed: 0, expired: 0, retried: 0 };

  const { results: due } = await db.prepare(`
    SELECT r.* FROM notification_rules r
    WHERE r.enabled = 1 AND r.next_fire_at IS NOT NULL AND r.next_fire_at <= ?
      AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.device_id = r.device_id AND s.active = 1)
    ORDER BY r.next_fire_at LIMIT ?`).bind(now, CRON_BATCH).all();
  stats.due = due.length;
  await pool(due, CONCURRENCY, (row) => processDue(env, row, now, stats, fetchImpl));

  const { results: retries } = await db.prepare(`
    SELECT d.id, d.rule_id, d.scheduled_fire_at, d.occurrence_id, d.attempts, d.ack_key, r.device_id, r.type
    FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id
    WHERE d.status = 'retry' AND d.next_attempt_at <= ?
    ORDER BY d.next_attempt_at LIMIT ?`).bind(now, CRON_BATCH).all();
  stats.retried = retries.length;
  await pool(retries, CONCURRENCY, (d) => processRetry(env, d, now, stats, fetchImpl));

  if (new Date(now).getUTCMinutes() === 0) await maintenance(db, now);
  return stats;
}
