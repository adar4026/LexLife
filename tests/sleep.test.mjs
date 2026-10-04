/* =========================================================
   tests/sleep.test.mjs — модуль «Сон»: длительность по настоящим моментам времени
   (полночь, CET/CEST), дата записи = день пробуждения, валидация, средние без
   пропущенных дней, циклическое среднее времени, цель и серии, агрегации,
   сравнение периодов, наблюдения по факторам, хранилище, резервная копия.
   Без браузера: services/sleep.js + StorageService на MemoryDriver. Только синтетические данные.
   run-all запускает файл в нескольких timezone (Мадрид, Лос-Анджелес, Токио, UTC).

   Запуск:  node tests/sleep.test.mjs     (или TZ=Europe/Madrid node tests/sleep.test.mjs)
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, BackupError, SleepStoreError, CURRENT_SCHEMA_VERSION } from '../js/services/storage.js';
import {
  calculateDuration, formatSleepDuration as rawDuration, formatSleepDelta as rawDelta, sleepDateFor, inferBedDate, normalizeSleepInput,
  isValidSleepEntry, getSleepForDate, averageSleep, averageBedtime, averageWakeTime, circularMeanMinutes, clockDiff,
  sleepGoalRate, currentSleepStreak, bestSleepStreak, averageQuality, sleepConsistency, aggregateByWeek, aggregateByMonth,
  aggregateByYear, comparePeriods, factorInsights, periodBounds, shiftPeriod, entriesInRange, napMinutes,
  totalDayMinutes, defaultSleepSettings, normalizeSleepSettings, isValidSleepSettings, clampSleepGoal, sleepReminderRules,
  SLEEP_REMINDER_TYPES, SLEEP_TAG_KEYS, minutesToClock, addDays, insightText as rawInsight,
  SLEEP_SOURCES, sleepSource, sleepExternalKey, findSleepByExternalId, isValidSleepLog,
} from '../js/services/sleep.js';
import { nextFire } from '../js/services/notifySchedule.js';

/* в интерфейсе число и единица — через неразрывный пробел; в проверках сравниваем как обычный текст */
const plain = (f) => (...a) => f(...a).replace(/\u00a0/g, ' ');
const formatSleepDuration = plain(rawDuration);
const formatSleepDelta = plain(rawDelta);
const insightText = plain(rawInsight);
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TODAY = '2026-10-04';
async function fresh() {
  const s = new StorageService(new MemoryDriver());
  await s.init();
  return s;
}
/* форма: лёг bed (дата накануне по умолчанию) → проснулся wake в день date */
const form = (o = {}) => normalizeSleepInput({
  wakeDate: TODAY, bedTime: '23:40', wakeTime: '07:20', quality: 4, awakenings: 1, ...o,
  bedDate: o.bedDate || inferBedDate(o.wakeDate || TODAY, o.bedTime || '23:40', o.wakeTime || '07:20'),
}, { today: TODAY });
/* запись для аналитики: дата, длительность (мин), время засыпания */
function entry(date, minutes, { bed = '23:00', quality = null, tags = [], naps = [] } = {}) {
  const start = `${addDays(date, bed >= '12:00' ? -1 : 0)}T${bed}`;
  const startMin = Number(bed.slice(0, 2)) * 60 + Number(bed.slice(3));
  const endMin = (startMin + minutes) % 1440;
  return { id: `e_${date}`, date, sleepStart: start, sleepEnd: `${date}T${minutesToClock(endMin)}`, durationMinutes: minutes, quality, awakenings: 0, naps, tags, note: '' };
}

/* ================= длительность и дата ================= */

test('длительность: 23:00 → 07:00 = 8 ч', () => {
  assert.equal(calculateDuration('2026-10-03T23:00', '2026-10-04T07:00'), 480);
  assert.equal(formatSleepDuration(480), '8 ч');
});

test('через полночь: 23:50 → 00:20 = 30 мин', () => {
  assert.equal(calculateDuration('2026-10-03T23:50', '2026-10-04T00:20'), 30);
  assert.equal(formatSleepDuration(30), '30 мин');
  const r = form({ bedTime: '23:50', wakeTime: '00:20' });
  assert.equal(r.ok, true);
  assert.equal(r.value.durationMinutes, 30);
  assert.equal(r.value.sleepStart, '2026-10-03T23:50');
});

test('дата записи: сон 3 → 4 октября относится к 4 октября; 23:40 → 07:20 = 7 ч 40 мин', () => {
  const r = form({ bedTime: '23:40', wakeTime: '07:20' });
  assert.equal(r.ok, true);
  assert.equal(r.value.date, '2026-10-04');
  assert.equal(r.value.sleepStart, '2026-10-03T23:40');
  assert.equal(r.value.sleepEnd, '2026-10-04T07:20');
  assert.equal(r.value.durationMinutes, 460);
  assert.equal(formatSleepDuration(r.value.durationMinutes), '7 ч 40 мин');
  assert.equal(sleepDateFor('2026-10-04T07:20'), '2026-10-04');
});

test('дата засыпания по умолчанию: вечер — накануне, после полуночи — тот же день; 23:30 → 07:30', () => {
  assert.equal(inferBedDate('2026-10-04', '23:30', '07:30'), '2026-10-03');
  assert.equal(inferBedDate('2026-10-04', '00:30', '08:00'), '2026-10-04');
  assert.equal(inferBedDate('2026-11-01', '23:00', '07:00'), '2026-10-31'); // через конец месяца
  assert.equal(inferBedDate('2027-01-01', '23:00', '07:00'), '2026-12-31'); // через новый год
  const r = form({ bedTime: '23:30', wakeTime: '07:30' });
  assert.equal(r.value.durationMinutes, 480);
  assert.equal(r.value.date, '2026-10-04');
});

test('DST: длительность — между настоящими моментами (Испания: CET/CEST), а не «конец − начало» по часам', () => {
  const spring = calculateDuration('2026-03-28T23:00', '2026-03-29T07:00');
  const autumn = calculateDuration('2026-10-24T23:00', '2026-10-25T07:00');
  const real = (a, b) => Math.round((new Date(...b) - new Date(...a)) / 60000);
  assert.equal(spring, real([2026, 2, 28, 23, 0], [2026, 2, 29, 7, 0]));
  assert.equal(autumn, real([2026, 9, 24, 23, 0], [2026, 9, 25, 7, 0]));
  if (TZ === 'Europe/Madrid') {
    assert.equal(spring, 420, 'весна: часы вперёд — сон на час короче');
    assert.equal(autumn, 540, 'осень: часы назад — сон на час дольше');
    /* запись после перевода часов остаётся за день пробуждения */
    const r = normalizeSleepInput({ bedDate: '2026-10-24', bedTime: '23:30', wakeDate: '2026-10-25', wakeTime: '07:30' }, { today: '2026-10-26' });
    assert.equal(r.value.date, '2026-10-25');
    assert.equal(r.value.durationMinutes, 540);
  } else if (TZ === 'America/Los_Angeles') {
    assert.equal(calculateDuration('2026-03-07T23:00', '2026-03-08T07:00'), 420);
    assert.equal(calculateDuration('2026-10-31T23:00', '2026-11-01T07:00'), 540);
  } else {
    assert.equal(spring, 480);
    assert.equal(autumn, 480);
  }
});

test('формат: часы и минуты, разница со знаком', () => {
  assert.equal(formatSleepDuration(448), '7 ч 28 мин');
  assert.equal(formatSleepDuration(45), '45 мин');
  assert.equal(formatSleepDuration(null), '—');
  assert.equal(formatSleepDelta(18), '+18 мин');
  assert.equal(formatSleepDelta(-65), '−1 ч 5 мин');
  assert.equal(formatSleepDelta(0), '0 мин');
});

/* ================= валидация ================= */

test('невалидная запись не проходит: конец раньше начала, 0 мин, 36 ч, будущее, качество, пробуждения, дневной сон', () => {
  assert.equal(form({ bedDate: '2026-10-04', bedTime: '08:00', wakeTime: '07:00' }).errors.duration, 'Время пробуждения должно быть позже времени засыпания');
  assert.ok(form({ bedDate: '2026-10-04', bedTime: '07:20', wakeTime: '07:20' }).errors.duration);
  assert.equal(form({ bedDate: '2026-10-02', bedTime: '19:00', wakeTime: '07:00' }).errors.duration, 'Получается больше 20 часов сна — проверьте даты');
  assert.equal(form({ wakeDate: '2026-10-05' }).errors.end, 'Дата пробуждения не может быть в будущем');
  assert.ok(form({ quality: 6 }).errors.quality);
  assert.ok(form({ quality: 0 }).errors.quality);
  assert.ok(form({ awakenings: -1 }).errors.awakenings);
  assert.ok(form({ awakenings: 21 }).errors.awakenings);
  assert.ok(form({ napEnabled: true, napMinutes: -5 }).errors.nap);
  assert.ok(form({ napEnabled: true, napMinutes: 0 }).errors.nap);
  assert.ok(normalizeSleepInput({ wakeDate: TODAY, wakeTime: '07:00', bedDate: '', bedTime: '' }, { today: TODAY }).errors.start);
  for (const r of [form({ quality: 6 }), form({ awakenings: 21 })]) { assert.equal(r.ok, false); assert.equal(r.value, null); }
  /* структурная проверка (резервная копия) */
  const ok = { ...form().value, id: 'x1' };
  assert.equal(isValidSleepEntry(ok), true);
  for (const bad of [
    { ...ok, durationMinutes: 36 * 60 }, { ...ok, durationMinutes: 0 }, { ...ok, quality: 7 }, { ...ok, awakenings: -1 },
    { ...ok, naps: [{ minutes: -10 }] }, { ...ok, date: '2026-10-03' }, { ...ok, sleepStart: '2026-10-04T08:00' },
    { ...ok, id: '<img>' }, { ...ok, tags: ['<script>'] }, { ...ok, sleepEnd: '2026-10-04 07:20' },
  ]) assert.equal(isValidSleepEntry(bad), false, JSON.stringify(bad));
});

test('форма: допустимые граничные значения, теги только известные и по порядку, заметка обрезается', () => {
  const r = form({ quality: null, awakenings: 20, napEnabled: true, napMinutes: 30, tags: ['stress', 'xx', 'coffee', 'stress'], note: '  Долго не мог заснуть  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.quality, null, 'качество необязательно');
  assert.equal(r.value.awakenings, 20);
  assert.deepEqual(r.value.naps, [{ minutes: 30, start: null, end: null }]);
  assert.equal(napMinutes(r.value), 30);
  assert.equal(totalDayMinutes(r.value), 460 + 30);
  assert.deepEqual(r.value.tags, ['coffee', 'stress']);
  assert.equal(r.value.note, 'Долго не мог заснуть');
  assert.equal(form({ note: 'x'.repeat(5000) }).value.note.length, 1000);
  assert.equal(SLEEP_TAG_KEYS.join(','), 'coffee,alcohol,late_meal,stress,exercise,medication,illness,screen,travel,nap');
});

/* ================= средние ================= */

test('средняя продолжительность: только по дням с записью (пропуск — не 0 ч)', () => {
  const list = [entry('2026-10-01', 420), entry('2026-10-03', 480)]; // 2 октября пропущено
  assert.equal(averageSleep(list), 450);
  assert.equal(averageSleep([]), null);
  const month = aggregateByMonth(list, '2026-10-15');
  assert.equal(month.length, 31);
  assert.equal(month[1].minutes, null, 'пропущенный день — null');
  assert.equal(month[0].minutes, 420);
});

test('среднее время отхода ко сну: 23:50 и 00:10 ≈ 00:00, а не 12:00', () => {
  assert.equal(circularMeanMinutes([23 * 60 + 50, 10]), 0);
  const list = [entry('2026-10-03', 450, { bed: '23:50' }), entry('2026-10-04', 430, { bed: '00:10' })];
  assert.equal(minutesToClock(averageBedtime(list)), '00:00');
  assert.equal(minutesToClock(averageBedtime([entry('2026-10-03', 450, { bed: '23:30' }), entry('2026-10-04', 450, { bed: '00:30' })])), '00:00');
  assert.equal(minutesToClock(averageBedtime([entry('2026-10-03', 480, { bed: '22:00' }), entry('2026-10-04', 480, { bed: '23:00' })])), '22:30');
  assert.equal(circularMeanMinutes([0, 720]), null, 'противоположные времена — среднего нет');
  assert.equal(clockDiff(10, 1430), 20);
  assert.equal(clockDiff(1430, 10), -20);
});

test('среднее время подъёма и стабильность режима', () => {
  const same = ['2026-10-01', '2026-10-02', '2026-10-03'].map((d) => entry(d, 480, { bed: '23:00' }));
  assert.equal(minutesToClock(averageWakeTime(same)), '07:00');
  assert.equal(sleepConsistency(same), 100);
  assert.equal(sleepConsistency(same.slice(0, 2)), null, 'меньше 3 записей — не считается');
  const shifted = [entry('2026-10-01', 480, { bed: '22:00' }), entry('2026-10-02', 480, { bed: '23:00' }), entry('2026-10-03', 480, { bed: '00:00' })];
  // отклонения от 23:00 / 07:00: 60, 0, 60 → среднее 40 мин → 1 − 40/120
  assert.equal(sleepConsistency(shifted), 67);
  const chaos = [entry('2026-10-01', 480, { bed: '20:00' }), entry('2026-10-02', 480, { bed: '02:00' }), entry('2026-10-03', 480, { bed: '23:00' })];
  assert.ok(sleepConsistency(chaos) < 30);
});

test('среднее качество — только по оценённым ночам', () => {
  assert.equal(averageQuality([entry('2026-10-01', 400, { quality: 4 }), entry('2026-10-02', 400, { quality: 5 }), entry('2026-10-03', 400)]), 4.5);
  assert.equal(averageQuality([entry('2026-10-01', 400)]), null);
});

/* ================= цель и серии ================= */

test('выполнение цели: процент от дней с записью', () => {
  const list = [entry('2026-10-01', 480), entry('2026-10-02', 470), entry('2026-10-03', 500), entry('2026-10-04', 300)];
  assert.deepEqual(sleepGoalRate(list, 480), { met: 2, total: 4, rate: 0.5 });
  assert.deepEqual(sleepGoalRate([], 480), { met: 0, total: 0, rate: null });
});

test('текущая серия: подряд по сегодня; без записи сегодня — по вчера; пропуск и недосып прерывают', () => {
  const run = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'].map((d) => entry(d, 490));
  assert.equal(currentSleepStreak(run, 480, TODAY), 4, 'сегодня ещё не записано — считается по вчера');
  assert.equal(currentSleepStreak([...run, entry(TODAY, 500)], 480, TODAY), 5);
  assert.equal(currentSleepStreak([...run, entry(TODAY, 300)], 480, TODAY), 0, 'сегодня цель не выполнена');
  assert.equal(currentSleepStreak(run.filter((e) => e.date !== '2026-10-02'), 480, TODAY), 1, 'пропущенный день прерывает серию');
  assert.equal(currentSleepStreak([], 480, TODAY), 0);
});

test('лучшая серия: самая длинная цепочка дней подряд с выполненной целью', () => {
  const list = [
    ...['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => entry(d, 500)),
    entry('2026-09-04', 300),
    ...['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'].map((d) => entry(d, 480)),
    entry('2026-09-11', 520), // 10-е пропущено
  ];
  assert.equal(bestSleepStreak(list, 480), 5);
  assert.equal(bestSleepStreak([entry('2026-10-31', 500), entry('2026-11-01', 500)], 480), 2, 'через конец месяца (и смену времени в США)');
  assert.equal(bestSleepStreak([], 480), 0);
});

/* ================= периоды и агрегации ================= */

test('периоды: неделя Пн–Вс, месяц, год; сдвиг на предыдущий', () => {
  assert.deepEqual(periodBounds('week', '2026-10-04'), { kind: 'week', start: '2026-09-28', end: '2026-10-04' }); // 4.10 — воскресенье
  assert.deepEqual(periodBounds('week', '2026-10-05'), { kind: 'week', start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(periodBounds('month', '2026-02-10'), { kind: 'month', start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodBounds('year', '2026-10-04'), { kind: 'year', start: '2026-01-01', end: '2026-12-31' });
  assert.equal(shiftPeriod(periodBounds('month', '2026-01-15'), -1).start, '2025-12-01');
  assert.equal(shiftPeriod(periodBounds('week', '2026-10-04'), -1).start, '2026-09-21');
  assert.equal(shiftPeriod(periodBounds('week', '2026-10-25'), 1).start, '2026-10-26', 'неделя после перевода часов');
  assert.equal(shiftPeriod(periodBounds('year', '2026-10-04'), -1).end, '2025-12-31');
});

test('агрегации: неделя — 7 дней, месяц — по числам, год — средние по месяцам', () => {
  const list = [entry('2026-09-28', 420, { quality: 3 }), entry('2026-10-04', 480, { quality: 5 }), entry('2026-10-01', 450), entry('2026-08-10', 400)];
  const week = aggregateByWeek(list, TODAY);
  assert.deepEqual(week.map((x) => x.minutes), [420, null, null, 450, null, null, 480]);
  const year = aggregateByYear(list, TODAY);
  assert.equal(year.length, 12);
  assert.equal(year[9].minutes, 465);
  assert.equal(year[9].count, 2);
  assert.equal(year[8].minutes, 420);
  assert.equal(year[8].quality, 3);
  assert.equal(year[0].minutes, null);
  assert.deepEqual(entriesInRange(list, '2026-10-01', '2026-10-31').map((e) => e.date), ['2026-10-01', '2026-10-04']);
});

test('getSleepForDate и одна запись на дату (самая длинная, если по ошибке их две)', () => {
  const a = entry('2026-10-04', 400);
  const b = { ...entry('2026-10-04', 450), id: 'other' };
  assert.equal(getSleepForDate([a, b], '2026-10-04').id, 'other');
  assert.equal(getSleepForDate([a], '2026-10-03'), null);
  assert.equal(averageSleep(entriesInRange([a, b], '2026-10-01', '2026-10-31')), 450);
});

test('сравнение периодов: разница средних; без данных предыдущего периода — нет сравнения', () => {
  assert.deepEqual(comparePeriods([entry('2026-10-01', 450)], [entry('2026-09-01', 432)]), { current: 450, previous: 432, delta: 18 });
  assert.equal(comparePeriods([entry('2026-10-01', 450)], []), null);
});

/* ================= наблюдения по факторам ================= */

test('факторы: только при ≥ 5 днях с фактором и ≥ 5 без; без причинных формулировок', () => {
  const days = Array.from({ length: 12 }, (_, i) => addDays('2026-09-01', i));
  const list = days.map((d, i) => (i < 5
    ? entry(d, 420, { quality: 3, tags: ['stress'] })
    : entry(d, 458, { quality: 4, tags: i % 2 ? ['exercise'] : [] })));
  const ins = factorInsights(list);
  const stressDur = ins.find((x) => x.key === 'stress' && x.kind === 'duration');
  assert.ok(stressDur);
  assert.equal(stressDur.delta, -38);
  assert.equal(insightText(stressDur), 'В дни со стрессом сон в среднем был на 38 мин короче (7 ч против 7 ч 38 мин).');
  const stressQ = ins.find((x) => x.key === 'stress' && x.kind === 'quality');
  assert.equal(insightText(stressQ), 'В дни со стрессом качество сна в среднем было 3,0 против 4,0.');
  assert.ok(!ins.some((x) => x.key === 'exercise'), 'тренировка: 3 дня — мало данных');
  assert.deepEqual(factorInsights(list.slice(0, 9)), [], 'без фактора только 4 дня — вывод не показывается');
  for (const x of ins) assert.doesNotMatch(insightText(x), /вызыва|приводит|из-за|потому/);
});

/* ================= настройки и напоминания ================= */

test('настройки: по умолчанию 8 ч, цель 4–12 ч с шагом 15 мин, сохранение лишних полей', () => {
  const d = defaultSleepSettings();
  assert.equal(d.goalMinutes, 480);
  assert.equal(isValidSleepSettings(d), true);
  assert.equal(clampSleepGoal(100), 240);
  assert.equal(clampSleepGoal(800), 720);
  assert.equal(clampSleepGoal(487), 480);
  assert.equal(clampSleepGoal(488), 495);
  const n = normalizeSleepSettings({ goalMinutes: 450, bedtime: 'xx', future: 1 });
  assert.equal(n.goalMinutes, 450);
  assert.equal(n.bedtime, '23:30');
  assert.equal(n.future, 1);
  assert.deepEqual(normalizeSleepSettings(null), d);
  assert.equal(isValidSleepSettings({ goalMinutes: 60 }), false);
  assert.equal(isValidSleepSettings({ bedtime: '25:00' }), false);
  assert.equal(isValidSleepSettings({ reminders: { log: { enabled: 'yes' } } }), false);
});

test('напоминания сна: два типа в формате правил уведомлений, сериализация и расписание', () => {
  assert.deepEqual(SLEEP_REMINDER_TYPES, ['sleep_bedtime', 'sleep_log']);
  const s = normalizeSleepSettings({ reminders: { bedtime: { enabled: true, time: '23:00' } } });
  const rules = sleepReminderRules(s);
  assert.deepEqual(rules.map((r) => [r.type, r.enabled, r.time, r.repeat]), [['sleep_bedtime', true, '23:00', 'daily'], ['sleep_log', false, '08:00', 'daily']]);
  assert.deepEqual(JSON.parse(JSON.stringify(rules)), rules);
  assert.equal(rules[1].ref.route, '#/sleep/new');
  const next = nextFire(rules[0], new Date(2026, 9, 4, 22, 0));
  assert.equal(next.getHours(), 23);
  assert.equal(next.getDate(), 4);
});

/* ================= хранилище ================= */

test('хранилище: CRUD, новые сверху, одна запись на дату, пересчёт после правки и удаления', async () => {
  const s = await fresh();
  assert.deepEqual(await s.getSleepEntries(), []);
  assert.equal((await s.getSleepSettings()).goalMinutes, 480);
  const a = await s.addSleepEntry(form().value);
  assert.ok(a.id && a.createdAt && a.updatedAt);
  await s.addSleepEntry(form({ wakeDate: '2026-10-03', bedTime: '23:00', wakeTime: '07:00' }).value);
  assert.deepEqual((await s.getSleepEntries()).map((e) => e.date), ['2026-10-04', '2026-10-03']);
  assert.equal(averageSleep(await s.getSleepEntries()), Math.round((460 + 480) / 2));
  await assert.rejects(s.addSleepEntry(form().value), (e) => e instanceof SleepStoreError && e.code === 'DUPLICATE_DATE' && e.existing.id === a.id);
  const upd = await s.updateSleepEntry(a.id, form({ bedTime: '23:00', wakeTime: '07:30', quality: 5 }).value);
  assert.equal(upd.durationMinutes, 510);
  assert.equal(upd.createdAt, a.createdAt);
  assert.equal((await s.getSleepEntry(a.id)).quality, 5);
  await assert.rejects(s.updateSleepEntry(a.id, form({ wakeDate: '2026-10-03' }).value), (e) => e.code === 'DUPLICATE_DATE');
  await assert.rejects(s.addSleepEntry({ ...form().value, date: '2026-09-01', durationMinutes: 3000 }), (e) => e.code === 'INVALID');
  assert.equal((await s.removeSleepEntry(a.id)).id, a.id);
  assert.equal(await s.removeSleepEntry(a.id), null);
  assert.deepEqual((await s.getSleepEntries()).map((e) => e.date), ['2026-10-03']);
  const st = await s.updateSleepSettings({ goalMinutes: 465, bedtime: '23:15' });
  assert.deepEqual([st.goalMinutes, st.bedtime, st.wakeTime], [465, '23:15', '07:30']);
  assert.equal((await s.updateSleepSettings({ reminders: { log: { enabled: true, time: '08:30' } } })).reminders.bedtime.time, '23:00', 'частичное обновление напоминаний');
});

test('существующая установка без ключей сна получает их при запуске (другие данные не меняются)', async () => {
  const driver = new MemoryDriver();
  await driver.set('health_meta', JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, seededAt: '2026-09-01T00:00:00.000Z' }));
  await driver.set('health_meds', JSON.stringify([{ id: 'm1', name: 'Синтетик' }]));
  const before = await driver.get('health_meds');
  const s = new StorageService(driver);
  await s.init();
  assert.equal(await driver.get('sleep_log'), '[]');
  assert.equal(JSON.parse(await driver.get('sleep_settings')).goalMinutes, 480);
  assert.equal(await driver.get('health_meds'), before);
  assert.equal(JSON.parse(await driver.get('health_meta')).schemaVersion, CURRENT_SCHEMA_VERSION, 'схема не меняется');
});

/* ================= резервная копия ================= */

test('backup: записи и настройки сна попадают в копию; restore на другом устройстве их возвращает', async () => {
  const a = await fresh();
  await a.addSleepEntry(form({ tags: ['stress'], napEnabled: true, napMinutes: 30, note: 'синтетика' }).value);
  await a.updateSleepSettings({ goalMinutes: 450, wakeTime: '07:00' });
  const { json, verified } = await a.createBackup();
  assert.equal(verified, true);
  const raw = JSON.parse(json);
  assert.equal(raw.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(raw.data.sleep_log.length, 1);
  assert.equal(raw.data.sleep_settings.goalMinutes, 450);
  const b = await fresh();
  const prepared = await b.prepareRestore(parseBackup(json));
  assert.equal(prepared.summary.sleep, 1);
  await b.restoreBackup(prepared);
  const [e] = await b.getSleepEntries();
  assert.deepEqual([e.date, e.durationMinutes, e.tags, napMinutes(e), e.note], ['2026-10-04', 460, ['stress'], 30, 'синтетика']);
  assert.equal((await b.getSleepSettings()).goalMinutes, 450);
});

test('legacy restore: копия до модуля «Сон» (без sleep_log/sleep_settings) восстанавливается со значениями по умолчанию', async () => {
  const old = {
    app: 'lexlife', backupFormatVersion: 2, schemaVersion: 8, createdAt: '2026-09-01T10:00:00.000Z',
    data: { health_meds: [{ id: 'm1', name: 'Синтетик' }], med_log: {}, activity_days: {} },
  };
  const s = await fresh();
  await s.addSleepEntry(form().value); // текущие данные заменяются копией целиком
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify(old))));
  assert.deepEqual(await s.getSleepEntries(), []);
  assert.deepEqual(await s.getSleepSettings(), defaultSleepSettings());
  assert.equal((await s.getMeds())[0].name, 'Синтетик');
  /* очень старая схема (v7, прежний app id) тоже проходит */
  const v7 = { ...old, app: 'moe-zdorovie', backupFormatVersion: undefined, schemaVersion: 7 };
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify(v7))));
  assert.deepEqual(await s.getSleepEntries(), []);
  /* sleep_log: null — раздел не создавался → по умолчанию */
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify({ ...old, data: { ...old.data, sleep_log: null } }))));
  assert.deepEqual(await s.getSleepEntries(), []);
});

test('restore: повреждённый раздел сна — понятная ошибка, текущие данные не меняются', async () => {
  const s = await fresh();
  const mine = await s.addSleepEntry(form().value);
  const base = { app: 'lexlife', backupFormatVersion: 2, schemaVersion: 8, data: { health_meds: [] } };
  const good = { ...form().value, id: 'r1', createdAt: null, updatedAt: null };
  for (const data of [
    { sleep_log: {} }, { sleep_log: [{ ...good, durationMinutes: 36 * 60 }] }, { sleep_log: [{ ...good, quality: 9 }] },
    { sleep_log: [{ ...good, id: '"><img>' }] }, { sleep_settings: { goalMinutes: 30 } }, { sleep_settings: [] },
  ]) {
    await assert.rejects(s.prepareRestore(parseBackup(JSON.stringify({ ...base, data: { ...base.data, ...data } }))),
      (e) => e instanceof BackupError && e.code === 'CORRUPT' && /Сон|Настройки сна/.test(e.message), JSON.stringify(data));
  }
  assert.deepEqual((await s.getSleepEntries()).map((e) => e.id), [mine.id]);
});

test('очистка данных удаляет сон вместе с остальными разделами', async () => {
  const s = await fresh();
  await s.addSleepEntry(form().value);
  await s.clearAll();
  assert.equal(await s.driver.get('sleep_log'), null);
  await s.init();
  assert.deepEqual(await s.getSleepEntries(), []);
});

/* ================= источник записи и стадии сна (задел под внешние источники) ================= */
const HK = {
  source: 'apple_health', externalId: 'HK-0000-SYNTH-0001', importedAt: '2026-10-04T08:00:00.000Z',
  sourceDevice: { name: 'Apple Watch', manufacturer: 'Apple', model: null },
  sleepStages: { awakeMinutes: 12, coreMinutes: 250, deepMinutes: 80, remMinutes: 118 },
};

test('legacy: запись без source — это manual, проходит проверку, аналитика прежняя', () => {
  const legacy = { ...form().value, id: 'old1', createdAt: null, updatedAt: null };
  assert.equal('source' in legacy, false);
  assert.equal(isValidSleepEntry(legacy), true);
  assert.equal(sleepSource(legacy), 'manual');
  assert.equal(sleepExternalKey(legacy), null);
  assert.deepEqual(SLEEP_SOURCES, ['manual', 'apple_health']);
});

test('manual: новая запись из формы получает source manual и пустые поля источника, без sleepStages', async () => {
  const s = await fresh();
  const e = await s.addSleepEntry(form().value);
  assert.deepEqual([e.source, e.externalId, e.sourceDevice, e.importedAt], ['manual', null, null, null]);
  assert.equal('sleepStages' in e, false, 'стадий у ручной записи нет совсем — без фиктивных значений');
  /* правка не меняет происхождение; у старой записи без source оно и не появляется */
  const upd = await s.updateSleepEntry(e.id, form({ wakeTime: '07:40' }).value);
  assert.equal(upd.source, 'manual');
  await s.driver.set('sleep_log', JSON.stringify([{ ...form().value, id: 'old1' }]));
  const old = await s.updateSleepEntry('old1', form({ quality: 5 }).value);
  assert.equal('source' in old, false);
  assert.equal(sleepSource(old), 'manual');
});

test('apple_health: валидатор принимает запись источника (externalId не обязателен), стадии и устройство', () => {
  const base = { ...form().value, id: 'h1' };
  assert.equal(isValidSleepEntry({ ...base, ...HK }), true);
  assert.equal(isValidSleepEntry({ ...base, ...HK, externalId: null }), true, 'externalId пока не обязателен');
  assert.equal(isValidSleepEntry({ ...base, source: 'manual', externalId: null, sourceDevice: null, importedAt: null }), true);
  assert.equal(isValidSleepEntry({ ...base, sourceDevice: { name: 'Кольцо', manufacturer: 'Другой', model: 'X2' } }), true, 'не только Apple Watch');
  assert.equal(isValidSleepEntry({ ...base, sleepStages: { deepMinutes: 90 } }), true, 'стадии частично');
  for (const bad of [
    { source: 'Apple Health!' }, { source: 5 }, { externalId: '' }, { externalId: 'x'.repeat(201) }, { externalId: 42 },
    { sourceDevice: 'Apple Watch' }, { sourceDevice: { name: { x: 1 } } }, { importedAt: 5 },
    { sleepStages: { deepMinutes: -5 } }, { sleepStages: { remMinutes: 2000 } }, { sleepStages: [] }, { sleepStages: { coreMinutes: '90' } },
  ]) assert.equal(isValidSleepEntry({ ...base, ...bad }), false, JSON.stringify(bad));
});

test('будущие значения: неизвестный безопасный источник и лишние поля стадий/устройства не ломают проверку', () => {
  const base = { ...form().value, id: 'f1' };
  assert.equal(isValidSleepEntry({ ...base, source: 'other_tracker', sourceDevice: { name: 'Band', firmware: '1.2', paired: true } }), true);
  assert.equal(isValidSleepEntry({ ...base, sleepStages: { ...HK.sleepStages, inBedMinutes: 500, unspecifiedMinutes: null } }), true);
  assert.equal(sleepSource({ ...base, source: 'other_tracker' }), 'other_tracker');
});

test('дедупликация будущего импорта: та же внешняя запись повторно не добавляется', async () => {
  const s = await fresh();
  const a = await s.addSleepEntry({ ...form().value, ...HK });
  assert.equal(a.source, 'apple_health');
  assert.deepEqual(a.sleepStages, HK.sleepStages);
  assert.equal(findSleepByExternalId(await s.getSleepEntries(), 'apple_health', HK.externalId).id, a.id);
  assert.equal(findSleepByExternalId(await s.getSleepEntries(), 'manual', HK.externalId), null, 'ключ учитывает источник');
  await assert.rejects(s.addSleepEntry({ ...form({ wakeDate: '2026-10-03' }).value, ...HK }),
    (e) => e instanceof SleepStoreError && e.code === 'DUPLICATE_EXTERNAL' && e.existing.id === a.id);
  assert.equal((await s.getSleepEntries()).length, 1);
});

test('backup/restore: source, externalId, sourceDevice, importedAt и sleepStages сохраняются и возвращаются', async () => {
  const a = await fresh();
  await a.addSleepEntry({ ...form().value, ...HK });
  await a.addSleepEntry(form({ wakeDate: '2026-10-03' }).value);
  const { json, verified } = await a.createBackup();
  assert.equal(verified, true);
  const b = await fresh();
  await b.restoreBackup(await b.prepareRestore(parseBackup(json)));
  const [hk, man] = await b.getSleepEntries();
  assert.deepEqual([hk.source, hk.externalId, hk.sourceDevice, hk.importedAt, hk.sleepStages], [HK.source, HK.externalId, HK.sourceDevice, HK.importedAt, HK.sleepStages]);
  assert.deepEqual([man.source, man.externalId, man.sourceDevice, man.importedAt, 'sleepStages' in man], ['manual', null, null, null, false]);
});

test('старая копия: записи сна без новых полей восстанавливаются как manual; будущие поля не мешают', async () => {
  const oldEntry = { ...form().value, id: 'old1', createdAt: '2026-10-04T08:00:00.000Z', updatedAt: '2026-10-04T08:00:00.000Z' };
  const backup = { app: 'lexlife', backupFormatVersion: 2, schemaVersion: 8, data: { sleep_log: [oldEntry], sleep_settings: defaultSleepSettings() } };
  const s = await fresh();
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify(backup))));
  const [e] = await s.getSleepEntries();
  assert.equal('source' in e, false, 'обязательной миграции нет');
  assert.equal(sleepSource(e), 'manual');
  const future = { ...backup, data: { ...backup.data, sleep_log: [{ ...oldEntry, source: 'other_tracker', sleepStages: { remMinutes: 90, lightMinutes: 200 }, futureField: { x: 1 } }] } };
  await s.restoreBackup(await s.prepareRestore(parseBackup(JSON.stringify(future))));
  assert.equal((await s.getSleepEntries())[0].source, 'other_tracker');
  assert.equal(isValidSleepLog([{ ...oldEntry, sleepStages: { deepMinutes: -1 } }]), false, 'некорректные значения по-прежнему отклоняются');
});

test('аналитика не зависит от источника и стадий: те же результаты с полями и без', () => {
  const plain = [entry('2026-10-01', 420, { quality: 3, tags: ['stress'] }), entry('2026-10-02', 480, { bed: '23:30', quality: 5 }), entry('2026-10-03', 510, { bed: '00:10', quality: 4 })];
  const rich = plain.map((e, i) => ({ ...e, ...HK, externalId: `HK-${i}`, sleepStages: { awakeMinutes: 60, coreMinutes: 10, deepMinutes: 0, remMinutes: 5 } }));
  const calc = (l) => [averageSleep(l), averageBedtime(l), averageWakeTime(l), averageQuality(l), sleepConsistency(l), sleepGoalRate(l, 480),
    currentSleepStreak(l, 480, '2026-10-03'), bestSleepStreak(l, 480), aggregateByWeek(l, '2026-10-01').map((x) => x.minutes),
    aggregateByYear(l, '2026-10-01').map((x) => x.minutes), totalDayMinutes(l[0]), factorInsights(l, { minDays: 1 })];
  assert.deepEqual(calc(rich), calc(plain));
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
