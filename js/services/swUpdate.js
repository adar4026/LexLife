/* =========================================================
   swUpdate.js — переход открытой вкладки на новую версию после deploy.

   Почему это нужно: sw.js отдаёт оболочку cache-first. При запуске документ и модули
   приходят из кэша СТАРОЙ версии, и только потом браузер находит новый sw.js, ставит его
   (skipWaiting) и тот забирает вкладку (clients.claim). Уже загруженные ES-модули при этом
   не меняются — hash-навигация так и продолжает работать на старом коде до перезагрузки.

   Протокол (sw.js ↔ страница):
     • новый SW в activate, если это ОБНОВЛЕНИЕ (были кэши прежних версий), шлёт каждой
       вкладке { type: UPDATE_MSG, version } с MessageChannel и ждёт подтверждения;
     • вкладка отвечает { ok: true } и сама перезагружается один раз — сразу или, если
       открыта форма / есть несохранённый ввод, при следующем безопасном переходе;
     • вкладка, не ответившая (старый код без этого протокола), перезагружается самим
       SW через WindowClient.navigate() — один раз, только в момент активации.

   Защита от цикла: перезагрузка не чаще одного раза на версию в этой вкладке
   (sessionStorage RELOAD_KEY = версия) и не больше одной на документ. Сообщение
   приходит только из activate, а activate бывает один раз на установку версии.
   Пользовательские данные (localStorage, IndexedDB, push-подписка) не затрагиваются:
   перезагрузка документа ≠ очистка хранилища.
   ========================================================= */

export const UPDATE_MSG = 'lexlife:update-ready';
export const VERSION_MSG = 'lexlife:version';
export const RELOAD_KEY = 'lexlife:update-reload';
/* проверка sw.js при возврате в приложение — не чаще раза в минуту */
export const UPDATE_CHECK_MS = 60 * 1000;

/* Маршруты-формы: перезагрузка потеряла бы введённое (черновик сна живёт только в памяти) */
export const FORM_ROUTE_RE = /^(?:visit\/new|visit\/.+\/edit|sleep\/new(?:\/.*)?|sleep\/(?!settings$).+|med\/new|med\/.+\/edit|test\/new|test\/.+\/edit)$/;
export const isFormRoute = (route) => FORM_ROUTE_RE.test(String(route || '').replace(/^#\/?/, ''));

/* Есть ли в дереве поле, изменённое пользователем и ещё не сохранённое:
   значение отличается от исходного (defaultValue / defaultChecked / defaultSelected).
   Форма заполняет поля сохранёнными данными через defaultValue — это исходное значение,
   не правка. Виджеты без поля ввода (степпер и т. п.) отмечают изменённость атрибутом
   data-unsaved на своём контейнере. */
export function hasUnsavedInput(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return false;
  if (typeof root.querySelector === 'function' && root.querySelector('[data-unsaved]')) return true;
  for (const f of root.querySelectorAll('input, textarea, select')) {
    const type = String(f.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') { if (f.checked !== f.defaultChecked) return true; continue; }
    if (type === 'file') { if (f.files && f.files.length) return true; continue; }
    if (String(f.tagName).toUpperCase() === 'SELECT') {
      if (Array.from(f.options || []).some((o) => o.selected !== o.defaultSelected)) return true;
      continue;
    }
    if (type === 'hidden' || type === 'button' || type === 'submit') continue;
    if (f.value !== f.defaultValue) return true;
  }
  return false;
}

/* Состояние обновления одной вкладки.
   reload() — перезагрузить документ; session — sessionStorage (может бросать: Safari private);
   isSafe() — можно ли перезагрузиться прямо сейчас без потери ввода. */
export function createUpdateController({ reload, session, isSafe = () => true, now = () => Date.now() }) {
  let pending = null; // версия, ждущая безопасного момента
  let reloading = false; // документ уже уходит на перезагрузку
  let lastCheck = -Infinity;

  const readGuard = () => { try { return session ? session.getItem(RELOAD_KEY) : null; } catch { return null; } };
  const writeGuard = (v) => { try { if (session) session.setItem(RELOAD_KEY, v); } catch { /* без guard'а остаётся предел «один раз на документ» */ } };

  function tryReload() {
    if (pending == null || reloading) return false;
    if (!isSafe()) return false;
    reloading = true;
    writeGuard(pending);
    reload();
    return true;
  }

  return {
    /* SW сообщил: активна новая версия, а этот документ загружен до неё.
       'reload' — перезагружаемся; 'deferred' — ждём безопасного момента;
       'guard' — ради этой версии вкладка уже перезагружалась (цикла нет);
       'already' — перезагрузка уже идёт. */
    onUpdateReady(version) {
      const v = String(version || 'unknown');
      if (reloading) return 'already';
      if (readGuard() === v) return 'guard';
      pending = v;
      return tryReload() ? 'reload' : 'deferred';
    },
    /* безопасный момент: экран сменился, приложение вернулось на передний план */
    retry: () => tryReload(),
    /* пора ли спросить сервер о новом sw.js (троттлинг) */
    shouldCheck() {
      const t = now();
      if (t - lastCheck < UPDATE_CHECK_MS) return false;
      lastCheck = t;
      return true;
    },
    get pending() { return pending; },
    get reloading() { return reloading; },
  };
}
