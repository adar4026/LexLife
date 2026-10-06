/* =========================================================
   tests/e2e/back-nav.e2e.mjs — единая кнопка «Назад» в настоящем браузере.

   run():
     1. каждый внутренний экран: ровно одна круглая .back-btn (52–56px, касание ≥ 44,
        без подписи, aria-label), слева по краю контента, центр — на линии аватара,
        не fixed (уезжает при прокрутке), заголовок — под ней; цвета темы;
     2. A → B → назад: ровно на A (Вода, открытая с Главной, возвращает на Главную);
     3. цепочка из 4 экранов назад в обратном порядке;
     4. двойной тап — один шаг назад;
     5. правка визита/анализа → «Сохранить» → карточка; «Назад» с карточки — к списку
        (формы в истории не остаётся); новый визит — то же;
     6. прокрутка и состояние экрана (период Воды, вид Календаря) — после возврата прежние.
   runDirect(fallback): сразу после загрузки внутреннего URL «с нуля» — истории LexLife нет,
     «Назад» заменяет запись на fallback (длина истории та же, из приложения не уходим).

   Только на localhost (отдельный origin с синтетическими данными): перед запуском
   сохраняет весь localStorage этого origin, после — возвращает его как был.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/back-nav.e2e.mjs'); await m.run();
   ========================================================= */

import Storage from '../../js/services/storage.js';
import { navDepth } from '../../js/ui/backNav.js';

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
const title = () => ($('#screen .header__title')?.textContent || '').trim();
/* экран отрисован: адрес совпал и роутер смонтировал новый корень в #screen
   (до этого на месте старый экран — тап по его кнопке намеренно игнорируется) */
const rendered = (prev) => $('#screen').firstElementChild && $('#screen').firstElementChild !== prev;
async function go(hash) {
  if (location.hash === hash) return; // уже здесь — перехода (и новой записи) не будет
  const prev = $('#screen').firstElementChild;
  location.hash = hash;
  await waitFor(() => location.hash === hash && rendered(prev), `экран ${hash}`);
  await sleep(150);
}
async function back(expectHash) {
  const prev = $('#screen').firstElementChild;
  $('#screen .back-btn').click();
  await waitFor(() => location.hash === expectHash && rendered(prev), `назад на ${expectHash} (сейчас ${location.hash})`);
  await sleep(150);
}
const isLocal = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/* проверка вида кнопки на текущем экране */
function inspectButton() {
  const btns = $$('#screen .back-btn');
  const b = btns[0];
  if (!b) return { count: 0 };
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  const screenRect = $('#screen').getBoundingClientRect();
  const screenPad = parseFloat(getComputedStyle($('#screen')).paddingLeft);
  const h1 = $('#screen .header__title');
  const avatar = $('#avatar-btn');
  const avatarShown = avatar && !avatar.classList.contains('hidden');
  const ar = avatarShown ? avatar.getBoundingClientRect() : null;
  return {
    count: btns.length,
    w: r.width, h: r.height,
    round: cs.borderRadius === '50%' || parseFloat(cs.borderRadius) >= r.width / 2 - 0.5,
    text: b.textContent.trim(),
    aria: b.getAttribute('aria-label'),
    svg: !!$('svg.back-btn__icon', b),
    position: cs.position,
    left: Math.round(r.left - screenRect.left - screenPad),
    centerY: r.top + window.scrollY + r.height / 2,
    avatarCenterY: ar ? ar.top + window.scrollY + ar.height / 2 : null,
    titleBelow: h1 ? h1.getBoundingClientRect().top >= r.bottom - 1 : false,
    bg: cs.backgroundColor, border: cs.borderTopColor, borderW: cs.borderTopWidth, ink: cs.color,
  };
}

export async function run({ keep = false } = {}) {
  if (!isLocal()) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));
  const theme = document.documentElement.dataset.theme || 'dark';

  try {
    /* синтетика: анализ с ЛПНП и визит (2026-02-14 — синтетическая дата) */
    const t = await Storage.addTest({ date: '2026-02-14', note: 'синтетика e2e', ldl: 2.1 });
    const v = await Storage.addVisit({ date: '2026-02-14', doctor: 'Синтетический врач', specialty: 'Терапевт', status: 'done' });
    await go('#/home');

    /* ---------- 1. все внутренние экраны ---------- */
    const routes = [
      'profile', 'steps', 'bike', 'steps-log', 'bike-log', 'sleep-log', 'visits', `visit/${v.id}`, 'visit/new', `visit/${v.id}/edit`, 'settings', 'export', 'water-import', 'theme',
      'notifications', 'goals', 'calendar', 'stats', 'security', 'move', 'sleep', 'sleep/new', 'sleep/settings',
      'med/new', `test/${t.id}`, 'test/new', `test/${t.id}/edit`, 'test-history/ldl',
      'metric/water', 'water-log', 'metric/weight', 'metric/pressure', 'metric/pulse', 'journals', 'journals/water',
    ];
    const bad = [];
    for (const r of routes) {
      await go(`#/${r}`);
      window.scrollTo(0, 0);
      await sleep(30);
      const i = inspectButton();
      const problems = [];
      if (i.count !== 1) problems.push(`кнопок ${i.count}`);
      else {
        if (i.w < 52 || i.w > 56 || Math.abs(i.w - i.h) > 0.5) problems.push(`размер ${i.w}×${i.h}`);
        if (!i.round) problems.push('не круглая');
        if (i.text) problems.push(`текст «${i.text}»`);
        if (i.aria !== 'Назад') problems.push(`aria ${i.aria}`);
        if (!i.svg) problems.push('нет шеврона');
        if (i.position === 'fixed') problems.push('fixed');
        if (i.left !== 0) problems.push(`левый край ${i.left}`);
        if (Math.abs(i.centerY - 38) > 1) problems.push(`центр по Y ${i.centerY}`);
        if (i.avatarCenterY !== null && Math.abs(i.centerY - i.avatarCenterY) > 1) problems.push(`не на линии аватара (${i.centerY} vs ${i.avatarCenterY})`);
        if (!i.titleBelow) problems.push('заголовок не под кнопкой');
      }
      if (problems.length) bad.push(`${r}: ${problems.join(', ')}`);
    }
    check(`1. ${routes.length} внутренних экранов — одна единая кнопка на месте`, !bad.length, bad.join(' | '));

    const look = inspectButton();
    if (theme === 'light') check('1a. светлая тема: белый фон, тёмная тонкая обводка, чёрный шеврон', look.bg === 'rgb(255, 255, 255)' && /^rgba\(28, 28, 30, 0\.2\d*\)$/.test(look.border) && look.borderW === '1px' && look.ink === 'rgb(17, 17, 19)', JSON.stringify(look));
    else check('1a. тёмная тема: тёмная заливка, светлый контур, светлый шеврон', look.bg === 'rgb(28, 35, 44)' && /^rgba\(255, 255, 255, 0\.2\)$/.test(look.border) && look.ink === 'rgb(242, 244, 247)', JSON.stringify(look));
    check('1b. вкладки — без кнопки «Назад»', await (async () => {
      for (const r of ['home', 'metrics', 'meds', 'tests']) { await go(`#/${r}`); if ($$('#screen .back-btn').length) return false; }
      return true;
    })());

    /* прокрутка: кнопка в потоке шапки, уезжает вместе со страницей */
    await go('#/stats');
    const yb = $('#screen .back-btn').getBoundingClientRect().top;
    window.scrollTo(0, 200);
    await sleep(80);
    const ya = $('#screen .back-btn').getBoundingClientRect().top;
    check('1c. кнопка прокручивается вместе с шапкой (не fixed)', document.documentElement.scrollHeight <= innerHeight + 5 || ya < yb - 50, `top ${yb} → ${ya}`);

    /* ---------- 2. A → B → назад ---------- */
    await go('#/home');
    await go('#/metric/water');
    await back('#/home');
    check('2. Вода, открытая с Главной: «Назад» — на Главную (раньше — всегда на «Показатели»)', location.hash === '#/home' && $('.hh__bar'));
    await go('#/calendar');
    await go(`#/visit/${v.id}`);
    await back('#/calendar');
    check('2a. визит, открытый из Календаря: «Назад» — в Календарь, не в список визитов', title() === 'Календарь');

    /* ---------- 3. цепочка из 4 экранов ---------- */
    await go('#/tests');
    await go(`#/test/${t.id}`);
    await go('#/test-history/ldl');
    const d0 = navDepth();
    const chain = [];
    await back(`#/test/${t.id}`); chain.push(location.hash);
    await back('#/tests'); chain.push(location.hash);
    check('3. цепочка Главная → Анализы → анализ → история: назад по порядку', chain.join(' ') === `#/test/${t.id} #/tests` && navDepth() === d0 - 2, `${chain.join(' ')} глубина ${d0}→${navDepth()}`);

    /* ---------- 4. двойной тап ---------- */
    await go('#/settings');
    await go('#/theme');
    const btn = $('#screen .back-btn');
    const prevT = $('#screen').firstElementChild;
    btn.click(); btn.click();
    await waitFor(() => location.hash === '#/settings' && rendered(prevT), 'назад на настройки');
    btn.click(); // ещё один тап по старой кнопке, пока новый экран ещё не на месте, — тоже не считается
    await sleep(500);
    check('4. двойной тап — ровно один шаг назад', location.hash === '#/settings', location.hash);

    /* ---------- 5. возврат после редактирования ---------- */
    await go('#/visits');
    await go(`#/visit/${v.id}`);
    await go(`#/visit/${v.id}/edit`);
    $('#f-doctor').value = 'Синтетический врач 2';
    $$('#screen .btn-primary').find((b) => /Сохранить/.test(b.textContent)).click();
    await waitFor(() => location.hash === `#/visit/${v.id}` && /врач 2/.test($('.visit-head__name')?.textContent || ''), 'карточка визита после правки');
    await sleep(250);
    check('5. правка визита → «Сохранить» → карточка с новыми данными', true);
    await back('#/visits');
    check('5a. «Назад» с карточки после правки — к списку визитов (формы в истории нет)', title() === 'Врачи и визиты');

    await go('#/visit/new');
    $('#f-doctor').value = 'Новый синтетический';
    $$('#screen .btn-primary').find((b) => /Добавить визит/.test(b.textContent)).click();
    await waitFor(() => /^#\/visit\/(?!new)/.test(location.hash) && /Новый синтетический/.test($('.visit-head__name')?.textContent || ''), 'карточка нового визита');
    await sleep(250);
    await back('#/visits');
    check('5b. новый визит → карточка; «Назад» — к списку, а не к пустой форме', title() === 'Врачи и визиты');

    await go('#/tests');
    await go(`#/test/${t.id}`);
    await go(`#/test/${t.id}/edit`);
    $('#f-note').value = 'синтетика e2e — правка';
    const prevF = $('#screen').firstElementChild;
    $$('#screen .btn-primary').find((x) => /Сохранить/.test(x.textContent)).click();
    await waitFor(() => location.hash === `#/test/${t.id}` && rendered(prevF), 'анализ после правки');
    await sleep(150);
    await back('#/tests');
    check('5c. правка анализа → анализ → «Назад» — к журналу', location.hash === '#/tests');

    /* ---------- 6. прокрутка и состояние экрана ---------- */
    await go('#/metric/water');
    $('#screen [data-p="month"]').click();
    await sleep(300);
    window.scrollTo(0, 260);
    await sleep(400); // прокрутка сохраняется в запись с задержкой 250 мс
    const y0 = window.scrollY;
    $('#screen [data-route="journals/water"]').click();
    await waitFor(() => location.hash === '#/journals/water' && title() === 'Все журналы', 'журнал воды');
    check('6. новый экран открывается сверху', window.scrollY < 5, `scrollY ${window.scrollY}`);
    $('#screen .jchip[data-filter="sleep"]')?.click(); // смена фильтра (replaceState) не ломает возврат
    await sleep(300);
    await back('#/metric/water');
    await sleep(200);
    check('6a. Вода после возврата: прежний период «Месяц»', $('#screen [data-p="month"]').classList.contains('is-active'));
    check('6b. Вода после возврата: прежнее место прокрутки', y0 > 100 ? Math.abs(window.scrollY - y0) < 4 : true, `было ${y0}, стало ${window.scrollY}`);

    await go('#/calendar');
    $('#screen [data-m="list"]').click();
    await sleep(250);
    await go('#/visits');
    await back('#/calendar');
    check('6c. Календарь после возврата: прежний вид «Список»', $('#screen [data-m="list"]').classList.contains('is-active'));
    await go('#/home');
    await go('#/calendar');
    check('6d. новый переход в Календарь — вид по умолчанию «Месяц»', $('#screen [data-m="month"]').classList.contains('is-active'));
  } finally {
    if (!keep) {
      Object.keys(localStorage).forEach((k) => { if (!(k in saved)) localStorage.removeItem(k); });
      Object.entries(saved).forEach(([k, val]) => localStorage.setItem(k, val));
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`back-nav e2e: ${results.length - failed}/${results.length}`);
  return { passed: results.length - failed, failed, results };
}

/* Сразу после загрузки внутреннего URL «с нуля» (до этого — чужая страница или ничего) */
export async function runDirect(fallbackHash) {
  if (!isLocal()) throw new Error('e2e запускается только на localhost');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const start = location.hash;
  await waitFor(() => $('#screen .back-btn'), 'кнопка «Назад»');
  const len = history.length;
  check(`D. ${start} открыт напрямую: истории LexLife нет`, navDepth() === 0, `глубина ${navDepth()}`);
  $('#screen .back-btn').click();
  await waitFor(() => location.hash === fallbackHash, `fallback ${fallbackHash}`);
  await sleep(300);
  check(`D1. «Назад» → ${fallbackHash} заменой (длина истории та же, приложение не покинуто)`, history.length === len && location.origin === window.origin && navDepth() === 0, `длина ${len} → ${history.length}`);
  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}
