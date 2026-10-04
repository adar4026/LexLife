/* =========================================================
   tests/e2e/meds.e2e.mjs — сквозная проверка экрана «Лекарства» в настоящем браузере:
   пустое состояние → форма (без названия не сохраняется) → карточка → отметка
   конкретного приёма → правка без потери истории → удаление с подтверждением.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском
   сохраняет лекарства этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/meds.e2e.mjs'); await m.run();
   run({ keep: true }) — оставить синтетические данные (для скриншотов).
   ========================================================= */

import { dateKey } from '../../js/services/storage.js';

const KEYS = ['health_meds', 'med_intakes', 'med_log'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 6000) {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
    await sleep(40);
  }
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function go(hash) {
  location.hash = hash;
  await waitFor(() => location.hash === hash, `адрес ${hash}`);
  await sleep(250);
}
const card = (name) => $$('.med-card').find((c) => $('.med-card__name', c).textContent === name);
const slotBtn = (c, time) => $$('.med-slot__btn', c).find((b) => b.dataset.slot === time);
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
async function clickDialog(label) {
  const b = await waitFor(() => $$('.dialog__btn').find((x) => x.textContent === label), `кнопка диалога «${label}»`);
  b.click();
  await sleep(150);
}
async function fillForm({ name, dose = '', times = [], mode = 'daily' }) {
  await waitFor(() => $('#mf-name'), 'форма лекарства');
  type($('#mf-name'), name);
  type($('#mf-dose'), dose);
  $(`input[name="mf-mode"][value="${mode}"]`).click();
  for (const t of times) {
    $('.med-times__add').click();
    const inputs = $$('.med-time__input');
    type(inputs[inputs.length - 1], t);
  }
}

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const today = dateKey();
  try {
    localStorage.setItem('health_meds', '[]');
    localStorage.setItem('med_intakes', '{}');
    localStorage.setItem('med_log', '{}');
    await go('#/home');
    await go('#/meds');

    /* 1. пустое состояние */
    const add = await waitFor(() => $('.med-empty__add'), 'кнопка пустого состояния');
    check('1. пустой список → видна кнопка «Добавить лекарство»', add.textContent.trim() === 'Добавить лекарство' && add.getBoundingClientRect().height >= 44,
      `${add.textContent.trim()} / ${add.getBoundingClientRect().height}px`);
    check('1a. заголовок и подзаголовок пустого состояния', $('.med-empty__title').textContent === 'Лекарств пока нет'
      && $('.med-empty__text').textContent === 'Добавьте препарат и укажите расписание приёма.');
    check('1b. подпись под карточкой; старый текст «принял сегодня» убран', $('.med-hint').textContent === 'Здесь можно отмечать приём лекарств и видеть историю по дням.'
      && !document.body.textContent.includes('Отметьте «принял сегодня»'));

    /* 2. без названия не сохраняется */
    add.click();
    await waitFor(() => location.hash === '#/med/new', 'форма');
    await fillForm({ name: '   ', times: [] });
    $('.med-form__form button[type="submit"]').click();
    await sleep(200);
    check('2. без названия сохранить нельзя', location.hash === '#/med/new' && !$('#mf-name-err').hidden
      && $('#mf-name').getAttribute('aria-invalid') === 'true' && JSON.parse(localStorage.getItem('health_meds')).length === 0,
    $('#mf-name-err').textContent);

    /* 3–4. создание и отображение */
    await fillForm({ name: 'Синтетик D', dose: '2000 МЕ', times: ['09:00'] });
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/meds' && card('Синтетик D'), 'карточка после сохранения');
    const d = card('Синтетик D');
    check('3. лекарство сохранено', JSON.parse(localStorage.getItem('health_meds')).some((m) => m.name === 'Синтетик D' && m.schedule.times[0] === '09:00'));
    check('4. карточка: название, дозировка, приём 09:00, пустое состояние исчезло',
      $('.med-card__meta', d).textContent.startsWith('2000 МЕ · Каждый день') && !!slotBtn(d, '09:00') && !$('.med-empty'));

    /* отметка и сохранение после «перезапуска» экрана */
    slotBtn(d, '09:00').click();
    await waitFor(() => slotBtn(card('Синтетик D'), '09:00').getAttribute('aria-pressed') === 'true', 'отметка 09:00');
    check('6a. отметка приёма сохраняется в med_intakes за локальный день', (JSON.parse(localStorage.getItem('med_intakes'))[today] || []).length === 1);

    /* 5–6. два приёма: отмечен только 08:00 */
    $('.med-add').click();
    await fillForm({ name: 'Синтетик два приёма', times: ['08:00', '20:00'] });
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/meds' && card('Синтетик два приёма'), 'вторая карточка');
    const two = card('Синтетик два приёма');
    check('5. несколько времён — две отдельные отметки', $$('.med-slot__btn', two).map((b) => b.dataset.slot).join() === '08:00,20:00');
    slotBtn(two, '08:00').click();
    await waitFor(() => slotBtn(card('Синтетик два приёма'), '08:00').getAttribute('aria-pressed') === 'true', 'отметка 08:00');
    check('6. отмечен только 08:00, 20:00 не принят', slotBtn(card('Синтетик два приёма'), '20:00').getAttribute('aria-pressed') === 'false');
    check('6b. сводка дня по приёмам', $('.med-sum').textContent === 'Сегодня принято 2 из 3', $('.med-sum').textContent);

    await go('#/home');
    await go('#/meds');
    await waitFor(() => card('Синтетик два приёма'), 'экран после возврата');
    check('E. отметки на месте после повторного открытия', slotBtn(card('Синтетик D'), '09:00').getAttribute('aria-pressed') === 'true'
      && slotBtn(card('Синтетик два приёма'), '08:00').getAttribute('aria-pressed') === 'true'
      && slotBtn(card('Синтетик два приёма'), '20:00').getAttribute('aria-pressed') === 'false');

    /* 7. снятие отметки */
    slotBtn(card('Синтетик D'), '09:00').click();
    await waitFor(() => slotBtn(card('Синтетик D'), '09:00').getAttribute('aria-pressed') === 'false', 'снятие 09:00');
    const recs = JSON.parse(localStorage.getItem('med_intakes'))[today] || [];
    check('7. снятие отметки удаляет только этот приём', recs.length === 1 && recs[0].scheduledTime === '08:00');

    /* 9 + 11. правка через ⋯: время 08:00 → 09:30, история дня не теряется */
    $('.med-card__more', card('Синтетик два приёма')).click();
    await clickDialog('Редактировать');
    await waitFor(() => /#\/med\/.+\/edit$/.test(location.hash) && $('#mf-name'), 'форма правки');
    check('9a. форма правки заполнена', $('#mf-name').value === 'Синтетик два приёма' && $$('.med-time__input').map((i) => i.value).join() === '08:00,20:00');
    type($$('.med-time__input')[0], '09:30');
    type($('#mf-note'), 'после еды');
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/meds' && card('Синтетик два приёма'), 'карточка после правки');
    const edited = card('Синтетик два приёма');
    check('9. правка сохранена (время, комментарий)', !!slotBtn(edited, '09:30') && $('.med-card__note', edited).textContent === 'после еды');
    check('11. принятый 08:00 остался в истории дня (строка «вне расписания»)', slotBtn(edited, '08:00')?.getAttribute('aria-pressed') === 'true'
      && $('.med-slot__state small', slotBtn(edited, '08:00').parentElement) != null);

    /* 10. удаление с подтверждением; «Отмена» ничего не меняет */
    $('.med-card__more', card('Синтетик D')).click();
    await clickDialog('Удалить');
    check('10a. подтверждение «Удалить Синтетик D?»', $('.dialog__title')?.textContent === 'Удалить Синтетик D?');
    await clickDialog('Отмена');
    check('10b. «Отмена» — лекарство на месте', !!card('Синтетик D'));
    $('.med-card__more', card('Синтетик D')).click();
    await clickDialog('Удалить');
    await clickDialog('Удалить');
    await waitFor(() => !card('Синтетик D'), 'карточка удалена');
    check('10. удалено из списка, запись и история остаются', JSON.parse(localStorage.getItem('health_meds')).some((m) => m.name === 'Синтетик D' && m.deletedAt));

    /* вёрстка */
    check('H. нет горизонтальной прокрутки', document.documentElement.scrollWidth <= window.innerWidth, `${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    const small = $$('.meds button, .meds summary').filter((b) => b.offsetParent && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44));
    check('A11y. касание ≥ 44×44 у всех кнопок экрана', !small.length, small.map((b) => b.className).join());
    check('A11y. у кнопок-иконок есть aria-label', $$('.med-card__more').every((b) => b.getAttribute('aria-label')));
  } finally {
    if (!keep) {
      KEYS.forEach((k) => (saved[k] == null ? localStorage.removeItem(k) : localStorage.setItem(k, saved[k])));
      await go('#/home');
      await go('#/meds');
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results);
  return { passed: results.length - failed.length, failed: failed.length, results };
}

