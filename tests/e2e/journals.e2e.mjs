/* =========================================================
   tests/e2e/journals.e2e.mjs — «Все журналы» в реальном DOM:
     • Главная: «Сегодняшние журналы» (записи за сегодня, % цели воды = % в hero) и «Просмотреть все»;
     • сценарий ТЗ: сегодня 1 500 мл · вчера 300 + 300 (10:31) · 3 дня назад 200 + 300 + 500 →
       «Сегодня • 1 500 мл», «Вчера • 600 мл», «ДД месяца ГГГГ • 1 000 мл», три отдельные карточки,
       % цели накопительно после записи;
     • фильтры: только существующие типы; «Вода» — в адресе; переключение;
     • запись открывает существующий редактор: изменить → итог дня пересчитан; удалить через
       редактор → карточка исчезает; последняя запись дня → дня нет;
     • запись задним числом попадает в свой день; смешанный день — «N записей»;
     • «Назад» с другого экрана — тот же фильтр и та же прокрутка; сон → форма → обратно в журнал;
     • «Журнал ›» раздела открывает этот же экран с фильтром;
     • данные воды других дней не изменились; нет горизонтальной прокрутки.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском сохраняет
   затрагиваемые ключи этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/journals.e2e.mjs'); await m.run();
   ========================================================= */

import Storage, { dateKey } from '../../js/services/storage.js';
import { journalDayLabel } from '../../js/services/journals.js';

const KEYS = ['metrics_log', 'health_metrics', 'sleep_log', 'sleep_settings', 'steps_log', 'bike_log', 'activity_days', 'activity_migration'];
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
const txt = (n) => (n ? n.textContent.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim() : '');
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
  await sleep(300);
}
const addDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); return dateKey(new Date(y, m - 1, d + n)); };
const read = (k, d) => JSON.parse(localStorage.getItem(k) || JSON.stringify(d));
const group = (date) => $(`#jg-${date}`);
const heads = () => $$('.jgroup__head').map(txt);
const cards = (date) => $$('.jcard', group(date) || document.createElement('div'));

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const today = dateKey();
  const y1 = addDay(today, -1);
  const d3 = addDay(today, -3);
  try {
    /* ---------- 0. синтетические данные сценария ---------- */
    const water = {
      [today]: { total: 1500, entries: [{ t: '18:22', ml: 1500 }] },
      [y1]: { total: 600, entries: [{ t: '10:31', ml: 300 }, { t: '10:31', ml: 300 }] },
      [d3]: { total: 1000, entries: [{ t: '23:33', ml: 200 }, { t: '23:37', ml: 300 }, { t: '23:40', ml: 500 }] },
    };
    localStorage.setItem('metrics_log', JSON.stringify({ water }));
    ['sleep_log', 'steps_log', 'bike_log', 'activity_days'].forEach((k) => localStorage.removeItem(k));
    await Storage.init();
    await Storage.setWaterGoal(2600);
    const yBefore = JSON.stringify(read('metrics_log', {}).water[y1]);

    /* ---------- 1. Главная: «Сегодняшние журналы» ---------- */
    await go('#/home');
    const hj = await waitFor(() => $('.hjournals'), '«Сегодняшние журналы»');
    check('1a. Главная: блок «Сегодняшние журналы»', txt($('.hsec__title', hj)) === 'Сегодняшние журналы');
    check('1b. запись за сегодня: «Вода — 1 500 мл», 18:22', $$('.jcard', hj).length === 1 && txt($('.jcard__title', hj)) === 'Вода — 1 500 мл' && /^18:22/.test(txt($('.jcard__sub', hj))), txt(hj));
    const heroPct = (txt($('.hh__pct')).match(/(\d+)%/) || [])[1];
    check('1c. % цели карточки = % воды в hero (58%)', txt($('.jcard__goal b', hj)) === '58%' && heroPct === '58', `${txt($('.jcard__goal b', hj))} / hero ${heroPct}`);
    $('.jall-btn', hj).click();
    await waitFor(() => location.hash === '#/journals' && $('.jgroup'), 'экран «Все журналы»');
    check('1d. «Просмотреть все» → «Все журналы», фильтр «Все»', txt($('.header__title')) === 'Все журналы' && txt($('.jchip[aria-pressed="true"]')) === 'Все');

    /* ---------- 2. группировка, итоги, отдельные записи ---------- */
    const L3 = journalDayLabel(d3, today);
    check('2a. дни и итоги: Сегодня • 1 500 мл / Вчера • 600 мл / ДД месяца ГГГГ • 1 000 мл',
      heads().join(' / ') === `Сегодня • 1 500 мл / Вчера • 600 мл / ${L3} • 1 000 мл`, heads().join(' / '));
    check('2b. три записи дня не склеиваются, новые сверху', cards(d3).map((c) => txt($('.jcard__title', c))).join('|') === 'Вода — 500 мл|Вода — 300 мл|Вода — 200 мл'
      && cards(d3).map((c) => txt($('.jcard__sub', c)).slice(0, 5)).join('|') === '23:40|23:37|23:33');
    check('2c. % цели — накопительно после записи: 38 / 19 / 8', cards(d3).map((c) => txt($('.jcard__goal b', c))).join(' ') === '38% 19% 8%');
    check('2d. вчера — две записи по 300 мл', cards(y1).length === 2);
    check('2e. фильтры — только существующие типы', $$('.jchip').map(txt).join('|') === 'Все|Вода|Сон|Шаги|Велосипед', $$('.jchip').map(txt).join('|'));

    /* ---------- 3. фильтр «Вода», правка и удаление через существующий редактор ---------- */
    $('.jchip[data-filter="water"]').click();
    await sleep(200);
    check('3a. фильтр «Вода» в адресе и нажат', location.hash === '#/journals/water' && txt($('.jchip[aria-pressed="true"]')) === 'Вода');
    check('3b. «Добавить запись» и «По месяцам» для типа', !!$('.jtools__add') && $('.jtools__month')?.getAttribute('href') === '#/water-log');
    cards(d3)[1].click();
    await waitFor(() => $('.dialog #wl-ml'), 'редактор записи воды');
    check('3c. открывается существующий редактор воды с этой записью', $('#wl-t').value === '23:37' && $('#wl-ml').value === '300' && $('#wl-d').value === d3
      && $$('.dialog__btn').map((b) => b.textContent).join('|') === 'Отмена|Удалить|Сохранить');
    type($('#wl-ml'), '450');
    await clickDialog('Сохранить');
    await waitFor(() => /1 150 мл/.test(txt($('.jgroup__head', group(d3)))), 'итог дня после правки');
    check('3d. правка: итог дня 1 150 мл, записей по-прежнему три', cards(d3).length === 3 && txt($('.jcard__title', cards(d3)[1])) === 'Вода — 450 мл');
    check('3e. после правки — тот же фильтр', location.hash === '#/journals/water' && txt($('.jchip[aria-pressed="true"]')) === 'Вода');
    cards(d3)[0].click();
    await clickDialog('Удалить');
    await clickDialog('Удалить');
    await waitFor(() => cards(d3).length === 2, 'удаление записи');
    check('3f. удаление: карточка исчезла, итог 650 мл', txt($('.jgroup__head', group(d3))) === `${L3} • 650 мл`);
    for (let i = 0; i < 2; i++) {
      cards(d3)[0].click();
      await clickDialog('Удалить');
      await clickDialog('Удалить');
      await sleep(200);
    }
    await waitFor(() => !group(d3), 'пустой день исчезает');
    check('3g. последняя запись дня удалена — дня в журнале нет', !group(d3) && heads().length === 2, heads().join(' / '));
    check('3h. вода других дней не изменилась', JSON.stringify(read('metrics_log', {}).water[y1]) === yBefore);

    /* ---------- 4. запись задним числом ---------- */
    const past = addDay(today, -12);
    $('.jtools__add').click();
    await waitFor(() => $('.dialog #wl-d'), 'форма новой записи');
    type($('#wl-d'), past); type($('#wl-t'), '07:15'); type($('#wl-ml'), '350');
    await clickDialog('Добавить');
    await waitFor(() => group(past), 'день прошлой записи');
    check('4a. запись задним числом — в своём дне, не в сегодня', txt($('.jgroup__head', group(past))) === `${journalDayLabel(past, today)} • 350 мл` && txt($('.jgroup__head', group(today))) === 'Сегодня • 1 500 мл');

    /* ---------- 5. «Назад» — тот же фильтр и та же прокрутка ---------- */
    const log = read('metrics_log', {});
    for (let i = 13; i < 70; i++) log.water[addDay(today, -i)] = { total: 900, entries: [{ t: '09:00', ml: 400 }, { t: '15:00', ml: 500 }] };
    localStorage.setItem('metrics_log', JSON.stringify(log));
    await go('#/journals/water');
    await waitFor(() => $$('.jgroup').length > 10, 'длинный журнал');
    window.scrollTo(0, 2400);
    await sleep(400);
    const yScroll = window.scrollY;
    $('.jtools__month').click();
    await waitFor(() => location.hash.startsWith('#/water-log') && $('#wl-add'), 'журнал по месяцам');
    $('.back-btn').click();
    await waitFor(() => location.hash === '#/journals/water' && $('.jgroup'), 'возврат в «Все журналы»');
    await sleep(300);
    check('5a. «Назад»: фильтр «Вода» сохранён', txt($('.jchip[aria-pressed="true"]')) === 'Вода');
    check('5b. «Назад»: прокрутка восстановлена', Math.abs(window.scrollY - yScroll) < 4, `${window.scrollY} vs ${yScroll}`);

    /* ---------- 6. сон: карточка → форма записи сна → обратно в журнал ---------- */
    localStorage.setItem('sleep_log', JSON.stringify([{ id: 'e2e-j-sl', date: today, sleepStart: `${y1}T23:25`, sleepEnd: `${today}T07:05`, durationMinutes: 460, quality: 4, awakenings: 0, naps: [], tags: [], note: '', createdAt: null, updatedAt: null }]));
    await go('#/journals/sleep');
    await waitFor(() => $('.jcard[data-type="sleep"]'), 'запись сна');
    check('6a. сон: «Сон — 7 ч 40 мин», 23:25 → 07:05; итог дня', txt($('.jcard__title')) === 'Сон — 7 ч 40 мин' && txt($('.jcard__sub')) === '23:25 → 07:05' && heads()[0] === 'Сегодня • 7 ч 40 мин', heads()[0]);
    $('.jcard[data-type="sleep"]').click();
    await waitFor(() => location.hash === '#/sleep/e2e-j-sl' && $('#sf-wake-time'), 'форма сна');
    type($('#sf-wake-time'), '07:35');
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash === '#/journals/sleep' && $('.jcard[data-type="sleep"]'), 'возврат в журнал сна');
    check('6b. после сохранения — «Все журналы» с фильтром «Сон», значение обновлено', txt($('.jchip[aria-pressed="true"]')) === 'Сон' && txt($('.jcard__title')) === 'Сон — 8 ч 10 мин', txt($('.jcard__title')));

    /* ---------- 7. смешанный день, пустой фильтр, ссылки разделов ---------- */
    await go('#/journals');
    await waitFor(() => group(today), 'сегодня');
    check('7a. разные типы в одном дне — «N записей»', txt($('.jgroup__head', group(today))) === 'Сегодня • 2 записи', txt($('.jgroup__head', group(today))));
    $('.jchip[data-filter="bike"]').click();
    await sleep(200);
    check('7b. пустой фильтр: «Нет поездок» и кнопка добавления', txt($('.jempty-all')) === 'Нет поездок' && !!$('.jtools__add'));
    await go('#/metric/water');
    (await waitFor(() => $('[data-route="journals/water"]'), '«Журнал ›» воды')).click();
    await waitFor(() => location.hash === '#/journals/water' && $('.jchip[aria-pressed="true"]'), 'журнал из раздела «Вода»');
    check('7c. Вода → «Журнал ›» → тот же экран с фильтром «Вода»', txt($('.header__title')) === 'Все журналы' && txt($('.jchip[aria-pressed="true"]')) === 'Вода');
    await go('#/sleep');
    (await waitFor(() => $('.sleep-journal'), '«Журнал ›» сна')).click();
    await waitFor(() => location.hash === '#/journals/sleep' && $('.jchip[aria-pressed="true"]'), 'журнал из раздела «Сон»');
    check('7d. Сон → «Журнал ›» → фильтр «Сон»', txt($('.jchip[aria-pressed="true"]')) === 'Сон');

    /* ---------- 8. вёрстка ---------- */
    for (const r of ['#/journals', '#/journals/water', '#/home']) {
      await go(r);
      check(`8. ${r}: нет горизонтальной прокрутки`, document.documentElement.scrollWidth <= window.innerWidth, `${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    }
    const small = $$('.jcard, .jchip, .jall-btn').filter((n) => { const b = n.getBoundingClientRect(); return b.width && b.height < 40; });
    check('8b. зоны касания карточек, фильтров и кнопки ≥ 40px', small.length === 0, small.map((n) => n.className).join(', '));
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
