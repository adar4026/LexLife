/* =========================================================
   tests/e2e/home.e2e.mjs — сквозная проверка плановой метки на шкале воды Главной:
   положение метки действительно обновляется раз в минуту (без перерендера экрана),
   и таймер этого обновления не утекает — гасится при уходе с Главной, не дублируется
   при повторном открытии.

   Только на localhost (отдельный origin с синтетическими данными). Перед запуском
   сохраняет hydration_cfg/health_metrics/metrics_log этого origin, после — возвращает их.

   Запуск (в консоли открытого http://127.0.0.1:<порт>/):
     const m = await import('/tests/e2e/home.e2e.mjs'); await m.run();
   ========================================================= */

import Storage, { dateKey } from '../../js/services/storage.js';

const KEYS = ['hydration_cfg', 'health_metrics', 'metrics_log'];
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
async function go(hash) {
  location.hash = hash;
  await waitFor(() => location.hash === hash, `адрес ${hash}`);
  await sleep(250);
}
const planRatio = () => { const v = $('.hh__plan')?.style.getPropertyValue('--plan'); return v === '' ? null : Number(v); };

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const today = dateKey();

  /* перехват setInterval/clearInterval — считаем только таймеры метки (задержка 60000) */
  const RealDate = Date;
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const created = []; // { id, fn }
  const cleared = [];
  window.setInterval = (fn, delay, ...args) => {
    const id = realSetInterval(fn, delay, ...args);
    if (delay === 60000) created.push({ id, fn });
    return id;
  };
  window.clearInterval = (id) => { if (created.some((c) => c.id === id)) cleared.push(id); return realClearInterval(id); };

  try {
    localStorage.setItem('hydration_cfg', JSON.stringify({ wakeStart: '07:00', wakeEnd: '23:00', slotMinutes: 120, notify: false }));
    await Storage.setWaterGoal(2600);
    const ml = { total: 900, entries: [{ t: '08:00', ml: 900 }] };
    localStorage.setItem('metrics_log', JSON.stringify({ ...JSON.parse(localStorage.getItem('metrics_log') || '{}'), water: { [today]: ml } }));

    /* фиксированное время 10:00 — предсказуемая метка независимо от реального часа прогона */
    let fakeNow = new RealDate(RealDate.now()).setHours(10, 0, 0, 0);
    window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } };

    await go('#/metrics'); // старт не с Главной — проверяем, что первый вход тоже заводит ровно один таймер
    await go('#/home');
    await waitFor(() => $('.hh__plan'), 'плановая метка на Главной');
    check('1. вход на Главную заводит ровно один таймер метки (60 000 мс)', created.length === 1 && cleared.length === 0, `created=${created.length} cleared=${cleared.length}`);

    const heroBefore = $('.hh');
    const v0 = planRatio();
    check('2. метка видна и посчитана по plannedByNow (10:00, 07:00–23:00, цель 2600)', v0 !== null && Math.abs(v0 - Math.round(2600 * 180 / 960) / 2600) < 1e-6, String(v0));

    /* «проходит» 15 минут — вручную вызываем перехваченный колбэк таймера (имитация тика setInterval) */
    fakeNow = new RealDate(RealDate.now()).setHours(10, 15, 0, 0);
    created[0].fn();
    const v1 = planRatio();
    check('3. через 15 мин метка сместилась вперёд (план вырос, та же вода/цель)', v1 > v0, `${v0} → ${v1}`);
    check('4. обновление точечное — узел hero не пересоздан (без перерендера экрана)', $('.hh') === heroBefore);
    check('5. aria-valuetext шкалы обновился вместе с меткой', $('.hh__bar').getAttribute('aria-valuetext').includes('по плану к этому времени'));

    /* уход с Главной — таймер должен быть остановлен */
    await go('#/metrics');
    check('6. уход с Главной гасит таймер метки', cleared.length === 1 && cleared[0] === created[0].id, `cleared=${JSON.stringify(cleared)}`);

    /* повторное открытие — новый таймер, не два параллельных */
    await go('#/home');
    await waitFor(() => $('.hh__plan'), 'плановая метка после повторного открытия');
    check('7. повторное открытие Главной создаёт один новый таймер (не дублирует)', created.length === 2 && cleared.length === 1, `created=${created.length} cleared=${cleared.length}`);

    /* быстрые переходы между экранами — ни один старый таймер не должен продолжать тикать */
    await go('#/meds');
    await go('#/home');
    await go('#/tests');
    check('8. серия переходов не оставляет работающих таймеров метки', cleared.length === created.length, `created=${created.length} cleared=${cleared.length}`);
  } finally {
    window.Date = RealDate;
    window.setInterval = realSetInterval;
    window.clearInterval = realClearInterval;
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
