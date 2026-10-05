/* =========================================================
   tests/visit-kinds.test.mjs — поиск и относительное время записей
   «Врачи и визиты» (js/services/visitKinds.js):
   • visitMatchesQuery — поиск по названию, врачу, специальности, клинике, заметкам;
     регистронезависимый, кириллица/латиница/испанский, не меняет данные;
   • relativeVisitLabel — «прошло/через + максимум 2 календарные единицы» от локальной
     календарной даты (без миллисекунд), с переходом между месяцами, годами и високосным годом.
   Без браузера. Только синтетические данные.

   Запуск:  node tests/visit-kinds.test.mjs
   (запускается также с разными TZ через tests/run-all.mjs — вычисления не должны зависеть от часового пояса)
   ========================================================= */

import assert from 'node:assert/strict';
import { visitMatchesQuery, relativeVisitLabel } from '../js/services/visitKinds.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ================= поиск ================= */

test('поиск: по названию визита', () => {
  assert.equal(visitMatchesQuery({ title: 'УЗИ сосудов шеи' }, 'сосудов'), true);
  assert.equal(visitMatchesQuery({ title: 'УЗИ сосудов шеи' }, 'печень'), false);
});

test('поиск: по имени врача', () => {
  assert.equal(visitMatchesQuery({ doctor: 'Dr. Ivanov' }, 'ivanov'), true);
  assert.equal(visitMatchesQuery({ doctor: 'Петров А.И.' }, 'петров'), true);
});

test('поиск: по специальности и клинике', () => {
  const v = { specialty: 'Кардиолог', clinic: 'Hospital La Paz' };
  assert.equal(visitMatchesQuery(v, 'кардиолог'), true);
  assert.equal(visitMatchesQuery(v, 'la paz'), true);
});

test('поиск: по заметке/заключению/рекомендациям', () => {
  assert.equal(visitMatchesQuery({ reason: 'Головная боль' }, 'головная'), true);
  assert.equal(visitMatchesQuery({ conclusion: 'Здоров' }, 'здоров'), true);
  assert.equal(visitMatchesQuery({ recommendations: 'Повторить анализ через месяц' }, 'повторить'), true);
});

test('поиск: без учёта регистра — кириллица, латиница, испанский', () => {
  assert.equal(visitMatchesQuery({ doctor: 'Иван Петров' }, 'ИВАН'), true);
  assert.equal(visitMatchesQuery({ doctor: 'Dr. SMITH' }, 'smith'), true);
  assert.equal(visitMatchesQuery({ doctor: 'José Muñoz' }, 'MUÑOZ'), true);
  assert.equal(visitMatchesQuery({ specialty: 'Cardiólogo' }, 'cardiólogo'), true);
});

test('поиск: пустой запрос — показывает всё (полный список)', () => {
  assert.equal(visitMatchesQuery({ title: 'Что угодно' }, ''), true);
  assert.equal(visitMatchesQuery({ title: 'Что угодно' }, '   '), true);
  assert.equal(visitMatchesQuery({}, ''), true);
});

test('поиск: нет результатов — ни одно поле не совпадает', () => {
  const v = { title: 'УЗИ', doctor: 'Иванов', specialty: 'Терапевт', clinic: 'Клиника №1', reason: 'плановый осмотр' };
  assert.equal(visitMatchesQuery(v, 'стоматолог'), false);
});

test('поиск: не меняет исходную запись', () => {
  const v = { title: 'Визит', doctor: 'Иванов' };
  const copy = JSON.parse(JSON.stringify(v));
  visitMatchesQuery(v, 'иванов');
  assert.deepEqual(v, copy);
});

test('поиск: работает одинаково для запланированных и прошедших (поле status не влияет)', () => {
  assert.equal(visitMatchesQuery({ title: 'Консультация', status: 'planned' }, 'консультация'), true);
  assert.equal(visitMatchesQuery({ title: 'Консультация', status: 'done' }, 'консультация'), true);
});

/* ================= относительное время ================= */

test('относительное время: сегодняшняя дата', () => {
  assert.equal(relativeVisitLabel('2026-10-04', '2026-10-04'), 'сегодня');
});

test('относительное время: прошедшая дата — дни', () => {
  assert.equal(relativeVisitLabel('2026-10-01', '2026-10-04'), 'прошло 3 дн.');
  assert.equal(relativeVisitLabel('2026-09-30', '2026-10-04'), 'прошло 4 дн.');
});

test('относительное время: будущая дата — дни', () => {
  assert.equal(relativeVisitLabel('2026-10-07', '2026-10-04'), 'через 3 дн.');
});

test('относительное время: недели + дни (прошлое и будущее)', () => {
  assert.equal(relativeVisitLabel('2026-09-19', '2026-10-04'), 'прошло 2 нед. 1 дн.'); // 15 дней
  assert.equal(relativeVisitLabel('2026-10-19', '2026-10-04'), 'через 2 нед. 1 дн.');
});

test('относительное время: ровно недели, без «0 дней»', () => {
  assert.equal(relativeVisitLabel('2026-09-20', '2026-10-04'), 'прошло 2 нед.'); // 14 дней, без «0 дн.»
});

test('относительное время: переход между месяцами — месяцы + дни реальной длины', () => {
  assert.equal(relativeVisitLabel('2026-07-30', '2026-10-04'), 'прошло 2 мес. 4 дн.');
  assert.equal(relativeVisitLabel('2026-11-12', '2026-10-04'), 'через 1 мес. 8 дн.');
});

test('относительное время: ровно месяц, без «0 дней»', () => {
  assert.equal(relativeVisitLabel('2026-09-04', '2026-10-04'), 'прошло 1 мес.');
});

test('относительное время: переход между годами — годы + месяцы, дни не показываем (максимум 2 единицы)', () => {
  assert.equal(relativeVisitLabel('2025-06-15', '2026-08-20'), 'прошло 1 г. 2 мес.');
  assert.equal(relativeVisitLabel('2025-08-20', '2026-08-20'), 'прошло 1 г.');
});

test('относительное время: конец февраля — обычный год (28 дней), без искусственных «30-дневных месяцев»', () => {
  assert.equal(relativeVisitLabel('2025-01-31', '2025-02-28'), 'прошло 1 мес.');
});

test('относительное время: високосный год — 29 февраля учитывается', () => {
  assert.equal(relativeVisitLabel('2024-01-31', '2024-03-01'), 'прошло 1 мес. 1 дн.'); // Feb 2024 = 29 дней
  assert.equal(relativeVisitLabel('2024-02-29', '2025-03-01'), 'прошло 1 г.'); // високосный день → невисокосный год
});

test('относительное время: мусорная/отсутствующая дата — пустая строка, без ошибки', () => {
  assert.equal(relativeVisitLabel('', '2026-10-04'), '');
  assert.equal(relativeVisitLabel(null, '2026-10-04'), '');
  assert.equal(relativeVisitLabel('не дата', '2026-10-04'), '');
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
