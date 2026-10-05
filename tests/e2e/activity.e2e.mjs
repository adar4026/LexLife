/* =========================================================
   tests/e2e/activity.e2e.mjs — «Шаги», «Велосипед» и единый журнал в реальном DOM:
     • Главная: две отдельные карточки (после «Сна»), значения и переход; ни «Активности»,
       ни «Дистанции пешком»; шаги — одной строкой с расчётными км «8 450 шагов · ≈ 6,3 км»;
     • шторка: пункты «👟 Шаги / 🚴 Велосипед»; адресов #/walk, #/walk-log нет;
     • шаги: источник «Беговая дорожка» — тот же дневной итог; км в форме пересчитываются при
       вводе, правка шагов сразу меняет км; walk_log не создаётся;
     • экран показателя: день ‹ › / «Сегодня», добавление за выбранный день, статистика
       Неделя / Месяц / Год — среднее, дни с данными, лучший день пересчитываются при смене периода;
     • журнал: любая прошлая дата, добавить задним числом, изменить, удалить, «Сегодня»,
       повтор той же даты шагов → «Заменить?» без дубля, перенос записи на другую дату;
     • велосипед: две поездки за день — итог дня 19,5 км; удаление поездки; перенос поездки;
     • «Назад» из журнала возвращает экран с тем же периодом (общая навигация);
     • вода и сон — тот же журнал («Журнал ›», «Сегодня»); форма сна из журнала возвращается в журнал;
     • перенос старой «Активности» (activity_days) при запуске; вода и сон не изменились;
     • нет горизонтальной прокрутки.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском сохраняет
   затрагиваемые ключи этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/activity.e2e.mjs'); await m.run();
   ========================================================= */

import Storage, { dateKey } from '../../js/services/storage.js';

const KEYS = ['steps_log', 'walk_log', 'bike_log', 'activity_migration', 'activity_days', 'metrics_log', 'sleep_log', 'sleep_settings'];
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
/* заполнить открытый диалог записи и нажать кнопку */
async function fillDialog(fields, submit) {
  await waitFor(() => $('.dialog #jr-d'), 'диалог записи');
  for (const [id, v] of Object.entries(fields)) type($(`#${id}`), v);
  await clickDialog(submit);
}
const addDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); return dateKey(new Date(y, m - 1, d + n)); };
const read = (k, d) => JSON.parse(localStorage.getItem(k) || JSON.stringify(d));

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const today = dateKey();
  const yesterday = addDay(today, -1);
  const past = addDay(today, -40); // другой месяц
  const past2 = addDay(today, -41);
  try {
    /* ---------- 0. «старая установка»: вода, сон, старая «Активность»; новых разделов ещё нет ---------- */
    const water = { [yesterday]: { total: 1500, entries: [{ t: '09:00', ml: 500 }, { t: '13:00', ml: 1000 }] } };
    const sleepEntry = { id: 'e2e-sl', date: yesterday, sleepStart: `${addDay(yesterday, -1)}T23:40`, sleepEnd: `${yesterday}T07:10`, durationMinutes: 450, quality: 4, awakenings: 0, naps: [], tags: [], note: '', createdAt: null, updatedAt: null };
    localStorage.setItem('metrics_log', JSON.stringify({ ...read('metrics_log', {}), water }));
    localStorage.setItem('sleep_log', JSON.stringify([sleepEntry]));
    localStorage.setItem('activity_days', JSON.stringify({ [addDay(today, -3)]: { steps: 6100, bike: 30, bikeIntensity: 'Средняя', plank: [60] } }));
    ['steps_log', 'walk_log', 'bike_log', 'activity_migration'].forEach((k) => localStorage.removeItem(k));
    const waterBefore = localStorage.getItem('metrics_log'), sleepBefore = localStorage.getItem('sleep_log'), actBefore = localStorage.getItem('activity_days');
    await Storage.init();
    check('M0. запуск не создаёт walk_log', localStorage.getItem('walk_log') == null);
    check('M1. перенос при запуске: шаги старой «Активности» → steps_log', read('steps_log', {})[addDay(today, -3)]?.steps === 6100);
    check('M2. велотренажёр → поездка без дистанции', read('bike_log', []).some((r) => r.id === `legacy-${addDay(today, -3)}` && r.minutes === 30 && r.km == null));
    check('M3. вода, сон и activity_days не изменились', localStorage.getItem('metrics_log') === waterBefore && localStorage.getItem('sleep_log') === sleepBefore && localStorage.getItem('activity_days') === actBefore);

    /* ---------- 1. Главная и шторка ---------- */
    await go('#/home');
    await waitFor(() => $$('.hact').length === 2, 'карточки показателей на Главной');
    const titles = $$('.hsec__title').map(txt);
    const iS = titles.indexOf('Сон');
    check('1a. Главная: «Шаги», «Велосипед» — сразу после «Сна», карточек ровно две',
      iS >= 0 && titles[iS + 1] === 'Шаги' && titles[iS + 2] === 'Велосипед' && $$('.hact').length === 2, titles.join(' | '));
    check('1b. на Главной нет ни «Активности», ни «Дистанции пешком»', !titles.includes('Активность') && !/пешком/i.test(txt($('#screen'))) && !$('.hact[data-activity="walk"]'));
    check('1c. карточка шагов: шаги и ≈ км одной строкой, дата обновления', txt($('.hact[data-activity="steps"] .hrow__title')) === '6 100 шагов · ≈ 4,6 км' && txt($('.hact[data-activity="steps"] .hrow__sub')) !== '',
      txt($('.hact[data-activity="steps"]')));
    check('1d. карточка шагов: мини-график 7 дней', $$('.hact[data-activity="steps"] .hspark rect').length === 7);
    $('#avatar-btn').click();
    await sleep(200);
    const items = $$('#drawer .drawer-item').map(txt);
    const iSl = items.indexOf('😴 Сон');
    check('1f. шторка: Сон / Вода / Шаги / Велосипед, без «Активности» и «Дистанции пешком»',
      iSl >= 0 && items.slice(iSl, iSl + 4).join('|') === '😴 Сон|💧 Вода|👟 Шаги|🚴 Велосипед' && !items.some((t) => /Активность|пешком/i.test(t)), items.join(' | '));
    $$('#drawer .drawer-item').find((b) => txt(b) === '👟 Шаги').click();
    await waitFor(() => location.hash === '#/steps' && $('.act-day'), 'экран «Шаги»');
    check('1g. шторка открывает экран показателя', txt($('.header__title')) === 'Шаги');
    for (const r of ['#/walk', '#/walk-log', `#/walk-log/${today}`]) {
      await go(r);
      await waitFor(() => $('#screen > *'), r);
      check(`1h. ${r}: такого экрана нет (открывается Главная)`, !$('.act-day') && !$('.act-log') && !/пешком/i.test(txt($('.header__title'))) && !!$('.home'), txt($('.header__title')));
    }

    /* ---------- 2. экран шагов: беговая дорожка, км в форме и на экране, прошлый день ---------- */
    await go('#/steps');
    await waitFor(() => $('.act-day'), 'экран шагов');
    check('2a. сегодня записи нет', txt($('.act-day__val')) === 'Нет записи' && txt($('.act-day__when')) === 'Сегодня');
    $('.act-day__edit').click();
    await waitFor(() => $('.dialog #jr-v'), 'форма шагов');
    check('2a2. в форме: источник (Вручную / Прогулка / Беговая дорожка)', $$('#jr-src option').map(txt).join('|') === 'Вручную|Прогулка|Беговая дорожка');
    type($('#jr-v'), '8450');
    check('2a3. км в форме пересчитываются при вводе', txt($('#jr-km')) === '≈ 6,3 км', txt($('#jr-km')));
    type($('#jr-v'), '');
    check('2a4. пустое поле — без NaN', txt($('#jr-km')) === '', txt($('#jr-km')));
    await fillDialog({ 'jr-v': '4 000', 'jr-src': 'treadmill' }, 'Добавить');
    await waitFor(() => /4 000/.test(txt($('.act-day__val'))), 'значение дня');
    check('2b. беговая дорожка — обычные шаги дня: 4 000 шагов · ≈ 3,0 км', txt($('.act-day__val')) === '4 000 шагов · ≈ 3,0 км' && read('steps_log', {})[today]?.steps === 4000, txt($('.act-day__val')));
    check('2b2. источник — только метка: «Беговая дорожка» вторичной строкой, отдельного ключа нет',
      read('steps_log', {})[today]?.source === 'treadmill' && /Беговая дорожка/.test(txt($('.act-day__sub'))) && !Object.keys(localStorage).some((k) => /treadmill|walk_log/.test(k)));
    $('.act-day__edit').click();
    await fillDialog({ 'jr-v': '8450' }, 'Сохранить');
    await waitFor(() => /8 450/.test(txt($('.act-day__val'))), 'правка шагов');
    check('2b3. правка шагов сразу меняет км: 8 450 шагов · ≈ 6,3 км', txt($('.act-day__val')) === '8 450 шагов · ≈ 6,3 км' && Object.keys(read('steps_log', {})).filter((d) => d === today).length === 1, txt($('.act-day__val')));
    check('2b4. км нигде не хранятся', !/"km"/.test(localStorage.getItem('steps_log')));
    $('.act-day [data-dd="-1"]').click();
    await sleep(100);
    check('2c. ‹ — вчера, появилась кнопка «Сегодня»', txt($('.act-day__when')) === 'Вчера' && !!$('.act-day [data-dtoday]'));
    $('.act-day__edit').click();
    await fillDialog({ 'jr-v': '3200' }, 'Добавить');
    await waitFor(() => read('steps_log', {})[yesterday]?.steps === 3200, 'запись за вчера');
    check('2d. запись за выбранный (вчерашний) день: 3 200 шагов · ≈ 2,4 км', txt($('.act-day__when')) === 'Вчера' && txt($('.act-day__val')) === '3 200 шагов · ≈ 2,4 км', txt($('.act-day__val')));
    check('2d2. последние записи — тоже с км', $$('.act-recent .row__title').map(txt).includes('3 200 шагов · ≈ 2,4 км'));
    $('.act-day [data-dtoday]').click();
    await sleep(100);
    check('2e. «Сегодня» возвращает к сегодняшнему дню', txt($('.act-day__when')) === 'Сегодня');

    /* ---------- 3. шаги: статистика Неделя / Месяц / Год пересчитывается целиком ---------- */
    const stepsLog = read('steps_log', {});
    for (let i = 0; i < 400; i++) {
      const d = addDay(today, -i);
      if (i % 4 === 2 || d in stepsLog || d === past || d === past2) continue;
      stepsLog[d] = { steps: 3000 + ((i * 7919) % 9000), note: '', source: 'manual', createdAt: null, updatedAt: null };
    }
    localStorage.setItem('steps_log', JSON.stringify(stepsLog));
    await go('#/steps');
    await waitFor(() => $('.act-avg'), 'статистика шагов');
    const snap = () => ({ avg: txt($('.act-avg')), days: txt($('.act-days')), best: txt($('.act-best')), total: txt($('.act-total')), bars: $$('.act-card .chart').length, title: txt($('.act-stats .sleep-nav__title')) });
    const pick = async (k) => { $(`.act-stats [data-k="${k}"]`).click(); await waitFor(() => $(`.act-stats [data-k="${k}"]`).classList.contains('is-active'), `период ${k}`); await sleep(120); return snap(); };
    $('.act-stats [data-d="-1"]').click(); // прошлая неделя целиком
    await sleep(150);
    const w = snap();
    const m = await pick('month');
    const y = await pick('year');
    const w2 = await pick('week');
    check('3a. Неделя → Месяц → Год: среднее меняется', w.avg !== m.avg && m.avg !== y.avg, `${w.avg} / ${m.avg} / ${y.avg}`);
    check('3b. дни с данными и сумма тоже пересчитаны', w.days !== m.days && m.days !== y.days && w.total !== y.total, `${w.days} / ${m.days} / ${y.days}`);
    check('3c. заголовок периода меняется вместе с цифрами', w.title !== m.title && m.title !== y.title);
    check('3d. обратно на «Неделю» — текущая неделя (с сегодняшнего дня), числа свои', w2.title !== m.title && w2.avg !== m.avg);
    await pick('year');
    check('3e. год — 12 месячных столбцов (компактный DOM)', $$('.act-card .chart svg path').length <= 12, String($$('.act-card .chart svg path').length));

    /* ---------- 4. журнал шагов: прошлая дата, добавить, повтор даты → «Заменить?», правка, перенос, удаление ---------- */
    $('.act-recent .section__action').click();
    await waitFor(() => location.hash.startsWith('#/steps-log') && $('#jr-add'), 'журнал шагов');
    check('4a. журнал: «Журнал шагов», панель с «Сегодня», месяцем и датой', txt($('.header__title')) === 'Журнал шагов' && $('#jr-month') && $('#jr-goto') && $('.jctrl__today'));
    type($('#jr-goto'), past);
    await waitFor(() => location.hash === `#/steps-log/${past}` && $('#jr-month')?.value === past.slice(0, 7), 'переход к прошлой дате');
    check('4b. переход к прошлой дате другого месяца', txt($('.jctrl__title')).length > 0 && $('#jr-month').value === past.slice(0, 7));
    check('4b2. выбранная дата без записей — подсказка', /записей нет/.test(txt($('.jempty'))));
    $('#jr-add').click();
    await waitFor(() => $('#jr-d')?.value === past, 'форма с выбранной датой');
    await fillDialog({ 'jr-v': '8 450' }, 'Добавить');
    await waitFor(() => $(`#jr-${past}`), 'день в журнале');
    check('4c. добавлено задним числом: запись журнала «8 450 шагов · ≈ 6,3 км», источник вторичной строкой', read('steps_log', {})[past]?.steps === 8450
      && txt($(`#jr-${past} .jrow .row__title`)) === '8 450 шагов · ≈ 6,3 км' && txt($(`#jr-${past} .jrow .row__sub`)) === 'Вручную', txt($(`#jr-${past}`)));
    $('#jr-add').click();
    await fillDialog({ 'jr-v': '9000' }, 'Добавить');
    await waitFor(() => $$('.dialog__title').some((t) => txt(t) === 'За эту дату уже есть запись'), 'вопрос о замене');
    await clickDialog('Заменить');
    await waitFor(() => read('steps_log', {})[past]?.steps === 9000, 'замена');
    check('4d. повтор той же даты — замена, а не дубль; км пересчитаны', $$(`#jr-${past} .jrow`).length === 1 && Object.keys(read('steps_log', {})).filter((d) => d === past).length === 1
      && txt($(`#jr-${past} .jday__total`)) === '9 000 шагов · ≈ 6,7 км', txt($(`#jr-${past} .jday__total`)));
    $(`#jr-${past} [data-act="edit"]`).click();
    await fillDialog({ 'jr-v': '9100', 'jr-d': past2 }, 'Сохранить');
    await waitFor(() => read('steps_log', {})[past2]?.steps === 9100, 'перенос');
    check('4e. правка с переносом на другую дату: старая дата пуста', !read('steps_log', {})[past] && !!$(`#jr-${past2}`));
    $(`#jr-${past2} [data-act="del"]`).click();
    await clickDialog('Удалить');
    await waitFor(() => !read('steps_log', {})[past2], 'удаление');
    check('4f. удаление записи дня', !$(`#jr-${past2} .jrow`));
    $('.jctrl__today').click();
    await waitFor(() => location.hash === `#/steps-log/${today}` && $('.jctrl__today')?.disabled, '«Сегодня»');
    check('4g. «Сегодня» — текущий месяц и сегодняшняя дата', $('#jr-month').value === today.slice(0, 7) && $('.jctrl__today').disabled);

    /* ---------- 5. «Назад» — экран шагов с тем же периодом (Год) ---------- */
    $('.back-btn').click();
    await waitFor(() => location.hash === '#/steps' && $('.act-stats'), 'возврат на экран шагов');
    await sleep(200);
    check('5. «Назад» из журнала: тот же период «Год»', $('.act-stats [data-k="year"]').classList.contains('is-active'));

    /* ---------- 6. велосипед: две поездки, сумма, удаление, перенос ---------- */
    await go(`#/bike-log/${yesterday}`);
    await waitFor(() => $('#jr-add'), 'журнал поездок');
    $('#jr-add').click();
    await fillDialog({ 'jr-t': '08:30', 'jr-km': '7,4' }, 'Добавить');
    await waitFor(() => $(`#jr-${yesterday}`), 'день поездки');
    $('#jr-add').click();
    await waitFor(() => $('#jr-d'), 'форма');
    type($('#jr-d'), yesterday);
    await fillDialog({ 'jr-t': '18:20', 'jr-km': '12,1' }, 'Добавить');
    await waitFor(() => $$(`#jr-${yesterday} .jrow`).length === 2, 'две поездки');
    check('6a. две поездки за день, итог дня 19,5 км', txt($(`#jr-${yesterday} .jday__total`)) === '19,5 км', txt($(`#jr-${yesterday} .jday__total`)));
    check('6b. поездки по времени: 08:30, затем 18:20', /^08:30/.test(txt($$(`#jr-${yesterday} .jrow .row__title`)[0])) && /^18:20/.test(txt($$(`#jr-${yesterday} .jrow .row__title`)[1])));
    $$(`#jr-${yesterday} [data-act="edit"]`)[1].click();
    await fillDialog({ 'jr-d': today }, 'Сохранить');
    await waitFor(() => $(`#jr-${today}`), 'перенос поездки');
    check('6c. перенос поездки на другую дату: оба дня пересчитаны', txt($(`#jr-${today} .jday__total`)) === '12,1 км' && txt($(`#jr-${yesterday} .jday__total`)) === '7,4 км');
    $(`#jr-${yesterday} [data-act="del"]`).click();
    await clickDialog('Удалить');
    await waitFor(() => !$(`#jr-${yesterday}`), 'удаление поездки');
    check('6d. удалена одна поездка, другая на месте', read('bike_log', []).filter((r) => r.km != null).length === 1);
    await go('#/home');
    await waitFor(() => $('.hact[data-activity="bike"]'), 'Главная');
    check('6e. Главная: велосипед сегодня — 12,1 км, 1 поездка', txt($('.hact[data-activity="bike"] .hrow__title')) === '12,1 км' && /1 поездка/.test(txt($('.hact[data-activity="bike"] .hrow__sub'))));

    /* ---------- 6f. велотренажёр без км (перенесён из старой версии): не «0 км» ---------- */
    const trainerDay = addDay(today, -3);
    await go(`#/bike-log/${trainerDay}`);
    await waitFor(() => $(`#jr-${trainerDay}`), 'день велотренажёра в журнале');
    const tr = txt($(`#jr-${trainerDay}`));
    check('6f. журнал: «Велотренажёр · 30 мин» и «Дистанция не указана», без «0 км»',
      /Велотренажёр · 30 мин/.test(tr) && /Дистанция не указана/.test(tr) && !/\b0(,0)? км/.test(tr), tr);

    /* ---------- 6g. «Статистика»: два самостоятельных блока, ни «Активности», ни «Дистанции пешком» ---------- */
    await go('#/stats');
    await waitFor(() => $('#st-steps'), 'статистика');
    const statsText = txt($('#screen'));
    check('6g. «Статистика»: блоки «👟 Шаги» и «🚴 Велосипед»', txt($('#st-steps .section__title')) === '👟 Шаги' && txt($('#st-bike .section__title')) === '🚴 Велосипед');
    check('6h. «Статистика»: нет ни «Активности», ни «Дистанции пешком»', !$('#st-activity') && !$('#st-walk') && !/Активность|пешком/i.test(statsText));
    check('6i. каждый блок ведёт на свой экран', $('#st-steps [data-route]')?.dataset.route === 'steps' && $('#st-bike [data-route]')?.dataset.route === 'bike');
    const stepTiles = $$('#st-steps .st-tile, #st-steps [class*="tile"]').map(txt).join(' | ') || txt($('#st-steps'));
    check('6k. шаги в «Статистике»: среднее, лучший день, минимум, дни с данными, сумма; км — вторично',
      /Среднее в день/.test(stepTiles) && /Лучший день/.test(stepTiles) && /Минимум/.test(stepTiles) && /Дней с данными/.test(stepTiles) && /Всего за период\s*[\d ]+ шаг\S*\s*≈ [\d ]+,\d км · сумма/.test(stepTiles) && !!$('#st-steps .chart'), stepTiles);
    check('6j. велосипед в «Статистике»: поездка без дистанции — отдельно, не 0 км', /дистанция не указана/.test(txt($('#st-bike'))) && !/\b0(,0)? км/.test(txt($('#st-bike'))), txt($('#st-bike')));

    /* ---------- 7. вода и сон — тот же журнал ---------- */
    await go('#/metric/water');
    await waitFor(() => $('[data-route="water-log"]'), 'вода');
    check('7a. вода: ссылка «Журнал ›»', txt($('[data-route="water-log"]')) === 'Журнал ›');
    $('[data-route="water-log"]').click();
    await waitFor(() => location.hash.startsWith('#/water-log') && $('#wl-add'), 'журнал воды');
    check('7b. журнал воды — та же панель (Сегодня, месяц, дата)', !!$('.jctrl__today') && !!$('#wl-month') && !!$('#wl-goto') && !!$(`#wl-${yesterday}`) && txt($(`#wl-${yesterday} .jday__total`)) === '1 500 мл');
    await go('#/sleep');
    await waitFor(() => $('.sleep-journal'), 'сон');
    $('.sleep-journal').click();
    await waitFor(() => location.hash.startsWith('#/sleep-log') && $('#jr-add'), 'журнал сна');
    check('7c. журнал сна: запись за вчера, 7 ч 30 мин', /7 ч 30 мин/.test(txt($(`#jr-${yesterday}`))), txt($('.jday')));
    type($('#jr-goto'), addDay(today, -5));
    await sleep(150);
    $('#jr-add').click();
    await waitFor(() => location.hash === `#/sleep/new/${addDay(today, -5)}` && $('#sf-bed-time'), 'форма сна на выбранную дату');
    check('7d. «+ Добавить» — форма сна на выбранную дату', $('#sf-wake-date').value === addDay(today, -5));
    type($('#sf-bed-time'), '23:40');
    type($('#sf-wake-time'), '07:10');
    $('.med-form__form button[type="submit"]').click();
    await waitFor(() => location.hash.startsWith('#/sleep-log') && $(`#jr-${addDay(today, -5)}`), 'возврат в журнал сна');
    check('7e. после сохранения — обратно в журнал сна, запись на месте', /7 ч 30 мин/.test(txt($(`#jr-${addDay(today, -5)}`))));

    check('8. вода и прежний сон не изменились', JSON.stringify(read('metrics_log', {}).water) === JSON.stringify(water) && read('sleep_log', []).some((e) => e.id === 'e2e-sl' && e.durationMinutes === 450));

    /* ---------- 9. вёрстка ---------- */
    for (const r of ['#/steps', '#/bike', '#/steps-log', '#/home']) {
      await go(r);
      check(`9. ${r}: нет горизонтальной прокрутки`, document.documentElement.scrollWidth <= window.innerWidth, `${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    }
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
