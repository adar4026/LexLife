/* =========================================================
   tests/e2e/pwa-update.e2e.mjs — реальное обновление установленной PWA в браузере.
   Не мок: настоящий Chrome (headless, отдельный профиль), настоящий Service Worker,
   настоящие сборки (scripts/build-assets.mjs, как для deploy), сервер с заголовками
   и CSP production Worker'а (worker/headers.js). Сервер подменяет сборку «на лету»,
   профиль браузера при этом не закрывается — как deploy при установленной PWA.

   Цепочка (каждая сборка — свой CACHE_VERSION и SHA, в app.js метка __E2E_BUILD):
     A  — прежняя production-сборка (--from, по умолчанию 665112a = v56): код БЕЗ протокола
          обновления → перевести вкладку может только новый SW (navigate);
     A→B — «пользователь открыл приложение»: документ приходит из старого кэша, новый SW
          ставится и переводит вкладку — ровно одна автоматическая перезагрузка;
     B→C — приложение открыто, возврат на передний план (visibilitychange): вкладка сама
          спрашивает сервер, получает новую версию и перезагружается один раз;
     C→D — новая версия выходит, пока открыта форма с введённым текстом: перезагрузки нет,
          текст на месте; после ухода с формы — одна перезагрузка;
     D   — тишина, переходы по экранам, повтор сообщения той же версии, перезапуск
          вкладки: ни одной лишней перезагрузки.
   На каждом шаге: какой код реально выполняется, версия SW, build-info, кэши,
   и снимок пользовательских данных (localStorage, IndexedDB, push) — без изменений.

   Запуск:  node tests/e2e/pwa-update.e2e.mjs [--from <git-ref>] [--keep]
   Нужен Google Chrome. Только синтетические данные во временном профиле.
   ========================================================= */

import { spawn, execFileSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSecurityHeaders } from '../../worker/headers.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FROM = argOf('--from', '665112a');
const KEEP = args.includes('--keep');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const FILES = ['index.html', 'manifest.json', 'build-info.json', 'sw.js', 'css', 'js', 'icons', 'scripts'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} — ${name}${detail ? ` · ${detail}` : ''}`);
};

/* ---------- сборки ---------- */
const TMP = mkdtempSync(join(tmpdir(), 'lexlife-pwa-update-'));
function makeBuild(label, ref, sha) {
  const src = join(TMP, `src-${label}`);
  mkdirSync(src);
  if (ref) execSync(`git archive ${ref} ${FILES.join(' ')} | tar -x -C "${src}"`, { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
  else for (const f of FILES) cpSync(join(REPO, f), join(src, f), { recursive: true });
  execFileSync(process.execPath, [join(src, 'scripts/build-assets.mjs')], {
    cwd: src, env: { ...process.env, WORKERS_CI_COMMIT_SHA: sha, WORKERS_CI_BRANCH: `e2e-${label}` }, stdio: 'ignore',
  });
  const dist = join(src, 'dist');
  appendFileSync(join(dist, 'js/app.js'), `\nglobalThis.__E2E_BUILD = '${label}';\n`); // какой код реально выполняется
  const info = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'));
  return { label, dist, sha: info.sha, cache: info.cache, ref: ref || 'working tree' };
}

/* ---------- сервер как production Worker ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
let current = null;
const hits = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/index.html') p = '/index.html';
  hits.push({ build: current && current.label, path: p });
  const file = join(current.dist, p);
  if (p.startsWith('/api/') || !file.startsWith(current.dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  const body = readFileSync(file);
  const etag = `"${createHash('md5').update(body).digest('hex')}"`;
  const headers = {
    'Content-Type': TYPES[extname(p)] || 'application/octet-stream',
    'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=0, must-revalidate', // как worker/index.js + Static Assets
    ETag: etag,
  };
  const r = withSecurityHeaders(new Response(null, { headers }));
  const out = Object.fromEntries(r.headers.entries());
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, out); res.end(); return; }
  res.writeHead(200, out);
  res.end(body);
});

/* ---------- CDP ---------- */
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Set();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

async function launchChrome() {
  const profile = join(TMP, 'profile');
  const proc = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { proc, cdp: new Cdp(ws) };
}

/* Вкладка: документ-загрузки (настоящие) и переходы внутри документа (hash) */
async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = { targetId, sessionId, loads: [], hashNavs: [], send: (m, p) => cdp.send(m, p, sessionId) };
  cdp.handlers.add((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId && m.params.frame.url.startsWith('http')) tab.loads.push({ url: m.params.frame.url + (m.params.frame.urlFragment || ''), at: Date.now() }); // url — без фрагмента, он отдельно
    if (m.method === 'Page.navigatedWithinDocument') tab.hashNavs.push(m.params.url);
  });
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  /* iPhone: размеры, UA, standalone (как PWA с экрана «Домой») */
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await tab.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  try { await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] }); } catch { /* старый Chrome */ }
  await tab.send('Page.navigate', { url });
  return tab;
}
async function evaluate(tab, body) {
  const r = await tab.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}
/* во время перезагрузки контекст исчезает — повторяем */
async function waitFor(tab, body, what, timeout = 25000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await evaluate(tab, body); if (v) return v; } catch { /* документ меняется */ }
    if (Date.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
    await sleep(100);
  }
}
const build = (tab) => evaluate(tab, 'return globalThis.__E2E_BUILD || null').catch(() => null);
/* версия активного SW: новый отвечает на lexlife:version; старый (v56 и раньше) молчит → null */
const swVersion = (tab) => evaluate(tab, `
  const c = navigator.serviceWorker.controller; if (!c) return null;
  return await new Promise((res) => { const ch = new MessageChannel(); const t = setTimeout(() => res(null), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data && e.data.version); }; c.postMessage({ type: 'lexlife:version' }, [ch.port2]); });`);
const cacheNames = (tab) => evaluate(tab, 'return (await caches.keys()).sort()');
const pageBuildInfo = (tab) => evaluate(tab, "return (await (await fetch('build-info.json')).json()).sha");

/* Разделы, которые новая версия добавляет при первом запуске (аддитивно, без смены схемы):
   шаги / велосипед и отметка переноса старой «Активности» (services/activity.js) */
const ADDITIVE_KEYS = ['steps_log', 'bike_log', 'activity_migration', 'waist_log', 'workouts_log', 'workouts_migration'];
/* Прежние данные байт-в-байт; новых ключей — только из ADDITIVE_KEYS; IndexedDB и push — как были */
function sameExceptAdditive(nextJson, prevJson) {
  const a = JSON.parse(nextJson), b = JSON.parse(prevJson);
  const added = Object.keys(a.localStorage).filter((k) => !(k in b.localStorage));
  return Object.keys(b.localStorage).every((k) => a.localStorage[k] === b.localStorage[k])
    && added.every((k) => ADDITIVE_KEYS.includes(k))
    && JSON.stringify(a.indexedDB) === JSON.stringify(b.indexedDB) && a.push === b.push && a.scope === b.scope;
}
const addedKeys = (nextJson, prevJson) => Object.keys(JSON.parse(nextJson).localStorage).filter((k) => !(k in JSON.parse(prevJson).localStorage));

/* Снимок пользовательских данных: весь localStorage, все базы IndexedDB, push-подписка */
const snapshot = (tab) => evaluate(tab, `
  const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
  const ser = async (v) => {
    if (v instanceof Blob) return { blob: await v.text(), size: v.size, type: v.type };
    if (Array.isArray(v)) return Promise.all(v.map(ser));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = await ser(v[k]); return o; }
    return v;
  };
  const idb = {};
  for (const { name } of (indexedDB.databases ? await indexedDB.databases() : []).sort((a, b) => a.name.localeCompare(b.name))) {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const stores = {};
    for (const s of [...db.objectStoreNames].sort()) {
      stores[s] = await ser(await new Promise((res, rej) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));
    }
    idb[name] = { version: db.version, stores }; db.close();
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return JSON.stringify({ localStorage: Object.fromEntries(Object.entries(ls).sort()), indexedDB: idb, push: sub ? sub.endpoint : null, scope: reg ? reg.scope : null });`);

/* ---------- сценарий ---------- */
async function main() {
  console.log(`сборки во ${TMP}`);
  const A = makeBuild('A', FROM, 'a'.repeat(40));
  const B = makeBuild('B', null, 'b'.repeat(40));
  const C = makeBuild('C', null, 'c'.repeat(40));
  const D = makeBuild('D', null, 'd'.repeat(40));
  const E = makeBuild('E', null, 'e'.repeat(40));
  const F = makeBuild('F', null, 'f'.repeat(40));
  const ALL = [A, B, C, D, E, F];
  for (const b of ALL) console.log(`  ${b.label}: ${b.ref} → ${b.cache}`);
  check('у всех сборок разные CACHE_VERSION', new Set(ALL.map((b) => b.cache)).size === ALL.length, ALL.map((b) => b.cache).join(' · '));

  current = A;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const { proc, cdp } = await launchChrome();
  try {
    /* ===== A: прежняя версия установлена и работает ===== */
    let tab = await openTab(cdp, `${ORIGIN}/#/home`);
    await waitFor(tab, 'return !!navigator.serviceWorker.controller', 'SW сборки A управляет вкладкой');
    check('A: работает код A, SW A активен', (await build(tab)) === 'A' && (await cacheNames(tab)).includes(A.cache), (await cacheNames(tab)).join(', '));

    /* синтетические данные — через StorageService самой сборки A */
    const seeded = await evaluate(tab, `
      const S = (await import('/js/services/storage.js')).default;
      const { dateKey } = await import('/js/services/storage.js');
      const { normalizeSleepInput } = await import('/js/services/sleep.js');
      const { normalizeMedInput } = await import('/js/services/meds.js');
      const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dateKey(d); };
      await S.setWaterGoal(2600);
      await S.addWaterEntry(500, day(0), '08:30'); await S.addWaterEntry(300, day(0), '11:15'); await S.addWaterEntry(1800, day(-1), '12:00');
      await S.setMetricValue('weight', 72.4, day(-2)); await S.setMetricValue('weight', 72.1, day(0));
      await S.setMetricValue('pressure', { systolic: 118, diastolic: 76 }, day(0)); await S.setMetricValue('pulse', 64, day(0));
      await S.setHydration({ wakeStart: '07:00', wakeEnd: '23:00', slotMinutes: 90 });
      await S.setProfile({ name: 'E2E Синтетика' });
      const sl = normalizeSleepInput({ bedDate: day(-1), bedTime: '23:10', wakeDate: day(0), wakeTime: '07:05', quality: 4, awakenings: 1, tags: [], note: 'e2e' });
      await S.addSleepEntry(sl.value);
      const med = normalizeMedInput({ name: 'E2E Витамин D', dose: '1 капсула', mode: 'daily', times: ['09:00'] });
      await S.addMed(med.value);
      const rules = await S.getNotifications(); if (rules[0]) await S.updateNotification(rules[0].id, { enabled: !rules[0].enabled });
      /* IndexedDB: отдельная база-проба с Blob — показать, что обновление её не трогает */
      await new Promise((res, rej) => { const r = indexedDB.open('lexlife-e2e-probe', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv', { keyPath: 'id' });
        r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ id: 1, note: 'проба', file: new Blob(['%PDF-e2e'], { type: 'application/pdf' }) }); tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
        r.onerror = () => rej(r.error); });
      /* чужой кэш origin — новый SW не должен его удалять */
      await (await caches.open('e2e-unrelated')).put('/e2e-probe', new Response('probe'));
      /* push-подписка: в headless Chrome сервиса push может не быть — фиксируем как есть */
      let push = 'нет';
      try { const reg = await navigator.serviceWorker.ready; const key = 'BLy1I-G7yb3M-h5FQNIJDwiFzgmp1tBIC_HGC3xk8KfOHiG4K03bQxSWlvoMqp0yo9y0gF69kAMyatmCPilJ28I';
        const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/')); const u8 = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8 }); push = sub.endpoint.slice(0, 40); } catch (e) { push = 'недоступна: ' + e.name; }
      return { keys: Object.keys(localStorage).length, push };`);
    check('синтетические данные созданы (вода, вес, давление, пульс, сон, лекарство, напоминание, профиль, IDB)', seeded.keys > 5, `ключей localStorage: ${seeded.keys}; push: ${seeded.push}`);

    await tab.send('Page.reload', {});
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'A' && document.querySelector('#screen').children.length > 0", 'перезапуск на A');
    let snap0 = await snapshot(tab);
    check('A: снимок данных до обновления снят', snap0.length > 200, `${Math.round(snap0.length / 1024)} КБ`);

    /* исходная проблема: hash-навигация на открытом документе остаётся на загруженном коде */
    let loads0 = tab.loads.length;
    for (const h of ['#/metric/water', '#/meds', '#/home']) await evaluate(tab, `location.hash = '${h}'; await new Promise((r) => setTimeout(r, 250)); return true`);
    check('A: hash-навигация — без перезагрузок документа', tab.loads.length === loads0 && (await build(tab)) === 'A', `переходов внутри документа: ${tab.hashNavs.length}`);

    /* ===== A → B: deploy; пользователь открывает приложение ===== */
    current = B;
    loads0 = tab.loads.length;
    await tab.send('Page.reload', {});
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'B'", 'вкладка перешла на B');
    await sleep(4000);
    let loads = tab.loads.slice(loads0);
    check('A→B: открытие (из старого кэша) + ровно одна автоматическая перезагрузка', loads.length === 2, `документов: ${loads.length}`);
    check('A→B: выполняется код B', (await build(tab)) === 'B');
    check('A→B: активный SW — версия B', (await swVersion(tab)) === B.cache, String(await swVersion(tab)));
    check('A→B: build-info в приложении = SHA сервера', (await pageBuildInfo(tab)) === B.sha);
    let names = await cacheNames(tab);
    check('A→B: кэш A удалён, кэш B на месте, чужой кэш не тронут', !names.includes(A.cache) && names.includes(B.cache) && names.includes('e2e-unrelated'), names.join(', '));
    const snapB = await snapshot(tab);
    check('A→B: пользовательские данные без изменений (новые пустые разделы — только аддитивно)', sameExceptAdditive(snapB, snap0), `добавлены: ${addedKeys(snapB, snap0).join(', ') || 'нет'}`);
    snap0 = snapB; // дальше — строгое совпадение со снимком после первого запуска B

    loads0 = tab.loads.length;
    for (const h of ['#/metric/water', '#/sleep', '#/meds', '#/tests', '#/home']) await evaluate(tab, `location.hash = '${h}'; await new Promise((r) => setTimeout(r, 250)); return true`);
    check('B: переходы по экранам — новый код, без перезагрузок', tab.loads.length === loads0 && (await build(tab)) === 'B');

    /* ===== B → C: приложение открыто; возврат на передний план ===== */
    current = C;
    loads0 = tab.loads.length;
    await evaluate(tab, "document.dispatchEvent(new Event('visibilitychange')); return true"); // как возврат PWA из фона: render + checkForUpdate
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'C'", 'вкладка перешла на C');
    await sleep(4000);
    loads = tab.loads.slice(loads0);
    check('B→C: вкладка сама нашла версию и перезагрузилась ровно один раз', loads.length === 1, `документов: ${loads.length}`);
    check('B→C: SW C, build-info C, кэш B удалён', (await swVersion(tab)) === C.cache && (await pageBuildInfo(tab)) === C.sha && !(await cacheNames(tab)).includes(B.cache));
    check('B→C: пользовательские данные без изменений', (await snapshot(tab)) === snap0);

    /* ===== C → D: новая версия выходит во время ввода в форме ===== */
    await evaluate(tab, "location.hash = '#/med/new'; await new Promise((r) => setTimeout(r, 400)); return true");
    await evaluate(tab, "const f = document.querySelector('#screen input:not([type]), #screen input[type=text]'); f.focus(); return !!f");
    await tab.send('Input.insertText', { text: 'Незаконченный ввод' });
    const typed = () => evaluate(tab, "const f = document.querySelector('#screen input:not([type]), #screen input[type=text]'); return f ? f.value : null").catch(() => null);
    check('C: в форме набран текст', (await typed()) === 'Незаконченный ввод');
    current = D;
    loads0 = tab.loads.length;
    await evaluate(tab, 'const r = await navigator.serviceWorker.getRegistration(); await r.update(); return true');
    await waitFor(tab, `return (await caches.keys()).includes('${D.cache}') && !(await caches.keys()).includes('${C.cache}')`, 'SW D активирован');
    await sleep(4000);
    check('C→D: пока форма открыта — ни одной перезагрузки, текст на месте',
      tab.loads.length === loads0 && (await build(tab)) === 'C' && (await typed()) === 'Незаконченный ввод', `документов: ${tab.loads.length - loads0}`);
    await evaluate(tab, "location.hash = '#/meds'; return true"); // пользователь ушёл с формы
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'D'", 'вкладка перешла на D после формы');
    await sleep(4000);
    loads = tab.loads.slice(loads0);
    check('C→D: после ухода с формы — ровно одна перезагрузка, на тот экран, куда ушли',
      loads.length === 1 && loads[0].url.endsWith('#/meds') && (await evaluate(tab, 'return location.hash')) === '#/meds', loads.map((l) => l.url.replace(ORIGIN, '')).join(', '));
    check('C→D: SW D, build-info D', (await swVersion(tab)) === D.cache && (await pageBuildInfo(tab)) === D.sha);

    /* ===== D: нет цикла ===== */
    loads0 = tab.loads.length;
    for (const h of ['#/home', '#/metric/water', '#/sleep', '#/home']) await evaluate(tab, `location.hash = '${h}'; await new Promise((r) => setTimeout(r, 250)); return true`);
    await evaluate(tab, "document.dispatchEvent(new Event('visibilitychange')); return true"); // проверка есть, версии новой нет
    await evaluate(tab, `navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'lexlife:update-ready', version: '${D.cache}' } })); return true`);
    await sleep(5000);
    check('D: переходы, возврат в приложение, повтор сообщения той же версии — перезагрузок нет', tab.loads.length === loads0 && (await build(tab)) === 'D', `документов: ${tab.loads.length - loads0}`);
    check('D: пользовательские данные без изменений', (await snapshot(tab)) === snap0);

    /* ===== перезапуск приложения: новая вкладка того же профиля ===== */
    await cdp.send('Target.closeTarget', { targetId: tab.targetId });
    tab = await openTab(cdp, `${ORIGIN}/#/home`);
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'D' && document.querySelector('#screen').children.length > 0", 'перезапуск на D');
    await sleep(5000);
    check('перезапуск: сразу D, одна загрузка, без перезагрузок', tab.loads.length === 1 && (await build(tab)) === 'D', `документов: ${tab.loads.length}`);
    check('перезапуск: данные без изменений', (await snapshot(tab)) === snap0);
    /* ===== «Настройки сна»: исходные значения не мешают обновлению, правка — откладывает ===== */
    const dirty = () => evaluate(tab, "return (await import('/js/services/swUpdate.js')).hasUnsavedInput(document.body)");
    const settings = () => evaluate(tab, "return JSON.parse(localStorage.getItem('sleep_settings') || 'null')");
    await evaluate(tab, "location.hash = '#/sleep/settings'; await new Promise((r) => setTimeout(r, 500)); return true");
    check('D: «Настройки сна» открыты — форма не изменена', (await dirty()) === false);
    current = E;
    loads0 = tab.loads.length;
    await evaluate(tab, 'const r = await navigator.serviceWorker.getRegistration(); await r.update(); return true');
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'E'", 'вкладка перешла на E на «Настройках сна»');
    await sleep(4000);
    loads = tab.loads.slice(loads0);
    check('D→E: на нетронутых «Настройках сна» — ровно одна перезагрузка, экран тот же',
      loads.length === 1 && (await evaluate(tab, 'return location.hash')) === '#/sleep/settings', loads.map((l) => l.url.replace(ORIGIN, '')).join(', '));

    const settingsBefore = await settings();
    const bedBefore = await evaluate(tab, "return document.querySelector('#ss-bed').value");
    const newBed = bedBefore === '22:15' ? '22:20' : '22:15';
    await evaluate(tab, `const f = document.querySelector('#ss-bed'); f.focus(); f.value = '${newBed}'; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return true`);
    check('E: пользователь сменил время сна — форма изменена', (await dirty()) === true);
    current = F;
    loads0 = tab.loads.length;
    await evaluate(tab, 'const r = await navigator.serviceWorker.getRegistration(); await r.update(); return true');
    await waitFor(tab, `return (await caches.keys()).includes('${F.cache}') && !(await caches.keys()).includes('${E.cache}')`, 'SW F активирован');
    await sleep(4000);
    check('E→F: правка не сохранена — перезагрузки нет, введённое время на месте',
      tab.loads.length === loads0 && (await build(tab)) === 'E' && (await evaluate(tab, "return document.querySelector('#ss-bed').value")) === newBed);
    await evaluate(tab, "document.querySelector('.sleep-form button[type=submit]').click(); return true"); // «Сохранить»
    await waitFor(tab, "return globalThis.__E2E_BUILD === 'F'", 'вкладка перешла на F после сохранения');
    await sleep(4000);
    loads = tab.loads.slice(loads0);
    check('E→F: после «Сохранить» — ровно одна перезагрузка, на «Сон»',
      loads.length === 1 && (await evaluate(tab, 'return location.hash')) === '#/sleep', loads.map((l) => l.url.replace(ORIGIN, '')).join(', '));
    const settingsAfter = await settings();
    check('E→F: сохранено именно то, что ввёл пользователь (время сна), остальное как было',
      settingsAfter.bedtime === newBed && settingsAfter.wakeTime === settingsBefore.wakeTime && settingsAfter.goalMinutes === settingsBefore.goalMinutes, JSON.stringify(settingsAfter));
    await evaluate(tab, "location.hash = '#/sleep/settings'; await new Promise((r) => setTimeout(r, 500)); return true");
    check('F: «Настройки сна» после сохранения — не изменены', (await dirty()) === false);
    /* кроме сохранённой пользователем настройки сна, данные те же, что до всех обновлений */
    const strip = (snap) => { const o = JSON.parse(snap); delete o.localStorage.sleep_settings; return JSON.stringify(o); };
    check('E→F: остальные данные без изменений', strip(await snapshot(tab)) === strip(snap0));

    const swFetches = hits.filter((h) => h.path === '/sw.js').length;
    check('sw.js запрашивался с сервера при каждой проверке (revalidate)', swFetches >= 4, `запросов sw.js: ${swFetches}`);
  } finally {
    proc.kill();
    server.close();
    if (!KEEP) rmSync(TMP, { recursive: true, force: true });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length} passed, ${bad.length} failed (${results.length} total) · from ${FROM}`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
