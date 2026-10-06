/* =========================================================
   tests/workouts.test.mjs — раздел «Тренировки» (js/services/workouts.js + StorageService +
   провайдер журнала): Планка (добавление, правка, удаление, 3 × 60 = 180 сек), «Другое
   упражнение» с произвольным названием, запись за прошлую дату, порядок журнала, перенос
   старых Планки / «Другого» из activity_days (однократный, идемпотентный, без дублей и без
   возврата удалённого, activity_days не меняется), резервная копия — новая и старая.
   Без браузера: StorageService на MemoryDriver. Только синтетические данные.

   Запуск:  node tests/workouts.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, BackupError, EntryStoreError } from '../js/services/storage.js';
import {
  normalizeWorkoutInput, isValidWorkout, isValidWorkoutsLog, migrateLegacyWorkouts, sortWorkouts, plankTotalSeconds,
  workoutTitle, workoutValue, workoutSub, fmtSeconds, fmtMinutes, WORKOUT_KINDS, WORKOUT_NAME_MAX,
} from '../js/services/workouts.js';
import { buildJournal, groupJournal, journalType, JOURNAL_TYPES } from '../js/services/journals.js';

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = (s) => String(s).replace(/[  ]/g, ' ');
const tick = () => new Promise((r) => setTimeout(r, 3));

const TODAY = '2026-10-05';
async function fresh(seed = null) {
  const s = new StorageService(new MemoryDriver());
  if (seed) {
    for (const [k, v] of Object.entries(seed)) await s.driver.set(k, JSON.stringify(v));
    await s.driver.set('health_meta', JSON.stringify({ seededAt: '2026-01-01T00:00:00.000Z', schemaVersion: 8 }));
  }
  await s.init();
  return s;
}
const plank = (date, sets, seconds, note = '') => normalizeWorkoutInput({ kind: 'plank', date, sets, seconds, note }, { today: TODAY }).value;
const other = (date, name, minutes, note = '') => normalizeWorkoutInput({ kind: 'other', date, name, minutes, note }, { today: TODAY }).value;

/* «существующая» установка: старая «Активность» с планкой и «другим» + уже перенесённые шаги */
const ACTIVITY_DAYS = {
  '2026-09-28': { bike: 40, bikeIntensity: 'Средняя', steps: 7300, plank: [60, 60, 60], otherType: 'Плавание', otherMin: 30, savedAt: '2026-09-28T20:00:00.000Z' },
  '2026-09-29': { bike: null, steps: 9100, plank: [], otherType: '', otherMin: null, savedAt: '2026-09-29T20:00:00.000Z' },
  '2026-09-30': { plank: [30, 45, null], otherType: 'Йога', otherMin: null, savedAt: '2026-09-30T20:00:00.000Z' },
  '2026-10-01': { plank: [0, 0], otherType: '  ', otherMin: 0 },
  '2026-10-02': { otherType: '', otherMin: 20 },
  '2026-10-03': { plank: [90], otherMin: 5000 },
};

test('1. добавление Планки: подходы × секунды, общая длительность 3 × 60 = 180 сек', async () => {
  const s = await fresh();
  const rec = await s.addWorkout(plank(TODAY, '3', '60'));
  assert.equal(rec.kind, 'plank');
  assert.equal(rec.sets, 3);
  assert.equal(rec.seconds, 60);
  assert.equal(plankTotalSeconds(rec), 180);
  assert.equal(rec.source, 'manual');
  assert.equal(plain(workoutValue(rec)), '3 подхода × 60 сек');
  assert.equal(plain(workoutSub(rec)), 'всего 3 мин');
  assert.equal(plain(fmtSeconds(180)), '3 мин');
  assert.equal(plain(fmtSeconds(45)), '45 сек');
  assert.equal(plain(fmtSeconds(210)), '3 мин 30 сек');
  const list = await s.getWorkouts();
  assert.equal(list.length, 1);
  assert.ok(isValidWorkoutsLog(list));
});

test('2. редактирование Планки: подходы, секунды, дата, заметка; id, тип и createdAt остаются', async () => {
  const s = await fresh();
  const rec = await s.addWorkout(plank(TODAY, '3', '60'));
  await tick();
  const next = await s.updateWorkout(rec.id, plank('2026-10-01', '4', '45', 'после пробежки'));
  assert.equal(next.id, rec.id);
  assert.equal(next.kind, 'plank');
  assert.equal(next.createdAt, rec.createdAt);
  assert.ok(next.updatedAt >= rec.updatedAt);
  assert.deepEqual([next.date, next.sets, next.seconds, next.note], ['2026-10-01', 4, 45, 'после пробежки']);
  assert.equal((await s.getWorkouts()).length, 1);
  /* попытка сменить тип через правку игнорируется: у планки не появляется name / minutes */
  const again = await s.updateWorkout(rec.id, { ...plank('2026-10-01', '4', '45'), kind: 'other', name: 'X', minutes: 5 });
  assert.equal(again.kind, 'plank');
  assert.ok(!('name' in again) && !('minutes' in again));
  assert.equal(await s.updateWorkout('нет-такой', plank(TODAY, '1', '10')), null);
});

test('2a. правка перенесённой планки с разными подходами сбрасывает legacySeconds (устаревшую точность)', async () => {
  const s = await fresh({ activity_days: { '2026-09-30': { plank: [30, 45], savedAt: '2026-09-30T20:00:00.000Z' } } });
  const before = (await s.getWorkouts()).find((w) => w.id === 'legacy-plank-2026-09-30');
  assert.deepEqual(before.legacySeconds, [30, 45]);
  const after = await s.updateWorkout(before.id, plank(before.date, '2', '38'));
  assert.ok(!('legacySeconds' in after), 'после ручного ввода новых sets/seconds старая точность не хранится');
  assert.equal((await s.getWorkouts()).find((w) => w.id === before.id).legacySeconds, undefined);
});

test('3. удаление: удаляется только эта запись; повторно → null', async () => {
  const s = await fresh();
  const a = await s.addWorkout(plank(TODAY, '3', '60'));
  const b = await s.addWorkout(other(TODAY, 'Отжимания', '15'));
  assert.equal((await s.removeWorkout(a.id)).id, a.id);
  assert.deepEqual((await s.getWorkouts()).map((x) => x.id), [b.id]);
  assert.equal(await s.removeWorkout(a.id), null);
});

test('4. «Другое упражнение»: произвольное название и длительность в минутах', async () => {
  const s = await fresh();
  for (const name of ['Отжимания', 'Приседания', 'Пресс', 'Растяжка', 'Гантели', 'Йога', 'Скакалка во дворе 🪢']) {
    await s.addWorkout(other(TODAY, name, '15'));
  }
  const names = (await s.getWorkouts()).map((x) => x.name);
  assert.ok(names.includes('Скакалка во дворе 🪢'));
  const one = (await s.getWorkouts()).find((x) => x.name === 'Отжимания');
  assert.equal(workoutTitle(one), 'Отжимания');
  assert.equal(plain(workoutValue(one)), '15 мин');
  assert.equal(plain(fmtMinutes(90)), '1 ч 30 мин');
  /* лишние пробелы убираются, длина ограничена */
  assert.equal(other(TODAY, '  Пресс   на  мяче ', '10').name, 'Пресс на мяче');
  assert.equal(other(TODAY, 'я'.repeat(200), '10').name.length, WORKOUT_NAME_MAX);
});

test('5. проверка ввода: пустые и неверные поля, будущая дата, неизвестный тип', () => {
  const n = (x) => normalizeWorkoutInput({ date: TODAY, ...x }, { today: TODAY });
  assert.ok(n({ kind: 'plank', sets: '0', seconds: '60' }).errors.sets);
  assert.ok(n({ kind: 'plank', sets: '3', seconds: '' }).errors.seconds);
  assert.ok(n({ kind: 'plank', sets: '2,5', seconds: '60' }).errors.sets, 'подходы — целое число');
  assert.ok(n({ kind: 'plank', sets: 'три', seconds: '60' }).errors.sets);
  assert.ok(n({ kind: 'other', name: '   ', minutes: '15' }).errors.name);
  assert.ok(n({ kind: 'other', name: 'Йога', minutes: '0' }).errors.minutes);
  assert.ok(n({ kind: 'other', name: 'Йога', minutes: '2000' }).errors.minutes);
  assert.ok(n({ kind: 'steps', name: 'Шаги', minutes: '10' }).errors.kind, 'шаги — не тренировка');
  assert.ok(normalizeWorkoutInput({ kind: 'plank', date: '2026-10-06', sets: '3', seconds: '60' }, { today: TODAY }).errors.date);
  assert.deepEqual(WORKOUT_KINDS, ['plank', 'other']);
});

test('6. запись за прошлую дату (другой месяц и год)', async () => {
  const s = await fresh();
  await s.addWorkout(plank('2025-12-31', '2', '90'));
  await s.addWorkout(other('2026-03-08', 'Йога', '45'));
  assert.deepEqual((await s.getWorkouts()).map((x) => x.date), ['2026-03-08', '2025-12-31']);
});

test('7. сортировка журнала: даты новые сверху; в один день позже добавленная выше', async () => {
  const s = await fresh();
  await s.addWorkout(plank('2026-10-01', '3', '60'));
  await tick();
  await s.addWorkout(other(TODAY, 'Отжимания', '15'));
  await tick();
  await s.addWorkout(plank(TODAY, '2', '45'));
  await tick();
  await s.addWorkout(other('2026-10-03', 'Пресс', '10'));
  const list = await s.getWorkouts();
  assert.deepEqual(list.map((x) => `${x.date} ${workoutTitle(x)}`), ['2026-10-05 Планка', '2026-10-05 Отжимания', '2026-10-03 Пресс', '2026-10-01 Планка']);
  const groups = groupJournal(buildJournal({ workouts: list }, {}, [journalType('workout')]), { today: TODAY });
  assert.deepEqual(groups.map((g) => g.date), [TODAY, '2026-10-03', '2026-10-01']);
  assert.deepEqual(groups[0].items.map((x) => x.title), ['Планка', 'Отжимания']);
  assert.equal(plain(groups[0].summary), '2 тренировки');
  assert.equal(plain(groups[1].summary), '1 тренировка');
  /* одинаковое createdAt — порядок добавления (позже в массиве — выше) */
  const same = sortWorkouts([{ id: 'a', date: TODAY, createdAt: 'x' }, { id: 'b', date: TODAY, createdAt: 'x' }]);
  assert.deepEqual(same.map((x) => x.id), ['b', 'a']);
});

test('8. «Тренировки» — только Планка и «Другое»: шаги, велосипед, сон и вода сюда не попадают', async () => {
  const s = await fresh();
  await s.saveDailyActivity('steps', { date: TODAY, steps: 8000, note: '' });
  await s.addBikeRide({ date: TODAY, time: null, km: 7, minutes: null, note: '' });
  await s.addWaterEntry?.(250, TODAY);
  assert.deepEqual(await s.getWorkouts(), []);
  const all = buildJournal({ steps: await s.getDailyActivityLog('steps'), bike: await s.getBikeRides(), workouts: [] });
  assert.ok(all.every((x) => x.type !== 'workout'));
  assert.ok(JOURNAL_TYPES.some((t) => t.id === 'steps') && JOURNAL_TYPES.some((t) => t.id === 'bike'), 'шаги и велосипед — свои типы журнала');
});

test('9. перенос старой «Активности»: планка и «другое» в «Тренировки», activity_days без изменений', async () => {
  const s = await fresh({ activity_days: ACTIVITY_DAYS });
  const before = await s.driver.get('activity_days');
  assert.equal(before, JSON.stringify(ACTIVITY_DAYS), 'activity_days байт-в-байт');
  const list = await s.getWorkouts();
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'legacy-other-2026-09-28', 'legacy-other-2026-09-30', 'legacy-other-2026-10-02',
    'legacy-plank-2026-09-28', 'legacy-plank-2026-09-30', 'legacy-plank-2026-10-03',
  ]);
  const p = byId['legacy-plank-2026-09-28'];
  assert.deepEqual([p.kind, p.sets, p.seconds, p.source, p.createdAt], ['plank', 3, 60, 'activity', '2026-09-28T20:00:00.000Z']);
  assert.equal(p.legacySeconds, null, 'равные подходы — нечего хранить отдельно от seconds');
  const uneven = byId['legacy-plank-2026-09-30'];
  assert.deepEqual([uneven.sets, uneven.seconds, uneven.note], [2, 38, 'Подходы: 30, 45 сек'], 'разные подходы: средняя длительность, исходные — в заметке');
  assert.deepEqual(uneven.legacySeconds, [30, 45], 'lossless: точные секунды каждого подхода сохранены структурно, не только текстом');
  assert.deepEqual([byId['legacy-other-2026-09-28'].name, byId['legacy-other-2026-09-28'].minutes], ['Плавание', 30]);
  assert.deepEqual([byId['legacy-other-2026-09-30'].name, byId['legacy-other-2026-09-30'].minutes], ['Йога', null], 'название без минут — запись без длительности');
  assert.equal(plain(workoutValue(byId['legacy-other-2026-09-30'])), 'без длительности');
  assert.deepEqual([byId['legacy-other-2026-10-02'].name, byId['legacy-other-2026-10-02'].minutes], ['Другое упражнение', 20]);
  assert.ok(!byId['legacy-other-2026-10-03'], '5000 минут — вне пределов, не переносится (в activity_days остаётся)');
  assert.ok(!byId['legacy-plank-2026-10-01'] && !byId['legacy-other-2026-10-01'], 'пустые нули не превращаются в записи');
  const marker = JSON.parse(await s.driver.get('workouts_migration'));
  assert.deepEqual([marker.plankAdded, marker.otherAdded, marker.invalid], [3, 3, 1]);
  /* шаги и велотренажёр — как и раньше, в свои разделы */
  assert.equal((await s.getDailyActivityLog('steps'))['2026-09-28'].steps, 7300);
  assert.ok((await s.getBikeRides()).some((r) => r.id === 'legacy-2026-09-28'));
  assert.ok((await s.getWorkouts()).every(isValidWorkout));
});

test('10. миграция идемпотентна: повторный запуск без дублей, удалённое не возвращается, правка сохраняется', async () => {
  const s = await fresh({ activity_days: ACTIVITY_DAYS });
  const n = (await s.getWorkouts()).length;
  await s.init();
  await s.init();
  assert.equal((await s.getWorkouts()).length, n, 'повторный запуск ничего не добавил');
  await s.removeWorkout('legacy-plank-2026-09-28');
  await s.updateWorkout('legacy-other-2026-09-28', other('2026-09-28', 'Плавание в бассейне', '35'));
  await s.init();
  const list = await s.getWorkouts();
  assert.equal(list.length, n - 1, 'удалённая перенесённая запись не вернулась');
  assert.equal(list.find((x) => x.id === 'legacy-other-2026-09-28').name, 'Плавание в бассейне');
  assert.equal(await s.driver.get('activity_days'), JSON.stringify(ACTIVITY_DAYS));
});

test('11. прерванная миграция (данные записаны, отметки нет) и частично заполненные данные — без дублей', async () => {
  const first = migrateLegacyWorkouts({ activityDays: ACTIVITY_DAYS, workoutsLog: [] }, { now: 'n' });
  const partial = first.workoutsLog.slice(0, 2);
  const manual = { id: 'm1', kind: 'plank', date: TODAY, sets: 1, seconds: 30, note: '', source: 'manual', createdAt: 'z', updatedAt: 'z' };
  const s = await fresh({ activity_days: ACTIVITY_DAYS, workouts_log: [...partial, manual] });
  const list = await s.getWorkouts();
  assert.equal(list.length, first.workoutsLog.length + 1);
  assert.equal(new Set(list.map((x) => x.id)).size, list.length, 'id не повторяются');
  assert.ok(list.some((x) => x.id === 'm1'), 'ручная запись на месте');
  /* чистая функция: вход не изменяется; мусор в activity_days не роняет перенос */
  const input = { activityDays: { ...ACTIVITY_DAYS, 'не-дата': { plank: [60] }, '2026-10-04': null, '2026-10-05': 'x' }, workoutsLog: [] };
  const copy = JSON.stringify(input);
  const r = migrateLegacyWorkouts(input, { now: 'n' });
  assert.equal(JSON.stringify(input), copy);
  assert.equal(r.workoutsLog.length, first.workoutsLog.length);
  const again = migrateLegacyWorkouts({ activityDays: ACTIVITY_DAYS, workoutsLog: r.workoutsLog }, { now: 'n' });
  assert.equal(again.changed, false);
  assert.equal(again.marker.skipped, r.workoutsLog.length);
  /* без activity_days (новая установка) — пусто, отметка есть */
  const clean = await fresh();
  assert.deepEqual(await clean.getWorkouts(), []);
  assert.ok(JSON.parse(await clean.driver.get('workouts_migration')).version >= 1);
});

test('12. резервная копия: тренировки и отметка переноса в копии, восстановление байт-в-байт', async () => {
  const s = await fresh({ activity_days: ACTIVITY_DAYS });
  await s.addWorkout(other(TODAY, 'Гантели', '20'));
  await s.removeWorkout('legacy-plank-2026-09-28');
  const b = await s.createBackup();
  assert.equal(b.verified, true);
  const raw = JSON.parse(b.json);
  assert.ok(Array.isArray(raw.data.workouts_log) && raw.data.workouts_migration);
  assert.deepEqual(raw.data.activity_days, ACTIVITY_DAYS, 'старый архив остаётся в копии');
  const t = await fresh();
  const prepared = await t.prepareRestore(parseBackup(b.json));
  assert.equal(prepared.summary.workouts, (await s.getWorkouts()).length);
  await t.restoreBackup(prepared);
  assert.deepEqual(await t.getWorkouts(), await s.getWorkouts());
  assert.ok(!(await t.getWorkouts()).some((x) => x.id === 'legacy-plank-2026-09-28'), 'удалённая запись не вернулась после восстановления');
});

test('13. старая копия (до «Тренировок»): планка и «другое» переносятся при восстановлении, остальное как было', async () => {
  const old = {
    app: 'lexlife', backupFormatVersion: 2, appVersion: '1.0.0', schemaVersion: 8, createdAt: '2026-10-05T10:00:00.000Z',
    settings: { theme: 'dark' },
    data: {
      activity_days: ACTIVITY_DAYS, steps_log: {}, bike_log: [], activity_migration: { version: 1, migratedAt: '2026-10-05T09:00:00.000Z' },
      metrics_log: { weight: { '2026-10-01': 80.1 } },
    },
  };
  const t = await fresh();
  await t.addWorkout(plank(TODAY, '1', '30'));
  const prepared = await t.prepareRestore(old);
  assert.equal(prepared.summary.workouts, 6);
  assert.equal(prepared.summary.waist, 0);
  await t.restoreBackup(prepared);
  assert.equal((await t.getWorkouts()).length, 6, 'текущие записи заменены данными копии — как и всё остальное');
  assert.deepEqual(await t.getWaistLog(), {});
  assert.equal((await t.getMetricLog('weight'))['2026-10-01'], 80.1);
  assert.deepEqual(await t.getAllActivity(), ACTIVITY_DAYS);
  /* очень старая копия формата 1 (без новых разделов и без отметок) — тоже */
  const v1 = { app: 'moe-zdorovie', schemaVersion: 8, exportedAt: '2026-01-01T00:00:00.000Z', data: { activity_days: { '2026-01-02': { plank: [60, 60] } } } };
  const p1 = await t.prepareRestore(v1);
  assert.deepEqual(p1.data.workouts_log.map((x) => x.id), ['legacy-plank-2026-01-02']);
});

test('14. повреждённый раздел тренировок в копии — понятная ошибка, текущие данные не меняются', async () => {
  const s = await fresh();
  await s.addWorkout(plank(TODAY, '3', '60'));
  const before = await s.driver.get('workouts_log');
  const bad = JSON.parse((await s.createBackup()).json);
  bad.data.workouts_log = [{ id: 'x', kind: 'plank', date: TODAY, sets: -1, seconds: 60 }];
  await assert.rejects(s.prepareRestore(bad), (e) => e instanceof BackupError && e.code === 'CORRUPT' && /Тренировки/.test(e.message));
  bad.data.workouts_log = [{ id: 'x', kind: 'yoga', date: TODAY }];
  await assert.rejects(s.prepareRestore(bad), (e) => e.code === 'CORRUPT');
  assert.equal(await s.driver.get('workouts_log'), before);
  await assert.rejects(s.addWorkout({ kind: 'plank', date: TODAY, sets: 0, seconds: 0 }), (e) => e instanceof EntryStoreError && e.code === 'INVALID');
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
