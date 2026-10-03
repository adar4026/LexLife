/* =========================================================
   tests/notifications.test.mjs — расписание и доставка уведомлений
   (js/services/notifySchedule.js, js/services/notifier.js, sw.js push/click).
   Без браузера. Только синтетические данные.

   Тесты расписания прогоняются в нескольких timezone (дочерние процессы
   с TZ=…): время правила — локальное время устройства, а не UTC.
   DST-проверки — для Europe/Madrid.

   Запуск:  node tests/notifications.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { nextFire, prevFire, dueFire, NOTIF_GRACE_MS } from '../js/services/notifySchedule.js';
import { createNotifier, armPatch, waterRulePatch, describeNotifyState, isSafeRoute, backgroundActive } from '../js/services/notifier.js';
import { nextFireUtc, prevFireUtc, zonedToUtc, wallLabel, localWallLabel, occurrenceId } from '../js/services/zonedSchedule.js';
import { createFakeCaches, loadServiceWorker } from './helpers/fakeBrowser.mjs';
import { StorageService, MemoryDriver, parseBackup } from '../js/services/storage.js';

const ZONES = ['Europe/Madrid', 'UTC', 'America/New_York', 'Asia/Tokyo'];

/* Родительский процесс: запускает себя в каждой timezone и суммирует */
if (!process.env.LEXLIFE_TZ_CHILD) {
  const self = fileURLToPath(import.meta.url);
  let failed = 0; let passed = 0;
  for (const tz of ZONES) {
    const r = spawnSync(process.execPath, [self], { env: { ...process.env, TZ: tz, LEXLIFE_TZ_CHILD: '1' }, encoding: 'utf8' });
    process.stdout.write(`\n== TZ=${tz}\n${r.stdout}${r.stderr}`);
    const m = /(\d+) passed, (\d+) failed/.exec(r.stdout);
    if (!m || r.status !== 0) failed += m ? Number(m[2]) || 1 : 1;
    if (m) passed += Number(m[1]);
  }
  console.log(`\n${passed} passed, ${failed} failed (${ZONES.length} timezones)`);
  process.exit(failed ? 1 : 0);
}

const TZ = process.env.TZ;
const tests = [];
const test = (name, fn, onlyTz) => { if (!onlyTz || onlyTz === TZ) tests.push({ name, fn }); };

/* локальное время устройства */
const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const rule = (o) => ({ id: 'r1', type: 'meds', enabled: true, time: '09:00', repeat: 'daily', days: [], intervalMinutes: 120, startTime: '07:00', endTime: '23:00', date: null, text: 'synthetic', lastFiredAt: null, ...o });

/* ---------- расписание ---------- */
test('ежедневно: сегодня до времени → сегодня, после → завтра (локальное время, не UTC)', () => {
  const r = rule({ time: '21:00' });
  const a = nextFire(r, L(2031, 3, 10, 20, 59));
  assert.equal(ymd(a), '2031-03-10'); assert.equal(hm(a), '21:00');
  const b = nextFire(r, L(2031, 3, 10, 21, 0));
  assert.equal(ymd(b), '2031-03-11'); assert.equal(hm(b), '21:00');
  assert.equal(hm(prevFire(r, L(2031, 3, 10, 21, 0))), '21:00');
});

test('переход через полночь: 00:05 после 23:59 — завтра; prevFire в 00:01 — вчера', () => {
  const r = rule({ time: '00:05' });
  const n = nextFire(r, L(2031, 3, 10, 23, 59));
  assert.equal(ymd(n), '2031-03-11'); assert.equal(hm(n), '00:05');
  const p = prevFire(r, L(2031, 3, 11, 0, 1));
  assert.equal(ymd(p), '2031-03-10'); assert.equal(hm(p), '00:05');
});

test('конец месяца/года: 31.12 23:30 → 01.01 следующего года', () => {
  const n = nextFire(rule({ time: '08:00' }), L(2031, 12, 31, 23, 30));
  assert.equal(ymd(n), '2032-01-01'); assert.equal(hm(n), '08:00');
});

test('будни: пятница вечером → понедельник', () => {
  const fri = L(2031, 3, 14, 22, 0); assert.equal(fri.getDay(), 5);
  const n = nextFire(rule({ repeat: 'weekdays', time: '08:00' }), fri);
  assert.equal(ymd(n), '2031-03-17'); assert.equal(n.getDay(), 1);
});

test('еженедельно (вес, пн 08:00): следующее и предыдущее; пустые дни → никогда', () => {
  const r = rule({ type: 'weight', repeat: 'weekly', days: [1], time: '08:00' });
  const n = nextFire(r, L(2031, 3, 17, 8, 1)); // пн после 08:00
  assert.equal(ymd(n), '2031-03-24');
  assert.equal(ymd(prevFire(r, L(2031, 3, 20, 12, 0))), '2031-03-17');
  assert.equal(nextFire(rule({ repeat: 'weekly', days: [] }), L(2031, 3, 17)), null);
});

test('разово (анализы/визиты): дата в далёком будущем, прошло → null', () => {
  const r = rule({ type: 'tests', repeat: 'once', date: '2031-05-20', time: '07:30' });
  const n = nextFire(r, L(2031, 3, 10));
  assert.equal(ymd(n), '2031-05-20'); assert.equal(hm(n), '07:30');
  assert.equal(nextFire(r, L(2031, 5, 20, 7, 30)), null);
  assert.equal(hm(prevFire(r, L(2031, 5, 20, 7, 30))), '07:30');
  assert.equal(nextFire(rule({ repeat: 'once', date: null }), L(2031, 3, 10)), null);
});

test('вода: каждые 2 ч 07:00–23:00 — слоты, после 23:00 → 07:00 завтра', () => {
  const r = rule({ type: 'water', repeat: 'interval', intervalMinutes: 120 });
  assert.equal(hm(nextFire(r, L(2031, 3, 10, 6, 0))), '07:00');
  assert.equal(hm(nextFire(r, L(2031, 3, 10, 7, 0))), '09:00');
  assert.equal(hm(nextFire(r, L(2031, 3, 10, 21, 30))), '23:00');
  const n = nextFire(r, L(2031, 3, 10, 23, 0));
  assert.equal(ymd(n), '2031-03-11'); assert.equal(hm(n), '07:00');
  assert.equal(hm(prevFire(r, L(2031, 3, 10, 10, 59))), '09:00');
  const p = prevFire(r, L(2031, 3, 10, 6, 0));
  assert.equal(ymd(p), '2031-03-09'); assert.equal(hm(p), '23:00');
});

test('вода: окно через полночь 22:00–02:00', () => {
  const r = rule({ type: 'water', repeat: 'interval', intervalMinutes: 120, startTime: '22:00', endTime: '02:00' });
  const n = nextFire(r, L(2031, 3, 10, 23, 30));
  assert.equal(ymd(n), '2031-03-11'); assert.equal(hm(n), '00:00');
  assert.equal(hm(nextFire(r, L(2031, 3, 11, 1, 30))), '02:00');
  assert.equal(hm(prevFire(r, L(2031, 3, 11, 1, 30))), '00:00');
  const after = nextFire(r, L(2031, 3, 11, 2, 0));
  assert.equal(ymd(after), '2031-03-11'); assert.equal(hm(after), '22:00');
});

test('Europe/Madrid, переход на летнее время (29.03.2026): 09:00 остаётся 09:00', () => {
  const r = rule({ time: '09:00' });
  const a = nextFire(r, L(2026, 3, 28, 8, 0));
  const b = nextFire(r, a);
  assert.equal(hm(a), '09:00'); assert.equal(hm(b), '09:00'); assert.equal(ymd(b), '2026-03-29');
  assert.equal((b - a) / 3600000, 23);
}, 'Europe/Madrid');

test('Europe/Madrid, переход на зимнее время (25.10.2026): 09:00 остаётся 09:00', () => {
  const r = rule({ time: '09:00' });
  const a = nextFire(r, L(2026, 10, 24, 8, 0));
  const b = nextFire(r, a);
  assert.equal(hm(b), '09:00'); assert.equal(ymd(b), '2026-10-25'); assert.equal((b - a) / 3600000, 25);
}, 'Europe/Madrid');

test('Europe/Madrid: время 09:00 — это 07:00Z летом и 08:00Z зимой (сравнение не в UTC)', () => {
  assert.equal(nextFire(rule({ time: '09:00' }), L(2026, 7, 1, 0, 0)).toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(nextFire(rule({ time: '09:00' }), L(2026, 12, 1, 0, 0)).toISOString(), '2026-12-01T08:00:00.000Z');
}, 'Europe/Madrid');

/* ---------- одно срабатывание → одно уведомление ---------- */
test('dueFire: срабатывает в момент и в пределах 10 мин, но не позже (пропущено)', () => {
  const r = rule({ time: '09:00' });
  assert.equal(dueFire(r, L(2031, 3, 10, 8, 59)), null);
  assert.equal(hm(dueFire(r, L(2031, 3, 10, 9, 0))), '09:00');
  assert.equal(hm(dueFire(r, L(2031, 3, 10, 9, 9))), '09:00');
  assert.equal(dueFire(r, new Date(L(2031, 3, 10, 9, 0).getTime() + NOTIF_GRACE_MS)), null);
});

test('dueFire: после lastFiredAt то же срабатывание не повторяется; выключенное — никогда', () => {
  const r = rule({ time: '09:00' });
  const due = dueFire(r, L(2031, 3, 10, 9, 0));
  assert.equal(dueFire({ ...r, lastFiredAt: due.toISOString() }, L(2031, 3, 10, 9, 5)), null);
  assert.ok(dueFire({ ...r, lastFiredAt: due.toISOString() }, L(2031, 3, 11, 9, 1)), 'завтра — снова');
  assert.equal(dueFire({ ...r, enabled: false }, L(2031, 3, 10, 9, 0)), null);
});

test('включение/правка (armPatch): прошедшее время не «догоняется», новое — срабатывает', () => {
  const now = L(2031, 3, 10, 9, 5);
  const armed = { ...rule({ time: '09:00' }), ...armPatch({ enabled: true }, now) };
  assert.equal(dueFire(armed, now), null, 'включили в 09:05 — 09:00 не показываем');
  const edited = { ...armed, ...armPatch({ time: '09:07' }, now) };
  assert.equal(dueFire(edited, L(2031, 3, 10, 9, 6)), null);
  assert.equal(hm(dueFire(edited, L(2031, 3, 10, 9, 7))), '09:07');
  /* старое время после изменения не срабатывает: расписание вычисляется только из текущих полей */
  const moved = { ...armed, ...armPatch({ time: '18:00' }, now) };
  assert.equal(dueFire(moved, L(2031, 3, 11, 9, 0)), null);
});

const memStorage = async (list) => {
  const s = new StorageService(new MemoryDriver());
  await s.init();
  await s._write('notifications', list);
  return s;
};

test('createNotifier: параллельные проверки → одно уведомление, lastFiredAt сохраняется', async () => {
  const storage = await memStorage([rule({ id: 'a', time: '09:00' }), rule({ id: 'b', time: '10:00' }), rule({ id: 'c', time: '09:00', enabled: false })]);
  const shown = [];
  let t = L(2031, 3, 10, 9, 1);
  const n = createNotifier({ storage, show: async (r) => { shown.push(r.id); }, permission: () => 'granted', now: () => t });
  await Promise.all([n.check(), n.check(), n.check()]);
  await n.check();
  assert.deepEqual(shown, ['a']);
  const a = (await storage.getNotifications()).find((r) => r.id === 'a');
  assert.equal(new Date(a.lastFiredAt).getTime(), L(2031, 3, 10, 9, 0).getTime());
  t = L(2031, 3, 10, 10, 0);
  await n.check(); await n.check();
  assert.deepEqual(shown, ['a', 'b']);
});

test('createNotifier: без разрешения ничего не показывает и не помечает', async () => {
  const storage = await memStorage([rule({ id: 'a' })]);
  const shown = [];
  for (const perm of ['default', 'denied', 'unsupported']) {
    const n = createNotifier({ storage, show: async (r) => shown.push(r.id), permission: () => perm, now: () => L(2031, 3, 10, 9, 0) });
    await n.check();
  }
  assert.deepEqual(shown, []);
  assert.equal((await storage.getNotifications())[0].lastFiredAt, null);
});

test('createNotifier: ошибка показа не роняет проверку и не даёт повторов', async () => {
  const storage = await memStorage([rule({ id: 'a' }), rule({ id: 'b' })]);
  const errors = []; const shown = [];
  const n = createNotifier({
    storage, permission: () => 'granted', now: () => L(2031, 3, 10, 9, 0), onError: (e, r) => errors.push(r.id),
    show: async (r) => { if (r.id === 'a') throw new Error('x'); shown.push(r.id); },
  });
  await n.check(); await n.check();
  assert.deepEqual(errors, ['a']); assert.deepEqual(shown, ['b']);
});

test('правила остаются валидными для бэкапа после armPatch / waterRulePatch', async () => {
  const storage = await memStorage([rule({ id: 'w1', type: 'water', repeat: 'interval' })]);
  await storage.updateNotification('w1', armPatch({ enabled: true, ...waterRulePatch({ wakeStart: '08:00', wakeEnd: '22:30', slotMinutes: 90 }) }));
  const w = (await storage.getNotifications())[0];
  assert.equal(w.startTime, '08:00'); assert.equal(w.endTime, '22:30'); assert.equal(w.intervalMinutes, 90); assert.equal(w.repeat, 'interval');
  const { json, verified } = await storage.createBackup();
  assert.ok(verified, 'бэкап с изменёнными правилами проходит самопроверку');
  const target = new StorageService(new MemoryDriver()); await target.init();
  await target.restoreBackup(await target.prepareRestore(parseBackup(json)));
  assert.deepEqual(await target.getNotifications(), await storage.getNotifications(), 'restore возвращает правила без изменений');
});

/* ---------- честный статус ---------- */
test('статус: Safari-вкладка на iPhone, запрет, нет разрешения, разрешено — без «работают»', () => {
  const base = { supported: true, permission: 'granted', ios: true, standalone: true, swActive: true, pushSupported: true, subscribed: false };
  assert.equal(describeNotifyState({ ...base, supported: false, standalone: false }).status.title, 'В Safari уведомления недоступны');
  assert.equal(describeNotifyState({ ...base, permission: 'denied' }).status.title, 'Уведомления запрещены в настройках iPhone');
  const def = describeNotifyState({ ...base, permission: 'default' }).status;
  assert.equal(def.title, 'Разрешение не предоставлено'); assert.equal(def.ask, true);
  assert.equal(describeNotifyState({ ...base, swActive: false }).status.level, 'warn');
  const ok = describeNotifyState(base);
  assert.equal(ok.status.title, 'Уведомления разрешены');
  assert.ok(ok.items.some((i) => i.label === 'Фоновая доставка' && i.value === 'неактивна'));
  assert.ok(ok.items.some((i) => i.label === 'Push-подписка' && i.value === 'отсутствует'));
  assert.ok(ok.items.some((i) => i.label === 'Системное разрешение' && i.value === 'разрешено'));
  assert.match(ok.limit, /пока LexLife открыт|останавливает его код/);
  const all = JSON.stringify(describeNotifyState(base));
  assert.ok(!/работают/.test(all), 'нет обещания «уведомления работают»');
});

test('статус фоновой доставки: активна только при сервере + подписке + синхронизированных правилах', () => {
  const base = { supported: true, permission: 'granted', ios: true, standalone: true, swActive: true, pushSupported: true, subscribed: true };
  const bg = { backend: 'ok', enabled: true, subscription: 'active', syncError: false, pending: false, lastSyncAt: '2031-03-10T08:00:00.000Z', lastPushAt: '2031-03-10T09:00:00.000Z' };
  const on = describeNotifyState({ ...base, background: bg });
  assert.equal(on.active, true); assert.equal(on.status.title, 'Фоновые уведомления активны');
  const facts = Object.fromEntries(on.items.map((i) => [i.label, i.value]));
  assert.equal(facts['Сервер уведомлений'], 'доступен'); assert.equal(facts['Фоновая доставка'], 'активна');
  assert.notEqual(facts['Последняя синхронизация'], '—'); assert.notEqual(facts['Последний серверный push'], '—');
  const err = describeNotifyState({ ...base, background: { ...bg, syncError: true } });
  assert.equal(err.active, false); assert.equal(err.status.title, 'Не удалось синхронизировать фоновые уведомления');
  assert.equal(describeNotifyState({ ...base, background: { ...bg, pending: true } }).active, false, 'неотправленные изменения — не «активна»');
  assert.equal(describeNotifyState({ ...base, background: { ...bg, subscription: 'lost' } }).status.title, 'Push-подписка потеряна');
  const pages = describeNotifyState({ ...base, subscribed: false, background: { ...bg, backend: 'absent', enabled: false, subscription: 'none' } });
  assert.equal(pages.active, false);
  assert.equal(Object.fromEntries(pages.items.map((i) => [i.label, i.value]))['Сервер уведомлений'], 'нет на этом адресе');
  assert.match(pages.limit, /По этому адресу фоновые уведомления не работают/);
  assert.equal(backgroundActive(null), false);
});

/* ---------- сервер = локальное расписание (одинаковые occurrence в любой timezone) ---------- */
test('zonedSchedule совпадает с локальным планировщиком: год × 7 правил (DST, полночь, окна, разовые)', () => {
  const rules = [rule({ time: '02:30' }), rule({ time: '00:05' }), rule({ repeat: 'interval', intervalMinutes: 90, startTime: '22:00', endTime: '02:00' }),
    rule({ repeat: 'interval', intervalMinutes: 60, startTime: '01:00', endTime: '04:00' }), rule({ repeat: 'weekly', days: [0, 3], time: '02:15' }),
    rule({ repeat: 'weekdays', time: '23:59' }), rule({ repeat: 'once', date: '2031-03-30', time: '02:30' })];
  let n = 0;
  for (let t = Date.UTC(2031, 0, 1); t < Date.UTC(2032, 0, 3); t += 151 * 60000) {
    for (const r of rules) {
      const a = nextFire(r, new Date(t)); const b = nextFireUtc(r, t, TZ);
      const c = prevFire(r, new Date(t)); const d = prevFireUtc(r, t, TZ);
      assert.equal(b, a ? a.getTime() : null, `next ${JSON.stringify(r)} @ ${new Date(t).toISOString()}`);
      assert.equal(d, c ? c.getTime() : null, `prev ${JSON.stringify(r)} @ ${new Date(t).toISOString()}`);
      if (a) assert.equal(wallLabel(b, TZ), localWallLabel(a), 'одинаковая локальная метка → одинаковый occurrenceId');
      n++;
    }
  }
  assert.ok(n > 20000);
});

test('Europe/Madrid: zonedToUtc на переходах DST', () => {
  const Z = 'Europe/Madrid';
  assert.equal(new Date(zonedToUtc(2031, 3, 30, 2, 30, Z)).toISOString(), '2031-03-30T01:30:00.000Z', 'весной 02:30 нет → 03:30 CEST');
  assert.equal(new Date(zonedToUtc(2031, 3, 30, 3, 0, Z)).toISOString(), '2031-03-30T01:00:00.000Z');
  assert.equal(new Date(zonedToUtc(2031, 10, 26, 2, 30, Z)).toISOString(), '2031-10-26T00:30:00.000Z', 'осенью 02:30 дважды → первое');
  assert.equal(new Date(zonedToUtc(2031, 10, 26, 3, 0, Z)).toISOString(), '2031-10-26T02:00:00.000Z');
  assert.equal(new Date(zonedToUtc(2031, 12, 31, 24, 30, Z)).toISOString(), '2031-12-31T23:30:00.000Z', 'переполнение минут → следующий день/год');
  assert.equal(occurrenceId('abc', '2031-03-30T03:30'), 'abc@2031-03-30T03:30');
});

test('isSafeRoute: только внутренние маршруты', () => {
  assert.ok(isSafeRoute('#/meds')); assert.ok(isSafeRoute('#/metric/water'));
  for (const bad of ['https://evil.example', 'javascript:alert(1)', '#/x?y=<z>', '//a', '', null]) assert.ok(!isSafeRoute(bad), String(bad));
});

/* ---------- sw.js: push и notificationclick ---------- */
const loadSw = () => loadServiceWorker({ scope: 'https://example.test/LexLife/' });

test('sw.js: CACHE_VERSION поднят, новые модули в APP_SHELL, старые кэши удаляются, данные не трогаются', () => {
  const src = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(src, /const CACHE_VERSION = 'lexlife-v39';/);
  for (const m of ['notifySchedule', 'notifier', 'zonedSchedule', 'pushClient', 'occurrenceStore', 'deployment']) assert.match(src, new RegExp(`'\\./js/services/${m}\\.js'`), m);
  assert.match(src, /k !== CACHE_VERSION && k !== FONT_CACHE && k !== OCC_CACHE/);
  assert.match(src, /startsWith\(new URL\(self\.registration\.scope\)\.pathname \+ 'api\/'\)/, 'API не кэшируется SW');
  assert.ok(!/localStorage|indexedDB/.test(src), 'SW не трогает пользовательские данные');
});

test('sw.js push: всегда показывает уведомление; маршрут только внутренний', async () => {
  const s = loadSw();
  assert.ok(s.listeners.push && s.listeners.notificationclick);
  await s.fire('push', { data: { json: () => ({ title: 'T', body: 'B', route: '#/meds' }), text: () => '' } });
  await s.fire('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'plain' } });
  await s.fire('push', { data: null });
  await s.fire('push', { data: { json: () => ({ route: 'https://evil.example' }), text: () => '' } });
  assert.equal(s.shown.length, 4);
  assert.equal(s.shown[0].opts.data.route, '#/meds');
  assert.equal(s.shown[1].opts.body, 'plain');
  assert.equal(s.shown[2].title, 'LexLife');
  assert.equal(s.shown[3].opts.data.route, '#/notifications');
});

test('sw.js push (сервер LexLife): tag = occurrenceId, target → route, журнал occurrence в Cache API, badge/icon; повтор — тот же tag', async () => {
  const caches = createFakeCaches();
  const s = loadServiceWorker({ caches, scope: 'https://example.test/LexLife/' });
  const payload = { v: 1, occurrenceId: 'r1@2031-03-10T09:00', type: 'water', title: 'LexLife', body: 'Пора выпить воду', target: '#/metric/water', scheduledAt: '2031-03-10T08:00:00.000Z' };
  await s.pushJson(payload);
  await s.pushJson(payload); // retry сервера / повторная доставка
  assert.equal(s.shown.length, 2, 'каждый push показывает уведомление (iOS)');
  assert.equal(s.shown[0].opts.tag, 'r1@2031-03-10T09:00'); assert.equal(s.shown[1].opts.tag, s.shown[0].opts.tag, 'тот же tag → замена, а не второе');
  assert.equal(s.shown[0].opts.data.route, '#/metric/water'); assert.equal(s.shown[0].opts.data.occurrenceId, payload.occurrenceId);
  assert.ok(s.shown[0].opts.icon && s.shown[0].opts.badge);
  const occ = (await caches.open('lexlife-occ-v1'));
  assert.ok(await occ.match('https://example.test/LexLife/__occ/r1%402031-03-10T09%3A00'), 'журнал в scope приложения (base path /LexLife/)');
  await s.pushJson({ occurrenceId: 'x'.repeat(500), body: 'y'.repeat(1000), target: 'javascript:alert(1)' });
  assert.equal(s.shown[2].opts.tag, 'lexlife-push'); assert.equal(s.shown[2].opts.body.length, 200); assert.equal(s.shown[2].opts.data.route, '#/notifications');
});

test('createNotifier: срабатывание, уже показанное push\'ем, локально не показывается; при активном push — ожидание, затем один запасной показ', async () => {
  const storage = await memStorage([rule({ id: 'a', time: '09:00' }), rule({ id: 'b', time: '09:00' })]);
  const seen = new Set(['a@' + localWallLabel(L(2031, 3, 10, 9, 0))]);
  const occurrences = { has: async (id) => seen.has(id), mark: async (id) => { seen.add(id); } };
  const shown = [];
  let t = L(2031, 3, 10, 9, 1);
  const n = createNotifier({ storage, show: async (r, at, id) => { shown.push(id); }, permission: () => 'granted', now: () => t, occurrences, deferMs: async () => 120000 });
  await n.check();
  assert.deepEqual(shown, [], 'a уже пришло push\'ем; b ждёт push 2 мин');
  assert.ok((await storage.getNotifications()).find((r) => r.id === 'a').lastFiredAt, 'a помечено как сработавшее');
  t = L(2031, 3, 10, 9, 2, 1);
  await Promise.all([n.check(), n.check()]); await n.check();
  assert.deepEqual(shown, ['b@' + localWallLabel(L(2031, 3, 10, 9, 0))]);
  assert.ok(seen.has(shown[0]), 'запасной показ записан в журнал (SW не покажет push как новое)');
});

test('sw.js notificationclick: фокус открытого окна + маршрут; иначе — открыть ./#/route', async () => {
  const s = loadSw();
  let closed = 0;
  const note = (route) => ({ notification: { close: () => { closed++; }, data: { route } } });
  await s.fire('notificationclick', note('#/metric/water'));
  assert.deepEqual(s.opened, ['./#/metric/water']);
  let focused = 0; const msgs = [];
  s.clients.push({ focus: async () => { focused++; }, postMessage: (m) => msgs.push(m) });
  await s.fire('notificationclick', note('#/meds'));
  await s.fire('notificationclick', note('javascript:alert(1)'));
  assert.equal(focused, 2); assert.equal(closed, 3);
  assert.equal(JSON.stringify(msgs), JSON.stringify([{ type: 'lexlife:open', route: '#/meds' }]));
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`  ok — ${t.name}`); } catch (err) { failed++; console.log(`  FAIL — ${t.name}\n    ${err && err.stack}`); }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
