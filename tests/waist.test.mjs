/* =========================================================
   tests/waist.test.mjs — «Обхват талии» (js/services/waist.js + StorageService + провайдер журнала):
   добавление, редактирование, перенос, удаление, запись за прошлую дату, сортировка, одна запись,
   пустое состояние, изменение за период, периоды НЕД / МЕС / 6 МЕС / ГОД, защита от дублей
   на одну дату, резервная копия (новая и старая), сохранность прежних данных.
   Без браузера: StorageService на MemoryDriver. Только синтетические данные.
   run-all запускает файл в нескольких timezone.

   Запуск:  node tests/waist.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, BackupError, EntryStoreError, METRIC_KEYS } from '../js/services/storage.js';
import {
  normalizeWaistInput, parseWaist, isValidWaistLog, waistPoints, waistHistory, latestWaist, waistChange, waistPeriod,
  fmtCm, fmtWaist, fmtWaistChange, WAIST_PERIOD_KINDS, WAIST_MIN, WAIST_MAX,
} from '../js/services/waist.js';
import { buildJournal, groupJournal, journalType } from '../js/services/journals.js';

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = (s) => String(s).replace(/[  ]/g, ' ');

const TODAY = '2026-10-05'; // понедельник
async function fresh() {
  const s = new StorageService(new MemoryDriver());
  await s.init();
  return s;
}
const w = (date, value) => normalizeWaistInput({ date, value }, { today: TODAY }).value;
const LOG = {
  '2026-09-28': { cm: 95, createdAt: 'a', updatedAt: 'a' },
  '2026-10-01': { cm: 94.5, createdAt: 'a', updatedAt: 'a' },
  '2026-10-03': { cm: 93.4, createdAt: 'a', updatedAt: 'a' },
  '2026-10-05': { cm: 93, createdAt: 'a', updatedAt: 'a' },
  '2026-06-15': { cm: 97, createdAt: 'a', updatedAt: 'a' },
  '2025-12-20': { cm: 99, createdAt: 'a', updatedAt: 'a' },
  '2025-10-10': { cm: 101, createdAt: 'a', updatedAt: 'a' },
};

test('1. добавление: измерение сохраняется на выбранную дату, createdAt / updatedAt проставлены', async () => {
  const s = await fresh();
  const r = await s.saveWaist(w(TODAY, '93'));
  assert.equal(r.date, TODAY);
  const log = await s.getWaistLog();
  assert.deepEqual(Object.keys(log), [TODAY]);
  assert.equal(log[TODAY].cm, 93);
  assert.ok(log[TODAY].createdAt && log[TODAY].updatedAt);
  assert.ok(isValidWaistLog(log));
});

test('2. десятичные значения: «92,5», «92.5», «92,5 см» → 92,5; округление до 0,1', () => {
  assert.equal(parseWaist('92,5'), 92.5);
  assert.equal(parseWaist('92.5'), 92.5);
  assert.equal(parseWaist('92,5 см'), 92.5);
  assert.equal(parseWaist(''), null);
  assert.ok(Number.isNaN(parseWaist('девяносто')));
  assert.equal(w(TODAY, '92,46').cm, 92.5);
  assert.equal(fmtCm(92.5), '92,5');
  assert.equal(plain(fmtWaist(92.5)), '92,5 см');
  assert.equal(plain(fmtWaist(93)), '93 см');
});

test('3. проверка ввода: пусто, мусор, вне 30–250 см, будущая дата, несуществующая дата', () => {
  const bad = (date, value) => normalizeWaistInput({ date, value }, { today: TODAY });
  assert.ok(bad(TODAY, '').errors.value);
  assert.ok(bad(TODAY, 'abc').errors.value);
  assert.ok(bad(TODAY, String(WAIST_MIN - 1)).errors.value);
  assert.ok(bad(TODAY, String(WAIST_MAX + 1)).errors.value);
  assert.ok(bad('2026-10-06', '90').errors.date, 'будущее');
  assert.ok(bad('2026-02-31', '90').errors.date, '31 февраля');
  assert.ok(bad(TODAY, '0').errors.value, '0 см не сохраняется');
  assert.equal(bad(TODAY, '30').ok, true);
  assert.equal(bad(TODAY, '250').ok, true);
});

test('4. редактирование: значение меняется, createdAt остаётся, запись одна', async () => {
  const s = await fresh();
  await s.saveWaist(w(TODAY, '93'));
  const created = (await s.getWaistLog())[TODAY].createdAt;
  await new Promise((r) => setTimeout(r, 5));
  await s.saveWaist(w(TODAY, '92,5'), { from: TODAY });
  const log = await s.getWaistLog();
  assert.deepEqual(Object.keys(log), [TODAY]);
  assert.equal(log[TODAY].cm, 92.5);
  assert.equal(log[TODAY].createdAt, created);
  assert.ok(log[TODAY].updatedAt >= created);
});

test('5. изменение даты: перенос одной записью; на занятую дату — только с подтверждением', async () => {
  const s = await fresh();
  await s.saveWaist(w('2026-10-01', '94'));
  await s.saveWaist(w('2026-10-03', '93'));
  await s.saveWaist(w('2026-09-20', '94'), { from: '2026-10-01' });
  assert.deepEqual(Object.keys(await s.getWaistLog()).sort(), ['2026-09-20', '2026-10-03']);
  await assert.rejects(s.saveWaist(w('2026-10-03', '94'), { from: '2026-09-20' }), (e) => e instanceof EntryStoreError && e.code === 'DUPLICATE_DATE' && e.existing.cm === 93);
  assert.deepEqual(Object.keys(await s.getWaistLog()).sort(), ['2026-09-20', '2026-10-03'], 'без подтверждения ничего не изменилось');
  await s.saveWaist(w('2026-10-03', '94'), { from: '2026-09-20', overwrite: true });
  const log = await s.getWaistLog();
  assert.deepEqual(Object.keys(log), ['2026-10-03']);
  assert.equal(log['2026-10-03'].cm, 94);
});

test('6. удаление: удаляется только измерение этого дня; повторное удаление → null', async () => {
  const s = await fresh();
  await s.saveWaist(w('2026-10-01', '94'));
  await s.saveWaist(w(TODAY, '93'));
  const rec = await s.removeWaist('2026-10-01');
  assert.equal(rec.cm, 94);
  assert.deepEqual(Object.keys(await s.getWaistLog()), [TODAY]);
  assert.equal(await s.removeWaist('2026-10-01'), null);
});

test('7. запись за прошлую дату (другой месяц и год) сохраняется на эту дату', async () => {
  const s = await fresh();
  await s.saveWaist(w('2024-02-29', '101,2'));
  const log = await s.getWaistLog();
  assert.equal(log['2024-02-29'].cm, 101.2);
  assert.deepEqual(latestWaist(log, TODAY), { date: '2024-02-29', cm: 101.2 });
});

test('8. защита от дублей: повторное добавление той же даты → DUPLICATE_DATE; замена — всё равно одна запись', async () => {
  const s = await fresh();
  await s.saveWaist(w(TODAY, '93'));
  await assert.rejects(s.saveWaist(w(TODAY, '92')), (e) => e instanceof EntryStoreError && e.code === 'DUPLICATE_DATE' && e.existing.date === TODAY);
  assert.equal((await s.getWaistLog())[TODAY].cm, 93);
  await s.saveWaist(w(TODAY, '92'), { overwrite: true });
  const log = await s.getWaistLog();
  assert.equal(Object.keys(log).length, 1);
  assert.equal(log[TODAY].cm, 92);
  /* правка уже удалённого измерения — NOT_FOUND, данные не меняются */
  await assert.rejects(s.saveWaist(w(TODAY, '91'), { from: '2026-01-01' }), (e) => e.code === 'NOT_FOUND');
});

test('9. сортировка: график — по возрастанию даты, журнал — новые сверху', async () => {
  assert.deepEqual(waistPoints(LOG).map((p) => p.date), ['2025-10-10', '2025-12-20', '2026-06-15', '2026-09-28', '2026-10-01', '2026-10-03', '2026-10-05']);
  assert.deepEqual(waistHistory(LOG).map((p) => p.date).slice(0, 3), ['2026-10-05', '2026-10-03', '2026-10-01']);
  const items = buildJournal({ waist: LOG }, {}, [journalType('waist')]);
  const groups = groupJournal(items, { today: TODAY });
  assert.deepEqual(groups.map((g) => g.date).slice(0, 3), ['2026-10-05', '2026-10-03', '2026-10-01']);
  assert.equal(groups[0].label, 'Сегодня');
  assert.equal(plain(groups[0].items[0].value), '93 см');
  assert.equal(groups[0].items[0].title, 'Обхват талии');
  assert.equal(plain(groups[0].summary), '93 см');
});

test('10. одна запись: последнее есть, изменения нет («—»), график из одной точки', () => {
  const one = { '2026-10-02': { cm: 92.5 } };
  const p = waistPeriod(one, 'month', 0, TODAY);
  assert.equal(p.points.length, 1);
  assert.deepEqual(p.last, { date: '2026-10-02', cm: 92.5 });
  assert.equal(p.first, p.last);
  assert.equal(p.change, null);
  assert.equal(fmtWaistChange(p.change), '—');
});

test('11. пустое состояние: нет последнего, нет точек, нигде нет «0 см»', () => {
  assert.equal(latestWaist({}, TODAY), null);
  for (const k of WAIST_PERIOD_KINDS) {
    const p = waistPeriod({}, k, 0, TODAY);
    assert.deepEqual(p.points, []);
    assert.equal(p.last, null);
    assert.equal(p.change, null);
  }
  assert.equal(fmtWaist(null), '—');
  assert.equal(fmtWaist(undefined), '—');
  assert.equal(fmtWaistChange(null), '—');
  assert.deepEqual(buildJournal({ waist: {} }, {}, [journalType('waist')]), []);
  assert.equal(journalType('waist').emptyText, 'Пока нет измерений');
});

test('12. динамика: изменение = последнее − первое измерение периода, без среднего', () => {
  const p = waistPeriod(LOG, 'month', 0, TODAY); // октябрь: 94,5 → 93,4 → 93
  assert.deepEqual(p.points.map((x) => x.cm), [94.5, 93.4, 93]);
  assert.equal(p.change, -1.5);
  assert.equal(plain(fmtWaistChange(p.change)), '−1,5 см');
  assert.equal(waistChange([{ cm: 95 }, { cm: 93 }]), -2);
  assert.equal(plain(fmtWaistChange(-2)), '−2 см');
  assert.equal(plain(fmtWaistChange(1.5)), '+1,5 см');
  assert.equal(plain(fmtWaistChange(0)), '0 см');
  assert.equal(waistChange([{ cm: 93.3 }, { cm: 93.1 }]), -0.2, 'без двоичной погрешности');
  assert.ok(!('average' in p), 'среднее не считается');
});

test('13. периоды НЕД / МЕС / 6 МЕС / ГОД: календарные окна, будущее исключено, ‹ › по целым периодам', () => {
  const week = waistPeriod(LOG, 'week', 0, TODAY);
  assert.equal(week.win.start, '2026-10-05');
  assert.equal(week.win.effEnd, TODAY);
  assert.deepEqual(week.points.map((x) => x.date), ['2026-10-05']);
  assert.equal(week.change, null);
  const prevWeek = waistPeriod(LOG, 'week', -1, TODAY);
  assert.equal(prevWeek.win.start, '2026-09-28');
  assert.equal(prevWeek.win.end, '2026-10-04');
  assert.deepEqual(prevWeek.points.map((x) => x.cm), [95, 94.5, 93.4]);
  assert.equal(prevWeek.change, -1.6);
  const month = waistPeriod(LOG, 'month', 0, TODAY);
  assert.equal(month.win.start, '2026-10-01');
  const six = waistPeriod(LOG, '6m', 0, TODAY);
  assert.equal(six.win.start, '2026-05-01');
  assert.deepEqual(six.points.map((x) => x.cm), [97, 95, 94.5, 93.4, 93]);
  assert.equal(six.change, -4);
  const year = waistPeriod(LOG, 'year', 0, TODAY);
  assert.equal(year.win.start, '2025-11-01');
  assert.deepEqual(year.points.map((x) => x.date)[0], '2025-12-20', 'октябрь 2025 — уже вне 12 месяцев');
  assert.equal(year.change, -6);
  const prevYear = waistPeriod(LOG, 'year', -1, TODAY);
  assert.deepEqual(prevYear.points.map((x) => x.date), ['2025-10-10']);
  /* будущие записи (не из формы — например, сдвиг часов) в период не попадают */
  const future = waistPeriod({ ...LOG, '2026-10-07': { cm: 80 } }, 'week', 0, TODAY);
  assert.deepEqual(future.points.map((x) => x.date), ['2026-10-05']);
  assert.equal(latestWaist({ ...LOG, '2026-10-07': { cm: 80 } }, TODAY).date, TODAY);
  /* «День» не поддерживается — неизвестный вид → месяц */
  assert.deepEqual(WAIST_PERIOD_KINDS, ['week', 'month', '6m', 'year']);
  assert.equal(waistPeriod(LOG, 'day', 0, TODAY).win.kind, 'month');
});

test('14. отдельный ключ waist_log: metrics_log и список показателей не меняются', async () => {
  const s = await fresh();
  const before = await s.getMetricsLog();
  await s.saveWaist(w(TODAY, '93'));
  assert.deepEqual(await s.getMetricsLog(), before);
  assert.ok(!METRIC_KEYS.includes('waist'), 'прежние версии проверяют metrics_log по этому списку');
});

test('15. резервная копия: талия входит в копию, самопроверка проходит, восстановление — байт-в-байт', async () => {
  const s = await fresh();
  await s.saveWaist(w('2026-10-01', '94,5'));
  await s.saveWaist(w(TODAY, '93'));
  await s.setMetricValue('weight', 80.2, '2026-10-01');
  const b = await s.createBackup();
  assert.equal(b.verified, true);
  const raw = JSON.parse(b.json);
  assert.deepEqual(raw.data.waist_log, await s.getWaistLog());
  const t = await fresh();
  const prepared = await t.prepareRestore(parseBackup(b.json));
  assert.equal(prepared.summary.waist, 2);
  await t.restoreBackup(prepared);
  assert.deepEqual(await t.getWaistLog(), await s.getWaistLog());
  assert.equal((await t.getMetricLog('weight'))['2026-10-01'], 80.2, 'вес на месте');
});

test('16. старая копия без waist_log восстанавливается; повреждённый раздел талии — понятная ошибка', async () => {
  const s = await fresh();
  await s.setMetricValue('weight', 81, '2026-09-01');
  const raw = JSON.parse((await s.createBackup()).json);
  delete raw.data.waist_log;
  delete raw.data.workouts_log;
  delete raw.data.workouts_migration;
  const t = await fresh();
  await t.saveWaist(w(TODAY, '93'));
  await t.importBackup(raw);
  assert.deepEqual(await t.getWaistLog(), {}, 'в копии талии не было — после восстановления раздел пуст, не ошибка');
  assert.equal((await t.getMetricLog('weight'))['2026-09-01'], 81);
  const bad = JSON.parse((await s.createBackup()).json);
  bad.data.waist_log = { '2026-10-01': { cm: 'девяносто' } };
  await assert.rejects(t.prepareRestore(bad), (e) => e instanceof BackupError && e.code === 'CORRUPT' && /Обхват талии/.test(e.message));
  bad.data.waist_log = { '2026-10-01': { cm: 0 } };
  await assert.rejects(t.prepareRestore(bad), (e) => e.code === 'CORRUPT', '0 см — не измерение');
});

test('17. существующие данные (вес, вода, сон, шаги) не меняются при работе с талией', async () => {
  const s = await fresh();
  await s.setMetricValue('weight', 80.4, '2026-10-01');
  await s.saveDailyActivity('steps', { date: '2026-10-01', steps: 8000, note: '' });
  const snap = async () => JSON.stringify(await Promise.all([s.getMetricsLog(), s.getDailyActivityLog('steps'), s.getSleepEntries(), s.getBikeRides()]));
  const before = await snap();
  await s.saveWaist(w('2026-10-01', '94'));
  await s.saveWaist(w('2026-10-02', '93'), { from: '2026-10-01' });
  await s.removeWaist('2026-10-02');
  assert.equal(await snap(), before);
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
console.log(`${tests.length - failed} passed, ${failed} failed (${tests.length} total) TZ=${TZ}`);
process.exit(failed ? 1 : 0);
