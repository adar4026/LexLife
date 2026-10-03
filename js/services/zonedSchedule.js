/* =========================================================
   zonedSchedule.js — расписание правил в заданной IANA timezone
   (чистые функции, без зависимостей). Используется сервером
   (Cloudflare Worker, cron) и фронтендом (occurrenceId).

   Правило хранит локальное время (time / startTime / endTime / date)
   + timezone. Момент срабатывания каждый раз заново вычисляется из
   локального времени — никаких «+24 часа», поэтому DST, полночь
   и смена года обрабатываются правильно.

   Семантика совпадает с js/services/notifySchedule.js (локальный
   Date устройства), включая DST:
   - несуществующее время (весной 02:30 в Europe/Madrid) → сдвиг вперёд
     на размер перехода (03:30), как делает Date;
   - неоднозначное время (осенью 02:30 бывает дважды) → первое.
   Это равенство проверяется тестом в нескольких timezone.
   ========================================================= */

const DAY_MS = 86400000;
const DAY_SCAN = 8;

const fmtCache = new Map();
function partsFormatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/* Корректная ли IANA timezone (Europe/Madrid, UTC, …) */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { partsFormatter(tz); return true; } catch { return false; }
}

/* Локальные поля момента t (мс UTC) в timezone */
export function wallParts(t, timeZone) {
  const p = {};
  for (const x of partsFormatter(timeZone).formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/* Смещение timezone в момент t: local − UTC, мс */
function offsetAt(t, timeZone) {
  const w = wallParts(t, timeZone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/* Локальное время (поля, допускается переполнение минут) → момент UTC, мс.
   Совместимо с Date: пропущенное время сдвигается вперёд, двойное — первое. */
export function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offEarly = offsetAt(wall - DAY_MS, timeZone);
  const offLate = offsetAt(wall + DAY_MS, timeZone);
  const cands = [...new Set([wall - offEarly, wall - offLate])]
    .filter((t) => offsetAt(t, timeZone) === wall - t)
    .sort((a, b) => a - b);
  if (cands.length) return cands[0];
  return wall - offEarly; // «дыра» перехода на летнее время: смещение до перехода
}

const toMin = (s, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '') || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return Number(m[1]) * 60 + Number(m[2]);
};
/* Гражданский день: { y, mo, d } (+ сдвиг в днях), день недели 0=вс */
const civil = (y, mo, d, shift = 0) => {
  const t = new Date(Date.UTC(y, mo - 1, d + shift));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
};
const okDay = (rule, day) => {
  if (rule.repeat === 'weekdays') return day.dow >= 1 && day.dow <= 5;
  if (rule.repeat === 'weekly') return (rule.days || []).includes(day.dow);
  return true;
};

/* Срабатывания правила, привязанные к гражданскому дню (мс UTC) */
function firesOnDay(rule, day, tz) {
  const at = (minutes) => zonedToUtc(day.y, day.mo, day.d, 0, minutes, tz);
  if (rule.repeat === 'interval') {
    const step = Math.max(15, Number(rule.intervalMinutes) || 120);
    const s = toMin(rule.startTime, '07:00');
    let e = toMin(rule.endTime, '23:00');
    if (e < s) e += 1440; // окно через полночь: 22:00–02:00
    const out = [];
    for (let m = s; m <= e; m += step) out.push(at(m));
    return out;
  }
  if (!okDay(rule, day)) return [];
  return [at(toMin(rule.time, '09:00'))];
}

function onceFire(rule, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rule.date || '');
  if (!m) return null;
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, toMin(rule.time, '09:00'), tz);
}

/* Ближайшее срабатывание строго после nowMs (мс UTC) или null */
export function nextFireUtc(rule, nowMs, tz) {
  if (rule.repeat === 'once') { const f = onceFire(rule, tz); return f != null && f > nowMs ? f : null; }
  const w = wallParts(nowMs, tz);
  let best = null;
  for (let i = -1; i <= DAY_SCAN; i++) {
    for (const f of firesOnDay(rule, civil(w.y, w.mo, w.d, i), tz)) if (f > nowMs && (best == null || f < best)) best = f;
  }
  return best;
}

/* Последнее срабатывание не позже nowMs или null */
export function prevFireUtc(rule, nowMs, tz) {
  if (rule.repeat === 'once') { const f = onceFire(rule, tz); return f != null && f <= nowMs ? f : null; }
  const w = wallParts(nowMs, tz);
  let best = null;
  for (let i = -DAY_SCAN; i <= 0; i++) {
    for (const f of firesOnDay(rule, civil(w.y, w.mo, w.d, i), tz)) if (f <= nowMs && (best == null || f > best)) best = f;
  }
  return best;
}

const p2 = (n) => String(n).padStart(2, '0');
/* Локальная метка «ГГГГ-ММ-ДДTЧЧ:ММ» момента t в timezone */
export function wallLabel(t, tz) {
  const w = wallParts(t, tz);
  return `${w.y}-${p2(w.mo)}-${p2(w.d)}T${p2(w.h)}:${p2(w.mi)}`;
}
/* То же для локального Date устройства (фронтенд) */
export function localWallLabel(date) {
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

/* Идентификатор одного срабатывания правила: id правила + локальное время.
   Одинаков у сервера (push) и у локального планировщика — по нему
   срабатывание показывается не больше одного раза. */
export const occurrenceId = (ruleId, wall) => `${ruleId}@${wall}`;
