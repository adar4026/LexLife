/* =========================================================
   tests/e2e/home.e2e.mjs — сквозная проверка плановой метки на шкале воды Главной:
   положение метки действительно обновляется раз в минуту (без перерендера экрана),
   и таймер этого обновления не утекает — гасится при уходе с Главной, не дублируется
   при повторном открытии. Подписи шкалы: «Осталось» — в строке цели, под шкалой справа —
   отклонение от того же плана (отстаёте / опережаете / по плану в пределах ±50 мл), обновляется с меткой;
   обе строки помещаются в одну линию на ширине экрана, где запущен тест.

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
const txt = (s) => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim(); // ru-RU: 1 700 с неразрывным пробелом
/* строка в одну линию: дети на одной высоте и ничего не выходит за ширину строки */
const oneLine = (s) => {
  const row = $(s);
  const kids = [...row.children].filter((k) => k.textContent.trim());
  const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2));
  const clipped = kids.some((k) => k.scrollWidth > k.clientWidth + 1);
  return kids.length === 2 && Math.abs(tops[0] - tops[1]) <= 2 && row.scrollWidth <= row.clientWidth + 1 && !clipped;
};

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

    /* подписи: 900 / 2600; план к 10:15 = round(2600 × 195 / 960) = 528 → +372 */
    check('5a. «Осталось» в строке цели: «воды из 2 600 мл» + «Осталось: 1 700 мл»', txt('.hh__goal') === 'воды из 2 600 мл' && txt('.hh__left') === 'Осталось: 1 700 мл' && !$('.hh__meta').textContent.includes('Осталось'), `${txt('.hh__goal')} | ${txt('.hh__left')}`);
    check('5b. опережение: «+372 мл · опережаете», зелёный, число жирнее', txt('.hh__dev') === '+372 мл · опережаете' && $('.hh__dev').classList.contains('hh__dev--ahead') && txt('.hh__dev b') === '+372 мл' && Number(getComputedStyle($('.hh__dev b')).fontWeight) > Number(getComputedStyle($('.hh__dev')).fontWeight), txt('.hh__dev'));
    check('5c. слева под шкалой — «35% от цели»', txt('.hh__pct') === '35% от цели', txt('.hh__pct'));
    check(`5d. обе строки в одну линию при ширине ${innerWidth}px`, oneLine('.hh__caption') && oneLine('.hh__meta'));

    /* время идёт дальше без перезагрузки: 14:00 → план 1138 → −238, метка правее заливки */
    fakeNow = new RealDate(RealDate.now()).setHours(14, 0, 0, 0);
    created[0].fn();
    const ahead = getComputedStyle($('.hh__dev')).color;
    check('5e. отставание после тика таймера: «−238 мл · отстаёте», красный — цвет метки', txt('.hh__dev') === '−238 мл · отстаёте' && $('.hh__dev').classList.contains('hh__dev--behind') && getComputedStyle($('.hh__dev')).color === getComputedStyle($('.hh__plan')).backgroundColor && $('.hh') === heroBefore, `${txt('.hh__dev')} ${ahead}`);
    check('5f. «Осталось» от времени не зависит', txt('.hh__left') === 'Осталось: 1 700 мл');
    check(`5g. после смены текста строка всё ещё в одну линию при ширине ${innerWidth}px`, oneLine('.hh__meta'));

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

    /* точное попадание: цель 2400, 13:00 → план round(2400 × 360 / 960) = 900 = выпито */
    await Storage.setWaterGoal(2400);
    fakeNow = new RealDate(RealDate.now()).setHours(13, 0, 0, 0);
    await go('#/home');
    await waitFor(() => $('.hh__dev'), 'отклонение на Главной');
    check('9. точно по плану: «По плану», нейтральный цвет; «Осталось: 1 500 мл»', txt('.hh__dev') === 'По плану' && $('.hh__dev').classList.contains('hh__dev--onPlan') && getComputedStyle($('.hh__dev')).color === getComputedStyle($('.hh__goal')).color && txt('.hh__left') === 'Осталось: 1 500 мл', `${txt('.hh__dev')} | ${txt('.hh__left')}`);
    /* допуск ±50 мл — только для текста; метка по-прежнему точно по plannedByNow */
    const tick = (h, m) => { fakeNow = new RealDate(RealDate.now()).setHours(h, m, 0, 0); created[created.length - 1].fn(); };
    tick(13, 1); // план round(2400 × 361 / 960) = 903 → −3
    check('10. через минуту без перезагрузки: −3 мл в пределах допуска → всё ещё «По плану»; метка точная', txt('.hh__dev') === 'По плану' && Math.abs(planRatio() - 903 / 2400) < 1e-6, `${txt('.hh__dev')} ${planRatio()}`);
    tick(13, 21); // план round(2400 × 381 / 960) = 953 → −53
    check('10a. 13:21: −53 мл → «−53 мл · отстаёте», красный', txt('.hh__dev') === '−53 мл · отстаёте' && $('.hh__dev').classList.contains('hh__dev--behind'), txt('.hh__dev'));
    tick(12, 40); // план 850 → +50 (граница)
    check('10b. 12:40: +50 мл — граница допуска → «По плану»', txt('.hh__dev') === 'По плану' && $('.hh__dev').classList.contains('hh__dev--onPlan'), txt('.hh__dev'));
    tick(12, 39); // план 848 → +52
    check('10c. 12:39: +52 мл → «+52 мл · опережаете», зелёный', txt('.hh__dev') === '+52 мл · опережаете' && $('.hh__dev').classList.contains('hh__dev--ahead'), txt('.hh__dev'));

    /* цель выполнена: «✓ Выполнено · +100 мл» в строке цели, тоже в одну линию */
    await Storage.setWaterGoal(800);
    await go('#/metrics');
    await go('#/home');
    await waitFor(() => $('.hh__left--done'), 'цель выполнена');
    check(`11. цель выполнена: «Выполнено · +100 мл» в строке цели, одна линия при ${innerWidth}px`, txt('.hh__left') === 'Выполнено · +100 мл' && oneLine('.hh__caption'), txt('.hh__left'));
    await Storage.setWaterGoal(2600);
    localStorage.setItem('metrics_log', JSON.stringify({ ...JSON.parse(localStorage.getItem('metrics_log') || '{}'), water: { [today]: { total: 3800, entries: [{ t: '08:00', ml: 3800 }] } } }));
    await go('#/metrics');
    await go('#/home');
    await waitFor(() => $('.hh__left--done'), 'цель выполнена, 3 800 / 2 600');
    check(`11a. самый длинный вариант «воды из 2 600 мл · ✓ Выполнено · +1 200 мл» — одна линия при ${innerWidth}px`, txt('.hh__left') === 'Выполнено · +1 200 мл' && oneLine('.hh__caption'), txt('.hh__left'));
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
