/* =========================================================
   tests/activity.test.mjs — самостоятельные показатели «Шаги», «Дистанция пешком», «Велосипед»
   (js/services/activity.js + StorageService): ввод за любую дату, правка, отсутствие дублей,
   поездки и сумма дня, перенос на другую дату, статистика Неделя / Месяц / Год и её пересчёт,
   сохранность воды и сна, резервная копия, импорт старой копии, безопасная миграция
   старого раздела «Активность» (activity_days).
   Без браузера: StorageService на MemoryDriver. Только синтетические данные.
   run-all запускает файл в нескольких timezone.

   Запуск:  node tests/activity.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, BackupError, ActivityStoreError, CURRENT_SCHEMA_VERSION } from '../js/services/storage.js';
import {
  ACTIVITY_METRICS, normalizeDailyInput, normalizeRideInput, dayValues, ridesByDate, rideDayKm, latestValue, lastDays,
  activityPeriodStats, comparePrevPeriod, migrateLegacyActivity, isValidStepsLog, isValidWalkLog, isValidBikeLog, isValidRide,
  fmtActivity, parseActivityNumber, STEPS_MAX,
} from '../js/services/activity.js';
import { normalizeSleepInput, inferBedDate, formatSleepDuration } from '../js/services/sleep.js';
import { createStatsEngine } from '../js/services/analytics.js';

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = (s) => s.replace(/[  ]/g, ' ');

const TODAY = '2026-10-05'; // понедельник
async function fresh() {
  const s = new StorageService(new MemoryDriver());
  await s.init();
  return s;
}
const steps = (date, value, note = '') => normalizeDailyInput('steps', { date, value, note }, { today: TODAY }).value;
const walk = (date, value, note = '') => normalizeDailyInput('walk', { date, value, note }, { today: TODAY }).value;
const ride = (date, time, km, minutes = '') => normalizeRideInput({ date, time, km, minutes }, { today: TODAY }).value;
/* «существующая» установка со старыми данными: вода, сон, старая «Активность» */
const WATER = { '2026-10-01': { total: 1800, entries: [{ t: '09:00', ml: 300 }, { t: '12:30', ml: 1500 }] }, '2026-10-02': { total: 900, entries: [] } };
const SLEEP_ENTRY = {
  id: 'sl-1', date: '2026-10-02', sleepStart: '2026-10-01T23:40', sleepEnd: '2026-10-02T07:10', durationMinutes: 450,
  quality: 4, awakenings: 0, naps: [], tags: [], note: '', createdAt: '2026-10-02T07:15:00.000Z', updatedAt: '2026-10-02T07:15:00.000Z',
};
const ACTIVITY_DAYS = {
  '2026-09-29': { bike: 40, bikeIntensity: 'Средняя', steps: 7300, plank: [60, 60], otherType: 'плавание', otherMin: 30, savedAt: '2026-09-29T20:00:00.000Z' },
  '2026-09-30': { bike: null, steps: 9100, plank: [], otherType: '', otherMin: null, savedAt: '2026-09-30T20:00:00.000Z' },
  '2026-10-01': { bike: 25, bikeIntensity: 'Лёгкая', steps: null, plank: [], savedAt: '2026-10-01T20:00:00.000Z' },
  '2026-10-02': { bike: 0, steps: 0, plank: [45] },
};
async function legacyInstall() {
  const d = new MemoryDriver();
  const set = (k, v) => d.set(k, JSON.stringify(v));
  await set('health_meta', { schemaVersion: CURRENT_SCHEMA_VERSION, seededAt: '2026-01-01T00:00:00.000Z' });
  await set('metrics_log', { water: WATER, weight: { '2026-10-01': 74.2 } });
  await set('sleep_log', [SLEEP_ENTRY]);
  await set('activity_days', ACTIVITY_DAYS);
  await set('activity_goals', { bike_minutes: 45, steps: 8000, water_liters: 2.3, plank_seconds: 60 });
  return d;
}

/* ---------- 1–3. шаги: дата, правка, без дублей ---------- */

test('1. шаги за выбранную прошлую дату: сохраняются на эту дату, одна запись на день', async () => {
  const s = await fresh();
  const r = await s.saveDailyActivity('steps', steps('2026-09-20', '8 450'));
  assert.equal(r.date, '2026-09-20');
  const log = await s.getDailyActivityLog('steps');
  assert.deepEqual(Object.keys(log), ['2026-09-20']);
  assert.equal(log['2026-09-20'].steps, 8450);
  assert.equal(log['2026-09-20'].source, 'manual');
  assert.ok(isValidStepsLog(log));
});

test('2. правка шагов: значение и заметка меняются, происхождение и createdAt — нет', async () => {
  const s = await fresh();
  const { entry: first } = await s.saveDailyActivity('steps', steps('2026-10-03', 5000));
  await s.saveDailyActivity('steps', steps('2026-10-03', 6200, 'беговая дорожка'), { from: '2026-10-03' });
  const e = await s.getDailyActivity('steps', '2026-10-03');
  assert.equal(e.steps, 6200);
  assert.equal(e.note, 'беговая дорожка');
  assert.equal(e.createdAt, first.createdAt);
  assert.equal(Object.keys(await s.getDailyActivityLog('steps')).length, 1);
});

test('3. нет дубля шагов за день: повторная запись даты → DUPLICATE_DATE, замена — всё равно одна запись', async () => {
  const s = await fresh();
  await s.saveDailyActivity('steps', steps('2026-10-04', 7000));
  await assert.rejects(s.saveDailyActivity('steps', steps('2026-10-04', 9000)), (e) => e instanceof ActivityStoreError && e.code === 'DUPLICATE_DATE' && e.existing.steps === 7000);
  assert.equal((await s.getDailyActivity('steps', '2026-10-04')).steps, 7000, 'без подтверждения ничего не затёрто');
  await s.saveDailyActivity('steps', steps('2026-10-04', 9000), { overwrite: true });
  const log = await s.getDailyActivityLog('steps');
  assert.deepEqual(Object.keys(log), ['2026-10-04']);
  assert.equal(log['2026-10-04'].steps, 9000);
  /* перенос на занятую дату — тоже только с подтверждением, и дубля не остаётся */
  await s.saveDailyActivity('steps', steps('2026-10-01', 3000));
  await assert.rejects(s.saveDailyActivity('steps', steps('2026-10-04', 3000), { from: '2026-10-01' }), (e) => e.code === 'DUPLICATE_DATE');
  await s.saveDailyActivity('steps', steps('2026-10-04', 3000), { from: '2026-10-01', overwrite: true });
  assert.deepEqual(await s.getDailyActivityLog('steps'), { '2026-10-04': { ...(await s.getDailyActivity('steps', '2026-10-04')) } });
  assert.equal((await s.getDailyActivity('steps', '2026-10-04')).steps, 3000);
});

test('шаги: ввод «8 450», беговая дорожка — те же шаги, будущее и мусор отклоняются', () => {
  assert.equal(steps('2026-10-05', '8 450').steps, 8450);
  assert.equal(normalizeDailyInput('steps', { date: '2026-10-06', value: 100 }, { today: TODAY }).ok, false, 'будущая дата');
  assert.equal(normalizeDailyInput('steps', { date: '2026-10-05', value: 'много' }, { today: TODAY }).ok, false);
  assert.equal(normalizeDailyInput('steps', { date: '2026-10-05', value: STEPS_MAX + 1 }, { today: TODAY }).ok, false);
  assert.equal(normalizeDailyInput('steps', { date: '2026-02-30', value: 1 }, { today: TODAY }).ok, false, 'несуществующая дата');
  assert.equal(parseActivityNumber('6,4'), 6.4);
  assert.equal(plain(fmtActivity('steps', 8450)), '8 450 шагов');
  assert.equal(plain(fmtActivity('steps', 1)), '1 шаг');
  assert.equal(plain(fmtActivity('steps', 3)), '3 шага');
  assert.equal(fmtActivity('walk', 6.4), '6,4 км');
  assert.equal(fmtActivity('bike', 18.2), '18,2 км');
  assert.deepEqual(Object.keys(ACTIVITY_METRICS), ['steps', 'walk', 'bike']);
});

/* ---------- 4–5. дистанция пешком ---------- */

test('4. дистанция пешком: «6,4» км за дату', async () => {
  const s = await fresh();
  await s.saveDailyActivity('walk', walk('2026-10-02', '6,4'));
  const log = await s.getDailyActivityLog('walk');
  assert.equal(log['2026-10-02'].km, 6.4);
  assert.ok(isValidWalkLog(log));
  assert.equal(dayValues('walk', log)['2026-10-02'], 6.4);
});

test('5. правка пешей дистанции и перенос на другую дату одной операцией', async () => {
  const s = await fresh();
  await s.saveDailyActivity('walk', walk('2026-10-02', 6.4));
  await s.saveDailyActivity('walk', walk('2026-10-02', '7,25'), { from: '2026-10-02' });
  assert.equal((await s.getDailyActivity('walk', '2026-10-02')).km, 7.25);
  await s.saveDailyActivity('walk', walk('2026-09-30', '7,25'), { from: '2026-10-02' });
  const log = await s.getDailyActivityLog('walk');
  assert.deepEqual(Object.keys(log), ['2026-09-30']);
  assert.equal(log['2026-09-30'].km, 7.25);
  await assert.rejects(s.saveDailyActivity('walk', walk('2026-10-01', 1), { from: '2026-10-03' }), (e) => e.code === 'NOT_FOUND');
});

/* ---------- 6–9. велосипед ---------- */

test('6–7. несколько поездок за день, итог дня — сумма: 7,4 + 12,1 = 19,5 км', async () => {
  const s = await fresh();
  await s.addBikeRide(ride('2026-10-04', '18:20', '12,1'));
  await s.addBikeRide(ride('2026-10-04', '08:30', '7,4'));
  await s.addBikeRide(ride('2026-10-03', '', '0,3'));
  const rides = await s.getBikeRides();
  assert.equal(rides.length, 3);
  assert.ok(isValidBikeLog(rides));
  const day = ridesByDate(rides).get('2026-10-04');
  assert.deepEqual(day.map((r) => r.time), ['08:30', '18:20'], 'внутри дня — по времени');
  assert.equal(rideDayKm(day), 19.5);
  const v = dayValues('bike', rides);
  assert.deepEqual(v, { '2026-10-04': 19.5, '2026-10-03': 0.3 });
  assert.equal(fmtActivity('bike', v['2026-10-04']), '19,5 км');
  /* 0,1 + 0,2 без «0,30000000000000004» */
  assert.equal(rideDayKm([{ km: 0.1 }, { km: 0.2 }]), 0.3);
});

test('8. удаление одной поездки — итог дня пересчитан, остальные поездки на месте', async () => {
  const s = await fresh();
  const a = await s.addBikeRide(ride('2026-10-04', '08:30', 7.4));
  await s.addBikeRide(ride('2026-10-04', '18:20', 12.1));
  assert.equal((await s.removeBikeRide(a.id)).id, a.id);
  assert.equal(await s.removeBikeRide(a.id), null, 'повторное удаление — ничего');
  const rides = await s.getBikeRides();
  assert.equal(rides.length, 1);
  assert.equal(dayValues('bike', rides)['2026-10-04'], 12.1);
});

test('9. перенос поездки на другую дату: оба дня пересчитаны, id и происхождение сохранены', async () => {
  const s = await fresh();
  const a = await s.addBikeRide(ride('2026-10-04', '08:30', 7.4));
  await s.addBikeRide(ride('2026-10-04', '18:20', 12.1));
  const moved = await s.updateBikeRide(a.id, ride('2026-10-01', '08:30', 7.4));
  assert.equal(moved.id, a.id);
  assert.equal(moved.createdAt, a.createdAt);
  assert.equal(moved.source, 'manual');
  const v = dayValues('bike', await s.getBikeRides());
  assert.deepEqual(v, { '2026-10-04': 12.1, '2026-10-01': 7.4 });
  assert.equal(await s.updateBikeRide('нет-такой', ride('2026-10-01', '', 1)), null);
  await assert.rejects(s.updateBikeRide(a.id, { date: '2026-10-01', km: -1 }), (e) => e.code === 'INVALID');
});

test('поездка: нужна дистанция или минуты; время необязательно; мусор отклоняется', () => {
  assert.equal(normalizeRideInput({ date: '2026-10-04' }, { today: TODAY }).ok, false);
  assert.equal(normalizeRideInput({ date: '2026-10-04', km: '0' }, { today: TODAY }).ok, false);
  assert.equal(normalizeRideInput({ date: '2026-10-04', km: '5', time: '25:00' }, { today: TODAY }).ok, false);
  assert.equal(normalizeRideInput({ date: '2026-10-04', minutes: '40' }, { today: TODAY }).ok, true);
  assert.equal(isValidRide({ id: 'x', date: '2026-10-04', km: null, minutes: null }), false);
});

/* ---------- 10. журнал прошлой даты (уровень данных) ---------- */

test('10. журнал прошлой даты: запись задним числом в другом месяце и году, правка и удаление там же', async () => {
  const s = await fresh();
  await s.saveDailyActivity('steps', steps('2025-12-31', 12000));
  await s.addBikeRide(ride('2025-12-31', '10:00', 21));
  assert.equal((await s.getDailyActivity('steps', '2025-12-31')).steps, 12000);
  await s.saveDailyActivity('steps', steps('2025-12-31', 11000), { from: '2025-12-31' });
  assert.equal((await s.getDailyActivity('steps', '2025-12-31')).steps, 11000);
  assert.equal((await s.removeDailyActivity('steps', '2025-12-31')).steps, 11000);
  assert.equal(await s.getDailyActivity('steps', '2025-12-31'), null);
  assert.equal(ridesByDate(await s.getBikeRides()).get('2025-12-31').length, 1);
  assert.deepEqual(latestValue({ '2025-12-31': 1, '2026-10-06': 2 }, TODAY), { date: '2025-12-31', value: 1 }, 'будущее не «последнее»');
  assert.deepEqual(lastDays({ '2026-10-05': 5, '2026-10-03': 3 }, 3, TODAY), [{ date: '2026-10-03', value: 3 }, { date: '2026-10-04', value: null }, { date: '2026-10-05', value: 5 }]);
});

/* ---------- 11–14. статистика ---------- */
const VALUES = {
  '2025-12-31': 100, // прошлый год — не входит ни в один период 2026
  '2026-03-10': 9000,
  '2026-09-01': 20000, '2026-09-15': 2000,
  '2026-09-28': 8000, '2026-09-29': 10000, '2026-10-01': 6000, '2026-10-02': 12000, '2026-10-04': 4000,
  '2026-10-05': 3000,
  '2026-10-20': 50000, // будущее — не входит
};

test('11. неделя (Пн–Вс): среднее по дням с записями, максимум, минимум, дни с данными, сумма', () => {
  const st = activityPeriodStats(VALUES, 'week', '2026-10-01', TODAY);
  assert.equal(st.start, '2026-09-28');
  assert.equal(st.end, '2026-10-04');
  assert.equal(st.elapsedDays, 7);
  assert.equal(st.daysWithData, 5);
  assert.equal(st.total, 40000);
  assert.equal(st.average, 8000);
  assert.deepEqual(st.max, { date: '2026-10-02', value: 12000 });
  assert.deepEqual(st.min, { date: '2026-10-04', value: 4000 });
  assert.equal(st.bars.length, 7);
  assert.deepEqual(st.bars.map((b) => b.value), [8000, 10000, null, 6000, 12000, null, 4000], 'пропуск — null, не 0');
  /* текущая неделя: будущие дни не в «прошедших днях» и не в столбцах */
  const cur = activityPeriodStats(VALUES, 'week', TODAY, TODAY);
  assert.equal(cur.elapsedDays, 1);
  assert.equal(cur.average, 3000);
  assert.ok(cur.bars.slice(1).every((b) => b.value == null));
});

test('12. месяц: сентябрь целиком и текущий октябрь до сегодня (будущее исключено)', () => {
  const sep = activityPeriodStats(VALUES, 'month', '2026-09-15', TODAY);
  assert.equal(sep.start, '2026-09-01');
  assert.equal(sep.end, '2026-09-30');
  assert.equal(sep.elapsedDays, 30);
  assert.equal(sep.daysWithData, 4);
  assert.equal(sep.total, 40000);
  assert.equal(sep.average, 10000);
  assert.equal(sep.max.value, 20000);
  assert.equal(sep.min.value, 2000);
  assert.equal(sep.bars.length, 30);
  const oct = activityPeriodStats(VALUES, 'month', '2026-10-04', TODAY);
  assert.equal(oct.elapsedDays, 5);
  assert.equal(oct.daysWithData, 4);
  assert.equal(oct.total, 25000);
  assert.equal(oct.average, 6250);
  assert.ok(!oct.bars.some((b) => b.value === 50000), 'будущая запись не на графике');
});

test('13. год: 12 месячных столбцов (среднее за день с записями и сумма), исходные дни не теряются', () => {
  const y = activityPeriodStats(VALUES, 'year', '2026-06-01', TODAY);
  assert.equal(y.start, '2026-01-01');
  assert.equal(y.end, '2026-12-31');
  assert.equal(y.bars.length, 12, 'год — 12 столбцов, а не 365');
  assert.equal(y.daysWithData, 9);
  assert.equal(y.total, 74000);
  assert.ok(Math.abs(y.average - 74000 / 9) < 1e-9);
  assert.equal(y.bars[2].value, 9000);
  assert.equal(y.bars[8].value, 10000);
  assert.equal(y.bars[8].total, 40000);
  assert.equal(y.bars[8].days, 4);
  assert.equal(y.bars[9].value, 6250);
  assert.equal(y.bars[0].value, null);
  assert.equal(y.max.value, 20000);
  assert.equal(y.min.value, 2000);
  assert.equal(VALUES['2026-10-20'], 50000, 'вход не изменён');
});

test('14. переключение Неделя → Месяц → Год пересчитывает все показатели, а не только график', () => {
  const anchor = '2026-09-29';
  const [w, m, y] = ['week', 'month', 'year'].map((k) => activityPeriodStats(VALUES, k, anchor, TODAY));
  assert.deepEqual([w.average, m.average].map(Math.round), [8000, 10000]);
  assert.notEqual(w.average, m.average);
  assert.notEqual(m.average, y.average);
  assert.notEqual(w.daysWithData, m.daysWithData);
  assert.notEqual(m.daysWithData, y.daysWithData);
  assert.notEqual(w.max.value, m.max.value);
  assert.notEqual(w.min.value, m.min.value);
  assert.notEqual(w.total, y.total);
  /* обратно на неделю — те же числа (ничего не «залипает» от предыдущего диапазона) */
  assert.deepEqual(activityPeriodStats(VALUES, 'week', anchor, TODAY), w);
  /* сравнение с прошлым периодом */
  const c = comparePrevPeriod(VALUES, 'week', '2026-10-01', TODAY);
  assert.equal(c, null, 'в неделе 21–27 сент. записей нет — сравнения нет');
  const cm = comparePrevPeriod(VALUES, 'month', '2026-10-01', TODAY);
  assert.equal(cm.delta, 6250 - 10000);
});

/* ---------- 15–16. вода и сон не меняются ---------- */

test('15–16. существующие вода и сон: байт-в-байт после запуска, миграции и работы с новыми разделами', async () => {
  const d = await legacyInstall();
  const before = { water: await d.get('metrics_log'), sleep: await d.get('sleep_log'), act: await d.get('activity_days'), goals: await d.get('activity_goals') };
  const s = await new StorageService(d).init();
  await s.saveDailyActivity('steps', steps('2026-10-04', 5000));
  await s.saveDailyActivity('walk', walk('2026-10-04', 4.2));
  const r = await s.addBikeRide(ride('2026-10-04', '08:00', 10));
  await s.removeBikeRide(r.id);
  assert.equal(await d.get('metrics_log'), before.water, 'вода (metrics_log) не изменилась');
  assert.equal(await d.get('sleep_log'), before.sleep, 'сон не изменился');
  assert.equal(await d.get('activity_days'), before.act, 'старая «Активность» не изменена');
  assert.equal(await d.get('activity_goals'), before.goals);
  assert.equal((await s.getWaterDay('2026-10-01')).total, 1800);
  assert.equal((await s.getSleepEntries())[0].durationMinutes, 450);
});

test('сон через полночь: 23:40 → 07:10 = 7 ч 30 мин, дата записи — день пробуждения', () => {
  const r = normalizeSleepInput({ bedDate: inferBedDate('2026-10-04', '23:40', '07:10'), bedTime: '23:40', wakeDate: '2026-10-04', wakeTime: '07:10' }, { today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.value.date, '2026-10-04');
  assert.equal(r.value.sleepStart, '2026-10-03T23:40');
  assert.equal(r.value.durationMinutes, 450);
  assert.equal(formatSleepDuration(450).replace(/ /g, ' '), '7 ч 30 мин');
});

/* ---------- 17–19. резервная копия ---------- */

test('17. бэкап содержит новые разделы и проходит самопроверку', async () => {
  const s = await fresh();
  await s.saveDailyActivity('steps', steps('2026-10-04', 8450));
  await s.saveDailyActivity('walk', walk('2026-10-04', 6.4));
  await s.addBikeRide(ride('2026-10-04', '08:30', 7.4));
  const b = await s.exportBackup();
  assert.equal(b.data.steps_log['2026-10-04'].steps, 8450);
  assert.equal(b.data.walk_log['2026-10-04'].km, 6.4);
  assert.equal(b.data.bike_log.length, 1);
  assert.equal(b.data.activity_migration.version, 1);
  const created = await s.createBackup();
  assert.equal(created.verified, true);
  const prepared = await s.prepareRestore(parseBackup(created.json));
  assert.deepEqual([prepared.summary.steps, prepared.summary.walk, prepared.summary.bike], [1, 1, 1]);
});

test('18. восстановление новых разделов: атомарно, данные совпадают, повреждённый раздел отклоняется', async () => {
  const src = await fresh();
  await src.saveDailyActivity('steps', steps('2026-10-04', 8450));
  await src.saveDailyActivity('walk', walk('2026-10-03', 3.1));
  await src.addBikeRide(ride('2026-10-04', '08:30', 7.4));
  await src.addBikeRide(ride('2026-10-04', '18:20', 12.1));
  const json = (await src.createBackup()).json;

  const dst = await fresh();
  await dst.saveDailyActivity('steps', steps('2026-01-01', 1)); // прежние данные устройства заменяются копией целиком
  await dst.restoreBackup(await dst.prepareRestore(parseBackup(json)));
  assert.deepEqual(await dst.getDailyActivityLog('steps'), await src.getDailyActivityLog('steps'));
  assert.deepEqual(await dst.getDailyActivityLog('walk'), await src.getDailyActivityLog('walk'));
  assert.deepEqual(await dst.getBikeRides(), await src.getBikeRides());
  assert.equal(dayValues('bike', await dst.getBikeRides())['2026-10-04'], 19.5);

  const bad = JSON.parse(json);
  bad.data.steps_log['2026-10-04'].steps = -5;
  await assert.rejects(dst.prepareRestore(bad), (e) => e instanceof BackupError && e.code === 'CORRUPT' && /Шаги/.test(e.message));
  const bad2 = JSON.parse(json);
  bad2.data.bike_log[0].km = 'много';
  await assert.rejects(dst.prepareRestore(bad2), (e) => e instanceof BackupError && /Велосипед/.test(e.message));
  assert.equal((await dst.getDailyActivity('steps', '2026-10-04')).steps, 8450, 'отклонённая копия ничего не изменила');
});

test('19. импорт старой копии (без новых разделов): шаги и велотренажёр переносятся, остальное как было', async () => {
  for (const schemaVersion of [CURRENT_SCHEMA_VERSION, 2]) {
    const old = {
      app: 'lexlife', backupFormatVersion: 2, schemaVersion, createdAt: '2026-10-01T10:00:00.000Z',
      data: {
        health_meds: [], health_visits: [], health_tests: [], activity_days: ACTIVITY_DAYS,
        ...(schemaVersion >= 5 ? { metrics_log: { water: WATER } } : {}),
        ...(schemaVersion >= 8 ? { sleep_log: [SLEEP_ENTRY] } : {}),
      },
    };
    const s = await fresh();
    const prepared = await s.prepareRestore(parseBackup(JSON.stringify(old)));
    await s.restoreBackup(prepared);
    const st = await s.getDailyActivityLog('steps');
    assert.deepEqual(Object.keys(st).sort(), ['2026-09-29', '2026-09-30'], `шаги > 0 перенесены (схема ${schemaVersion})`);
    assert.equal(st['2026-09-29'].steps, 7300);
    assert.equal(st['2026-09-29'].source, 'activity');
    const rides = await s.getBikeRides();
    assert.deepEqual(rides.map((r) => [r.date, r.minutes, r.km]).sort(), [['2026-09-29', 40, null], ['2026-10-01', 25, null]]);
    assert.deepEqual(await s.getDailyActivityLog('walk'), {});
    assert.deepEqual(await s._read('activity_days'), ACTIVITY_DAYS, 'activity_days восстановлен как есть');
    if (schemaVersion >= 8) {
      assert.deepEqual((await s.getWaterDay('2026-10-01')).entries, WATER['2026-10-01'].entries);
      assert.equal((await s.getSleepEntries()).length, 1);
    }
  }
});

/* ---------- 20. миграция старой «Активности» ---------- */

test('20. миграция: однократная, без дублей, без возврата удалённого, activity_days не меняется', async () => {
  const d = await legacyInstall();
  const actBefore = await d.get('activity_days');
  const s = await new StorageService(d).init();
  const st = await s.getDailyActivityLog('steps');
  assert.deepEqual(Object.keys(st).sort(), ['2026-09-29', '2026-09-30'], '0 и null не переносятся');
  const rides = await s.getBikeRides();
  assert.deepEqual(rides.map((r) => r.id).sort(), ['legacy-2026-09-29', 'legacy-2026-10-01']);
  assert.match(rides.find((r) => r.id === 'legacy-2026-09-29').note, /Велотренажёр · интенсивность: средняя/);
  const marker = await s._read('activity_migration');
  assert.deepEqual([marker.stepsAdded, marker.bikeAdded, marker.version], [2, 2, 1]);
  assert.equal(await d.get('activity_days'), actBefore);

  /* повторный запуск — ничего нового */
  const snap = [await d.get('steps_log'), await d.get('bike_log'), await d.get('activity_migration')];
  await new StorageService(d).init();
  assert.deepEqual([await d.get('steps_log'), await d.get('bike_log'), await d.get('activity_migration')], snap);

  /* пользователь удалил перенесённое — после перезапуска оно не возвращается */
  await s.removeDailyActivity('steps', '2026-09-29');
  await s.removeBikeRide('legacy-2026-10-01');
  const s2 = await new StorageService(d).init();
  assert.equal(await s2.getDailyActivity('steps', '2026-09-29'), null);
  assert.equal((await s2.getBikeRides()).length, 1);

  /* и после восстановления НОВОЙ копии этого устройства тоже (отметка едет вместе с данными) */
  const json = (await s2.createBackup()).json;
  const s3 = await fresh();
  await s3.restoreBackup(await s3.prepareRestore(parseBackup(json)));
  assert.equal(await s3.getDailyActivity('steps', '2026-09-29'), null);
  assert.equal((await s3.getBikeRides()).length, 1);
});

test('миграция: существующие записи не перезаписываются, прерванный перенос не дублирует, мусор пропускается', async () => {
  const d = await legacyInstall();
  /* шаги этой даты уже введены в новом разделе; перенос был прерван после записи поездок, но до отметки */
  await d.set('steps_log', JSON.stringify({ '2026-09-29': { steps: 11111, note: 'вручную', source: 'manual', createdAt: null, updatedAt: null } }));
  await d.set('bike_log', JSON.stringify([{ id: 'legacy-2026-09-29', date: '2026-09-29', time: null, km: null, minutes: 40, note: '', source: 'activity', createdAt: null, updatedAt: null }]));
  const s = await new StorageService(d).init();
  assert.equal((await s.getDailyActivity('steps', '2026-09-29')).steps, 11111, 'ручная запись сохранена');
  assert.equal((await s.getDailyActivity('steps', '2026-09-30')).steps, 9100);
  assert.equal((await s.getBikeRides()).filter((r) => r.id === 'legacy-2026-09-29').length, 1, 'без дубля поездки');
  const m = await s._read('activity_migration');
  assert.deepEqual([m.stepsAdded, m.stepsSkipped, m.bikeAdded, m.bikeSkipped], [1, 1, 1, 1]);

  const res = migrateLegacyActivity({ activityDays: { '2026-10-01': { steps: 1e9, bike: 99999 }, bad: { steps: 5 }, '2026-10-02': 'x' }, stepsLog: {}, bikeLog: [] });
  assert.deepEqual(res.stepsLog, {});
  assert.deepEqual(res.bikeLog, []);
  assert.equal(res.marker.invalid, 2);
  assert.equal(res.changed, false);
});

test('свежая установка: пустые разделы и отметка миграции; старые API «Активности» не сломаны', async () => {
  const s = await fresh();
  assert.deepEqual(await s.getDailyActivityLog('steps'), {});
  assert.deepEqual(await s.getDailyActivityLog('walk'), {});
  assert.deepEqual(await s.getBikeRides(), []);
  assert.equal((await s._read('activity_migration')).version, 1);
  assert.deepEqual(await s.getAllActivity(), {});
  await s.verifyIntegrity();
});

test('«Статистика»: три самостоятельных блока — шаги, пешком, велосипед; общего «activity» нет', () => {
  const engine = createStatsEngine({
    activityDays: { '2026-10-01': { steps: 7000, bike: 30 }, '2026-10-02': { steps: 5000 } },
    stepsLog: { '2026-10-02': { steps: 5000 }, '2026-10-03': { steps: 9000 } },
    walkLog: { '2026-10-03': { km: 6.4 }, '2026-10-04': { km: 3.6 } },
    bikeLog: [
      { id: 'a', date: '2026-10-04', time: '08:30', km: 7.4 }, { id: 'b', date: '2026-10-04', time: '18:20', km: 12.1 },
      { id: 'legacy-2026-10-01', date: '2026-10-01', time: null, km: null, minutes: 35, source: 'activity' },
    ],
  }, TODAY);
  /* шаги — только из steps_log: удалённый перенесённый день не возвращается из activity_days */
  assert.deepEqual(engine.series.steps.map((p) => [p.date, p.value]), [['2026-10-02', 5000], ['2026-10-03', 9000]]);
  assert.deepEqual(engine.series.walk.map((p) => [p.date, p.value]), [['2026-10-03', 6.4], ['2026-10-04', 3.6]]);
  assert.deepEqual(engine.series.bike.map((p) => [p.date, p.value]), [['2026-10-04', 19.5]], 'велотренажёр без км — не 0 км и не точка ряда');
  assert.equal('activityMin' in engine.series, false);
  const m = engine.forPeriod('7d');
  assert.equal('activity' in m, false, 'общего блока «Активность» в модели нет');
  assert.equal(m.steps.stats.avg, 7000);
  assert.equal(m.walk.stats.avg, 5);
  assert.equal(m.bike.stats.avg, 19.5);
  assert.equal(m.bike.best.value, 19.5);
  assert.deepEqual(m.bike.noKm, { count: 1, minutes: 35, totalAll: 1 }, 'поездки без дистанции — отдельно');
  assert.equal(m.bike.buckets.length, 7);
  const legacy = createStatsEngine({ activityDays: { '2026-10-01': { steps: 7000 } } }, TODAY);
  assert.deepEqual(legacy.series.steps.map((p) => p.value), [7000], 'старый вызов без steps_log — как раньше');
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
