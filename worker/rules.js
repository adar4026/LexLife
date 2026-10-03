/* =========================================================
   worker/rules.js — проверка присланных правил и вычисление
   next_fire_at. Текст напоминания на сервер не принимается:
   push содержит только нейтральную фразу по типу правила.
   ========================================================= */

import { nextFireUtc, isValidTimeZone } from '../js/services/zonedSchedule.js';

export const RULE_TYPES = ['meds', 'water', 'pressure', 'weight', 'tests', 'visits'];
export const REPEATS = ['daily', 'weekdays', 'weekly', 'interval', 'once'];
export const MAX_RULES = 24;

/* Нейтральные тексты: без названий лекарств, значений и диагнозов */
export const PUSH_TEXT = {
  water: 'Пора выпить воду',
  meds: 'Проверьте напоминание LexLife',
  pressure: 'Время измерить давление',
  weight: 'Время контрольного взвешивания',
  tests: 'У вас есть напоминание LexLife',
  visits: 'Проверьте предстоящие визиты',
};
/* Экран, который откроется по нажатию (только внутренние маршруты) */
export const PUSH_TARGET = {
  meds: '#/meds', water: '#/metric/water', pressure: '#/metric/pressure',
  weight: '#/metric/weight', tests: '#/tests', visits: '#/visits',
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class RuleError extends Error {
  constructor(message) { super(message); this.code = 'invalid_rules'; }
}

/* Нормализованное правило (форма как у клиента) или исключение RuleError */
export function normalizeRule(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new RuleError('rule must be an object');
  if (!ID_RE.test(r.id || '')) throw new RuleError('bad rule id');
  if (!RULE_TYPES.includes(r.type)) throw new RuleError('bad rule type');
  if (!REPEATS.includes(r.repeat)) throw new RuleError('bad repeat');
  if (typeof r.enabled !== 'boolean') throw new RuleError('bad enabled');
  const out = { id: r.id, type: r.type, enabled: r.enabled, repeat: r.repeat, time: null, days: [], intervalMinutes: null, startTime: null, endTime: null, date: null };
  if (r.repeat === 'interval') {
    const iv = Number(r.intervalMinutes);
    if (!Number.isInteger(iv) || iv < 15 || iv > 1440) throw new RuleError('bad interval');
    if (!TIME_RE.test(r.startTime || '') || !TIME_RE.test(r.endTime || '')) throw new RuleError('bad window');
    Object.assign(out, { intervalMinutes: iv, startTime: r.startTime, endTime: r.endTime });
  } else {
    if (!TIME_RE.test(r.time || '')) throw new RuleError('bad time');
    out.time = r.time;
    if (r.repeat === 'weekly') {
      if (!Array.isArray(r.days) || r.days.length > 7 || !r.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new RuleError('bad days');
      out.days = [...new Set(r.days)].sort((a, b) => a - b);
    }
    if (r.repeat === 'once') {
      if (!DATE_RE.test(r.date || '')) throw new RuleError('bad date');
      out.date = r.date;
    }
  }
  return out;
}

export function normalizeRules(list) {
  if (!Array.isArray(list) || list.length > MAX_RULES) throw new RuleError('rules must be an array');
  const out = list.map(normalizeRule);
  if (new Set(out.map((r) => r.id)).size !== out.length) throw new RuleError('duplicate rule id');
  return out;
}

export function checkTimeZone(tz) {
  if (!isValidTimeZone(tz)) throw new RuleError('bad timezone');
  return tz;
}

/* Строка БД → правило в форме клиента (для расчёта расписания) */
export function rowToRule(row) {
  return {
    id: row.client_rule_id, type: row.type, enabled: !!row.enabled, repeat: row.schedule_type,
    time: row.local_time, days: row.days_of_week ? row.days_of_week.split(',').map(Number) : [],
    intervalMinutes: row.interval_minutes, startTime: row.window_start, endTime: row.window_end, date: row.once_date,
  };
}

/* Подпись расписания: изменилась — next_fire_at пересчитывается */
export const scheduleSignature = (rule, tz) => JSON.stringify([
  rule.enabled, rule.repeat, rule.time, rule.days, rule.intervalMinutes, rule.startTime, rule.endTime, rule.date, tz,
]);

export const nextFireFor = (rule, afterMs, tz) => (rule.enabled ? nextFireUtc(rule, afterMs, tz) : null);
