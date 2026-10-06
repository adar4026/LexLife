/* =========================================================
   pushClient.js — фоновые уведомления: устройство, Web Push подписка
   и зеркало правил на сервере LexLife (Cloudflare Worker, тот же origin).

   Главное состояние правил — по-прежнему localStorage (notifications).
   Сервер получает только расписание (без текстов) для фоновой доставки.

   Синхронизация — по состоянию, а не по событиям: «отпечаток» текущих
   правил + timezone сравнивается с последним успешно отправленным.
   Отличается → нужна синхронизация. Поэтому:
   - offline-изменения не теряются (отпечаток переживает перезапуск);
   - несколько изменений подряд → уходит одна, последняя версия;
   - restore из бэкапа автоматически пересинхронизирует правила;
   - rev монотонен: устаревший запрос сервер отклонит (409).

   Ключи устройства (lexlife_device_*) лежат вне DATA_KEYS: не попадают
   в резервную копию и не переносятся restore'ом на другое устройство.
   ========================================================= */

export const PUSH_KV = {
  deviceId: 'lexlife_device_id',
  token: 'lexlife_device_token',
  state: 'lexlife_push_state',
};
export const SYNC_FAIL_TEXT = 'Не удалось синхронизировать фоновые уведомления';
/* Пока push — основной канал, локальный планировщик ждёт столько, прежде чем показать сам */
export const SERVER_FALLBACK_MS = 2 * 60000;

const SYNC_FIELDS = ['id', 'type', 'enabled', 'repeat', 'time', 'days', 'intervalMinutes', 'startTime', 'endTime', 'date'];

/* Что уходит на сервер: только расписание. Без text, ref, lastFiredAt. */
export function syncSnapshot(rules, timezone) {
  const list = (Array.isArray(rules) ? rules : [])
    .map((r) => {
      const o = {};
      for (const k of SYNC_FIELDS) o[k] = r[k] == null ? null : r[k];
      o.enabled = !!r.enabled;
      o.days = Array.isArray(r.days) ? [...r.days].sort((a, b) => a - b) : [];
      if (o.intervalMinutes != null) o.intervalMinutes = Number(o.intervalMinutes);
      return o;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { timezone, rules: list };
}

export function urlB64ToUint8Array(b64u) {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const sameKey = (a, b) => {
  if (!a || !b) return false;
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
async function hashText(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* deps:
   kv            { get(k) → string|null, set(k, v), remove(k) } (localStorage)
   fetchImpl     fetch
   apiBase       URL каталога API (new URL('api/', document.baseURI))
   getRules      async () → правила из Storage
   timeZone      () → 'Europe/Madrid'
   pushManager   async () → PushManager | null
   permission    () → 'granted' | 'denied' | 'default' | 'unsupported'
   serverAllowed false — резервная копия (GitHub Pages): ни одного запроса к /api,
                 устройство не регистрируется, подписка и правила на сервер не уходят
   now, randomUUID — для тестов */
export function createPushClient({
  kv, fetchImpl, apiBase, getRules, timeZone, pushManager, permission, serverAllowed = true,
  now = () => Date.now(), randomUUID = () => crypto.randomUUID(),
}) {
  const readState = () => {
    try { const s = JSON.parse(kv.get(PUSH_KV.state) || 'null'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
  };
  const patchState = (patch) => { const s = { ...readState(), ...patch }; kv.set(PUSH_KV.state, JSON.stringify(s)); return s; };
  const creds = () => {
    const deviceId = kv.get(PUSH_KV.deviceId); const token = kv.get(PUSH_KV.token);
    return deviceId && token ? { deviceId, token } : null;
  };

  async function api(method, path, body, { auth = true } = {}) {
    if (!serverAllowed) return { ok: false, status: 0, data: { error: 'not_primary' }, legacy: true };
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const c = creds();
      if (!c) return { ok: false, status: 401, data: { error: 'no_device' } };
      headers.Authorization = `Bearer ${c.deviceId}.${c.token}`; // токен — только в заголовке, не в URL
    }
    let res;
    try {
      res = await fetchImpl(new URL(path, apiBase).href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
    } catch {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  let configPromise = null;
  /* { available, vapidPublicKey }. На GitHub Pages /api нет → available: false */
  function config() {
    if (!serverAllowed) return Promise.resolve({ available: false, vapidPublicKey: null, offline: false, legacy: true });
    if (!configPromise) {
      configPromise = api('GET', 'config', undefined, { auth: false }).then((r) => {
        const ok = r.ok && r.data && typeof r.data.vapidPublicKey === 'string' && r.data.vapidPublicKey.length > 80;
        if (!ok) configPromise = null; // повторить позже (сеть могла вернуться)
        return { available: !!ok, vapidPublicKey: ok ? r.data.vapidPublicKey : null, offline: r.status === 0 };
      });
    }
    return configPromise;
  }

  /* device_id генерируется на устройстве один раз; сервер выдаёт токен.
     Если id занят (409) — новый случайный id (старый токен утерян). */
  async function ensureDevice() {
    if (!serverAllowed) return false;
    if (creds()) return true;
    let id = kv.get(PUSH_KV.deviceId) || randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      kv.set(PUSH_KV.deviceId, id);
      const r = await api('POST', 'device/register', { deviceId: id }, { auth: false });
      if (r.ok && r.data.token) { kv.set(PUSH_KV.deviceId, r.data.deviceId); kv.set(PUSH_KV.token, r.data.token); return true; }
      if (r.status !== 409) return false;
      id = randomUUID();
    }
    return false;
  }
  const forgetDevice = () => { kv.remove(PUSH_KV.token); kv.remove(PUSH_KV.deviceId); };

  async function sendSubscription(sub) {
    const j = sub.toJSON();
    let r = await api('POST', 'push/subscribe', { endpoint: j.endpoint, keys: { p256dh: j.keys && j.keys.p256dh, auth: j.keys && j.keys.auth } });
    if (r.status === 401) { // устройство удалено на сервере (долго не использовалось) — регистрируемся заново
      forgetDevice();
      if (!(await ensureDevice())) return r;
      r = await api('POST', 'push/subscribe', { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } });
    }
    if (r.ok) patchState({ subscription: 'active', endpointHash: await hashText(j.endpoint), syncedHash: null });
    return r;
  }

  /* Включить фоновые уведомления. Разрешение на уведомления запрашивает вызывающий код. */
  async function enable() {
    if (!serverAllowed) return { ok: false, error: 'legacy' };
    if (permission() !== 'granted') return { ok: false, error: 'permission' };
    const cfg = await config();
    if (!cfg.available) return { ok: false, error: cfg.offline ? 'offline' : 'backend_unavailable' };
    const pm = await pushManager();
    if (!pm) return { ok: false, error: 'push_unsupported' };
    if (!(await ensureDevice())) return { ok: false, error: 'register_failed' };
    const key = urlB64ToUint8Array(cfg.vapidPublicKey);
    let sub = await pm.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      try { sub = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key }); } catch (err) {
        return { ok: false, error: 'subscribe_failed', detail: err && err.name };
      }
    }
    const r = await sendSubscription(sub);
    if (!r.ok) return { ok: false, error: r.status === 0 ? 'offline' : 'server', status: r.status };
    patchState({ enabled: true, pendingUnsubscribe: false });
    const s = await sync({ force: true });
    return { ok: s.ok, error: s.ok ? null : 'sync_failed' };
  }

  /* Отключить: PushSubscription.unsubscribe() + сервер удаляет подписку и зеркало правил.
     Локальные правила не трогаются (локальные напоминания при открытом приложении остаются). */
  async function disable() {
    patchState({ enabled: false, subscription: 'none', syncedHash: null, endpointHash: null });
    try { const pm = await pushManager(); const sub = pm && await pm.getSubscription(); if (sub) await sub.unsubscribe(); } catch { /* подписки уже нет */ }
    if (!creds()) { patchState({ pendingUnsubscribe: false }); return { ok: true }; }
    const r = await api('POST', 'push/unsubscribe', {});
    patchState({ pendingUnsubscribe: !r.ok && r.status !== 401 });
    return { ok: r.ok || r.status === 401, offline: r.status === 0 };
  }

  async function syncOnce(force) {
    if (!serverAllowed) return { ok: true, skipped: true };
    const st = readState();
    if (st.pendingUnsubscribe) { // отключение, не дошедшее до сервера offline
      const r = await api('POST', 'push/unsubscribe', {});
      if (r.ok || r.status === 401) patchState({ pendingUnsubscribe: false });
    }
    if (!st.enabled) return { ok: true, skipped: true };
    const snap = syncSnapshot(await getRules(), timeZone());
    const hash = JSON.stringify(snap);
    if (!force && hash === st.syncedHash) return { ok: true, upToDate: true };
    for (let attempt = 0; attempt < 2; attempt++) {
      const rev = Math.max(now(), (Number(readState().rev) || 0) + 1);
      patchState({ rev });
      const r = await api('POST', 'notifications/sync', { rev, ...snap });
      if (r.ok) {
        patchState({ syncedHash: hash, syncedAt: new Date(now()).toISOString(), lastError: null, lastErrorAt: null });
        return { ok: true };
      }
      if (r.status === 409 && r.data && Number.isSafeInteger(r.data.rev)) { patchState({ rev: r.data.rev }); continue; }
      if (r.status === 401) patchState({ subscription: 'lost' });
      patchState({ lastError: SYNC_FAIL_TEXT, lastErrorAt: new Date(now()).toISOString() });
      return { ok: false, status: r.status, offline: r.status === 0 };
    }
    patchState({ lastError: SYNC_FAIL_TEXT, lastErrorAt: new Date(now()).toISOString() });
    return { ok: false, status: 409 };
  }

  /* Одна синхронизация за раз; вызовы во время отправки склеиваются в ещё
     один проход, который прочитает самую свежую версию правил. */
  let inflight = null; let again = false; let againForce = false;
  function sync({ force = false } = {}) {
    if (inflight) { again = true; againForce = againForce || force; return inflight; }
    inflight = (async () => {
      let res = await syncOnce(force);
      while (again && res.ok) { const f = againForce; again = false; againForce = false; res = await syncOnce(f); }
      again = false; againForce = false;
      return res;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /* При запуске: подписка на месте и та же, что знает сервер? */
  async function checkSubscription() {
    if (!serverAllowed) return { state: 'off' };
    const st = readState();
    if (!st.enabled) return { state: 'off' };
    let sub = null;
    try { const pm = await pushManager(); sub = pm ? await pm.getSubscription() : null; } catch { sub = null; }
    if (!sub) {
      if (permission() === 'granted') { // iOS мог сбросить подписку — подписываемся заново (userVisibleOnly)
        const r = await enable();
        if (r.ok) return { state: 'renewed' };
      }
      patchState({ subscription: 'lost' });
      return { state: 'lost' };
    }
    if ((await hashText(sub.toJSON().endpoint)) !== st.endpointHash) {
      const r = await sendSubscription(sub);
      return { state: r.ok ? 'updated' : 'error' };
    }
    /* Сервер тоже знает эту подписку? (отметка запуска last_seen_at; подписку мог
       снять ответ 404/410 push-сервиса) — нет → отправляем снова */
    const s = await api('GET', 'push/status');
    if ((s.ok && s.data.subscription !== 'active') || s.status === 401) {
      const r = await sendSubscription(sub);
      return { state: r.ok ? 'healed' : 'error' };
    }
    return { state: 'ok' };
  }

  /* Судьба одного срабатывания на сервере → решение локального планировщика:
     'delivered' — push принят push-сервисом (не дублировать),
     'pending'   — сервер ещё отправляет/повторяет,
     'undelivered' — не ушёл (ошибка, пропуск, нет записи) или сервер недоступен
                     (без сети iPhone push тоже не получил). */
  async function occurrenceStatus(occId) {
    const r = await api('GET', `push/deliveries?occurrence=${encodeURIComponent(occId)}`);
    const d = r.ok && r.data ? r.data.delivery : null;
    if (!d) return 'undelivered';
    if (d.status === 'sent' || d.status === 'unknown') return 'delivered';
    if (d.status === 'claimed' || d.status === 'retry') return 'pending';
    return 'undelivered';
  }

  const pendingSync = async () => {
    if (!serverAllowed) return false;
    const st = readState();
    return !!st.enabled && JSON.stringify(syncSnapshot(await getRules(), timeZone())) !== st.syncedHash;
  };
  /* Push — основной канал: включён, подписка активна, правила на сервере актуальны */
  async function isServerPrimary() {
    if (!serverAllowed) return false;
    const st = readState();
    return !!st.enabled && st.subscription === 'active' && !(await pendingSync());
  }

  return {
    serverAllowed, config, ensureDevice, enable, disable, sync, checkSubscription, pendingSync, isServerPrimary, occurrenceStatus,
    state: readState,
    status: () => api('GET', 'push/status'),
    testPush: () => api('POST', 'notifications/test', {}),
    deliveries: () => api('GET', 'push/deliveries'),
  };
}
