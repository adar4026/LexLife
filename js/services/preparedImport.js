/* =========================================================
   preparedImport.js — «Импортировать подготовленный анализ».
   Один JSON-файл с одной записью анализа (формат — docs/FULL_BACKUP.md §3).
   Файл читается локально, строго проверяется (недоверенный ввод: только известные
   поля, типы, длины) и ДОБАВЛЯЕТСЯ к существующим анализам — ничего не заменяет,
   другие разделы не трогает. Повторный импорт той же записи блокируется по importId.
   ========================================================= */

import { TEST_FIELDS, IMPORT_ID_RE } from './storage.js';

export const PREPARED_KIND = 'lexlife-prepared-test';
export const PREPARED_FORMAT_VERSION = 1;
const MAX_TEXT = 1024 * 1024;
const MAX_RESULTS = 300;
const TEST_KEYS = new Set(['date', 'note', 'labRanges', 'customResults', ...TEST_FIELDS]);
const RESULT_KEYS = new Set(['group', 'name', 'value', 'unit', 'ref']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export class PreparedImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreparedImportError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (msg) => { throw new PreparedImportError(msg); };
const str = (v, max, what) => {
  if (v == null) return '';
  if (typeof v !== 'string') fail(`Поле «${what}» должно быть текстом.`);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > max) fail(`Поле «${what}» слишком длинное (больше ${max} символов).`);
  return s;
};
const hasForbidden = (o) => Object.keys(o).some((k) => FORBIDDEN.has(k));

function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900;
}

/* Простой числовой диапазон «4.00–11.00» → { refLow, refHigh }; иначе (текстовые
   пояснения лаборатории) — без границ, текст сохраняется как есть */
export function parseRange(ref) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[–—-]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(ref || '');
  if (!m) return {};
  const lo = Number(m[1].replace(',', '.'));
  const hi = Number(m[2].replace(',', '.'));
  return isNum(lo) && isNum(hi) && lo <= hi ? { refLow: lo, refHigh: hi } : {};
}

/* Текст файла → { importId, entry, summary }. Ничего не пишет. */
export function parsePreparedTest(text, { today = new Date() } = {}) {
  if (typeof text !== 'string' || !text.trim()) fail('Файл пуст.');
  if (text.length > MAX_TEXT) fail('Файл слишком большой для одной записи анализа.');
  let raw;
  try { raw = JSON.parse(text); } catch { fail('Файл повреждён: это не корректный JSON.'); }
  if (!isObj(raw) || hasForbidden(raw)) fail('Файл не является подготовленным анализом LexLife.');
  if (raw.app === 'lexlife' && raw.data && raw.backupFormatVersion != null) {
    fail('Это резервная копия LexLife, а не подготовленный анализ. Её восстанавливают в «Резервная копия».');
  }
  if (raw.app !== 'lexlife' || raw.kind !== PREPARED_KIND) fail('Файл не является подготовленным анализом LexLife.');
  if (raw.formatVersion !== PREPARED_FORMAT_VERSION) {
    fail(Number.isInteger(raw.formatVersion) && raw.formatVersion > PREPARED_FORMAT_VERSION
      ? 'Файл подготовлен для более новой версии LexLife. Обновите приложение.'
      : 'Неподдерживаемая версия формата подготовленного анализа.');
  }
  if (typeof raw.importId !== 'string' || !IMPORT_ID_RE.test(raw.importId)) {
    fail('В файле нет корректного идентификатора импорта (importId: 8–100 латинских букв, цифр, . _ : -).');
  }
  const t = raw.test;
  if (!isObj(t) || hasForbidden(t)) fail('В файле нет записи анализа (поле test).');
  const unknown = Object.keys(t).filter((k) => !TEST_KEYS.has(k));
  if (unknown.length) fail(`Неизвестные поля в записи анализа: ${unknown.slice(0, 5).join(', ')}.`);

  if (!isRealDate(t.date)) fail('Некорректная дата анализа (нужен формат ГГГГ-ММ-ДД).');
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (t.date > todayIso) fail('Дата анализа в будущем.');

  const entry = { date: t.date, note: str(t.note, 500, 'Заметка') };
  const main = [];
  for (const f of TEST_FIELDS) {
    if (t[f] == null) continue;
    if (!isNum(t[f])) fail(`Значение основного показателя «${f}» должно быть числом.`);
    entry[f] = t[f];
    main.push(f);
  }

  if (t.labRanges != null) {
    if (!isObj(t.labRanges) || hasForbidden(t.labRanges)) fail('Поле labRanges должно быть объектом.');
    const labRanges = {};
    for (const [k, v] of Object.entries(t.labRanges)) {
      if (!TEST_FIELDS.includes(k)) fail(`labRanges: неизвестный показатель «${k}».`);
      if (entry[k] == null) fail(`labRanges: диапазон для «${k}» без значения показателя.`);
      const s = str(v, 200, `диапазон ${k}`);
      if (s) labRanges[k] = s;
    }
    if (Object.keys(labRanges).length) entry.labRanges = labRanges;
  }

  const customResults = [];
  if (t.customResults != null) {
    if (!Array.isArray(t.customResults)) fail('Поле customResults должно быть списком.');
    if (t.customResults.length > MAX_RESULTS) fail(`Слишком много показателей (больше ${MAX_RESULTS}).`);
    const seen = new Set();
    t.customResults.forEach((r, i) => {
      const n = i + 1;
      if (!isObj(r) || hasForbidden(r)) fail(`Показатель №${n}: некорректная запись.`);
      const extra = Object.keys(r).filter((k) => !RESULT_KEYS.has(k));
      if (extra.length) fail(`Показатель №${n}: неизвестные поля ${extra.join(', ')}.`);
      const name = str(r.name, 120, `название показателя №${n}`);
      if (!name) fail(`Показатель №${n}: нет названия.`);
      if (!isNum(r.value)) fail(`Показатель «${name}»: значение должно быть числом.`);
      const item = { group: str(r.group, 60, 'группа'), name, value: r.value, unit: str(r.unit, 40, `единица «${name}»`), ref: str(r.ref, 200, `диапазон «${name}»`) };
      const key = `${item.group}\u0001${item.name}\u0001${item.unit}`.toLowerCase();
      if (seen.has(key)) fail(`Показатель «${name}» повторяется.`);
      seen.add(key);
      if (!item.group) delete item.group;
      Object.assign(item, parseRange(item.ref));
      customResults.push(item);
    });
  }
  if (customResults.length) entry.customResults = customResults;
  if (!main.length && !customResults.length) fail('В записи нет ни одного показателя.');

  entry.importId = raw.importId;
  entry.source = 'prepared-json';

  const groups = [];
  customResults.forEach((r) => {
    const g = r.group || 'Другие показатели';
    let grp = groups.find((x) => x.name === g);
    if (!grp) { grp = { name: g, items: [] }; groups.push(grp); }
    grp.items.push(r);
  });
  return { importId: raw.importId, entry, summary: { date: t.date, main, customCount: customResults.length, groups } };
}

/* Добавить разобранную запись к анализам (без замены). → { added, entry | existing } */
export async function importPreparedTest(storage, parsed, { now = new Date() } = {}) {
  return storage.addTestOnce({ ...parsed.entry, importedAt: now.toISOString() });
}
