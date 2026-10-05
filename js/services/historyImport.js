/* =========================================================
   historyImport.js — «Импорт медицинской истории» (#/history-import).
   Один JSON-файл (kind: lexlife-medical-history) с прошлыми событиями
   (визиты, процедуры, обследования, стоматология, заболевания…) и курсами лекарств.

   • Файл — недоверенный ввод: только известные поля, типы, длины, реальные даты
     (локальные календарные «ГГГГ-ММ-ДД», без Date-парсинга в UTC), не в будущем.
     Любая ошибка классификации отклоняет весь файл — частичного импорта нет.
   • План (dry-run) ничего не пишет: каждая запись получает статус
       add       — будет добавлена;
       imported  — уже импортирована раньше (тот же importId; в т.ч. удалённая вами — не возвращается);
       duplicate — такое событие/курс уже есть в LexLife (дата + врач/вид/процедура/зуб…; курс — препарат + дата начала);
                   «Сдача анализов» — дубль, если в «Анализах» есть запись этой даты;
       conflict  — похожая запись есть, но совпадение неоднозначно → пропуск, нужна проверка.
   • Применение только ДОБАВЛЯЕТ записи в health_visits / health_meds (Storage.addImportedHistory):
     существующие не изменяются и не удаляются. id записей выводятся из importId —
     повторный импорт того же файла добавляет 0 записей.
   • Результаты анализов этот формат не принимает вовсе (для них — импорт подготовленного анализа).
   Чистые функции без DOM и хранилища; тесты — tests/history-import.test.mjs.
   ========================================================= */

import { VISIT_KIND_KEYS } from './visitKinds.js';

export const HISTORY_KIND = 'lexlife-medical-history';
export const HISTORY_FORMAT_VERSION = 1;
export const HISTORY_SOURCE = 'medical-history';
const MAX_TEXT = 1024 * 1024;
const MAX_EVENTS = 500;
const MAX_MEDS = 200;
const IMPORT_ID_RE = /^[a-z0-9][a-z0-9:._-]{7,70}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const EVENT_KEYS = new Set(['importId', 'date', 'time', 'kind', 'title', 'doctor', 'specialty', 'clinic', 'reason', 'conclusion', 'recommendations', 'medRefs', 'match']);
const MED_KEYS = new Set(['importId', 'name', 'aliases', 'start', 'end', 'dose', 'purpose', 'every_days', 'schedule', 'note', 'courseStatus']);
/* Статус прошедшего курса (аддитивное поле health_meds): завершён / прекращён досрочно / только назначен (приём доз не отмечался) */
export const COURSE_STATUSES = ['completed', 'stopped', 'prescribed'];
const MED_SCHEDULES = ['daily', 'asNeeded'];
const TEXT_LIMITS = { title: 120, doctor: 120, specialty: 120, clinic: 160, reason: 500, conclusion: 2000, recommendations: 2000 };

export class HistoryImportError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'HistoryImportError';
    this.errors = errors;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasForbidden = (o) => Object.keys(o).some((k) => FORBIDDEN.has(k));

/* Реальная календарная дата (31.04 — нет). Проверка через UTC-компоненты — это только
   проверка существования дня, сама дата хранится строкой как есть. */
export function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900;
}
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* importId → устойчивый id записи (безопасный id схемы: [A-Za-z0-9_-]) */
export const recordIdFor = (importId) => `mh-${importId.replace(/[^a-z0-9_-]/g, '-')}`.slice(0, 80);

/* Нормализация для сравнения: регистр, диакритика (á → a), ё → е, пунктуация → пробел */
export function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

/* Текст файла → { packageId, events, meds }. Ничего не пишет; ошибки собираются все сразу. */
export function parseMedicalHistory(text, { today = new Date() } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new HistoryImportError('Файл пуст.');
  if (text.length > MAX_TEXT) throw new HistoryImportError('Файл слишком большой для импорта истории.');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new HistoryImportError('Файл повреждён: это не корректный JSON.'); }
  if (!isObj(raw) || hasForbidden(raw)) throw new HistoryImportError('Файл не является медицинской историей LexLife.');
  if (raw.app === 'lexlife' && raw.data && raw.backupFormatVersion != null) {
    throw new HistoryImportError('Это резервная копия LexLife, а не медицинская история. Её восстанавливают в «Резервная копия».');
  }
  if (raw.app !== 'lexlife' || raw.kind !== HISTORY_KIND) throw new HistoryImportError('Файл не является медицинской историей LexLife.');
  if (raw.formatVersion !== HISTORY_FORMAT_VERSION) {
    throw new HistoryImportError(Number.isInteger(raw.formatVersion) && raw.formatVersion > HISTORY_FORMAT_VERSION
      ? 'Файл подготовлен для более новой версии LexLife. Обновите приложение.'
      : 'Неподдерживаемая версия формата медицинской истории.');
  }
  if (typeof raw.packageId !== 'string' || !IMPORT_ID_RE.test(raw.packageId)) throw new HistoryImportError('В файле нет корректного packageId.');
  const events = raw.events == null ? [] : raw.events;
  const meds = raw.meds == null ? [] : raw.meds;
  if (!Array.isArray(events) || !Array.isArray(meds)) throw new HistoryImportError('Поля events и meds должны быть списками.');
  if (events.length > MAX_EVENTS || meds.length > MAX_MEDS) throw new HistoryImportError('Слишком много записей в одном файле.');
  if (!events.length && !meds.length) throw new HistoryImportError('В файле нет ни одной записи.');
  const extra = Object.keys(raw).filter((k) => !['app', 'kind', 'formatVersion', 'packageId', 'events', 'meds'].includes(k));

  const todayIso = localDay(today);
  const errors = [];
  const ids = new Set();
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  if (extra.length) errors.push(`Неизвестные поля файла: ${extra.join(', ')}`);

  const text1 = (o, k, max, where, required = false) => {
    const v = o[k];
    if (v == null || v === '') { if (required) err(where, `нет поля «${k}»`); return ''; }
    if (typeof v !== 'string') { err(where, `поле «${k}» должно быть текстом`); return ''; }
    const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
    if (s.length > max) err(where, `поле «${k}» длиннее ${max} символов`);
    if (required && !s) err(where, `пустое поле «${k}»`);
    return s;
  };
  const strList = (o, k, where, max = 30) => {
    const v = o[k];
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 80)) { err(where, `поле «${k}» должно быть списком коротких строк`); return []; }
    return v.map((x) => x.trim());
  };
  const checkId = (o, where) => {
    if (typeof o.importId !== 'string' || !IMPORT_ID_RE.test(o.importId)) { err(where, 'некорректный importId (8–71 символ: a-z 0-9 : . _ -)'); return null; }
    if (ids.has(o.importId)) { err(where, `importId «${o.importId}» повторяется`); return null; }
    ids.add(o.importId);
    return o.importId;
  };
  const checkDate = (v, where, what, required = true) => {
    if (v == null && !required) return null;
    if (!isRealDate(v)) { err(where, `некорректная дата ${what} (нужен ГГГГ-ММ-ДД)`); return null; }
    if (v > todayIso) { err(where, `дата ${what} в будущем`); return null; }
    return v;
  };

  const outMeds = [];
  meds.forEach((m, i) => {
    const where = `Лекарство №${i + 1}`;
    if (!isObj(m) || hasForbidden(m)) { err(where, 'некорректная запись'); return; }
    const unknown = Object.keys(m).filter((k) => !MED_KEYS.has(k));
    if (unknown.length) err(where, `неизвестные поля ${unknown.join(', ')}`);
    const importId = checkId(m, where);
    const name = text1(m, 'name', 80, where, true);
    const start = checkDate(m.start, `${where} «${name}»`, 'начала');
    let end = null;
    if (m.end != null) {
      end = isRealDate(m.end) ? m.end : (err(where, 'некорректная дата окончания'), null);
      if (end && start && end < start) err(where, 'окончание раньше начала');
    }
    const every = m.every_days == null ? null : m.every_days;
    if (every != null && !(Number.isInteger(every) && every >= 2 && every <= 365)) err(where, 'every_days — целое число дней 2–365');
    const schedule = m.schedule == null ? 'daily' : m.schedule;
    if (!MED_SCHEDULES.includes(schedule)) err(where, `schedule — ${MED_SCHEDULES.join(' | ')}`);
    /* в историю — только курсы с известным окончанием: без него курс стал бы «активным сейчас»
       (для этого случая — событие kind: medication «Начало приёма») */
    if (m.end == null) err(where, 'нет даты окончания — запишите как событие «Начало приёма» (kind: medication)');
    const courseStatus = m.courseStatus == null ? 'completed' : m.courseStatus;
    if (!COURSE_STATUSES.includes(courseStatus)) err(where, `courseStatus — ${COURSE_STATUSES.join(' | ')}`);
    outMeds.push({
      importId, name, start, end, every_days: every, schedule, courseStatus,
      aliases: [...new Set([name, ...strList(m, 'aliases', where)].map(norm).filter(Boolean))],
      dose: text1(m, 'dose', 40, where), purpose: text1(m, 'purpose', 120, where), note: text1(m, 'note', 120, where),
    });
  });
  const medIds = new Set(outMeds.map((m) => m.importId));

  const outEvents = [];
  events.forEach((e, i) => {
    const where = `Событие №${i + 1}`;
    if (!isObj(e) || hasForbidden(e)) { err(where, 'некорректная запись'); return; }
    const unknown = Object.keys(e).filter((k) => !EVENT_KEYS.has(k));
    if (unknown.length) err(where, `неизвестные поля ${unknown.join(', ')} (результаты анализов этот импорт не принимает)`);
    const importId = checkId(e, where);
    const date = checkDate(e.date, where, 'события');
    if (!VISIT_KIND_KEYS.includes(e.kind)) err(where, `неизвестный вид «${e.kind}»`);
    if (e.time != null && !(typeof e.time === 'string' && TIME_RE.test(e.time))) err(where, 'время — ЧЧ:ММ');
    const ev = { importId, date, time: e.time || null, kind: e.kind };
    for (const k of Object.keys(TEXT_LIMITS)) ev[k] = text1(e, k, TEXT_LIMITS[k], where, k === 'title');
    ev.medRefs = strList(e, 'medRefs', where);
    ev.medRefs.forEach((r) => { if (!medIds.has(r)) err(where, `medRefs: нет лекарства «${r}» в файле`); });
    let keywords = [];
    if (e.match != null) {
      if (!isObj(e.match) || hasForbidden(e.match) || Object.keys(e.match).some((k) => k !== 'keywords')) err(where, 'match — { keywords: [...] }');
      else keywords = strList(e.match, 'keywords', where);
    }
    ev.keywords = [...new Set(keywords.map(norm).filter((k) => k.length >= 2))];
    outEvents.push(ev);
  });

  if (errors.length) {
    throw new HistoryImportError(`Файл не импортирован: ${errors.length} ${errors.length === 1 ? 'ошибка' : 'ошибок/ошибки'} проверки.`, errors);
  }
  return { packageId: raw.packageId, events: outEvents, meds: outMeds };
}

/* ---------- поиск совпадений ---------- */

const visitHaystack = (v) => ` ${norm([v.title, v.doctor, v.specialty, v.clinic, v.reason, v.conclusion, v.recommendations].filter((x) => typeof x === 'string').join(' '))} `;
/* ключевое слово — начало слова в тексте («уролог» находит «урологом», «36» — только число 36) */
const hasKeyword = (hay, kw) => (/^\d+$/.test(kw) ? new RegExp(`(^|\\D)${kw}(\\D|$)`).test(hay) : hay.includes(` ${kw}`));

function medNameMatches(existingName, aliases) {
  const n = norm(existingName);
  if (!n) return false;
  return aliases.some((a) => n === a || n.startsWith(`${a} `) || n.includes(` ${a} `) || n.endsWith(` ${a}`));
}

/* Пересечение периодов курсов (без окончания — открытый период) */
const overlaps = (a, b) => (a.start || '0000') <= (b.end || '9999') && (b.start || '0000') <= (a.end || '9999');

const dayFmt = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : 'без даты');

/* Dry-run: { events: [{ item, status, reason, matchId }], meds: [...], counts } — ничего не пишет.
   existing: { visits, meds (включая удалённые), tests } — текущие данные LexLife. */
export function buildHistoryImportPlan(parsed, existing) {
  const visits = Array.isArray(existing.visits) ? existing.visits : [];
  const meds = Array.isArray(existing.meds) ? existing.meds : [];
  const tests = Array.isArray(existing.tests) ? existing.tests : [];
  /* записи этого же пакета сравниваются только по importId, не по тексту: иначе соседнее
     событие того же дня из этого файла приняли бы за «уже существующее» */
  const own = new Set([...parsed.events, ...parsed.meds].map((x) => x.importId));
  const foreign = (r) => !own.has(r.importId);

  const medPlan = parsed.meds.map((item) => {
    const byImport = meds.find((m) => m.importId === item.importId || m.id === recordIdFor(item.importId));
    if (byImport) return { item, status: 'imported', matchId: byImport.id, reason: byImport.deletedAt ? 'импортировано ранее и удалено вами — не возвращается' : 'импортировано ранее' };
    const same = meds.filter((m) => foreign(m) && medNameMatches(m.name, item.aliases));
    const exact = same.find((m) => m.start === item.start);
    if (exact) return { item, status: 'duplicate', matchId: exact.id, reason: `уже есть «${exact.name}» с началом ${dayFmt(exact.start)}` };
    const unclear = same.find((m) => !m.start || overlaps({ start: m.start, end: m.end }, item));
    if (unclear) {
      return { item, status: 'conflict', matchId: unclear.id, reason: unclear.start
        ? `уже есть «${unclear.name}» (${dayFmt(unclear.start)}${unclear.end ? `–${dayFmt(unclear.end)}` : ' – …'}), периоды пересекаются`
        : `уже есть «${unclear.name}» без даты начала — тот же курс?` };
    }
    return { item, status: 'add', reason: same.length ? `другие курсы «${same[0].name}» не пересекаются` : '' };
  });

  const eventPlan = parsed.events.map((item) => {
    const byImport = visits.find((v) => v.importId === item.importId || v.id === recordIdFor(item.importId));
    if (byImport) return { item, status: 'imported', matchId: byImport.id, reason: 'импортировано ранее' };
    if (item.kind === 'lab') {
      const t = tests.find((x) => x.date === item.date);
      if (t) return { item, status: 'duplicate', matchId: t.id, reason: `в «Анализах» уже есть анализ от ${dayFmt(item.date)}` };
    }
    const sameDay = visits.filter((v) => v.date === item.date && foreign(v));
    const hit = sameDay.find((v) => { const hay = visitHaystack(v); return item.keywords.some((k) => hasKeyword(hay, k)); });
    if (hit) return { item, status: 'duplicate', matchId: hit.id, reason: `в «Врачи и визиты» уже есть: ${[hit.title || hit.doctor, hit.specialty].filter(Boolean).join(' · ') || 'визит'} (${dayFmt(hit.date)})` };
    return { item, status: 'add', reason: sameDay.length ? `в эту дату есть другая запись (${sameDay.map((v) => v.doctor || v.specialty || 'визит').join(', ')}) — не совпадает` : '' };
  });

  const count = (list, s) => list.filter((x) => x.status === s).length;
  const counts = {};
  for (const s of ['add', 'imported', 'duplicate', 'conflict']) counts[s] = count(eventPlan, s) + count(medPlan, s);
  return {
    packageId: parsed.packageId, events: eventPlan, meds: medPlan, counts,
    eventsTotal: eventPlan.length, medsTotal: medPlan.length,
    eventsAdd: count(eventPlan, 'add'), medsAdd: count(medPlan, 'add'),
  };
}

/* План → записи для Storage.addImportedHistory (только status add). Связи визитов с лекарствами:
   новый курс — его id; курс, найденный как дубль/импортированный, — id существующей записи. */
export function buildHistoryRecords(plan, { now = new Date() } = {}) {
  const importedAt = now.toISOString();
  const medIdOf = new Map();
  plan.meds.forEach((p) => {
    if (p.status === 'add') medIdOf.set(p.item.importId, recordIdFor(p.item.importId));
    else if (p.matchId != null && p.status !== 'conflict') medIdOf.set(p.item.importId, p.matchId);
  });
  const meds = plan.meds.filter((p) => p.status === 'add').map(({ item }) => ({
    id: recordIdFor(item.importId), name: item.name, icon: '💊', dose: item.dose, purpose: item.purpose,
    start: item.start, end: item.end, every_days: item.every_days, active: true,
    schedule: { mode: item.schedule, days: [], times: [] }, reminder_time: null, note: item.note, courseStatus: item.courseStatus,
    importId: item.importId, importedAt, source: HISTORY_SOURCE,
  }));
  const visits = plan.events.filter((p) => p.status === 'add').map(({ item }) => ({
    id: recordIdFor(item.importId), date: item.date, time: item.time, kind: item.kind, title: item.title,
    doctor: item.doctor, specialty: item.specialty, clinic: item.clinic, reason: item.reason,
    conclusion: item.conclusion, recommendations: item.recommendations, nextDate: null, status: 'done', attachments: [],
    links: { testIds: [], medIds: item.medRefs.map((r) => medIdOf.get(r)).filter((x) => x != null), reminderIds: [] },
    importId: item.importId, importedAt, source: HISTORY_SOURCE,
  }));
  return { meds, visits };
}

/* Применить план: только добавление. → { medsAdded, visitsAdded } */
export async function applyHistoryImportPlan(storage, plan, { now = new Date() } = {}) {
  return storage.addImportedHistory(buildHistoryRecords(plan, { now }));
}
