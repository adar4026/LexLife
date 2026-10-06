/* =========================================================
   js/services/journals.js — «Все журналы»: единое представление записей всех показателей.

   Источник данных не меняется и не копируется: провайдер каждого типа читает уже существующие
   ключи (metrics_log.water, sleep_log, steps_log, bike_log, metrics_log.<точечный показатель>,
   waist_log, workouts_log)
   и при чтении превращает их в одинаковые элементы журнала. Отдельного постоянного хранилища,
   миграции и изменений формата копии нет.

     данные Storage → провайдер типа (collect) → элементы журнала → фильтр → дни (groupJournal)

   Элемент журнала (только для отображения, нигде не хранится):
     { id, type, date: 'ГГГГ-ММ-ДД', time: 'ЧЧ:ММ' | null, seq, title, value, sub,
       amount (число для итога дня | null), progress ({ pct, label } | null), ref (что открыть) }

   Новый тип подключается одной записью в JOURNAL_TYPES: id, label, icon, collect(data, ctx),
   summary(items), emptyText. Экран и Главная — общие и про конкретные типы не знают;
   действия (изменить / удалить / добавить) — js/app.js → JOURNAL_ACTIONS по тому же id.

   Без DOM и без Storage — проверяется в Node (tests/journals.test.mjs).
   ========================================================= */

import { fmtActivityValue, activityUnit, fmtKmApprox, stepsToKm, STEPS_SOURCES, LEGACY_ACTIVITY_SOURCE, isActivityDay } from './activity.js';
import { formatSleepDuration, stampTime, isSleepDay } from './sleep.js';
import { isWaterMinderKey } from './waterImport.js';
import { waistPoints, fmtWaist } from './waist.js';
import { sortWorkouts, workoutTitle, workoutValue, workoutSub, isWorkoutDay } from './workouts.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NB = ' ';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDay = (v) => typeof v === 'string' && DAY_RE.test(v);
const timeOrNull = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : null);

export function plural(n, one, few, many) {
  const a = Math.abs(Math.round(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
/* «1 500», «12 345» — разряды через неразрывный пробел (одинаково во всех браузерах) */
export function fmtInt(n) {
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, NB);
  return n < 0 ? `−${s}` : s;
}
/* «76,4», «36,6», «98» */
const fmtDec = (n, max = 1) => {
  const r = Math.round(n * 10 ** max) / 10 ** max;
  return String(r).replace('.', ',');
};
const fmtMl = (ml) => `${fmtInt(ml)}${NB}мл`;
const plRecords = (n) => `${n}${NB}${plural(n, 'запись', 'записи', 'записей')}`;
const plMeasures = (n) => `${n}${NB}${plural(n, 'измерение', 'измерения', 'измерений')}`;
const plRides = (n) => `${n}${NB}${plural(n, 'поездка', 'поездки', 'поездок')}`;
const plWorkouts = (n) => `${n}${NB}${plural(n, 'тренировка', 'тренировки', 'тренировок')}`;

/* ---------- дни ---------- */
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
/* «Сегодня» · «Вчера» · «03 октября 2026» */
export function journalDayLabel(day, today) {
  if (day === today) return 'Сегодня';
  if (day === addDays(today, -1)) return 'Вчера';
  const [y, m, d] = day.split('-');
  return `${d} ${MONTHS_GEN[Number(m) - 1]} ${y}`;
}

/* ---------- провайдеры ---------- */

/* Вода: каждая запись приёма — отдельный элемент (записи дня не склеиваются).
   «ежедневная цель N%» — накопительный прогресс дня ПОСЛЕ этой записи (записи по времени:
   200 → 8 %, +300 → 19 %, +500 → 38 % при цели 2 600 мл). Округление — как у процента воды
   на Главной и экране «Вода» (Math.round): у одной и той же суммы один процент везде.
   Цель — текущая цель воды (истории целей нет).
   Остаток итога дня без разбивки по приёмам (старые данные) — отдельный элемент без времени,
   поэтому итог дня журнала всегда равен итогу дня экрана «Вода». */
const WATER_SOURCE = (e) => (isWaterMinderKey(e.key) ? 'WaterMinder' : 'вручную');
function collectWater(data, ctx) {
  const log = isObj(data.metricsLog) && isObj(data.metricsLog.water) ? data.metricsLog.water : {};
  const goal = isNum(ctx.waterGoal) && ctx.waterGoal > 0 ? ctx.waterGoal : null;
  const out = [];
  for (const [date, o] of Object.entries(log)) {
    if (!isDay(date) || !isObj(o)) continue;
    const entries = Array.isArray(o.entries) ? o.entries : [];
    let cum = 0;
    let sum = 0;
    entries.forEach((e, i) => {
      if (!isObj(e) || !isNum(e.ml) || e.ml <= 0 || !timeOrNull(e.t)) return;
      cum += e.ml;
      sum += e.ml;
      const drink = typeof e.drink === 'string' && e.drink && e.drink !== 'Вода' ? e.drink : null;
      out.push({
        id: `water:${date}:${i}`, type: 'water', date, time: e.t, seq: i,
        title: drink || 'Вода', value: fmtMl(e.ml), sub: `${e.t} · ${WATER_SOURCE(e)}`, amount: e.ml,
        progress: goal ? { pct: Math.round((cum / goal) * 100), label: 'ежедневная цель' } : null,
        ref: { date, index: i, entry: { t: e.t, ml: e.ml, key: e.key ?? null } },
      });
    });
    const extra = Math.round((isNum(o.total) ? o.total : 0) - sum);
    if (extra > 0) {
      out.push({
        id: `water:${date}:rest`, type: 'water', date, time: null, seq: -1,
        title: 'Вода', value: fmtMl(extra), sub: 'Итог без разбивки по времени', amount: extra,
        progress: null, ref: { date, index: -1, legacy: true },
      });
    }
  }
  return out;
}

/* Сон: запись — ночь, день — дата пробуждения; время для порядка в дне — время пробуждения */
function collectSleep(data, ctx) {
  const list = Array.isArray(data.sleep) ? data.sleep : [];
  const goal = isNum(ctx.sleepGoal) && ctx.sleepGoal > 0 ? ctx.sleepGoal : null;
  return list.filter((e) => isObj(e) && isSleepDay(e.date) && isNum(e.durationMinutes) && typeof e.sleepStart === 'string' && typeof e.sleepEnd === 'string')
    .map((e, i) => ({
      id: `sleep:${e.id}`, type: 'sleep', date: e.date, time: timeOrNull(stampTime(e.sleepEnd)), seq: i,
      title: 'Сон', value: formatSleepDuration(e.durationMinutes), sub: `${stampTime(e.sleepStart)} → ${stampTime(e.sleepEnd)}`,
      amount: e.durationMinutes,
      progress: goal ? { pct: Math.round((e.durationMinutes / goal) * 100), label: 'цель сна' } : null,
      ref: { id: e.id, date: e.date },
    }));
}

/* Шаги: один итог за день (без времени) */
function collectSteps(data) {
  const log = isObj(data.steps) ? data.steps : {};
  const out = [];
  for (const [date, e] of Object.entries(log)) {
    if (!isActivityDay(date) || !isObj(e) || !isNum(e.steps)) continue;
    const src = STEPS_SOURCES[e.source || 'manual'] || String(e.source);
    out.push({
      id: `steps:${date}`, type: 'steps', date, time: null, seq: 0,
      title: 'Шаги', value: fmtActivityValue('steps', e.steps),
      sub: [fmtKmApprox(stepsToKm(e.steps)), src, typeof e.note === 'string' && e.note ? e.note : ''].filter(Boolean).join(' · '),
      amount: e.steps, progress: null, ref: { date, entry: e },
    });
  }
  return out;
}

/* Велосипед: каждая поездка — отдельный элемент; поездка без км (перенесённый велотренажёр) —
   по минутам, в километры дня не входит и никогда не показывается как «0 км» */
function collectBike(data) {
  const list = Array.isArray(data.bike) ? data.bike : [];
  return list.filter((r) => isObj(r) && isActivityDay(r.date)).map((r, i) => {
    const km = isNum(r.km) ? r.km : null;
    const min = isNum(r.minutes) ? `${r.minutes}${NB}мин` : '';
    const trainer = r.source === LEGACY_ACTIVITY_SOURCE || /^Велотренажёр/.test(r.note || '');
    return {
      id: `bike:${r.id}`, type: 'bike', date: r.date, time: timeOrNull(r.time), seq: i,
      title: km == null && trainer ? 'Велотренажёр' : 'Велосипед',
      value: km != null ? `${fmtActivityValue('bike', km)}${NB}км` : min || 'без дистанции',
      sub: [km != null ? min : 'Дистанция не указана', timeOrNull(r.time) || ''].filter(Boolean).join(' · '),
      amount: km, progress: null, ref: { id: r.id, date: r.date, ride: r },
    };
  });
}

/* Точечные показатели: одно значение за день (metrics_log.<ключ>[день]), времени нет */
function pointCollector(key, title, fmt) {
  return (data) => {
    const log = isObj(data.metricsLog) && isObj(data.metricsLog[key]) ? data.metricsLog[key] : {};
    const out = [];
    for (const [date, v] of Object.entries(log)) {
      if (!isDay(date)) continue;
      const value = fmt(v);
      if (value == null) continue;
      out.push({ id: `${key}:${date}`, type: key, date, time: null, seq: 0, title, value, sub: '', amount: key === 'pressure' ? null : v, progress: null, ref: { date, value: v } });
    }
    return out;
  };
}
const single = (unit, digits = 1) => (v) => (isNum(v) && v > 0 ? `${fmtDec(v, digits)}${unit ? `${NB}${unit}` : ''}` : null);
const pressureFmt = (v) => (isObj(v) && isNum(v.systolic) && isNum(v.diastolic) ? `${v.systolic}/${v.diastolic}` : null);
/* итог дня одного точечного показателя: одно значение — само значение, несколько — «N измерений» */
const pointSummary = (items) => (items.length === 1 ? items[0].value : plMeasures(items.length));

/* Обхват талии: одно измерение за день (waist_log), времени нет */
function collectWaist(data) {
  const log = isObj(data.waist) ? data.waist : {};
  return waistPoints(log).map(({ date, cm }) => {
    const e = log[date];
    return {
      id: `waist:${date}`, type: 'waist', date, time: null, seq: 0,
      title: 'Обхват талии', value: fmtWaist(cm), sub: typeof e.note === 'string' ? e.note : '',
      amount: cm, progress: null, ref: { date, entry: e },
    };
  });
}

/* Тренировки: каждая запись — отдельный элемент (Планка / название упражнения); времени нет,
   в пределах дня позже добавленная — выше */
function collectWorkouts(data) {
  const list = sortWorkouts(Array.isArray(data.workouts) ? data.workouts.filter((w) => isObj(w) && isWorkoutDay(w.date)) : []);
  return list.map((w, i) => ({
    id: `workout:${w.id}`, type: 'workout', date: w.date, time: null, seq: list.length - i,
    title: workoutTitle(w), value: workoutValue(w), sub: workoutSub(w),
    amount: null, progress: null, ref: { id: w.id, date: w.date, workout: w },
  }));
}

/* Порядок — порядок фильтров. always — тип ведётся журналом (есть «Добавить»), его фильтр
   виден и без записей; остальные — только когда у пользователя есть записи этого типа.
   «Ходьбы» в LexLife нет (ходьба — это «Шаги»): типов без данных не выдумываем,
   новый тип — новая запись здесь. */
export const JOURNAL_TYPES = [
  { id: 'water', label: 'Вода', icon: 'water', always: true, emptyText: 'Нет записей воды', collect: collectWater,
    summary: (items) => fmtMl(items.reduce((s, x) => s + (x.amount || 0), 0)) },
  { id: 'sleep', label: 'Сон', icon: 'sleep', always: true, emptyText: 'Нет записей сна', collect: collectSleep,
    /* записей за дату обычно одна; если их несколько — основной сон (самый длинный), как в разделе «Сон» */
    summary: (items) => formatSleepDuration(Math.max(...items.map((x) => x.amount))) },
  { id: 'steps', label: 'Шаги', icon: 'steps', always: true, emptyText: 'Нет записей шагов', collect: collectSteps,
    summary: (items) => { const n = items.reduce((s, x) => s + x.amount, 0); return `${fmtActivityValue('steps', n)}${NB}${activityUnit('steps', n)}`; } },
  { id: 'bike', label: 'Велосипед', icon: 'bike', always: true, emptyText: 'Нет поездок', collect: collectBike,
    summary: (items) => {
      const km = items.filter((x) => isNum(x.amount));
      return km.length ? `${fmtActivityValue('bike', Math.round(km.reduce((s, x) => s + x.amount, 0) * 100) / 100)}${NB}км` : plRides(items.length);
    } },
  { id: 'workout', label: 'Тренировки', icon: 'workout', emptyText: 'Пока нет тренировок', collect: collectWorkouts,
    summary: (items) => plWorkouts(items.length) },
  { id: 'weight', label: 'Вес', icon: 'weight', emptyText: 'Нет записей веса', collect: pointCollector('weight', 'Вес', single('кг')), summary: pointSummary },
  { id: 'waist', label: 'Талия', icon: 'waist', emptyText: 'Пока нет измерений', collect: collectWaist, summary: pointSummary },
  { id: 'pressure', label: 'Давление', icon: 'pressure', emptyText: 'Нет записей давления', collect: pointCollector('pressure', 'Давление', pressureFmt),
    summary: (items) => plMeasures(items.length) },
  { id: 'pulse', label: 'Пульс', icon: 'pulse', emptyText: 'Нет записей пульса', collect: pointCollector('pulse', 'Пульс', single('уд/мин', 0)), summary: pointSummary },
  { id: 'temperature', label: 'Температура', icon: 'temperature', emptyText: 'Нет записей температуры', collect: pointCollector('temperature', 'Температура', single('°C')), summary: pointSummary },
  { id: 'spo2', label: 'Сатурация', icon: 'spo2', emptyText: 'Нет записей сатурации', collect: pointCollector('spo2', 'Сатурация', single('%', 0)), summary: pointSummary },
  { id: 'glucose', label: 'Глюкоза', icon: 'glucose', emptyText: 'Нет записей глюкозы', collect: pointCollector('glucose', 'Глюкоза', single('ммоль/л')), summary: pointSummary },
];
const TYPE_BY_ID = new Map(JOURNAL_TYPES.map((t) => [t.id, t]));
const TYPE_ORDER = new Map(JOURNAL_TYPES.map((t, i) => [t.id, i]));
export const journalType = (id) => TYPE_BY_ID.get(id) || null;
export const isJournalFilter = (f) => f === 'all' || TYPE_BY_ID.has(f);

/* ---------- сборка, фильтр, дни ---------- */

/* Внутри дня новые выше: по времени (без времени — ниже записей со временем), при равном
   времени — позже добавленная выше, затем порядок типов */
export function compareInDay(a, b) {
  const ta = a.time || '', tb = b.time || '';
  if (ta !== tb) return tb.localeCompare(ta);
  if (a.type !== b.type) return (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99);
  return b.seq - a.seq;
}

/* data: { metricsLog, sleep, steps, bike, waist, workouts }; ctx: { waterGoal, sleepGoal } → все элементы */
export function buildJournal(data = {}, ctx = {}, types = JOURNAL_TYPES) {
  const out = [];
  for (const t of types) {
    for (const it of t.collect(data, ctx)) out.push(it);
  }
  return out;
}

export const filterJournal = (items, filter = 'all') => (filter && filter !== 'all' ? items.filter((x) => x.type === filter) : items.slice());

/* Итог дня: записи одного типа — итог этого типа («1 500 мл», «8 420 шагов», «7 ч 42 мин»);
   разные типы — «N записей» (несовместимые единицы не складываются) */
export function daySummary(items, types = TYPE_BY_ID) {
  if (!items.length) return '';
  const kinds = new Set(items.map((x) => x.type));
  if (kinds.size === 1) {
    const t = types.get ? types.get(items[0].type) : null;
    if (t && t.summary) return t.summary(items);
  }
  return plRecords(items.length);
}

/* → [{ date, label, summary, items }] — дни новые сверху, записи дня новые сверху; пустых дней нет */
export function groupJournal(items, { today } = {}) {
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.date)) byDay.set(it.date, []);
    byDay.get(it.date).push(it);
  }
  return [...byDay.keys()].sort((a, b) => b.localeCompare(a)).map((date) => {
    const list = byDay.get(date).sort(compareInDay);
    return { date, label: today ? journalDayLabel(date, today) : date, summary: daySummary(list), items: list };
  });
}

/* Фильтры: «Все» + типы, у которых есть записи или которые ведутся журналом (always);
   active — показывается всегда (открыли журнал из раздела без записей) */
export function journalFilters(items, active = 'all', types = JOURNAL_TYPES) {
  const has = new Set(items.map((x) => x.type));
  return [{ id: 'all', label: 'Все' }, ...types.filter((t) => t.always || has.has(t.id) || t.id === active).map((t) => ({ id: t.id, label: t.label }))];
}

export function journalEmptyText(filter) {
  const t = filter && filter !== 'all' ? TYPE_BY_ID.get(filter) : null;
  return t ? t.emptyText : 'Записей пока нет';
}

/* Порционный показ: первые limit дней, но не меньше, чем нужно, чтобы показать focus-дату */
export const JOURNAL_PAGE_DAYS = 21;
export function visibleDays(groups, limit = JOURNAL_PAGE_DAYS, focus = null) {
  let n = Math.max(1, limit);
  if (focus) {
    const i = groups.findIndex((g) => g.date <= focus);
    if (i >= 0) n = Math.max(n, i + 1);
  }
  return groups.slice(0, n);
}

/* Записи за сегодня для Главной: новые сверху, не больше limit; total — сколько всего */
export function todayJournal(items, today, limit = 3) {
  const list = items.filter((x) => x.date === today).sort(compareInDay);
  return { items: list.slice(0, limit), total: list.length };
}

/* Разбор адреса «journals[/<фильтр>[/ГГГГ-ММ-ДД]]» → { filter, focus } */
export function parseJournalRoute(rest = '') {
  const [f, d] = String(rest || '').split('/');
  return { filter: isJournalFilter(f) ? f : 'all', focus: isDay(d) ? d : null };
}
export const journalRoute = (filter = 'all', focus = null) => `journals${filter && filter !== 'all' ? `/${filter}` : focus ? '/all' : ''}${focus ? `/${focus}` : ''}`;

