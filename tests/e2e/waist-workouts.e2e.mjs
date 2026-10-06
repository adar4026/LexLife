/* =========================================================
   tests/e2e/waist-workouts.e2e.mjs — «Обхват талии» и «Тренировки» в реальном DOM:
     • «Показатели»: карточка «📏 Обхват талии» сразу после «Веса», того же вида, нового
       раздела «Показатели» нет; нижняя навигация не изменилась;
     • экран талии: «Назад» · заголовок · «+»; пустое состояние без «0 см»; первое измерение;
       НЕД · МЕС · 6 МЕС · ГОД (без «ДН»), крупное последнее значение и дата; график из одной
       точки и линия из двух; выбор точки — значение и дата; «Изменение» последнее − первое;
       та же дата → «Изменить?» без дубля; запись задним числом;
     • журнал измерений: новые сверху, изменить значение и дату, удалить, добавить за любую дату;
       «Назад» возвращает экран талии с тем же периодом;
     • шторка: «🏋️ Тренировки» после «🚴 Велосипеда»; экран — журнал; перенесённые Планка и
       «Другое» из старой «Активности» на месте; добавить Планку (3 × 60 = 180 сек), «Другое»
       с произвольным названием задним числом, изменить, удалить; шагов и велосипеда там нет;
       пустое состояние;
     • резервная копия содержит новые разделы; нет горизонтальной прокрутки.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском сохраняет
   затрагиваемые ключи этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/waist-workouts.e2e.mjs'); await m.run();
   ========================================================= */

import Storage, { dateKey, parseBackup } from '../../js/services/storage.js';

const KEYS = ['waist_log', 'workouts_log', 'workouts_migration', 'activity_days', 'steps_log', 'bike_log', 'activity_migration', 'metrics_log'];
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
  await sleep(250);
}
async function fill(fields, submit) {
  await waitFor(() => $('.dialog input'), 'диалог');
  for (const [id, v] of Object.entries(fields)) type($(`#${id}`), v);
  if (submit) await clickDialog(submit);
}
const addDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); return dateKey(new Date(y, m - 1, d + n)); };
const read = (k, d) => JSON.parse(localStorage.getItem(k) || JSON.stringify(d));
const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/[  ]/g, ' ');
const noHScroll = () => document.documentElement.scrollWidth <= window.innerWidth;

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const today = dateKey();
  const d3 = addDay(today, -3);
  const d20 = addDay(today, -20);
  const d400 = addDay(today, -400); // другой год
  try {
    /* ---------- 0. «старая установка»: старая «Активность» с планкой и «другим», новых разделов нет ---------- */
    const legacy = {
      [d3]: { steps: 6100, bike: 30, bikeIntensity: 'Средняя', plank: [60, 60, 60], otherType: 'Плавание', otherMin: 30, savedAt: `${d3}T20:00:00.000Z` },
    };
    localStorage.setItem('activity_days', JSON.stringify(legacy));
    ['waist_log', 'workouts_log', 'workouts_migration', 'steps_log', 'bike_log', 'activity_migration'].forEach((k) => localStorage.removeItem(k));
    const actBefore = localStorage.getItem('activity_days');
    const weightBefore = JSON.stringify(read('metrics_log', {}).weight || {});
    await Storage.init();
    await Storage.init(); // повторный запуск
    const wl = read('workouts_log', []);
    check('M1. перенос при запуске: Планка и «Другое» → workouts_log, без дублей после повторного запуска',
      wl.length === 2 && wl.some((w) => w.id === `legacy-plank-${d3}` && w.sets === 3 && w.seconds === 60) && wl.some((w) => w.id === `legacy-other-${d3}` && w.name === 'Плавание' && w.minutes === 30), JSON.stringify(wl));
    check('M2. activity_days не изменился; шаги и велотренажёр — по-прежнему в своих разделах',
      localStorage.getItem('activity_days') === actBefore && read('steps_log', {})[d3]?.steps === 6100 && read('bike_log', []).length === 1);
    check('M3. waist_log появился пустым', JSON.stringify(read('waist_log', null)) === '{}');

    /* ---------- 1. «Показатели» ---------- */
    await go('#/metrics');
    await waitFor(() => $$('.mcard').length >= 8, 'сетка показателей');
    const names = $$('.mcard .mcard__name').map(txt);
    check('1a. «Показатели»: Вес → Обхват талии → Давление → Пульс → Вода → Температура → Сатурация → Глюкоза',
      names.join('|') === 'Вес|Обхват талии|Давление|Пульс|Вода|Температура|Сатурация|Глюкоза', names.join('|'));
    const wcard = $('.mcard[data-route="metric/waist"]'), kcard = $('.mcard[data-route="metric/weight"]');
    check('1b. карточка талии — тот же компонент, что «Вес» (радиус, отступы, высота)',
      wcard && getComputedStyle(wcard).borderRadius === getComputedStyle(kcard).borderRadius && getComputedStyle(wcard).padding === getComputedStyle(kcard).padding
      && Math.abs(wcard.offsetHeight - kcard.offsetHeight) <= 1 && txt(wcard.querySelector('.mcard__emoji')) === '📏', txt(wcard));
    check('1c. без измерений карточка не показывает «0 см»', !/\b0 см/.test(txt(wcard)) && /—/.test(txt(wcard)), txt(wcard));
    check('1d. нижняя навигация — прежние 4 вкладки, «Тренировок» там нет', !/Тренировк/.test(txt($('#tab-bar'))) && !/Показатели.*Показатели/.test(txt($('#tab-bar'))), txt($('#tab-bar')));

    /* ---------- 2. экран талии: пустое состояние, первое измерение ---------- */
    wcard.click();
    await waitFor(() => location.hash === '#/metric/waist' && $('.waist'), 'экран талии');
    check('2a. шапка: стандартная «Назад», «Обхват талии», «+»', !!$('.waist .back-btn') && txt($('.waist .header__title')) === 'Обхват талии' && !!$('.waist .hdr-add'));
    check('2b. пустое состояние: «Пока нет измерений» и «Добавить первое измерение», без «0 см»',
      txt($('.waist-empty .med-empty__title')) === 'Пока нет измерений' && txt($('.waist-first')) === 'Добавить первое измерение' && !/\b0 см/.test(txt($('#screen'))) && !$('.chart'));
    $('.waist-first').click();
    await waitFor(() => $('.dialog #ws-v'), 'форма измерения');
    check('2c. форма: дата по умолчанию — сегодня, поле в сантиметрах', $('#ws-d').value === today && /см/.test(txt($('label[for="ws-v"]'))));
    await fill({ 'ws-v': '93' }, 'Сохранить');
    await waitFor(() => $('.waist-stats'), 'статистика талии');
    check('2d. крупно — последнее измерение и дата', txt($('.hhead__num')) === '93' && txt($('.hhead__unit')) === 'см' && txt($('.hhead__range')) === fmtDate(today), txt($('.hhead')));
    check('2e. периоды — НЕД · МЕС · 6 МЕС · ГОД, «ДН» нет', $$('.waist .hseg__btn').map(txt).join('|') === 'НЕД|МЕС|6 МЕС|ГОД');
    check('2f. одна запись: одна точка, без линии; изменение «—»', $$('.waist .chart__dot:not(.chart__dot--sel)').length === 1 && !$('.waist .chart__line') && txt($('.waist-change')) === '—',
      `${$$('.waist .chart__dot').length} ${txt($('.waist-change'))}`);

    /* ---------- 3. запись задним числом, линия, изменение, выбор точки ---------- */
    $('.waist .hdr-add').click();
    await fill({ 'ws-d': d20, 'ws-v': '95,5' }, 'Сохранить');
    await sleep(150);
    $('.waist .hseg__btn[data-k="6m"]').click();
    await waitFor(() => $('.waist .hseg__btn[data-k="6m"][aria-selected="true"]'), '6 МЕС');
    await sleep(100);
    check('3a. две записи: линия между точками, «Последнее» 93 см', !!$('.waist .chart__line') && txt($('.waist-last')) === '93 см', txt($('.waist-grid')));
    check('3b. изменение за период: 93 − 95,5 = −2,5 см', txt($('.waist-change')) === '−2,5 см', txt($('.waist-change')));
    check('3c. выбранная точка по умолчанию — последняя: значение и дата', txt($('.waist .chart__rv')) === '93 см' && txt($('.waist .chart__rd')) === fmtDate(today));
    $('.waist .chart__plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await sleep(50);
    check('3d. выбор другой точки показывает её значение и дату', txt($('.waist .chart__rv')) === '95,5 см' && txt($('.waist .chart__rd')) === fmtDate(d20), txt($('.waist .chart__readout')));
    const ticks = $$('.waist .chart__tick').map(txt);
    check('3e. шкала Y не от нуля — подстроена под значения', !ticks.includes('0') && ticks.some((t) => /^9\d/.test(t)), ticks.join(' '));

    /* ---------- 4. та же дата → «Изменить?», без дубля ---------- */
    $('.waist .hdr-add').click();
    await fill({ 'ws-v': '92' }, 'Сохранить');
    await waitFor(() => $$('.dialog__title').some((x) => txt(x) === 'За эту дату уже есть измерение'), 'вопрос о замене');
    check('4a. на занятую дату — предложение изменить существующее измерение', /93 см/.test(txt($('.dialog__body'))) && /92 см/.test(txt($('.dialog__body'))));
    await clickDialog('Изменить');
    await sleep(150);
    const wlog = read('waist_log', {});
    check('4b. запись за сегодня одна и изменена (92 см)', Object.keys(wlog).filter((d) => d === today).length === 1 && wlog[today].cm === 92 && Object.keys(wlog).length === 2 && txt($('.hhead__num')) === '92');

    /* ---------- 5. журнал измерений ---------- */
    check('5a. «Журнал измерений ›»', txt($('.waist-journal .row__title')) === 'Журнал измерений');
    $('.waist-journal').click();
    await waitFor(() => location.hash === '#/journals/waist' && $$('.jcard').length === 2, 'журнал талии');
    check('5b. новые сверху: 92 см (сегодня), затем 95,5 см', /92 см/.test(txt($$('.jcard')[0])) && /95,5 см/.test(txt($$('.jcard')[1])) && txt($('.jgroup__day')) === 'Сегодня', $$('.jcard').map(txt).join(' / '));
    $$('.jcard')[0].click();
    await waitFor(() => $('.dialog #ws-v'), 'правка измерения');
    check('5c. запись открывается: значение и дата', $('#ws-v').value === '92' && $('#ws-d').value === today && $$('.dialog__btn').some((b) => b.textContent === 'Удалить'));
    await fill({ 'ws-d': addDay(today, -1), 'ws-v': '91,5' }, 'Сохранить');
    await waitFor(() => $$('.jcard').length === 2 && /91,5 см/.test(txt($('.jcard'))), 'изменённое измерение');
    const wlog2 = read('waist_log', {});
    check('5d. изменены значение и дата (перенос, без дубля)', !wlog2[today] && wlog2[addDay(today, -1)]?.cm === 91.5 && Object.keys(wlog2).length === 2);
    $('.jtools__add').click();
    await fill({ 'ws-d': d400, 'ws-v': '101' }, 'Сохранить');
    await sleep(200);
    check('5e. добавление за любую дату (прошлый год)', read('waist_log', {})[d400]?.cm === 101);
    const card95 = $$('.jcard').find((c) => /95,5 см/.test(txt(c)));
    card95.click();
    await clickDialog('Удалить');
    await clickDialog('Удалить');
    await waitFor(() => !$$('.jcard').some((c) => /95,5 см/.test(txt(c))), 'удаление');
    check('5f. удаление измерения', !read('waist_log', {})[d20] && Object.keys(read('waist_log', {})).length === 2);
    check('5g. журнал талии: нет горизонтальной прокрутки', noHScroll());
    $('.back-btn').click();
    await waitFor(() => location.hash === '#/metric/waist' && $('.waist-stats'), 'назад к талии');
    check('5h. «Назад» возвращает экран талии с тем же периодом (6 МЕС)', !!$('.waist .hseg__btn[data-k="6m"][aria-selected="true"]'));
    check('5i. экран талии: нет горизонтальной прокрутки', noHScroll(), `${document.documentElement.scrollWidth}`);
    $('.back-btn').click();
    await waitFor(() => location.hash === '#/metrics', 'назад к «Показателям»');
    check("5j. «Назад» с экрана талии — в «Показатели», карточка показывает последнее", /91,5\s*см/.test(txt($('.mcard[data-route="metric/waist"]'))), txt($('.mcard[data-route="metric/waist"]')));
    check('5k. вес не изменился', JSON.stringify(read('metrics_log', {}).weight || {}) === weightBefore);

    /* ---------- 6. «Тренировки» ---------- */
    await go('#/home');
    $('#avatar-btn').click();
    await sleep(200);
    const items = $$('#drawer .drawer-item').map(txt);
    const iB = items.indexOf('🚴 Велосипед');
    check('6a. шторка: «🏋️ Тренировки» сразу после «🚴 Велосипеда»; Шаги / Велосипед / Сон / Вода на месте',
      iB > 0 && items[iB + 1] === '🏋️ Тренировки' && ['😴 Сон', '💧 Вода', '👟 Шаги'].every((t) => items.includes(t)) && items.filter((t) => /Показатели/.test(t)).length === 0, items.join(' | '));
    $$('#drawer .drawer-item').find((b) => txt(b) === '🏋️ Тренировки').click();
    await waitFor(() => location.hash === '#/workouts' && $('.workouts .jcard'), 'экран тренировок');
    check('6b. шапка: «Назад» и «Тренировки»; кнопка «Добавить тренировку»', !!$('.workouts .back-btn') && txt($('.workouts .header__title')) === 'Тренировки' && txt($('.workouts-add')) === 'Добавить тренировку');
    const cards = () => $$('.workouts .jcard').map(txt);
    check('6c. перенесённые записи на месте: Планка 3 × 60 сек и Плавание 30 мин', cards().some((t) => /Планка — 3 подхода × 60 сек/.test(t)) && cards().some((t) => /Плавание — 30 мин/.test(t)), cards().join(' / '));
    check('6d. шагов и велосипеда в «Тренировках» нет', !cards().some((t) => /Шаги|Велосипед|Велотренажёр/.test(t)));

    $('.workouts-add').click();
    await waitFor(() => $$('.dialog__btn').some((b) => b.textContent === 'Планка'), 'выбор типа');
    check('6e. сначала — выбор типа: Планка / Другое упражнение', $$('.dialog__btn').map((b) => b.textContent).join('|') === 'Планка|Другое упражнение|Отмена');
    await clickDialog('Планка');
    await waitFor(() => $('.dialog #wo-sets'), 'форма планки');
    check('6f. форма планки: дата — сегодня', $('#wo-d').value === today && !!$('#wo-sec'));
    type($('#wo-sets'), '3');
    type($('#wo-sec'), '60');
    check('6g. общая длительность считается: 3 × 60 = 180 сек (3 мин)', txt($('#wo-total')) === 'Всего: 3 × 60 = 180 сек (3 мин)', txt($('#wo-total')));
    await clickDialog('Сохранить');
    await waitFor(() => txt($('.workouts .jgroup__day')) === 'Сегодня', 'новая планка');
    check('6h. новая планка — сверху, в группе «Сегодня»', /Планка — 3 подхода × 60 сек/.test(txt($('.workouts .jcard'))), txt($('.workouts .jcard')));

    $('.workouts-add').click();
    await clickDialog('Другое упражнение');
    await waitFor(() => $('.dialog #wo-name'), 'форма упражнения');
    check('6i. «Другое»: название — свободный ввод с подсказками', $('#wo-name').getAttribute('list') === 'wo-names' && $$('#wo-names option').map((o) => o.value).includes('Отжимания') && $$('#wo-names option').map((o) => o.value).includes('Плавание'));
    await fill({ 'wo-d': addDay(today, -1), 'wo-name': 'Скакалка во дворе', 'wo-min': '15' }, 'Сохранить');
    await waitFor(() => cards().some((t) => /Скакалка во дворе — 15 мин/.test(t)), 'упражнение задним числом');
    const order = $$('.workouts .jgroup').map((g) => g.dataset.date);
    check('6j. произвольное название и прошлая дата; дни — новые сверху', order[0] === today && order[1] === addDay(today, -1) && order.indexOf(d3) === 2, order.join(' '));

    $$('.workouts .jcard').find((c) => /Планка — 3 подхода/.test(txt(c)) && c.closest('.jgroup').dataset.date === today).click();
    await waitFor(() => $('.dialog #wo-sets'), 'правка планки');
    check('6k. запись открывается для правки, есть «Удалить»', $('#wo-sets').value === '3' && $$('.dialog__btn').some((b) => b.textContent === 'Удалить'));
    await fill({ 'wo-sets': '4', 'wo-sec': '45' }, 'Сохранить');
    await waitFor(() => cards().some((t) => /Планка — 4 подхода × 45 сек/.test(t)), 'изменённая планка');
    check('6l. правка планки сохранена, запись одна', read('workouts_log', []).filter((w) => w.kind === 'plank' && w.date === today).length === 1);
    $$('.workouts .jcard').find((c) => /Плавание/.test(txt(c))).click();
    await clickDialog('Удалить');
    await clickDialog('Удалить');
    await waitFor(() => !cards().some((t) => /Плавание/.test(t)), 'удаление');
    check('6m. удаление (перенесённой записи) — activity_days не изменился', !read('workouts_log', []).some((w) => w.id === `legacy-other-${d3}`) && localStorage.getItem('activity_days') === actBefore);
    await Storage.init();
    check('6n. повторный запуск не возвращает удалённую и не дублирует', read('workouts_log', []).length === 3 && !read('workouts_log', []).some((w) => w.id === `legacy-other-${d3}`));
    check('6o. «Тренировки»: нет горизонтальной прокрутки', noHScroll());

    /* ---------- 7. «Все журналы» видят новые типы ---------- */
    await go('#/journals');
    await waitFor(() => $('.jchip'), 'все журналы');
    const chips = $$('.jchip').map(txt);
    check('7a. «Все журналы»: фильтры «Тренировки» и «Талия»', chips.includes('Тренировки') && chips.includes('Талия'), chips.join('|'));

    /* ---------- 8. резервная копия ---------- */
    const b = await Storage.createBackup();
    const prepared = await Storage.prepareRestore(parseBackup(b.json));
    check('8a. копия содержит талию и тренировки и проходит самопроверку', b.verified && prepared.summary.waist === 2 && prepared.summary.workouts === 3 && !!JSON.parse(b.json).data.workouts_migration);

    /* ---------- 9. пустое состояние тренировок ---------- */
    localStorage.setItem('workouts_log', '[]');
    await go('#/workouts');
    await waitFor(() => $('.workouts-empty'), 'пустые тренировки');
    check('9a. «Пока нет тренировок» и «Добавить первую тренировку»', txt($('.workouts-empty .med-empty__title')) === 'Пока нет тренировок' && txt($('.workouts-first')) === 'Добавить первую тренировку');

    for (const r of ['#/metrics', '#/metric/waist', '#/workouts', '#/journals/workout']) {
      await go(r);
      check(`10. ${r}: нет горизонтальной прокрутки`, noHScroll(), `${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    }
  } finally {
    if (!keep) {
      KEYS.forEach((k) => (saved[k] == null ? localStorage.removeItem(k) : localStorage.setItem(k, saved[k])));
      await go('#/home');
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results);
  return { passed: results.length - failed.length, failed: failed.length, results };
}
