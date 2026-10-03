/* =========================================================
   homeSummary.js — данные главного экрана: чистые функции без DOM и хранилища.
   • waterProgress — прогресс воды за сегодня (без отрицательного «осталось»);
   • waterDayStatus — главный показатель дня: вода относительно плана гидратации;
   • medsToday — лекарства на сегодня: сколько в плане дня и сколько отмечено;
   • upcomingVisit — ближайший запланированный / следующий визит (как в Календаре);
   • attentionItems — «Требует внимания»: последние значения показателей анализов,
     которые приложение уже отмечает как вне диапазона (evaluateField — справочные
     значения приложения для основных полей; outOfLabRange — диапазон бланка для
     показателей лаборатории). Новых медицинских правил здесь нет;
   • upcomingMed — «Ближайшее»: одно ближайшее предстоящее лекарство по его
     собственному расписанию (reminder_time / every_days) и отметке «принял сегодня»;
   • recentActivity — «Последняя активность»: из последнего анализа, последнего
     измерения и последнего прошедшего визита — самый поздний по дате.
   ========================================================= */

import { REFERENCE, TEST_FIELDS, sortTests, dateKey } from './storage.js';
import { evaluateField, outOfLabRange, resultKey, urineStandard, groupSummary } from './testsJournal.js';

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

/* Состояние дня по воде относительно плана гидратации — та же оценка, что на экране «Вода»
   (выпито − план к текущему моменту < 0 → «отстаёте»). plannedMl считает app.js (plannedByNow).
   → { state: 'none' (цели нет) | 'done' | 'onTrack' | 'behind', behind (мл, ≥ 0), over (мл сверх цели) } */
export function waterDayStatus(current, goal, plannedMl) {
  const p = waterProgress(current, goal);
  if (!p.goal) return { state: 'none', behind: 0, over: 0 };
  if (p.reached) return { state: 'done', behind: 0, over: p.over };
  const planned = isNum(plannedMl) ? Math.min(Math.max(plannedMl, 0), p.goal) : 0;
  const behind = Math.max(Math.round(planned - p.current), 0);
  return { state: behind > 0 ? 'behind' : 'onTrack', behind, over: 0 };
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

/* Следующая доза курса «раз в N дней» (не раньше today; курс ещё не начался — его начало) или null.
   Тот же расчёт, что раньше жил в app.js (экран «Лекарства», Календарь). */
export function nextDose(med, today = dateKey()) {
  if (!med.every_days || !med.start) return null;
  const ms = 86400000;
  const start = new Date(med.start + 'T00:00:00');
  const day = new Date(today + 'T00:00:00');
  if (start > day) return med.start;
  const cycles = Math.ceil((day - start) / ms / med.every_days);
  return dateKey(new Date(start.getTime() + cycles * med.every_days * ms));
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/* Одно ближайшее предстоящее лекарство или null.
   meds — health_meds; takenToday — med_log за сегодня (имена). Учитываются только активные лекарства
   со своим расписанием: reminder_time — ежедневно в это время (для курса «раз в N дней» — в дни доз),
   every_days без времени — в день дозы. Сегодняшний приём уже отмечен или его время прошло —
   берётся следующий. Курс закончился (end) — не показывается.
   → { id, name, dose, date, time|null } */
export function upcomingMed(meds, { now = new Date(), takenToday = [] } = {}) {
  const today = dateKey(now);
  const tm = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrow = dateKey(tm);
  const nowT = hhmm(now);
  const taken = new Set(Array.isArray(takenToday) ? takenToday : []);
  let best = null;
  (Array.isArray(meds) ? meds : []).forEach((m) => {
    if (!m || !m.active || typeof m.name !== 'string' || !m.name.trim()) return;
    const time = TIME_RE.test(m.reminder_time || '') ? m.reminder_time : null;
    const course = m.every_days && m.start;
    if (!time && !course) return;
    /* сегодняшний приём ещё впереди? */
    const todayOpen = !taken.has(m.name) && (!time || time > nowT);
    let date;
    if (course) {
      date = nextDose(m, today);
      if (date === today && !todayOpen) date = nextDose(m, tomorrow);
    } else {
      date = todayOpen ? today : tomorrow;
    }
    if (!date || (m.end && date > m.end)) return;
    const key = `${date}T${time || '00:00'}`;
    if (!best || key < best.key) best = { key, id: m.id, name: m.name, dose: m.dose || '', date, time };
  });
  if (!best) return null;
  const { key, ...item } = best;
  return item;
}

/* Лекарства на сегодня — те же отметки, что на экране «Лекарства» («принял сегодня» по имени).
   В план дня входит активное лекарство, если курс не закончился (end) и не начался позже (start);
   курс «раз в N дней» — только в день дозы. Лекарство без расписания отмечается ежедневно — входит.
   → { due, taken } (taken ≤ due) */
export function medsToday(meds, { today = dateKey(), takenToday = [] } = {}) {
  const taken = new Set(Array.isArray(takenToday) ? takenToday : []);
  let due = 0;
  let done = 0;
  (Array.isArray(meds) ? meds : []).forEach((m) => {
    if (!m || !m.active || typeof m.name !== 'string' || !m.name.trim()) return;
    if (m.end && today > m.end) return;
    if (m.start && today < m.start) return;
    if (m.every_days && m.start && nextDose(m, today) !== today) return;
    due += 1;
    if (taken.has(m.name)) done += 1;
  });
  return { due, taken: done };
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
