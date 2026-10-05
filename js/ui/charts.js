/* =========================================================
   charts.js — лёгкие интерактивные SVG-графики без библиотек
   • lineChart — измерения во времени (вес, давление, пульс…): все точки,
     ось X пропорциональна датам (пропуски видны), цель/тренд — отдельными линиями.
   • barChart — дневные (или агрегированные) столбцы: вода, активность.
     «Нет данных» — пустой слот, реальный 0 — отметка у базовой линии.
   Тап/перетаскивание по графику выбирает ближайшую дату, карточка значения —
   над графиком. touch-action: pan-y — вертикальный жест остаётся прокруткой страницы.
   Перерисовка — только при изменении ширины (ResizeObserver) и выборе точки.
   ========================================================= */

const DAY_MS = 86400000;
const RU = 'ru-RU';
const H = 200;          // высота SVG, включая полосу подписей оси X
const PAD_T = 14;
const PAD_B = 28;
const PAD_R = 10;
const TICK_FONT = 11;
const MIN_DOT_GAP = 9;  // точки плотнее — рисуется только линия + последняя/выбранная точка

const escXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const utc = (day) => new Date(day * DAY_MS);

function fmtTick(day, span) {
  const d = utc(day);
  if (span > 400) return d.toLocaleDateString(RU, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return d.toLocaleDateString(RU, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
const fmtAxis = (v, step) => v.toLocaleString(RU, { maximumFractionDigits: step < 1 ? (step < 0.1 ? 2 : 1) : 0 });

function niceStep(span, count) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}
/* Ось Y: «круглые» деления, минимальный размах minSpan (чтобы шум не выглядел скачком) */
function yScale(lo, hi, { zero = false, minSpan = 1, step: fixedStep = null } = {}) {
  if (zero) lo = 0;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = zero ? 0 : mid - minSpan / 2;
    hi = zero ? Math.max(hi, minSpan) : mid + minSpan / 2;
  }
  const step = fixedStep || niceStep(hi - lo, 4);
  const nlo = Math.floor(lo / step + 1e-9) * step;
  const nhi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo: nlo, hi: nhi, ticks, step };
}
/* Деления оси X: 3–5 дат, равномерно по периоду */
function xTicks(start, end) {
  const span = end - start;
  if (span <= 0) return [start];
  const n = span <= 6 ? span + 1 : 4;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(start + (span * i) / (n - 1)));
  return [...new Set(out)];
}
function nearestIndex(sortedDays, day) {
  let lo = 0, hi = sortedDays.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedDays[mid] < day) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(sortedDays[lo - 1] - day) <= Math.abs(sortedDays[lo] - day)) return lo - 1;
  return lo;
}

/* Если записи начинаются заметно позже начала периода (> 15 % его длины) —
   ось X начинается с первой записи, чтобы точки не сжимались у правого края */
function fitRange(range, firstDay) {
  if (firstDay == null || firstDay - range.start <= (range.end - range.start) * 0.15) return null;
  return { start: Math.min(firstDay, range.end - 6), end: range.end };
}
const fmtFull = (day) => utc(day).toLocaleDateString(RU, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/* Общая «рамка»: карточка значения + область графика + легенда (+ пояснение об оси) */
function frame({ ariaLabel, legend, note }) {
  const root = document.createElement('div');
  root.className = 'chart';
  root.innerHTML = `<div class="chart__readout" aria-live="polite"></div><div class="chart__plot" tabindex="0" role="img"></div>${legend ? `<div class="chart__legend">${legend}</div>` : ''}${note ? `<p class="chart__note">${escXml(note)}</p>` : ''}`;
  const plot = root.querySelector('.chart__plot');
  plot.setAttribute('aria-label', ariaLabel || 'График');
  return { root, plot, readout: root.querySelector('.chart__readout') };
}

/* Выбор точки: касание/перетаскивание (горизонтальное), мышь, стрелки клавиатуры */
/* Касание: выбор по тапу (pointerup) или горизонтальному ведению пальцем; если браузер
   начал вертикальную прокрутку (pan-y), приходит pointercancel — выбор не меняется. */
function bindPointer(plot, { onPick, onStep }) {
  let active = false, sx = 0, sy = 0;
  const pick = (e) => { const r = plot.getBoundingClientRect(); onPick(e.clientX - r.left); };
  const isMouse = (e) => e.pointerType === 'mouse';
  plot.addEventListener('pointerdown', (e) => { active = true; sx = e.clientX; sy = e.clientY; if (isMouse(e)) pick(e); });
  plot.addEventListener('pointermove', (e) => {
    if (isMouse(e)) pick(e);
    else if (active && Math.abs(e.clientX - sx) > Math.abs(e.clientY - sy)) pick(e);
  });
  plot.addEventListener('pointerup', (e) => { if (active && !isMouse(e)) pick(e); active = false; });
  ['pointercancel', 'pointerleave'].forEach((t) => plot.addEventListener(t, () => { active = false; }));
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onStep(e.key === 'ArrowLeft' ? -1 : 1); }
  });
}
function observeWidth(plot, draw) {
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(plot.clientWidth);
    if (w && w !== lastW) { lastW = w; draw(w); }
  });
  ro.observe(plot);
}
const leftPad = (labels) => Math.max(26, Math.max(...labels.map((s) => s.length)) * 6.6 + 8);

function gridSvg(ys, x0, x1, y, labels) {
  return ys.ticks.map((v, i) => {
    const yy = y(v).toFixed(1);
    return `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" class="chart__grid"/><text x="${x0 - 6}" y="${yy}" dy="0.35em" text-anchor="end" class="chart__tick">${escXml(labels[i])}</text>`;
  }).join('');
}
function xAxisSvg(range, x) {
  const span = range.end - range.start;
  return xTicks(range.start, range.end).map((d, i, arr) => {
    const anchor = arr.length > 1 && i === 0 ? 'start' : arr.length > 1 && i === arr.length - 1 ? 'end' : 'middle';
    return `<text x="${x(d).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" class="chart__tick">${escXml(fmtTick(d, span))}</text>`;
  }).join('');
}
/* Свои подписи оси X ([{ day, label }]: «Пн…Вс», «1 5 10…», «Янв…»); крайние не выходят за поле,
   подпись, которая налезла бы на предыдущую (узкий экран), пропускается — значение есть в карточке над графиком */
function customXAxisSvg(labels, x, x0, x1) {
  let lastRight = -Infinity;
  return labels.map(({ day, label }) => {
    const cx = x(day);
    const w = String(label).length * 7;
    const anchor = cx - w / 2 < x0 - 4 ? 'start' : cx + w / 2 > x1 + 4 ? 'end' : 'middle';
    const left = anchor === 'start' ? cx : anchor === 'end' ? cx - w : cx - w / 2;
    if (left < lastRight + 6) return '';
    lastRight = left + w;
    return `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" class="chart__tick">${escXml(label)}</text>`;
  }).join('');
}
/* Линия цели — пунктир; подпись цели — в легенде (не перекрывает точки данных) */
function goalSvg(goals, x0, x1, y, ys) {
  return goals.filter((g) => g.value >= ys.lo && g.value <= ys.hi).map((g) => {
    const yy = y(g.value).toFixed(1);
    return `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" class="chart__goal"/>`;
  }).join('');
}

/* ---------- Линейный график ----------
   range: { start, end } (номера дней); series: [{ key, label, color, points:[{day, value}] }];
   goals: [{ value, label }] — цель(и), goalLegend — общая подпись целей в легенде; trend: { from:{day,value}, to:{day,value} } | null;
   readout(day) → HTML карточки значения (данные экранирует вызывающий). */
/* Необязательно: yFormat(v, step) — подписи оси Y (например, время суток); domain { lo, hi } — диапазон,
   который всегда входит в шкалу (оценка 1–5); xLabels — свои подписи оси X; fit: false — ось X
   всегда на весь период (календарная неделя/месяц/год); yStep — свой шаг делений оси Y. */
export function lineChart({ range, series, goals = [], goalLegend = '', trend = null, minSpan = 1, readout, ariaLabel, yFormat = null, domain = null, xLabels = null, fit = true, yStep = null }) {
  const multi = series.length > 1;
  const legend = [
    ...(multi ? series.map((s) => `<span class="chart__key"><i class="chart__swatch" style="background:${s.color}"></i>${escXml(s.label)}</span>`) : []),
    ...(goals.length ? [`<span class="chart__key"><i class="chart__swatch chart__swatch--goal"></i>${escXml(goalLegend || goals.map((g) => g.label).join(' · '))}</span>`] : []),
    ...(trend ? ['<span class="chart__key"><i class="chart__swatch chart__swatch--trend"></i>линия тренда</span>'] : []),
  ].join('');
  const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.day)))].sort((a, b) => a - b);
  const fitted = fit ? fitRange(range, days[0]) : null;
  const view = fitted || range;
  const { root, plot, readout: out } = frame({ ariaLabel, legend, note: fitted ? `Ось начинается с первой записи периода: ${fmtFull(days[0])}` : '' });
  let sel = days.length - 1;
  let geo = null;

  /* Цель включается в шкалу, если она рядом с данными; иначе — подпись у края */
  const vals = series.flatMap((s) => s.points.map((p) => p.value));
  const dataLo = Math.min(...vals), dataHi = Math.max(...vals);
  const reach = Math.max(dataHi - dataLo, minSpan) * 2;
  const shownGoals = goals.filter((g) => g.value >= dataLo - reach && g.value <= dataHi + reach);
  const hiddenGoals = goals.filter((g) => !shownGoals.includes(g));
  const lo = Math.min(dataLo, ...shownGoals.map((g) => g.value), ...(domain ? [domain.lo] : []));
  const hi = Math.max(dataHi, ...shownGoals.map((g) => g.value), ...(domain ? [domain.hi] : []));
  const ys = yScale(lo, hi, { minSpan, step: yStep });
  const yLabels = ys.ticks.map((v) => (yFormat ? yFormat(v, ys.step) : fmtAxis(v, ys.step)));

  function draw(W) {
    const x0 = leftPad(yLabels), x1 = W - PAD_R;
    const spanD = Math.max(1, view.end - view.start);
    const x = (d) => x0 + ((d - view.start) / spanD) * (x1 - x0);
    const y = (v) => PAD_T + (1 - (v - ys.lo) / (ys.hi - ys.lo)) * (H - PAD_T - PAD_B);
    geo = { x, y, x0, x1 };
    let svg = gridSvg(ys, x0, x1, y, yLabels) + (xLabels ? customXAxisSvg(xLabels, x, x0, x1) : xAxisSvg(view, x)) + goalSvg(shownGoals, x0, x1, y, ys);
    if (hiddenGoals.length) {
      svg += hiddenGoals.map((g, i) => `<text x="${x1}" y="${PAD_T + 10 + i * 14}" text-anchor="end" class="chart__goal-lbl">${escXml(g.label)} ${g.value > hi ? '↑' : '↓'}</text>`).join('');
    }
    if (trend) svg += `<line x1="${x(trend.from.day).toFixed(1)}" y1="${y(trend.from.value).toFixed(1)}" x2="${x(trend.to.day).toFixed(1)}" y2="${y(trend.to.value).toFixed(1)}" class="chart__trend"/>`;
    series.forEach((s) => {
      if (s.points.length > 1) {
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
        svg += `<path d="${d}" class="chart__line" style="stroke:${s.color}"/>`;
      }
      const dense = s.points.length > 1 && (x1 - x0) / (s.points.length - 1) < MIN_DOT_GAP;
      const dots = dense ? s.points.slice(-1) : s.points;
      svg += dots.map((p) => `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" class="chart__dot" style="fill:${s.color}"/>`).join('');
    });
    svg += '<g class="chart__cursor"></g>';
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${svg}</svg>`;
    drawCursor();
  }
  function drawCursor() {
    if (!geo || sel < 0) return;
    const day = days[sel];
    const cx = geo.x(day).toFixed(1);
    let g = `<line x1="${cx}" x2="${cx}" y1="${PAD_T}" y2="${H - PAD_B}" class="chart__crosshair"/>`;
    series.forEach((s) => {
      const p = s.points.find((q) => q.day === day);
      if (p) g += `<circle cx="${cx}" cy="${geo.y(p.value).toFixed(1)}" r="6" class="chart__dot chart__dot--sel" style="fill:${s.color}"/>`;
    });
    plot.querySelector('.chart__cursor').innerHTML = g;
    out.innerHTML = readout(day);
  }
  const select = (i) => { sel = Math.max(0, Math.min(days.length - 1, i)); drawCursor(); };
  bindPointer(plot, {
    onPick: (px) => {
      if (!geo) return;
      const day = view.start + ((px - geo.x0) / (geo.x1 - geo.x0)) * (view.end - view.start);
      select(nearestIndex(days, day));
    },
    onStep: (d) => select(sel + d),
  });
  if (days.length) out.innerHTML = readout(days[sel]);
  observeWidth(plot, draw);
  return root;
}

/* ---------- Столбчатый график ----------
   bars: [{ start, end, value|null }] — слоты периода (value null = нет данных);
   goal: { value, label } | null; readout(bar) → HTML. */
/* Необязательно: barColor(bar) — заливка конкретного столбца (по умолчанию color); yFormat(v, step) —
   подписи оси Y; xLabels — свои подписи оси X ([{ day, label }], по центру слота); fit: false — ось X
   на весь период; legendExtra — HTML дополнительных пунктов легенды (данные экранирует вызывающий). */
export function barChart({ range, bars: allBars, goal = null, minSpan = 1, readout, ariaLabel, color = 'var(--viz-1)', barColor = null, yFormat = null, xLabels = null, fit = true, legendExtra = '' }) {
  const legend = (goal ? `<span class="chart__key"><i class="chart__swatch chart__swatch--goal"></i>${escXml(goal.label)}</span>` : '') + legendExtra;
  const firstBar = allBars.find((b) => b.value != null);
  const fitted = fit && firstBar ? fitRange(range, firstBar.start) : null;
  const view = fitted ? { start: firstBar.start, end: range.end } : range;
  const bars = fitted ? allBars.filter((b) => b.end >= view.start) : allBars;
  const { root, plot, readout: out } = frame({ ariaLabel, legend, note: fitted ? `Ось начинается с первой записи периода: ${fmtFull(firstBar.points && firstBar.points.length ? firstBar.points[0].day : firstBar.start)}` : '' });
  const withData = bars.map((b, i) => (b.value != null ? i : -1)).filter((i) => i >= 0);
  let sel = withData.length ? withData[withData.length - 1] : bars.length - 1;
  let geo = null;
  const vals = bars.filter((b) => b.value != null).map((b) => b.value);
  const ys = yScale(0, Math.max(0, ...vals, goal ? goal.value : 0), { zero: true, minSpan });
  const yLabels = ys.ticks.map((v) => (yFormat ? yFormat(v, ys.step) : fmtAxis(v, ys.step)));

  function draw(W) {
    const x0 = leftPad(yLabels), x1 = W - PAD_R;
    const total = view.end - view.start + 1;
    const x = (d) => x0 + ((d - view.start) / total) * (x1 - x0);
    const y = (v) => PAD_T + (1 - (v - ys.lo) / (ys.hi - ys.lo)) * (H - PAD_T - PAD_B);
    const base = y(0);
    geo = { x, x0, x1, total };
    let svg = gridSvg(ys, x0, x1, y, yLabels) + (xLabels ? customXAxisSvg(xLabels, (d) => x(d + 0.5), x0, x1) : xAxisSvg(view, (d) => x(d + 0.5)));
    svg += '<g class="chart__cursor"></g>';
    bars.forEach((b) => {
      if (b.value == null) return;
      const slot = x(b.end + 1) - x(b.start);
      const w = Math.max(1, Math.min(24, slot - 2));
      const bx = x(b.start) + (slot - w) / 2;
      if (b.value <= 0) {
        svg += `<rect x="${bx.toFixed(1)}" y="${(base - 2).toFixed(1)}" width="${w.toFixed(1)}" height="2" class="chart__zero"/>`;
        return;
      }
      const top = y(b.value);
      const h = Math.max(2, base - top);
      const r = Math.min(4, w / 2, h);
      /* скругление только у вершины, база — прямая */
      svg += `<path d="M${bx.toFixed(1)},${base.toFixed(1)}V${(base - h + r).toFixed(1)}Q${bx.toFixed(1)},${(base - h).toFixed(1)} ${(bx + r).toFixed(1)},${(base - h).toFixed(1)}H${(bx + w - r).toFixed(1)}Q${(bx + w).toFixed(1)},${(base - h).toFixed(1)} ${(bx + w).toFixed(1)},${(base - h + r).toFixed(1)}V${base.toFixed(1)}Z" style="fill:${barColor ? barColor(b) : color}"/>`;
    });
    if (goal) svg += goalSvg([goal], x0, x1, y, ys);
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${svg}</svg>`;
    drawCursor();
  }
  function drawCursor() {
    if (!geo || sel < 0) return;
    const b = bars[sel];
    const bx = geo.x(b.start), w = geo.x(b.end + 1) - bx;
    plot.querySelector('.chart__cursor').innerHTML = `<rect x="${bx.toFixed(1)}" y="${PAD_T - 4}" width="${w.toFixed(1)}" height="${H - PAD_T - PAD_B + 4}" rx="4" class="chart__slot"/>`;
    out.innerHTML = readout(b);
  }
  const select = (i) => { sel = Math.max(0, Math.min(bars.length - 1, i)); drawCursor(); };
  bindPointer(plot, {
    onPick: (px) => {
      if (!geo) return;
      const day = view.start + Math.floor(((px - geo.x0) / (geo.x1 - geo.x0)) * geo.total);
      const i = bars.findIndex((b) => day >= b.start && day <= b.end);
      select(i >= 0 ? i : day < view.start ? 0 : bars.length - 1);
    },
    onStep: (d) => select(sel + d),
  });
  if (bars.length) out.innerHTML = readout(bars[sel]);
  observeWidth(plot, draw);
  return root;
}
