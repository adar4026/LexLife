/* =========================================================
   meds.js — расписание и приёмы лекарств: чистые функции без DOM и хранилища.
   Модель (аддитивная, схема v8 не меняется):
   • health_meds[i].schedule = { mode: 'daily'|'days'|'asNeeded', days: [0=Вс…6=Сб], times: ['08:00', …] };
     без schedule — старая запись: reminder_time (одно время) / every_days (курс «раз в N дней»);
   • med_intakes = { "ГГГГ-ММ-ДД": [{ medId, scheduledTime, takenAt }] } — принятые приёмы
     по ЛОКАЛЬНОЙ дате пользователя (dateKey); scheduledTime null — приём без времени.
   • medOccurrences — приёмы дня по расписанию: та же модель пригодится уведомлениям
     (одно срабатывание = один приём), когда их подключат к лекарствам.
   ========================================================= */

import { dateKey, MED_MODES } from './storage.js';

export { MED_MODES };
export const MED_NAME_MAX = 80;
export const MED_DOSE_MAX = 40;
export const MED_NOTE_MAX = 120;
export const MED_TIMES_MAX = 8;
/* Порядок дней в форме — с понедельника; значения — как Date.getDay() и notifications.days */
export const WEEKDAYS = [
  { day: 1, short: 'Пн', name: 'понедельник' }, { day: 2, short: 'Вт', name: 'вторник' },
  { day: 3, short: 'Ср', name: 'среда' }, { day: 4, short: 'Чт', name: 'четверг' },
  { day: 5, short: 'Пт', name: 'пятница' }, { day: 6, short: 'Сб', name: 'суббота' },
  { day: 0, short: 'Вс', name: 'воскресенье' },
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/* локальный календарный день → Date в полночь (без UTC: «ГГГГ-ММ-ДД» не парсится как UTC) */
const dayDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (day, n) => { const d = dayDate(day); return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };
export const weekdayOf = (day) => dayDate(day).getDay();

/* Времена: только корректные ЧЧ:ММ, без повторов, по возрастанию */
export function normalizeTimes(times) {
  return [...new Set((Array.isArray(times) ? times : []).filter((t) => typeof t === 'string' && TIME_RE.test(t)))].sort();
}
const normalizeDays = (days) => [...new Set((Array.isArray(days) ? days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
  .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

/* Действующее расписание лекарства (новое поле schedule или старое reminder_time) */
export function medSchedule(med) {
  const s = med && med.schedule;
  if (isObj(s) && MED_MODES.includes(s.mode)) {
    const days = normalizeDays(s.days);
    /* «по дням» без дней — запись повреждена вручную: показываем как ежедневную, а не прячем */
    const mode = s.mode === 'days' && !days.length ? 'daily' : s.mode;
    return { mode, days: mode === 'days' ? days : [], times: mode === 'asNeeded' ? [] : normalizeTimes(s.times) };
  }
  const t = med && TIME_RE.test(med.reminder_time || '') ? [med.reminder_time] : [];
  return { mode: 'daily', days: [], times: t };
}

/* Следующая доза курса «раз в N дней» (не раньше today; курс ещё не начался — его начало)
   или null — в т.ч. когда курс закончился (дата окончания end) */
export function nextDose(med, today = dateKey()) {
  if (!med.every_days || !med.start) return null;
  const ms = 86400000;
  const start = new Date(med.start + 'T00:00:00');
  const day = new Date(today + 'T00:00:00');
  const next = start > day ? med.start : dateKey(new Date(start.getTime() + Math.ceil((day - start) / ms / med.every_days) * med.every_days * ms));
  return med.end && DAY_RE.test(med.end) && next > med.end ? null : next;
}

/* Лекарство в списке, но сейчас не принимается: удалено, выключено, курс не начался / закончился */
export function medStatusOn(med, day) {
  if (!med || med.deletedAt) return 'deleted';
  if (med.active === false) return 'inactive';
  if (med.start && DAY_RE.test(med.start) && day < med.start) return 'notStarted';
  if (med.end && DAY_RE.test(med.end) && day > med.end) return 'ended';
  return 'active';
}

/* Подпись прошедшего курса по courseStatus (аддитивное поле, импорт истории) */
export function endedCourseWord(med) {
  const st = med && med.courseStatus;
  if (st === 'stopped') return 'прекращён';
  if (st === 'prescribed') return 'назначенный курс, приём не отмечался';
  return 'завершён';
}

/* Есть ли приём по расписанию в этот день («по необходимости» — нет: отметка по факту) */
export function isMedDueOn(med, day) {
  if (medStatusOn(med, day) !== 'active') return false;
  if (med.every_days && med.start && nextDose(med, day) !== day) return false;
  const s = medSchedule(med);
  if (s.mode === 'asNeeded') return false;
  if (s.mode === 'days') return s.days.includes(weekdayOf(day));
  return true;
}

/* Приёмы дня по расписанию: [{ time|null }] — несколько времён = несколько приёмов; без времени — один */
export function medOccurrences(med, day) {
  if (!isMedDueOn(med, day)) return [];
  const { times } = medSchedule(med);
  return times.length ? times.map((time) => ({ time })) : [{ time: null }];
}

const slotOrder = (a, b) => (a.time == null) - (b.time == null) || String(a.time).localeCompare(String(b.time));

/* Строки отметок дня для карточки: [{ time, taken, takenAt, extra }].
   intakes — med_intakes[day]; legacyNames — med_log[day] (старая отметка «принял сегодня» по имени).
   • приёмы по расписанию этого дня; «по необходимости» — одна отметка «принял сегодня»;
   • принятый приём, которого уже нет в расписании (время изменили) — остаётся строкой (extra), не пропадает;
   • старая отметка по имени — у первого приёма, пока у лекарства нет новых записей за этот день. */
export function medDaySlots(med, day, { intakes = [], legacyNames = [] } = {}) {
  if (!med || med.deletedAt) return [];
  const recs = (Array.isArray(intakes) ? intakes : []).filter((r) => isObj(r) && r.medId === med.id);
  const s = medSchedule(med);
  const active = medStatusOn(med, day) === 'active';
  let slots = active && s.mode === 'asNeeded' ? [{ time: null }] : medOccurrences(med, day);
  slots = slots.map((x) => ({ time: x.time, extra: false }));
  recs.forEach((r) => {
    const t = r.scheduledTime || null;
    if (!slots.some((x) => x.time === t)) slots.push({ time: t, extra: true });
  });
  const legacy = !recs.length && Array.isArray(legacyNames) && legacyNames.includes(med.name);
  if (legacy && !slots.length) slots.push({ time: null, extra: true }); // старая отметка в день без приёма по расписанию
  slots.sort(slotOrder);
  return slots.map((x, i) => {
    const r = recs.find((q) => (q.scheduledTime || null) === x.time);
    return { time: x.time, extra: x.extra, taken: !!r || (legacy && i === 0), takenAt: r ? r.takenAt || null : null };
  });
}

/* Ближайший день с приёмом после day (не включая), не дальше limit дней, или null */
export function nextDueDay(med, day, limit = 370) {
  for (let i = 1; i <= limit; i += 1) {
    const d = addDays(day, i);
    if (med.end && d > med.end) return null;
    if (isMedDueOn(med, d)) return d;
  }
  return null;
}

/* Подпись расписания: «Каждый день» · «Пн, Ср, Пт» · «По необходимости» (+ курс «раз в N дн.») */
export function scheduleLabel(med) {
  const s = medSchedule(med);
  let label = s.mode === 'asNeeded' ? 'По необходимости'
    : s.mode === 'days' ? (s.days.length === 7 ? 'Каждый день' : WEEKDAYS.filter((w) => s.days.includes(w.day)).map((w) => w.short).join(', '))
      : 'Каждый день';
  if (med && med.every_days && med.start && s.mode !== 'asNeeded') label = `Раз в ${med.every_days} дн.`;
  return label;
}

/* Сводка дня по всем лекарствам: приёмы по расписанию (без «по необходимости») → { due, taken } */
export function intakeSummary(meds, day, { intakes = [], legacyNames = [] } = {}) {
  let due = 0;
  let taken = 0;
  (Array.isArray(meds) ? meds : []).forEach((m) => {
    if (!m || typeof m.name !== 'string' || !m.name.trim() || !isMedDueOn(m, day)) return;
    medDaySlots(m, day, { intakes, legacyNames }).forEach((x) => {
      if (x.extra) return;
      due += 1;
      if (x.taken) taken += 1;
    });
  });
  return { due, taken };
}

/* Форма → { ok, errors: { name?, days? }, value } — value готов для addMed/updateMed.
   reminder_time — зеркало первого времени для старых версий LexLife (их Главная/Календарь читают только его). */
export function normalizeMedInput(input) {
  const i = isObj(input) ? input : {};
  const name = str(i.name).slice(0, MED_NAME_MAX);
  const mode = MED_MODES.includes(i.mode) ? i.mode : 'daily';
  const days = mode === 'days' ? normalizeDays(i.days) : [];
  const times = mode === 'asNeeded' ? [] : normalizeTimes(i.times).slice(0, MED_TIMES_MAX);
  const errors = {};
  if (!name) errors.name = 'Введите название препарата';
  if (mode === 'days' && !days.length) errors.days = 'Выберите хотя бы один день';
  const value = {
    name,
    dose: str(i.dose).slice(0, MED_DOSE_MAX),
    note: str(i.note).slice(0, MED_NOTE_MAX),
    schedule: { mode, days, times },
    reminder_time: times[0] || null,
  };
  return { ok: !Object.keys(errors).length, errors, value };
}

/* История по дням (новые сверху): только реальные отметки — приёмы и старый журнал по имени.
   meds — включая удалённые (имя для истории). → [{ day, items: [{ name, time|null }] }] */
export function intakeHistory(meds, allIntakes, allLegacy, { until = dateKey(), days = 14 } = {}) {
  const byId = new Map((Array.isArray(meds) ? meds : []).filter((m) => m && m.id != null).map((m) => [m.id, m]));
  const from = addDays(until, -(days - 1));
  const keys = new Set([...Object.keys(isObj(allIntakes) ? allIntakes : {}), ...Object.keys(isObj(allLegacy) ? allLegacy : {})]);
  return [...keys].filter((d) => DAY_RE.test(d) && d >= from && d <= until).sort().reverse().map((day) => {
    const recs = Array.isArray(allIntakes && allIntakes[day]) ? allIntakes[day] : [];
    const items = recs.filter(isObj).map((r) => ({ name: (byId.get(r.medId) || {}).name || 'Удалённое лекарство', time: r.scheduledTime || null }));
    const named = new Set(recs.map((r) => (byId.get(r.medId) || {}).name));
    (Array.isArray(allLegacy && allLegacy[day]) ? allLegacy[day] : []).forEach((n) => { if (typeof n === 'string' && !named.has(n)) items.push({ name: n, time: null }); });
    items.sort((a, b) => a.name.localeCompare(b.name, 'ru') || slotOrder(a, b));
    return { day, items };
  }).filter((d) => d.items.length);
}
