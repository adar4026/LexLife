/* =========================================================
   tests/e2e/water.e2e.mjs — статистика воды в духе Apple Health в реальном DOM:
     • сегменты ДН · НЕД · МЕС · 6 МЕС · ГОД (переиспользуемый .hseg), без синего активного фона;
     • «В СРЕДНЕМ» · крупное значение · «мл/день» · диапазон дат; в ДН — «ВСЕГО» за день;
     • для каждого режима: число столбцов, подписи X, среднее = metricPeriods (сумма / прошедшие
       дни периода; дни без воды = 0; будущий день не учитывается), правая ось Y, линия цели;
     • ‹ › — предыдущий / следующий период, тип периода не сбрасывается, «›» у текущего недоступна;
     • выбор столбца: подсказка с датой и значением, заголовок уступает ей место, касание вне — снять;
     • изменение записи воды (быстрое добавление) — график и среднее обновляются, период тот же;
     • «Назад» из журнала — тот же период и смещение;
     • нет горизонтальной прокрутки, подписи оси не обрезаны, подписи X не наезжают; обе темы.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском сохраняет
   затрагиваемые ключи этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/water.e2e.mjs'); await m.run();
     await m.run({ keep: true })   // оставить синтетические данные для скриншотов
   ========================================================= */

import Storage, { dateKey } from '../../js/services/storage.js';
import { periodWindow, aggregatePeriod, fmtGroup } from '../../js/services/metricPeriods.js';

const KEYS = ['health_metrics', 'metrics_log', 'hydration_cfg', 'app_theme'];
const GOAL = 2600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const txt = (n) => (typeof n === 'string' ? txt($(n)) : (n ? n.textContent.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim() : ''));

async function waitFor(fn, what, timeout = 6000) {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
    await sleep(40);
  }
}
async function go(hash) {
  if (location.hash === hash) { location.hash = '#/__'; await sleep(60); }
  location.hash = hash;
  await waitFor(() => location.hash === hash, `адрес ${hash}`);
  await sleep(300);
}
const shift = (n) => dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + n));
const view = () => ({
  kind: $('.hseg__btn[aria-selected="true"]')?.dataset.k,
  cap: txt('.hhead__cap'), num: txt('.hhead__num'), unit: txt('.hhead__unit'), range: txt('.hhead__range'),
  bars: $$('.hc__col').length, x: $$('.hc__xl').map((n) => txt(n)), ticks: $$('.hc__tick').map((n) => txt(n)),
  goal: txt('.hc__goal-lbl'), next: $('.hnav__btn[data-dir="1"]')?.disabled,
});
async function pick(kind) {
  $(`.hseg__btn[data-k="${kind}"]`).click();
  await waitFor(() => $(`.hseg__btn[data-k="${kind}"]`)?.getAttribute('aria-selected') === 'true', `период ${kind}`);
  await sleep(80);
  return view();
}
async function nav(dir) {
  const before = txt('.hhead__range');
  $(`.hnav__btn[data-dir="${dir}"]`).click();
  await waitFor(() => txt('.hhead__range') !== before, 'смена периода');
  await sleep(80);
  return view();
}

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));

  try {
    /* синтетический журнал за ~14 месяцев с дырами; будущий день (+3) — не должен попасть никуда */
    const water = {};
    for (let i = 0; i < 420; i++) {
      if (i % 5 === 3) continue;
      const ml = i < 7 ? 2800 : i < 30 ? 1200 : 1900;
      const entries = [{ t: '09:00', ml: Math.round(ml * 0.4) }, { t: '18:30', ml: ml - Math.round(ml * 0.4) }];
      water[shift(-i)] = { total: ml, entries };
    }
    water[shift(3)] = { total: 9999, entries: [{ t: '09:00', ml: 9999 }] };
    localStorage.setItem('hydration_cfg', JSON.stringify({ wakeStart: '07:00', wakeEnd: '23:00', slotMinutes: 120, notify: false }));
    localStorage.setItem('metrics_log', JSON.stringify({ ...JSON.parse(localStorage.getItem('metrics_log') || '{}'), water }));
    await Storage.setWaterGoal(GOAL);
    const today = dateKey();
    const expect = (kind, offset = 0) => {
      const log = JSON.parse(localStorage.getItem('metrics_log')).water;
      return aggregatePeriod(periodWindow(kind, offset, today), (d) => (log[d] ? log[d].total : null), {
        hourValues: (d) => { const h = new Array(24).fill(0); (log[d]?.entries || []).forEach((e) => { h[Number(e.t.slice(0, 2))] += e.ml; }); return h; },
      });
    };

    await go('#/metric/water');
    await waitFor(() => $('.hstats .hseg'), 'блок статистики воды');
    $('.hstats').scrollIntoView({ block: 'start' });

    /* ---------- 1. структура ---------- */
    check('1a. сегменты ДН · НЕД · МЕС · 6 МЕС · ГОД', $$('.hseg__btn').map((b) => txt(b)).join('|') === 'ДН|НЕД|МЕС|6 МЕС|ГОД', $$('.hseg__btn').map((b) => txt(b)).join('|'));
    check('1b. старого переключателя «Неделя / Месяц / Год» и карточки графика нет', !$('.hstats .seg') && !$('.wchart') && !$('.wavg') && !$('.hstats .card'));
    const order = ['.hseg', '.hhead', '.hc'].map((s) => $(`.hstats ${s}`));
    check('1c. порядок: сегменты → заголовок → график', order.every(Boolean) && order[0].compareDocumentPosition(order[1]) & 4 && order[1].compareDocumentPosition(order[2]) & 4);

    /* ---------- 2. каждый режим ---------- */
    const seen = {};
    for (const k of ['week', 'month', '6m', 'year', 'day']) {
      const v = await pick(k);
      const e = expect(k);
      seen[k] = v;
      const num = fmtGroup(k === 'day' ? e.total : e.average).replace(/ /g, ' ');
      check(`2·${k}. заголовок: ${k === 'day' ? 'ВСЕГО' : 'В СРЕДНЕМ'} … мл = расчёт периода`,
        v.num === num && v.cap.toLowerCase() === (k === 'day' ? 'всего' : 'в среднем') && v.unit === 'мл', `${v.cap} ${v.num} ${v.unit} / ожидалось ${num}`);
      check(`2·${k}. диапазон дат периода`, v.range === e.range.replace(/ /g, ' '), `${v.range} / ${e.range}`);
      check(`2·${k}. столбцов: ${e.buckets.length}`, v.bars === e.buckets.length);
      check(`2·${k}. правая ось Y от 0 до верхней отметки шкалы`, v.ticks[0] === '0' && v.ticks.length >= 3, v.ticks.join(','));
      check(`2·${k}. линия цели ${k === 'day' ? 'не показана (день по часам)' : '«цель 2 600»'}`, k === 'day' ? !$('.hc__goal') : v.goal === 'цель 2 600', v.goal);
      check(`2·${k}. текущий период: «›» недоступна`, v.next === true);
    }
    check('2a. подписи недели Пн…Вс', seen.week.x.join(',') === 'Пн,Вт,Ср,Чт,Пт,Сб,Вс');
    check('2b. месяц — интервалы недель', seen.month.x[0] === '1–7' && seen.month.x[1] === '8–14', seen.month.x.join(','));
    check('2c. 6 месяцев — 6 месяцев', seen['6m'].bars === 6);
    check('2d. год — 12 месяцев, подписи из трёх букв', seen.year.bars === 12 && seen.year.x.every((l) => /^[а-я]{3}$/.test(l.slice(0, 3))), seen.year.x.join(','));
    check('2e. день — 24 часа, подписи 00 06 12 18', seen.day.x.filter(Boolean).join(' ') === '00 06 12 18');
    check('2f. режимы дают разные диапазоны', new Set(['week', 'month', '6m', 'year'].map((k) => seen[k].range)).size === 4);
    const wk = expect('week');
    check('2g. дни без воды = 0, будущий день не учтён', !Object.values(expect('year').dayKeys).includes(shift(3)) && wk.total < 9999);

    /* ---------- 3. навигация ---------- */
    await pick('week');
    const cur = view();
    const prev = await nav(-1);
    const ePrev = expect('week', -1);
    check('3a. «‹» — предыдущая неделя: диапазон, среднее, столбцы', prev.range === ePrev.range.replace(/ /g, ' ') && prev.num === fmtGroup(ePrev.average).replace(/ /g, ' ') && prev.bars === 7, `${prev.range} ${prev.num}`);
    check('3b. тип периода не сбросился, «›» доступна', prev.kind === 'week' && prev.next === false);
    const back = await nav(1);
    check('3c. «›» — снова текущая неделя', back.range === cur.range && back.next === true);
    await pick('month');
    const pm = await nav(-1);
    check('3d. предыдущий месяц — полный, «1 — 30/31 …»', /^1 — (28|29|30|31) /.test(pm.range) && pm.kind === 'month', pm.range);
    await nav(1);

    /* ---------- 4. выбор столбца ---------- */
    await pick('week');
    const firstCol = $$('.hc__col').find((c) => !c.disabled);
    const r = firstCol.getBoundingClientRect();
    const plot = $('.hc__plot');
    const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 });
    plot.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width / 2, r.bottom - 10)));
    plot.dispatchEvent(new PointerEvent('pointerup', opts(r.left + r.width / 2, r.bottom - 10)));
    await sleep(120);
    const eW = expect('week');
    const b0 = eW.buckets[0];
    check('4a. касание столбца — подсказка: дата и значение', !$('.hc__tip').hidden && txt('.hc__tip-title') === b0.tip.replace(/ /g, ' ') && txt('.hc__tip-val') === `${fmtGroup(b0.value).replace(/ /g, ' ')} мл`, txt('.hc__tip'));
    check('4b. выбранный столбец выделен, остальные приглушены', firstCol.classList.contains('is-sel') && $('.hc').classList.contains('hc--sel'));
    check('4c. заголовок периода уступает место подсказке', getComputedStyle($('.hhead')).visibility === 'hidden');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(80);
    check('4d. касание вне графика снимает выбор', $('.hc__tip').hidden && getComputedStyle($('.hhead')).visibility === 'visible');
    await pick('month');
    $('.hc').selectBar(0);
    await sleep(60);
    check('4e. месяц: подсказка «1–7 …» и «в среднем … мл/день»', /^1–7 /.test(txt('.hc__tip-title')) && /^в среднем [\d ]+ мл\/день$/.test(txt('.hc__tip-val')), txt('.hc__tip'));

    /* ---------- 5. изменение записи воды → график обновлён, период тот же ---------- */
    await pick('week');
    const beforeNum = txt('.hhead__num');
    const todayIdx = periodWindow('week', 0, today).buckets.findIndex((b) => b.start === today);
    const beforeH = $$('.hc__col')[todayIdx].querySelector('.hc__bar').dataset.h;
    $('.wqbar__chip').click();
    await waitFor(() => txt('.hhead__num') !== beforeNum, 'обновление среднего после записи');
    await sleep(450);
    const eAfter = expect('week');
    check('5a. после записи воды: среднее пересчитано', txt('.hhead__num') === fmtGroup(eAfter.average).replace(/ /g, ' '), `${beforeNum} → ${txt('.hhead__num')}`);
    check('5b. столбец сегодняшнего дня вырос', parseFloat($$('.hc__col')[todayIdx].querySelector('.hc__bar').style.height) > parseFloat(beforeH), `${beforeH} → ${$$('.hc__col')[todayIdx].querySelector('.hc__bar').style.height}`);
    check('5c. выбранный период не сбросился', view().kind === 'week');

    /* ---------- 6. «Назад» из журнала — тот же период и смещение ---------- */
    await pick('6m');
    const p6 = await nav(-1);
    $('[data-route="journals/water"]').click();
    await waitFor(() => location.hash === '#/journals/water' && $('.jchip'), 'журнал');
    await sleep(1100);
    $('.back-btn').click();
    await waitFor(() => location.hash === '#/metric/water' && $('.hstats .hseg'), 'возврат к воде');
    await sleep(150);
    check('6. «Назад»: тот же тип (6 МЕС) и тот же период', view().kind === '6m' && view().range === p6.range, `${view().kind} ${view().range}`);

    /* ---------- 7. вёрстка и темы ---------- */
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      for (const k of ['week', 'month', '6m', 'year', 'day']) {
        await pick(k);
        const ticks = $$('.hc__tick').map((n) => n.getBoundingClientRect());
        const xs = $$('.hc__xl').map((n) => { const vis = [...n.children].find((c) => getComputedStyle(c).display !== 'none') || n; const rr = vis.getBoundingClientRect(); return { l: n.getBoundingClientRect().left, r: rr.left + rr.width, w: rr.width }; }).filter((x) => x.w > 0);
        const overlap = xs.some((x, i) => i && xs[i - 1].r > x.l + 1);
        check(`7·${theme}·${k}. нет горизонтальной прокрутки, ось Y не обрезана, подписи X не наезжают`,
          document.documentElement.scrollWidth <= window.innerWidth && ticks.every((t) => t.right <= window.innerWidth) && !overlap,
          `${document.documentElement.scrollWidth}/${window.innerWidth} overlap=${overlap}`);
      }
      const on = getComputedStyle($('.hseg__btn[aria-selected="true"]')).backgroundColor;
      const capsule = getComputedStyle($('.hseg')).backgroundColor;
      check(`7·${theme}. активный сегмент — светлая/серая капсула, не синяя`, on !== capsule && !/rgb\((10, 114, 232|88, 166, 255)\)/.test(on), `${on} / ${capsule}`);
      check(`7·${theme}. число читаемо`, getComputedStyle($('.hhead__num')).color !== getComputedStyle(document.body).backgroundColor);
    }
    const seg = $$('.hseg__btn').map((b) => b.getBoundingClientRect().height);
    check('7a. сегменты одной высоты, компактные (28–34px)', seg.every((x) => Math.abs(x - seg[0]) < 0.5 && x >= 28 && x <= 34), seg.join(','));

    return { ok: results.every((x) => x.ok), results };
  } finally {
    if (!keep) for (const [k, v] of Object.entries(saved)) (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
    console.table(results);
  }
}
