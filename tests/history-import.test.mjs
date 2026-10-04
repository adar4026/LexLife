/* =========================================================
   tests/history-import.test.mjs — импорт медицинской истории
   (js/services/historyImport.js + StorageService.addImportedHistory).
   Без браузера (MemoryDriver). Только синтетические данные — никаких реальных
   медицинских записей, имён врачей или дат пользователя.
   run-all запускает файл в нескольких timezone: даты — локальные строки, без UTC-сдвига.

   Запуск:  node tests/history-import.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup } from '../js/services/storage.js';
import {
  parseMedicalHistory, buildHistoryImportPlan, buildHistoryRecords, applyHistoryImportPlan,
  HistoryImportError, recordIdFor, norm, isRealDate,
} from '../js/services/historyImport.js';
import { visitTitle, visitSub, visitIcon, visitTime, visitStatusChip } from '../js/services/visitKinds.js';
import { nextDose, medStatusOn, isMedDueOn, intakeSummary, nextDueDay, endedCourseWord } from '../js/services/meds.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TODAY = new Date(2026, 1, 20, 12, 0); // 2026-02-20, локально

async function fresh() {
  const s = new StorageService(new MemoryDriver());
  await s.init();
  return s;
}

/* Синтетический пакет: визит, стоматология (зуб 11), сдача анализов, заболевание, два курса */
function pkg(over = {}) {
  return {
    app: 'lexlife', kind: 'lexlife-medical-history', formatVersion: 1, packageId: 'synthetic-pkg-1',
    meds: [
      { importId: 'syn:med:2025-11-02:alpha', name: 'Alphazol', aliases: ['Альфазол'], start: '2025-11-02', end: '2025-12-01', note: 'синтетика' },
      { importId: 'syn:med:2026-01-05:beta', name: 'Betamin', start: '2026-01-05', every_days: 10, end: '2026-02-04', courseStatus: 'stopped' },
    ],
    events: [
      { importId: 'syn:2026-01-10:therapist', date: '2026-01-10', time: '09:15', kind: 'visit', title: 'Консультация', doctor: 'Dr. Test Doctor', specialty: 'Терапевт', conclusion: 'Без отклонений.', medRefs: ['syn:med:2026-01-05:beta'], match: { keywords: ['терапевт', 'test doctor'] } },
      { importId: 'syn:2026-01-10:dental-11', date: '2026-01-10', kind: 'dental', title: 'Лечение зуба 11', specialty: 'Стоматология', match: { keywords: ['11', 'стомат'] } },
      { importId: 'syn:2026-01-12:lab', date: '2026-01-12', kind: 'lab', title: 'Сдача анализов', conclusion: 'Сдана кровь.' },
      { importId: 'syn:2025-11-01:illness', date: '2025-11-01', kind: 'illness', title: 'Простуда', conclusion: 'Принимал: «как записано»; сироп X.', medRefs: ['syn:med:2025-11-02:alpha'] },
    ],
    ...over,
  };
}
const parse = (o = pkg()) => parseMedicalHistory(JSON.stringify(o), { today: TODAY });
const errorsOf = (o) => { try { parse(o); } catch (e) { assert.ok(e instanceof HistoryImportError); return e.errors.join('\n') || e.message; } assert.fail('файл должен быть отклонён'); };

/* ================= разбор и валидация ================= */

test('разбор: корректный пакет, даты остаются строками как в файле', () => {
  const p = parse();
  assert.equal(p.events.length, 4);
  assert.equal(p.meds.length, 2);
  assert.equal(p.events[0].date, '2026-01-10');
  assert.equal(p.events[0].time, '09:15');
  assert.deepEqual(p.meds[0].aliases, ['alphazol', 'альфазол']);
  assert.ok(isRealDate('2024-02-29') && !isRealDate('2025-02-29') && !isRealDate('2026-04-31'));
});

test('валидация: результаты анализов, неизвестные поля и виды отклоняются целиком', () => {
  const o = pkg();
  o.events[2] = { ...o.events[2], customResults: [{ name: 'LDL', value: 1 }] };
  assert.match(errorsOf(o), /неизвестные поля customResults/);
  const k = pkg(); k.events[0].kind = 'party';
  assert.match(errorsOf(k), /неизвестный вид/);
  assert.match(errorsOf({ ...pkg(), extra: 1 }), /Неизвестные поля файла/);
});

test('валидация: даты — реальные, не в будущем; время ЧЧ:ММ; importId уникален; medRefs существуют', () => {
  const a = pkg(); a.events[0].date = '2026-02-30';
  assert.match(errorsOf(a), /некорректная дата/);
  const b = pkg(); b.events[0].date = '2026-02-21';
  assert.match(errorsOf(b), /в будущем/);
  const c = pkg(); c.events[0].time = '9:15';
  assert.match(errorsOf(c), /время/);
  const d = pkg(); d.events[1].importId = d.events[0].importId;
  assert.match(errorsOf(d), /повторяется/);
  const e = pkg(); e.events[0].medRefs = ['syn:med:none:x1'];
  assert.match(errorsOf(e), /нет лекарства/);
  const f = pkg(); f.meds[0].end = '2025-10-01';
  assert.match(errorsOf(f), /окончание раньше начала/);
  const g = pkg(); g.events[0].title = '';
  assert.match(errorsOf(g), /title/);
});

test('валидация: резервная копия и чужие файлы не принимаются', () => {
  assert.throws(() => parseMedicalHistory(JSON.stringify({ app: 'lexlife', backupFormatVersion: 2, data: {} })), /резервная копия/);
  assert.throws(() => parseMedicalHistory('{"app":"lexlife","kind":"lexlife-prepared-test"}'), /не является/);
  assert.throws(() => parseMedicalHistory('{ broken'), /не корректный JSON/);
  assert.throws(() => parseMedicalHistory(JSON.stringify({ ...pkg(), formatVersion: 2 }), { today: TODAY }), /более новой версии/);
});

test('курсы: только с датой окончания; статус курса — из списка; «Начало приёма» без окончания — событие', () => {
  const a = pkg(); delete a.meds[0].end;
  assert.match(errorsOf(a), /нет даты окончания/);
  const b = pkg(); b.meds[0].courseStatus = 'maybe';
  assert.match(errorsOf(b), /courseStatus/);
  const c = pkg(); c.events.push({ importId: 'syn:2026-01-20:medstart', date: '2026-01-20', kind: 'medication', title: 'Начало приёма: Gammavit', conclusion: 'Дата окончания не указана.' });
  const p = parse(c);
  assert.equal(p.events[4].kind, 'medication');
  assert.equal(p.meds[0].courseStatus, 'completed', 'по умолчанию — завершён');
  assert.equal(p.meds[1].courseStatus, 'stopped');
});

/* ================= dry-run ================= */

test('dry-run на пустой базе: всё к добавлению, ничего не пишет', async () => {
  const s = await fresh();
  const before = JSON.stringify([...s.driver.map.entries()]);
  const plan = buildHistoryImportPlan(parse(), { visits: await s.getVisits(), meds: await s.getMeds({ includeDeleted: true }), tests: await s.getTests() });
  assert.deepEqual(plan.counts, { add: 6, imported: 0, duplicate: 0, conflict: 0 });
  assert.equal(JSON.stringify([...s.driver.map.entries()]), before);
});

test('дубли: анализ той же даты в «Анализах», визит той же даты по врачу/зубу, курс по препарату + дате начала', () => {
  const existing = {
    tests: [{ id: 't1', date: '2026-01-12', chol: 1 }],
    visits: [
      { id: 'v1', date: '2026-01-10', doctor: 'Test Doctor', specialty: 'Терапевт' },
      { id: 'v2', date: '2026-01-10', doctor: 'Другой', specialty: 'Стоматолог', reason: 'зуб 11 — пломба' },
    ],
    meds: [{ id: 'm1', name: 'альфазол 20 мг', start: '2025-11-02' }],
  };
  const plan = buildHistoryImportPlan(parse(), existing);
  const st = Object.fromEntries([...plan.events, ...plan.meds].map((p) => [p.item.importId, p.status]));
  assert.equal(st['syn:2026-01-12:lab'], 'duplicate');
  assert.equal(st['syn:2026-01-10:therapist'], 'duplicate');
  assert.equal(st['syn:2026-01-10:dental-11'], 'duplicate');
  assert.equal(st['syn:med:2025-11-02:alpha'], 'duplicate');
  assert.equal(st['syn:2025-11-01:illness'], 'add');
  assert.equal(st['syn:med:2026-01-05:beta'], 'add');
});

test('не дубль: та же процедура в другой день; номер зуба совпадает только целиком', () => {
  const plan = buildHistoryImportPlan(parse(), {
    tests: [{ id: 't1', date: '2026-01-13' }],
    visits: [{ id: 'v1', date: '2026-01-11', specialty: 'Терапевт' }, { id: 'v2', date: '2026-01-10', reason: 'код 110, кабинет 211' }],
    meds: [],
  });
  assert.equal(plan.counts.duplicate, 0);
  assert.match(plan.events.find((p) => p.item.importId === 'syn:2026-01-10:dental-11').reason, /другая запись/);
});

test('курс: тот же препарат без даты начала или с пересечением периодов — «требует уточнения», без пересечения — новый', () => {
  const noStart = buildHistoryImportPlan(parse(), { visits: [], tests: [], meds: [{ id: 'm1', name: 'Betamin' }] });
  assert.equal(noStart.meds[1].status, 'conflict');
  const overlap = buildHistoryImportPlan(parse(), { visits: [], tests: [], meds: [{ id: 'm1', name: 'Betamin', start: '2026-01-20' }] });
  assert.equal(overlap.meds[1].status, 'conflict');
  const other = buildHistoryImportPlan(parse(), { visits: [], tests: [], meds: [{ id: 'm1', name: 'Betamin', start: '2025-03-01', end: '2025-04-01' }] });
  assert.equal(other.meds[1].status, 'add');
  /* конфликтный курс не импортируется, и визит на него не ссылается */
  const rec = buildHistoryRecords(noStart);
  assert.ok(!rec.meds.some((m) => m.name === 'Betamin'));
  assert.deepEqual(rec.visits.find((v) => v.title === 'Консультация').links.medIds, []);
});

/* ================= применение ================= */

test('импорт: только добавление, существующие записи не меняются; повтор — 0 новых', async () => {
  const s = await fresh();
  const mine = await s.addVisit({ date: '2026-02-01', doctor: 'Свой врач', specialty: 'Терапевт' });
  await s.addMed({ name: 'Своё', start: '2026-02-01' });
  const snap = async () => ({ visits: JSON.stringify((await s.getVisits()).filter((v) => !v.importId)), meds: JSON.stringify((await s.getMeds()).filter((m) => !m.importId)), other: JSON.stringify(await s.getTests()) });
  const before = await snap();
  const read = async () => ({ visits: await s.getVisits(), meds: await s.getMeds({ includeDeleted: true }), tests: await s.getTests() });

  const plan = buildHistoryImportPlan(parse(), await read());
  const res = await applyHistoryImportPlan(s, plan, { now: TODAY });
  assert.equal(res.medsAdded, 2);
  assert.equal(res.visitsAdded, 4);
  assert.deepEqual(res.before, { meds: 1, visits: 1 });
  assert.deepEqual(res.after, { meds: 3, visits: 5 });
  assert.deepEqual(await snap(), before);
  assert.ok(await s.getVisit(mine.id));

  const again = buildHistoryImportPlan(parse(), await read());
  assert.deepEqual(again.counts, { add: 0, imported: 6, duplicate: 0, conflict: 0 });
  const r2 = await applyHistoryImportPlan(s, again);
  assert.deepEqual([r2.medsAdded, r2.visitsAdded], [0, 0]);
  /* даже повторная запись тех же готовых записей мимо плана — не дублирует */
  const r3 = await s.addImportedHistory(buildHistoryRecords(plan));
  assert.deepEqual([r3.medsAdded, r3.visitsAdded], [0, 0]);
  assert.deepEqual(r3.before, r3.after);
  assert.equal((await s.getVisits()).length, 5);
  assert.equal((await s.getMeds()).length, 3);
});

test('импорт — только слияние: сбой записи визитов убирает лишь добавленные курсы, прежние записи целы', async () => {
  const s = await fresh();
  await s.addVisit({ date: '2026-02-01', doctor: 'Свой врач' });
  await s.addMed({ name: 'Своё', start: '2026-02-01' });
  /* старая запись без id (ранние версии) тоже должна уцелеть */
  const meds0 = [...await s.getMeds({ includeDeleted: true }), { name: 'Без id', start: '2025-01-01' }];
  await s._write('health_meds', meds0);
  const before = { v: s.driver.map.get('health_visits'), m: s.driver.map.get('health_meds') };
  const set = s.driver.set.bind(s.driver);
  s.driver.set = (k, v) => { if (k === 'health_visits') throw new Error('quota'); return set(k, v); };
  const plan = buildHistoryImportPlan(parse(), { visits: await s.getVisits(), meds: meds0, tests: [] });
  await assert.rejects(applyHistoryImportPlan(s, plan), /Импорт не выполнен/);
  s.driver.set = set;
  assert.equal(s.driver.map.get('health_visits'), before.v);
  assert.equal(s.driver.map.get('health_meds'), before.m);
});

test('импорт: поля визита и курса, связи, локальные даты без сдвига', async () => {
  const s = await fresh();
  await applyHistoryImportPlan(s, buildHistoryImportPlan(parse(), { visits: [], meds: [], tests: [] }), { now: TODAY });
  const v = await s.getVisit(recordIdFor('syn:2026-01-10:therapist'));
  assert.equal(v.date, '2026-01-10');
  assert.equal(v.time, '09:15');
  assert.equal(v.kind, 'visit');
  assert.equal(v.status, 'done');
  assert.equal(v.source, 'medical-history');
  assert.deepEqual(v.links.medIds, [recordIdFor('syn:med:2026-01-05:beta')]);
  const m = await s.getMed(recordIdFor('syn:med:2026-01-05:beta'));
  assert.equal(m.start, '2026-01-05');
  assert.equal(m.end, '2026-02-04');
  assert.equal(m.every_days, 10);
  assert.equal(m.courseStatus, 'stopped');
  assert.deepEqual(await s.getMedIntakes('2026-01-05'), [], 'приёмы доз не создаются');
  /* связь с курсом, который уже был в LexLife (дубль) — на существующую запись */
  const s2 = await fresh();
  const own = await s2.addMed({ name: 'Betamin', start: '2026-01-05' });
  await applyHistoryImportPlan(s2, buildHistoryImportPlan(parse(), { visits: [], meds: await s2.getMeds({ includeDeleted: true }), tests: [] }));
  assert.deepEqual((await s2.getVisit(recordIdFor('syn:2026-01-10:therapist'))).links.medIds, [own.id]);
});

test('удалённый вами импортированный курс не возвращается при повторном импорте', async () => {
  const s = await fresh();
  const read = async () => ({ visits: await s.getVisits(), meds: await s.getMeds({ includeDeleted: true }), tests: await s.getTests() });
  await applyHistoryImportPlan(s, buildHistoryImportPlan(parse(), await read()));
  await s.removeMed(recordIdFor('syn:med:2025-11-02:alpha'));
  const plan = buildHistoryImportPlan(parse(), await read());
  assert.equal(plan.meds[0].status, 'imported');
  assert.match(plan.meds[0].reason, /удалено вами/);
});

test('резервная копия: импортированные записи и их поля проходят создание → проверку → восстановление', async () => {
  const a = await fresh();
  await applyHistoryImportPlan(a, buildHistoryImportPlan(parse(), { visits: [], meds: [], tests: [] }), { now: TODAY });
  const { json, verified } = await a.createBackup();
  assert.ok(verified);
  const b = await fresh();
  await b.restoreBackup(await b.prepareRestore(parseBackup(json)));
  assert.deepEqual(await b.getVisits(), await a.getVisits());
  assert.deepEqual(await b.getMeds({ includeDeleted: true }), await a.getMeds({ includeDeleted: true }));
});

test('форма визита: название сохраняется, правка не теряет вид и метку импорта', async () => {
  const s = await fresh();
  const v = await s.addVisit({ date: '2026-02-01', title: 'УЗИ', doctor: '', kind: 'imaging' });
  assert.equal(v.title, 'УЗИ');
  assert.equal(v.kind, 'imaging');
  const plain = await s.addVisit({ date: '2026-02-01', doctor: 'Dr. Plain' });
  assert.ok(!('kind' in plain) && !('title' in plain), 'обычный визит — без лишних полей');
  await applyHistoryImportPlan(s, buildHistoryImportPlan(parse(), { visits: [], meds: [], tests: [] }));
  const id = recordIdFor('syn:2026-01-10:dental-11');
  await s.updateVisit(id, { title: 'Лечение зуба 11 (правка)', doctor: 'Dr. X' });
  const after = await s.getVisit(id);
  assert.equal(after.kind, 'dental');
  assert.equal(after.importId, 'syn:2026-01-10:dental-11');
});

/* ================= отображение и расписание ================= */

test('подпись визита: название события → врач → «Визит»', () => {
  assert.equal(visitTitle({ doctor: 'Dr. A', specialty: 'Кардиолог' }), 'Dr. A');
  assert.equal(visitSub({ doctor: 'Dr. A', specialty: 'Кардиолог', clinic: 'К1' }), 'Кардиолог · К1');
  assert.equal(visitTitle({ title: 'УЗИ', doctor: 'Dr. A' }), 'УЗИ');
  assert.equal(visitSub({ title: 'УЗИ', doctor: 'Dr. A', clinic: 'К1' }), 'Dr. A · К1');
  assert.equal(visitTitle({}), 'Визит');
  assert.equal(visitIcon({ kind: 'dental' }), '🦷');
  assert.equal(visitIcon({ kind: 'unknown' }), '🩺');
  assert.equal(visitTime({ time: '25:00' }), null);
});

test('завершённый курс: не в плане дня, следующая доза курса «раз в N дней» не позже окончания', () => {
  const m = { id: 'x', name: 'Betamin', active: true, start: '2026-01-05', end: '2026-02-04', every_days: 10 };
  assert.equal(nextDose(m, '2026-01-06'), '2026-01-15');
  assert.equal(nextDose(m, '2026-02-04'), '2026-02-04'); // последняя доза — в день окончания
  assert.equal(nextDose(m, '2026-02-05'), null); // следующая была бы 2026-02-14
  assert.equal(nextDose({ ...m, end: null }, '2026-02-05'), '2026-02-14');
  assert.equal(medStatusOn(m, '2026-02-20'), 'ended');
  assert.equal(isMedDueOn(m, '2026-02-20'), false);
  assert.deepEqual(intakeSummary([m], '2026-02-20'), { due: 0, taken: 0 });
});

test('прекращённый курс: после окончания не активен, не в «принято сегодня», без следующих приёмов; подпись статуса', () => {
  const m = { id: 'a', name: 'Synthstatin', active: true, start: '2026-06-17', end: '2026-07-21', courseStatus: 'stopped', schedule: { mode: 'daily', days: [], times: [] } };
  assert.equal(isMedDueOn(m, '2026-07-21'), true);
  assert.equal(medStatusOn(m, '2026-07-22'), 'ended');
  assert.deepEqual(intakeSummary([m], '2026-10-04'), { due: 0, taken: 0 });
  assert.equal(nextDueDay(m, '2026-07-21'), null);
  assert.equal(endedCourseWord(m), 'прекращён');
  assert.equal(endedCourseWord({ courseStatus: 'prescribed' }), 'назначенный курс, приём не отмечался');
  assert.equal(endedCourseWord({}), 'завершён');
});

test('отметка статуса: «запись к врачу» не превращается в состоявшийся визит', () => {
  assert.deepEqual(visitStatusChip({ status: 'done' }), { cls: 'done', text: 'выполнен' });
  assert.deepEqual(visitStatusChip({ status: 'done', kind: 'appointment' }), { cls: 'planned', text: 'запись к врачу' });
  assert.equal(visitStatusChip({ status: 'done', kind: 'illness' }), null);
  assert.equal(visitStatusChip({ status: 'done', kind: 'medication' }), null);
  assert.deepEqual(visitStatusChip({ status: 'planned', kind: 'visit' }), { cls: 'planned', text: 'запланирован' });
});

test('нормализация имён: регистр, диакритика, ё', () => {
  assert.equal(norm('Ergometría / Prueba'), 'ergometria prueba');
  assert.equal(norm('Ёлка'), 'елка');
});

/* ---------- запуск ---------- */
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ FAIL ${t.name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
  }
}
console.log(`${tests.length - failed} passed, ${failed} failed (${tests.length} total) TZ=${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone}`);
process.exit(failed ? 1 : 0);
