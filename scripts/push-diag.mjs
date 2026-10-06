#!/usr/bin/env node
/* =========================================================
   scripts/push-diag.mjs — диагностика фоновых уведомлений по D1.
   ТОЛЬКО ЧТЕНИЕ (SELECT через `wrangler d1 execute`), ничего не меняет.

   node scripts/push-diag.mjs              — production (--remote)
   node scripts/push-diag.mjs --local      — локальная D1 wrangler dev
   node scripts/push-diag.mjs --hours 48   — окно журнала (по умолчанию 24 ч)
   node scripts/push-diag.mjs --occurrence '<rule>@2026-10-06T13:30'
                                           — почему конкретное срабатывание пришло / не пришло

   Показывает: устройства (8 символов id), подписки (только хост push-сервиса),
   правила и их next_fire_at, журнал доставки с задержками
   «отправлено» (сервер → Apple) и «показано» (Apple → iPhone, ack от SW),
   и подозрения: одно расписание на нескольких устройствах (две установки
   PWA = дубли), включённые правила без расписания, зависшие claimed/retry.
   Endpoint, ключи и токены не выводятся.
   ========================================================= */

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const where = flag('--local') ? '--local' : '--remote';
const hours = Number(opt('--hours', 24)) || 24;
const occurrence = opt('--occurrence', null);
const TZ = 'Europe/Madrid';

function q(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'lexlife', where, '--json', '--command', sql], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  return JSON.parse(r.stdout)[0].results;
}
const local = (t) => (t ? new Date(t).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const lag = (a, b) => (a && b ? `${Math.round((a - b) / 1000)} с` : '—');
const esc = (s) => String(s).replace(/'/g, "''");

if (occurrence) {
  const rows = q(`SELECT d.*, r.type, substr(r.device_id,1,8) dev, r.enabled FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id WHERE d.occurrence_id = '${esc(occurrence)}'`);
  if (!rows.length) {
    console.log(`Записи о «${occurrence}» нет: cron не выбрал срабатывание.`);
    console.log('Возможные причины: правило выключено или не синхронизировано, у устройства нет активной подписки (next_fire_at = NULL), срабатывание старше 30 дней (журнал очищен).');
  }
  for (const d of rows) {
    console.log(`устройство ${d.dev} · ${d.type} · запланировано ${local(d.scheduled_fire_at)} (${TZ})`);
    console.log(`  статус: ${d.status}${d.error_code ? ` (${d.error_code})` : ''}, попыток: ${d.attempts}`);
    console.log(`  взято cron: ${local(d.created_at)} (+${lag(d.created_at, d.scheduled_fire_at)})`);
    console.log(`  принято push-сервисом: ${local(d.sent_at)} (+${lag(d.sent_at, d.scheduled_fire_at)})`);
    console.log(`  показано на iPhone (ack SW): ${d.shown_at ? `${local(d.shown_at)} (+${lag(d.shown_at, d.scheduled_fire_at)})` : d.ack_key ? 'не подтверждено (SW не запускался или нет сети)' : 'нет данных (отправлено до 2026-10-06, без ack)'}`);
  }
  process.exit(0);
}

const since = Date.now() - hours * 3600000;
console.log(`\n== Устройства и подписки (${where === '--remote' ? 'production' : 'local'})`);
console.table(q(`SELECT substr(dv.id,1,8) dev, dv.timezone tz, datetime(dv.last_sync_at/1000,'unixepoch') last_sync_utc,
  datetime(dv.last_seen_at/1000,'unixepoch') last_seen_utc,
  (SELECT COUNT(*) FROM push_subscriptions s WHERE s.device_id = dv.id AND s.active = 1) subs,
  (SELECT substr(s.endpoint, 9, instr(substr(s.endpoint, 9), '/') - 1) FROM push_subscriptions s WHERE s.device_id = dv.id LIMIT 1) host,
  (SELECT datetime(MAX(s.last_success_at)/1000,'unixepoch') FROM push_subscriptions s WHERE s.device_id = dv.id) last_201_utc,
  (SELECT datetime(MAX(s.last_ack_at)/1000,'unixepoch') FROM push_subscriptions s WHERE s.device_id = dv.id) last_ack_utc,
  (SELECT MAX(s.failure_count) FROM push_subscriptions s WHERE s.device_id = dv.id) fails
  FROM devices dv ORDER BY dv.created_at`));

console.log('\n== Правила (включённые)');
console.table(q(`SELECT id rule_id, substr(device_id,1,8) dev, client_rule_id, type, schedule_type, COALESCE(local_time, window_start || '–' || window_end || '/' || interval_minutes || 'м') sched,
  datetime(next_fire_at/1000,'unixepoch') next_utc FROM notification_rules WHERE enabled = 1 ORDER BY device_id, type`));

console.log(`\n== Журнал доставки за ${hours} ч (время — ${TZ})`);
const rows = q(`SELECT d.id, d.rule_id, substr(r.device_id,1,8) dev, r.type, d.occurrence_id, d.scheduled_fire_at, d.created_at, d.sent_at, d.shown_at, d.acked_at, d.ack_key IS NOT NULL has_ack, d.status, d.error_code, d.attempts
  FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id WHERE d.scheduled_fire_at >= ${since} ORDER BY d.scheduled_fire_at, r.device_id`);
console.table(rows.map((d) => ({
  rule: d.rule_id, dev: d.dev, type: d.type, scheduled: local(d.scheduled_fire_at), status: d.status + (d.error_code ? `:${d.error_code}` : ''), tries: d.attempts,
  sent: d.sent_at ? `+${lag(d.sent_at, d.scheduled_fire_at)}` : '—',
  shown: d.shown_at ? `+${lag(d.shown_at, d.scheduled_fire_at)}` : d.has_ack && d.status === 'sent' ? 'нет ack' : '—',
})));

console.log('\n== Подозрения');
const issues = [];
for (const r of q(`SELECT client_rule_id, COUNT(DISTINCT r.device_id) n FROM notification_rules r
    WHERE r.enabled = 1 AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.device_id = r.device_id AND s.active = 1)
    GROUP BY client_rule_id HAVING n > 1`)) {
  issues.push(`правило ${r.client_rule_id} активно на ${r.n} устройствах с подписками → каждое срабатывание приходит ${r.n} раза (несколько установок PWA / восстановление бэкапа на второй установке)`);
}
for (const r of q(`SELECT substr(device_id,1,8) dev, COUNT(*) n FROM notification_rules r WHERE enabled = 1 AND next_fire_at IS NULL AND completed_at IS NULL
    AND schedule_type <> 'once' GROUP BY device_id`)) issues.push(`устройство ${r.dev}: ${r.n} включённых правил без расписания (нет активной подписки) — push не отправляются, пока приложение не откроется`);
for (const r of q(`SELECT status, COUNT(*) n FROM notification_deliveries WHERE status IN ('claimed','retry') AND created_at < ${Date.now() - 15 * 60000} GROUP BY status`)) issues.push(`${r.n} доставок зависли в '${r.status}' дольше 15 мин (maintenance раз в час переведёт их в unknown/expired)`);
const late = rows.filter((d) => d.sent_at && d.sent_at - d.scheduled_fire_at > 2 * 60000);
if (late.length) issues.push(`${late.length} отправок позже 2 мин после расписания (cron/D1 задержка)`);
const held = rows.filter((d) => d.shown_at && d.shown_at - d.scheduled_fire_at > 5 * 60000);
if (held.length) issues.push(`${held.length} push показаны iPhone позже 5 мин после расписания при своевременной отправке → задержка на стороне устройства (сон, Фокусирование, «Сводка уведомлений», режим энергосбережения)`);
const unacked = rows.filter((d) => d.has_ack && d.status === 'sent' && !d.shown_at);
if (unacked.length) issues.push(`${unacked.length} push приняты Apple, но не подтверждены Service Worker'ом (установка удалена, iPhone вне сети или SW ещё не обновился до v65)`);
console.log(issues.length ? issues.map((x) => `• ${x}`).join('\n') : 'нет');
