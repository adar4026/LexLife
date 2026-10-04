/* =========================================================
   visitKinds.js — вид записи в «Врачи и визиты» и её подпись.
   Аддитивные поля визита (схема v8 не меняется, старые версии их не показывают):
   • kind — вид события медицинской истории (визит, процедура, УЗИ/КТ, стоматология…);
   • title — короткое название события, когда врач неизвестен или не главное;
   • time — «ЧЧ:ММ», если время известно.
   Записи без этих полей (обычные визиты) выглядят как раньше: врач · специальность · клиника.
   Плюс: поиск по записи (visitMatchesQuery) и относительное время (relativeVisitLabel)
   для списка «Врачи и визиты» — обе функции чистые, ничего не читают и не пишут в storage.
   ========================================================= */

import { dateKey } from './storage.js';

export const VISIT_KINDS = {
  visit: { icon: '🩺', label: 'Визит к врачу' },
  procedure: { icon: '🩹', label: 'Процедура' },
  surgery: { icon: '🏥', label: 'Операция' },
  imaging: { icon: '🩻', label: 'Обследование' },
  dental: { icon: '🦷', label: 'Стоматология' },
  lab: { icon: '🧪', label: 'Сдача анализов' },
  illness: { icon: '🤒', label: 'Заболевание' },
  injury: { icon: '🤕', label: 'Травма' },
  emergency: { icon: '🚑', label: 'Неотложная помощь' },
  referral: { icon: '📝', label: 'Направление' },
  appointment: { icon: '📅', label: 'Запись к врачу' },
  vision: { icon: '👓', label: 'Зрение' },
  medication: { icon: '💊', label: 'Начало приёма' },
};
export const VISIT_KIND_KEYS = Object.keys(VISIT_KINDS);

const txt = (v) => (typeof v === 'string' ? v.trim() : '');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const visitIcon = (v) => (VISIT_KINDS[v && v.kind] || VISIT_KINDS.visit).icon;
export const visitKindLabel = (v) => (VISIT_KINDS[v && v.kind] || VISIT_KINDS.visit).label;
export const visitTime = (v) => (v && TIME_RE.test(v.time || '') ? v.time : null);

/* Заголовок строки: название события → врач → «Визит» */
export function visitTitle(v) {
  return txt(v && v.title) || txt(v && v.doctor) || 'Визит';
}

/* Подзаголовок: врач (если заголовок — название события) · специальность · клиника */
export function visitSub(v) {
  if (!v) return '';
  const parts = txt(v.title) ? [txt(v.doctor)] : [];
  parts.push(txt(v.specialty), txt(v.clinic));
  return parts.filter(Boolean).join(' · ');
}

/* Отметка статуса в карточке: «запланирован» / «выполнен» — только для состоявшихся визитов и процедур.
   «Запись к врачу» — не подтверждённый приём; заболевание, направление, начало приёма — не визиты. */
const DONE_KINDS = new Set(['visit', 'procedure', 'surgery', 'imaging', 'dental', 'lab', 'injury', 'emergency', 'vision']);
export function visitStatusChip(v) {
  if (v && v.status === 'planned') return { cls: 'planned', text: 'запланирован' };
  if (!v || !v.kind || DONE_KINDS.has(v.kind)) return { cls: 'done', text: 'выполнен' };
  if (v.kind === 'appointment') return { cls: 'planned', text: 'запись к врачу' };
  return null;
}

/* ---------- поиск по записи ---------- */
/* Текстовые поля визита, по которым ищем; .toLowerCase() у строк сам корректно
   работает с кириллицей, латиницей и диакритикой испанского (ñ, á…). */
const SEARCH_FIELDS = ['title', 'doctor', 'specialty', 'clinic', 'reason', 'conclusion', 'recommendations'];

export function visitSearchText(v) {
  if (!v) return '';
  const parts = SEARCH_FIELDS.map((k) => txt(v[k]));
  parts.push(visitKindLabel(v));
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function visitMatchesQuery(v, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return visitSearchText(v).includes(q);
}

/* ---------- относительное время записи ---------- */
/* «прошло/через + максимум 2 календарные единицы» (годы, месяцы, недели, дни —
   настоящей календарной длины, не по 30-дневным месяцам). Считаем по локальным
   календарным датам (YYYY-MM-DD), без арифметики через миллисекунды часового пояса. */

const DAY_MS = 86400000;
function parseDateKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3] } : null;
}
const daysInMonth = (y, mo) => new Date(y, mo + 1, 0).getDate();
const toDayIndex = (x) => Math.round(Date.UTC(x.y, x.mo, x.d) / DAY_MS);
function addMonths(a, n) {
  const total = a.mo + n;
  const y = a.y + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  return { y, mo, d: Math.min(a.d, daysInMonth(y, mo)) };
}
/* Календарная разница b − a, где b не раньше a: {years, months, days} реальной длины.
   months считаем наибольшим числом, которое при добавлении к a (с учётом укорачивания
   дня до длины месяца — 31.01 + 1мес → 28/29.02) не перескакивает b. */
function calendarDiff(a, b) {
  let months = (b.y - a.y) * 12 + (b.mo - a.mo);
  let anchor = addMonths(a, months);
  while (toDayIndex(anchor) > toDayIndex(b)) { months -= 1; anchor = addMonths(a, months); }
  return { years: Math.floor(months / 12), months: months % 12, days: toDayIndex(b) - toDayIndex(anchor) };
}

/* dateStr, today — «YYYY-MM-DD» (как Storage.dateKey). today по умолчанию — сегодня устройства. */
export function relativeVisitLabel(dateStr, today = dateKey()) {
  const from = parseDateKey(dateStr);
  const now = parseDateKey(today);
  if (!from || !now) return '';
  const totalDays = toDayIndex(now) - toDayIndex(from);
  if (totalDays === 0) return 'сегодня';
  const future = totalDays < 0;
  const { years, months, days } = future ? calendarDiff(now, from) : calendarDiff(from, now);
  const abs = Math.abs(totalDays);
  let unit;
  if (years > 0) unit = months > 0 ? `${years} г. ${months} мес.` : `${years} г.`;
  else if (months > 0) unit = days > 0 ? `${months} мес. ${days} дн.` : `${months} мес.`;
  else {
    const weeks = Math.floor(abs / 7), rem = abs % 7;
    unit = weeks > 0 ? (rem > 0 ? `${weeks} нед. ${rem} дн.` : `${weeks} нед.`) : `${abs} дн.`;
  }
  return future ? `через ${unit}` : `прошло ${unit}`;
}
