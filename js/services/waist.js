/* =========================================================
   waist.js — показатель «Обхват талии» (раздел «Показатели»): модель записи, проверка ввода,
   последнее измерение, точки периода НЕД · МЕС · 6 МЕС · ГОД и изменение за период.
   Чистые функции без DOM и без хранилища (storage.js импортирует этот файл).

   Модель (аддитивный ключ, схема v8 не меняется — как steps_log):
   • waist_log = { "ГГГГ-ММ-ДД": { cm, createdAt, updatedAt[, note, source] } }
     Одно измерение за календарный день: повторная запись той же даты — только явная замена
     («Заменить?»), дубля быть не может по устройству хранилища. cm — сантиметры, шаг 0,1.
   Отдельный ключ, а не metrics_log.waist: прежние версии LexLife проверяют metrics_log по
   списку известных показателей и отклонили бы копию с талией; неизвестный ключ они просто
   пропускают (как steps_log / sleep_log).

   Периоды — те же календарные окна, что у статистики воды (metricPeriods.periodWindow):
   неделя Пн–Вс, месяц, 6 и 12 календарных месяцев по текущий, ‹ › по целым периодам.
   Среднее не считается: «Последнее» и «Изменение» (последнее − первое измерение периода).
   Никакой медицинской оценки изменения здесь нет — только разница в сантиметрах.
   ========================================================= */

import { periodWindow } from './metricPeriods.js';

export const WAIST_MIN = 30;
export const WAIST_MAX = 250;
export const WAIST_NOTE_MAX = 500;
export const WAIST_PERIOD_KINDS = ['week', 'month', '6m', 'year'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const NB = ' ';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* настоящая календарная дата (31 февраля — нет) */
export function isWaistDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/* «92,5», «92.5», «93 см» → число | NaN (пусто → null) */
export function parseWaist(raw) {
  if (raw == null) return null;
  if (isNum(raw)) return raw;
  const s = String(raw).replace(/[\s  ]/g, '').replace(/см$/i, '').replace(',', '.');
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/* Форма → запись. input: { date, value }, opts.today → { ok, errors, value: { date, cm } } */
export function normalizeWaistInput(input = {}, { today = localDay() } = {}) {
  const errors = {};
  const date = String(input.date || '');
  if (!isWaistDay(date)) errors.date = 'Укажите дату';
  else if (date > today) errors.date = 'Дата не может быть в будущем';
  const n = parseWaist(input.value);
  let cm = null;
  if (n == null || Number.isNaN(n)) errors.value = 'Укажите обхват талии в сантиметрах';
  else {
    cm = round1(n);
    if (cm < WAIST_MIN || cm > WAIST_MAX) errors.value = `Обхват талии — от ${WAIST_MIN} до ${WAIST_MAX} см`;
  }
  const ok = !Object.keys(errors).length;
  return { ok, errors, value: ok ? { date, cm } : null };
}

/* ---------- проверка структуры (хранилище, резервная копия) ---------- */
const isText = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
export function isValidWaistEntry(e) {
  return isObj(e) && isNum(e.cm) && e.cm >= WAIST_MIN && e.cm <= WAIST_MAX
    && isText(e.note, WAIST_NOTE_MAX * 2) && isText(e.createdAt, 40) && isText(e.updatedAt, 40)
    && (e.source == null || (typeof e.source === 'string' && SOURCE_RE.test(e.source)));
}
export const isValidWaistLog = (v) => isObj(v) && Object.entries(v).every(([d, e]) => isWaistDay(d) && isValidWaistEntry(e));

/* ---------- чтение ---------- */

/* Измерения по возрастанию даты: [{ date, cm }] (некорректные пропускаются) */
export function waistPoints(log) {
  if (!isObj(log)) return [];
  return Object.keys(log).filter((d) => isWaistDay(d) && isObj(log[d]) && isNum(log[d].cm)).sort()
    .map((date) => ({ date, cm: log[date].cm }));
}
/* Измерения журнала: новые сверху */
export const waistHistory = (log) => waistPoints(log).reverse();

/* Последнее измерение не позже today → { date, cm } | null */
export function latestWaist(log, today = localDay()) {
  const pts = waistPoints(log).filter((p) => p.date <= today);
  return pts.length ? pts[pts.length - 1] : null;
}

/* Изменение между первым и последним измерением списка (по дате); меньше двух — null */
export function waistChange(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  return round1(points[points.length - 1].cm - points[0].cm);
}

/* Период kind ('week' | 'month' | '6m' | 'year'), offset (0 — текущий, −1 — предыдущий …).
   → { win (periodWindow), points (измерения периода по дате), first, last, change } */
export function waistPeriod(log, kind, offset = 0, today = localDay()) {
  const k = WAIST_PERIOD_KINDS.includes(kind) ? kind : 'month';
  const win = periodWindow(k, offset, today);
  const points = waistPoints(log).filter((p) => p.date >= win.start && p.date <= win.effEnd);
  return {
    win, points,
    first: points[0] || null,
    last: points.length ? points[points.length - 1] : null,
    change: waistChange(points),
  };
}

/* ---------- форматирование ---------- */
/* «93», «92,5» */
export const fmtCm = (v) => (isNum(v) ? String(round1(v)).replace('.', ',') : '—');
/* «92,5 см» */
export const fmtWaist = (v) => (isNum(v) ? `${fmtCm(v)}${NB}см` : '—');
/* «−2 см», «+1,5 см», «0 см»; нет изменения (меньше двух измерений) — «—» */
export function fmtWaistChange(d) {
  if (!isNum(d)) return '—';
  const a = round1(Math.abs(d));
  if (a === 0) return `0${NB}см`;
  return `${d < 0 ? '−' : '+'}${fmtCm(a)}${NB}см`;
}
