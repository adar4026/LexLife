/* =========================================================
   tests/back-nav.test.mjs — единая кнопка «Назад» и учёт внутренней истории
   (js/ui/backNav.js) + статические проверки: в app.js не осталось старых вариантов
   возврата (history.back/history.length/goBackOr, «‹ Назад»), CSS кнопки, предкэш SW.
   История браузера — модель с той же семантикой, что у настоящей: переход по хешу
   создаёт запись с state = null, location.replace заменяет запись, back() уходит
   на предыдущую запись (в т.ч. на чужую страницу до LexLife). Поведение в браузере —
   tests/e2e/back-nav.e2e.mjs.

   Запуск:  node tests/back-nav.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initNavHistory, goBack, goBackTo, canGoBack, navDepth, prevRoute, replaceRoute, replaceUrl, readEntryUi, saveEntryUi, BackButton } from '../js/ui/backNav.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- модель окна: история + location + hashchange (асинхронно, как в браузере) ---------- */
function fakeWindow(urls = ['#/home'], { externalBefore = 0 } = {}) {
  const listeners = new Set();
  const entries = [];
  for (let i = 0; i < externalBefore; i++) entries.push({ url: `https://example.com/${i}`, state: null, external: true });
  urls.forEach((u) => entries.push({ url: u, state: null }));
  let idx = entries.length - 1;
  const stats = { backCalls: 0, leftApp: false };
  const fire = () => setTimeout(() => listeners.forEach((fn) => fn({ type: 'hashchange' })), 0);
  const w = {
    stats, entries,
    get idx() { return idx; },
    addEventListener: (t, fn) => { if (t === 'hashchange') listeners.add(fn); },
    removeEventListener: (t, fn) => { if (t === 'hashchange') listeners.delete(fn); },
    history: {
      get state() { return entries[idx].state; },
      get length() { return entries.length; },
      replaceState(state, _t, url) { entries[idx] = { url: url ?? entries[idx].url, state: state == null ? null : structuredClone(state) }; },
      back() {
        stats.backCalls++;
        if (idx === 0) return;
        const from = entries[idx];
        idx--;
        if (entries[idx].external) { stats.leftApp = true; return; }
        if (entries[idx].url !== from.url) fire();
      },
    },
    location: {
      get hash() { return entries[idx].url; },
      set hash(v) { if (v === entries[idx].url) return; entries.splice(idx + 1); entries.push({ url: v, state: null }); idx++; fire(); },
      replace(v) { const same = v === entries[idx].url; entries[idx] = { url: v, state: null }; if (!same) fire(); },
    },
    /* перезагрузка: state записей сохраняется, обработчики — нет */
    reload() { listeners.clear(); },
  };
  return w;
}
async function push(w, hash) { w.location.hash = hash; await tick(); }
async function back(w, fallback) { goBack(fallback); await tick(); }
/* сбросить защиту от двойного нажатия между шагами сценария (она по времени) */
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const later = () => { clock += 5000; };

/* ---------- сценарии ---------- */
test('прямое открытие внутреннего URL: истории LexLife нет → fallback заменой, без history.back', async () => {
  const w = fakeWindow(['#/test/abc'], { externalBefore: 2 });
  initNavHistory(w);
  assert.equal(navDepth(), 0);
  assert.equal(canGoBack(), false);
  await back(w, 'tests');
  assert.equal(w.stats.backCalls, 0, 'history.back() увёл бы на чужую страницу');
  assert.equal(w.stats.leftApp, false);
  assert.equal(w.location.hash, '#/tests');
  assert.equal(w.entries.length, 3, 'новой записи нет (replace)');
  assert.equal(navDepth(), 0);
});

test('A → B → назад: ровно на A, глубина 1 → 0', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/metric/water');
  assert.equal(navDepth(), 1);
  await back(w, 'metrics');
  assert.equal(w.location.hash, '#/home', 'вернулись туда, откуда пришли, а не на fallback');
  assert.equal(navDepth(), 0);
  assert.equal(w.stats.backCalls, 1);
});

test('цепочка из 4 экранов: назад проходит её в обратном порядке, затем fallback без выхода из приложения', async () => {
  later();
  const w = fakeWindow(['#/home'], { externalBefore: 1 });
  initNavHistory(w);
  for (const h of ['#/tests', '#/test/t1', '#/test-history/ldl']) await push(w, h);
  assert.equal(navDepth(), 3);
  const seen = [];
  for (let i = 0; i < 3; i++) { later(); await back(w, 'home'); seen.push(w.location.hash); }
  assert.deepEqual(seen, ['#/test/t1', '#/tests', '#/home']);
  later();
  await back(w, 'home');
  assert.equal(w.stats.leftApp, false, 'с первого экрана LexLife «Назад» не уходит на чужую страницу');
  assert.equal(w.location.hash, '#/home');
});

test('двойное нажатие: один возврат, а не два', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/calendar');
  await push(w, '#/visit/v1');
  goBack('visits');
  goBack('visits');
  await tick();
  assert.equal(w.stats.backCalls, 1);
  assert.equal(w.location.hash, '#/calendar');
});

test('после перехода защита снимается: следующий «Назад» на новом экране работает сразу', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/visits');
  await push(w, '#/visit/v1');
  await back(w, 'visits');
  await back(w, 'home');
  assert.equal(w.location.hash, '#/home');
  assert.equal(w.stats.backCalls, 2);
});

test('replaceRoute: запись заменяется, глубина та же, дубля в истории нет', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/visits');
  await push(w, '#/visit/new');
  replaceRoute('visit/v9'); // сохранили новый визит → карточка вместо формы
  await tick();
  assert.equal(w.location.hash, '#/visit/v9');
  assert.equal(navDepth(), 2);
  assert.deepEqual(w.entries.map((e) => e.url), ['#/home', '#/visits', '#/visit/v9']);
  await back(w, 'visits');
  assert.equal(w.location.hash, '#/visits', 'назад с карточки — к списку, не к пустой форме');
});

test('replaceRoute на текущий адрес — ничего не делает и не ломает следующий переход', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  replaceRoute('home');
  await tick();
  await push(w, '#/sleep');
  assert.equal(navDepth(), 1, 'следующий переход — новая запись, а не замена');
});

test('goBackTo после «Сохранить»: экран — предыдущий → назад к нему (без дубля)', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/sleep');
  await push(w, '#/sleep/new');
  assert.equal(prevRoute(), '#/sleep');
  goBackTo('sleep');
  await tick();
  assert.equal(w.location.hash, '#/sleep');
  assert.equal(w.stats.backCalls, 1);
  assert.equal(w.idx, 1, 'стоим на прежней записи «Сон», а не на её копии');
  assert.equal(prevRoute(), '#/home');
});

test('goBackTo: пришли не с этого экрана → замена формы на экран (как раньше), не history.back', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/sleep/new');
  goBackTo('sleep');
  await tick();
  assert.equal(w.stats.backCalls, 0);
  assert.deepEqual(w.entries.map((e) => e.url), ['#/home', '#/sleep']);
  assert.equal(navDepth(), 1);
  assert.equal(prevRoute(), '#/home', 'замена сохраняет «откуда пришли»');
  later();
  await back(w, 'home');
  assert.equal(w.location.hash, '#/home');
});

test('goBackTo при прямом открытии формы: замена, из приложения не уходим', async () => {
  later();
  const w = fakeWindow(['#/med/new'], { externalBefore: 1 });
  initNavHistory(w);
  goBackTo('meds');
  await tick();
  assert.equal(w.stats.backCalls, 0);
  assert.equal(w.location.hash, '#/meds');
  assert.equal(w.entries.length, 2);
});

test('перезагрузка: глубина берётся из записи истории', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/tests');
  await push(w, '#/test/t1');
  w.reload();
  initNavHistory(w);
  assert.equal(navDepth(), 2);
  assert.equal(prevRoute(), '#/tests', 'и адрес предыдущей записи');
  await back(w, 'tests');
  assert.equal(w.location.hash, '#/tests');
  assert.equal(navDepth(), 1);
});

test('replaceUrl (журнал воды меняет месяц) — без hashchange, глубина сохраняется', async () => {
  later();
  const w = fakeWindow(['#/metric/water']);
  initNavHistory(w);
  await push(w, '#/water-log');
  replaceUrl('water-log/2026-02');
  await tick();
  assert.equal(w.location.hash, '#/water-log/2026-02');
  assert.equal(navDepth(), 1);
  assert.equal(w.history.state.lexDepth, 1);
  await back(w, 'metric/water');
  assert.equal(w.location.hash, '#/metric/water');
});

test('состояние экрана живёт в его записи: «Назад» возвращает его, новый переход — по умолчанию', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/calendar');
  assert.equal(readEntryUi('calendar'), undefined);
  saveEntryUi('calendar', { mode: 'week', cursor: '2026-02-09', selected: '2026-02-14' });
  w.history.replaceState({ ...w.history.state, y: 420 }, ''); // прокрутка — в той же записи
  await push(w, '#/visit/v1');
  assert.equal(readEntryUi('calendar'), undefined, 'у новой записи своё (пустое) состояние');
  await back(w, 'visits');
  assert.deepEqual(readEntryUi('calendar'), { mode: 'week', cursor: '2026-02-09', selected: '2026-02-14' });
  assert.equal(w.history.state.y, 420);
  assert.equal(w.history.state.lexDepth, 1, 'saveEntryUi не теряет глубину');
});

test('BackButton: круглая кнопка без подписи, aria-label, свой обработчик или goBack(fallback)', async () => {
  later();
  const w = fakeWindow(['#/home']);
  initNavHistory(w);
  await push(w, '#/settings');
  const made = [];
  const doc = {
    createElement: (tag) => {
      const attrs = {}; const handlers = {};
      const n = { tag, attrs, innerHTML: '', setAttribute: (k, v) => { attrs[k] = String(v); }, addEventListener: (t, fn) => { handlers[t] = fn; }, click: () => handlers.click && handlers.click() };
      made.push(n);
      return n;
    },
  };
  const b = BackButton({ fallback: 'home', doc });
  assert.equal(b.tag, 'button');
  assert.equal(b.type, 'button');
  assert.equal(b.className, 'back-btn');
  assert.equal(b.attrs['aria-label'], 'Назад');
  assert.match(b.innerHTML, /^<svg class="back-btn__icon"[^>]*aria-hidden="true"/);
  assert.equal(b.innerHTML.replace(/<[^>]+>/g, '').trim(), '', 'видимого текста нет');
  b.click();
  b.click(); // повторный тап по той же кнопке
  await tick();
  assert.equal(w.location.hash, '#/home');
  assert.equal(w.stats.backCalls, 1);
  let custom = 0;
  later();
  const c = BackButton({ onBack: () => { custom++; }, doc });
  c.click();
  assert.equal(custom, 1);
});

/* ---------- статические проверки ---------- */
const app = read('js/app.js');
const css = read('css/styles.css');

test('app.js: старых вариантов возврата не осталось', () => {
  assert.doesNotMatch(app, /history\.back\(|history\.length|goBackOr|location\.replace\(/, 'возврат и замена — только через backNav.js');
  assert.doesNotMatch(app, /‹ \$\{|‹ Назад|class="back-btn"/, 'текстовая кнопка «‹ Назад» — заменена компонентом');
  assert.doesNotMatch(app, /label: '(Назад|Показатели|Визиты|Отмена)', onBack/, 'подписи у кнопки нет');
  assert.doesNotMatch(app, /history\.replaceState\(null/, 'replaceState не должен стирать глубину записи');
  assert.match(app, /import \{ BackButton, goBack, goBackTo, replaceRoute, replaceUrl, initNavHistory, readEntryUi, saveEntryUi \} from '\.\/ui\/backNav\.js';/);
  /* учёт истории подключается раньше роутера — глубина известна к render() */
  assert.ok(app.indexOf('initNavHistory();') > 0 && app.indexOf('initNavHistory();') < app.indexOf("window.addEventListener('hashchange', render);"));
});

test('app.js: все шапки внутренних экранов — backHeader/BackButton, жёстких переходов «назад» нет', () => {
  const headers = app.match(/backHeader\(/g).length;
  assert.ok(headers >= 25, `шапок с кнопкой: ${headers}`);
  assert.match(app, /function backHeader\(title, \{ fallback = 'home', onBack \} = \{\}\) \{\n  const h = el\(`<header class="header header--nav">/);
  assert.match(app, /header\.prepend\(BackButton\(\{ fallback: 'home' \}\)\)/, 'экран «Сон» со своей шапкой — тот же компонент');
  assert.doesNotMatch(app, /onBack: \(\) => \{ location\.hash/, '«назад» не создаёт новую запись истории');
  assert.doesNotMatch(app, /location\.hash = '#\/visits'/, 'удаление визита — возврат, а не дубль списка');
  assert.doesNotMatch(app, /location\.hash = `#\/visit\/\$\{(id|created\.id)\}`/, 'сохранение визита — возврат/замена, а не новая запись поверх формы');
});

test('CSS: круг 52–56px, зона касания ≥ 44, не fixed, токены обеих тем', () => {
  const block = css.match(/\n\.back-btn \{([^}]*)\}/)[1];
  const size = Number(block.match(/--back-size: (\d+)px/)[1]);
  assert.ok(size >= 52 && size <= 56, `размер ${size}`);
  assert.match(block, /border-radius: 50%/);
  assert.match(block, /border: 1px solid var\(--back-border\)/);
  assert.doesNotMatch(block, /position: fixed/);
  assert.match(css, /@media \(max-height: 700px\) \{ \.back-btn \{ --back-size: 52px;/);
  assert.match(css, /\[data-theme="light"\] \{\n  --back-bg: #ffffff;/);
  assert.match(css, /:root \{\n  --back-bg: #1c232c;/);
  assert.match(css, /\.header--nav \{ padding-top: 0; \}/);
});

test('sw.js: backNav.js в предкэше (офлайн)', () => {
  assert.match(read('sw.js'), /'\.\/js\/ui\/backNav\.js',/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
Date.now = realNow;
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
