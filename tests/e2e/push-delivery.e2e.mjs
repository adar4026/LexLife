/* =========================================================
   tests/e2e/push-delivery.e2e.mjs — сквозная доставка push без моков:
   настоящий Worker (wrangler dev, локальная D1 с настоящими миграциями,
   dev-пара VAPID из .dev.vars) → настоящий cron (/__scheduled) → настоящий
   push-сервис (FCM Google Chrome) → настоящий Service Worker LexLife →
   showNotification → подтверждение показа (POST /api/push/ack) → D1.

   Проверяет то, что тестами на заглушках не доказать:
   - SW реально показывает push и подтверждает показ (shown_at/acked_at в D1);
   - повторный запуск cron той же минуты не шлёт второй push;
   - журнал доставки на экране «Уведомления» показывает «показано в …».
   iPhone (APNs/webpushd) здесь не участвует: его задержку покажет ack в production.

   Запуск:  node tests/e2e/push-delivery.e2e.mjs [--keep]
   Нужны Google Chrome и сеть (FCM). Временные профиль и D1, синтетические данные.
   ========================================================= */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEP = process.argv.includes('--keep');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8788;
const ORIGIN = `http://127.0.0.1:${PORT}`; // не localhost: wrangler слушает IPv4 (см. docs/CLOUDFLARE.md)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = mkdtempSync(join(tmpdir(), 'lexlife-push-e2e-'));
const STATE = join(TMP, 'state');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} — ${name}${detail ? ` · ${detail}` : ''}`);
};

const wrangler = (...a) => spawnSync('npx', ['wrangler', ...a], { cwd: REPO, encoding: 'utf8' });
function d1(sql) {
  const r = wrangler('d1', 'execute', 'lexlife', '--local', '--persist-to', STATE, '--json', '--command', sql);
  if (r.status !== 0) throw new Error(`d1: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout)[0].results;
}

/* ---------- CDP (как в pwa-update.e2e.mjs) ---------- */
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
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method}: нет ответа 20 с`)); }, 20000);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }
}
async function evaluate(tab, body) {
  const r = await tab.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, what, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ }
    if (Date.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
    await sleep(250);
  }
}

let dev = null; let chrome = null;
async function main() {
  const step = (t) => console.log(`· ${t}`);
  step('сборка dist/ и локальная D1');
  execFileSync(process.execPath, [join(REPO, 'scripts/build-assets.mjs')], { cwd: REPO, stdio: 'ignore' });
  const mig = wrangler('d1', 'migrations', 'apply', 'lexlife', '--local', '--persist-to', STATE);
  if (mig.status !== 0) throw new Error(mig.stderr);

  step('wrangler dev');
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--test-scheduled', '--persist-to', STATE], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const devLog = [];
  dev.stdout.on('data', (b) => devLog.push(String(b))); dev.stderr.on('data', (b) => devLog.push(String(b)));
  await waitFor(async () => (await fetch(`${ORIGIN}/api/status`)).ok, 'wrangler dev /api/status', 60000);

  step('Chrome');
  const profile = join(TMP, 'profile');
  chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), 'Chrome DevToolsActivePort', 15000);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new Cdp(ws);
  await cdp.send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['notifications'] });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = { send: (m, p) => cdp.send(m, p, sessionId) };
  const errors = [];
  cdp.handlers.add((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  });
  await tab.send('Page.enable'); await tab.send('Runtime.enable');
  await tab.send('Page.navigate', { url: `${ORIGIN}/#/notifications` });
  await waitFor(() => evaluate(tab, 'return !!(navigator.serviceWorker.controller || 0) || !!(await navigator.serviceWorker.getRegistration())?.active'), 'Service Worker активен');
  /* статус экрана читается при отрисовке: после первой активации SW — перезагрузка */
  await tab.send('Page.reload');
  await waitFor(() => evaluate(tab, "return !!document.querySelector('[data-act=enable]')"), 'кнопка «Включить фоновые уведомления»');

  step('включение push');
  /* 1. Включение: устройство + настоящая push-подписка FCM + правила на сервере */
  await evaluate(tab, "document.querySelector('[data-act=enable]').click(); return true");
  await waitFor(() => evaluate(tab, "const s = JSON.parse(localStorage.getItem('lexlife_push_state') || '{}'); return s.enabled && s.subscription === 'active' && !!s.syncedHash"), 'подписка и синхронизация', 45000);
  const subs = d1("SELECT substr(endpoint, 1, 40) host, active FROM push_subscriptions");
  check('одна активная подписка FCM в D1', subs.length === 1 && subs[0].active === 1 && subs[0].host.startsWith('https://fcm.googleapis.com/'), subs.map((s) => s.host.slice(8, 30)).join());

  /* 2. Срабатывание «сейчас»: правило воды включается прямо в тестовой D1 */
  const rule = d1("SELECT id, client_rule_id FROM notification_rules WHERE type = 'water'")[0];
  const fireAt = Date.now() - 5000;
  d1(`UPDATE notification_rules SET enabled = 1, next_fire_at = ${fireAt} WHERE id = ${rule.id}`);
  const cronHit = await fetch(`${ORIGIN}/__scheduled?cron=*+*+*+*+*`);
  check('cron запущен (/__scheduled)', cronHit.ok, String(cronHit.status));

  step('ожидание push и ack');
  /* 3. FCM → SW → showNotification → ack */
  const row = await waitFor(() => { const r = d1(`SELECT * FROM notification_deliveries WHERE rule_id = ${rule.id}`)[0]; return r && r.acked_at ? r : null; }, 'ack от Service Worker', 45000).catch((e) => { check(e.message, false); return d1(`SELECT * FROM notification_deliveries WHERE rule_id = ${rule.id}`)[0]; });
  check('доставка sent, 1 попытка', row && row.status === 'sent' && row.attempts === 1, row && `${row.status}/${row.error_code || ''}`);
  check('SW подтвердил показ: shown_at и acked_at записаны', row && row.shown_at && row.acked_at, row && row.shown_at ? `показ +${Math.round((row.shown_at - row.scheduled_fire_at) / 1000)} с после расписания` : '');
  check('last_ack_at подписки обновлён', d1('SELECT last_ack_at FROM push_subscriptions')[0].last_ack_at > 0);
  const notes = await evaluate(tab, "const reg = await navigator.serviceWorker.getRegistration(); return (await reg.getNotifications()).map((n) => ({ title: n.title, occ: n.data && n.data.occurrenceId, body: n.body }))");
  check('уведомление на экране — одно, tag/occurrence сервера', notes.length === 1 && notes[0].title === 'LexLife' && notes[0].occ === row.occurrence_id, JSON.stringify(notes));

  /* 4. Повтор cron той же минуты и следующей — второго push нет */
  await fetch(`${ORIGIN}/__scheduled?cron=*+*+*+*+*`); await fetch(`${ORIGIN}/__scheduled?cron=*+*+*+*+*`);
  await sleep(3000);
  const all = d1(`SELECT COUNT(*) n FROM notification_deliveries WHERE rule_id = ${rule.id}`)[0].n;
  const notes2 = await evaluate(tab, 'const reg = await navigator.serviceWorker.getRegistration(); return (await reg.getNotifications()).length');
  check('повторные cron: одна доставка, одно уведомление', all === 1 && notes2 === 1, `deliveries=${all}, notifications=${notes2}`);

  /* 5. Журнал доставки на экране «Уведомления» */
  await tab.send('Page.reload');
  await waitFor(() => evaluate(tab, "return !!document.querySelector('.notif-log')"), 'журнал доставки на экране');
  await evaluate(tab, "document.querySelector('.notif-log').open = true; return true");
  const logText = await waitFor(() => evaluate(tab, "const t = document.querySelector('.notif-log__body').textContent; return /показано в/.test(t) ? t : null"), 'строка «показано в» в журнале');
  check('журнал доставки показывает время показа', /показано в .+ \(вовремя|\+\d+ мин\)/.test(logText), logText.slice(0, 80));

  /* 6. Логи Worker'а: структурированные, без endpoint */
  const logs = devLog.join('');
  check('лог cron: decision=sent с rule_id/scheduled_at/lag_s', /"evt":"push","decision":"sent","rule_id":\d+/.test(logs) && /"lag_s":/.test(logs));
  check('лог ack: shown_lag_s', /"evt":"ack".*"shown_lag_s":/.test(logs));
  check('в логах нет пути endpoint FCM', !/fcm\.googleapis\.com\/fcm\/send\//.test(logs));
  check('без ошибок JavaScript на странице', errors.length === 0, errors.join(' | '));
}

try {
  await main();
} catch (err) {
  check(`сценарий прерван: ${err.message}`, false);
} finally {
  try { chrome && chrome.kill('SIGKILL'); } catch { /* уже закрыт */ }
  try { dev && dev.kill('SIGTERM'); } catch { /* уже закрыт */ }
  if (!KEEP) { await sleep(500); rmSync(TMP, { recursive: true, force: true }); } else console.log(`профиль и D1: ${TMP}`);
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
