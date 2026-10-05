/* =========================================================
   tests/water-stats-range.test.mjs — единый диапазон периода экрана «Вода»
   (js/services/analytics.js → getWaterStatsRange) и среднее по этому диапазону.

   Проверяется:
     • неделя / месяц / год — границы диапазона и число дней;
     • среднее = сумма за диапазон / календарные дни диапазона;
     • дни без записей воды входят в знаменатель как 0;
     • будущие дни в текущий незавершённый период не входят;
     • переключение периода реально меняет среднее (воспроизведение бага нижней карточки);
     • график и среднее получают один и тот же startDate/endDate;
     • формат мл → «л/день»;
     • нет данных → среднее 0;
     • журнал воды не изменяется.

   Без браузера, без localStorage. Только синтетические данные.
   Запуск:  node tests/water-stats-range.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { getWaterStatsRange, formatLiters, WATER_PERIODS, WATER_PERIOD_LABEL } from '../js/services/analytics.js';
import { StorageService, MemoryDriver, dateKey } from '../js/services/storage.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* «сегодня» тестов — фиксированная локальная дата, как в ТЗ: 5 октября 2026 г. */
const NOW = new Date(2026, 9, 5, 14, 30);
const day = (total) => ({ total, entries: total ? [{ t: '09:00', ml: total }] : [] });
const shift = (base, n) => dateKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() + n));


/* ---------- 1–3. границы и среднее каждого периода ---------- */

test('неделя: 7 дней по сегодня, среднее = сумма / 7', () => {
  const log = {};
  // 28 сент. — 4 окт. = 9100 мл по примеру ТЗ, плюс сегодня (5 окт.) 0
  for (let i = 6; i >= 0; i--) log[shift(NOW, -i)] = day(i === 0 ? 1600 : 1250);
  const r = getWaterStatsRange('week', NOW, log);
  assert.equal(r.startDate, '2026-09-29');
  assert.equal(r.endDate, '2026-10-05');
  assert.equal(r.numberOfDays, 7);
  assert.equal(r.dayKeys.length, 7);
  assert.equal(r.sum, 1250 * 6 + 1600);
  assert.equal(r.average, (1250 * 6 + 1600) / 7);
  assert.equal(r.label, WATER_PERIOD_LABEL.week);
});

test('неделя: пример ТЗ — 9100 мл за 7 дней → 1300 мл/день = «1,3»', () => {
  const log = {};
  const per = [1300, 1300, 1300, 1300, 1300, 1300, 1300]; // 9100
  per.forEach((ml, i) => (log[shift(NOW, -(6 - i))] = day(ml)));
  const r = getWaterStatsRange('week', NOW, log);
  assert.equal(r.sum, 9100);
  assert.equal(r.average, 1300);
  assert.equal(formatLiters(r.average), '1,3');
});

test('месяц: 30 дней по сегодня (6 сент. — 5 окт.), среднее только по ним', () => {
  const log = {};
  for (let i = 0; i < 60; i++) log[shift(NOW, -i)] = day(2000); // шире периода
  const r = getWaterStatsRange('month', NOW, log);
  assert.equal(r.startDate, '2026-09-06');
  assert.equal(r.endDate, '2026-10-05');
  assert.equal(r.numberOfDays, 30);
  assert.equal(r.average, 2000); // дни до 6 сент. не влияют
  assert.equal(r.sum, 2000 * 30);
});

test('месяц: календарный октябрь и глобальная история не используются', () => {
  const log = {};
  for (let i = 0; i < 5; i++) log[shift(NOW, -i)] = day(3000);       // 1–5 окт.
  for (let i = 5; i < 30; i++) log[shift(NOW, -i)] = day(1000);      // 6 сент. — 30 сент.
  for (let i = 30; i < 200; i++) log[shift(NOW, -i)] = day(300);     // раньше периода
  const r = getWaterStatsRange('month', NOW, log);
  const expected = (3000 * 5 + 1000 * 25) / 30;
  assert.equal(r.average, expected);
  assert.notEqual(r.average, 3000); // не «календарный октябрь»
});

test('год: тот же диапазон, что у 12 столбцов графика (1-е число 11 месяцев назад — сегодня)', () => {
  const r = getWaterStatsRange('year', NOW, {});
  assert.equal(r.startDate, '2025-11-01');
  assert.equal(r.endDate, '2026-10-05');
  assert.equal(r.months.length, 12);
  assert.equal(r.months[0].ym, '2025-11');
  assert.equal(r.months[11].ym, '2026-10');
  assert.equal(r.months[11].end, r.endDate); // последний месяц обрезан сегодняшним днём
  assert.equal(r.numberOfDays, r.dayKeys.length);
  assert.equal(r.numberOfDays, 339);
});

test('год: среднее по всем дням года, не по месяцу и не по неделе', () => {
  const log = {};
  for (let i = 0; i < 400; i++) log[shift(NOW, -i)] = day(i < 30 ? 2400 : 1200);
  const year = getWaterStatsRange('year', NOW, log);
  const month = getWaterStatsRange('month', NOW, log);
  assert.equal(month.average, 2400);
  assert.equal(year.average, (2400 * 30 + 1200 * (year.numberOfDays - 30)) / year.numberOfDays);
  assert.ok(year.average < month.average);
});

/* ---------- 4. дни без воды = 0 ---------- */

test('дни без записей воды входят в знаменатель как 0', () => {
  const log = { [shift(NOW, -6)]: day(2100), [shift(NOW, 0)]: day(2100) };
  const r = getWaterStatsRange('week', NOW, log);
  assert.equal(r.sum, 4200);
  assert.equal(r.average, 4200 / 7); // 600, а не 2100
  assert.equal(r.dailyTotals.filter((d) => d.total === 0).length, 5);
});

test('день, у которого все приёмы удалены, считается нулём, а не пропускается', () => {
  const log = {
    [shift(NOW, -1)]: { total: 0, entries: [], removedKeys: ['wm:x'] },
    [shift(NOW, 0)]: day(1400),
  };
  const r = getWaterStatsRange('week', NOW, log);
  assert.equal(r.average, 1400 / 7);
  assert.equal(r.dailyTotals.find((d) => d.date === shift(NOW, -1)).total, 0);
});

/* ---------- 5. будущие дни ---------- */

test('будущие дни не входят в текущий незавершённый период', () => {
  const log = { [shift(NOW, 0)]: day(1000), [shift(NOW, 1)]: day(9999), [shift(NOW, 20)]: day(9999) };
  for (const p of WATER_PERIODS) {
    const r = getWaterStatsRange(p, NOW, log);
    assert.equal(r.endDate, '2026-10-05', p);
    assert.ok(!r.dayKeys.includes(shift(NOW, 1)), p);
    assert.equal(r.sum, 1000, p); // будущие 9999 не засчитаны
  }
});

test('год: последний месяц не захватывает остаток октября', () => {
  const r = getWaterStatsRange('year', NOW, {});
  const october = r.dayKeys.filter((k) => k.startsWith('2026-10'));
  assert.equal(october.length, 5);
  assert.equal(october[october.length - 1], '2026-10-05');
});

/* ---------- 6. переключение периода меняет среднее (баг нижней карточки) ---------- */

test('баг: переключение Неделя → Месяц → Год реально пересчитывает среднее', () => {
  const log = {};
  for (let i = 0; i < 400; i++) log[shift(NOW, -i)] = day(i < 7 ? 2200 : i < 30 ? 1200 : 1900);
  const week = getWaterStatsRange('week', NOW, log);
  const month = getWaterStatsRange('month', NOW, log);
  const year = getWaterStatsRange('year', NOW, log);
  assert.equal(week.average, 2200);
  assert.notEqual(month.average, week.average);
  assert.notEqual(year.average, month.average);
  assert.notEqual(year.average, week.average);
  // отображаемые значения тоже различаются — не остаётся значение предыдущего периода
  const shown = [week, month, year].map((r) => formatLiters(r.average));
  assert.equal(new Set(shown).size, 3, `показано: ${shown.join(' / ')}`);
});

test('баг: сохранённое значение месяца не переносится на год (разные startDate)', () => {
  const log = {};
  for (let i = 0; i < 400; i++) log[shift(NOW, -i)] = day(1800);
  const month = getWaterStatsRange('month', NOW, log);
  const year = getWaterStatsRange('year', NOW, log);
  assert.notEqual(year.startDate, month.startDate);
  assert.notEqual(year.numberOfDays, month.numberOfDays);
  assert.equal(year.endDate, month.endDate);
  // при одинаковом объёме каждый день средние совпадут по величине, но диапазоны — разные объекты
  assert.equal(year.average, 1800);
  assert.equal(month.average, 1800);
});

/* ---------- 7. один canonical range на график и среднее ---------- */

test('график и среднее получают один и тот же startDate/endDate', () => {
  const log = {};
  for (let i = 0; i < 400; i++) log[shift(NOW, -i)] = day(1500);
  for (const p of WATER_PERIODS) {
    const r = getWaterStatsRange(p, NOW, log);
    // dayKeys — ровно диапазон, по нему же строится серия графика (js/app.js → metricSeries)
    assert.equal(r.dayKeys[0], r.startDate, p);
    assert.equal(r.dayKeys[r.dayKeys.length - 1], r.endDate, p);
    assert.equal(r.dayKeys.length, r.numberOfDays, p);
    assert.equal(r.dailyTotals.length, r.numberOfDays, p);
    assert.equal(r.dailyTotals[0].date, r.startDate, p);
    assert.equal(r.dailyTotals[r.dailyTotals.length - 1].date, r.endDate, p);
    // дни идут подряд, без дыр и повторов
    const asDays = r.dayKeys.map((k) => Math.round(new Date(k + 'T00:00:00Z').getTime() / 86400000));
    assert.ok(asDays.every((d, i) => i === 0 || d === asDays[i - 1] + 1), p);
  }
});

test('год: столбцы графика лежат внутри диапазона среднего', () => {
  const r = getWaterStatsRange('year', NOW, {});
  assert.equal(r.months[0].start, r.startDate);
  for (const m of r.months) {
    assert.ok(m.start >= r.startDate, m.ym);
    assert.ok(m.end <= r.endDate, m.ym);
    assert.ok(r.dayKeys.includes(m.start), m.ym);
  }
});

/* ---------- 8. формат мл → л/день ---------- */

test('формат: мл → «л/день» с одним знаком и запятой', () => {
  assert.equal(formatLiters(1300), '1,3');
  assert.equal(formatLiters(2200), '2,2');
  assert.equal(formatLiters(1950), '2,0');
  assert.equal(formatLiters(1700), '1,7');
  assert.equal(formatLiters(1900), '1,9');
  assert.equal(formatLiters(0), '0');
  assert.equal(formatLiters(null), '0');
  assert.equal(formatLiters(NaN), '0');
  assert.ok(!formatLiters(1300).includes('.'));
});

/* ---------- 9. нет данных ---------- */

test('без данных среднее = 0 при любом периоде', () => {
  for (const p of WATER_PERIODS) {
    for (const log of [{}, null, undefined]) {
      const r = getWaterStatsRange(p, NOW, log);
      assert.equal(r.sum, 0, p);
      assert.equal(r.average, 0, p);
      assert.equal(formatLiters(r.average), '0', p);
      assert.equal(r.numberOfDays > 0, true, p);
    }
  }
});

test('неизвестный период — безопасный откат на «год»', () => {
  assert.equal(getWaterStatsRange('decade', NOW, {}).period, 'year');
  assert.equal(getWaterStatsRange(undefined, NOW, {}).period, 'year');
});

/* ---------- 10. журнал не изменяется ---------- */

test('журнал воды и его дни не изменяются расчётом', () => {
  const log = {};
  for (let i = 0; i < 40; i++) log[shift(NOW, -i)] = day(1000 + i);
  const snapshot = JSON.stringify(log);
  for (const p of WATER_PERIODS) getWaterStatsRange(p, NOW, log);
  assert.equal(JSON.stringify(log), snapshot);
});

test('через StorageService: расчёт не трогает записи, пересчёт следует за правками', async () => {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  const today = dateKey();
  const before = JSON.stringify(await storage.getWaterLog());

  getWaterStatsRange('week', new Date(), await storage.getWaterLog());
  getWaterStatsRange('year', new Date(), await storage.getWaterLog());
  assert.equal(JSON.stringify(await storage.getWaterLog()), before, 'расчёт изменил журнал');

  const base = getWaterStatsRange('week', new Date(), await storage.getWaterLog());
  await storage.addWaterEntry(500, today, '09:00');
  const after = getWaterStatsRange('week', new Date(), await storage.getWaterLog());
  assert.equal(after.sum, base.sum + 500);
  assert.equal(after.numberOfDays, base.numberOfDays);
  assert.equal(after.average, (base.sum + 500) / base.numberOfDays);

  await storage.removeWaterEntry(0, today, { t: '09:00', ml: 500 });
  const back = getWaterStatsRange('week', new Date(), await storage.getWaterLog());
  assert.equal(back.sum, base.sum);
});

/* ---------- устойчивость к timezone процесса ---------- */

test('диапазон считается по локальному календарю, конец — локальное сегодня', () => {
  const now = new Date(2027, 2, 1, 0, 10); // 1 марта, ночь
  const r = getWaterStatsRange('week', now, {});
  assert.equal(r.endDate, '2027-03-01');
  assert.equal(r.startDate, '2027-02-23');
  assert.equal(r.numberOfDays, 7);
  const y = getWaterStatsRange('year', now, {});
  assert.equal(y.startDate, '2026-04-01');
  assert.equal(y.months.length, 12);
});

test('переход через год: неделя и месяц пересекают 1 января', () => {
  const now = new Date(2027, 0, 3, 12, 0);
  const w = getWaterStatsRange('week', now, {});
  assert.equal(w.startDate, '2026-12-28');
  assert.equal(w.endDate, '2027-01-03');
  const m = getWaterStatsRange('month', now, {});
  assert.equal(m.startDate, '2026-12-05');
  assert.equal(m.numberOfDays, 30);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL — ${name}`);
    console.error(`         ${err && err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
