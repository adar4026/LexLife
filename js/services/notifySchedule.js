/* =========================================================
   notifySchedule.js — расписание правил уведомлений (чистые функции).
   Всё время — локальное время устройства (new Date(y, m, d, h, min)),
   без UTC-сравнений и без зашитой timezone: Europe/Madrid, переход на
   летнее/зимнее время и полночь обрабатываются движком Date.
   Модель правила — notifications (ARCHITECTURE.md §5.7), формат не меняется.
   ========================================================= */

export const NOTIF_GRACE_MS = 10 * 60000; // опоздавшее срабатывание показываем не позже 10 мин

const DAY_SCAN = 8; // daily/weekly/interval: хватает недели + запаса

const toMin = (s, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '') || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return Number(m[1]) * 60 + Number(m[2]);
};
const dayStart = (d, shift = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift);
const at = (day, minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
const okDay = (rule, day) => {
  const dow = day.getDay();
  if (rule.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (rule.repeat === 'weekly') return (rule.days || []).includes(dow);
  return true;
};

/* Срабатывания правила, «привязанные» к дню day (окно interval может уходить за полночь) */
export function firesOn(rule, day) {
  if (rule.repeat === 'interval') {
    const step = Math.max(15, Number(rule.intervalMinutes) || 120);
    const s = toMin(rule.startTime, '07:00');
    let e = toMin(rule.endTime, '23:00');
    if (e < s) e += 1440; // окно через полночь: 22:00–02:00
    const out = [];
    for (let m = s; m <= e; m += step) out.push(at(day, m));
    return out;
  }
  if (!okDay(rule, day)) return [];
  return [at(day, toMin(rule.time, '09:00'))];
}

function onceFire(rule) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rule.date || '');
  if (!m) return null;
  return at(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), toMin(rule.time, '09:00'));
}

/* Ближайшее срабатывание строго после now (или null) */
export function nextFire(rule, now = new Date()) {
  if (rule.repeat === 'once') { const f = onceFire(rule); return f && f > now ? f : null; }
  let best = null;
  for (let i = -1; i <= DAY_SCAN; i++) {
    for (const f of firesOn(rule, dayStart(now, i))) if (f > now && (!best || f < best)) best = f;
  }
  return best;
}

/* Последнее срабатывание не позже now (или null) */
export function prevFire(rule, now = new Date()) {
  if (rule.repeat === 'once') { const f = onceFire(rule); return f && f <= now ? f : null; }
  let best = null;
  for (let i = -DAY_SCAN; i <= 0; i++) {
    for (const f of firesOn(rule, dayStart(now, i))) if (f <= now && (!best || f > best)) best = f;
  }
  return best;
}

/* Нужно ли показать правило сейчас: возвращает момент срабатывания или null.
   Одно срабатывание — одно уведомление: lastFiredAt хранит последний показанный момент. */
export function dueFire(rule, now = new Date(), graceMs = NOTIF_GRACE_MS) {
  if (!rule || !rule.enabled) return null;
  const prev = prevFire(rule, now);
  if (!prev) return null;
  const last = rule.lastFiredAt ? new Date(rule.lastFiredAt) : null;
  if (last && !Number.isNaN(last.getTime()) && prev <= last) return null;
  if (now - prev >= graceMs) return null;
  return prev;
}
