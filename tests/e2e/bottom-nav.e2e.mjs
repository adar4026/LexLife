/* =========================================================
   tests/e2e/bottom-nav.e2e.mjs — нижняя плавающая капсула в настоящем
   браузере (открытое приложение LexLife): активный пункт на основных и
   вложенных экранах, положение индикатора, неизменная геометрия, safe area
   (подставляется через --safe-bottom — только тестовый override, в production
   работает env(safe-area-inset-bottom)), системный шрифт, нижний отступ контента, подписи без
   обрезки, нет горизонтального скролла, переход без перезагрузки, Drawer.
   Данные не меняет — только переходы по экранам.

   Запуск (в консоли открытого http://localhost:4173/, при нужной ширине окна):
     const m = await import('/tests/e2e/bottom-nav.e2e.mjs'); await m.run();
   ========================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  await sleep(350); // render + transition индикатора (200 ms)
}

/* маршрут → ожидаемый активный раздел (null — экран вне вкладок) */
export const ROUTES = [
  ['#/home', 'home'], ['#/metrics', 'metrics'], ['#/meds', 'meds'], ['#/tests', 'tests'],
  ['#/metric/weight', 'metrics'], ['#/metric/pressure', 'metrics'], ['#/metric/water', 'metrics'], ['#/water-log', 'metrics'],
  ['#/test/new', 'tests'], ['#/test-history/hgb', 'tests'],
  ['#/activity', null], ['#/settings', null], ['#/calendar', null],
  ['#/tests', 'tests'], ['#/home', 'home'],
];

export async function run() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const nav = $('#tab-bar');
  const ind = $('.tab-bar__indicator', nav);
  const root = document.documentElement;
  const W = innerWidth;
  const startHash = location.hash || '#/home';
  const heights = new Set();

  try {
    for (const [hash, tab] of ROUTES) {
      await go(hash);
      const cur = $$('.tab[aria-current="page"]', nav);
      const act = $$('.tab.is-active', nav);
      const r = nav.getBoundingClientRect();
      heights.add(`${r.height}|${r.left}|${r.width}|${innerHeight - r.bottom}`);
      if (tab) {
        check(`${hash}: активен «${tab}»`, cur.length === 1 && act.length === 1 && cur[0].dataset.route === tab, cur.map((a) => a.dataset.route).join(','));
        const a = cur[0].getBoundingClientRect();
        let p = ind.getBoundingClientRect();
        /* переход 200 ms; после смены темы/холодного экрана кадр может стартовать позже — ждём до 1 с */
        for (let i = 0; i < 20 && Math.abs(ind.getBoundingClientRect().left - a.left) >= 1.5; i++) await sleep(50);
        p = ind.getBoundingClientRect();
        check(`${hash}: индикатор под активным пунктом`, Math.abs(p.left - a.left) < 1.5 && Math.abs(p.width - a.width) < 1.5 && getComputedStyle(ind).opacity === '1', `${p.left.toFixed(1)} vs ${a.left.toFixed(1)}`);
      } else {
        check(`${hash}: нет активного пункта, индикатор скрыт`, cur.length === 0 && act.length === 0 && !ind.classList.contains('is-ready'));
      }
      check(`${hash}: нет горизонтального скролла`, root.scrollWidth <= W, `${root.scrollWidth} > ${W}`);
    }
    check('капсула не меняет высоту/положение между экранами', heights.size === 1, [...heights].join(' ; '));

    /* геометрия: не касается краёв, капсула, поверх контента */
    const r = nav.getBoundingClientRect();
    const cs = getComputedStyle(nav);
    const side = W <= 340 ? 12 : 14;
    check(`боковые поля ${side}px`, W > 528 || (Math.abs(r.left - side) < 0.6 && Math.abs(W - r.right - side) < 0.6), `${r.left} / ${W - r.right}`);
    check('высота 64px, радиус 32px', r.height === 64 && cs.borderTopLeftRadius === '32px', `${r.height} ${cs.borderTopLeftRadius}`);
    check('без safe area — 6px от нижнего края', Math.abs(innerHeight - r.bottom - 6) < 0.6, String(innerHeight - r.bottom));
    check('position:fixed, z-index выше контента', cs.position === 'fixed' && +cs.zIndex >= 100);

    /* подписи помещаются, касание ≥ 44×44, иконки одного размера */
    for (const a of $$('.tab', nav)) {
      const lb = $('.tab__label', a);
      const ar = a.getBoundingClientRect();
      const ic = $('.tab__icon', a).getBoundingClientRect();
      check(`«${lb.textContent}»: подпись без обрезки`, lb.scrollWidth <= lb.clientWidth + 0.5, `${lb.scrollWidth} > ${lb.clientWidth}`);
      check(`«${lb.textContent}»: зона касания ≥ 44×44`, ar.width >= 44 && ar.height >= 44, `${ar.width.toFixed(1)}×${ar.height.toFixed(1)}`);
      check(`«${lb.textContent}»: иконка 22×22`, ic.width === 22 && ic.height === 22);
      check(`«${lb.textContent}»: системный шрифт`, /^-apple-system/.test(getComputedStyle(lb).fontFamily), getComputedStyle(lb).fontFamily);
    }

    /* safe area (iPhone с Home Indicator ≈ 34px): капсула на 10px заходит в safe area — 24px от края,
       ~11px над Home Indicator (он занимает 8–13px от края); контент — выше капсулы */
    root.style.setProperty('--safe-bottom', '34px');
    await sleep(50);
    const rs = nav.getBoundingClientRect();
    check('safe area 34px: капсула 24px от края, чуть выше Home Indicator', Math.abs(innerHeight - rs.bottom - 24) < 0.6, String(innerHeight - rs.bottom));
    const pad = parseFloat(getComputedStyle($('#screen')).paddingBottom);
    check('safe area 34px: нижний отступ контента = 24 + 64 + 20', Math.abs(pad - 108) < 0.6, String(pad));
    root.style.setProperty('--safe-bottom', '12px');
    await sleep(50);
    check('малая safe area: не ниже 6px от края', Math.abs(innerHeight - nav.getBoundingClientRect().bottom - 6) < 0.6);
    root.style.removeProperty('--safe-bottom');
    await sleep(50);

    /* последний элемент экрана прокручивается выше капсулы */
    for (const hash of ['#/home', '#/metrics', '#/meds', '#/tests', '#/settings']) {
      await go(hash);
      window.scrollTo(0, root.scrollHeight);
      await sleep(120);
      const kids = $$('#screen > * > *').filter((n) => n.getBoundingClientRect().height > 0);
      const last = kids[kids.length - 1];
      const lb = last ? last.getBoundingClientRect().bottom : 0;
      const top = nav.getBoundingClientRect().top;
      check(`${hash}: последний блок выше капсулы`, last && lb <= top + 0.5, `${lb.toFixed(1)} > ${top.toFixed(1)}`);
      window.scrollTo(0, 0);
    }

    /* переход по пункту — без перезагрузки страницы, активный сразу */
    await go('#/home');
    window.__bottomNavMarker = 1;
    $('.tab[data-route="meds"]', nav).click();
    await sleep(30);
    check('тап: активный пункт обновился сразу', $('.tab[data-route="meds"]', nav).getAttribute('aria-current') === 'page');
    await sleep(300);
    check('тап: открыт экран без перезагрузки', location.hash === '#/meds' && window.__bottomNavMarker === 1);
    delete window.__bottomNavMarker;

    /* Drawer как раньше */
    await go('#/home');
    $('#menu-btn').click();
    await sleep(320);
    check('Drawer открывается поверх капсулы', $('#drawer').classList.contains('open') && +getComputedStyle($('#drawer')).zIndex > +getComputedStyle(nav).zIndex);
    $('#scrim').click();
    await sleep(320);
    check('Drawer закрывается', !$('#drawer').classList.contains('open') && !$('#scrim').classList.contains('open'));
  } finally {
    root.style.removeProperty('--safe-bottom');
    if (location.hash !== startHash) location.hash = startHash;
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`bottom-nav e2e @${W}px: ${results.length - failed.length}/${results.length} ok`);
  return { width: W, total: results.length, failed };
}
