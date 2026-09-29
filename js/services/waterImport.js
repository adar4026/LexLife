/* =========================================================
   waterImport.js — разовый импорт истории воды из CSV WaterMinder
   в metrics_log.water (см. storage.js §«Вода»).
   Чистые функции разбора CSV и построения плана импорта (без DOM,
   без Storage) + два тонких адаптера, применяющих готовый план через
   StorageService.bulkAddWaterEntries(). Тестируются напрямую (см.
   tests/water-import.test.mjs), без браузера.

   Формат приёма в metrics_log.water[date].entries — { t, ml } (см.
   METRIC_VALUE_OK.water в storage.js); лишние поля объекта запись
   не запрещены схемой, поэтому импортированные записи несут доп.
   поля: key (устойчивый ключ идемпотентности), drink (тип напитка
   из CSV, если указан), hydrationMl (исходный объём напитка, если
   он отличается от объёма гидратации — например, кофе/пиво).
   ========================================================= */

export const WATERMINDER_IMPORT_PREFIX = 'wm';

const REQUIRED_COLUMNS = ['Drink Type', 'Water Value(ml)', 'Date', 'Time'];

/* Разбор одной строки CSV с учётом кавычек и экранирования "" —
   WaterMinder оборачивает числовые поля в кавычки, переносов строк
   внутри значений не использует. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function parseCsvText(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(parseCsvLine);
  return { header, rows };
}

/* Дата WaterMinder — d/m/yy (без ведущих нулей), локальная, БЕЗ UTC-преобразований. */
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;
export function parseWaterMinderDate(s) {
  const m = DATE_RE.exec(String(s || '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = 2000 + Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null; // напр. 31/4
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* Время WaterMinder — HH:mm, локальное, без преобразований часового пояса. */
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
export function parseWaterMinderTime(s) {
  const m = TIME_RE.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseMl(s) {
  if (s == null || s === '') return null;
  const n = Number(String(s).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* CSV WaterMinder → { rows, errors, totalLines }.
   rows: { dateKey, time, ml, hydrationMl, drinkType, line }.
   Строки с нечитаемой датой/временем/объёмом идут в errors и не импортируются. */
export function parseWaterMinderCsv(text) {
  const { header, rows } = parseCsvText(text);
  const idx = {};
  REQUIRED_COLUMNS.forEach((name) => { idx[name] = header.indexOf(name); });
  const missing = REQUIRED_COLUMNS.filter((name) => idx[name] < 0);
  if (missing.length) {
    throw new Error(`Не найдены столбцы WaterMinder CSV: ${missing.join(', ')}`);
  }
  const iHydration = header.indexOf('Hydration Value(ml)');

  const out = [];
  const errors = [];
  rows.forEach((r, i) => {
    const dateKey = parseWaterMinderDate(r[idx['Date']]);
    const time = parseWaterMinderTime(r[idx['Time']]);
    const ml = parseMl(r[idx['Water Value(ml)']]);
    const hydrationMlRaw = iHydration >= 0 ? parseMl(r[iHydration]) : null;
    const drinkType = String(r[idx['Drink Type']] || '').trim();
    if (!dateKey || !time || ml == null || ml <= 0) {
      errors.push({ line: i + 2, raw: r });
      return;
    }
    out.push({
      dateKey,
      time,
      ml: Math.round(ml),
      hydrationMl: hydrationMlRaw != null ? Math.round(hydrationMlRaw) : null,
      drinkType,
      line: i + 2,
    });
  });
  return { rows: out, errors, totalLines: rows.length };
}

/* Устойчивый ключ идемпотентности: дата+время+объём+тип напитка, плюс порядковый
   номер повторения этой же комбинации в файле. WaterMinder регулярно содержит
   несколько РАЗНЫХ приёмов с одинаковыми на вид значениями (например, три кружки
   по 300 мл подряд в одну и ту же минуту) — их нельзя схлопывать в одну запись,
   поэтому ключ различает n-е вхождение одной и той же комбинации, а не просто
   комбинацию саму по себе. Порядок вычисляется по порядку строк в файле и
   стабилен между запусками одного и того же CSV. */
export function assignImportKeys(rows, prefix = WATERMINDER_IMPORT_PREFIX) {
  const counts = new Map();
  return rows.map((r) => {
    const tuple = `${r.dateKey}|${r.time}|${r.ml}|${r.drinkType}`;
    const n = counts.get(tuple) || 0;
    counts.set(tuple, n + 1);
    return { ...r, importKey: `${prefix}:${tuple}:${n}` };
  });
}

function isWaterMinderKey(key, prefix = WATERMINDER_IMPORT_PREFIX) {
  return typeof key === 'string' && key.startsWith(`${prefix}:`);
}

function toEntry(row) {
  const entry = { t: row.time, ml: row.ml, key: row.importKey };
  if (row.drinkType) entry.drink = row.drinkType;
  if (row.hydrationMl != null && row.hydrationMl !== row.ml) entry.hydrationMl = row.hydrationMl;
  return entry;
}

/* Собрать план импорта по строкам, уже размеченным ключами (assignImportKeys),
   против текущей истории воды (metrics_log.water). Ничего не пишет — только план.
   todayKey — дата, которую план по умолчанию держит отдельно (see: сегодняшние
   записи импортируются отдельным подтверждённым действием, а не автоматически). */
export function buildWaterImportPlan(rows, existingWaterLog, todayKey) {
  const existingKeys = new Set();
  for (const day of Object.values(existingWaterLog || {})) {
    for (const e of (day && day.entries) || []) {
      if (e && typeof e.key === 'string') existingKeys.add(e.key);
    }
  }

  const perDay = new Map(); // dateKey -> { csvCount, newCount, dupCount }
  const additionsByDay = {}; // исключая todayKey
  const todayAdditions = []; // [{ day, entry, row }]
  const duplicates = []; // строки, уже импортированные ранее (повторный запуск)
  let minDate = null;
  let maxDate = null;

  for (const r of rows) {
    if (minDate == null || r.dateKey < minDate) minDate = r.dateKey;
    if (maxDate == null || r.dateKey > maxDate) maxDate = r.dateKey;
    const stat = perDay.get(r.dateKey) || { csvCount: 0, newCount: 0, dupCount: 0 };
    stat.csvCount += 1;
    if (existingKeys.has(r.importKey)) {
      stat.dupCount += 1;
      duplicates.push(r);
    } else {
      stat.newCount += 1;
      const entry = toEntry(r);
      if (r.dateKey === todayKey) {
        todayAdditions.push({ day: r.dateKey, entry, row: r });
      } else {
        (additionsByDay[r.dateKey] || (additionsByDay[r.dateKey] = [])).push(entry);
      }
    }
    perDay.set(r.dateKey, stat);
  }

  const todayLog = (existingWaterLog || {})[todayKey];
  const todayEntries = (todayLog && todayLog.entries) || [];
  const existingTodayManualCount = todayEntries.filter((e) => !isWaterMinderKey(e && e.key)).length;
  const existingTodayImportedCount = todayEntries.length - existingTodayManualCount;

  const addedCount = Object.values(additionsByDay).reduce((s, l) => s + l.length, 0);

  return {
    totalRows: rows.length,
    minDate,
    maxDate,
    perDay,
    additionsByDay,
    todayAdditions,
    duplicates,
    todayKey,
    addedCount,
    duplicateCount: duplicates.length,
    csvTodayCount: (perDay.get(todayKey) || { csvCount: 0 }).csvCount,
    existingTodayManualCount,
    existingTodayImportedCount,
  };
}

/* Применить основной план — все дни, КРОМЕ todayKey. Одна операция записи. */
export async function applyWaterImportPlan(storage, plan) {
  await storage.bulkAddWaterEntries(plan.additionsByDay);
  return {
    importedCount: plan.addedCount,
    days: Object.keys(plan.additionsByDay).sort(),
  };
}

/* Отдельное подтверждённое действие — импорт только сегодняшних записей плана. */
export async function applyTodayWaterImport(storage, plan) {
  const byDay = {};
  for (const { day, entry } of plan.todayAdditions) {
    (byDay[day] || (byDay[day] = [])).push(entry);
  }
  await storage.bulkAddWaterEntries(byDay);
  return { importedCount: plan.todayAdditions.length, day: plan.todayKey };
}
