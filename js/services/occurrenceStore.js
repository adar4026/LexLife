/* =========================================================
   occurrenceStore.js — какие срабатывания уже показаны (push или
   локально). Общий для страницы и Service Worker: Cache API, кэш
   OCC_CACHE, ключи «<scope>__occ/<occurrenceId>». sw.js содержит
   такой же код (классический SW не импортирует модули).
   ========================================================= */

export const OCC_CACHE = 'lexlife-occ-v1';
const MAX_AGE_MS = 3 * 86400000;

export function createOccurrenceStore({ cachesApi = globalThis.caches, base } = {}) {
  const key = (id) => new URL(`__occ/${encodeURIComponent(id)}`, base).href;
  const open = () => cachesApi.open(OCC_CACHE);
  return {
    async has(id) {
      try { return !!(await (await open()).match(key(id))); } catch { return false; }
    },
    async mark(id, via) {
      try { await (await open()).put(key(id), new Response(JSON.stringify({ via, at: Date.now() }))); } catch { /* не критично */ }
    },
    async prune(now = Date.now()) {
      try {
        const c = await open();
        for (const req of await c.keys()) {
          const res = await c.match(req);
          const at = res ? (await res.json().catch(() => ({}))).at : 0;
          if (!at || now - at > MAX_AGE_MS) await c.delete(req);
        }
      } catch { /* не критично */ }
    },
  };
}
