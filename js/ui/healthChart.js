/* =========================================================
   js/ui/healthChart.js — блок статистики показателя в духе Apple Health (UI LexLife):
     PeriodSelector  — сегменты ДН · НЕД · МЕС · 6 МЕС · ГОД (серая капсула, активный — светлая);
     MetricHeader    — «В СРЕДНЕМ» · крупное значение · единица · диапазон дат + ‹ › (PeriodNavigator);
     HealthBarChart  — столбцы, горизонтальная сетка, пунктирные разделители, правая ось Y,
                       пунктирная линия цели, выбор столбца (касание / перетаскивание) с подсказкой.
   Только DOM; данные и расчёты — js/services/metricPeriods.js. Цвета — токены темы (--hc-*).
   Переиспользуется любым показателем: вода сейчас; сон, шаги, вес — тем же блоком.
   ========================================================= */

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHEV = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

/* kinds: [{ id, label, title }]; onChange(id); prev — прежний активный сегмент: светлый «бегунок»
   переезжает с него на новый (плавное переключение, как системный segmented control) */
export function PeriodSelector({ kinds, active, onChange, label = 'Период', prev = null }) {
  const box = h(`<div class="hseg" role="tablist" aria-label="${esc(label)}" style="--hseg-n:${kinds.length}"><span class="hseg__thumb" aria-hidden="true"></span></div>`);
  const idx = (id) => Math.max(0, kinds.findIndex((k) => k.id === id));
  const thumb = box.querySelector('.hseg__thumb');
  const place = (i) => { thumb.style.transform = `translateX(${i * 100}%)`; };
  if (prev && prev !== active) {
    place(idx(prev));
    requestAnimationFrame(() => requestAnimationFrame(() => { box.classList.add('hseg--anim'); place(idx(active)); }));
  } else place(idx(active));
  kinds.forEach((k) => {
    const b = h(`<button class="hseg__btn" type="button" role="tab" data-k="${esc(k.id)}" aria-selected="${k.id === active}" aria-label="${esc(k.title || k.label)}">${esc(k.label)}</button>`);
    b.addEventListener('click', () => { if (k.id !== active) onChange(k.id); });
    box.appendChild(b);
  });
  return box;
}

/* ‹ › — предыдущий / следующий период (следующий недоступен у текущего) */
export function PeriodNavigator({ hasPrev = true, hasNext, onPrev, onNext }) {
  const nav = h(`
    <div class="hnav">
      <button class="hnav__btn" type="button" data-dir="-1" aria-label="Предыдущий период">${CHEV('M14.5 5.5 8 12l6.5 6.5')}</button>
      <button class="hnav__btn" type="button" data-dir="1" aria-label="Следующий период">${CHEV('M9.5 5.5 16 12l-6.5 6.5')}</button>
    </div>
  `);
  const [prev, next] = nav.querySelectorAll('button');
  prev.disabled = !hasPrev;
  next.disabled = !hasNext;
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  return nav;
}

/* caption — «В среднем» / «Всего»; value — готовая строка числа; unit; range — диапазон дат */
export function MetricHeader({ caption, value, unit, range, nav = null }) {
  const head = h(`
    <div class="hhead">
      <div class="hhead__main">
        <div class="hhead__cap"></div>
        <div class="hhead__val"><span class="hhead__num"></span><span class="hhead__unit"></span></div>
        <div class="hhead__range"></div>
      </div>
    </div>
  `);
  head.querySelector('.hhead__cap').textContent = caption;
  head.querySelector('.hhead__num').textContent = value;
  head.querySelector('.hhead__unit').textContent = unit;
  head.querySelector('.hhead__range').textContent = range;
  if (nav) head.appendChild(nav);
  return head;
}

/* График.
   buckets: [{ key, label, letter?, value (число | null — нет столбца), sep (разделитель слева) }];
   scale: { max, ticks } (metricPeriods.niceScale); goal: число | null; goalLabel;
   yFormat(n) — подписи оси; tip(bucket) → { title, value } — подсказка выбранного столбца;
   compact — подписи X буквами на узком экране (12 месяцев). */
export function HealthBarChart({ buckets, scale, goal = null, goalLabel = '', yFormat = String, tip, compact = false, emptyText = 'Нет записей за период', ariaLabel = 'График' }) {
  const n = buckets.length;
  const pct = (v) => `${Math.max(0, Math.min(100, (v / scale.max) * 100)).toFixed(3)}%`;
  const root = h(`
    <div class="hc${compact ? ' hc--compact' : ''}${n > 12 ? ' hc--dense' : ''}" style="--hc-n:${n}">
      <div class="hc__area">
        <div class="hc__plot" role="group" aria-label="${esc(ariaLabel)}"></div>
        <div class="hc__axis" aria-hidden="true"></div>
      </div>
      <div class="hc__x" aria-hidden="true"></div>
    </div>
  `);
  const plot = root.querySelector('.hc__plot');
  const axis = root.querySelector('.hc__axis');
  const xrow = root.querySelector('.hc__x');

  scale.ticks.forEach((t) => {
    plot.appendChild(h(`<div class="hc__grid${t === 0 ? ' hc__grid--base' : ''}" style="bottom:${pct(t)}"></div>`));
    const lbl = h(`<span class="hc__tick" style="bottom:${pct(t)}"></span>`);
    lbl.textContent = yFormat(t);
    axis.appendChild(lbl);
  });
  buckets.forEach((b, i) => { if (b.sep) plot.appendChild(h(`<div class="hc__sep" style="left:${((i / n) * 100).toFixed(3)}%"></div>`)); });
  if (goal != null && goal > 0) {
    const g = h(`<div class="hc__goal" style="bottom:${pct(goal)}"><span class="hc__goal-lbl"></span></div>`);
    g.querySelector('.hc__goal-lbl').textContent = goalLabel;
    plot.appendChild(g);
  }

  const bars = h('<div class="hc__bars"></div>');
  const cols = buckets.map((b, i) => {
    const has = b.value != null;
    const col = h(`<button class="hc__col" type="button" data-i="${i}" ${has ? '' : 'disabled'}><span class="hc__bar"></span></button>`);
    if (has) {
      const t = tip(b);
      col.setAttribute('aria-label', `${t.title}: ${t.value}`);
      col.querySelector('.hc__bar').dataset.h = pct(b.value);
      if (b.value <= 0) col.classList.add('hc__col--zero');
    } else col.setAttribute('aria-hidden', 'true');
    bars.appendChild(col);
    const x = h('<span class="hc__xl"></span>');
    if (compact && b.letter) x.innerHTML = `<span class="hc__xl-full">${esc(b.label)}</span><span class="hc__xl-short">${esc(b.letter)}</span>`;
    else x.textContent = b.label || '';
    xrow.appendChild(x);
    return col;
  });
  plot.appendChild(bars);
  if (!buckets.some((b) => b.value > 0)) plot.appendChild(h(`<p class="hc__empty">${esc(emptyText)}</p>`));

  const tipBox = h('<div class="hc__tip" hidden><span class="hc__tip-title"></span><b class="hc__tip-val"></b></div>');
  const guide = h('<div class="hc__guide" hidden></div>'); // линия от подсказки к столбцу
  plot.append(guide, tipBox);

  /* выбор столбца: касание / перетаскивание по графику, клавиатура — Enter/пробел на столбце */
  let sel = -1;
  function select(i) {
    sel = i;
    root.classList.toggle('hc--sel', i >= 0);
    cols.forEach((c, j) => c.classList.toggle('is-sel', j === i));
    if (i < 0) { tipBox.hidden = true; guide.hidden = true; return; }
    const t = tip(buckets[i]);
    tipBox.querySelector('.hc__tip-title').textContent = t.title;
    tipBox.querySelector('.hc__tip-val').textContent = t.value;
    tipBox.hidden = false;
    const w = plot.clientWidth || 1;
    const cx = ((i + 0.5) / n) * w;
    const tw = tipBox.offsetWidth;
    tipBox.style.left = `${Math.max(0, Math.min(w - tw, cx - tw / 2))}px`;
    guide.style.left = `${cx}px`;
    guide.hidden = false;
  }
  const idxAt = (clientX) => {
    const r = plot.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
    if (buckets[i].value != null) return i;
    for (let d = 1; d < n; d++) { /* ближайший столбец с данными */
      if (buckets[i - d] && buckets[i - d].value != null) return i - d;
      if (buckets[i + d] && buckets[i + d].value != null) return i + d;
    }
    return -1;
  };
  let down = false, moved = false, startSel = -1;
  plot.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    down = true; moved = false; startSel = sel;
    const i = idxAt(e.clientX);
    if (i >= 0) select(i);
  });
  plot.addEventListener('pointermove', (e) => {
    if (!down) return;
    const i = idxAt(e.clientX);
    if (i >= 0 && i !== sel) { moved = true; select(i); }
  });
  const up = () => {
    if (!down) return;
    down = false;
    if (!moved && startSel >= 0 && startSel === sel) select(-1); // повторное касание того же столбца — снять выбор
  };
  plot.addEventListener('pointerup', up);
  plot.addEventListener('pointercancel', () => { down = false; });
  plot.addEventListener('pointerleave', up);
  cols.forEach((c, i) => c.addEventListener('click', (e) => { if (e.detail === 0) select(sel === i ? -1 : i); })); // клавиатура
  root.selectBar = (i) => select(i); // для тестов и внешнего управления
  /* касание вне графика снимает выбор (заголовок периода возвращается) */
  const outside = (e) => {
    if (!root.isConnected) { document.removeEventListener('pointerdown', outside, true); return; }
    if (sel >= 0 && !root.contains(e.target)) select(-1);
  };
  document.addEventListener('pointerdown', outside, true);

  /* плавное появление / смена столбцов */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    cols.forEach((c) => { const b = c.querySelector('.hc__bar'); if (b.dataset.h) b.style.height = b.dataset.h; });
  }));
  return root;
}
