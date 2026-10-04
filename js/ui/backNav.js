/* =========================================================
   js/ui/backNav.js — единая кнопка «Назад» (BackButton) и единый возврат (goBack).

   Внутренняя история LexLife. history.length для этого не годится: в Safari в нём
   и страницы до LexLife (history.back() уводит из приложения), а в PWA с экрана
   «Домой» он может быть > 1 и без истории LexLife. Поэтому каждая запись истории
   помечается глубиной history.state.lexDepth (и адресом предыдущей записи lexPrev):
     – первая запись сессии (открыли приложение / внутренний URL напрямую) — 0;
     – обычный переход (location.hash = …) — новая запись, глубина предыдущей + 1;
     – замена (replaceRoute → location.replace) — та же глубина, новой записи нет;
     – «Назад»/«Вперёд» по истории — глубина берётся из самой записи.
   Перезагрузка сохраняет history.state, поэтому глубина переживает и её.

   goBack(fallback): глубина > 0 — history.back() (ровно на тот экран LexLife, откуда
   пришли, он сам восстанавливает прокрутку/состояние из своей записи); глубина 0 —
   location.replace на fallback (без новой записи и без выхода из приложения).
   goBackTo(route) — после «Сохранить»/«Удалить»: на заданный экран (как было раньше),
   но если он и есть предыдущий — через history.back(), чтобы в истории не было дубля.
   Повторное нажатие до завершения перехода игнорируется — двойного возврата нет.

   Окно подменяется в тестах (initNavHistory(fakeWindow)), см. tests/back-nav.test.mjs.
   ========================================================= */

const DEPTH = 'lexDepth';
const PREV = 'lexPrev';
const PENDING_MS = 1000; // страховка: если hashchange не пришёл, кнопка снова работает

let win = null;
let depth = 0;
let current = null; // адрес текущей записи
let prev = null; // адрес предыдущей записи LexLife (null — её нет)
let replacing = null; // хеш, на который LexLife сейчас делает location.replace
let pendingUntil = 0; // до этого момента повторный goBack игнорируется

const readDepth = (s) => (s && Number.isInteger(s[DEPTH]) && s[DEPTH] >= 0 ? s[DEPTH] : null);
const toHash = (route) => (String(route).startsWith('#') ? String(route) : `#/${String(route).replace(/^\/+/, '')}`);

function stamp(d, p) {
  depth = d;
  prev = d > 0 ? p : null;
  try { win.history.replaceState({ ...(win.history.state || {}), [DEPTH]: depth, [PREV]: prev }, ''); } catch { /* Safari: лимит частоты replaceState */ }
}

function onHashChange() {
  pendingUntil = 0;
  const s = win.history.state;
  const known = readDepth(s);
  const isReplace = replacing !== null && win.location.hash === replacing;
  replacing = null;
  const from = current;
  current = win.location.hash;
  if (known !== null) { depth = known; prev = known > 0 && typeof s[PREV] === 'string' ? s[PREV] : null; return; } // переход по истории
  if (isReplace) stamp(depth, prev);
  else stamp(depth + 1, from);
}

/* Вызывается один раз при запуске, ДО подписки роутера на hashchange */
export function initNavHistory(w = window) {
  if (win) win.removeEventListener('hashchange', onHashChange);
  win = w;
  replacing = null;
  pendingUntil = 0;
  current = w.location.hash;
  const s = w.history.state;
  const known = readDepth(s);
  stamp(known ?? 0, known && typeof s[PREV] === 'string' ? s[PREV] : null);
  w.addEventListener('hashchange', onHashChange);
}

/* Есть ли куда вернуться внутри LexLife */
export const canGoBack = () => depth > 0;
export const navDepth = () => depth;
export const prevRoute = () => prev;

/* Перейти на маршрут, заменив текущую запись истории (без дубля и без новой глубины) */
export function replaceRoute(route) {
  const hash = toHash(route);
  if (win.location.hash === hash) return;
  replacing = hash;
  win.location.replace(hash);
}

/* Сменить адрес текущей записи без перехода (hashchange не будет) — глубина сохраняется */
export function replaceUrl(route) {
  try {
    win.history.replaceState({ [DEPTH]: depth, [PREV]: prev }, '', toHash(route));
    current = win.location.hash;
  } catch { /* Safari: лимит частоты replaceState */ }
}

/* Единый возврат: на предыдущий экран LexLife, а если его нет — на fallback */
export function goBack(fallback = 'home') {
  const now = Date.now();
  if (now < pendingUntil) return;
  pendingUntil = now + PENDING_MS;
  if (depth > 0) win.history.back();
  else replaceRoute(fallback);
}

/* После сохранения/удаления — на экран route: предыдущий — назад к нему, иначе заменой */
export function goBackTo(route) {
  const now = Date.now();
  if (now < pendingUntil) return;
  pendingUntil = now + PENDING_MS;
  if (depth > 0 && prev === toHash(route)) win.history.back();
  else replaceRoute(route);
}

/* Состояние экрана (вкладка, период, выбранная дата) — в его записи истории, рядом с
   прокруткой: «Назад» возвращает экран таким, каким его оставили, новый переход на тот же
   маршрут открывает его с настройками по умолчанию. Только простые значения (JSON). */
export function readEntryUi(key) {
  const s = win && win.history.state;
  return s && s.ui && typeof s.ui === 'object' ? s.ui[key] : undefined;
}
export function saveEntryUi(key, value) {
  try {
    const s = win.history.state || {};
    win.history.replaceState({ ...s, ui: { ...(s.ui || {}), [key]: value } }, '');
  } catch { /* Safari: лимит частоты replaceState */ }
}

/* Шеврон в духе SF Symbols «chevron.left»: скруглённые концы, без подписи */
const CHEVRON = '<svg class="back-btn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 4.75 7.75 12 15 19.25"/></svg>';

/* Круглая кнопка «Назад» для шапки внутреннего экрана.
   fallback — куда вернуться, если экран открыт напрямую; onBack — свой обработчик
   (например, сбросить черновик), который сам вызывает goBack(...). */
export function BackButton({ fallback = 'home', onBack, label = 'Назад', doc = document } = {}) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'back-btn';
  b.setAttribute('aria-label', label);
  b.innerHTML = CHEVRON;
  /* старый экран остаётся на месте, пока новый рендерится, — повторный тап по нему не считается */
  let busyUntil = 0;
  b.addEventListener('click', () => {
    const now = Date.now();
    if (now < busyUntil) return;
    busyUntil = now + PENDING_MS;
    if (onBack) onBack(); else goBack(fallback);
  });
  return b;
}
