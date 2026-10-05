/* =========================================================
   tests/e2e/water.e2e.mjs — сквозная проверка статистики воды на экране «Вода»:
   крупное среднее над графиком, один canonical range на среднее / подпись / график /
   «цель выполнена, дней», и воспроизведение прежнего бага — при переключении
   Неделя → Месяц → Год среднее обязано пересчитываться, а не оставаться прежним.

   Проверяется также: старой нижней карточки с тремя средними нет; блок стоит
   над графиком внутри того же блока; нижняя навигация ничего не перекрывает;
   светлая и тёмная тема; ширина iPhone.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском
   сохраняет health_metrics / metrics_log / hydration_cfg этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/water.e2e.mjs'); await m.run();
     await m.run({ keep: true })   // оставить синтетические данные для скриншотов
   ========================================================= */

import Storage, { dateKey } from '../../js/services/storage.js';
import { getWaterStatsRange, formatLiters } from '../../js/services/analytics.js';

const KEYS = ['health_metrics', 'metrics_log', 'hydration_cfg', 'app_theme'];
const GOAL = 2600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const txt = (s) => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim();

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
  location.hash = hash;
  await waitFor(() => location.hash === hash, `адрес ${hash}`);
  await sleep(250);
}
/* нажать кнопку периода и дождаться перерисовки */
async function pick(period) {
  const btn = $(`.seg__btn[data-p="${period}"]`);
  if (!btn) throw new Error(`нет кнопки периода ${period}`);
  btn.click();
  await waitFor(() => $(`.seg__btn[data-p="${period}"]`)?.classList.contains('is-active'), `активна кнопка ${period}`);
  await sleep(120);
  return { avg: txt('.wavg__val'), range: txt('.wavg__range'), caption: txt('.wavg + * ~ *') };
}
const shift = (n) => dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + n));

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));

  try {
    /* ---------- синтетический журнал: у каждого периода своё среднее ----------
       последние 7 дней — 2800, дни 8–30 — 1200, дальше год — 1900, с дырами (дни без воды). */
    const water = {};
    for (let i = 0; i < 420; i++) {
      if (i % 5 === 3) continue; // дни без записей воды — должны считаться нулём (есть и внутри недели)
      const ml = i < 7 ? 2800 : i < 30 ? 1200 : 1900;
      water[shift(-i)] = { total: ml, entries: [{ t: '09:00', ml }] };
    }
    water[shift(3)] = { total: 9999, entries: [{ t: '09:00', ml: 9999 }] }; // будущий день — не должен попасть ни в один период
    localStorage.setItem('hydration_cfg', JSON.stringify({ wakeStart: '07:00', wakeEnd: '23:00', slotMinutes: 120, notify: false }));
    localStorage.setItem('metrics_log', JSON.stringify({ ...JSON.parse(localStorage.getItem('metrics_log') || '{}'), water }));
    await Storage.setWaterGoal(GOAL);

    await go('#/metric/water');
    await waitFor(() => $('.wavg__val'), 'блок среднего на экране воды');

    /* ---------- 1. блок есть, старой карточки с тремя средними нет ---------- */
    check('крупное среднее показано над графиком', !!$('.wavg__val') && !!$('.wavg__cap'));
    check('подпись «В среднем» и единица «л/день»',
      /в среднем/i.test(txt('.wavg__cap')) && /л\/день/.test(txt('.wavg__unit')), `${txt('.wavg__cap')} / ${txt('.wavg__unit')}`);
    check('старой карточки «среднее, л/день» с тремя значениями нет',
      !$$('div').some((d) => /^среднее, л\/день$/i.test(d.textContent.trim())) && !$('.wavg__mid') && !$('.wavg__lbl'));

    const hero = $('.wavg');
    const chart = $('.wchart');
    check('среднее и график — в одном блоке, среднее выше графика',
      !!chart && hero.parentElement === chart.parentElement
      && !!(hero.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING),
      `родители: ${hero.parentElement?.className} / ${chart?.parentElement?.className}`);

    /* ---------- 2. каждый период: значение и диапазон = canonical range ---------- */
    const log = JSON.parse(localStorage.getItem('metrics_log')).water;
    const seen = {};
    for (const p of ['week', 'month', 'year']) {
      const shown = await pick(p);
      const r = getWaterStatsRange(p, new Date(), log);
      seen[p] = { ...shown, expected: formatLiters(r.average), range: shown.range, r };
      check(`${p}: среднее соответствует диапазону`, shown.avg.startsWith(formatLiters(r.average)),
        `показано «${shown.avg}», ожидалось «${formatLiters(r.average)} л/день» (${r.startDate}…${r.endDate}, ${r.numberOfDays} дн.)`);
      check(`${p}: подпись диапазона содержит границы диапазона`,
        shown.range.includes(String(Number(r.endDate.slice(8)))) && shown.range.length > 8, shown.range);
      /* дублирующей подписи «за период: …» под «цель выполнена, дней» быть не должно —
         диапазон показан один раз, сверху, в .wavg__range */
      check(`${p}: дублирующей подписи «за период:» нет`,
        !$$('div').some((d) => /^за период:/.test(d.textContent.trim())));
      /* «цель выполнена, дней» всё равно считается по тому же диапазону — проверяем через
         диалог карточки, который явно называет период и границы (waterGoalDays(rng.dayKeys)) */
      $('.stat--link')?.click();
      await sleep(100);
      const dialogBody = txt('.dialog__body');
      check(`${p}: диалог «цель выполнена» ссылается на диапазон канонического периода`,
        dialogBody.includes(String(r.numberOfDays)) && dialogBody.toLowerCase().includes(r.label), dialogBody);
      $$('.dialog__btn').find((b) => /закрыть/i.test(b.textContent))?.click();
      await sleep(100);
      check(`${p}: число столбцов графика соответствует диапазону`,
        $$('.wchart__barcol').length === (p === 'year' ? 12 : r.numberOfDays),
        `${$$('.wchart__barcol').length} столбцов при ${r.numberOfDays} дн.`);
    }

    /* ---------- 3. баг: переключение реально меняет среднее ---------- */
    check('Неделя / Месяц / Год — три разных средних, значение не «залипает»',
      new Set([seen.week.avg, seen.month.avg, seen.year.avg]).size === 3,
      `${seen.week.avg} / ${seen.month.avg} / ${seen.year.avg}`);
    check('диапазоны периодов тоже разные', new Set([seen.week.range, seen.month.range, seen.year.range]).size === 3,
      [seen.week.range, seen.month.range, seen.year.range].join(' | '));

    /* воспроизведение прежнего сценария: запомнить месяц → переключить на год */
    const month = await pick('month');
    const year = await pick('year');
    check('баг воспроизведён и исправлен: после Месяц → Год показано годовое среднее',
      year.avg !== month.avg && year.avg.startsWith(formatLiters(getWaterStatsRange('year', new Date(), log).average)),
      `месяц ${month.avg} → год ${year.avg}`);

    /* ---------- 4. дни без воды = 0 и будущий день не учтён ---------- */
    const rWeek = getWaterStatsRange('week', new Date(), log);
    check('дни без записей вошли в расчёт как 0', rWeek.dailyTotals.some((d) => d.total === 0) && rWeek.average < 2800, `${rWeek.average}`);
    check('будущий день (+3) не попал ни в один период',
      !['week', 'month', 'year'].some((p) => getWaterStatsRange(p, new Date(), log).dayKeys.includes(shift(3))));

    /* ---------- 5. вёрстка: iPhone, нижняя навигация, темы ---------- */
    await pick('year');
    const nav = $('.tabbar') || $('nav');
    const box = $('.wavg').getBoundingClientRect();
    check('блок среднего не выходит за ширину экрана',
      box.left >= -1 && box.right <= window.innerWidth + 1 && $('.wavg__val').scrollWidth <= $('.wavg__val').clientWidth + 1,
      `${Math.round(box.left)}…${Math.round(box.right)} при ширине ${window.innerWidth}`);
    check('значение, единица и диапазон на отдельных строках и видимы',
      box.height > 50 && getComputedStyle($('.wavg__val')).fontSize.replace('px', '') > 28, getComputedStyle($('.wavg__val')).fontSize);
    if (nav) {
      const nb = nav.getBoundingClientRect();
      $('.wavg').scrollIntoView({ block: 'center' });
      await sleep(150);
      const hb = $('.wavg').getBoundingClientRect();
      check('нижняя навигация не перекрывает блок среднего', hb.bottom <= nb.top + 1, `блок до ${Math.round(hb.bottom)}, навигация с ${Math.round(nb.top)}`);
    }
    for (const theme of ['dark', 'light']) {
      localStorage.setItem('app_theme', theme);
      document.documentElement.dataset.theme = theme;
      await sleep(200);
      const c = getComputedStyle($('.wavg__val')).color;
      const bg = getComputedStyle(document.body).backgroundColor;
      check(`тема ${theme}: число читаемо (цвет текста ≠ цвет фона)`, c !== bg, `${c} на ${bg}`);
    }

    return { ok: results.every((r) => r.ok), results, seen };
  } finally {
    if (!keep) for (const [k, v] of Object.entries(saved)) (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
    console.table(results);
  }
}
