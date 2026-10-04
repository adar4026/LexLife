/* =========================================================
   docViewer.js — «Документ анализа»: просмотр PDF и фото поверх приложения.
   • PDF — все страницы подряд с вертикальной прокруткой (локальный pdf.js,
     js/vendor/pdfjs), номер страницы «2 / 5», масштаб (−/+, щипок, двойной тап).
     Видимые страницы рисуются на canvas, далёкие — освобождаются (память iPhone).
   • JPG/PNG/HEIC — полноэкранно, щипок/двойной тап/колесо — масштаб, перетаскивание.
   • «Поделиться» — системное меню (сохранить в «Файлы», открыть в другом приложении),
     «Открыть отдельно» — файл в отдельном окне браузера.
   • Встроенный просмотр не удался (старый браузер, повреждённый файл) — понятное
     сообщение и те же «Открыть отдельно» / «Поделиться».
   • Все временные ресурсы (Blob URL, pdf.js-документ и его worker, canvas,
     наблюдатели, обработчики) принадлежат DocSession и освобождаются при закрытии.
   ========================================================= */

const PDFJS_URL = new URL('../vendor/pdfjs/pdf.min.js', import.meta.url).href;
const PDFJS_WORKER_URL = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
const ZOOMS = [1, 1.5, 2, 3, 4];
const MAX_CANVAS_PX = 5_000_000; // один canvas не больше ~5 Мпикс (лимиты памяти iOS)

/* ---------- Сессия просмотра: владелец временных ресурсов ----------
   url(blob) — Blob URL, живёт до close(); onClose(fn) — очистка; close() — идемпотентно:
   очистки в обратном порядке (ошибка одной не мешает остальным), затем revoke всех URL. */
export class DocSession {
  constructor(urlApi = URL) {
    this.urlApi = urlApi;
    this.urls = new Set();
    this.cleanups = [];
    this.closed = false;
  }
  url(blob) {
    if (this.closed) throw new Error('DocSession closed');
    const u = this.urlApi.createObjectURL(blob);
    this.urls.add(u);
    return u;
  }
  onClose(fn) {
    if (this.closed) { try { fn(); } catch { /* уже закрыто */ } return; }
    this.cleanups.push(fn);
  }
  close() {
    if (this.closed) return false;
    this.closed = true;
    for (const fn of this.cleanups.splice(0).reverse()) {
      try { fn(); } catch { /* освобождаем остальное */ }
    }
    for (const u of this.urls) {
      try { this.urlApi.revokeObjectURL(u); } catch { /* уже освобождён */ }
    }
    this.urls.clear();
    return true;
  }
}

/* Масштаб PDF: следующий шаг из ZOOMS / ближайший к произвольному (после щипка) */
export function stepZoom(z, dir) {
  if (dir > 0) return ZOOMS.find((s) => s > z + 1e-6) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find((s) => s < z - 1e-6) ?? ZOOMS[0];
}
export const clampZoom = (z) => Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));

/* Плотность пикселей canvas: DPR ≤ 2 и не больше MAX_CANVAS_PX на страницу */
export function canvasScale(cssW, cssH, dpr) {
  let s = Math.min(dpr || 1, 2);
  if (cssW * cssH * s * s > MAX_CANVAS_PX) s = Math.sqrt(MAX_CANVAS_PX / (cssW * cssH));
  return Math.max(0.5, s);
}

/* ---------- мелкие DOM-хелперы (модуль самостоятельный) ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const fmtSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`);
const kindOf = (type) => (type === 'application/pdf' ? 'pdf' : /^image\//.test(type || '') ? 'image' : 'other');

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
    pdfjsPromise.catch(() => { pdfjsPromise = null; }); // следующая попытка — заново
  }
  return pdfjsPromise;
}

let current = null; // открытый просмотр (одновременно — только один)

/* Открыть просмотр. file — File (имя, тип, данные).
   opts: { lockScroll, unlockScroll } — блокировка прокрутки страницы под просмотром.
   → { session, close, ready } (ready — Promise: PDF/фото показаны или показан запасной вариант) */
export function openDocViewer(file, { lockScroll = () => {}, unlockScroll = () => {}, title = 'Документ анализа' } = {}) {
  if (current) current.close();
  const session = new DocSession();
  const kind = kindOf(file.type);
  const canShare = !!(navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch { return false; } })());
  const url = session.url(file);
  const opener = document.activeElement;

  const root = h(`
    <div class="docv" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="docv__bar">
        <button class="docv__btn" type="button" data-act="close">‹ Закрыть</button>
        <div class="docv__head">
          <span class="docv__eyebrow">${esc(title)}</span>
          <span class="docv__title"></span>
        </div>
        <span class="docv__pages" aria-live="polite"></span>
      </div>
      <div class="docv__body"></div>
      <div class="docv__tools">
        <div class="docv__zoom" hidden>
          <button class="docv__tool docv__tool--sq" type="button" data-act="zoom-out" aria-label="Уменьшить">−</button>
          <span class="docv__zoomval">100%</span>
          <button class="docv__tool docv__tool--sq" type="button" data-act="zoom-in" aria-label="Увеличить">+</button>
        </div>
        <button class="docv__tool" type="button" data-act="${canShare ? 'share' : 'save'}">${canShare ? 'Поделиться' : 'Сохранить'}</button>
        <button class="docv__tool" type="button" data-act="open">Открыть отдельно</button>
      </div>
    </div>
  `);
  root.querySelector('.docv__title').textContent = file.name || 'Документ';
  const body = root.querySelector('.docv__body');
  const pagesEl = root.querySelector('.docv__pages');
  const zoomBox = root.querySelector('.docv__zoom');
  const zoomVal = root.querySelector('.docv__zoomval');

  let zoomApi = null; // { in(), out(), label() } — у PDF и у фото свой

  const fallback = (reason) => {
    zoomBox.hidden = true;
    pagesEl.textContent = '';
    body.innerHTML = `
      <div class="docv__msg">
        <p class="docv__msg-title">Встроенный просмотр недоступен</p>
        <p>${esc(reason)}</p>
        <p class="docv__msg-file">${esc(file.name || 'Документ')} · ${esc(fmtSize(file.size))}</p>
        <div class="docv__msg-actions">
          <button class="btn-primary" type="button" data-act="open">Открыть отдельно</button>
          ${canShare ? '<button class="btn-ghost" type="button" data-act="share">Поделиться</button>' : '<button class="btn-ghost" type="button" data-act="save">Сохранить файл</button>'}
        </div>
      </div>`;
  };

  /* Действия. share вызывается синхронно из касания — иначе iOS отклонит системное меню. */
  const onClick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !root.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'close') close();
    else if (act === 'share') navigator.share({ files: [file] }).catch(() => { /* отменено */ });
    else if (act === 'open') openSeparately();
    else if (act === 'save') saveFile();
    else if (act === 'zoom-in' && zoomApi) zoomApi.in();
    else if (act === 'zoom-out' && zoomApi) zoomApi.out();
  };
  function openSeparately() {
    const w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch { /* другое окно */ } return; }
    /* всплывающие окна запрещены (часть PWA) — ссылка с target=_blank */
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function saveFile() {
    const a = document.createElement('a');
    a.href = url; a.download = file.name || 'document';
    document.body.appendChild(a); a.click(); a.remove();
  }
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if ((e.key === '+' || e.key === '=') && zoomApi) zoomApi.in();
    else if (e.key === '-' && zoomApi) zoomApi.out();
  };
  /* iOS Safari: щипок внутри просмотра не должен масштабировать всю страницу */
  const stopGesture = (e) => e.preventDefault();

  function close() {
    if (!session.close()) return;
    if (current && current.session === session) current = null;
  }
  session.onClose(() => {
    root.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    root.removeEventListener('gesturestart', stopGesture);
    root.removeEventListener('gesturechange', stopGesture);
    root.remove();
    unlockScroll();
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
  });
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close); // «Назад» браузера/переход — закрыть просмотр
  root.addEventListener('gesturestart', stopGesture);
  root.addEventListener('gesturechange', stopGesture);

  lockScroll();
  document.body.appendChild(root);
  root.querySelector('[data-act="close"]').focus({ preventScroll: true });

  let ready;
  if (kind === 'pdf') {
    ready = renderPdf({ file, body, session, pagesEl, zoomBox, zoomVal, fallback, setZoomApi: (z) => { zoomApi = z; } });
  } else if (kind === 'image') {
    ready = renderImage({ file, url, body, session, zoomBox, zoomVal, fallback, setZoomApi: (z) => { zoomApi = z; } });
  } else {
    fallback('Этот тип файла нельзя показать внутри приложения.');
    ready = Promise.resolve({ ok: false });
  }
  const api = { session, close, ready, root };
  current = api;
  return api;
}

/* ---------- PDF: все страницы ---------- */
async function renderPdf({ file, body, session, pagesEl, zoomBox, zoomVal, fallback, setZoomApi }) {
  body.innerHTML = '<div class="docv__loading">Открываю документ…</div>';
  let lib;
  let pdf;
  try {
    lib = await loadPdfjs();
    if (session.closed) return { ok: false, closed: true };
    const data = new Uint8Array(await file.arrayBuffer());
    const task = lib.getDocument({ data, isEvalSupported: false, enableXfa: false, useSystemFonts: true });
    session.onClose(() => { task.destroy().catch(() => {}); });
    pdf = await task.promise;
  } catch (err) {
    if (session.closed) return { ok: false, closed: true };
    const pwd = err && err.name === 'PasswordException';
    fallback(pwd ? 'Документ защищён паролем.' : lib ? 'Не удалось прочитать PDF.' : 'Этот браузер не поддерживает встроенный просмотр PDF.');
    return { ok: false, error: err };
  }
  if (session.closed) return { ok: false, closed: true };

  const n = pdf.numPages;
  const pages = [];
  try {
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      if (session.closed) return { ok: false, closed: true };
      const vp = page.getViewport({ scale: 1 });
      pages.push({ i, page, w: vp.width, h: vp.height, el: null, canvas: null, task: null, renderedAt: 0 });
    }
  } catch (err) {
    if (!session.closed) fallback('Не удалось прочитать страницы PDF.');
    return { ok: false, error: err };
  }

  body.innerHTML = '';
  body.classList.add('docv__body--pdf');
  const stack = h('<div class="docv__stack"></div>');
  body.appendChild(stack);
  pages.forEach((p) => {
    p.el = h(`<div class="docv__page" data-page="${p.i}"><span class="docv__pageno">${p.i}</span></div>`);
    p.el.setAttribute('aria-label', `Страница ${p.i} из ${n}`);
    stack.appendChild(p.el);
  });

  let zoom = 1;
  let baseW = 0;
  const dpr = () => window.devicePixelRatio || 1;
  const pageWidth = () => Math.floor(baseW * zoom);
  function layout() {
    baseW = Math.max(200, body.clientWidth - 16);
    const w = pageWidth();
    pages.forEach((p) => {
      p.el.style.width = `${w}px`;
      p.el.style.height = `${Math.round((w * p.h) / p.w)}px`;
    });
    stack.classList.toggle('is-zoomed', zoom > 1);
  }
  function release(p) {
    if (p.task) { try { p.task.cancel(); } catch { /* уже */ } p.task = null; }
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.renderedAt = 0;
  }
  function draw(p) {
    const w = pageWidth();
    if (p.renderedAt === w || p.task || session.closed) return;
    const cssH = (w * p.h) / p.w;
    const s = canvasScale(w, cssH, dpr());
    const vp = p.page.getViewport({ scale: (w / p.w) * s });
    const canvas = document.createElement('canvas');
    canvas.className = 'docv__canvas';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    p.task = task;
    task.promise.then(() => {
      if (p.task !== task || session.closed) { canvas.width = 0; canvas.height = 0; return; }
      p.task = null;
      if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); }
      p.canvas = canvas;
      p.renderedAt = w;
      p.el.appendChild(canvas);
    }, () => { if (p.task === task) p.task = null; canvas.width = 0; canvas.height = 0; });
  }

  /* Рисуем видимые страницы (+ по экрану сверху и снизу), остальные освобождаем */
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      const p = pages[Number(e.target.dataset.page) - 1];
      if (e.isIntersecting) { visible.add(p); draw(p); } else { visible.delete(p); release(p); }
    });
  }, { root: body, rootMargin: '100% 0px' });
  pages.forEach((p) => io.observe(p.el));

  /* Номер текущей страницы: та, что пересекает верхнюю треть экрана */
  let raf = 0;
  const updatePageNo = () => {
    raf = 0;
    const mark = body.scrollTop + body.clientHeight / 3;
    let cur = 1;
    for (const p of pages) { if (p.el.offsetTop <= mark) cur = p.i; else break; }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) cur = n;
    pagesEl.textContent = `${cur} / ${n}`;
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(updatePageNo); };
  body.addEventListener('scroll', onScroll, { passive: true });

  function setZoom(z, cx = body.clientWidth / 2, cy = body.clientHeight / 2) {
    const nz = clampZoom(z);
    if (Math.abs(nz - zoom) < 1e-3) return;
    const fx = (body.scrollLeft + cx) / body.scrollWidth;
    const fy = (body.scrollTop + cy) / body.scrollHeight;
    zoom = nz;
    layout();
    body.scrollLeft = fx * body.scrollWidth - cx;
    body.scrollTop = fy * body.scrollHeight - cy;
    zoomVal.textContent = `${Math.round(zoom * 100)}%`;
    visible.forEach(draw); // остальные дорисует IntersectionObserver
    updatePageNo();
  }
  setZoomApi({ in: () => setZoom(stepZoom(zoom, 1)), out: () => setZoom(stepZoom(zoom, -1)) });
  zoomBox.hidden = false;

  /* Щипок: предпросмотр CSS-трансформацией, по окончании — перерисовка в новом масштабе */
  const pinch = pinchTracker(body, {
    onMove: (k, cx, cy) => {
      const r = body.getBoundingClientRect();
      stack.style.transformOrigin = `${cx - r.left + body.scrollLeft}px ${cy - r.top + body.scrollTop}px`;
      stack.style.transform = `scale(${clampZoom(zoom * k) / zoom})`;
    },
    onEnd: (k, cx, cy) => {
      stack.style.transform = '';
      stack.style.transformOrigin = '';
      const r = body.getBoundingClientRect();
      setZoom(zoom * k, cx - r.left, cy - r.top);
    },
    onDoubleTap: (cx, cy) => {
      const r = body.getBoundingClientRect();
      setZoom(zoom > 1 ? 1 : 2, cx - r.left, cy - r.top);
    },
  });
  const onResize = () => { layout(); visible.forEach(draw); updatePageNo(); };
  window.addEventListener('resize', onResize);

  session.onClose(() => {
    io.disconnect();
    pinch.destroy();
    body.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    if (raf) cancelAnimationFrame(raf);
    pages.forEach((p) => { release(p); try { p.page.cleanup(); } catch { /* уже */ } });
    try { pdf.destroy(); } catch { /* уже */ }
  });

  layout();
  updatePageNo();
  return { ok: true, pages: n };
}

/* ---------- Фото: полноэкранно с масштабированием ---------- */
function renderImage({ file, url, body, session, zoomBox, zoomVal, fallback, setZoomApi }) {
  body.innerHTML = '';
  body.classList.add('docv__body--image');
  const img = h('<img class="docv__img" alt="" draggable="false">');
  img.alt = file.name || 'Фото анализа';
  body.appendChild(img);

  let s = 1, x = 0, y = 0; // масштаб и сдвиг (px) относительно центра
  const MAX = 6;
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    zoomVal.textContent = `${Math.round(s * 100)}%`;
  };
  const bound = () => {
    const bw = body.clientWidth, bh = body.clientHeight;
    const iw = img.clientWidth * s, ih = img.clientHeight * s;
    const mx = Math.max(0, (iw - bw) / 2), my = Math.max(0, (ih - bh) / 2);
    x = Math.min(mx, Math.max(-mx, x));
    y = Math.min(my, Math.max(-my, y));
  };
  /* Масштаб вокруг точки (cx, cy) в координатах окна */
  function zoomAt(ns, cx, cy) {
    ns = Math.min(MAX, Math.max(1, ns));
    const r = body.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    x = px - ((px - x) * ns) / s;
    y = py - ((py - y) * ns) / s;
    s = ns;
    if (s === 1) { x = 0; y = 0; }
    bound();
    apply();
  }
  const center = () => { const r = body.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  setZoomApi({ in: () => zoomAt(s * 1.5, ...center()), out: () => zoomAt(s / 1.5, ...center()) });

  let base = 1;
  const pinch = pinchTracker(body, {
    onStart: () => { base = s; },
    onMove: (k, cx, cy) => zoomAt(base * k, cx, cy),
    onPan: (dx, dy) => { if (s > 1) { x += dx; y += dy; bound(); apply(); } },
    onDoubleTap: (cx, cy) => zoomAt(s > 1 ? 1 : 2.5, cx, cy),
    panOnlyWhen: () => s > 1,
  });
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey && s === 1) return;
    e.preventDefault();
    zoomAt(s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
  };
  body.addEventListener('wheel', onWheel, { passive: false });
  session.onClose(() => {
    pinch.destroy();
    body.removeEventListener('wheel', onWheel);
    img.removeAttribute('src'); // отпустить декодированное изображение
  });

  return new Promise((resolve) => {
    img.addEventListener('load', () => { zoomBox.hidden = false; apply(); resolve({ ok: true }); }, { once: true });
    img.addEventListener('error', () => {
      if (!session.closed) fallback(/heic|heif/.test(file.type) ? 'Этот браузер не показывает фото HEIC.' : 'Не удалось показать фото.');
      resolve({ ok: false });
    }, { once: true });
    img.src = url;
  });
}

/* ---------- Жесты: щипок, перетаскивание, двойной тап (Pointer Events) ----------
   onStart(), onMove(scaleFromStart, cx, cy), onEnd(scaleFromStart, cx, cy),
   onPan(dx, dy) — одним пальцем/мышью, onDoubleTap(x, y).
   panOnlyWhen() → true — одиночный жест перехватывается (иначе остаётся прокруткой). */
function pinchTracker(el, { onStart, onMove, onEnd, onPan, onDoubleTap, panOnlyWhen } = {}) {
  const pts = new Map();
  let startDist = 0, lastK = 1, lastC = [0, 0];
  let lastTap = 0, lastTapXY = [0, 0], moved = false;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...pts.values()]; return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };

  const down = (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 2) {
      startDist = dist() || 1; lastK = 1; lastC = mid();
      if (onStart) onStart();
    }
    if (pts.size === 1 && panOnlyWhen && panOnlyWhen()) { try { el.setPointerCapture(e.pointerId); } catch { /* нет */ } }
  };
  const move = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) {
      e.preventDefault();
      lastK = dist() / startDist; lastC = mid();
      if (onMove) onMove(lastK, ...lastC);
    } else if (pts.size === 1 && onPan && panOnlyWhen && panOnlyWhen()) {
      e.preventDefault();
      onPan(dx, dy);
    }
  };
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const wasPinch = pts.size === 2;
    pts.delete(e.pointerId);
    if (wasPinch) { if (onEnd) onEnd(lastK, ...lastC); return; }
    if (pts.size === 0 && !moved && e.type === 'pointerup' && onDoubleTap) {
      const now = Date.now();
      if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapXY[0], e.clientY - lastTapXY[1]) < 30) {
        lastTap = 0;
        onDoubleTap(e.clientX, e.clientY);
      } else { lastTap = now; lastTapXY = [e.clientX, e.clientY]; }
    }
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: false });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return {
    destroy() {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      pts.clear();
    },
  };
}
