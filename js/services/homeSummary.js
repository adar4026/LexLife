/* =========================================================
   homeSummary.js — данные главного экрана: чистые функции без DOM и хранилища.
   • waterProgress — прогресс воды за сегодня (без отрицательного «осталось»);
   • homeWaterStatus — статус воды на Главной: остаток до дневной цели / превышение;
   • waterPlanMarker — положение плановой метки на шкале воды Главной;
   • waterPlanDelta — отклонение от плана к текущему моменту (подпись этой метки);
   • waterDayStatus — вода относительно плана гидратации (с допуском);
   • medsToday — лекарства на сегодня: сколько в плане дня и сколько отмечено;
   • upcomingVisit — ближайший запланированный / следующий визит (как в Календаре);
   • attentionItems — «Требует внимания»: последние значения показателей анализов,
     которые приложение уже отмечает как вне диапазона (evaluateField — справочные
     значения приложения для основных полей; outOfLabRange — диапазон бланка для
     показателей лаборатории). Новых медицинских правил здесь нет;
   • upcomingMed — «Ближайшее»: один ближайший предстоящий приём лекарства по его
     расписанию (services/meds.js) и отметкам приёмов за сегодня;
   • recentActivity — «Последняя активность»: из последнего анализа, последнего
     измерения и последнего прошедшего визита — самый поздний по дате.
   ========================================================= */

import { REFERENCE, TEST_FIELDS, sortTests, dateKey } from './storage.js';
import { evaluateField, outOfLabRange, resultKey, urineStandard, groupSummary } from './testsJournal.js';
import { nextDose, medSchedule, medDaySlots, medOccurrences, isMedDueOn, nextDueDay, intakeSummary } from './meds.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ---------- вода ---------- */
/* → { current, goal, progress (0…1), remaining (≥ 0), reached, over (мл сверх цели) } */
export function waterProgress(current, goal) {
  const cur = isNum(current) && current > 0 ? current : 0;
  const g = isNum(goal) && goal > 0 ? goal : 0;
  return {
    current: cur,
    goal: g,
    progress: g ? Math.min(cur / g, 1) : 0,
    remaining: Math.max(g - cur, 0),
    reached: g > 0 && cur >= g,
    over: g > 0 && cur > g ? cur - g : 0,
  };
}

/* Быстрое действие hero «+ N мл»: одна запись воды этим объёмом (Storage.addWaterEntry) */
export const HOME_WATER_QUICK_ADD = 300;

/* Статус воды на Главной — остаток до дневной цели (план гидратации здесь не участвует;
   оценка по плану — waterDayStatus, экран «Вода»).
   → { state: 'none' (цели нет) | 'done' (цель выполнена) | 'remaining', remaining (мл, ≥ 0), over (мл сверх цели) } */
export function homeWaterStatus(current, goal) {
  const p = waterProgress(current, goal);
  if (!p.goal) return { state: 'none', remaining: 0, over: 0 };
  if (p.reached) return { state: 'done', remaining: 0, over: p.over };
  return { state: 'remaining', remaining: p.remaining, over: 0 };
}

/* Положение плановой метки на шкале воды Главной: доля цели, которую по плану нужно выпить
   к текущему моменту (plannedMl считает app.js — plannedByNow). → 0…1, или null — цели нет, метки нет */
export function waterPlanMarker(plannedMl, goal) {
  if (!isNum(goal) || goal <= 0) return null;
  const planned = isNum(plannedMl) ? plannedMl : 0;
  return Math.min(Math.max(planned / goal, 0), 1);
}

/* Допуск текстового статуса отклонения на Главной, мл: |delta| ≤ допуска — «По плану».
   На сам delta и на положение метки не влияет. */
export const WATER_PLAN_DELTA_TOLERANCE = 50;

/* Отклонение от плана воды к текущему моменту — числовая подпись той же красной метки:
   delta = выпито − план к текущему моменту (plannedMl — plannedByNow из app.js, ограничен целью,
   как и метка), точно, в целых мл. Допуск WATER_PLAN_DELTA_TOLERANCE — только для state.
   → { state: 'none' (цели нет) | 'behind' (delta < −50) | 'ahead' (delta > 50) | 'onPlan' (−50…50), delta (целые мл) } */
export function waterPlanDelta(current, goal, plannedMl) {
  const p = waterProgress(current, goal);
  if (!p.goal) return { state: 'none', delta: 0 };
  const planned = isNum(plannedMl) ? Math.min(Math.max(plannedMl, 0), p.goal) : 0;
  const delta = Math.round(p.current - planned) || 0; // || 0 — без «−0»
  const state = delta < -WATER_PLAN_DELTA_TOLERANCE ? 'behind' : delta > WATER_PLAN_DELTA_TOLERANCE ? 'ahead' : 'onPlan';
  return { state, delta };
}

/* Допуск плана воды, мл: отклонение в его пределах — «по плану»; пока план к текущему моменту
   не больше допуска и ничего не выпито — «день только начался» (до подъёма план = 0) */
export const WATER_PLAN_TOLERANCE = 150;

/* Состояние дня по воде относительно плана гидратации — по тому же плану, что на экране «Вода»
   (выпито − план к текущему моменту), но с допуском WATER_PLAN_TOLERANCE. plannedMl считает app.js (plannedByNow).
   → { state: 'none' (цели нет) | 'done' | 'start' | 'onTrack' | 'ahead' | 'behind',
       behind (мл, ≥ 0), ahead (мл опережения, ≥ 0), over (мл сверх цели) } */
export function waterDayStatus(current, goal, plannedMl) {
  const p = waterProgress(current, goal);
  if (!p.goal) return { state: 'none', behind: 0, ahead: 0, over: 0 };
  if (p.reached) return { state: 'done', behind: 0, ahead: 0, over: p.over };
  const planned = isNum(plannedMl) ? Math.min(Math.max(plannedMl, 0), p.goal) : 0;
  const diff = Math.round(p.current - planned);
  if (diff < -WATER_PLAN_TOLERANCE) return { state: 'behind', behind: -diff, ahead: 0, over: 0 };
  if (diff > WATER_PLAN_TOLERANCE) return { state: 'ahead', behind: 0, ahead: diff, over: 0 };
  return { state: p.current === 0 ? 'start' : 'onTrack', behind: 0, ahead: 0, over: 0 };
}

/* ---------- «Требует внимания» ---------- */
const LABEL = { high: 'Выше нормы', low: 'Ниже нормы' };
const LEVEL_ORDER = { danger: 0, warn: 1 };

/* Направление отклонения основного поля — по тем же справочным значениям, что и evaluateField */
function fieldDirection(field, v) {
  const ref = REFERENCE[field];
  if (ref.higherIsBetter) return 'low';
  if (ref.goodMin != null && v < ref.goodMin) return 'low';
  return 'high';
}

/* tests — записи health_tests (любой порядок). Для каждого показателя берётся только
   его последнее значение (самый новый анализ, где он есть): старые отклонения,
   уже перекрытые новым результатом, не показываются.
   → { items: [{ key, name, value, unit, date, testId, level: 'danger'|'warn', dir: 'high'|'low', label }], total } */
export function attentionItems(tests, { limit = 3 } = {}) {
  const list = sortTests((Array.isArray(tests) ? tests : []).filter((t) => t && typeof t.date === 'string'));
  const found = [];

  TEST_FIELDS.forEach((f, order) => {
    const t = list.find((x) => isNum(x[f]));
    if (!t) return;
    const status = evaluateField(f, t[f]);
    if (status !== 'warn' && status !== 'danger') return;
    const dir = fieldDirection(f, t[f]);
    found.push({ key: f, name: REFERENCE[f].label, value: t[f], unit: REFERENCE[f].unit, date: t.date, testId: t.id, level: status, dir, label: LABEL[dir], order });
  });

  /* показатели лаборатории: последний результат по ключу истории; ↑/↓ — только при числовом диапазоне бланка */
  const seen = new Set();
  list.forEach((t) => {
    (Array.isArray(t.customResults) ? t.customResults : []).forEach((r) => {
      if (!r || typeof r.name !== 'string') return;
      const key = resultKey(r);
      if (seen.has(key)) return;
      seen.add(key);
      const out = outOfLabRange(r);
      if (!out) return;
      const dir = out === '↑' ? 'high' : 'low';
      const std = urineStandard(r);
      found.push({
        key, name: std ? std.label : r.name, value: r.value, unit: r.unit || '', date: t.date, testId: t.id,
        level: dir === 'high' ? 'danger' : 'warn', dir, label: LABEL[dir], order: TEST_FIELDS.length + found.length,
      });
    });
  });

  found.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.date.localeCompare(a.date) || a.order - b.order);
  return { items: found.slice(0, limit).map(({ order, ...it }) => it), total: found.length };
}

/* ---------- «Ближайшее»: лекарства ---------- */
/* nextDose переехал в meds.js (единая логика расписания) — экспорт сохранён */
export { nextDose };

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/* Один ближайший предстоящий приём лекарства или null.
   meds — health_meds; intakes — med_intakes за сегодня; takenToday — старый med_log за сегодня (имена).
   Учитываются лекарства со временем приёма (schedule.times / reminder_time) или курсом «раз в N дней»
   (без времени — по дате). Сегодняшний приём уже отмечен или его время прошло — берётся следующий:
   следующее время сегодня, иначе первый приём ближайшего дня по расписанию (дни недели, курс, end).
   → { id, name, dose, date, time|null } */
export function upcomingMed(meds, { now = new Date(), takenToday = [], intakes = [] } = {}) {
  const today = dateKey(now);
  const nowT = hhmm(now);
  let best = null;
  const consider = (m, date, time) => {
    const key = `${date}T${time || '00:00'}`;
    if (!best || key < best.key) best = { key, id: m.id, name: m.name, dose: m.dose || '', date, time };
  };
  (Array.isArray(meds) ? meds : []).forEach((m) => {
    if (!m || typeof m.name !== 'string' || !m.name.trim() || m.deletedAt) return;
    const course = !!(m.every_days && m.start);
    if (!medSchedule(m).times.length && !course) return;
    const open = medDaySlots(m, today, { intakes, legacyNames: takenToday })
      .find((x) => !x.extra && !x.taken && (x.time ? x.time > nowT : true) && isMedDueOn(m, today));
    if (open) { consider(m, today, open.time); return; }
    const day = nextDueDay(m, today);
    if (day) consider(m, day, medOccurrences(m, day)[0].time);
  });
  if (!best) return null;
  const { key, ...item } = best;
  return item;
}

/* Лекарства на сегодня — приёмы по расписанию дня (несколько времён = несколько приёмов) и сколько
   из них отмечено. «По необходимости» в план не входит; курс «раз в N дней» — только в день дозы;
   лекарство без времени — один приём в день. takenToday — старые отметки по имени (med_log).
   → { due, taken } (taken ≤ due) */
export function medsToday(meds, { today = dateKey(), takenToday = [], intakes = [] } = {}) {
  return intakeSummary(meds, today, { intakes, legacyNames: takenToday });
}

/* Ближайший визит — как в Календаре: запланированный визит (status 'planned') на дату не раньше
   сегодняшней или «следующий визит» (nextDate) любого визита. Времени у визитов нет.
   → { visitId, date, title, next: boolean } | null */
export function upcomingVisit(visits, today = dateKey()) {
  let best = null;
  const consider = (v, date, next) => {
    if (typeof date !== 'string' || date < today) return;
    if (!best || date < best.date) {
      best = { visitId: v.id, date, title: [v.specialty, v.doctor].filter(Boolean).join(' · ') || 'Визит к врачу', next };
    }
  };
  (Array.isArray(visits) ? visits : []).forEach((v) => {
    if (!v) return;
    if (v.status === 'planned') consider(v, v.date, false);
    if (v.nextDate) consider(v, v.nextDate, true);
  });
  return best;
}

/* ---------- «Последняя активность» ---------- */
export const POINT_METRICS = ['weight', 'pressure', 'pulse', 'temperature', 'spo2', 'glucose'];

/* Кандидаты — последний анализ, последнее измерение (точечные показатели) и последний прошедший
   визит; показывается самый поздний по дате. Будущие даты и запланированные визиты не участвуют.
   Времени у этих записей нет, только дата: при равной дате — анализ, затем измерение, затем визит.
   → { kind: 'test', date, testId, summary } | { kind: 'metric', date, key, value } | { kind: 'visit', date, visitId, title } | null */
export function recentActivity({ tests = [], metricsLog = {}, visits = [], today = dateKey() }) {
  const past = (d) => typeof d === 'string' && d <= today;
  const candidates = [];

  const t = sortTests((Array.isArray(tests) ? tests : []).filter((x) => x && past(x.date)))[0];
  if (t) candidates.push({ kind: 'test', date: t.date, testId: t.id, summary: groupSummary(t) });

  let best = null;
  POINT_METRICS.forEach((key) => {
    const log = (metricsLog && metricsLog[key]) || {};
    Object.keys(log).forEach((date) => {
      if (log[date] == null || !past(date)) return;
      if (!best || date > best.date) best = { kind: 'metric', date, key, value: log[date] };
    });
  });
  if (best) candidates.push(best);

  const v = (Array.isArray(visits) ? visits : [])
    .filter((x) => x && past(x.date) && x.status !== 'planned')
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (v) candidates.push({ kind: 'visit', date: v.date, visitId: v.id, title: [v.specialty, v.doctor].filter(Boolean).join(' · ') || 'Визит к врачу' });

  /* sort устойчивый: при равной дате сохраняется порядок анализ → измерение → визит */
  return candidates.sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}
