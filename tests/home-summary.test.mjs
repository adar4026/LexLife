/* =========================================================
   tests/home-summary.test.mjs — данные главного экрана (js/services/homeSummary.js).
   • вода: прогресс, «осталось» без отрицательных значений, цель выполнена / превышена;
   • «Требует внимания»: только существующие статусы (evaluateField — справочные
     значения приложения; outOfLabRange — числовой диапазон бланка), последнее значение
     показателя, порядок и лимит;
   • «Ближайшее»: одно предстоящее лекарство по его расписанию и отметке «принял сегодня»;
   • «Последняя активность»: самый поздний из анализа, измерения и прошедшего визита.
   • hero: вода относительно плана дня; лекарства на сегодня; ближайший визит.
   Без браузера. Только синтетические данные.

   Запуск:  node tests/home-summary.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { waterProgress, waterDayStatus, medsToday, upcomingVisit, attentionItems, recentActivity, upcomingMed, nextDose } from '../js/services/homeSummary.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const lab = (group, name, value, unit, refLow, refHigh) => ({ group, name, value, unit, ref: '', ...(refLow != null ? { refLow, refHigh } : {}) });

/* ================= вода ================= */

test('вода: обычный день — осталось и прогресс', () => {
  const p = waterProgress(2400, 2600);
  assert.equal(p.remaining, 200);
  assert.equal(p.progress, 2400 / 2600);
  assert.equal(p.reached, false);
  assert.equal(p.over, 0);
});

test('вода: цель ровно выполнена', () => {
  const p = waterProgress(2600, 2600);
  assert.deepEqual([p.remaining, p.progress, p.reached, p.over], [0, 1, true, 0]);
});

test('вода: выпито больше цели — «осталось» не отрицательное, прогресс не больше 1', () => {
  const p = waterProgress(3100, 2600);
  assert.deepEqual([p.remaining, p.progress, p.reached, p.over], [0, 1, true, 500]);
});

test('вода: пустой день, нет цели, мусор на входе', () => {
  assert.deepEqual(waterProgress(0, 2600), { current: 0, goal: 2600, progress: 0, remaining: 2600, reached: false, over: 0 });
  assert.deepEqual(waterProgress(500, 0), { current: 500, goal: 0, progress: 0, remaining: 0, reached: false, over: 0 });
  assert.equal(waterProgress(NaN, 2600).current, 0);
  assert.equal(waterProgress(-100, 2600).remaining, 2600);
  assert.equal(waterProgress(undefined, undefined).progress, 0);
});

/* ================= «Требует внимания» ================= */

test('внимание: основные поля — уровень и направление по справочным значениям приложения', () => {
  const { items, total } = attentionItems([{ id: 't1', date: '2026-02-14', ldl: 167, vitd: 23.8, chol: 180, hdl: 60, glucose: 90 }]);
  assert.equal(total, 2);
  assert.deepEqual(items.map((i) => [i.key, i.level, i.dir, i.label]), [
    ['ldl', 'danger', 'high', 'Выше нормы'],
    ['vitd', 'warn', 'low', 'Ниже нормы'],
  ]);
  assert.equal(items[0].name, 'LDL холестерин');
  assert.equal(items[0].unit, 'mg/dl');
  assert.equal(items[0].testId, 't1');
  assert.equal(items[0].date, '2026-02-14');
});

test('внимание: умеренное превышение — warn; диапазон goodMin…good даёт направление', () => {
  const { items } = attentionItems([{ id: 't1', date: '2026-02-14', ldl: 130, tsh: 0.1, hgb: 19 }]);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.deepEqual([by.ldl.level, by.ldl.dir], ['warn', 'high']);
  assert.deepEqual([by.tsh.level, by.tsh.dir], ['warn', 'low']);
  assert.deepEqual([by.hgb.level, by.hgb.dir], ['warn', 'high']);
});

test('внимание: все значения в пределах — пусто', () => {
  assert.deepEqual(attentionItems([{ id: 't1', date: '2026-02-14', ldl: 100, vitd: 40, hdl: 60 }]), { items: [], total: 0 });
  assert.deepEqual(attentionItems([]), { items: [], total: 0 });
  assert.deepEqual(attentionItems(null), { items: [], total: 0 });
});

test('внимание: учитывается только последнее значение показателя', () => {
  const list = [
    { id: 'old', date: '2026-01-10', ldl: 190, vitd: 20 },
    { id: 'new', date: '2026-02-14', ldl: 100 }, // LDL пришёл в норму, витамин D в новом анализе не сдавался
  ];
  const { items } = attentionItems(list);
  assert.deepEqual(items.map((i) => [i.key, i.testId]), [['vitd', 'old']]);
});

test('внимание: показатели лаборатории — только с числовым диапазоном бланка', () => {
  const list = [{
    id: 't1', date: '2026-02-14', customResults: [
      lab('Биохимия', 'Ферритин', 420, 'ng/mL', 30, 400),
      lab('Биохимия', 'Калий', 3.1, 'mmol/L', 3.5, 5.1),
      lab('Биохимия', 'Натрий', 140, 'mmol/L', 135, 145),
      { group: 'Биохимия', name: 'Кальций', value: 99, unit: 'mg/dL', ref: '8.5–10.5' }, // диапазон только текстом — не оцениваем
      { group: 'Анализ мочи', name: 'Белок', text: 'отрицательно', unit: '', ref: '' },
    ],
  }];
  const { items } = attentionItems(list);
  assert.deepEqual(items.map((i) => [i.name, i.dir, i.level, i.label]), [
    ['Ферритин', 'high', 'danger', 'Выше нормы'],
    ['Калий', 'low', 'warn', 'Ниже нормы'],
  ]);
  assert.equal(items[0].key, 'c:ферритин');
});

test('внимание: показатель лаборатории — тоже только последний результат', () => {
  const list = [
    { id: 'a', date: '2026-01-10', customResults: [lab('Биохимия', 'Ферритин', 500, 'ng/mL', 30, 400)] },
    { id: 'b', date: '2026-02-14', customResults: [lab('Биохимия', 'Ферритин', 200, 'ng/mL', 30, 400)] },
  ];
  assert.equal(attentionItems(list).total, 0);
});

test('внимание: сначала выраженные (danger), затем новые; лимит 3 и общее число', () => {
  const list = [
    { id: 'a', date: '2026-01-10', vitd: 20, hdl: 40 },
    { id: 'b', date: '2026-02-14', ldl: 170, trig: 350, hba1c: 6.0 },
  ];
  const all = attentionItems(list, { limit: 10 });
  assert.deepEqual(all.items.map((i) => i.key), ['ldl', 'trig', 'hba1c', 'hdl', 'vitd']);
  const top = attentionItems(list);
  assert.equal(top.items.length, 3);
  assert.equal(top.total, 5);
  assert.deepEqual(top.items.map((i) => i.level), ['danger', 'danger', 'warn']);
});

test('внимание: входные данные не меняются', () => {
  const list = [{ id: 'a', date: '2026-01-10', ldl: 170 }, { id: 'b', date: '2026-02-14', vitd: 20 }];
  const copy = JSON.parse(JSON.stringify(list));
  attentionItems(list);
  assert.deepEqual(list, copy);
});

/* ================= «Ближайшее» ================= */

const NOW = new Date(2026, 1, 14, 12, 0); // 14.02.2026 12:00 по локальному времени
const med = (o) => ({ id: 'm_' + o.name, active: true, dose: '', ...o });

test('ближайшее: нет лекарств, неактивные или без расписания — null (блок скрыт)', () => {
  assert.equal(upcomingMed([], { now: NOW }), null);
  assert.equal(upcomingMed(null, { now: NOW }), null);
  assert.equal(upcomingMed([med({ name: 'A', active: false, reminder_time: '21:00' }), med({ name: 'B' })], { now: NOW }), null);
});

test('ближайшее: из нескольких — самое раннее предстоящее, только одно', () => {
  const list = [med({ name: 'Вечернее', reminder_time: '21:00' }), med({ name: 'Дневное', reminder_time: '14:30', dose: '1 таб.' })];
  assert.deepEqual(upcomingMed(list, { now: NOW }), { id: 'm_Дневное', name: 'Дневное', dose: '1 таб.', date: '2026-02-14', time: '14:30' });
});

test('ближайшее: время сегодня прошло или приём отмечен — завтра', () => {
  const list = [med({ name: 'Утреннее', reminder_time: '08:00' })];
  assert.deepEqual(upcomingMed(list, { now: NOW }), { id: 'm_Утреннее', name: 'Утреннее', dose: '', date: '2026-02-15', time: '08:00' });
  const later = [med({ name: 'Вечернее', reminder_time: '21:00' })];
  assert.equal(upcomingMed(later, { now: NOW, takenToday: ['Вечернее'] }).date, '2026-02-15');
  assert.equal(upcomingMed(later, { now: NOW, takenToday: [] }).date, '2026-02-14');
});

test('ближайшее: курс «раз в N дней» — следующая доза; сегодняшняя доза отмечена — следующая по курсу', () => {
  const c = med({ name: 'Курс', every_days: 7, start: '2026-02-07' });
  assert.equal(nextDose(c, '2026-02-14'), '2026-02-14');
  assert.equal(nextDose(c, '2026-02-15'), '2026-02-21');
  assert.equal(nextDose({ ...c, start: '2026-03-01' }, '2026-02-14'), '2026-03-01'); // курс ещё не начался
  assert.equal(nextDose({ name: 'x' }, '2026-02-14'), null);
  assert.deepEqual(upcomingMed([c], { now: NOW }), { id: 'm_Курс', name: 'Курс', dose: '', date: '2026-02-14', time: null });
  assert.equal(upcomingMed([c], { now: NOW, takenToday: ['Курс'] }).date, '2026-02-21');
  const timed = { ...c, reminder_time: '09:00' }; // доза сегодня, но время прошло
  assert.deepEqual([upcomingMed([timed], { now: NOW }).date, upcomingMed([timed], { now: NOW }).time], ['2026-02-21', '09:00']);
});

test('ближайшее: курс закончился (end) — не показывается', () => {
  assert.equal(upcomingMed([med({ name: 'A', reminder_time: '08:00', end: '2026-02-14' })], { now: NOW }), null);
  assert.equal(upcomingMed([med({ name: 'B', reminder_time: '21:00', end: '2026-02-14' })], { now: NOW }).date, '2026-02-14');
  assert.equal(upcomingMed([med({ name: 'C', every_days: 7, start: '2026-02-01', end: '2026-02-14' })], { now: NOW }), null); // следующая доза 15.02 — после окончания
});

/* ================= «Последняя активность» ================= */

const TODAY = '2026-02-14';

test('активность: побеждает самая поздняя дата — измерение новее анализа', () => {
  const a = recentActivity({
    tests: [{ id: 'x', date: '2026-01-10', ldl: 100 }, { id: 'y', date: '2026-02-01', ldl: 110 }],
    metricsLog: { weight: { '2026-02-13': 80 } },
    visits: [{ id: 'v1', date: '2026-02-05', status: 'done' }],
    today: TODAY,
  });
  assert.deepEqual(a, { kind: 'metric', date: '2026-02-13', key: 'weight', value: 80 });
});

test('активность: анализ новее измерения и визита', () => {
  const a = recentActivity({
    tests: [{ id: 'y', date: '2026-02-12', customResults: [lab('Гематология', 'Лейкоциты', 6, '10^9/L', 4, 11)] }],
    metricsLog: { pulse: { '2026-02-01': 70 } },
    visits: [{ id: 'v1', date: '2026-02-05', status: 'done' }],
    today: TODAY,
  });
  assert.deepEqual(a, { kind: 'test', date: '2026-02-12', testId: 'y', summary: 'Гематология' });
});

test('активность: прошедший визит новее анализа и измерения', () => {
  const a = recentActivity({
    tests: [{ id: 'y', date: '2026-02-01', ldl: 100 }],
    metricsLog: { weight: { '2026-02-03': 80 } },
    visits: [
      { id: 'v1', date: '2026-02-10', status: 'done', specialty: 'Терапевт', doctor: 'Dr. Test' },
      { id: 'v2', date: '2026-02-12', status: 'planned', specialty: 'Кардиолог' }, // запланированный не участвует
    ],
    today: TODAY,
  });
  assert.deepEqual(a, { kind: 'visit', date: '2026-02-10', visitId: 'v1', title: 'Терапевт · Dr. Test' });
});

test('активность: будущие анализ, измерение и визит не участвуют; вода не считается', () => {
  const a = recentActivity({
    tests: [{ id: 'f', date: '2026-03-01', ldl: 100 }, { id: 'p', date: '2026-01-20', ldl: 100 }],
    metricsLog: {
      weight: { '2026-02-10': 80.5 },
      pressure: { '2026-02-12': { systolic: 120, diastolic: 80 } },
      pulse: { '2026-03-01': 70 },
      water: { '2026-02-14': { total: 500, entries: [] } },
    },
    visits: [{ id: 'vf', date: '2026-02-20', status: 'done' }],
    today: TODAY,
  });
  assert.deepEqual(a, { kind: 'metric', date: '2026-02-12', key: 'pressure', value: { systolic: 120, diastolic: 80 } });
});

test('активность: равная дата (времени у записей нет) — анализ, затем измерение, затем визит', () => {
  const base = { metricsLog: { weight: { '2026-02-10': 80 } }, visits: [{ id: 'v', date: '2026-02-10', status: 'done' }], today: TODAY };
  assert.equal(recentActivity({ ...base, tests: [{ id: 't', date: '2026-02-10', ldl: 100 }] }).kind, 'test');
  assert.equal(recentActivity({ ...base, tests: [] }).kind, 'metric');
});

test('активность: нет данных — null (секция скрывается)', () => {
  assert.equal(recentActivity({ today: TODAY }), null);
  assert.equal(recentActivity({ tests: [], metricsLog: {}, visits: [{ id: 'p', date: '2026-03-01', status: 'planned' }], today: TODAY }), null);
});

/* ================= hero: план дня, лекарства на сегодня, ближайший визит ================= */

test('hero: вода по плану, отставание, цель выполнена, цели нет', () => {
  assert.deepEqual(waterDayStatus(1200, 2600, 1100), { state: 'onTrack', behind: 0, over: 0 });
  assert.deepEqual(waterDayStatus(1200, 2600, 1200), { state: 'onTrack', behind: 0, over: 0 });
  assert.deepEqual(waterDayStatus(900, 2600, 1250), { state: 'behind', behind: 350, over: 0 });
  assert.deepEqual(waterDayStatus(2900, 2600, 2600), { state: 'done', behind: 0, over: 300 });
  assert.deepEqual(waterDayStatus(500, 0, 0), { state: 'none', behind: 0, over: 0 });
});

test('hero: план до подъёма (0) и мусор — «по плану», отставание не больше цели', () => {
  assert.equal(waterDayStatus(0, 2600, 0).state, 'onTrack');
  assert.equal(waterDayStatus(0, 2600, undefined).state, 'onTrack');
  assert.equal(waterDayStatus(NaN, 2600, -50).state, 'onTrack');
  assert.equal(waterDayStatus(100, 2600, 99999).behind, 2500);
});

test('лекарства на сегодня: активные, отмеченные — по имени; неактивные и закончившиеся не считаются', () => {
  const list = [
    med({ name: 'A', reminder_time: '08:00' }),
    med({ name: 'B' }), // без расписания — отмечается ежедневно
    med({ name: 'C', active: false }),
    med({ name: 'D', reminder_time: '21:00', end: '2026-02-13' }),
    med({ name: 'E', start: '2026-02-20' }),
  ];
  assert.deepEqual(medsToday(list, { today: '2026-02-14', takenToday: ['A', 'C'] }), { due: 2, taken: 1 });
  assert.deepEqual(medsToday(list, { today: '2026-02-14', takenToday: ['A', 'B'] }), { due: 2, taken: 2 });
  assert.deepEqual(medsToday([], { today: '2026-02-14' }), { due: 0, taken: 0 });
  assert.deepEqual(medsToday(null), { due: 0, taken: 0 });
});

test('лекарства на сегодня: курс «раз в N дней» — только в день дозы', () => {
  const c = med({ name: 'Курс', every_days: 7, start: '2026-02-07' });
  assert.deepEqual(medsToday([c], { today: '2026-02-14' }), { due: 1, taken: 0 });
  assert.deepEqual(medsToday([c], { today: '2026-02-15' }), { due: 0, taken: 0 });
  assert.deepEqual(medsToday([c], { today: '2026-02-14', takenToday: ['Курс'] }), { due: 1, taken: 1 });
});

test('ближайший визит: запланированный или «следующий визит», не в прошлом, самый ранний', () => {
  const visits = [
    { id: 'v1', date: '2026-01-10', status: 'done', specialty: 'Кардиолог', doctor: 'Петров', nextDate: '2026-03-01' },
    { id: 'v2', date: '2026-02-20', status: 'planned', specialty: 'Терапевт' },
    { id: 'v3', date: '2026-02-01', status: 'planned', specialty: 'Окулист' }, // в прошлом
  ];
  assert.deepEqual(upcomingVisit(visits, '2026-02-14'), { visitId: 'v2', date: '2026-02-20', title: 'Терапевт', next: false });
  assert.deepEqual(upcomingVisit(visits, '2026-02-21'), { visitId: 'v1', date: '2026-03-01', title: 'Кардиолог · Петров', next: true });
  assert.equal(upcomingVisit(visits, '2026-03-02'), null);
  assert.equal(upcomingVisit([{ id: 'v', date: '2026-02-14', status: 'done' }], '2026-02-14'), null);
  assert.equal(upcomingVisit([{ id: 'v', date: '2026-02-14', status: 'planned' }], '2026-02-14').title, 'Визит к врачу');
  assert.equal(upcomingVisit(null, '2026-02-14'), null);
});

/* ---------- запуск ---------- */
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${t.name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
  }
}
console.log(`${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
