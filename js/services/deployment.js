/* =========================================================
   deployment.js — где запущен LexLife (без зашитого base path).
   Все пути приложения относительные, поэтому один и тот же код
   работает и на GitHub Pages (/LexLife/), и на Cloudflare (/).

   NEW_HOME_URL — адрес нового production на Cloudflare. Пока null:
   экран переноса скрыт. Заполняется только после проверки
   нового production (отдельное решение владельца).
   ========================================================= */

export const NEW_HOME_URL = null;

/* Старая копия на GitHub Pages (adar4026.github.io/LexLife/) */
export const isLegacyPages = (loc = globalThis.location) => !!loc && /\.github\.io$/i.test(loc.hostname);

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
