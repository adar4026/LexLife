/* =========================================================
   testsJournal.js — журнал анализов: чистые функции без DOM.
   • journal — список записей по годам (от новых к старым), фильтр по году,
     номер записи внутри одной даты («Анализ № 1 / № 2»);
   • groupSummary — короткое описание групп для строки списка;
   • testSections — все показатели записи по разделам экрана полного анализа;
   • indicatorHistory — история одного показателя по всем анализам (для графика).
   Каждая запись анализа обрабатывается отдельно: данные разных записей не смешиваются.
   ========================================================= */

import { REFERENCE, TEST_FIELDS } from './storage.js';

/* Разделы экрана полного анализа — в этом порядке */
export const SECTIONS = [
  { key: 'lipids', title: 'Липиды' },
  { key: 'sugar', title: 'Сахар и метаболизм' },
  { key: 'organs', title: 'Печень и почки' },
  { key: 'iron', title: 'Железо и витамины' },
  { key: 'blood', title: 'Гематология' },
  { key: 'urine', title: 'Анализ мочи' },
  { key: 'stool', title: 'Кал' },
  { key: 'other', title: 'Другие показатели' },
];

const FIELD_SECTION = {
  chol: 'lipids', ldl: 'lipids', hdl: 'lipids', trig: 'lipids',
  glucose: 'sugar', hba1c: 'sugar',
  vitd: 'iron',
  hgb: 'blood', hct: 'blood',
  tsh: 'other', psa: 'other',
};

/* Раздел показателя лаборатории — по названию (рус./лат./исп.), затем по группе бланка.
   Исключение — группы «Анализ мочи» и «Кал»: их показатели (глюкоза, билирубин, гемоглобин в моче,
   скрытая кровь в кале) остаются в своём разделе и не смешиваются с одноимёнными показателями крови.
   words — целые слова (короткие аббревиатуры), stems — части слов. Порядок правил важен:
   «гликированный гемоглобин» — сахар, а не гематология; СРБ — «Другие». */
const RULES = [
  { section: 'other', words: ['crp', 'срб', 'pcr'], stems: ['реактивн', 'reactiv', 'натрийурет', 'natriuret'] },
  { section: 'lipids', words: ['ldl', 'hdl', 'vldl', 'лпнп', 'лпвп', 'лпонп', 'apoa', 'apob', 'apoa1', 'lpa'],
    stems: ['холестер', 'cholest', 'colester', 'триглицер', 'triglic', 'triglyc', 'липопротеин', 'lipoprot', 'аполипо', 'apolipo'] },
  { section: 'sugar', words: ['hba1c', 'homa', 'a1c'],
    stems: ['глюкоз', 'glucos', 'glucem', 'glicem', 'гликир', 'glycat', 'glicad', 'glicos', 'инсулин', 'insulin',
      'мочевая кислот', 'мочевой кислот', 'uric', 'úric', 'фруктозамин', 'fructosam', 'с-пептид', 'c-пептид', 'c-peptid', 'péptido c'] },
  { section: 'organs', words: ['ast', 'alt', 'got', 'gpt', 'ggt', 'ггт', 'алт', 'аст', 'ldh', 'лдг', 'bun', 'gfr', 'egfr', 'скф', 'alp', 'щф', 'ггтп'],
    stems: ['фосфатаз', 'phosphat', 'fosfat', 'билирубин', 'bilirub', 'bilirrub', 'альбумин', 'albumin', 'общий белок', 'белок общий',
      'proteínas totales', 'total protein', 'креатинин', 'creatin', 'мочевин', 'urea', 'цистатин', 'cystatin', 'cistatin',
      'трансаминаз', 'transamin', 'амилаз', 'amilas', 'amylas', 'липаз', 'lipas'] },
  { section: 'iron', words: ['b12', 'b9', 'b6', 'b1', 'd3', 'd2', 'tibc', 'ожсс'],
    stems: ['желез', 'iron', 'hierro', 'ферритин', 'ferritin', 'трансферрин', 'transferr', 'фолиев', 'фолат', 'folat', 'fólic', 'folic',
      'витамин', 'vitamin', 'кобаламин', 'cobalam', 'cianocobal'] },
  { section: 'blood', words: ['mcv', 'mch', 'mchc', 'rdw', 'mpv', 'pdw', 'pct', 'wbc', 'rbc', 'plt', 'hgb', 'hb', 'hct', 'соэ', 'esr', 'vsg'],
    stems: ['лейкоцит', 'leucocit', 'leukocyt', 'эритроцит', 'eritrocit', 'erythrocyt', 'hematí', 'тромбоцит', 'plaquet', 'platelet',
      'гемоглобин', 'hemoglobin', 'гематокрит', 'hematocrit', 'лимфоцит', 'linfocit', 'lymphocyt', 'моноцит', 'monocit', 'monocyt',
      'нейтрофил', 'neutrofil', 'neutrophil', 'эозинофил', 'eosinofil', 'eosinophil', 'базофил', 'basofil', 'basophil',
      'палочкояд', 'сегментояд', 'ретикулоцит', 'reticulocit', 'reticulocyt', 'тромбокрит', 'plaquetocrit', 'plateletcrit'] },
];

const URINE_GROUP = ['моч', 'orina', 'urin'];
/* «Кал» / «Анализ кала» — целым словом, чтобы не задеть «кальций»; остальное — части слов */
const STOOL_WORDS = ['кал', 'кала'];
const STOOL_GROUP = ['копрогр', 'heces', 'stool', 'feces', 'faeces', 'fecal', 'faecal'];
const isStoolGroup = (group) => wordsOf(group).some((w) => STOOL_WORDS.includes(w)) || STOOL_GROUP.some((s) => group.includes(s));

const GROUP_RULES = [
  { section: 'blood', stems: ['гематолог', 'hemat', 'кровь общ', 'общий анализ крови', 'hemogram'] },
  { section: 'iron', stems: ['витамин', 'vitamin'] },
  { section: 'organs', stems: ['печен', 'почк', 'hepat', 'renal', 'kidney', 'liver'] },
  { section: 'lipids', stems: ['липидограм', 'lipidogram', 'lipid profile', 'perfil lipíd'] },
];

const lower = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const wordsOf = (s) => lower(s).split(/[^a-zа-я0-9áéíóúñü]+/).filter(Boolean);

export function sectionOfResult(r) {
  const group = lower(r && r.group);
  if (URINE_GROUP.some((s) => group.includes(s))) return 'urine';
  if (isStoolGroup(group)) return 'stool';
  const name = lower(r && r.name);
  const words = new Set(wordsOf(name));
  for (const rule of RULES) {
    if (rule.words.some((w) => words.has(w)) || rule.stems.some((s) => name.includes(s))) return rule.section;
  }
  for (const rule of GROUP_RULES) if (rule.stems.some((s) => group.includes(s))) return rule.section;
  return 'other';
}
export const sectionOfField = (f) => FIELD_SECTION[f] || 'other';

/* ---------- цветовая отметка (как раньше в карточке анализа) ---------- */

/* Основные поля — справочные значения приложения (REFERENCE): good | warn | danger | none */
export function evaluateField(field, value) {
  const ref = REFERENCE[field];
  if (!ref || value == null || value === '' || isNaN(Number(value))) return 'none';
  const v = Number(value);
  if (ref.higherIsBetter) return v >= ref.goodMin ? 'good' : 'warn';
  if (ref.goodMin != null && ref.good != null) return v >= ref.goodMin && v <= ref.good ? 'good' : 'warn';
  if (ref.warn != null) {
    if (v <= ref.good) return 'good';
    if (v <= ref.warn) return 'warn';
    return 'danger';
  }
  return v <= ref.good ? 'good' : 'danger';
}
/* Показатели лаборатории — только факт выхода за числовой диапазон бланка: '↑' | '↓' | '' */
export function outOfLabRange(r) {
  if (!r || typeof r.value !== 'number' || r.refLow == null || r.refHigh == null) return '';
  return r.value < r.refLow ? '↓' : r.value > r.refHigh ? '↑' : '';
}

/* ---------- ключ показателя для истории ---------- */
const normName = (s) => lower(s).trim().replace(/\s+/g, ' ');
export const fieldKey = (f) => f;
export const customKey = (name) => `c:${normName(name)}`;

/* Стандартные показатели анализа мочи — стабильный внутренний ключ и единое название.
   Лаборатории и импорты называют их по-разному («pH» / «pH мочи», «Белок в моче» / «Белок (моча)»,
   PROTEINAS / GLUCOSURIA); ключ объединяет историю, исходное название в записи не меняется.
   Только для показателей раздела «Анализ мочи»; порядок правил важен (уробилиноген — до билирубина). */
const URINE_KEYS = [
  { key: 'urine_specific_gravity', label: 'Удельный вес мочи', stems: ['удельн', 'плотност', 'densidad', 'specific gravity', 'gravedad'] },
  { key: 'urine_ph', label: 'pH мочи', words: ['ph'] },
  { key: 'urine_nitrites', label: 'Нитриты', stems: ['нитрит', 'nitrit'] },
  { key: 'urine_protein', label: 'Белок (моча)', stems: ['белок', 'протеин', 'protein', 'proteín'] },
  { key: 'urine_glucose', label: 'Глюкоза (моча)', stems: ['глюкоз', 'glucos'] },
  { key: 'urine_ketones', label: 'Кетоновые тела', stems: ['кетон', 'ceton', 'cetón', 'keton'] },
  { key: 'urine_urobilinogen', label: 'Уробилиноген', stems: ['уробилин', 'urobilin'] },
  { key: 'urine_bilirubin', label: 'Билирубин (моча)', stems: ['билирубин', 'bilirub', 'bilirrub'] },
  { key: 'urine_hemoglobin_myoglobin', label: 'Гемоглобин/миоглобин (моча)', stems: ['гемоглобин', 'миоглобин', 'hemoglobin', 'mioglobin', 'myoglobin'] },
  { key: 'urine_sediment', label: 'Осадок мочи', stems: ['осадок', 'sediment'] },
];
/* → { key, label } стандартного показателя мочи или null */
export function urineStandard(r) {
  if (!r || sectionOfResult(r) !== 'urine') return null;
  const name = lower(r.name);
  const words = new Set(wordsOf(name));
  const u = URINE_KEYS.find((x) => (x.words || []).some((w) => words.has(w)) || (x.stems || []).some((st) => name.includes(st)));
  return u ? { key: u.key, label: u.label } : null;
}
/* Ключ истории показателя лаборатории: стандартный показатель мочи — urine_*, иначе c:<название> */
export const resultKey = (r) => (urineStandard(r) || {}).key || customKey(r.name);

const customList = (t) => (Array.isArray(t && t.customResults) ? t.customResults.filter((r) => r && typeof r.name === 'string') : []);
const hasNum = (v) => typeof v === 'number' && Number.isFinite(v);
/* качественный результат бланка («отрицательно») — только если нет числа */
const textOf = (r) => (!hasNum(r.value) && typeof r.text === 'string' && r.text.trim() ? r.text.trim() : '');

/* ---------- строки показателей одной записи ---------- */
function rowsOf(t) {
  const rows = [];
  TEST_FIELDS.forEach((f) => {
    if (!hasNum(t[f])) return;
    const ref = REFERENCE[f];
    rows.push({
      kind: 'field', key: fieldKey(f), section: sectionOfField(f), name: ref.label, value: t[f], unit: ref.unit,
      ref: t.labRanges && typeof t.labRanges[f] === 'string' ? t.labRanges[f] : '',
      status: evaluateField(f, t[f]), out: '',
    });
  });
  customList(t).forEach((r) => {
    const std = urineStandard(r);
    rows.push({
      kind: 'custom', key: std ? std.key : customKey(r.name), section: sectionOfResult(r), name: std ? std.label : r.name,
      labName: std && normName(std.label) !== normName(r.name) ? r.name : '',
      value: hasNum(r.value) ? r.value : null, text: textOf(r), unit: r.unit || '', ref: r.ref || '', group: r.group || '',
      status: 'none', out: outOfLabRange(r),
    });
  });
  return rows;
}

/* Разделы полного анализа: [{ key, title, rows }] — только непустые, в порядке SECTIONS.
   Внутри раздела: основные поля, затем показатели лаборатории в порядке бланка. */
export function testSections(t) {
  const rows = rowsOf(t || {});
  return SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => r.section === s.key) })).filter((s) => s.rows.length);
}
export const indicatorCount = (t) => rowsOf(t || {}).length;

/* Короткое описание для строки списка: группы бланка лаборатории (как в документе),
   а без них — разделы основных полей. «Гематология · Биохимия · Витамины» */
export function groupSummary(t) {
  const rows = rowsOf(t || {});
  const groups = [...new Set(customList(t).map((r) => String(r.group || '').trim()).filter(Boolean))];
  /* разделы, которые группы бланка не покрывают: основные поля вне бланка (липиды,
     введённые вручную) и показатели без группы */
  const covered = new Set(rows.filter((r) => r.kind === 'custom' && r.group).map((r) => r.section));
  const groupText = lower(groups.join(' '));
  const extra = SECTIONS.filter((s) => rows.some((r) => r.section === s.key)
    && !covered.has(s.key) && !SECTION_WORDS[s.key].some((w) => groupText.includes(w)));
  return [...groups, ...extra.map((s) => s.title)].join(' · ');
}
/* Названия групп бланка, которые уже говорят о разделе («Биохимия и липиды» → липиды) */
const SECTION_WORDS = {
  lipids: ['липид', 'lipid'],
  sugar: ['сахар', 'глюк', 'метабол', 'glucos'],
  organs: ['печен', 'почк', 'hepat', 'renal'],
  iron: ['желез', 'витамин', 'vitamin'],
  blood: ['гематолог', 'hemat', 'кровь'],
  urine: URINE_GROUP,
  stool: STOOL_GROUP,
  other: [],
};

/* ---------- журнал ---------- */
export const yearOf = (t) => Number(String(t.date).slice(0, 4));

/* tests — как их отдаёт Storage.getTests() (sortTests: даты по убыванию, в одну дату позже
   добавленный выше). Здесь — только устойчивая сортировка по дате: повторный вызов порядок не меняет.
   → { total, years: [2026, 2025, …], year: 'all'|number, shown, groups: [{ year, items: [{ test, no, sameDay }] }] }
   no — номер записи внутри своей даты по порядку добавления (1, 2, …), sameDay — сколько записей в эту дату. */
export function journal(tests, { year = 'all' } = {}) {
  const list = tests.slice().sort((a, b) => b.date.localeCompare(a.date));
  const perDate = new Map();
  list.forEach((t) => perDate.set(t.date, (perDate.get(t.date) || 0) + 1));
  const seen = new Map();
  const items = list.map((t) => {
    const count = perDate.get(t.date);
    const pos = seen.get(t.date) || 0; // 0 — самая новая запись этой даты
    seen.set(t.date, pos + 1);
    return { test: t, no: count - pos, sameDay: count };
  });
  const years = [...new Set(list.map(yearOf))].sort((a, b) => b - a);
  const y = year !== 'all' && years.includes(Number(year)) ? Number(year) : 'all';
  const shown = y === 'all' ? items : items.filter((it) => yearOf(it.test) === y);
  const groups = [];
  shown.forEach((it) => {
    const yr = yearOf(it.test);
    let g = groups[groups.length - 1];
    if (!g || g.year !== yr) { g = { year: yr, items: [] }; groups.push(g); }
    g.items.push(it);
  });
  return { total: list.length, years, year: y, shown: shown.length, groups };
}

/* Номер записи в своей дате (для заголовка полного анализа) → { no, sameDay } */
export function sameDayNumber(tests, id) {
  const it = journal(tests).groups.flatMap((g) => g.items).find((x) => x.test.id === id);
  return it ? { no: it.no, sameDay: it.sameDay } : { no: 1, sameDay: 1 };
}

/* ---------- история одного показателя ----------
   Ключ — поле формы, urine_* (стандартный показатель мочи, см. URINE_KEYS) или c:<название>.
   → { key, title, unit, entries: [{ testId, date, no, sameDay, value, text, unit, ref, out, status, name, labName }] (новые сверху),
       points: [{ date, value }] (для графика: одна единица, по одному значению на дату — позже добавленное) } */
export function indicatorHistory(tests, key) {
  const isField = TEST_FIELDS.includes(key);
  /* старая ссылка c:<название> на стандартный показатель мочи → его ключ */
  if (!isField && key.startsWith('c:')) {
    const r = tests.flatMap(customList).find((x) => customKey(x.name) === key);
    if (r && urineStandard(r)) key = urineStandard(r).key;
  }
  const items = journal(tests).groups.flatMap((g) => g.items);
  const entries = [];
  items.forEach(({ test: t, no, sameDay }) => {
    if (isField) {
      if (!hasNum(t[key])) return;
      entries.push({
        testId: t.id, date: t.date, no, sameDay, value: t[key], unit: REFERENCE[key].unit,
        ref: t.labRanges && typeof t.labRanges[key] === 'string' ? t.labRanges[key] : '',
        out: '', status: evaluateField(key, t[key]), name: REFERENCE[key].label,
      });
      return;
    }
    customList(t).filter((r) => resultKey(r) === key).forEach((r) => {
      const std = urineStandard(r);
      entries.push({
        testId: t.id, date: t.date, no, sameDay, value: hasNum(r.value) ? r.value : null, text: textOf(r), unit: r.unit || '',
        ref: r.ref || '', out: outOfLabRange(r), status: 'none', name: std ? std.label : r.name,
        labName: std && normName(std.label) !== normName(r.name) ? r.name : '',
      });
    });
  });
  const title = isField ? REFERENCE[key].label : (entries[0] ? entries[0].name : 'Показатель');
  const unit = isField ? REFERENCE[key].unit : (entries.find((e) => e.value != null) || {}).unit || '';
  const byDate = new Map();
  entries.forEach((e) => { // entries — новые сверху: первое значение даты — позже добавленное
    if (e.value == null || normName(e.unit) !== normName(unit) || byDate.has(e.date)) return;
    byDate.set(e.date, e.value);
  });
  const points = [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
  return { key, title, unit, entries, points };
}
