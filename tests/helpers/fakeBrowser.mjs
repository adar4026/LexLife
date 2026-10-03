/* =========================================================
   tests/helpers/fakeBrowser.mjs — минимальные Cache API, PushManager
   и загрузчик sw.js в vm для тестов без браузера.
   ========================================================= */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeUserAgent } from './pushService.mjs';

export function createFakeCaches() {
  const stores = new Map();
  const keyOf = (k) => (typeof k === 'string' ? k : k.url);
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (k) => { const r = m.get(keyOf(k)); return r ? r.clone() : undefined; },
      put: async (k, res) => { m.set(keyOf(k), res.clone()); },
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (k) => m.delete(keyOf(k)),
    };
  };
  return { open, stores, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), match: async () => undefined };
}

/* Браузерная подписка: настоящие ключи ECDH (payload можно расшифровать) */
export async function createFakePushManager({ endpointHost = 'https://web.push.apple.com' } = {}) {
  let current = null;
  const calls = { subscribe: [], unsubscribe: 0 };
  const pm = {
    async getSubscription() { return current; },
    async subscribe(opts) {
      calls.subscribe.push(opts);
      const ua = await makeUserAgent();
      const endpoint = `${endpointHost}/${crypto.randomUUID()}`;
      const sub = {
        ua, endpoint, options: { applicationServerKey: opts.applicationServerKey.buffer, userVisibleOnly: opts.userVisibleOnly },
        toJSON: () => ({ endpoint, keys: { p256dh: ua.p256dh, auth: ua.auth } }),
        unsubscribe: async () => { calls.unsubscribe++; if (current === sub) current = null; return true; },
      };
      current = sub;
      return sub;
    },
    /* браузер/iOS сбросил подписку */
    drop() { current = null; },
  };
  return { pm, calls, current: () => current };
}

/* sw.js в изолированном контексте: push / notificationclick */
export function loadServiceWorker({ caches = createFakeCaches(), scope = 'https://lexlife.test/' } = {}) {
  const listeners = {}; const shown = []; const opened = []; const clients = [];
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    registration: { scope, showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: { matchAll: async () => clients, openWindow: async (u) => { opened.push(u); }, claim: async () => {} },
    skipWaiting: () => {}, location: { origin: new URL(scope).origin },
  };
  vm.runInNewContext(readFileSync(new URL('../../sw.js', import.meta.url), 'utf8'), { self, caches, fetch: () => {}, URL, Request: class {}, Response, Date, JSON, String, encodeURIComponent });
  const fire = async (type, ev) => { const waits = []; listeners[type]({ ...ev, waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
  const pushJson = (obj) => fire('push', { data: { json: () => obj, text: () => JSON.stringify(obj) } });
  return { listeners, shown, opened, clients, fire, pushJson, caches };
}
