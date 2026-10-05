/* =========================================================
   activity.js — самостоятельные показатели «Шаги» и «Велосипед»:
   модель записи, проверка, суммы по дням, статистика периода, миграция старой «Активности»,
   расчётные километры из шагов (stepsToKm).
   Чистые функции без DOM и без хранилища (storage.js импортирует этот файл).

   Модель (аддитивные ключи, схема v8 не меняется — как sleep_log и med_intakes):
   • steps_log = { "ГГГГ-ММ-ДД": { steps, note, source, createdAt, updatedAt } }
     Один итог за календарный день: повторная запись той же даты обновляет значение,
     дубля быть не может по устройству хранилища. «Шаги» — вся ходьба за день: прогулка,
     дома, беговая дорожка, вручную, будущий автоматический источник. source — только метка
     происхождения итога (STEPS_SOURCES), отдельного показателя у источника нет.
     Километры рядом с шагами — оценка, считается при показе (stepsToKm) и нигде не хранится:
     ни в записи, ни в резервной копии. Реальную дистанцию (GPS / Apple Health), если она
     появится, нельзя молча смешивать с этой оценкой.
   • bike_log  = [{ id, date, time, km, minutes, note, source, createdAt, updatedAt }]
     Несколько поездок за день; итог дня — сумма km. time «ЧЧ:ММ» необязательно;
     km или minutes — хотя бы одно (перенесённые записи велотренажёра — только минуты).
   • activity_migration = { version, migratedAt, stepsAdded, bikeAdded, … } — отметка
     однократного переноса из activity_days. Хранится вместе с данными (входит в бэкап),
     поэтому удалённая пользователем перенесённая запись не возвращается ни при следующем
     запуске, ни после восстановления новой копии.
   source: 'manual' — вручную, 'activity' — перенесено из старого раздела «Активность»;
   у шагов ещё 'stroll' / 'treadmill' / 'auto' (STEPS_SOURCES); будущие источники — свои ключи. Пропущенный день — «нет данных», а не 0.
   ========================================================= */

import { periodBounds, shiftPeriod, addDays, daysBetween, localDay } from './sleep.js';

export const ACTIVITY_KEYS = ['steps', 'bike'];
/* Ограничения ввода (разумные пределы для одного дня / одной поездки) */
export const STEPS_MAX = 200000;
export const RIDE_KM_MAX = 1000;
export const RIDE_MINUTES_MAX = 1440;
export const ACTIVITY_NOTE_MAX = 500;
export const LEGACY_ACTIVITY_SOURCE = 'activity';
export const ACTIVITY_MIGRATION_VERSION = 1;

/* Описание показателей для экранов: единица, точность, маршруты */
export const ACTIVITY_METRICS = {
  steps: { key: 'steps', title: 'Шаги', short: 'Шаги', emoji: '👟', route: 'steps', logRoute: 'steps-log', kind: 'daily', field: 'steps', unit: 'шагов', decimals: 0, max: STEPS_MAX },
  bike: { key: 'bike', title: 'Велосипед', short: 'Велосипед', emoji: '🚴', route: 'bike', logRoute: 'bike-log', kind: 'rides', field: 'km', unit: 'км', decimals: 2, max: RIDE_KM_MAX },
};

/* Источник дневного итога шагов — только метка. Выбрать в форме можно STEPS_SOURCE_CHOICES;
   'auto' — задел под автоматический источник, 'activity' — перенесённые записи. */
export const STEPS_SOURCES = { manual: 'Вручную', stroll: 'Прогулка', treadmill: 'Беговая дорожка', auto: 'Автоматически', activity: 'Перенесено из прежней версии' };
export const STEPS_SOURCE_CHOICES = ['manual', 'stroll', 'treadmill'];

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

/* Дневной итог шагов. input: { date, value, note, source? }, opts.today.
   source — ключ STEPS_SOURCES (не задан — хранилище оставит прежний / 'manual').
   → { ok, errors, value: { date, steps, note[, source] } } */
export function normalizeDailyInput(metric, input = {}, { today = localDay() } = {}) {
  const M = ACTIVITY_METRICS[metric];
  if (!M || M.kind !== 'daily') throw new Error(`не дневной показатель: ${metric}`);
  const errors = {};
  const date = String(input.date || '');
  if (!isActivityDay(date)) errors.date = 'Укажите дату';
  else if (date > today) errors.date = 'Дата не может быть в будущем';
  const n = parseActivityNumber(input.value);
  let v = null;
  if (n == null || Number.isNaN(n)) errors.value = 'Укажите количество шагов';
  else {
    v = Math.round(n);
    if (v < 0 || v > STEPS_MAX) errors.value = `Шагов — от 0 до ${STEPS_MAX.toLocaleString('ru-RU')}`;
  }
  const source = input.source == null || input.source === '' ? null : String(input.source);
  if (source != null && !Object.prototype.hasOwnProperty.call(STEPS_SOURCES, source)) errors.source = 'Неизвестный источник';
  const note = String(input.note || '').trim().slice(0, ACTIVITY_NOTE_MAX);
  const ok = !Object.keys(errors).length;
  return { ok, errors, value: ok ? { date, [M.field]: v, note, ...(source ? { source } : {}) } : null };
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
const dailyLogOf = (entryOk) => (v) => isObj(v) && Object.entries(v).every(([d, e]) => isActivityDay(d) && entryOk(e));
export const isValidStepsLog = dailyLogOf(isValidStepsEntry);

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
   store — steps_log (объект) или bike_log (массив). */
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

/* ---------- километры из шагов (оценка) ----------
   Длина шага при ходьбе ≈ рост × 0,415; км = шаги × длина шага (см) / 100 000, округление до 0,1.
   Роста в приложении нет → DEFAULT_HEIGHT_CM (шаг 74,7 см). Длина шага считается в целых мм,
   чтобы округление не зависело от двоичной погрешности (180 × 0,415 = 74,69999…). */
export const STEP_LENGTH_FACTOR = 0.415;
export const DEFAULT_HEIGHT_CM = 180;
const HEIGHT_MIN = 100, HEIGHT_MAX = 250;
const stepLengthMm = (heightCm) => Math.round((isNum(heightCm) && heightCm >= HEIGHT_MIN && heightCm <= HEIGHT_MAX ? heightCm : DEFAULT_HEIGHT_CM) * STEP_LENGTH_FACTOR * 10);
/* длина шага, см: 180 → 74,7; рост не задан / вне 100–250 см → по DEFAULT_HEIGHT_CM */
export const stepLengthCm = (heightCm) => stepLengthMm(heightCm) / 10;
/* шаги → км (0,1) | null, если шагов нет / некорректно */
export function stepsToKm(steps, heightCm) {
  if (!isNum(steps) || steps < 0) return null;
  return Math.round((Math.round(steps) * stepLengthMm(heightCm)) / 100000) / 10;
}
/* «≈ 6,3 км» (неразрывные пробелы — «≈» не отрывается от числа) | '' */
export function fmtKmApprox(km) {
  return isNum(km) ? `≈\u00a0${km.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0км` : '';
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
/* «8 450 шагов · ≈ 6,3 км» — у шагов рядом всегда расчётные км (opts.km: false — без них,
   opts.heightCm — рост, если появится); «7,4 км» — велосипед */
export function fmtActivity(metric, v, { km = true, heightCm } = {}) {
  const base = `${fmtActivityValue(metric, v)} ${activityUnit(metric, v)}`;
  if (metric !== 'steps' || !km) return base;
  const approx = fmtKmApprox(stepsToKm(v, heightCm));
  return approx ? `${base} · ${approx}` : base;
}
export const fmtSteps = (steps, heightCm) => fmtActivity('steps', steps, { heightCm });
