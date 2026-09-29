/* =========================================================
   tests/water-goal-days.test.mjs — дни с выполненной целью воды за период
   и лучшая серия (js/services/analytics.js → waterGoalDays), в том числе после
   добавления, правки, переноса и удаления записей через StorageService.
   Без браузера, без localStorage (MemoryDriver). Только синтетические данные.

   Запуск:  node tests/water-goal-days.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { waterGoalDays } from '../js/services/analytics.js';
import { StorageService, MemoryDriver } from '../js/services/storage.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const GOAL = 2600;
const keysFrom = (start, n) => {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(y, m - 1, d + i);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  });
};
const day = (total) => ({ total, entries: total ? [{ t: '09:00', ml: total }] : [] });

test('считает все дни с целью, даже не подряд', () => {
  const keys = keysFrom('2031-03-01', 7);
  const log = { [keys[0]]: day(2600), [keys[2]]: day(3000), [keys[3]]: day(2599), [keys[6]]: day(2700) };
  const g = waterGoalDays(log, GOAL, keys);
  assert.equal(g.count, 3);
  assert.deepEqual(g.days.map((x) => x.date), [keys[0], keys[2], keys[6]]);
  assert.deepEqual(g.days.map((x) => x.total), [2600, 3000, 2700]);
  assert.equal(g.bestStreak, 1);
});

test('ровно цель засчитывается, на 1 мл меньше — нет', () => {
  const keys = keysFrom('2031-03-01', 2);
  const g = waterGoalDays({ [keys[0]]: day(2600), [keys[1]]: day(2599) }, GOAL, keys);
  assert.equal(g.count, 1);
});

test('лучшая серия: день без записей и недобор прерывают серию', () => {
  const keys = keysFrom('2031-03-01', 10);
  const log = {};
  [0, 1, 2].forEach((i) => (log[keys[i]] = day(2800)));   // серия 3
  log[keys[3]] = day(1000);                                // недобор
  [4, 5].forEach((i) => (log[keys[i]] = day(2600)));      // серия 2
  // keys[6] — записей нет
  [7, 8, 9].forEach((i) => (log[keys[i]] = day(2900)));   // серия 3
  log[keys[9]] = day(4000);
  const g = waterGoalDays(log, GOAL, keys);
  assert.equal(g.count, 8);
  assert.equal(g.bestStreak, 3);
});

test('только дни периода: дни до и после не учитываются', () => {
  const all = keysFrom('2031-02-20', 20);
  const log = Object.fromEntries(all.map((k) => [k, day(3000)]));
  const week = all.slice(10, 17);
  const g = waterGoalDays(log, GOAL, week);
  assert.equal(g.count, 7);
  assert.equal(g.bestStreak, 7);
});

test('серия через границу месяца и года', () => {
  const keys = keysFrom('2031-12-30', 4);
  const log = Object.fromEntries(keys.map((k) => [k, day(2600)]));
  assert.equal(waterGoalDays(log, GOAL, keys).bestStreak, 4);
});

test('без цели или без журнала — ноль, журнал не меняется', () => {
  const keys = keysFrom('2031-03-01', 3);
  const log = { [keys[0]]: day(3000) };
  const snapshot = JSON.stringify(log);
  assert.equal(waterGoalDays(log, 0, keys).count, 0);
  assert.equal(waterGoalDays(null, GOAL, keys).count, 0);
  waterGoalDays(log, GOAL, keys);
  assert.equal(JSON.stringify(log), snapshot);
});

test('день, у которого все записи удалены, — не день с целью', () => {
  const keys = keysFrom('2031-03-01', 1);
  const g = waterGoalDays({ [keys[0]]: { total: 0, entries: [], removedKeys: ['wm:x'] } }, GOAL, keys);
  assert.equal(g.count, 0);
});

test('пересчёт после добавления, правки, переноса и удаления записей', async () => {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  const keys = keysFrom('2031-05-10', 4);
  const [d1, d2, d3, d4] = keys;
  const calc = async () => waterGoalDays(await storage.getWaterLog(), GOAL, keys);

  // добавление: d1 и d2 — цель, d3 — нет
  await storage.addWaterEntry(1600, d1, '09:00');
  await storage.addWaterEntry(1000, d1, '15:00');
  await storage.addWaterEntry(2600, d2, '10:00');
  await storage.addWaterEntry(2000, d3, '10:00');
  let g = await calc();
  assert.equal(g.count, 2);
  assert.equal(g.bestStreak, 2);

  // правка: d3 2000 → 2700 — серия 3
  await storage.updateWaterEntry(d3, 0, { t: '10:00', ml: 2000 }, { t: '10:30', ml: 2700 });
  g = await calc();
  assert.equal(g.count, 3);
  assert.equal(g.bestStreak, 3);

  // перенос: 1000 мл из d1 в d4 — d1 падает до 1600, d4 получает 1000
  await storage.updateWaterEntry(d1, 1, { t: '15:00', ml: 1000 }, { t: '15:00', ml: 1000, date: d4 });
  g = await calc();
  assert.deepEqual(g.days.map((x) => x.date), [d2, d3]);
  assert.equal(g.bestStreak, 2);

  // удаление: запись d2 — остаётся один день с целью
  await storage.removeWaterEntry(0, d2, { t: '10:00', ml: 2600 });
  g = await calc();
  assert.deepEqual(g.days.map((x) => x.date), [d3]);
  assert.equal(g.bestStreak, 1);
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
