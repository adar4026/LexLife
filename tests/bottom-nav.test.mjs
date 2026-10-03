/* =========================================================
   tests/bottom-nav.test.mjs — нижняя плавающая капсула (js/ui/bottomNav.js,
   разметка index.html, геометрия css/styles.css).
   Активный пункт, aria-current, общий индикатор; 4 раздела с SVG без emoji;
   safe area и единый нижний отступ контента. Без браузера (минимальный DOM).
   Поведение в настоящем браузере — tests/e2e/bottom-nav.e2e.mjs.

   Запуск:  node tests/bottom-nav.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setActiveTab } from '../js/ui/bottomNav.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('css/styles.css');
const rule = (sel) => { const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)); return m ? m[1] : null; };

/* ---------- минимальный DOM ---------- */
function fakeEl(dataset = {}) {
  const classes = new Set();
  const attrs = new Map();
  const props = new Map();
  const log = [];
  return {
    dataset, attrs, props, log,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; },
    },
    setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k),
    style: {
      set transition(v) { log.push(v); }, get transition() { return log[log.length - 1] ?? ''; },
      setProperty: (k, v) => props.set(k, v),
    },
    get offsetWidth() { return 300; },
  };
}
function fakeNav() {
  const tabs = ['home', 'metrics', 'meds', 'tests'].map((route) => fakeEl({ route }));
  const ind = fakeEl();
  const nav = fakeEl();
  nav.querySelectorAll = (s) => (s === '.tab' ? tabs : []);
  nav.querySelector = (s) => (s === '.tab-bar__indicator' ? ind : null);
  return { nav, tabs, ind };
}
const active = (tabs) => tabs.filter((t) => t.classList.contains('is-active')).map((t) => t.dataset.route);

/* ---------- setActiveTab ---------- */
test('каждый из 4 разделов: один активный пункт, aria-current="page", индекс индикатора', () => {
  const { nav, tabs, ind } = fakeNav();
  ['home', 'metrics', 'meds', 'tests'].forEach((route, i) => {
    assert.equal(setActiveTab(nav, route), i);
    assert.deepEqual(active(tabs), [route]);
    tabs.forEach((t) => assert.equal(t.attrs.get('aria-current'), t.dataset.route === route ? 'page' : undefined));
    assert.equal(nav.props.get('--nav-index'), String(i));
    assert.ok(ind.classList.contains('is-ready'));
  });
});

test('первое появление индикатора — без анимации, дальнейшие переходы — через CSS transition', () => {
  const { nav, ind } = fakeNav();
  setActiveTab(nav, 'meds');
  assert.deepEqual(ind.log, ['none', ''], 'transition выключен на время первой установки и возвращён');
  setActiveTab(nav, 'tests');
  assert.deepEqual(ind.log, ['none', ''], 'обычный переход не трогает inline transition');
});

test('экран вне вкладок (null): нет активного пункта и aria-current, индикатор скрыт; возврат — без «пролёта»', () => {
  const { nav, tabs, ind } = fakeNav();
  setActiveTab(nav, 'metrics');
  assert.equal(setActiveTab(nav, null), -1);
  assert.deepEqual(active(tabs), []);
  assert.ok(tabs.every((t) => !t.attrs.has('aria-current')));
  assert.ok(!ind.classList.contains('is-ready'));
  setActiveTab(nav, 'home');
  assert.deepEqual(ind.log.slice(-2), ['none', ''], 'после скрытия появляется сразу на месте');
  assert.equal(nav.props.get('--nav-index'), '0');
});

test('без панели не падает', () => {
  assert.equal(setActiveTab(null, 'home'), -1);
});

/* ---------- разметка ---------- */
test('index.html: <nav> с aria-label, ровно 4 ссылки-раздела в нужном порядке, SVG без emoji', () => {
  const nav = html.match(/<nav class="tab-bar" id="tab-bar" aria-label="[^"]+"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'nav.tab-bar с aria-label');
  const items = [...nav[1].matchAll(/<a class="tab" href="#\/(\w+)" data-route="(\w+)">([\s\S]*?)<\/a>/g)];
  assert.deepEqual(items.map((m) => m[1]), ['home', 'metrics', 'meds', 'tests']);
  items.forEach((m) => assert.equal(m[1], m[2], 'href и data-route совпадают'));
  assert.deepEqual(items.map((m) => m[3].match(/<span class="tab__label">([^<]+)<\/span>/)[1]), ['Главная', 'Показатели', 'Лекарства', 'Анализы']);
  items.forEach((m) => assert.match(m[3], /<svg class="tab__icon" viewBox="0 0 24 24" aria-hidden="true">/));
  assert.ok(!/\p{Extended_Pictographic}/u.test(nav[1]), 'нет emoji');
  assert.equal((nav[1].match(/tab-bar__indicator/g) || []).length, 1, 'один общий индикатор');
  assert.match(nav[1], /<span class="tab-bar__indicator" aria-hidden="true"><\/span>/);
  assert.match(html, /<meta\s+name="viewport"\s+content="[^"]*viewport-fit=cover/);
});

/* ---------- геометрия и safe area ---------- */
test('styles.css: плавающая капсула на границе safe area, единый отступ контента', () => {
  assert.match(css, /--tab-h: 64px;/);
  assert.match(css, /--tab-bottom: max\(6px, var\(--safe-bottom\)\);/);
  assert.match(css, /--safe-bottom: env\(safe-area-inset-bottom, 0px\);/);
  assert.match(css, /--tab-space: calc\(var\(--tab-bottom\) \+ var\(--tab-h\) \+ 20px\);/);
  assert.match(rule('.screen'), /padding: calc\(var\(--safe-top\) \+ 12px\) 16px var\(--tab-space\);/);
  const bar = rule('.tab-bar');
  for (const re of [/position: fixed;/, /left: 14px;/, /right: 14px;/, /bottom: var\(--tab-bottom\);/, /height: var\(--tab-h\);/,
    /border-radius: 32px;/, /margin: 0 auto;/, /grid-template-columns: repeat\(var\(--nav-count, 4\), minmax\(0, 1fr\)\);/,
    /-webkit-backdrop-filter:/, /z-index: 100;/]) assert.match(bar, re);
  assert.ok(!/padding-bottom/.test(bar), 'safe area не добавляется второй раз внутрь капсулы');
  assert.ok(!/translateX\(-50%\)/.test(bar), 'центрирование без дробного transform');
  assert.match(css, /@media \(max-width: 340px\) \{\s*\.tab-bar \{ left: 12px; right: 12px; \}/);
});

test('styles.css: индикатор — transform по --nav-index, 200 ms без bounce, reduced motion', () => {
  const ind = rule('.tab-bar__indicator');
  assert.match(ind, /width: calc\(\(100% - 14px\) \/ var\(--nav-count, 4\)\);/);
  assert.match(ind, /transform: translate3d\(calc\(var\(--nav-index, 0\) \* 100%\), 0, 0\);/);
  const tr = ind.match(/transform (\d*\.?\d+)s cubic-bezier\(([^)]+)\)/);
  assert.ok(tr, 'transition transform');
  assert.ok(+tr[1] >= 0.18 && +tr[1] <= 0.22, '180–220 ms');
  assert.ok(tr[2].split(',').map(Number).every((v) => v >= 0 && v <= 1), 'кривая без выхода за 1 — без bounce');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tab-bar__indicator \{ transition: opacity 0\.18s ease; \}/);
});

test('styles.css: активное состояние не только цветом; иконки — currentColor; фокус виден', () => {
  assert.match(rule('.tab.is-active .tab__label'), /font-weight: 800;/);
  assert.match(rule('.tab.is-active .tab__icon'), /stroke-width: 2\.4;/);
  assert.match(rule('.tab__icon'), /stroke: currentColor;/);
  assert.match(rule('.tab:focus-visible'), /outline: 2px solid var\(--blue\);/);
  for (const t of ['--nav-bg', '--nav-border', '--nav-pill-bg', '--nav-muted', '--nav-shadow']) {
    assert.equal((css.match(new RegExp(`\\n\\s*${t}:`, 'g')) || []).length, 2, `${t}: тёмная и светлая тема`);
  }
});

test('app.js и sw.js: активная вкладка из resolve(), модуль в предкэше', () => {
  const app = read('js/app.js');
  assert.match(app, /import \{ setActiveTab \} from '\.\/ui\/bottomNav\.js';/);
  assert.match(app, /setActiveTab\(\$\('#tab-bar'\), tab\);/);
  assert.match(app, /if \(h\.startsWith\('test-history\/'\)\) return \{ fn: [^}]+, tab: 'tests'/, 'история показателя анализа → «Анализы»');
  assert.match(app, /if \(METRICS\[k\]\) return \{ fn: [^}]+, tab: 'metrics'/, 'история показателя → «Показатели»');
  assert.match(read('sw.js'), /'\.\/js\/ui\/bottomNav\.js',/);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL — ${name}`);
    console.error(`         ${err && err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
