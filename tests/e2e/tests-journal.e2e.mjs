/* =========================================================
   tests/e2e/tests-journal.e2e.mjs — сквозная проверка журнала анализов и
   «Документ анализа» в настоящем браузере (открытое приложение LexLife).

   Только на localhost (отдельный origin с синтетическими данными): на любом
   другом адресе сценарий сразу останавливается. Перед запуском сохраняет
   анализы этого origin, после — возвращает их и удаляет свои документы.

   Запуск (в консоли открытого http://localhost:4173/):
     const m = await import('/tests/e2e/tests-journal.e2e.mjs'); await m.run();
   run({ keep: true }) — оставить синтетические данные (для скриншотов).
   ========================================================= */

import Storage, { KEYS } from '../../js/services/storage.js';
import { AttachmentService, IdbAttachmentStore } from '../../js/services/attachments.js';
import { makeTestPdf } from '../helpers/syntheticPdf.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 8000) {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
    await sleep(50);
  }
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function go(hash) {
  location.hash = hash;
  await waitFor(() => location.hash === hash, `адрес ${hash}`);
  await sleep(250);
}
async function pngFile() {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#e8f0fe'; g.fillRect(0, 0, 600, 400);
  g.fillStyle = '#1a73e8'; g.font = 'bold 40px sans-serif'; g.fillText('Synthetic photo', 120, 210);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], 'synthetic-photo.png', { type: 'image/png' });
}
const lab = (group, name, value, unit, ref, refLow, refHigh) => ({ group, name, value, unit, ref, ...(refLow != null ? { refLow, refHigh } : {}) });

export async function run({ keep = false } = {}) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('e2e запускается только на localhost с синтетическими данными');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail); };
  const Attachments = new AttachmentService(Storage, new IdbAttachmentStore());
  const savedTests = localStorage.getItem(KEYS.tests);
  const created = [];
  const origOpen = window.open;
  const origShare = navigator.share;
  const origCanShare = navigator.canShare;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  try {
    /* ---------- синтетические данные ---------- */
    localStorage.setItem(KEYS.tests, '[]');
    const add = async (t) => { const e = await Storage.addTest(t); created.push(e.id); return e; };
    for (let i = 0; i < 10; i++) await add({ date: `2023-${String(i + 1).padStart(2, '0')}-10`, hgb: 13 + i / 10 });
    const may = await add({ date: '2025-05-03', hgb: 14.2, hct: 43 });
    const oct = await add({ date: '2025-10-15', chol: 205, ldl: 128, hdl: 52, trig: 140, customResults: [lab('Гематология', 'Лейкоциты', 6.1, 'x10³/mm³', '4.00–11.00', 4, 11)] });
    const janA = await add({
      date: '2026-02-14', chol: 190, ldl: 110, glucose: 92, vitd: 31, hgb: 15.1,
      labRanges: { ldl: '0.00–116.00' },
      customResults: [
        lab('Гематология', 'Лейкоциты', 3.4, 'x10³/mm³', '4.00–11.00', 4, 11),
        lab('Гематология', 'Тромбоциты', 250, 'x10³/mm³', '150–400', 150, 400),
        lab('Биохимия', 'Креатинин', 0.92, 'mg/dL', '0.70–1.20', 0.7, 1.2),
        lab('Биохимия', 'ALT / GPT', 24, 'UI/L', '0–41', 0, 41),
        lab('Витамины', 'Витамин B12', 420, 'pg/mL', '197–771', 197, 771),
        lab('Прочее', 'Синтетический показатель', 7, 'ед.', 'см. бланк'),
      ],
    });
    const janB = await add({ date: '2026-02-14', vitd: 35, customResults: [lab('Гематология', 'Лейкоциты', 5.2, 'x10³/mm³', '4.00–11.00', 4, 11)] });
    await Attachments.attachToTest(janA.id, new File([makeTestPdf(3)], 'synthetic-3-pages.pdf', { type: 'application/pdf' }));
    await Attachments.attachToTest(janB.id, await pngFile());

    /* ---------- 1–3. список ---------- */
    await go('#/home');
    await go('#/tests');
    window.scrollTo(0, 0);
    const rows = () => $$('.tj-row');
    await waitFor(() => rows().length === 14, 'строки журнала');
    const order = rows().map((r) => r.dataset.id);
    check('1. новый анализ вверху, старые ниже', order[0] === janB.id && order[1] === janA.id && order[2] === oct.id && order[3] === may.id, order.slice(0, 4).join(','));
    check('3. два анализа в одну дату — две строки с номерами', $('.tj-row__no', rows()[0])?.textContent === 'Анализ № 2' && $('.tj-row__no', rows()[1])?.textContent === 'Анализ № 1');
    check('2. в строке нет длинных показателей', !$('.test-value, .test-values, .tv-row', $('.tj-list')));
    check('заголовки годов', $$('.tj-year__title').map((h) => h.textContent).join(',') === '2026,2025,2023');
    check('описание групп', $('.tj-row__groups', rows()[1]).textContent === 'Гематология · Биохимия · Витамины · Прочее · Липиды · Сахар и метаболизм' && $('.tj-row__groups', rows()[2]).textContent === 'Гематология · Липиды', $('.tj-row__groups', rows()[1]).textContent);
    check('«Без документа» у записи без файла', $('.tj-doc--none', rows()[2])?.textContent === 'Без документа');
    check('блок PDF: имя, тип, размер', /PDF/.test($('.tj-doc__badge', rows()[1]).textContent) && $('.tj-doc__name', rows()[1]).textContent === 'synthetic-3-pages.pdf' && /КБ|Б/.test($('.tj-doc__meta', rows()[1]).textContent));
    check('нет «Изменить»/«Удалить» в списке', !$$('button', $('.tj-list')).some((b) => /Изменить|Удалить/.test(b.textContent)));

    /* ---------- 9. фильтр по годам ---------- */
    const yearBtn = (y) => $(`.tj-filter [data-year="${y}"]`);
    check('фильтр: по умолчанию «Все»', yearBtn('all')?.classList.contains('is-active'));
    yearBtn('2025').click();
    await waitFor(() => rows().length === 2, 'фильтр 2025');
    check('фильтр 2025', rows().map((r) => r.dataset.id).join() === [oct.id, may.id].join());
    yearBtn('all').click();
    await waitFor(() => rows().length === 14, 'фильтр «Все»');

    /* ---------- 5. PDF в строке открывает документ, не анализ ---------- */
    let live = 0;
    URL.createObjectURL = function (b) { live += 1; return origCreate.call(URL, b); };
    URL.revokeObjectURL = function (u) { live -= 1; return origRevoke.call(URL, u); };
    const opened = [];
    window.open = (u) => { opened.push(u); return {}; };
    const shared = [];
    navigator.share = async (d) => { shared.push(d); };
    navigator.canShare = () => true;

    $('.tj-doc', rows()[1]).click();
    const v = await waitFor(() => $('.docv'), 'просмотр документа');
    check('5. нажатие на PDF открывает документ, адрес не меняется', location.hash === '#/tests' && !!v);
    /* ---------- 6. все страницы ---------- */
    await waitFor(() => $$('.docv__page').length === 3, '3 страницы');
    await waitFor(() => $('.docv__page[data-page="1"] canvas'), 'страница 1 нарисована');
    check('6. многостраничный PDF: 3 страницы, счётчик «1 / 3»', $('.docv__pages').textContent === '1 / 3');
    const body = $('.docv__body');
    body.scrollTop = body.scrollHeight;
    await waitFor(() => $('.docv__pages').textContent === '3 / 3', 'счётчик 3 / 3');
    await waitFor(() => $('.docv__page[data-page="3"] canvas'), 'страница 3 нарисована');
    check('6. последняя страница показана, счётчик «3 / 3»', true);
    const c3 = $('.docv__page[data-page="3"] canvas');
    check('страница нарисована (canvas не пустой)', c3.width > 300 && c3.height > 400, `${c3.width}×${c3.height}`);
    /* масштаб */
    const w0 = $('.docv__page').getBoundingClientRect().width;
    $('[data-act="zoom-in"]').click();
    await sleep(100);
    check('масштаб «+» увеличивает страницы', $('.docv__page').getBoundingClientRect().width > w0 * 1.4 && $('.docv__zoomval').textContent === '150%');
    $('[data-act="zoom-out"]').click();
    /* ---------- 7. открыть отдельно / поделиться ---------- */
    $('.docv [data-act="open"]').click();
    const blobUrl = opened[0];
    const res = blobUrl ? await fetch(blobUrl) : null;
    const blob = res ? await res.blob() : null;
    check('7. «Открыть отдельно» — Blob URL документа (PDF целиком)', !!blob && blob.type === 'application/pdf' && blob.size === makeTestPdf(3).length);
    $('.docv [data-act="share"]').click();
    await sleep(20);
    check('7. «Поделиться» — системное меню с файлом PDF', shared.length === 1 && shared[0].files?.[0]?.name === 'synthetic-3-pages.pdf' && shared[0].files[0].type === 'application/pdf');
    /* ---------- 8. закрытие ---------- */
    $('.docv [data-act="close"]').click();
    await sleep(50);
    check('8. после закрытия просмотр убран, Blob URL освобождены', !$('.docv') && live === 0, `живых URL: ${live}`);
    let revokedAfter = false;
    try { await fetch(blobUrl); } catch { revokedAfter = true; }
    check('8. Blob URL после закрытия недоступен', revokedAfter);
    check('после закрытия прокрутка страницы разблокирована', !document.body.classList.contains('is-scroll-locked'));

    /* фото: полноэкранно, масштаб */
    $('.tj-doc', rows()[0]).click();
    await waitFor(() => $('.docv__img') && $('.docv__img').complete && $('.docv__img').naturalWidth > 0, 'фото загружено');
    $('[data-act="zoom-in"]').click();
    check('фото: полноэкранно, масштаб «+»', /scale\(1\.5\)/.test($('.docv__img').style.transform));
    history.back(); // «Назад» закрывает просмотр
    await sleep(300);
    check('«Назад» закрывает просмотр фото', !$('.docv') && live === 0, `живых URL: ${live}`);
    if (location.hash !== '#/tests') await go('#/tests');

    /* запасной вариант: повреждённый PDF */
    const { openDocViewer } = await import('../../js/ui/docViewer.js');
    const bad = openDocViewer(new File([new TextEncoder().encode('%PDF-1.4\nnot really a pdf')], 'broken.pdf', { type: 'application/pdf' }));
    await bad.ready;
    check('повреждённый PDF — сообщение и «Открыть отдельно»/«Поделиться»', !!$('.docv__msg') && !!$('.docv__msg [data-act="open"]') && !!$('.docv__msg [data-act="share"]'));
    bad.close();
    check('после запасного варианта Blob URL освобождены', live === 0, `живых URL: ${live}`);

    /* ---------- 4. строка → полный анализ; «Назад» — на прежнее место ---------- */
    await waitFor(() => rows().length === 14, 'журнал');
    const target = rows()[9];
    target.scrollIntoView({ block: 'center' });
    await sleep(400);
    const yBefore = window.scrollY;
    $('.tj-row__groups', target).click();
    await waitFor(() => location.hash.startsWith('#/test/') && $('.tv'), 'полный анализ');
    check('4. нажатие на строку открывает полный анализ', /^Анализ от /.test($('.header__title').textContent) && window.scrollY < 5, `scrollY=${window.scrollY}`);
    $('.back-btn').click();
    await waitFor(() => location.hash === '#/tests' && rows().length === 14, 'назад к списку');
    await sleep(150);
    check('«Назад» — к списку, в прежнее место прокрутки', Math.abs(window.scrollY - yBefore) < 4 && yBefore > 100, `было ${yBefore}, стало ${window.scrollY}`);

    /* ---------- полный анализ ---------- */
    await go(`#/test/${janA.id}`);
    const titles = $$('.tv-sec .section__title').map((h) => h.textContent);
    check('разделы полного анализа', titles.join('|') === 'Липиды|Сахар и метаболизм|Печень и почки|Железо и витамины|Гематология|Другие показатели', titles.join('|'));
    check('шапка «Анализ от 14 февр. 2026 г.» и номер в дате', $('.header__title').textContent === 'Анализ от 14 февр. 2026 г.' && /№ 1 из 2/.test($('.tv-sub').textContent));
    check('пользовательский показатель сохранён и показан', $$('.tv-row__name').some((n) => n.textContent === 'Синтетический показатель'));
    const leuk = $$('.tv-row').find((r) => $('.tv-row__name', r).textContent === 'Лейкоциты');
    check('строка: значение, единица, референс, отметка', /3,4/.test(leuk.textContent) && /x10³\/mm³/.test(leuk.textContent) && /4\.00–11\.00/.test(leuk.textContent) && /↓/.test(leuk.textContent));
    check('«Изменить» и «Удалить анализ» — на экране анализа', !!$('.tv-actions [data-act="edit"]') && !!$('.tv-actions [data-act="delete"]'));
    check('блок документа на экране анализа', $('.tv-doc__name')?.textContent === 'synthetic-3-pages.pdf');
    $('.tv-doc').click();
    await waitFor(() => $$('.docv__page').length === 3, 'PDF с экрана анализа');
    $('.docv [data-act="close"]').click();
    await sleep(50);
    check('PDF с экрана анализа: закрыт без утечек', !$('.docv') && live === 0);

    /* ---------- история показателя и график ---------- */
    leuk.click();
    await waitFor(() => location.hash.startsWith('#/test-history/'), 'история показателя');
    await sleep(200);
    check('история показателя: 3 значения (2 даты) и график', $$('.tv-row').length === 3 && !!$('.st-card svg'), $('.header__title').textContent);
    history.back();
    await waitFor(() => location.hash === `#/test/${janA.id}`, 'назад к анализу');

    /* ---------- изменение сохраняет пользовательские показатели ---------- */
    await sleep(200);
    $('.tv-actions [data-act="edit"]').click();
    await waitFor(() => location.hash.endsWith('/edit') && $('#f-note'), 'форма изменения');
    $('#f-note').value = 'синтетическая заметка';
    $('.test-form .btn-primary').click();
    await waitFor(() => location.hash === `#/test/${janA.id}` && $('.tv-note'), 'сохранено');
    const saved = await Storage.getTest(janA.id);
    check('«Изменить»: заметка сохранена, показатели лаборатории и документ на месте', saved.note === 'синтетическая заметка' && saved.customResults.length === 6 && saved.attachments.length === 1);

    /* ---------- новый анализ через форму ---------- */
    await go('#/tests');
    $('.tj-add').click();
    await waitFor(() => location.hash === '#/test/new' && $('#f-date'), 'форма нового анализа');
    $('#f-date').value = '2026-09-29';
    $('[data-field="chol"]').value = '181';
    $('.test-form .btn-primary').click();
    await waitFor(() => location.hash === '#/tests' && rows().length === 15, 'новый в списке');
    const newest = (await Storage.getTests())[0];
    created.push(newest.id);
    check('новый анализ через форму — первым в списке', rows()[0].dataset.id === newest.id && newest.date === '2026-09-29');

    /* ---------- удаление только своей записи ---------- */
    await go(`#/test/${newest.id}`);
    $('.tv-actions [data-act="delete"]').click();
    await waitFor(() => $('.dialog'), 'диалог удаления');
    $$('.dialog button').find((b) => b.textContent === 'Удалить').click();
    await waitFor(async () => !(await Storage.getTest(newest.id)), 'удалено');
    check('удаление: остальные записи на месте', (await Storage.getTests()).length === 14);
  } catch (err) {
    check('сценарий выполнен без исключений', false, String(err && err.stack || err));
  } finally {
    window.open = origOpen;
    navigator.share = origShare;
    navigator.canShare = origCanShare;
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    document.querySelector('.docv [data-act="close"]')?.click();
    if (!keep) {
      for (const id of created) await Attachments.deleteTest(id).catch(() => {});
      if (savedTests == null) localStorage.removeItem(KEYS.tests); else localStorage.setItem(KEYS.tests, savedTests);
      location.hash = '#/tests';
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} проверок пройдено`);
  return { passed: results.length - failed.length, total: results.length, failed, results };
}
