/* =========================================================
   tests/meds.test.mjs — лекарства: форма, расписание, отметка каждого приёма,
   история по локальным дням, правка/удаление без потери истории, резервная копия.
   Без браузера: services/meds.js + StorageService на MemoryDriver. Только синтетические данные.
   run-all запускает файл в нескольких timezone (дата приёма — локальный день, не UTC).

   Запуск:  node tests/meds.test.mjs     (или TZ=America/Los_Angeles node tests/meds.test.mjs)
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, BackupError, CURRENT_SCHEMA_VERSION, applyMedIntake, dateKey } from '../js/services/storage.js';
import {
  normalizeMedInput, medSchedule, medDaySlots, medOccurrences, isMedDueOn, intakeSummary, intakeHistory,
  nextDueDay, scheduleLabel, addDays, weekdayOf,
} from '../js/services/meds.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function fresh() {
  const s = new StorageService(new MemoryDriver());
  await s.init();
  return s;
}
const form = (o) => normalizeMedInput({ name: 'Синтетик', mode: 'daily', days: [], times: [], ...o });
const SUNDAY = '2026-10-04'; // воскресенье
const MONDAY = '2026-10-05';

/* ================= форма ================= */

test('форма: без названия сохранить нельзя (пусто и только пробелы)', () => {
  for (const name of ['', '   ', undefined]) {
    const r = normalizeMedInput({ name, mode: 'daily', times: ['08:00'] });
    assert.equal(r.ok, false);
    assert.equal(r.errors.name, 'Введите название препарата');
  }
});

test('форма: «по выбранным дням» без дней — ошибка; поля обрезаются, времена без повторов и по порядку', () => {
  assert.equal(form({ mode: 'days', days: [] }).errors.days, 'Выберите хотя бы один день');
  const r = form({ name: '  Синтетик D  ', dose: ' 2000 МЕ ', note: ' после еды ', mode: 'days', days: [5, 1, 1, 9], times: ['20:00', '08:00', '20:00', 'xx', '25:00'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    name: 'Синтетик D', dose: '2000 МЕ', note: 'после еды',
    schedule: { mode: 'days', days: [1, 5], times: ['08:00', '20:00'] }, reminder_time: '08:00',
  });
  const asNeeded = form({ mode: 'asNeeded', times: ['08:00'] });
  assert.deepEqual(asNeeded.value.schedule, { mode: 'asNeeded', days: [], times: [] });
  assert.equal(asNeeded.value.reminder_time, null);
});

/* ================= создание и отображение ================= */

test('создание: лекарство сохраняется и появляется в списке; несколько времён — несколько приёмов в день', async () => {
  const s = await fresh();
  assert.deepEqual(await s.getMeds(), []);
  const m = await s.addMed(form({ name: 'Синтетик D', dose: '2000 МЕ', times: ['20:00', '08:00'] }).value);
  const list = await s.getMeds();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, m.id);
  assert.equal(list[0].name, 'Синтетик D');
  assert.equal(list[0].active, true);
  assert.deepEqual(medDaySlots(list[0], SUNDAY).map((x) => [x.time, x.taken]), [['08:00', false], ['20:00', false]]);
  assert.deepEqual(intakeSummary(list, SUNDAY), { due: 2, taken: 0 });
});

test('без времени — одна отметка в день; «по необходимости» — отметка есть, в план дня не входит', () => {
  const daily = { id: 'a', name: 'A', active: true, schedule: { mode: 'daily', days: [], times: [] } };
  const prn = { id: 'b', name: 'B', active: true, schedule: { mode: 'asNeeded', days: [], times: [] } };
  assert.deepEqual(medDaySlots(daily, SUNDAY).map((x) => x.time), [null]);
  assert.deepEqual(medDaySlots(prn, SUNDAY).map((x) => x.time), [null]);
  assert.equal(isMedDueOn(prn, SUNDAY), false);
  assert.deepEqual(intakeSummary([daily, prn], SUNDAY), { due: 1, taken: 0 });
  assert.equal(scheduleLabel(prn), 'По необходимости');
});

test('по выбранным дням: приём только в эти дни недели, следующий день считается', () => {
  const m = { id: 'a', name: 'A', active: true, schedule: { mode: 'days', days: [1, 3], times: ['09:00'] } };
  assert.equal(weekdayOf(SUNDAY), 0);
  assert.equal(isMedDueOn(m, SUNDAY), false);
  assert.deepEqual(medDaySlots(m, SUNDAY), []);
  assert.deepEqual(medOccurrences(m, MONDAY), [{ time: '09:00' }]);
  assert.equal(nextDueDay(m, SUNDAY), MONDAY);
  assert.equal(nextDueDay(m, MONDAY), '2026-10-07');
  assert.equal(scheduleLabel(m), 'Пн, Ср');
});

/* ================= отметки приёмов ================= */

test('отметка конкретного приёма: 08:00 принят, 20:00 остаётся непринятым', async () => {
  const s = await fresh();
  const m = await s.addMed(form({ times: ['08:00', '20:00'] }).value);
  const now = new Date(2026, 9, 4, 8, 12);
  await s.setMedIntake({ medId: m.id, time: '08:00', taken: true, day: SUNDAY, now });
  const slots = medDaySlots(m, SUNDAY, { intakes: await s.getMedIntakes(SUNDAY) });
  assert.deepEqual(slots.map((x) => [x.time, x.taken]), [['08:00', true], ['20:00', false]]);
  assert.equal(slots[0].takenAt, now.toISOString());
  const recs = await s.getMedIntakes(SUNDAY);
  assert.deepEqual(recs, [{ medId: m.id, scheduledTime: '08:00', takenAt: now.toISOString() }]);
  /* повторная отметка не дублирует запись */
  await s.setMedIntake({ medId: m.id, time: '08:00', taken: true, day: SUNDAY, now });
  assert.equal((await s.getMedIntakes(SUNDAY)).length, 1);
});

test('снятие отметки удаляет только этот приём этого дня', async () => {
  const s = await fresh();
  const m = await s.addMed(form({ times: ['08:00', '20:00'] }).value);
  for (const [day, time] of [[SUNDAY, '08:00'], [SUNDAY, '20:00'], [MONDAY, '08:00']]) {
    await s.setMedIntake({ medId: m.id, time, taken: true, day });
  }
  await s.setMedIntake({ medId: m.id, time: '08:00', taken: false, day: SUNDAY });
  assert.deepEqual((await s.getMedIntakes(SUNDAY)).map((r) => r.scheduledTime), ['20:00']);
  assert.deepEqual((await s.getMedIntakes(MONDAY)).map((r) => r.scheduledTime), ['08:00']);
  await s.setMedIntake({ medId: m.id, time: '20:00', taken: false, day: SUNDAY });
  assert.ok(!(SUNDAY in (await s.getAllMedIntakes())), 'пустой день не остаётся в журнале');
});

test('история разных дней не смешивается: отметка сегодня не меняет вчера', async () => {
  const s = await fresh();
  const m = await s.addMed(form({}).value);
  const yesterday = addDays(SUNDAY, -1);
  await s.setMedIntake({ medId: m.id, taken: true, day: yesterday });
  const before = JSON.stringify(await s.getMedIntakes(yesterday));
  await s.setMedIntake({ medId: m.id, taken: true, day: SUNDAY });
  await s.setMedIntake({ medId: m.id, taken: false, day: SUNDAY });
  assert.equal(JSON.stringify(await s.getMedIntakes(yesterday)), before);
  assert.deepEqual(medDaySlots(m, yesterday, { intakes: await s.getMedIntakes(yesterday) }).map((x) => x.taken), [true]);
  assert.deepEqual(medDaySlots(m, SUNDAY, { intakes: await s.getMedIntakes(SUNDAY) }).map((x) => x.taken), [false]);
});

test('быстрые касания: две отметки одновременно — обе сохраняются', async () => {
  const s = await fresh();
  const m = await s.addMed(form({ times: ['08:00', '20:00'] }).value);
  await Promise.all([
    s.setMedIntake({ medId: m.id, time: '08:00', taken: true, day: SUNDAY }),
    s.setMedIntake({ medId: m.id, time: '20:00', taken: true, day: SUNDAY }),
  ]);
  assert.deepEqual((await s.getMedIntakes(SUNDAY)).map((r) => r.scheduledTime).sort(), ['08:00', '20:00']);
});

test('приёмы двух лекарств независимы', async () => {
  const s = await fresh();
  const a = await s.addMed(form({ name: 'A', times: ['08:00'] }).value);
  const b = await s.addMed(form({ name: 'B', times: ['08:00'] }).value);
  await s.setMedIntake({ medId: a.id, time: '08:00', taken: true, day: SUNDAY });
  const intakes = await s.getMedIntakes(SUNDAY);
  assert.equal(medDaySlots(a, SUNDAY, { intakes })[0].taken, true);
  assert.equal(medDaySlots(b, SUNDAY, { intakes })[0].taken, false);
  assert.deepEqual(intakeSummary([a, b], SUNDAY, { intakes }), { due: 2, taken: 1 });
});

/* ================= редактирование и удаление ================= */

test('редактирование: поля обновляются, старые поля записи (курс, назначение) сохраняются', async () => {
  const s = await fresh();
  const m = await s.addMed({ ...form({ times: ['08:00'] }).value, purpose: 'синтетическое назначение', every_days: 2, start: '2026-10-01' });
  const r = form({ name: 'Синтетик 2', dose: '1 таблетка', note: 'до завтрака', mode: 'days', days: [1], times: ['09:30'] });
  const upd = await s.updateMed(m.id, r.value);
  assert.equal(upd.name, 'Синтетик 2');
  assert.equal(upd.dose, '1 таблетка');
  assert.equal(upd.note, 'до завтрака');
  assert.deepEqual(upd.schedule, { mode: 'days', days: [1], times: ['09:30'] });
  assert.deepEqual([upd.purpose, upd.every_days, upd.start, upd.id], ['синтетическое назначение', 2, '2026-10-01', m.id]);
  assert.equal(await s.updateMed('нет-такого', r.value), null);
});

test('смена расписания не уничтожает историю: старый приём остаётся в своём дне, сегодня видна строка «вне расписания»', async () => {
  const s = await fresh();
  const m = await s.addMed(form({ times: ['08:00', '20:00'] }).value);
  const yesterday = addDays(SUNDAY, -1);
  await s.setMedIntake({ medId: m.id, time: '08:00', taken: true, day: yesterday });
  await s.setMedIntake({ medId: m.id, time: '20:00', taken: true, day: yesterday });
  await s.setMedIntake({ medId: m.id, time: '08:00', taken: true, day: SUNDAY });
  const upd = await s.updateMed(m.id, form({ times: ['09:00'] }).value);
  assert.equal((await s.getMedIntakes(yesterday)).length, 2, 'вчерашние приёмы на месте');
  const today = medDaySlots(upd, SUNDAY, { intakes: await s.getMedIntakes(SUNDAY) });
  assert.deepEqual(today.map((x) => [x.time, x.taken, x.extra]), [['08:00', true, true], ['09:00', false, false]]);
  assert.deepEqual(intakeSummary([upd], SUNDAY, { intakes: await s.getMedIntakes(SUNDAY) }), { due: 1, taken: 0 }, 'в плане — только новое расписание');
  assert.deepEqual(medDaySlots(upd, MONDAY).map((x) => x.time), ['09:00']);
  const hist = intakeHistory(await s.getMeds({ includeDeleted: true }), await s.getAllMedIntakes(), {}, { until: SUNDAY });
  assert.deepEqual(hist.map((d) => [d.day, d.items.map((i) => i.time)]), [[SUNDAY, ['08:00']], [yesterday, ['08:00', '20:00']]]);
});

test('удаление: лекарство пропадает из списка, история приёма и запись для связей остаются', async () => {
  const s = await fresh();
  const m = await s.addMed(form({ name: 'Синтетик D' }).value);
  await s.setMedIntake({ medId: m.id, taken: true, day: SUNDAY });
  assert.equal(await s.removeMed(m.id), true);
  assert.deepEqual(await s.getMeds(), []);
  assert.equal(await s.getMed(m.id), null);
  const all = await s.getMeds({ includeDeleted: true });
  assert.equal(all.length, 1);
  assert.ok(all[0].deletedAt && all[0].active === false);
  assert.equal((await s.getMedIntakes(SUNDAY)).length, 1);
  assert.deepEqual(medDaySlots(all[0], SUNDAY, { intakes: await s.getMedIntakes(SUNDAY) }), [], 'удалённое не рисуется');
  const hist = intakeHistory(all, await s.getAllMedIntakes(), {}, { until: SUNDAY });
  assert.equal(hist[0].items[0].name, 'Синтетик D', 'в истории остаётся имя');
  assert.equal(await s.removeMed(m.id), false, 'повторное удаление ничего не делает');
});

/* ================= старые данные ================= */

test('старая отметка по имени (med_log) видна и переносится в приём при первой новой отметке', async () => {
  const s = await fresh();
  await s._write('health_meds', [{ id: 'm_old', name: 'Старое', icon: '💊', active: true, reminder_time: '21:00' }]);
  await s._write('med_log', { [SUNDAY]: ['Старое', 'Другое'], '2026-10-01': ['Старое'] });
  const [m] = await s.getMeds();
  assert.deepEqual(medSchedule(m), { mode: 'daily', days: [], times: ['21:00'] });
  assert.equal(medDaySlots(m, SUNDAY, { legacyNames: await s.getMedLog(SUNDAY) })[0].taken, true);
  /* снять старую отметку: запись по имени убирается только за этот день, чужие имена не трогаются */
  await s.setMedIntake({ medId: 'm_old', time: '21:00', taken: false, day: SUNDAY, name: 'Старое', legacyTime: '21:00' });
  assert.deepEqual(await s.getMedLog(SUNDAY), ['Другое']);
  assert.deepEqual(await s.getMedLog('2026-10-01'), ['Старое']);
  assert.deepEqual(await s.getMedIntakes(SUNDAY), []);
  /* чистая функция: отметка другого приёма сохраняет старую как приём legacyTime */
  const r = applyMedIntake({ intakes: [], legacy: ['Старое'] }, { medId: 'm_old', time: '09:00', taken: true, name: 'Старое', legacyTime: '08:00', takenAt: 'T' });
  assert.deepEqual(r.intakes, [{ medId: 'm_old', scheduledTime: '08:00', takenAt: null }, { medId: 'm_old', scheduledTime: '09:00', takenAt: 'T' }]);
  assert.deepEqual([r.legacy, r.legacyChanged], [[], true]);
});

test('лекарство из старой копии без id получает id — остальные поля не меняются', async () => {
  const s = await fresh();
  await s._write('health_meds', [{ name: 'Без id', dose: '1', active: true }, { id: 'keep', name: 'С id' }]);
  assert.equal(await s.ensureMedIds(), true);
  const list = await s.getMeds();
  assert.ok(list[0].id && list[0].name === 'Без id' && list[0].dose === '1');
  assert.equal(list[1].id, 'keep');
  assert.equal(await s.ensureMedIds(), false, 'второй раз ничего не пишет');
});

test('существующая установка без med_intakes: init добавляет пустой раздел и не трогает остальное', async () => {
  const driver = new MemoryDriver();
  const meds = [{ id: 'm1', name: 'Синтетик', active: true }];
  await driver.set('health_meta', JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, seededAt: '2026-01-01T00:00:00.000Z' }));
  await driver.set('health_meds', JSON.stringify(meds));
  await driver.set('med_log', JSON.stringify({ '2026-01-02': ['Синтетик'] }));
  const s = await new StorageService(driver).init();
  assert.equal(await driver.get('med_intakes'), '{}');
  assert.equal(await driver.get('health_meds'), JSON.stringify(meds));
  assert.equal(await driver.get('med_log'), JSON.stringify({ '2026-01-02': ['Синтетик'] }));
  assert.equal(JSON.parse(await driver.get('health_meta')).schemaVersion, CURRENT_SCHEMA_VERSION, 'схема не меняется');
  assert.deepEqual(await s.getMedIntakes('2026-01-02'), []);
});

/* ================= резервная копия ================= */

test('backup/restore: лекарства с расписанием и приёмы восстанавливаются на другом устройстве', async () => {
  const a = await fresh();
  const m = await a.addMed(form({ name: 'Синтетик D', dose: '2000 МЕ', note: 'после еды', times: ['08:00', '20:00'] }).value);
  const gone = await a.addMed(form({ name: 'Удалённое' }).value);
  await a.setMedIntake({ medId: m.id, time: '08:00', taken: true, day: SUNDAY });
  await a.setMedIntake({ medId: gone.id, taken: true, day: SUNDAY });
  await a.removeMed(gone.id);
  const { json, verified } = await a.createBackup();
  assert.equal(verified, true);
  const b = await fresh();
  await b.restoreBackup(await b.prepareRestore(parseBackup(json)));
  const list = await b.getMeds();
  assert.deepEqual(list.map((x) => [x.name, x.dose, x.note, x.schedule.times]), [['Синтетик D', '2000 МЕ', 'после еды', ['08:00', '20:00']]]);
  assert.equal((await b.getMeds({ includeDeleted: true })).length, 2);
  assert.deepEqual(await b.getMedIntakes(SUNDAY), await a.getMedIntakes(SUNDAY));
});

test('backup/restore: старая копия без med_intakes импортируется, старый журнал сохраняется', async () => {
  const old = {
    app: 'lexlife', backupFormatVersion: 2, schemaVersion: 8, createdAt: '2026-09-01T10:00:00.000Z',
    data: {
      health_meds: [{ id: 'm1', name: 'Синтетик', icon: '💊', active: true, reminder_time: '21:00', every_days: null }],
      med_log: { '2026-08-30': ['Синтетик'] },
    },
  };
  const s = await fresh();
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify(old))));
  assert.deepEqual(await s.getAllMedIntakes(), {});
  assert.deepEqual(await s.getMedLog('2026-08-30'), ['Синтетик']);
  const [m] = await s.getMeds();
  assert.equal(medDaySlots(m, '2026-08-30', { legacyNames: await s.getMedLog('2026-08-30') })[0].taken, true);
  /* схема v7 (legacy-приложение) тоже проходит */
  const v7 = { ...old, app: 'moe-zdorovie', backupFormatVersion: undefined, schemaVersion: 7 };
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify(v7))));
  assert.deepEqual(await s.getAllMedIntakes(), {});
});

test('backup/restore: повреждённые приёмы или расписание — понятная ошибка, данные не меняются', async () => {
  const base = { app: 'lexlife', backupFormatVersion: 2, schemaVersion: 8, data: { health_meds: [] } };
  const bad = [
    { med_intakes: { [SUNDAY]: [{ medId: '<img>', scheduledTime: '08:00' }] } },
    { med_intakes: { [SUNDAY]: [{ medId: 'm1', scheduledTime: '8 утра' }] } },
    { med_intakes: { 'вчера': [] } },
    { health_meds: [{ id: 'm1', name: 'X', schedule: { mode: 'weekly' } }] },
    { health_meds: [{ id: 'm1', name: 'X', schedule: { mode: 'days', days: [7] } }] },
    { health_meds: [{ id: 'm1', name: 'X', schedule: { mode: 'daily', times: ['<b>'] } }] },
  ];
  const s = await fresh();
  const before = await s.getMeds();
  for (const data of bad) {
    await assert.rejects(s.prepareRestore(parseBackup(JSON.stringify({ ...base, data: { ...base.data, ...data } }))),
      (e) => e instanceof BackupError && e.code === 'CORRUPT', JSON.stringify(data));
  }
  assert.deepEqual(await s.getMeds(), before);
});

/* ================= даты и часовой пояс ================= */

test('локальная дата: 23:30 4 октября — запись 4 октября, а не 5-го по UTC', async () => {
  const late = new Date(2026, 9, 4, 23, 30);
  assert.equal(dateKey(late), '2026-10-04');
  const s = await fresh();
  const m = await s.addMed(form({ times: ['23:00'] }).value);
  await s.setMedIntake({ medId: m.id, time: '23:00', taken: true, day: dateKey(late), now: late });
  assert.deepEqual(Object.keys(await s.getAllMedIntakes()), ['2026-10-04']);
  assert.equal((await s.getMedIntakes('2026-10-04'))[0].takenAt, late.toISOString(), 'момент приёма — полный ISO');
  const early = new Date(2026, 9, 5, 0, 15);
  assert.equal(dateKey(early), '2026-10-05');
});

test('календарные дни без UTC-сдвига: день недели, переход на зимнее время, конец месяца', () => {
  assert.equal(weekdayOf('2026-10-04'), 0);
  assert.equal(weekdayOf('2026-10-05'), 1);
  assert.equal(addDays('2026-10-24', 2), '2026-10-26'); // Европа: 25.10 — переход на зимнее время
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // США: 01.11
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  const m = { id: 'a', name: 'A', active: true, schedule: { mode: 'days', days: [0], times: ['09:00'] } };
  assert.equal(nextDueDay(m, '2026-10-24'), '2026-10-25');
  assert.equal(nextDueDay(m, '2026-10-25'), '2026-11-01');
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
