/* =========================================================
   worker/delivery.js — отправка push на устройство и учёт
   состояния подписки (успех / 404-410 / временные ошибки).
   endpoint и ключи подписки никуда не выводятся.
   ========================================================= */

import { sendWebPush, topicFor } from './webpush.js';

export const MAX_TRANSIENT_FAILURES = 10; // подряд: 429/5xx/сеть
export const MAX_PERMANENT_FAILURES = 3;  // подряд: прочие 4xx (403 VAPID, 400 …)

export class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'push_not_configured'; }
}

export function vapidFromEnv(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new ConfigError('VAPID is not configured');
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}

export const activeSubscription = (db, deviceId) => db
  .prepare('SELECT * FROM push_subscriptions WHERE device_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1')
  .bind(deviceId).first();

/* Подписки устройства больше нет: правила перестают выбираться cron'ом,
   пока устройство не подпишется снова (тогда next_fire_at пересчитается). */
export async function dropSubscription(db, sub, now) {
  await db.batch([
    db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id),
    db.prepare(`UPDATE notification_rules SET next_fire_at = NULL, updated_at = ?
                WHERE device_id = ? AND NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE device_id = ? AND active = 1)`)
      .bind(now, sub.device_id, sub.device_id),
  ]);
}

/* Отправить payload активной подписке устройства.
   → { kind: 'ok'|'gone'|'retry'|'error'|'no_subscription', status } */
export async function pushToDevice(env, deviceId, payload, { now = Date.now(), fetchImpl = fetch, ttl } = {}) {
  const vapid = vapidFromEnv(env);
  const db = env.DB;
  const sub = await activeSubscription(db, deviceId);
  if (!sub) return { kind: 'no_subscription', status: 0 };
  const topic = payload.occurrenceId ? await topicFor(payload.occurrenceId) : undefined;
  const r = await sendWebPush(sub, payload, vapid, { ttl, topic, fetchImpl, nowMs: now });
  if (r.kind === 'ok') {
    await db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0, updated_at = ? WHERE id = ?').bind(now, now, sub.id).run();
  } else if (r.kind === 'gone') {
    await dropSubscription(db, sub, now);
  } else {
    const count = (sub.failure_count || 0) + 1;
    const limit = r.kind === 'error' ? MAX_PERMANENT_FAILURES : MAX_TRANSIENT_FAILURES;
    if (count >= limit) await dropSubscription(db, sub, now);
    else await db.prepare('UPDATE push_subscriptions SET failure_count = ?, last_failure_at = ?, updated_at = ? WHERE id = ?').bind(count, now, now, sub.id).run();
  }
  return { kind: r.kind, status: r.status };
}
