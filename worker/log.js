/* =========================================================
   worker/log.js — структурированные логи cron и push-доставки
   (Workers Logs: observability.enabled, одна JSON-строка на событие).

   Что можно: rule_id (число D1), короткий префикс device_id, тип правила,
   occurrence (id правила + локальное время, без текста), времена, решение,
   HTTP-статус, хост push-сервиса.
   Чего нельзя: endpoint целиком, ключи подписки, токены, VAPID, тексты.
   ========================================================= */

export const devTag = (deviceId) => (typeof deviceId === 'string' ? deviceId.slice(0, 8) : null);

/* Хост push-сервиса без пути (путь endpoint'а — идентификатор подписки) */
export function endpointHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return null; }
}

const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/* Одно событие доставки. decision: sent | retry | failed | gone | skipped_late |
   lost_race | no_subscription | expired | stale_suspect (только диагностика) */
export function logDelivery(e) {
  const out = {
    evt: 'push', decision: e.decision,
    rule_id: e.ruleId ?? null, device: devTag(e.deviceId), type: e.type ?? null,
    occurrence: e.occurrence ?? null,
    scheduled_at: iso(e.scheduled), actual_at: iso(e.now),
    lag_s: Number.isFinite(e.scheduled) && Number.isFinite(e.now) ? Math.round((e.now - e.scheduled) / 1000) : null,
    attempt: e.attempt ?? null, status: e.status ?? null, host: e.host ?? null, reason: e.reason ?? null,
  };
  (e.decision === 'failed' || e.decision === 'gone' ? console.warn : console.log)(JSON.stringify(out));
  return out;
}

/* Итог одного запуска cron (только счётчики и время) */
export function logCron(stats, scheduledTime, startedAt) {
  console.log(JSON.stringify({ evt: 'cron', scheduled_at: iso(scheduledTime), started_at: iso(startedAt), drift_s: Math.round((startedAt - scheduledTime) / 1000), ...stats }));
}
