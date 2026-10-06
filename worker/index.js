/* =========================================================
   worker/index.js — LexLife на Cloudflare Workers + Static Assets.
   Один Worker, один origin:
   - статический PWA из dist/ (binding ASSETS, приложение от корня /)
   - /api/* — Web Push backend (D1: binding DB)
   - scheduled — Cron Trigger раз в минуту (due-уведомления)
   ========================================================= */

import { handleApi } from './api.js';
import { runCron } from './cron.js';
import { withSecurityHeaders } from './headers.js';
import { logCron } from './log.js';

async function serveAsset(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
  /* start_url манифеста и предкэш SW запрашивают ./index.html: отдаём его без
     редиректа на «/» (редирект ломает ответ SW на навигацию) */
  if (url.pathname === '/index.html') url.pathname = '/';
  const res = await env.ASSETS.fetch(new Request(url, request));
  if (url.pathname === '/sw.js' && res.ok) {
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'no-cache');
    return out;
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const res = url.pathname.startsWith('/api/')
      ? await handleApi(request, env)
      : await serveAsset(request, env);
    return withSecurityHeaders(res);
  },

  async scheduled(event, env, ctx) {
    const startedAt = Date.now();
    ctx.waitUntil(runCron(env, event.scheduledTime).then((s) => {
      /* итог запуска: только счётчики (подробности — по строке на доставку, worker/log.js) */
      if (s.due || s.retried) logCron(s, event.scheduledTime, startedAt);
    }).catch((err) => {
      console.error(JSON.stringify({ evt: 'cron_error', scheduled_at: new Date(event.scheduledTime).toISOString(), error: err && err.name, message: String(err && err.message || '').slice(0, 200) }));
      throw err;
    }));
  },
};
