/* =========================================================
   activity.js — самостоятельные показатели «Шаги», «Дистанция пешком», «Велосипед»:
   модель записи, проверка, суммы по дням, статистика периода, миграция старой «Активности».
   Чистые функции без DOM и без хранилища (storage.js импортирует этот файл).

   Модель (аддитивные ключи, схема v8 не меняется — как sleep_log и med_intakes):
   • steps_log = { "ГГГГ-ММ-ДД": { steps, note, source, createdAt, updatedAt } }
     Один итог за календарный день: повторная запись той же даты обновляет значение,
     дубля быть не может по устройству хранилища. Шаги на беговой дорожке — обычные шаги.
   • walk_log  = { "ГГГГ-ММ-ДД": { km, note, source, createdAt, updatedAt } }
     Тоже один дневной итог (как шаги и точечные показатели metrics_log): итог дня вводится
     и правится целиком, его дата переносится одной операцией.
   • bike_log  = [{ id, date, time, km, minutes, note, source, createdAt, updatedAt }]
     Несколько поездок за день; итог дня — сумма km. time «ЧЧ:ММ» необязательно;
     km или minutes — хотя бы одно (перенесённые записи велотренажёра — только минуты).
   • activity_migration = { version, migratedAt, stepsAdded, bikeAdded, … } — отметка
     однократного переноса из activity_days. Хранится вместе с данными (входит в бэкап),
     поэтому удалённая пользователем перенесённая запись не возвращается ни при следующем
     запуске, ни после восстановления новой копии.
   source: 'manual' — вручную, 'activity' — перенесено из старого раздела «Активность»;
   будущие источники (импорт) — свои ключи. Пропущенный день — «нет данных», а не 0.
   ========================================================= */

import { periodBounds, shiftPeriod, addDays, daysBetween, localDay } from './sleep.js';

export const ACTIVITY_KEYS = ['steps', 'walk', 'bike'];
/* Ограничения ввода (разумные пределы для одного дня / одной поездки) */
export const STEPS_MAX = 200000;
export const WALK_KM_MAX = 300;
export const RIDE_KM_MAX = 1000;
export const RIDE_MINUTES_MAX = 1440;
export const ACTIVITY_NOTE_MAX = 500;
export const LEGACY_ACTIVITY_SOURCE = 'activity';
export const ACTIVITY_MIGRATION_VERSION = 1;

/* Описание показателей для экранов: единица, точность, маршруты */
export const ACTIVITY_METRICS = {
  steps: { key: 'steps', title: 'Шаги', short: 'Шаги', emoji: '👟', route: 'steps', logRoute: 'steps-log', kind: 'daily', field: 'steps', unit: 'шагов', decimals: 0, max: STEPS_MAX },
  walk: { key: 'walk', title: 'Дистанция пешком', short: 'Пешком', emoji: '🚶', route: 'walk', logRoute: 'walk-log', kind: 'daily', field: 'km', unit: 'км', decimals: 2, max: WALK_KM_MAX },
  bike: { key: 'bike', title: 'Велосипед', short: 'Велосипед', emoji: '🚴', route: 'bike', logRoute: 'bike-log', kind: 'rides', field: 'km', unit: 'км', decimals: 2, max: RIDE_KM_MAX },
};

/* ---------- примитивы ---------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const pad = (n) => String(n).padStart(2, '0');
const round2 = (v) => Math.round(v * 100) / 100;

/* настоящая календарная дата (31 февраля — нет) */
export function isActivityDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
export const isActivityTime = (v) => typeof v === 'string' && TIME_RE.test(v);

/* «8 450», «6,4», «7.45» → число | NaN (пустая строка → null) */
export function parseActivityNumber(raw) {
  if (raw == null) return null;
  if (isNum(raw)) return raw;
  const s = String(raw).replace(/[\s  ]/g, '').replace(',', '.');
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/* ---------- форма → запись ---------- */

/* Дневной итог (шаги / дистанция пешком). input: { date, value, note }, opts.today.
   → { ok, errors, value: { date, steps|km, note } } */
export function normalizeDailyInput(metric, input = {}, { today = localDay() } = {}) {
  const M = ACTIVITY_METRICS[metric];
  if (!M || M.kind !== 'daily') throw new Error(`не дневной показатель: ${metric}`);
  const errors = {};
  const date = String(input.date || '');
  if (!isActivityDay(date)) errors.date = 'Укажите дату';
  else if (date > today) errors.date = 'Дата не может быть в будущем';
  const n = parseActivityNumber(input.value);
  let v = null;
  if (n == null || Number.isNaN(n)) errors.value = metric === 'steps' ? 'Укажите количество шагов' : 'Укажите дистанцию в километрах';
  else if (metric === 'steps') {
    v = Math.round(n);
    if (v < 0 || v > STEPS_MAX) errors.value = `Шагов — от 0 до ${STEPS_MAX.toLocaleString('ru-RU')}`;
  } else {
    v = round2(n);
    if (v < 0 || v > WALK_KM_MAX) errors.value = `Дистанция — от 0 до ${WALK_KM_MAX} км`;
  }
  const note = String(input.note || '').trim().slice(0, ACTIVITY_NOTE_MAX);
  const ok = !Object.keys(errors).length;
  return { ok, errors, value: ok ? { date, [M.field]: v, note } : null };
}

/* Поездка. input: { date, time, km, minutes, note } → { ok, errors, value } */
export function normalizeRideInput(input = {}, { today = localDay() } = {}) {
  const errors = {};
  const date = String(input.date || '');
  if (!isActivityDay(date)) errors.date = 'Укажите дату';
  else if (date > today) errors.date = 'Дата не может быть в будущем';
  const time = input.time == null || input.time === '' ? null : String(input.time);
  if (time != null && !isActivityTime(time)) errors.time = 'Время — в формате ЧЧ:ММ';
  const kmRaw = parseActivityNumber(input.km);
  const minRaw = parseActivityNumber(input.minutes);
  let km = null, minutes = null;
  if (kmRaw != null) {
    if (Number.isNaN(kmRaw) || kmRaw <= 0 || kmRaw > RIDE_KM_MAX) errors.km = `Дистанция — больше 0 и не больше ${RIDE_KM_MAX} км`;
    else km = round2(kmRaw);
  }
  if (minRaw != null) {
    if (Number.isNaN(minRaw) || Math.round(minRaw) < 1 || minRaw > RIDE_MINUTES_MAX) errors.minutes = `Время в пути — от 1 до ${RIDE_MINUTES_MAX} минут`;
    else minutes = Math.round(minRaw);
  }
  if (kmRaw == null && minRaw == null) errors.km = 'Укажите дистанцию в километрах';
  const note = String(input.note || '').trim().slice(0, ACTIVITY_NOTE_MAX);
  const ok = !Object.keys(errors).length;
  return { ok, errors, value: ok ? { date, time, km, minutes, note } : null };
}

/* ---------- проверка структуры (хранилище, резервная копия) ---------- */
const isText = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
const metaOk = (e) => (e.source == null || (typeof e.source === 'string' && SOURCE_RE.test(e.source)))
  && isText(e.note, ACTIVITY_NOTE_MAX * 2) && isText(e.createdAt, 40) && isText(e.updatedAt, 40);

export function isValidStepsEntry(e) {
  return isObj(e) && isInt(e.steps) && e.steps >= 0 && e.steps <= STEPS_MAX && metaOk(e);
}
export function isValidWalkEntry(e) {
  return isObj(e) && isNum(e.km) && e.km >= 0 && e.km <= WALK_KM_MAX && metaOk(e);
}
const dailyLogOf = (entryOk) => (v) => isObj(v) && Object.entries(v).every(([d, e]) => isActivityDay(d) && entryOk(e));
export const isValidStepsLog = dailyLogOf(isValidStepsEntry);
export const isValidWalkLog = dailyLogOf(isValidWalkEntry);

export function isValidRide(e) {
  const hasKm = e && e.km != null, hasMin = e && e.minutes != null;
  return isObj(e) && typeof e.id === 'string' && ID_RE.test(e.id) && isActivityDay(e.date)
    && (e.time == null || isActivityTime(e.time))
    && (!hasKm || (isNum(e.km) && e.km > 0 && e.km <= RIDE_KM_MAX))
    && (!hasMin || (isInt(e.minutes) && e.minutes >= 1 && e.minutes <= RIDE_MINUTES_MAX))
    && (hasKm || hasMin) && metaOk(e);
}
export const isValidBikeLog = (v) => Array.isArray(v) && v.every(isValidRide);
export const isValidActivityMigration = (v) => v == null || (isObj(v) && isInt(v.version) && v.version >= 1 && isText(v.migratedAt, 40));

/* ---------- суммы по дням ---------- */

/* Поездки: новые сверху (дата, затем время; без времени — ниже поездок со временем) */
export function sortRides(rides) {
  return (Array.isArray(rides) ? rides.slice() : []).sort((a, b) => b.date.localeCompare(a.date)
    || String(b.time || '').localeCompare(String(a.time || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
/* Поездки по датам: Map(date → поездки дня по времени, раньше — выше) */
export function ridesByDate(rides) {
  const map = new Map();
  for (const r of Array.isArray(rides) ? rides : []) {
    if (!isObj(r) || !isActivityDay(r.date)) continue;
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  for (const list of map.values()) list.sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')));
  return map;
}
/* Итог дня велосипеда: сумма km поездок с дистанцией; дня без дистанции — нет (null) */
export function rideDayKm(list) {
  const withKm = (list || []).filter((r) => isNum(r.km));
  return withKm.length ? round2(withKm.reduce((s, r) => s + r.km, 0)) : null;
}

/* Значения по дням: { "ГГГГ-ММ-ДД": число } — только дни, где значение есть.
   store — steps_log / walk_log (объект) или bike_log (массив). */
export function dayValues(metric, store) {
  const M = ACTIVITY_METRICS[metric];
  const out = {};
  if (!M) return out;
  if (M.kind === 'rides') {
    for (const [d, list] of ridesByDate(store)) { const v = rideDayKm(list); if (v != null) out[d] = v; }
    return out;
  }
  if (!isObj(store)) return out;
  for (const [d, e] of Object.entries(store)) if (isActivityDay(d) && isObj(e) && isNum(e[M.field])) out[d] = e[M.field];
  return out;
}

/* Последнее значение не позже today: { date, value } | null */
export function latestValue(values, today = localDay()) {
  const days = Object.keys(values || {}).filter((d) => d <= today).sort();
  const d = days[days.length - 1];
  return d ? { date: d, value: values[d] } : null;
}
/* Последние n дней по today включительно: [{ date, value|null }] (для мини-графика) */
export function lastDays(values, n = 7, today = localDay()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = addDays(today, -i); out.push({ date: d, value: values && isNum(values[d]) ? values[d] : null }); }
  return out;
}

/* ---------- статистика периода ----------
   kind — 'week' | 'month' | 'year' (календарные, как у «Сна»: неделя Пн–Вс), anchor — любой день периода.
   Всё считается из одних и тех же дней периода [start, min(end, today)] — переключение периода
   пересчитывает и график, и среднее, и максимум/минимум, и лучший день, и число дней с данными.
   Среднее — по дням с данными (пропуск ≠ 0: значение вводится вручную, пустой день — неизвестен).
   Год: 12 месячных столбцов (среднее за день с данными в месяце + сумма); исходные дни не теряются. */
export function activityPeriodStats(values, kind, anchor, today = localDay()) {
  const b = periodBounds(kind, anchor);
  const end = b.end < today ? b.end : today;
  const elapsed = end >= b.start ? daysBetween(b.start, end) + 1 : 0;
  const days = Object.keys(values || {}).filter((d) => d >= b.start && d <= end && isNum(values[d])).sort();
  const pts = days.map((date) => ({ date, value: values[date] }));
  const total = round2(pts.reduce((s, p) => s + p.value, 0));
  let max = null, min = null;
  for (const p of pts) {
    if (!max || p.value > max.value) max = p;
    if (!min || p.value < min.value) min = p;
  }
  let bars;
  if (kind === 'year') {
    const y = b.start.slice(0, 4);
    bars = Array.from({ length: 12 }, (_, i) => {
      const ym = `${y}-${pad(i + 1)}`;
      const mb = periodBounds('month', `${ym}-01`);
      const inside = pts.filter((p) => p.date.startsWith(ym));
      const sum = round2(inside.reduce((s, p) => s + p.value, 0));
      return { kind: 'month', month: ym, start: mb.start, end: mb.end, value: inside.length ? sum / inside.length : null, total: sum, days: inside.length };
    });
  } else {
    bars = [];
    for (let d = b.start; d <= b.end; d = addDays(d, 1)) bars.push({ kind: 'day', date: d, start: d, end: d, value: isNum(values && values[d]) && d <= today ? values[d] : null });
  }
  return {
    kind, start: b.start, end: b.end, elapsedDays: elapsed,
    daysWithData: pts.length, total,
    average: pts.length ? total / pts.length : null,
    max, min, best: max,
    bars,
  };
}
/* Сравнение среднего с предыдущим периодом того же вида → { prevAverage, delta } | null */
export function comparePrevPeriod(values, kind, anchor, today = localDay()) {
  const cur = activityPeriodStats(values, kind, anchor, today);
  const prevB = shiftPeriod(periodBounds(kind, anchor), -1);
  const prev = activityPeriodStats(values, kind, prevB.start, today);
  if (cur.average == null || prev.average == null) return null;
  return { prevAverage: prev.average, delta: cur.average - prev.average };
}

/* ---------- миграция старого раздела «Активность» (activity_days) ----------
   Переносит шаги (> 0) в steps_log и минуты велотренажёра (> 0) в bike_log как поездку без
   дистанции. Существующие записи не перезаписываются (дата шагов уже занята → пропуск;
   поездка с тем же детерминированным id legacy-<дата> уже есть → пропуск), поэтому повторный
   запуск ничего не дублирует. activity_days не изменяется: планка, «другое упражнение» и
   интенсивность остаются там (и в бэкапе). Значения вне допустимых пределов не переносятся.
   → { stepsLog, bikeLog, marker, changed } (вход не изменяется) */
export function migrateLegacyActivity({ activityDays, stepsLog, bikeLog } = {}, { now = new Date().toISOString() } = {}) {
  const steps = isObj(stepsLog) ? { ...stepsLog } : {};
  const rides = Array.isArray(bikeLog) ? bikeLog.slice() : [];
  const ids = new Set(rides.map((r) => r && r.id));
  const marker = { version: ACTIVITY_MIGRATION_VERSION, migratedAt: now, stepsAdded: 0, stepsSkipped: 0, bikeAdded: 0, bikeSkipped: 0, invalid: 0 };
  const days = isObj(activityDays) ? Object.keys(activityDays).filter(isActivityDay).sort() : [];
  for (const d of days) {
    const a = activityDays[d];
    if (!isObj(a)) continue;
    const at = typeof a.savedAt === 'string' && a.savedAt.length <= 40 ? a.savedAt : null;
    if (isNum(a.steps) && a.steps > 0) {
      const entry = { steps: Math.round(a.steps), note: '', source: LEGACY_ACTIVITY_SOURCE, createdAt: at, updatedAt: at };
      if (steps[d]) marker.stepsSkipped += 1;
      else if (!isValidStepsEntry(entry)) marker.invalid += 1;
      else { steps[d] = entry; marker.stepsAdded += 1; }
    }
    if (isNum(a.bike) && a.bike > 0) {
      const id = `legacy-${d}`;
      const intensity = typeof a.bikeIntensity === 'string' ? a.bikeIntensity.trim().slice(0, 40) : '';
      const ride = {
        id, date: d, time: null, km: null, minutes: Math.round(a.bike),
        note: `Велотренажёр${intensity ? ` · интенсивность: ${intensity.toLowerCase()}` : ''}`,
        source: LEGACY_ACTIVITY_SOURCE, createdAt: at, updatedAt: at,
      };
      if (ids.has(id)) marker.bikeSkipped += 1;
      else if (!isValidRide(ride)) marker.invalid += 1;
      else { rides.push(ride); ids.add(id); marker.bikeAdded += 1; }
    }
  }
  return { stepsLog: steps, bikeLog: rides, marker, changed: marker.stepsAdded + marker.bikeAdded > 0 };
}

/* ---------- форматирование ---------- */
export function fmtActivityValue(metric, v) {
  if (v == null || !isNum(v)) return '—';
  if (metric === 'steps') return Math.round(v).toLocaleString('ru-RU');
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}
const plural = (n, one, few, many) => {
  const a = Math.abs(Math.round(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
/* единица под число: «1 шаг», «3 шага», «8 450 шагов»; км не склоняется */
export const activityUnit = (metric, v) => (metric === 'steps' ? plural(v ?? 0, 'шаг', 'шага', 'шагов') : 'км');
export const fmtActivity = (metric, v) => `${fmtActivityValue(metric, v)} ${activityUnit(metric, v)}`;
