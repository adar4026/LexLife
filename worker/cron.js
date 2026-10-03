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
   ========================================================= */

import { NOTIF_GRACE_MS } from '../js/services/notifySchedule.js';
import { wallLabel, occurrenceId } from '../js/services/zonedSchedule.js';
import { rowToRule, nextFireFor, PUSH_TEXT, PUSH_TARGET } from './rules.js';
import { pushToDevice } from './delivery.js';

export const CRON_BATCH = 40;
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [60000, 120000];
export const STUCK_CLAIM_MS = 5 * 60000;
export const DELIVERY_RETENTION_MS = 30 * 86400000;
export const IDLE_DEVICE_RETENTION_MS = 90 * 86400000;
const CONCURRENCY = 6;

export function buildPayload(type, fireAt, occ) {
  return {
    v: 1, occurrenceId: occ, type, title: 'LexLife',
    body: PUSH_TEXT[type] || 'У вас есть напоминание LexLife',
    target: PUSH_TARGET[type] || '#/notifications',
    scheduledAt: new Date(fireAt).toISOString(),
  };
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/* Итог попытки → статус delivery */
async function finish(db, deliveryId, attempts, scheduled, res, now, stats) {
  if (res.kind === 'ok') {
    stats.sent++;
    await db.prepare(`UPDATE notification_deliveries SET status = 'sent', attempts = ?, sent_at = ?, error_code = NULL WHERE id = ?`)
      .bind(attempts, now, deliveryId).run();
    return;
  }
  const backoff = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  const code = res.kind === 'no_subscription' ? 'no_subscription' : `${res.kind}:${res.status}`;
  if (res.kind === 'retry' && attempts < MAX_ATTEMPTS && now + backoff < scheduled + NOTIF_GRACE_MS) {
    stats.retrying++;
    await db.prepare(`UPDATE notification_deliveries SET status = 'retry', attempts = ?, next_attempt_at = ?, error_code = ? WHERE id = ?`)
      .bind(attempts, now + backoff, code, deliveryId).run();
    return;
  }
  stats.failed++;
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

  const [ins] = await db.batch([
    db.prepare(`INSERT INTO notification_deliveries (rule_id, scheduled_fire_at, occurrence_id, status, attempts, created_at)
                SELECT ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM notification_rules WHERE id = ? AND next_fire_at = ?)
                ON CONFLICT (rule_id, scheduled_fire_at) DO NOTHING`)
      .bind(row.id, fireAt, occ, late ? 'skipped' : 'claimed', now, row.id, fireAt),
    db.prepare(`UPDATE notification_rules
                SET next_fire_at = ?, completed_at = CASE WHEN schedule_type = 'once' THEN ? ELSE completed_at END, updated_at = ?
                WHERE id = ? AND next_fire_at = ?`)
      .bind(next, now, now, row.id, fireAt),
  ]);
  if (ins.meta.changes !== 1) { stats.lost++; return; } // занято другим запуском / правило изменилось
  if (late) { stats.skipped++; return; }
  stats.claimed++;
  const delivery = await db.prepare('SELECT id FROM notification_deliveries WHERE rule_id = ? AND scheduled_fire_at = ?').bind(row.id, fireAt).first();
  let res;
  try {
    res = await pushToDevice(env, row.device_id, buildPayload(row.type, fireAt, occ), { now, fetchImpl, ttl: ttlFor(fireAt, now) });
  } catch (err) {
    res = { kind: 'error', status: err && err.code === 'push_not_configured' ? 'config' : 'exception' };
  }
  await finish(db, delivery.id, 1, fireAt, res, now, stats);
}

async function processRetry(env, d, now, stats, fetchImpl) {
  const db = env.DB;
  if (now - d.scheduled_fire_at >= NOTIF_GRACE_MS) {
    await db.prepare(`UPDATE notification_deliveries SET status = 'expired', next_attempt_at = NULL WHERE id = ? AND status = 'retry'`).bind(d.id).run();
    stats.expired++;
    return;
  }
  const claim = await db.prepare(`UPDATE notification_deliveries SET status = 'claimed', next_attempt_at = NULL WHERE id = ? AND status = 'retry'`).bind(d.id).run();
  if (claim.meta.changes !== 1) { stats.lost++; return; }
  let res;
  try {
    res = await pushToDevice(env, d.device_id, buildPayload(d.type, d.scheduled_fire_at, d.occurrence_id), { now, fetchImpl, ttl: ttlFor(d.scheduled_fire_at, now) });
  } catch (err) {
    res = { kind: 'error', status: err && err.code === 'push_not_configured' ? 'config' : 'exception' };
  }
  await finish(db, d.id, d.attempts + 1, d.scheduled_fire_at, res, now, stats);
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
    SELECT d.id, d.scheduled_fire_at, d.occurrence_id, d.attempts, r.device_id, r.type
    FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id
    WHERE d.status = 'retry' AND d.next_attempt_at <= ?
    ORDER BY d.next_attempt_at LIMIT ?`).bind(now, CRON_BATCH).all();
  stats.retried = retries.length;
  await pool(retries, CONCURRENCY, (d) => processRetry(env, d, now, stats, fetchImpl));

  if (new Date(now).getUTCMinutes() === 0) await maintenance(db, now);
  return stats;
}
