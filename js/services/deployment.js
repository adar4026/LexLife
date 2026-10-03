/* =========================================================
   deployment.js — где запущен LexLife (без зашитого base path).
   Все пути приложения относительные, поэтому один и тот же код
   работает и на GitHub Pages (/LexLife/), и на Cloudflare (/).

   Основной production — Cloudflare (PRIMARY_URL): единственный адрес,
   где работает сервер фоновых уведомлений. GitHub Pages — резервная
   копия: тот же код, но без серверного push (никаких запросов к /api,
   подписок и правил на сервере), с предупреждением в интерфейсе.
   ========================================================= */

export const PRIMARY_URL = 'https://lexlife.alexus4026.workers.dev/';
export const LEGACY_URL = 'https://adar4026.github.io/LexLife/';

/* Новый адрес для экрана переноса (на резервной копии — «перенести туда») */
export const NEW_HOME_URL = PRIMARY_URL;

const DEV_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/* Старая копия на GitHub Pages (adar4026.github.io/LexLife/) */
export const isLegacyPages = (loc = globalThis.location) => !!loc && /\.github\.io$/i.test(loc.hostname);

/* 'primary' — основной production (Cloudflare);
   'legacy'  — резервная копия на GitHub Pages;
   'dev'     — локальная разработка (wrangler dev, тестовые порты);
   'other'   — любой другой адрес (в т. ч. preview-версии Worker). */
export function deploymentRole(loc = globalThis.location, primary = PRIMARY_URL) {
  if (!loc) return 'other';
  if (isLegacyPages(loc)) return 'legacy';
  try { if (loc.origin === new URL(primary).origin) return 'primary'; } catch { /* неверный адрес */ }
  if (DEV_HOSTS.includes(loc.hostname)) return 'dev';
  return 'other';
}

/* Сервер push (/api) — только на основном адресе и локально для разработки.
   Резервная копия и чужие адреса не регистрируют устройство, не создают
   подписку и не отправляют правила: второй набор серверных уведомлений невозможен. */
export const serverPushAllowed = (loc = globalThis.location, primary = PRIMARY_URL) => ['primary', 'dev'].includes(deploymentRole(loc, primary));

/* Режим экрана переноса:
   'export' — старая копия (GitHub Pages): создать полную копию и перейти на новый адрес;
   'import' — новый адрес: восстановить копию из старой версии;
   null     — новый адрес неизвестен или это другой сайт (localhost и т. п.) — экран скрыт. */
export function migrationMode(loc = globalThis.location, target = NEW_HOME_URL) {
  if (!target || !loc) return null;
  let origin;
  try { origin = new URL(target).origin; } catch { return null; }
  if (isLegacyPages(loc)) return 'export';
  return loc.origin === origin ? 'import' : null;
}
