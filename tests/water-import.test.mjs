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

/* ---------- исправление ошибочной серии, журнал, серия дней ---------- */

/* Синтетический «ошибочный день»: нормальная история до 22:41 (итог 2 900 мл), затем серия
   повторных добавлений 23:xx (+3 000 мл), плюс ручная запись пользователя в 23:30. */
const BAD_DAY = '2026-01-28';
const BAD_DAY_CSV = [
  HEADER,
  'Вода,Кружка,"500","500",28/1/26,09:00,1%,"500","2.600"',
  'Вода,Кружка,"800","800",28/1/26,13:00,1%,"1.300","2.600"',
  'Вода,Кружка,"700","700",28/1/26,18:00,1%,"2.000","2.600"',
  'Вода,Кружка,"650","650",28/1/26,22:10,1%,"2.650","2.600"',
  'Вода,Кружка,"250","250",28/1/26,22:41,1%,"2.900","2.600"',
  'Вода,Кружка,"250","250",28/1/26,23:08,1%,"3.150","2.600"',
  'Вода,Кружка,"250","250",28/1/26,23:08,1%,"3.400","2.600"',
  'Вода,Кружка,"250","250",28/1/26,23:08,1%,"3.650","2.600"',
  'Вода,Кружка,"750","750",28/1/26,23:23,1%,"4.400","2.600"',
  'Вода,Кружка,"1500","1500",28/1/26,23:34,1%,"5.900","2.600"',
  'Вода,Кружка,"300","300",29/1/26,10:00,1%,"300","2.600"',
  'Вода,Кружка,"3200","3200",27/9/25,12:00,1%,"3.200","2.600"', // «честный» рекорд в другом дне
].join('\n');

async function badDayScenario() {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  await storage.addWaterEntry(200, BAD_DAY, '23:30'); // ручная запись позже 22:41 — трогать нельзя
  const rows = assignImportKeys(parseWaterMinderCsv(BAD_DAY_CSV).rows);
  await applyWaterImportPlan(storage, buildWaterImportPlan(rows, await storage.getWaterLog(), TODAY));
  return { storage, rows };
}
const isWm = (e) => typeof e.key === 'string' && e.key.startsWith('wm:');

test('исправление дня: удаляются только импортированные записи позже 22:41, итог = 2 900 + ручная', async () => {
  const { storage } = await badDayScenario();
  assert.equal((await storage.getWaterDay(BAD_DAY)).total, 5900 + 200);
  assert.equal((await storage.getWaterRecord()).date, BAD_DAY); // ошибочный день — «рекорд»

  const removed = await storage.removeWaterEntriesWhere(BAD_DAY, (e) => isWm(e) && e.t > '22:41');
  assert.equal(removed.length, 5);
  const day = await storage.getWaterDay(BAD_DAY);
  assert.equal(day.total, 2900 + 200);
  assert.ok(day.entries.some((e) => e.t === '22:41' && e.ml === 250), 'запись 22:41 остаётся');
  assert.ok(day.entries.some((e) => e.t === '23:30' && e.key == null), 'ручная запись 23:30 остаётся');
  assert.equal((await storage.getWaterDay('2026-01-29')).total, 300, 'соседний день не тронут');
  assert.deepEqual(await storage.getWaterRecord(), { date: '2025-09-27', total: 3200 }, 'рекорд пересчитан');
});

test('исправление дня: только импортированные — без ручной записи итог ровно 2 900', async () => {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  const rows = assignImportKeys(parseWaterMinderCsv(BAD_DAY_CSV).rows);
  await applyWaterImportPlan(storage, buildWaterImportPlan(rows, await storage.getWaterLog(), TODAY));
  await storage.removeWaterEntriesWhere(BAD_DAY, (e) => isWm(e) && e.t > '22:41');
  assert.equal((await storage.getWaterDay(BAD_DAY)).total, 2900);
});

test('повторный импорт не возвращает удалённые пользователем записи', async () => {
  const { storage, rows } = await badDayScenario();
  await storage.removeWaterEntriesWhere(BAD_DAY, (e) => isWm(e) && e.t > '22:41');
  const plan = buildWaterImportPlan(rows, await storage.getWaterLog(), TODAY);
  assert.equal(plan.addedCount, 0);
  assert.equal(plan.removedByUserCount, 5);
  await applyWaterImportPlan(storage, plan);
  assert.equal((await storage.getWaterDay(BAD_DAY)).total, 2900 + 200);
});

test('метки удаления переживают добавление ручной записи в тот же день и бэкап/восстановление', async () => {
  const { storage, rows } = await badDayScenario();
  await storage.removeWaterEntriesWhere(BAD_DAY, (e) => isWm(e) && e.t > '22:41');
  await storage.addWaterEntry(100, BAD_DAY, '07:00');
  const fresh = new StorageService(new MemoryDriver());
  await fresh.restoreBackup(await fresh.prepareRestore(JSON.parse((await storage.createBackup()).json)));
  const plan = buildWaterImportPlan(rows, await fresh.getWaterLog(), TODAY);
  assert.equal(plan.addedCount, 0);
  assert.equal(plan.removedByUserCount, 5);
  assert.equal((await fresh.getWaterDay(BAD_DAY)).total, 2900 + 200 + 100);
});

test('удаление одной записи точное: из трёх одинаковых удаляется именно показанная', async () => {
  const { storage, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);
  const day = await storage.getWaterDay('2026-09-18');
  const target = day.entries[1];
  // устаревший индекс (0) + содержимое с ключом — удаляется запись с ключом :1
  assert.equal(await storage.removeWaterEntry(0, '2026-09-18', { t: target.t, ml: target.ml, key: target.key }), true);
  const keys = (await storage.getWaterDay('2026-09-18')).entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ['wm:2026-09-18|23:44|300|Вода:0', 'wm:2026-09-18|23:44|300|Вода:2']);
  // запись, которой уже нет, — ничего не удаляется
  assert.equal(await storage.removeWaterEntry(0, '2026-09-18', { t: '23:44', ml: 300, key: target.key }), false);
  assert.equal((await storage.getWaterDay('2026-09-18')).entries.length, 2);
  // ручная запись (key: null) не совпадает с импортированной того же времени/объёма
  assert.equal(await storage.removeWaterEntry(0, '2026-09-18', { t: '23:44', ml: 300, key: null }), false);
});

test('редактирование: время/объём и перенос на другой день пересчитывают оба дня, ключ импорта сохраняется', async () => {
  const { storage, withKeys, plan1 } = await runFullImportScenario();
  await applyWaterImportPlan(storage, plan1);
  const coffee = (await storage.getWaterDay('2026-09-20')).entries.find((e) => e.drink === 'Кофе');
  const ok = await storage.updateWaterEntry('2026-09-20', 0, { t: coffee.t, ml: coffee.ml, key: coffee.key }, { date: '2026-09-21', t: '08:15', ml: 250 });
  assert.equal(ok, true);
  assert.equal((await storage.getWaterDay('2026-09-20')).total, 450);
  const moved = (await storage.getWaterDay('2026-09-21')).entries[0];
  assert.deepEqual({ t: moved.t, ml: moved.ml, key: moved.key, drink: moved.drink }, { t: '08:15', ml: 250, key: coffee.key, drink: 'Кофе' });
  assert.equal((await storage.getWaterDay('2026-09-21')).total, 250);
  // повторный импорт узнаёт перенесённую/исправленную запись — дубля нет
  const plan2 = buildWaterImportPlan(withKeys, await storage.getWaterLog(), TODAY);
  assert.equal(plan2.addedCount, 0);
  // некорректный ввод отклоняется, данные не меняются
  assert.equal(await storage.updateWaterEntry('2026-09-21', 0, { t: '08:15', ml: 250, key: coffee.key }, { t: '25:00', ml: 250 }), false);
  assert.equal(await storage.updateWaterEntry('2026-09-21', 0, { t: '08:15', ml: 250, key: coffee.key }, { t: '08:15', ml: 0 }), false);
});

test('добавление записи с выбранной датой и временем попадает в свой день', async () => {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  await storage.addWaterEntry(330, '2026-03-15', '23:59');
  await storage.addWaterEntry(120, '2026-03-16', '00:01');
  assert.deepEqual((await storage.getWaterDay('2026-03-15')).entries, [{ t: '23:59', ml: 330 }]);
  assert.equal((await storage.getWaterDay('2026-03-16')).total, 120);
});

test('серия учёта: дни подряд с хотя бы одной записью воды, независимо от цели', async () => {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  await storage.addWaterEntry(3000, '2026-09-26', '10:00');
  await storage.addWaterEntry(200, '2026-09-28', '10:00'); // 27.09 — пусто
  await storage.addWaterEntry(300, '2026-09-29', '10:00');
  const today = new Date(2026, 8, 29, 22, 0);
  assert.equal(await storage.getWaterLoggedStreak(today), 2);
  // сегодня ещё нет записей — серия считается со вчера
  assert.equal(await storage.getWaterLoggedStreak(new Date(2026, 8, 30, 8, 0)), 2);
  // пропуск двух дней обнуляет серию
  assert.equal(await storage.getWaterLoggedStreak(new Date(2026, 9, 1, 8, 0)), 0);
});

test('день, где удалены все приёмы, не считается днём с записью (средние/аналитика)', async () => {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  await storage.addWaterEntry(400, '2026-01-27', '21:15');
  await storage.removeWaterEntry(0, '2026-01-27', { t: '21:15', ml: 400, key: null });
  const day = await storage.getWaterDay('2026-01-27');
  assert.equal(pickWater(day), null);
  assert.equal(await storage.getWaterRecord(), null);
  assert.equal(pickWater({ total: 1500, entries: [] }), 1500, 'легаси-итог без приёмов по-прежнему учитывается');
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
