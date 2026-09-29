/* =========================================================
   tests/water-import.test.mjs — автономные тесты импорта воды из
   WaterMinder CSV (js/services/waterImport.js + StorageService).
   Без браузера, без localStorage (MemoryDriver), без сети.
   Синтетические данные — никаких реальных персональных данных.

   Запуск:  node tests/water-import.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import {
  parseWaterMinderCsv,
  parseWaterMinderDate,
  parseWaterMinderTime,
  assignImportKeys,
  buildWaterImportPlan,
  applyWaterImportPlan,
  applyTodayWaterImport,
} from '../js/services/waterImport.js';
import { StorageService, MemoryDriver } from '../js/services/storage.js';
import { evaluateWaterPlan, pickWater } from '../js/services/analytics.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const HEADER = 'Drink Type,Cup Name,Hydration Value(ml),Water Value(ml),Date,Time,Daily Goal Reached in %,Day Total(ml),Daily Goal Amount(ml)';

/* Синтетический CSV, повторяющий особенности реального экспорта WaterMinder:
   - тройной дубль одинаковой на вид строки (одна и та же минута/объём/тип) —
     это ТРИ разных приёма, схлопывать нельзя;
   - переход через полночь (23:5x одного дня и 00:0x следующего);
   - кофе/пиво, где Hydration Value(ml) ≠ Water Value(ml);
   - однозначные день/месяц без ведущего нуля и однозначный час;
   - записи «за сегодня» (2026-09-29), которые план обязан держать отдельно;
   - одна заведомо битая строка (невозможная дата 31/4) — должна попасть в errors,
     а не сломать разбор остальных строк. */
const TODAY = '2026-09-29'; // dateKey (ISO) — используется в сравнениях с планом/хранилищем
const TODAY_WM = '29/9/26'; // та же дата в формате WaterMinder (d/m/yy) — используется в CSV
const SYNTHETIC_CSV = [
  HEADER,
  'Вода,Кружка,"300","300",1/2/26,9:05,10%,"300","2.600"',
  'Вода,Кружка,"300","300",18/9/26,23:44,50%,"900","2.600"',
  'Вода,Кружка,"300","300",18/9/26,23:44,55%,"1.200","2.600"',
  'Вода,Кружка,"300","300",18/9/26,23:44,60%,"1.500","2.600"',
  'Вода,Кружка,"200","200",19/9/26,00:05,5%,"200","2.600"',
  'Кофе,Чашка,"300","270",20/9/26,08:10,10%,"270","2.600"',
  'Пиво,Бокал,"500","450",20/9/26,19:00,80%,"720","2.600"',
  `Вода,Кружка,"250","250",${TODAY_WM},07:30,10%,"250","2.600"`,
  `Вода,Кружка,"400","400",${TODAY_WM},12:00,25%,"650","2.600"`,
  'Вода,Кружка,"300","300",31/4/26,10:00,10%,"300","2.600"', // битая дата — 31 апреля не существует
].join('\n');

test('parseWaterMinderDate: корректный разбор d/m/yy без UTC/ISO-преобразований', () => {
  assert.equal(parseWaterMinderDate('29/9/26'), '2026-09-29');
  assert.equal(parseWaterMinderDate('1/2/26'), '2026-02-01');
  assert.equal(parseWaterMinderDate('31/12/25'), '2025-12-31');
  assert.equal(parseWaterMinderDate('31/4/26'), null); // в апреле нет 31-го
  assert.equal(parseWaterMinderDate('13/13/26'), null);
  assert.equal(parseWaterMinderDate('не дата'), null);
});

test('parseWaterMinderTime: корректный разбор HH:mm, однозначный час дополняется нулём', () => {
  assert.equal(parseWaterMinderTime('23:44'), '23:44');
  assert.equal(parseWaterMinderTime('9:05'), '09:05');
  assert.equal(parseWaterMinderTime('00:00'), '00:00');
  assert.equal(parseWaterMinderTime('24:00'), null);
  assert.equal(parseWaterMinderTime('12:60'), null);
});

test('parseWaterMinderCsv: разбирает все строки, битая дата уходит в errors, а не роняет импорт', () => {
  const { rows, errors, totalLines } = parseWaterMinderCsv(SYNTHETIC_CSV);
  assert.equal(totalLines, 10);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 11); // строка с 31/4/26 — 11-я строка файла (1 — заголовок)
  assert.equal(rows.length, 9);
});

test('parseWaterMinderCsv: объём для гидратации берётся строго из Water Value(ml)', () => {
  const { rows } = parseWaterMinderCsv(SYNTHETIC_CSV);
  const coffee = rows.find((r) => r.drinkType === 'Кофе');
  const beer = rows.find((r) => r.drinkType === 'Пиво');
  assert.equal(coffee.ml, 270);
  assert.equal(coffee.hydrationMl, 300);
  assert.equal(beer.ml, 450);
  assert.equal(beer.hydrationMl, 500);
});

test('parseWaterMinderCsv: записи 23:xx и 00:xx относятся к своим календарным дням', () => {
  const { rows } = parseWaterMinderCsv(SYNTHETIC_CSV);
  const lateNight = rows.filter((r) => r.time === '23:44');
  assert.equal(lateNight.length, 3);
  assert.ok(lateNight.every((r) => r.dateKey === '2026-09-18'));
  const justAfter = rows.find((r) => r.time === '00:05');
  assert.equal(justAfter.dateKey, '2026-09-19'); // не «прилип» к предыдущему дню
});

test('assignImportKeys: даёт различающиеся ключи даже для трёх внешне одинаковых строк', () => {
  const { rows } = parseWaterMinderCsv(SYNTHETIC_CSV);
  const withKeys = assignImportKeys(rows);
  const keys = withKeys.map((r) => r.importKey);
  assert.equal(new Set(keys).size, keys.length, 'все ключи должны быть уникальны');
  const tripleKeys = withKeys.filter((r) => r.time === '23:44').map((r) => r.importKey);
  assert.deepEqual(
    tripleKeys.sort(),
    ['wm:2026-09-18|23:44|300|Вода:0', 'wm:2026-09-18|23:44|300|Вода:1', 'wm:2026-09-18|23:44|300|Вода:2'].sort(),
  );
});

test('buildWaterImportPlan: держит сегодняшние записи отдельно от общего плана', () => {
  const { rows } = parseWaterMinderCsv(SYNTHETIC_CSV);
  const withKeys = assignImportKeys(rows);
  const plan = buildWaterImportPlan(withKeys, {}, TODAY);
  assert.equal(plan.totalRows, 9);
  assert.equal(plan.addedCount, 7); // 9 строк минус 2 «сегодняшние»
  assert.equal(plan.todayAdditions.length, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(plan.additionsByDay, TODAY));
  assert.equal(plan.csvTodayCount, 2);
  assert.equal(plan.existingTodayManualCount, 0);
});

test('buildWaterImportPlan: предупреждает о существующих сегодняшних ручных записях', () => {
  const { rows } = parseWaterMinderCsv(SYNTHETIC_CSV);
  const withKeys = assignImportKeys(rows);
  const existingLog = { [TODAY]: { total: 500, entries: [{ t: '08:00', ml: 500 }] } };
  const plan = buildWaterImportPlan(withKeys, existingLog, TODAY);
  assert.equal(plan.existingTodayManualCount, 1);
  assert.equal(plan.existingTodayImportedCount, 0);
});

async function runFullImportScenario() {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  // Симулируем реальное устройство: сегодня в LexLife уже есть ручная запись.
  await storage.addWaterEntry(500, TODAY, '08:00');

  const { rows, errors } = parseWaterMinderCsv(SYNTHETIC_CSV);
  const withKeys = assignImportKeys(rows);
  const existingLog1 = await storage.getWaterLog();
  const plan1 = buildWaterImportPlan(withKeys, existingLog1, TODAY);
  return { storage, withKeys, errors, plan1 };
}

test('импорт: 1-й запуск переносит все не-сегодняшние строки без потерь и без дублей', async () => {
  const { storage, plan1 } = await runFullImportScenario();
  const res = await applyWaterImportPlan(storage, plan1);
  assert.equal(res.importedCount, 7);

  const log = await storage.getWaterLog();
  // Тройной дубль 18/9 — все три приёма должны сохраниться как отдельные записи.
  assert.equal(log['2026-09-18'].entries.length, 3);
  assert.equal(log['2026-09-18'].total, 900);
  // Переход через полночь — 19/9 не задет записями 18/9.
  assert.equal(log['2026-09-19'].entries.length, 1);
  assert.equal(log['2026-09-19'].total, 200);
  // Кофе/пиво учтены по Water Value(ml).
  assert.equal(log['2026-09-20'].total, 270 + 450);
  // Сегодняшний день импортом не тронут — там по-прежнему только ручная запись.
  assert.equal(log[TODAY].entries.length, 1);
  assert.equal(log[TODAY].total, 500);
});

test('импорт: повторный запуск того же плана идемпотентен (0 новых, все — дубли)', async () => {
  const { storage, withKeys, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);

  const existingLog2 = await storage.getWaterLog();
  const plan2 = buildWaterImportPlan(withKeys, existingLog2, TODAY);
  assert.equal(plan2.addedCount, 0);
  assert.equal(plan2.duplicateCount, 7);
  assert.equal(plan2.todayAdditions.length, 2); // сегодняшние ещё не импортированы этим планом

  // Повторное применение плана не меняет данные (проверяем сумму дня с тройным дублем).
  await applyWaterImportPlan(storage, plan2);
  const log = await storage.getWaterLog();
  assert.equal(log['2026-09-18'].entries.length, 3);
  assert.equal(log['2026-09-18'].total, 900);
});

test('импорт «за сегодня»: отдельное действие добавляет только сегодняшние строки, повтор идемпотентен', async () => {
  const { storage, withKeys, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);

  const res = await applyTodayWaterImport(storage, plan1);
  assert.equal(res.importedCount, 2);

  const log = await storage.getWaterLog();
  assert.equal(log[TODAY].entries.length, 3); // 1 ручная + 2 импортированные
  assert.equal(log[TODAY].total, 500 + 250 + 400);

  // Пересборка плана против обновлённых данных — всё уже импортировано, 0 новых.
  const existingLog3 = await storage.getWaterLog();
  const plan3 = buildWaterImportPlan(withKeys, existingLog3, TODAY);
  assert.equal(plan3.addedCount, 0);
  assert.equal(plan3.todayAdditions.length, 0);
  assert.equal(plan3.duplicateCount, 9);

  await applyWaterImportPlan(storage, plan3);
  await applyTodayWaterImport(storage, plan3);
  const logAfterReplay = await storage.getWaterLog();
  assert.equal(logAfterReplay[TODAY].entries.length, 3);
  assert.equal(logAfterReplay[TODAY].total, 500 + 250 + 400);
});

test('импорт не удаляет и не перезаписывает существующие записи пользователя', async () => {
  const { storage, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);
  const log = await storage.getWaterLog();
  const manual = log[TODAY].entries.find((e) => e.key == null);
  assert.ok(manual, 'ручная запись должна остаться на месте');
  assert.equal(manual.t, '08:00');
  assert.equal(manual.ml, 500);
});

test('импортированные записи корректно участвуют в дневном плане воды (analytics.evaluateWaterPlan)', async () => {
  const { storage, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);
  const day = (await storage.getWaterLog())['2026-09-18'];
  assert.equal(pickWater(day), 900); // используется total, как и для ручных записей

  const slots = [
    { time: 7 * 60, ml: 300 },
    { time: 12 * 60, ml: 300 },
    { time: 18 * 60, ml: 300 },
  ];
  const result = evaluateWaterPlan(slots, day.entries, 24 * 60, 23 * 60);
  const attributed = result.reduce((s, r) => s + r.inWindow, 0);
  assert.equal(attributed, 900); // весь объём тройного дубля учтён в плане, ничего не потеряно
});

test('бэкап/восстановление остаются совместимы после импорта (формат и валидация не ломаются)', async () => {
  const { storage, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);

  const backup = await storage.createBackup();
  assert.equal(backup.verified, true);

  const fresh = new StorageService(new MemoryDriver());
  const parsed = JSON.parse(backup.json);
  const prepared = await fresh.prepareRestore(parsed);
  assert.equal(prepared.data.metrics_log.water['2026-09-18'].entries.length, 3);
  await fresh.restoreBackup(prepared);
  const restoredLog = await fresh.getWaterLog();
  assert.equal(restoredLog['2026-09-18'].total, 900);
});

/* ---------- раннер ---------- */
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
