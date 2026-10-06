/* =========================================================
   tests/metric-periods.test.mjs — периоды статистики показателя (js/services/metricPeriods.js):
   ДН · НЕД · МЕС · 6 МЕС · ГОД, навигация по периодам, столбцы, среднее (дни без записей = 0,
   будущие дни текущего периода не входят), подписи диапазона, «красивая» шкала Y.
   Без браузера и без Storage. Только синтетические данные.

   Запуск:  node tests/metric-periods.test.mjs   (npm test — в нескольких timezone)
   ========================================================= */

import assert from 'node:assert/strict';
import { periodWindow, aggregatePeriod, niceScale, formatPeriodRange, addDays, PERIOD_KINDS, PERIOD_SHORT, fmtGroup } from '../js/services/metricPeriods.js';

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = (s) => String(s).replace(/ /g, ' ');
const TODAY = '2026-10-05'; // понедельник
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const agg = (kind, offset, values, today = TODAY, opts) => aggregatePeriod(periodWindow(kind, offset, today), (d) => (d in values ? values[d] : null), opts);
const fill = (start, n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [addDays(start, i), typeof v === 'function' ? v(i) : v]));

test('режимы и подписи переключателя', () => {
  assert.deepEqual(PERIOD_KINDS, ['day', 'week', 'month', '6m', 'year']);
  assert.deepEqual(PERIOD_KINDS.map((k) => PERIOD_SHORT[k]), ['ДН', 'НЕД', 'МЕС', '6 МЕС', 'ГОД']);
});

/* ---------- неделя ---------- */
test('1. неделя с полными данными: 7 столбцов Пн–Вс, среднее = сумма / 7', () => {
  const v = fill('2026-09-28', 7, (i) => 1000 + i * 100); // 1000…1600
  const a = agg('week', -1, v);
  assert.equal(a.start, '2026-09-28');
  assert.equal(a.end, '2026-10-04');
  assert.deepEqual(a.buckets.map((b) => b.label), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
  assert.deepEqual(a.buckets.map((b) => b.value), [1000, 1100, 1200, 1300, 1400, 1500, 1600]);
  assert.equal(a.total, 9100);
  assert.equal(a.average, 1300);
  assert.equal(a.days, 7);
  assert.equal(plain(a.range), '28 сент. — 4 окт. 2026 г.');
});
test('2. неделя с пропусками: день без записей = 0 и входит в знаменатель', () => {
  const a = agg('week', -1, { '2026-09-28': 1400, '2026-10-01': 2800 });
  assert.deepEqual(a.buckets.map((b) => b.value), [1400, 0, 0, 2800, 0, 0, 0]);
  assert.equal(a.average, 600); // 4200 / 7, не 4200 / 2
});
test('3. пустая неделя: столбцы 0, среднее 0', () => {
  const a = agg('week', -3, {});
  assert.ok(a.buckets.every((b) => b.value === 0));
  assert.equal(a.average, 0);
  assert.equal(a.max, 0);
});
test('4. текущая неполная неделя: будущие дни — без столбца и вне среднего', () => {
  const a = agg('week', 0, { '2026-10-05': 1500, '2026-10-06': 9999 }, '2026-10-06'); // вторник; 9999 — «сегодня»
  assert.equal(a.start, '2026-10-05');
  assert.equal(a.effEnd, '2026-10-06');
  assert.equal(a.days, 2);
  assert.deepEqual(a.buckets.map((b) => b.value), [1500, 9999, null, null, null, null, null]);
  close(a.average, (1500 + 9999) / 2);
  assert.equal(plain(a.range), '5 — 6 окт. 2026 г.');
  assert.equal(a.hasNext, false);
  const fut = agg('week', 0, { '2026-10-08': 5000 }, '2026-10-06');
  assert.equal(fut.total, 0, 'запись будущего дня не учитывается');
});
test('10. будущие дни не входят ни в один текущий период', () => {
  const v = { '2026-10-06': 7777, '2026-10-31': 7777, '2026-10-05': 1000 };
  for (const k of ['week', 'month', '6m', 'year']) {
    const a = agg(k, 0, v);
    assert.ok(a.dayKeys.every((d) => d <= TODAY), k);
    assert.equal(a.total, 1000, k);
  }
});

/* ---------- месяц ---------- */
test('5. месяц 28/29/30/31 день: интервалы по неделям месяца', () => {
  const lab = (k, today) => periodWindow('month', 0, today).buckets.map((b) => b.label);
  assert.deepEqual(lab('month', '2026-02-28'), ['1–7', '8–14', '15–21', '22–28']);
  assert.deepEqual(lab('month', '2028-02-29'), ['1–7', '8–14', '15–21', '22–28', '29–29']);
  assert.deepEqual(lab('month', '2026-09-30'), ['1–7', '8–14', '15–21', '22–28', '29–30']);
  assert.deepEqual(lab('month', '2026-10-31'), ['1–7', '8–14', '15–21', '22–28', '29–31']);
  const full = periodWindow('month', -1, TODAY); // сентябрь целиком
  assert.equal(full.days, 30);
  assert.equal(plain(full.range), '1 — 30 сент. 2026 г.');
});
test('месяц: столбец — среднее в день по своему интервалу; текущий месяц — по 1–5 октября', () => {
  const v = fill('2026-10-01', 5, 1000);
  v['2026-10-03'] = 2000;
  const a = agg('month', 0, v);
  assert.equal(a.days, 5);
  assert.equal(a.average, 6000 / 5); // не / 31
  assert.equal(a.buckets[0].value, 6000 / 5); // 1–7: прошли только 1–5
  assert.deepEqual(a.buckets.slice(1).map((b) => b.value), [null, null, null, null]);
  assert.equal(a.buckets[0].avg, true);
  assert.equal(plain(a.range), '1 — 5 окт. 2026 г.');
  assert.equal(plain(a.buckets[1].tip), '8–14 окт.');
  const sep = agg('month', -1, fill('2026-09-01', 30, (i) => (i < 7 ? 700 : 1400)));
  assert.equal(sep.buckets[0].value, 700);
  assert.equal(sep.buckets[4].value, 1400); // 29–30
  close(sep.average, (7 * 700 + 23 * 1400) / 30);
});

/* ---------- 6 месяцев и год ---------- */
test('7. 6 месяцев: май…октябрь, столбец — среднее в день за месяц', () => {
  const a = agg('6m', 0, { ...fill('2026-05-01', 31, 1000), '2026-10-01': 3100 });
  assert.deepEqual(a.buckets.map((b) => b.label), ['май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.']);
  assert.equal(a.buckets[0].value, 1000);
  assert.equal(a.buckets[1].value, 0);
  assert.equal(a.buckets[5].value, 3100 / 5); // октябрь: 5 прошедших дней
  assert.equal(a.start, '2026-05-01');
  assert.equal(plain(a.range), '1 мая — 5 окт. 2026 г.');
  assert.equal(a.days, 31 + 30 + 31 + 31 + 30 + 5);
  assert.equal(plain(periodWindow('6m', -1, TODAY).range), '1 нояб. 2025 г. — 30 апр. 2026 г.');
});
test('8. год: 12 месяцев нояб. 2025 — окт. 2026; трёхбуквенные подписи, буквы — запасной вариант', () => {
  const a = agg('year', 0, {});
  assert.equal(a.buckets.length, 12);
  assert.deepEqual(a.buckets.map((b) => b.label), ['ноя', 'дек', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт']);
  assert.equal(a.buckets.map((b) => b.letter).join(''), 'НДЯФМАМИИАСО');
  assert.equal(plain(a.range), '1 нояб. 2025 г. — 5 окт. 2026 г.');
  assert.equal(plain(periodWindow('year', -1, TODAY).range), '1 нояб. 2024 г. — 31 окт. 2025 г.');
  assert.equal(a.buckets[11].tip, 'Октябрь 2026');
});
test('6. переход через декабрь / январь', () => {
  const jan = periodWindow('month', -1, '2027-02-10');
  assert.equal(jan.start, '2027-01-01');
  assert.equal(periodWindow('month', -2, '2027-02-10').start, '2026-12-01');
  const w = periodWindow('week', 0, '2027-01-01'); // пятница
  assert.equal(w.start, '2026-12-28');
  assert.equal(plain(w.range), '28 дек. 2026 г. — 1 янв. 2027 г.');
  const y = agg('year', 0, { '2026-12-31': 3100, '2027-01-01': 3100 }, '2027-01-01');
  assert.equal(y.buckets[10].value, 100); // декабрь: 3100 / 31
  assert.equal(y.buckets[11].value, 3100); // январь: 1 прошедший день
  assert.equal(periodWindow('day', -1, '2027-01-01').start, '2026-12-31');
});
test('9. правильное среднее — сумма / календарные дни периода (не / дни с записями)', () => {
  const a = agg('week', -1, { '2026-09-29': 2400, '2026-10-03': 1000, '2026-10-04': 600, '2026-10-05': 1500 });
  assert.equal(a.total, 4000);
  close(a.average, 4000 / 7);
  /* режим mean (точечные показатели) — только дни с данными */
  const m = agg('week', -1, { '2026-09-29': 76, '2026-10-03': 78 }, TODAY, { mode: 'mean' });
  assert.equal(m.average, 77);
  assert.equal(m.buckets[2].value, null);
});

/* ---------- день ---------- */
test('день: 24 часовых столбца, итог дня, подписи 00 · 06 · 12 · 18', () => {
  const hours = new Array(24).fill(0); hours[9] = 500; hours[18] = 1000;
  const a = agg('day', 0, { [TODAY]: 1500 }, TODAY, { hourValues: () => hours });
  assert.equal(a.buckets.length, 24);
  assert.equal(a.total, 1500);
  assert.equal(a.buckets[18].value, 1000);
  assert.deepEqual(a.buckets.filter((b) => b.label).map((b) => b.label), ['00', '06', '12', '18']);
  assert.equal(a.buckets[18].tip, '18:00–19:00');
  assert.equal(plain(a.range), '5 окт. 2026 г.');
  assert.equal(periodWindow('day', -3, TODAY).start, '2026-10-02');
  assert.equal(periodWindow('day', 5, TODAY).start, TODAY, 'вперёд дальше сегодня нельзя');
});

/* ---------- шкала Y ---------- */
test('11. шкала Y: 2350 и цель 2600 → 3000; 3600 → 4000; 5100 → 6000', () => {
  assert.deepEqual(niceScale(2350, 2600), { max: 3000, step: 1000, ticks: [0, 1000, 2000, 3000] });
  assert.equal(niceScale(3600, 2600).max, 4000);
  assert.equal(niceScale(5100, 2600).max, 6000);
  assert.deepEqual(niceScale(5100).ticks, [0, 2000, 4000, 6000]);
  assert.equal(niceScale(480).max, 600); // часы дня
  assert.equal(niceScale(0, null).max, 1000);
});
test('12–13. цель выше данных — внутри шкалы; данные выше цели — шкала по данным', () => {
  const s1 = niceScale(300, 2600);
  assert.ok(s1.max >= 2600 * 1.05);
  const s2 = niceScale(4800, 2000);
  assert.ok(s2.max >= 4800 && s2.ticks.at(-1) === s2.max);
});

/* ---------- календарь и подписи ---------- */
test('14. локальный календарь: границы дня и переход на летнее/зимнее время', () => {
  assert.equal(addDays('2026-03-28', 1), '2026-03-29');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  const w = periodWindow('week', 0, '2026-03-31');
  assert.deepEqual([w.start, w.end, w.days], ['2026-03-30', '2026-04-05', 2]);
  assert.equal(periodWindow('month', 0, '2026-03-29').days, 29);
  assert.equal(periodWindow('week', 0, '2026-10-04').start, '2026-09-28'); // воскресенье — конец недели Пн–Вс
});
test('диапазоны: день, один месяц, разные месяцы, разные годы', () => {
  assert.equal(plain(formatPeriodRange('2026-10-05', '2026-10-05')), '5 окт. 2026 г.');
  assert.equal(plain(formatPeriodRange('2026-10-01', '2026-10-31')), '1 — 31 окт. 2026 г.');
  assert.equal(plain(formatPeriodRange('2026-09-29', '2026-10-05')), '29 сент. — 5 окт. 2026 г.');
  assert.equal(plain(formatPeriodRange('2025-11-01', '2026-10-31')), '1 нояб. 2025 г. — 31 окт. 2026 г.');
  assert.equal(plain(fmtGroup(1375)), '1 375');
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
