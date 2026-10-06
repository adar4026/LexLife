/* =========================================================
   tests/journals.test.mjs — «Все журналы» (js/services/journals.js): провайдеры типов,
   группировка по дням, итоги дня, фильтры, порционный показ, адрес экрана; правка,
   перенос и удаление через существующие методы StorageService — журнал перечитывается
   из тех же ключей (отдельного хранилища нет), формат резервной копии не меняется.
   Без браузера: StorageService на MemoryDriver. Только синтетические данные.

   Запуск:  node tests/journals.test.mjs   (npm test — в нескольких timezone)
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, CURRENT_SCHEMA_VERSION } from '../js/services/storage.js';
import {
  JOURNAL_TYPES, buildJournal, filterJournal, groupJournal, daySummary, journalFilters, journalEmptyText, journalDayLabel,
  visibleDays, todayJournal, parseJournalRoute, journalRoute, compareInDay, JOURNAL_PAGE_DAYS, addDays,
} from '../js/services/journals.js';
import { normalizeDailyInput, normalizeRideInput } from '../js/services/activity.js';

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = (s) => String(s).replace(/[  ]/g, ' ');

const TODAY = '2026-10-05';
const GOAL = 2600;
/* сценарий со скриншотов: сегодня 1 500, вчера 300 + 300 в 10:31, 3 октября 200 + 300 + 500 */
const WATER = {
  '2026-10-05': { total: 1500, entries: [{ t: '18:22', ml: 1500 }] },
  '2026-10-04': { total: 600, entries: [{ t: '10:31', ml: 300 }, { t: '10:31', ml: 300 }] },
  '2026-10-03': { total: 1000, entries: [{ t: '23:33', ml: 200 }, { t: '23:37', ml: 300 }, { t: '23:40', ml: 500 }] },
};
const SLEEP = [{
  id: 'sl-1', date: '2026-10-05', sleepStart: '2026-10-04T23:23', sleepEnd: '2026-10-05T07:05', durationMinutes: 462,
  quality: 4, awakenings: 0, naps: [], tags: [], note: '', createdAt: '2026-10-05T07:10:00.000Z', updatedAt: '2026-10-05T07:10:00.000Z',
}];
const steps = (date, value, source) => normalizeDailyInput('steps', { date, value, source }, { today: TODAY }).value;
const ride = (date, time, km, minutes = '') => normalizeRideInput({ date, time, km, minutes }, { today: TODAY }).value;
const data = (over = {}) => ({
  metricsLog: { water: WATER, weight: { '2026-10-05': 76.4, '2026-09-15': 77.1 }, pressure: { '2026-10-05': { systolic: 128, diastolic: 82 } } },
  sleep: SLEEP,
  steps: { '2026-10-05': { ...steps('2026-10-05', '8420'), createdAt: 'x', updatedAt: 'x' } },
  bike: [{ id: 'r1', ...ride('2026-10-05', '17:30', '8,4', '43'), createdAt: 'a', updatedAt: 'a' }, { id: 'r2', ...ride('2026-10-05', '08:10', '4', ''), createdAt: 'b', updatedAt: 'b' }],
  ...over,
});
const ctx = { waterGoal: GOAL, sleepGoal: 480 };
const waterOnly = () => buildJournal({ metricsLog: { water: WATER } }, ctx);

/* Storage «существующей установки» (без демо-данных): только заданные ключи */
async function install(keys) {
  const d = new MemoryDriver();
  await d.set('health_meta', JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, seededAt: '2026-01-01T00:00:00.000Z' }));
  for (const [k, v] of Object.entries(keys)) await d.set(k, JSON.stringify(v));
  const s = new StorageService(d);
  await s.init();
  return s;
}
async function journalOf(s) {
  const [metricsLog, sleep, st, bike] = await Promise.all([s.getMetricsLog(), s.getSleepEntries(), s.getDailyActivityLog('steps'), s.getBikeRides()]);
  return buildJournal({ metricsLog, sleep, steps: st, bike }, ctx);
}
const dayOf = (groups, date) => groups.find((g) => g.date === date);

/* ---------- группировка и порядок ---------- */
test('1. группировка по дате записи (dateKey)', () => {
  const g = groupJournal(waterOnly(), { today: TODAY });
  assert.deepEqual(g.map((x) => x.date), ['2026-10-05', '2026-10-04', '2026-10-03']);
  assert.ok(g.every((x) => x.items.every((it) => it.date === x.date)));
});
test('2. дни: новые сверху', () => {
  const items = buildJournal({ metricsLog: { water: { '2026-01-02': WATER['2026-10-03'], '2026-12-31': WATER['2026-10-05'], '2025-12-31': WATER['2026-10-04'] } } }, ctx);
  assert.deepEqual(groupJournal(items, { today: TODAY }).map((x) => x.date), ['2026-12-31', '2026-01-02', '2025-12-31']);
});
test('3. внутри дня новые сверху; одинаковое время — позже добавленная выше; без времени — ниже', () => {
  const d3 = dayOf(groupJournal(waterOnly(), { today: TODAY }), '2026-10-03');
  assert.deepEqual(d3.items.map((x) => x.time), ['23:40', '23:37', '23:33']);
  const d4 = dayOf(groupJournal(waterOnly(), { today: TODAY }), '2026-10-04');
  assert.deepEqual(d4.items.map((x) => x.ref.index), [1, 0]);
  const today = dayOf(groupJournal(buildJournal(data(), ctx), { today: TODAY }), TODAY);
  const times = today.items.map((x) => x.time);
  assert.deepEqual(times.filter(Boolean), [...times.filter(Boolean)].sort().reverse());
  assert.ok(times.indexOf(null) > times.lastIndexOf('08:10'), 'записи без времени (шаги, вес, давление) — после записей со временем');
  assert.equal(compareInDay({ time: '10:00', type: 'water', seq: 0 }, { time: null, type: 'water', seq: 0 }) < 0, true);
});
test('4–6. подписи дней: «Сегодня», «Вчера», «03 октября 2026»', () => {
  assert.equal(journalDayLabel('2026-10-05', TODAY), 'Сегодня');
  assert.equal(journalDayLabel('2026-10-04', TODAY), 'Вчера');
  assert.equal(journalDayLabel('2026-10-03', TODAY), '03 октября 2026');
  assert.equal(journalDayLabel('2025-12-31', '2026-01-01'), 'Вчера'); // через границу года
  assert.equal(journalDayLabel('2026-03-01', TODAY), '01 марта 2026');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30'); // переход на летнее время — без сдвига дня
});

/* ---------- вода ---------- */
test('7. вода 200 + 300 + 500 = 1 000 мл; сценарий: 1 500 · 600 · 1 000', () => {
  const g = groupJournal(waterOnly(), { today: TODAY });
  assert.deepEqual(g.map((x) => `${x.label} • ${plain(x.summary)}`), ['Сегодня • 1 500 мл', 'Вчера • 600 мл', '03 октября 2026 • 1 000 мл']);
});
test('8. записи дня не склеиваются: 3 отдельные карточки, у каждой своё значение', () => {
  const d3 = dayOf(groupJournal(waterOnly(), { today: TODAY }), '2026-10-03');
  assert.equal(d3.items.length, 3);
  assert.deepEqual(d3.items.map((x) => plain(x.value)), ['500 мл', '300 мл', '200 мл']);
  assert.equal(new Set(d3.items.map((x) => x.id)).size, 3);
  assert.equal(dayOf(groupJournal(waterOnly(), { today: TODAY }), '2026-10-04').items.length, 2);
});
test('21. вода без регрессии: % цели — накопительный ПОСЛЕ записи (8 → 19 → 38), округление как у % воды на Главной; вчера 12 → 23; сегодня 58', () => {
  const g = groupJournal(waterOnly(), { today: TODAY });
  assert.deepEqual(dayOf(g, '2026-10-03').items.map((x) => x.progress.pct), [38, 19, 8]);
  assert.deepEqual(dayOf(g, '2026-10-04').items.map((x) => x.progress.pct), [23, 12]);
  assert.deepEqual(dayOf(g, TODAY).items.map((x) => x.progress.pct), [58]); // = «58% от цели» в hero (Math.round(1500 / 2600 × 100))
  assert.equal(dayOf(g, TODAY).items[0].progress.label, 'ежедневная цель');
  /* время и источник — из самой записи */
  assert.equal(plain(dayOf(g, '2026-10-03').items[0].sub), '23:40 · вручную');
  /* без цели — без процента */
  assert.equal(buildJournal({ metricsLog: { water: WATER } }, {})[0].progress, null);
});
test('вода: остаток итога без разбивки по приёмам — отдельная запись, итог дня = итогу экрана «Вода»', () => {
  const items = buildJournal({ metricsLog: { water: { '2026-09-01': { total: 1700, entries: [{ t: '09:00', ml: 200 }] }, '2026-09-02': { total: 900, entries: [] } } } }, ctx);
  const g = groupJournal(items, { today: TODAY });
  assert.equal(plain(dayOf(g, '2026-09-01').summary), '1 700 мл');
  assert.equal(dayOf(g, '2026-09-01').items.length, 2);
  assert.equal(plain(dayOf(g, '2026-09-02').summary), '900 мл');
  assert.equal(dayOf(g, '2026-09-02').items[0].ref.legacy, true);
  assert.equal(dayOf(g, '2026-09-02').items[0].time, null);
});
test('вода: напиток — своё название, WaterMinder — источник; некорректные записи пропускаются', () => {
  const items = buildJournal({ metricsLog: { water: { '2026-09-01': { total: 500, entries: [{ t: '09:00', ml: 200, drink: 'Кофе', key: 'wm:abc' }, { t: '9:0', ml: 100 }, { t: '10:00', ml: -5 }, null, { t: '11:00', ml: 300 }] } } } }, ctx);
  assert.equal(items.filter((x) => x.time).length, 2);
  assert.equal(items[0].title, 'Кофе');
  assert.match(items[0].sub, /WaterMinder/);
});

/* ---------- фильтры ---------- */
test('9. фильтр «Все» — все типы', () => {
  const all = buildJournal(data(), ctx);
  assert.deepEqual([...new Set(filterJournal(all, 'all').map((x) => x.type))].sort(), ['bike', 'pressure', 'sleep', 'steps', 'water', 'weight']);
  assert.equal(filterJournal(all, 'all').length, all.length);
});
test('10. фильтр «Вода» — только вода; итог дня по воде', () => {
  const only = filterJournal(buildJournal(data(), ctx), 'water');
  assert.ok(only.length && only.every((x) => x.type === 'water'));
  assert.equal(plain(dayOf(groupJournal(only, { today: TODAY }), TODAY).summary), '1 500 мл');
});
test('11. переключение фильтров: Вода → Сон → Все; фильтры — только существующие типы', () => {
  const all = buildJournal(data(), ctx);
  assert.deepEqual(groupJournal(filterJournal(all, 'sleep'), { today: TODAY }).map((x) => x.date), [TODAY]);
  assert.equal(groupJournal(filterJournal(all, 'water'), { today: TODAY }).length, 3);
  assert.ok(groupJournal(filterJournal(all, 'all'), { today: TODAY }).length >= 4);
  const ids = journalFilters(all).map((f) => f.id);
  assert.deepEqual(ids, ['all', 'water', 'sleep', 'steps', 'bike', 'weight', 'pressure']);
  assert.ok(!ids.includes('pulse'), 'нет записей пульса — нет и фильтра');
  assert.ok(!JOURNAL_TYPES.some((t) => t.id === 'walk' || t.id === 'waist'), 'типов без данных в LexLife не выдумываем');
  /* журнал открыт из раздела без записей — его фильтр виден */
  assert.ok(journalFilters([], 'pulse').some((f) => f.id === 'pulse'));
  assert.deepEqual(journalFilters([]).map((f) => f.id), ['all', 'water', 'sleep', 'steps', 'bike']);
});

/* ---------- итоги дня ---------- */
test('12. итог дня каждого типа — свой формат', () => {
  const g = (f) => dayOf(groupJournal(filterJournal(buildJournal(data(), ctx), f), { today: TODAY }), TODAY).summary;
  assert.equal(plain(g('water')), '1 500 мл');
  assert.equal(plain(g('steps')), '8 420 шагов');
  assert.equal(plain(g('bike')), '12,4 км'); // 8,4 + 4
  assert.equal(plain(g('sleep')), '7 ч 42 мин');
  assert.equal(plain(g('weight')), '76,4 кг');
  assert.equal(plain(g('pressure')), '1 измерение');
  const P = JOURNAL_TYPES.find((t) => t.id === 'pressure');
  assert.equal(plain(P.summary([{}, {}])), '2 измерения');
  /* поездки только без дистанции — не «0 км» */
  const trainer = buildJournal({ bike: [{ id: 'x', date: '2026-10-01', time: null, km: null, minutes: 35, note: 'Велотренажёр', source: 'activity' }] }, ctx);
  assert.equal(plain(groupJournal(trainer, { today: TODAY })[0].summary), '1 поездка');
  assert.equal(trainer[0].title, 'Велотренажёр');
  assert.equal(plain(trainer[0].value), '35 мин');
});
test('13. разные типы в одном дне — «N записей», единицы не складываются', () => {
  const day = dayOf(groupJournal(buildJournal(data(), ctx), { today: TODAY }), TODAY);
  assert.equal(plain(day.summary), `${day.items.length} записей`);
  assert.equal(day.items.length, 7); // вода, сон, шаги, 2 поездки, вес, давление
  assert.equal(plain(daySummary([{ type: 'water', amount: 1 }, { type: 'sleep', amount: 1 }])), '2 записи');
  assert.equal(daySummary([]), '');
});
test('карточки: значение и подпись по типу (сон, шаги, поездка, вес, давление)', () => {
  const all = buildJournal(data(), ctx);
  const by = (id) => all.find((x) => x.id === id);
  assert.equal(plain(by('sleep:sl-1').value), '7 ч 42 мин');
  assert.equal(plain(by('sleep:sl-1').sub), '23:23 → 07:05');
  assert.equal(by('sleep:sl-1').progress.pct, 96);
  assert.equal(plain(by(`steps:${TODAY}`).value), '8 420');
  assert.match(plain(by(`steps:${TODAY}`).sub), /^≈ 6,3 км/);
  assert.equal(plain(by('bike:r1').value), '8,4 км');
  assert.equal(plain(by('bike:r1').sub), '43 мин · 17:30');
  assert.equal(plain(by(`weight:${TODAY}`).value), '76,4 кг');
  assert.equal(by(`pressure:${TODAY}`).value, '128/82');
});

/* ---------- правка / удаление через существующий CRUD Storage ---------- */
test('14–18. открыть (ref) → изменить → удалить: журнал пересчитывается, пустой день исчезает', async () => {
  const s = await install({ metrics_log: { water: structuredClone(WATER) } });
  let g = groupJournal(filterJournal(await journalOf(s), 'water'), { today: TODAY });
  /* 14. открыть: ref указывает ровно на показанную запись */
  const card = dayOf(g, '2026-10-03').items[1]; // 23:37 · 300
  assert.equal(card.ref.entry.t, '23:37');
  assert.equal(card.ref.entry.ml, 300);
  /* 15. изменить: 300 → 450 в той же записи */
  assert.ok(await s.updateWaterEntry(card.ref.date, card.ref.index, card.ref.entry, { t: '23:37', ml: 450 }));
  g = groupJournal(filterJournal(await journalOf(s), 'water'), { today: TODAY });
  /* 17. итог дня пересчитан */
  assert.equal(plain(dayOf(g, '2026-10-03').summary), '1 150 мл');
  assert.equal(dayOf(g, '2026-10-03').items.length, 3);
  /* 16. удалить одну запись */
  const one = dayOf(g, '2026-10-03').items[0];
  assert.ok(await s.removeWaterEntry(one.ref.index, one.ref.date, one.ref.entry));
  g = groupJournal(filterJournal(await journalOf(s), 'water'), { today: TODAY });
  assert.equal(dayOf(g, '2026-10-03').items.length, 2);
  assert.equal(plain(dayOf(g, '2026-10-03').summary), '650 мл');
  /* 18. удалить все записи дня — дня больше нет */
  for (const it of [...dayOf(g, '2026-10-04').items]) {
    const cur = groupJournal(filterJournal(await journalOf(s), 'water'), { today: TODAY });
    const x = dayOf(cur, '2026-10-04').items.find((y) => y.ref.entry.t === it.ref.entry.t);
    assert.ok(await s.removeWaterEntry(x.ref.index, x.ref.date, x.ref.entry));
  }
  g = groupJournal(filterJournal(await journalOf(s), 'water'), { today: TODAY });
  assert.equal(dayOf(g, '2026-10-04'), undefined);
  assert.deepEqual(g.map((x) => x.date), ['2026-10-05', '2026-10-03']);
});
test('перенос записи воды на другую дату: уходит из старого дня, появляется в новом', async () => {
  const s = await install({ metrics_log: { water: structuredClone(WATER) } });
  const it = dayOf(groupJournal(await journalOf(s), { today: TODAY }), TODAY).items[0];
  assert.ok(await s.updateWaterEntry(it.ref.date, it.ref.index, it.ref.entry, { t: '21:00', ml: 1500, date: '2026-09-20' }));
  const g = groupJournal(await journalOf(s), { today: TODAY });
  assert.equal(dayOf(g, TODAY), undefined);
  assert.equal(plain(dayOf(g, '2026-09-20').summary), '1 500 мл');
  assert.equal(dayOf(g, '2026-09-20').label, '20 сентября 2026');
});
test('точечные показатели: правка, перенос и удаление значения дня (moveMetricValue / removeMetricValue)', async () => {
  const s = await install({ metrics_log: { weight: { '2026-10-05': 76.4, '2026-09-15': 77.1 } } });
  assert.ok(await s.moveMetricValue('weight', '2026-10-05', '2026-10-05', 76.2));
  assert.ok(await s.moveMetricValue('weight', '2026-09-15', '2026-09-14', 77));
  assert.deepEqual(await s.getMetricLog('weight'), { '2026-10-05': 76.2, '2026-09-14': 77 });
  assert.equal(await s.moveMetricValue('weight', '2026-09-15', '2026-09-16', 70), false, 'исходного значения нет — ничего не меняется');
  assert.ok(await s.removeMetricValue('weight', '2026-09-14'));
  assert.equal(await s.removeMetricValue('weight', '2026-09-14'), false);
  const g = groupJournal(filterJournal(await journalOf(s), 'weight'), { today: TODAY });
  assert.deepEqual(g.map((x) => [x.date, plain(x.summary)]), [['2026-10-05', '76,2 кг']]);
});
test('шаги и поездки: правка / удаление существующим API — журнал видит изменения', async () => {
  const s = await install({});
  await s.saveDailyActivity('steps', steps('2026-09-28', '5000'));
  const r = await s.addBikeRide(ride('2026-10-01', '09:00', '10', '30'));
  let g = groupJournal(await journalOf(s), { today: TODAY });
  assert.equal(plain(dayOf(g, '2026-09-28').summary), '5 000 шагов');
  assert.equal(plain(dayOf(g, '2026-10-01').summary), '10,0 км'); // как в разделе «Велосипед»
  await s.saveDailyActivity('steps', steps('2026-09-28', '6200'), { from: '2026-09-28' });
  await s.removeBikeRide(r.id);
  g = groupJournal(await journalOf(s), { today: TODAY });
  assert.equal(plain(dayOf(g, '2026-09-28').summary), '6 200 шагов');
  assert.equal(dayOf(g, '2026-10-01'), undefined);
});

/* ---------- исторические даты ---------- */
test('19. записи задним числом попадают в свой день, а не в сегодня', async () => {
  const s = await install({});
  await s.addWaterEntry(500, '2026-10-03', '23:40');
  await s.saveDailyActivity('steps', steps('2026-09-28', '7000'));
  await s.addBikeRide(ride('2026-10-01', '', '6,5'));
  await s.setMetricValue('weight', 76.4, '2026-09-15');
  const g = groupJournal(await journalOf(s), { today: TODAY });
  assert.deepEqual(g.map((x) => x.date), ['2026-10-03', '2026-10-01', '2026-09-28', '2026-09-15']);
  assert.equal(dayOf(g, TODAY), undefined);
  assert.equal(dayOf(g, '2026-10-03').items[0].time, '23:40');
  assert.equal(dayOf(g, '2026-10-01').items[0].time, null); // поездка без времени
});

/* ---------- состояние экрана ---------- */
test('20. фильтр и дата — в адресе экрана; неизвестный фильтр → «Все»', () => {
  assert.deepEqual(parseJournalRoute(''), { filter: 'all', focus: null });
  assert.deepEqual(parseJournalRoute('water'), { filter: 'water', focus: null });
  assert.deepEqual(parseJournalRoute('steps/2026-09-28'), { filter: 'steps', focus: '2026-09-28' });
  assert.deepEqual(parseJournalRoute('nope/2026-13'), { filter: 'all', focus: null });
  assert.equal(journalRoute('all'), 'journals');
  assert.equal(journalRoute('water'), 'journals/water');
  assert.equal(journalRoute('steps', '2026-09-28'), 'journals/steps/2026-09-28');
  assert.equal(journalRoute('all', '2026-09-28'), 'journals/all/2026-09-28');
  for (const f of ['all', 'water', 'sleep', 'pressure']) assert.equal(parseJournalRoute(journalRoute(f).slice(9)).filter, f);
});
test('порционный показ: первые N дней; дата из адреса всегда видна; «Сегодняшние журналы» — до 3 новых', () => {
  const many = {};
  for (let i = 0; i < 60; i++) many[addDays(TODAY, -i)] = { total: 250, entries: [{ t: '09:00', ml: 250 }] };
  const g = groupJournal(buildJournal({ metricsLog: { water: many } }, ctx), { today: TODAY });
  assert.equal(visibleDays(g).length, JOURNAL_PAGE_DAYS);
  assert.equal(visibleDays(g, 42).length, 42);
  assert.equal(visibleDays(g, JOURNAL_PAGE_DAYS, addDays(TODAY, -50)).at(-1).date, addDays(TODAY, -50));
  assert.equal(visibleDays(g, 5, '2020-01-01').length, 5); // даты нет — лимит как есть
  const t = todayJournal(buildJournal(data(), ctx), TODAY, 3);
  assert.equal(t.items.length, 3);
  assert.equal(t.total, 7);
  assert.deepEqual(t.items.map((x) => x.time), ['18:22', '17:30', '08:10']);
  assert.equal(journalEmptyText('all'), 'Записей пока нет');
  assert.equal(journalEmptyText('water'), 'Нет записей воды');
  assert.equal(journalEmptyText('sleep'), 'Нет записей сна');
});

/* ---------- резервная копия ---------- */
test('22. backup/restore: новых ключей нет, журнал после восстановления тот же', async () => {
  const s = await install({ metrics_log: { water: WATER, weight: { '2026-09-15': 77.1 } }, sleep_log: SLEEP });
  const before = groupJournal(await journalOf(s), { today: TODAY });
  const backup = await s.exportBackup();
  assert.ok(!Object.keys(backup.data).some((k) => /journal/i.test(k)), 'журнал не хранится отдельно');
  const json = JSON.stringify(backup);
  const dst = await install({});
  await dst.restoreBackup(await dst.prepareRestore(parseBackup(json)));
  const after = groupJournal(await journalOf(dst), { today: TODAY });
  assert.deepEqual(after.map((x) => [x.date, plain(x.summary), x.items.length]), before.map((x) => [x.date, plain(x.summary), x.items.length]));
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
