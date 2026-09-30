/* =========================================================
   tests/tests-journal.test.mjs — журнал анализов и «Документ анализа».
   • порядок записей (новые сверху), одна дата — отдельные записи с номерами,
     разделы полного анализа, история показателя, фильтр по годам;
   • совместимость: ручное добавление/изменение, импорт JSON, обычный и полный backup;
   • DocSession — нет утечки Blob URL; многостраничный PDF через локальный pdf.js.
   Без браузера и сети. Только синтетические данные.

   Запуск:  node tests/tests-journal.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, sortTests } from '../js/services/storage.js';
import { AttachmentService, MemoryAttachmentStore, attachmentOf } from '../js/services/attachments.js';
import { createFullBackup, prepareFullRestore, applyFullRestore } from '../js/services/fullBackup.js';
import { parsePreparedTest, importPreparedTest } from '../js/services/preparedImport.js';
import {
  journal, groupSummary, testSections, indicatorHistory, sameDayNumber, sectionOfResult,
  customKey, evaluateField, outOfLabRange, indicatorCount,
} from '../js/services/testsJournal.js';
import { DocSession, stepZoom, clampZoom, canvasScale } from '../js/ui/docViewer.js';
import { makeTestPdf } from './helpers/syntheticPdf.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function setup() {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  const store = new MemoryAttachmentStore();
  return { storage, store, service: new AttachmentService(storage, store) };
}
const pdfFile = (name = 'synthetic.pdf', pages = 2) => new File([makeTestPdf(pages)], name, { type: 'application/pdf' });
const ids = (list) => list.map((t) => t.id);
const flat = (j) => j.groups.flatMap((g) => g.items);
const lab = (group, name, value, unit, ref, refLow, refHigh) => ({ group, name, value, unit, ref, ...(refLow != null ? { refLow, refHigh } : {}) });

/* ================= порядок и разделение записей ================= */

test('1. новый анализ появляется вверху, старые опускаются ниже', async () => {
  const { storage } = await setup();
  const a = await storage.addTest({ date: '2025-05-03', hgb: 14 });
  const b = await storage.addTest({ date: '2025-10-15', chol: 190 });
  assert.deepEqual(ids(await storage.getTests()), [b.id, a.id]);
  const c = await storage.addTest({ date: '2026-02-14', ldl: 100 });
  assert.deepEqual(ids(await storage.getTests()), [c.id, b.id, a.id]);
  assert.equal((await storage.getLatestTest()).id, c.id);
  const j = journal(await storage.getTests());
  assert.deepEqual(flat(j).map((it) => it.test.id), [c.id, b.id, a.id]);
  /* запись с более ранней датой встаёт на своё место по дате */
  const old = await storage.addTest({ date: '2024-02-01', tsh: 2 });
  assert.equal((await storage.getTests()).at(-1).id, old.id);
});

test('2. анализы разных дат не смешиваются: у каждой записи свои показатели, документ и история', async () => {
  const { storage, service } = await setup();
  const a = await storage.addTest({ date: '2025-10-15', chol: 210, customResults: [lab('Гематология', 'Лейкоциты', 6.1, 'x10³/mm³', '4.00–11.00', 4, 11)] });
  const b = await storage.addTest({ date: '2026-02-14', chol: 180, hgb: 15, customResults: [lab('Гематология', 'Лейкоциты', 12.5, 'x10³/mm³', '4.00–11.00', 4, 11), lab('Витамины', 'Витамин B12', 400, 'pg/mL', '200–900', 200, 900)] });
  await service.attachToTest(b.id, pdfFile('b.pdf'));
  const [tb, ta] = await storage.getTests();
  assert.equal(tb.id, b.id);
  assert.equal(attachmentOf(ta), null, 'документ не «переехал» к другой записи');
  assert.equal(attachmentOf(tb).name, 'b.pdf');
  const valsA = testSections(ta).flatMap((s) => s.rows.map((r) => `${r.name}=${r.value}`));
  const valsB = testSections(tb).flatMap((s) => s.rows.map((r) => `${r.name}=${r.value}`));
  assert.deepEqual(valsA.sort(), ['Лейкоциты=6.1', 'Холестерин общий=210'].sort());
  assert.deepEqual(valsB.sort(), ['Витамин B12=400', 'Гемоглобин=15', 'Лейкоциты=12.5', 'Холестерин общий=180'].sort());
  const h = indicatorHistory(await storage.getTests(), customKey('лейкоциты'));
  assert.deepEqual(h.entries.map((e) => [e.testId, e.value, e.out]), [[b.id, 12.5, '↑'], [a.id, 6.1, '']]);
});

test('3. два анализа в одну дату — две отдельные записи «№ 1 / № 2», новая выше', async () => {
  const { storage } = await setup();
  const first = await storage.addTest({ date: '2026-02-14', chol: 190 });
  const other = await storage.addTest({ date: '2025-12-01', hgb: 14 });
  const second = await storage.addTest({ date: '2026-02-14', vitd: 35 });
  const list = await storage.getTests();
  assert.deepEqual(ids(list), [second.id, first.id, other.id]);
  const items = flat(journal(list));
  assert.deepEqual(items.map((it) => [it.test.id, it.no, it.sameDay]), [[second.id, 2, 2], [first.id, 1, 2], [other.id, 1, 1]]);
  assert.deepEqual(sameDayNumber(list, first.id), { no: 1, sameDay: 2 });
  assert.deepEqual(sameDayNumber(list, second.id), { no: 2, sameDay: 2 });
  /* показатели не сливаются */
  assert.deepEqual(testSections(list[0]).flatMap((s) => s.rows.map((r) => r.key)), ['vitd']);
  assert.deepEqual(testSections(list[1]).flatMap((s) => s.rows.map((r) => r.key)), ['chol']);
  /* изменение не меняет место записи внутри даты */
  await storage.updateTest(first.id, { note: 'изменено' });
  assert.deepEqual(ids(await storage.getTests()), [second.id, first.id, other.id]);
  /* для графика в одну дату берётся позже добавленное значение, в списке — оба */
  await storage.updateTest(first.id, { vitd: 20 });
  const h = indicatorHistory(await storage.getTests(), 'vitd');
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.points, [{ date: '2026-02-14', value: 35 }]);
});

test('sortTests и journal: порядок для старых записей без служебных полей, повторный вызов его не меняет', () => {
  const list = [{ id: 'a', date: '2025-01-01' }, { id: 'b', date: '2026-03-01' }, { id: 'c', date: '2025-01-01' }];
  const sorted = sortTests(list);
  assert.deepEqual(ids(sorted), ['b', 'c', 'a']);
  assert.deepEqual(ids(list), ['a', 'b', 'c'], 'исходный массив не меняется');
  const once = flat(journal(sorted)).map((i) => [i.test.id, i.no]);
  const twice = flat(journal(flat(journal(sorted)).map((i) => i.test))).map((i) => [i.test.id, i.no]);
  assert.deepEqual(once, [['b', 1], ['c', 2], ['a', 1]]);
  assert.deepEqual(twice, once);
});

/* ================= год, фильтр, описание групп ================= */

test('9a. заголовки годов и фильтр «Все / по годам» (по умолчанию — все)', () => {
  const list = [
    { id: 't1', date: '2026-02-14' }, { id: 't2', date: '2025-10-15' },
    { id: 't3', date: '2025-05-03' }, { id: 't4', date: '2023-07-07' },
  ];
  const all = journal(list);
  assert.equal(all.year, 'all');
  assert.deepEqual(all.years, [2026, 2025, 2023]);
  assert.deepEqual(all.groups.map((g) => [g.year, g.items.map((i) => i.test.id)]), [[2026, ['t1']], [2025, ['t2', 't3']], [2023, ['t4']]]);
  assert.equal(all.shown, 4);
  const y25 = journal(list, { year: 2025 });
  assert.equal(y25.year, 2025);
  assert.deepEqual(flat(y25).map((i) => i.test.id), ['t2', 't3']);
  assert.equal(y25.total, 4);
  assert.deepEqual(journal(list, { year: '2023' }).groups.map((g) => g.year), [2023]);
  /* год, которого больше нет (анализ удалён), — назад ко «Все» */
  assert.equal(journal(list, { year: 2019 }).year, 'all');
  assert.deepEqual(journal([], {}).groups, []);
});

test('описание групп: группы бланка, иначе разделы; старые записи без показателей', () => {
  assert.equal(groupSummary({ date: '2026-02-14', hgb: 14, customResults: [lab('Гематология', 'Лейкоциты', 5), lab('Биохимия', 'Креатинин', 0.9), lab('Гематология', 'MCV', 90), lab('Витамины', 'Витамин B12', 400)] }), 'Гематология · Биохимия · Витамины');
  assert.equal(groupSummary({ date: '2025-10-15', chol: 200, ldl: 120, glucose: 90 }), 'Липиды · Сахар и метаболизм');
  assert.equal(groupSummary({ date: '2025-05-03', hgb: 14, hct: 44 }), 'Гематология');
  /* основные поля вне групп бланка не теряются; группа «… и липиды» уже их называет */
  assert.equal(groupSummary({ date: '2025-10-15', chol: 205, ldl: 128, customResults: [lab('Гематология', 'Лейкоциты', 6)] }), 'Гематология · Липиды');
  assert.equal(groupSummary({ date: '2025-10-15', chol: 205, customResults: [lab('Биохимия и липиды', 'Креатинин', 0.9)] }), 'Биохимия и липиды');
  assert.equal(groupSummary({ date: '2025-10-15', customResults: [lab('', 'Ферритин', 80), lab('Гематология', 'MCV', 90)] }), 'Гематология · Железо и витамины');
  assert.equal(groupSummary({ date: '2020-01-01', note: 'старая запись' }), '');
  assert.equal(indicatorCount({ date: '2020-01-01' }), 0);
  assert.deepEqual(testSections({ date: '2020-01-01' }), []);
});

/* ================= разделы полного анализа ================= */

test('разделы полного анализа: Липиды · Сахар · Печень и почки · Железо и витамины · Гематология · (Анализ мочи) · Другие', () => {
  const cases = {
    'LDL холестерин': 'lipids', 'Colesterol HDL': 'lipids', 'Триглицериды': 'lipids',
    'Глюкоза': 'sugar', 'Гликированный гемоглобин HbA1c': 'sugar', 'Мочевая кислота': 'sugar', 'Инсулин': 'sugar',
    'AST / GOT': 'organs', 'ALT / GPT': 'organs', 'ГГТ / GGT': 'organs', 'Щелочная фосфатаза': 'organs',
    'Билирубин общий': 'organs', 'Креатинин': 'organs', 'Мочевина': 'organs', 'СКФ (CKD-EPI)': 'organs',
    'Железо': 'iron', 'Ферритин': 'iron', 'Насыщение трансферрина': 'iron', 'Фолиевая кислота': 'iron', 'Витамин B12': 'iron',
    'Лейкоциты': 'blood', 'Нейтрофилы, абсолютное число': 'blood', 'MCHC': 'blood', 'RDW': 'blood', 'Тромбокрит': 'blood', 'СОЭ': 'blood',
    'С-реактивный белок': 'other', 'ТТГ': 'other', 'Кортизол': 'other',
  };
  for (const [name, section] of Object.entries(cases)) assert.equal(sectionOfResult({ name }), section, name);
  /* неизвестное название — по группе бланка, иначе «Другие» */
  assert.equal(sectionOfResult({ name: 'Показатель X', group: 'Гематология' }), 'blood');
  assert.equal(sectionOfResult({ name: 'Показатель X', group: 'Витамины' }), 'iron');
  assert.equal(sectionOfResult({ name: 'Показатель X', group: 'Биохимия и липиды' }), 'other');

  const t = {
    date: '2026-02-14', chol: 190, ldl: 110, glucose: 95, vitd: 28, hgb: 15, psa: 1.1,
    labRanges: { ldl: '0.00–116.00' },
    customResults: [lab('Гематология', 'Лейкоциты', 3.1, 'x10³/mm³', '4.00–11.00', 4, 11), lab('Биохимия', 'Креатинин', 0.9, 'mg/dL', '0.70–1.20', 0.7, 1.2), lab('Разное', 'Новый показатель', 5, 'ед', 'см. бланк')],
  };
  const secs = testSections(t);
  assert.deepEqual(secs.map((s) => s.title), ['Липиды', 'Сахар и метаболизм', 'Печень и почки', 'Железо и витамины', 'Гематология', 'Другие показатели']);
  const blood = secs.find((s) => s.key === 'blood').rows;
  assert.deepEqual(blood.map((r) => [r.name, r.out]), [['Гемоглобин', ''], ['Лейкоциты', '↓']]);
  const ldl = secs[0].rows.find((r) => r.key === 'ldl');
  assert.equal(ldl.ref, '0.00–116.00');
  assert.equal(ldl.status, evaluateField('ldl', 110));
  const other = secs.find((s) => s.key === 'other').rows.map((r) => r.name);
  assert.deepEqual(other, ['PSA', 'Новый показатель'], 'пользовательский показатель показан');
  assert.equal(outOfLabRange({ value: 12, refLow: 4, refHigh: 11 }), '↑');
  assert.equal(outOfLabRange({ value: 12 }), '');
});

test('анализ мочи — отдельный раздел: одноимённые показатели не смешиваются с кровью; текстовые результаты', async () => {
  const urine = (name, extra) => ({ group: 'Анализ мочи', name, unit: '', ref: '', ...extra });
  assert.equal(sectionOfResult({ name: 'Глюкоза (моча)', group: 'Анализ мочи' }), 'urine');
  assert.equal(sectionOfResult({ name: 'Гемоглобин/миоглобин (моча)', group: 'Анализ мочи' }), 'urine');
  assert.equal(sectionOfResult({ name: 'Densidad', group: 'Orina' }), 'urine');
  assert.equal(sectionOfResult({ name: 'Мочевина', group: 'Биохимия' }), 'organs', 'мочевина крови — не анализ мочи');
  assert.equal(sectionOfResult({ name: 'Посев', group: 'Микробиология' }), 'other');

  const { storage } = await setup();
  const t = await storage.addTest({
    date: '2025-04-10', glucose: 90, psa: 1,
    customResults: [
      lab('Гематология', 'Лейкоциты', 5, 'x10³/mm³', '4.00–11.00', 4, 11),
      urine('pH мочи', { value: 5.5, ref: '5.00–7.80', refLow: 5, refHigh: 7.8 }),
      urine('Глюкоза (моча)', { text: 'отрицательно', unit: 'mg/dL' }),
      { group: 'Микробиология', name: 'Посев', text: 'не проводится' },
    ],
  });
  const secs = testSections(t);
  assert.deepEqual(secs.map((s) => s.title), ['Сахар и метаболизм', 'Гематология', 'Анализ мочи', 'Другие показатели']);
  const u = secs.find((s) => s.key === 'urine').rows;
  assert.deepEqual(u.map((r) => [r.name, r.value, r.text, r.out]), [['pH мочи', 5.5, '', ''], ['Глюкоза (моча)', null, 'отрицательно', '']]);
  assert.deepEqual(secs.find((s) => s.key === 'sugar').rows.map((r) => r.name), ['Глюкоза'], 'глюкоза мочи не попала к глюкозе крови');
  assert.equal(indicatorCount(t), 6);
  assert.equal(groupSummary(t), 'Гематология · Анализ мочи · Микробиология · Сахар и метаболизм');

  await storage.addTest({ date: '2025-10-01', customResults: [urine('Глюкоза (моча)', { text: 'норма' })] });
  const h = indicatorHistory(await storage.getTests(), customKey('Глюкоза (моча)'));
  assert.deepEqual(h.entries.map((e) => [e.date, e.value, e.text]), [['2025-10-01', null, 'норма'], ['2025-04-10', null, 'отрицательно']]);
  assert.deepEqual(h.points, [], 'текстовые результаты не попадают в график');
  /* текст игнорируется, если есть число */
  assert.equal(testSections({ date: '2025-01-01', customResults: [urine('X', { value: 1, text: 'y' })] })[0].rows[0].text, '');
});

/* ================= история показателя ================= */

test('история показателя: основные поля и показатели лаборатории, график — одна единица', async () => {
  const { storage } = await setup();
  await storage.addTest({ date: '2024-03-01', ldl: 140, labRanges: { ldl: '< 116' } });
  await storage.addTest({ date: '2025-03-01', ldl: 120 });
  await storage.addTest({ date: '2026-03-01', hgb: 14 });
  const h = indicatorHistory(await storage.getTests(), 'ldl');
  assert.equal(h.title, 'LDL холестерин');
  assert.deepEqual(h.entries.map((e) => [e.date, e.value, e.ref]), [['2025-03-01', 120, ''], ['2024-03-01', 140, '< 116']]);
  assert.deepEqual(h.points, [{ date: '2024-03-01', value: 140 }, { date: '2025-03-01', value: 120 }]);

  await storage.addTest({ date: '2025-01-01', customResults: [lab('Б', 'Ферритин', 80, 'ng/mL')] });
  await storage.addTest({ date: '2026-01-01', customResults: [lab('Б', ' ферритин ', 95, 'ng/mL')] });
  await storage.addTest({ date: '2026-02-01', customResults: [lab('Б', 'Ферритин', 200, 'pmol/L')] });
  const f = indicatorHistory(await storage.getTests(), customKey('Ферритин'));
  assert.equal(f.entries.length, 3, 'названия сравниваются без регистра и лишних пробелов');
  assert.equal(f.unit, 'pmol/L');
  assert.deepEqual(f.points, [{ date: '2026-02-01', value: 200 }], 'в графике — только значения единицы последнего');
  assert.equal(indicatorHistory(await storage.getTests(), customKey('Нет такого')).entries.length, 0);
});

/* ================= совместимость ================= */

test('ручное добавление и изменение: показатели лаборатории и документ сохраняются', async () => {
  const { storage, service } = await setup();
  const { entry } = parsePreparedTest(JSON.stringify({
    app: 'lexlife', kind: 'lexlife-prepared-test', formatVersion: 1, importId: 'synthetic-journal-01',
    test: { date: '2025-06-01', chol: 180, customResults: [{ group: 'Г', name: 'Лейкоциты', value: 5, unit: 'x10³/mm³', ref: '4.00–11.00' }] },
  }));
  const res = await importPreparedTest(storage, { entry, importId: 'synthetic-journal-01' });
  assert.equal(res.added, true);
  await service.attachToTest(res.entry.id, pdfFile('doc.pdf'));
  /* как форма «Изменить»: только основные поля, дата и заметка */
  await storage.updateTest(res.entry.id, { date: '2025-06-02', note: 'n', chol: undefined, ldl: 99 });
  const t = await storage.getTest(res.entry.id);
  assert.equal(t.customResults.length, 1);
  assert.equal(t.customResults[0].refLow, 4);
  assert.equal(attachmentOf(t).name, 'doc.pdf');
  assert.equal(t.chol, undefined);
  assert.equal(t.ldl, 99);
  assert.equal(t.importId, 'synthetic-journal-01');
});

test('9b. импорт JSON: новая запись встаёт по дате, повтор блокируется', async () => {
  const { storage } = await setup();
  const manual = await storage.addTest({ date: '2025-10-15', chol: 200 });
  const json = (importId, date) => JSON.stringify({ app: 'lexlife', kind: 'lexlife-prepared-test', formatVersion: 1, importId, test: { date, hgb: 14 } });
  const r1 = await importPreparedTest(storage, parsePreparedTest(json('synthetic-journal-02', '2026-02-14'), { today: new Date('2026-09-30') }));
  assert.deepEqual(ids(await storage.getTests()), [r1.entry.id, manual.id]);
  const again = await importPreparedTest(storage, parsePreparedTest(json('synthetic-journal-02', '2026-02-14'), { today: new Date('2026-09-30') }));
  assert.equal(again.added, false);
  const r2 = await importPreparedTest(storage, parsePreparedTest(json('synthetic-journal-03', '2026-02-14'), { today: new Date('2026-09-30') }));
  const items = flat(journal(await storage.getTests()));
  assert.deepEqual(items.map((i) => [i.test.id, i.no]), [[r2.entry.id, 2], [r1.entry.id, 1], [manual.id, 1]]);
});

test('9c. обычный backup/restore: порядок, записи одной даты и пользовательские показатели сохраняются', async () => {
  const src = await setup();
  const a = await src.storage.addTest({ date: '2026-02-14', chol: 190, customResults: [lab('Г', 'Лейкоциты', 5, 'x', '4–11', 4, 11)] });
  const b = await src.storage.addTest({ date: '2025-05-03' }); // старая запись без показателей и документа
  const c = await src.storage.addTest({ date: '2026-02-14', hgb: 15 });
  const before = flat(journal(await src.storage.getTests())).map((i) => [i.test.id, i.no]);
  const backup = await src.storage.createBackup();
  const dst = await setup();
  await dst.storage.restoreBackup(await dst.storage.prepareRestore(parseBackup(backup.json)));
  const after = await dst.storage.getTests();
  assert.deepEqual(flat(journal(after)).map((i) => [i.test.id, i.no]), before);
  assert.deepEqual(before, [[c.id, 2], [a.id, 1], [b.id, 1]]);
  assert.deepEqual(after.find((t) => t.id === a.id).customResults, (await src.storage.getTest(a.id)).customResults);
});

test('9d. полный ZIP backup/restore: документы остаются у своих записей', async () => {
  const src = await setup();
  const a = await src.storage.addTest({ date: '2026-02-14', chol: 190 });
  const b = await src.storage.addTest({ date: '2026-02-14', hgb: 15 });
  const c = await src.storage.addTest({ date: '2025-01-01', tsh: 2 });
  await src.service.attachToTest(a.id, pdfFile('first.pdf', 3));
  await src.service.attachToTest(b.id, pdfFile('second.pdf', 1));
  const full = await createFullBackup(src.storage, src.store);
  const dst = await setup();
  await applyFullRestore(dst.storage, dst.service, await prepareFullRestore(dst.storage, full.blob));
  const list = await dst.storage.getTests();
  assert.deepEqual(ids(list), [b.id, a.id, c.id]);
  for (const [id, name] of [[a.id, 'first.pdf'], [b.id, 'second.pdf']]) {
    const meta = attachmentOf(list.find((t) => t.id === id));
    assert.equal(meta.name, name);
    const file = await dst.service.getFile(meta);
    assert.equal(file.type, 'application/pdf');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(await (await src.service.getFile(attachmentOf(await src.storage.getTest(id)))).arrayBuffer()));
  }
  assert.equal(attachmentOf(list.find((t) => t.id === c.id)), null);
});

/* ================= «Документ анализа» ================= */

function fakeUrlApi() {
  let n = 0;
  const live = new Set();
  return {
    live,
    created: () => n,
    createObjectURL: () => { const u = `blob:fake/${++n}`; live.add(u); return u; },
    revokeObjectURL: (u) => { live.delete(u); },
  };
}

test('8. DocSession: Blob URL живёт до закрытия и освобождается при закрытии (без утечек)', () => {
  const api = fakeUrlApi();
  const s = new DocSession(api);
  const u1 = s.url(new Blob(['a']));
  const u2 = s.url(new Blob(['b']));
  assert.equal(api.live.size, 2);
  assert.ok(api.live.has(u1) && api.live.has(u2), 'URL не освобождается раньше закрытия');
  const order = [];
  s.onClose(() => order.push('первый'));
  s.onClose(() => { order.push('второй'); throw new Error('сбой очистки'); });
  assert.equal(s.close(), true);
  assert.deepEqual(order, ['второй', 'первый'], 'очистка в обратном порядке, сбой не прерывает остальные');
  assert.equal(api.live.size, 0, 'все Blob URL освобождены');
  assert.equal(s.close(), false, 'повторное закрытие — без эффекта');
  assert.throws(() => s.url(new Blob(['c'])), /closed/);
  let late = false;
  s.onClose(() => { late = true; });
  assert.equal(late, true, 'очистка, добавленная после закрытия, выполняется сразу');
});

test('масштаб PDF и размер canvas', () => {
  assert.equal(stepZoom(1, 1), 1.5);
  assert.equal(stepZoom(1.5, 1), 2);
  assert.equal(stepZoom(4, 1), 4);
  assert.equal(stepZoom(1, -1), 1);
  assert.equal(stepZoom(2.4, -1), 2);
  assert.equal(clampZoom(0.3), 1);
  assert.equal(clampZoom(9), 4);
  assert.equal(canvasScale(360, 509, 3), 2, 'DPR ограничен 2');
  const s = canvasScale(1440, 2036, 2);
  assert.ok(1440 * 2036 * s * s <= 5_000_000 + 1, 'большая страница — не больше ~5 Мпикс');
});

test('6. многостраничный PDF: локальный pdf.js читает все страницы', async () => {
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    const lib = await import('../js/vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = new URL('../js/vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
    const task = lib.getDocument({ data: makeTestPdf(5), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const pdf = await task.promise;
    assert.equal(pdf.numPages, 5);
    for (let i = 1; i <= 5; i++) {
      const page = await pdf.getPage(i);
      const text = (await page.getTextContent()).items.map((it) => it.str).join(' ');
      assert.match(text, new RegExp(`Synthetic page ${i} of 5`));
      assert.equal(Math.round(page.getViewport({ scale: 1 }).width), 595);
    }
    await pdf.destroy();
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }
});

/* ---------- запуск ---------- */
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`✓ ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${t.name}\n  ${err && err.stack}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
