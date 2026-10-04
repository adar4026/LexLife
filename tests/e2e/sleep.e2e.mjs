/* =========================================================
   tests/e2e/sleep.e2e.mjs — сквозная проверка раздела «Сон» в настоящем браузере:
   шторка → пустое состояние → запись 23:40 → 07:20 (7 ч 40 мин) → история, Главная,
   Календарь → аналитика → правка → удаление с подтверждением → ошибки ввода →
   резервная копия → очистка данных → восстановление.

   Только на localhost (отдельный origin с синтетическими данными): шаг «очистка данных»
   стирает все разделы этого origin, восстановление возвращает их из копии.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/sleep.e2e.mjs'); await m.run();
   run({ keep: true }) — оставить синтетические записи сна (для скриншотов).
   ========================================================= */

import Storage, { dateKey, parseBackup } from '../../js/services/storage.js';

const KEYS = ['sleep_log', 'sleep_settings'];
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
const txt = (n) => (n ? n.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '');
async function go(hash) {
  if (location.hash === hash) { location.hash = '#/__'; await sleep(60); }
  location.hash = hash;
  await waitFor(() => location.hash === hash, `адрес ${hash}`);
  await sleep(300);
}
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
const addDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); return dateKey(new Date(y, m - 1, d + n)); };
const log = () => JSON.parse(localStorage.getItem('sleep_log') || '[]');

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const today = dateKey();
  const yesterday = addDay(today, -1);
  try {
    localStorage.setItem('sleep_log', '[]');
    localStorage.removeItem('sleep_settings');
    await Storage.init();

    /* 1–4. шторка: «😴 Сон» между «Активность» и «Вода», открывает раздел */
    await go('#/home');
    $('#avatar-btn').click();
    await sleep(200);
    const items = $$('#drawer .drawer-item').map((b) => txt(b));
    const iA = items.indexOf('🏃 Активность'), iS = items.indexOf('😴 Сон'), iW = items.indexOf('💧 Вода');
    check('2–3. в шторке «😴 Сон» сразу после «Активность», перед «Вода»', iS === iA + 1 && iW === iS + 1, items.join(' | '));
    const sleepItem = $$('#drawer .drawer-item').find((b) => txt(b) === '😴 Сон');
    const water = $$('#drawer .drawer-item').find((b) => txt(b) === '💧 Вода');
    check('3a. пункт того же размера, что соседние', sleepItem && Math.abs(sleepItem.getBoundingClientRect().height - water.getBoundingClientRect().height) < 0.5
      && getComputedStyle(sleepItem).fontSize === getComputedStyle(water).fontSize);
    sleepItem.click();
    await waitFor(() => location.hash === '#/sleep' && $('.sleep-empty'), 'раздел «Сон»');
    check('4. открыт раздел, заголовок «Сон», пустое состояние первого запуска', txt($('.header__title')) === 'Сон'
      && txt($('.sleep-empty .med-empty__title')) === 'Здесь появится история вашего сна' && !$('#drawer').classList.contains('open'));

    /* 5–6. запись: лёг 23:40, проснулся 07:20, качество 4, пробуждения 1 */
    $('.sleep-empty .sleep-cta').click();
    await waitFor(() => location.hash === '#/sleep/new' && $('#sf-bed-time'), 'форма');
    check('5a. по умолчанию: проснулся сегодня', $('#sf-wake-date').value === today);
    type($('#sf-bed-time'), '23:40');
    type($('#sf-wake-time'), '07:20');
    $('.sleep-q[data-q="4"]').click();
    $('[data-aw="1"]').click();
    check('5b. дата засыпания подставилась: накануне', $('#sf-bed-date').value === yesterday, $('#sf-bed-date').value);
    check('6. рассчитано «7 ч 40 мин»', txt($('.sleep-dur__val')) === '7 ч 40 мин', txt($('.sleep-dur__val')));
    check('6a. качество 4 выбрано, пробуждения 1', $('.sleep-q[data-q="4"]').getAttribute('aria-checked') === 'true' && txt($('#sf-aw')) === '1');
    $('.sleep-tag[data-tag="stress"]').click();
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/sleep' && $('.sleep-last__dur'), 'экран после сохранения');
    const e1 = log()[0];
    check('5. сохранено: дата пробуждения, время, длительность, качество, пробуждения, фактор',
      log().length === 1 && e1.date === today && e1.sleepStart === `${yesterday}T23:40` && e1.sleepEnd === `${today}T07:20`
      && e1.durationMinutes === 460 && e1.quality === 4 && e1.awakenings === 1 && e1.tags.join() === 'stress', JSON.stringify(e1));
    check('5c. «Последний сон»: Сегодня · 7 ч 40 мин · 23:40 → 07:20 · Хороший сон', txt($('.sleep-last__dur')) === '7 ч 40 мин'
      && txt($('.sleep-last__times')) === '23:40 → 07:20' && txt($('.sleep-last__q')).includes('Хороший сон') && txt($('.sleep-last__meta')) === '1 пробуждение');

    /* 7. история */
    const row = $(`.sleep-row[href="#/sleep/${e1.id}"]`);
    check('7. запись в истории (месяц, новые сверху)', row && txt($('.sleep-row__dur', row)) === '7 ч 40 мин' && txt($('.sleep-row__times', row)) === '23:40 → 07:20'
      && txt($('.sleep-row__q', row)).includes('Хорошо'));

    /* 8. Главная */
    await go('#/home');
    const homeRow = await waitFor(() => $$('.hsec').find((s) => txt($('.hsec__title', s)) === 'Сон'), 'карточка сна на Главной');
    check('8. на Главной: «Сон» · 7 ч 40 мин · 23:40 → 07:20', txt($('.hrow__title', homeRow)) === '7 ч 40 мин' && txt($('.hrow__sub', homeRow)) === '23:40 → 07:20'
      && $('.hrow', homeRow).getAttribute('href') === '#/sleep');

    /* 9. Календарь: событие в день пробуждения → переход к записи */
    await go('#/calendar');
    const ev = await waitFor(() => $$('#daybox .row').find((r) => txt(r).startsWith('😴 Сон · 7 ч 40 мин')), 'событие сна в календаре');
    check('9. в Календаре «😴 Сон · 7 ч 40 мин» за сегодня', !!ev);
    ev.click();
    await waitFor(() => location.hash === `#/sleep/${e1.id}` && $('#sf-bed-time'), 'запись из календаря');
    check('9a. событие открывает эту запись', $('#sf-bed-time').value === '23:40' && $('#sf-wake-time').value === '07:20');

    /* 10. аналитика: вторая ночь (вчера 23:00 → 07:00) */
    await go(`#/sleep/new/${yesterday}`);
    await waitFor(() => $('#sf-wake-date'), 'форма за вчера');
    check('10a. форма на конкретную дату', $('#sf-wake-date').value === yesterday);
    type($('#sf-bed-time'), '23:00');
    type($('#sf-wake-time'), '07:00');
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/sleep' && log().length === 2, 'вторая запись');
    await waitFor(() => $('.sleep-analytics .sleep-kpi__val'), 'аналитика');
    const avg1 = txt($('.sleep-analytics .sleep-kpi__val'));
    check('10. аналитика: средний сон (460 + 480) / 2 = 7 ч 50 мин', avg1 === '7 ч 50 мин', avg1);
    check('10b. график продолжительности и цель 8 ч', !!$('.sleep-analytics .chart__plot svg') && txt($('.sleep-analytics .chart__legend')).includes('цель 8 ч'));

    /* 11–12. правка: проснулся в 07:50 → 8 ч 10 мин, цель выполнена, среднее пересчитано */
    await go(`#/sleep/${e1.id}`);
    await waitFor(() => $('#sf-wake-time'), 'форма правки');
    type($('#sf-wake-time'), '07:50');
    check('11. форма показывает новую длительность', txt($('.sleep-dur__val')) === '8 ч 10 мин');
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/sleep' && $('.sleep-last__dur') && txt($('.sleep-last__dur')) === '8 ч 10 мин', 'после правки');
    check('11a. запись изменена, не продублирована', log().length === 2 && log().find((e) => e.id === e1.id).durationMinutes === 490);
    check('12. пересчёт: средний сон 8 ч 5 мин, «Цель выполнена»', txt($('.sleep-analytics .sleep-kpi__val')) === '8 ч 5 мин'
      && txt($('.sleep-last__goal')).startsWith('Цель выполнена'), txt($('.sleep-analytics .sleep-kpi__val')));

    /* ошибки ввода: проснулся раньше, чем лёг; дубль даты */
    await go('#/sleep/new');
    await waitFor(() => $('#sf-bed-date'), 'форма');
    type($('#sf-bed-date'), today);
    type($('#sf-bed-time'), '08:00');
    type($('#sf-wake-time'), '07:00');
    $('.med-form__form button[type="submit"]').click();
    await sleep(200);
    check('V1. конец раньше начала — понятная ошибка, не сохранено', location.hash === '#/sleep/new' && !$('#sf-time-err').hidden
      && txt($('#sf-time-err')) === 'Время пробуждения должно быть позже времени засыпания' && log().length === 2, txt($('#sf-time-err')));
    type($('#sf-bed-date'), yesterday);
    type($('#sf-bed-time'), '23:30');
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => $('.dialog__title'), 'диалог дубля');
    check('V2. дата уже записана — предложение открыть запись', txt($('.dialog__title')).startsWith('За ') && txt($('.dialog__title')).endsWith('сон уже записан') && log().length === 2);
    await clickDialog('Отмена');

    /* 13–14. удаление с подтверждением */
    await go(`#/sleep/${e1.id}`);
    await waitFor(() => $('.sleep-delete'), 'кнопка удаления');
    $('.sleep-delete').click();
    await waitFor(() => $('.dialog__title'), 'подтверждение');
    check('13a. подтверждение «Удалить запись сна за …?» с кнопками Отмена / Удалить', /^Удалить запись сна за .+\?$/.test(txt($('.dialog__title')))
      && $$('.dialog__btn').map((b) => b.textContent).join() === 'Отмена,Удалить');
    await clickDialog('Отмена');
    check('13b. «Отмена» — запись на месте', log().length === 2);
    $('.sleep-delete').click();
    await clickDialog('Удалить');
    await waitFor(() => location.hash === '#/sleep' && $('.sleep-last--none'), 'после удаления');
    check('13. удалено', log().length === 1 && !log().some((e) => e.id === e1.id));
    check('14. пересчёт: «Сегодня сон ещё не записан», аналитика ждёт данных', txt($('.sleep-last__title')) === 'Сегодня сон ещё не записан'
      && !!$('.sleep-wait'));
    await go('#/home');
    const homeNone = $$('.hsec').find((s) => txt($('.hsec__title', s)) === 'Сон');
    check('14a. Главная: «Сегодня нет записи» · «Добавить»', txt($('.hrow__title', homeNone)) === 'Сегодня нет записи' && txt($('.hrow__status', homeNone)) === 'Добавить');

    /* 15–18. резервная копия → очистка данных → восстановление */
    await Storage.updateSleepSettings({ goalMinutes: 450 });
    const before = localStorage.getItem('sleep_log');
    const { json, verified } = await Storage.createBackup();
    const raw = JSON.parse(json);
    check('15. копия создана и проверена, сон и настройки в ней', verified && raw.data.sleep_log.length === 1 && raw.data.sleep_settings.goalMinutes === 450);
    await Storage.clearAll();
    await Storage.init();
    check('16. данные удалены', log().length === 0 && (await Storage.getSleepSettings()).goalMinutes === 480);
    const prepared = await Storage.prepareRestore(parseBackup(json));
    check('17a. предпросмотр восстановления: «Сон: 1»', prepared.summary.sleep === 1);
    await Storage.restoreBackup(prepared);
    check('17–18. сон полностью восстановлен (записи и настройки)', localStorage.getItem('sleep_log') === before && (await Storage.getSleepSettings()).goalMinutes === 450);
    await go('#/sleep');
    await waitFor(() => $('.sleep-row'), 'история после восстановления');
    check('18a. раздел снова показывает запись', $$('.sleep-row').length === 1);

    /* вёрстка и доступность */
    check('H. нет горизонтальной прокрутки', document.documentElement.scrollWidth <= window.innerWidth, `${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    await go('#/sleep/new');
    await waitFor(() => $('.sleep-q'), 'форма');
    check('H2. форма без горизонтальной прокрутки', document.documentElement.scrollWidth <= window.innerWidth, `${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    /* «‹ Назад» — общий компонент шапки всех экранов (не часть раздела); переключатель 48×28 —
       зона касания вся строка «Дневной сон» */
    const hit = (b) => (b.classList.contains('rs-toggle') ? b.closest('.sleep-nap-row') : b).getBoundingClientRect();
    const small = $$('.sleep-form button:not(.back-btn)').filter((b) => b.offsetParent && (hit(b).height < 44 || hit(b).width < 44));
    check('A11y. касание ≥ 44×44 у кнопок формы', !small.length, small.map((b) => b.className).join());
    $('.sleep-nap-row').click();
    check('A11y. касание строки «Дневной сон» включает переключатель', $('#sf-nap').getAttribute('aria-checked') === 'true' && !$('[data-part="nap"]').hidden);
    check('A11y. качество — radiogroup, у вариантов есть подписи', $('.sleep-quality').getAttribute('role') === 'radiogroup' && $$('.sleep-q').every((b) => b.getAttribute('aria-label')));
  } finally {
    if (!keep) {
      KEYS.forEach((k) => (saved[k] == null ? localStorage.removeItem(k) : localStorage.setItem(k, saved[k])));
      await Storage.init();
      await go('#/home');
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results);
  return { passed: results.length - failed.length, failed: failed.length, results };
}
