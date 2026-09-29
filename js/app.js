/* =========================================================
   app.js — точка входа, роутер, Drawer и экраны (MVP v1.0)
   Async-first: данные через StorageService с await.
   Навигация: нижний таб-бар (Главная/Показатели/Лекарства/Анализы)
   + боковое меню (Drawer, ☰ справа сверху).
   Показатели — единая модель: каждый показатель = модуль #/metric/<key>.
   ========================================================= */

import Storage, { REFERENCE, TEST_FIELDS, dateKey, APP_VERSION, APP_UPDATED, CURRENT_SCHEMA_VERSION, BackupError, parseBackup } from './services/storage.js';

/* ---------- DOM-помощники ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';

/* ---------- форматирование ---------- */
const RU = 'ru-RU';
const fmtFull = (d = new Date()) => {
  const s = d.toLocaleDateString(RU, { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(RU, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtNum = (n) => (n == null ? '—' : String(n).replace('.', ','));

/* ---------- реестр показателей ---------- */
const METRICS = {
  weight: { key: 'weight', name: 'Вес', emoji: '⚖️', unit: 'кг', kind: 'single', step: '0.1' },
  pressure: { key: 'pressure', name: 'Давление', emoji: '🩸', unit: 'mmHg', kind: 'pressure', step: '1' },
  pulse: { key: 'pulse', name: 'Пульс', emoji: '❤️', unit: 'уд/мин', kind: 'single', step: '1' },
  water: { key: 'water', name: 'Вода', emoji: '💧', unit: 'мл', kind: 'water' },
  temperature: { key: 'temperature', name: 'Температура', emoji: '🌡', unit: '°C', kind: 'single', step: '0.1' },
  spo2: { key: 'spo2', name: 'Сатурация', emoji: '🫁', unit: '%', kind: 'single', step: '1' },
  glucose: { key: 'glucose', name: 'Глюкоза', emoji: '🍬', unit: 'ммоль/л', kind: 'single', step: '0.1' },
};
const METRIC_ORDER = ['weight', 'pressure', 'pulse', 'water', 'temperature', 'spo2', 'glucose'];
const HOME_METRICS = ['weight', 'pressure', 'pulse', 'water'];

const fmtMl = (ml) => (ml == null ? '—' : Math.round(ml).toLocaleString('ru-RU'));
const fmtMetric = (key, v) => {
  if (v == null) return '—';
  const k = METRICS[key].kind;
  if (k === 'pressure') return `${v.systolic}/${v.diastolic}`;
  if (k === 'water') return fmtMl(v.total);
  return fmtNum(v);
};
const chartVal = (key, v) => {
  if (v == null) return null;
  const k = METRICS[key].kind;
  if (k === 'pressure') return v.systolic;
  if (k === 'water') return v.total;
  return v;
};

/* ---------- доменная логика анализов ---------- */
function evaluate(field, value) {
  const ref = REFERENCE[field];
  if (!ref || value == null || value === '' || isNaN(Number(value))) return 'none';
  const v = Number(value);
  if (ref.higherIsBetter) return v >= ref.goodMin ? 'good' : 'warn';
  if (ref.goodMin != null && ref.good != null) return v >= ref.goodMin && v <= ref.good ? 'good' : 'warn';
  if (ref.warn != null) {
    if (v <= ref.good) return 'good';
    if (v <= ref.warn) return 'warn';
    return 'danger';
  }
  return v <= ref.good ? 'good' : 'danger';
}
function nextDose(med) {
  if (!med.every_days || !med.start) return null;
  const ms = 86400000;
  const start = new Date(med.start + 'T00:00:00');
  const today = new Date(dateKey() + 'T00:00:00');
  if (start > today) return med.start;
  const cycles = Math.ceil((today - start) / ms / med.every_days);
  return dateKey(new Date(start.getTime() + cycles * med.every_days * ms));
}

/* ---------- тема ---------- */
const getTheme = () => localStorage.getItem('app_theme') || 'dark';
const applyTheme = (t) => document.documentElement.setAttribute('data-theme', t);
function setTheme(t) { localStorage.setItem('app_theme', t); applyTheme(t); }

/* =========================================================
   Карточка показателя (используется на Главной и в «Показателях»)
   ========================================================= */
function metricCard(key, latest) {
  const M = METRICS[key];
  return el(`
    <button class="mcard" type="button" data-route="metric/${key}">
      <div class="mcard__top"><span class="mcard__emoji">${M.emoji}</span><span class="mcard__name">${esc(M.name)}</span></div>
      <div class="mcard__val">${esc(fmtMetric(key, latest && latest.value))}<span class="mcard__unit">${esc(M.unit)}</span></div>
    </button>
  `);
}

/* =========================================================
   Вкладка 1 — Главная (Dashboard)
   ========================================================= */
async function HomeScreen() {
  const [alerts, allMeds, latestTest, profile, ...latests] = await Promise.all([
    Storage.getAlerts(),
    Storage.getMeds(),
    Storage.getLatestTest(),
    Storage.getProfile(),
    ...HOME_METRICS.map((k) => Storage.getMetricLatest(k)),
  ]);
  const meds = allMeds.filter((m) => m.active);
  const screen = el('<div></div>');
  const greeting = profile?.name ? `Привет, ${esc(profile.name)} 👋` : 'Привет 👋';

  screen.appendChild(
    el(`
    <header class="header">
      <p class="header__eyebrow">${esc(fmtFull(new Date()))}</p>
      <h1 class="header__title">${greeting}</h1>
    </header>
  `)
  );

  /* Сегодня — 4 краткие карточки показателей (тап → модуль) */
  const sec = el('<section class="section" style="margin-top:14px"><div class="section__head"><h2 class="section__title">Сегодня</h2><button class="section__action" data-route="metrics">Все</button></div><div class="mcard-grid"></div></section>');
  const grid = $('.mcard-grid', sec);
  HOME_METRICS.forEach((k, i) => grid.appendChild(metricCard(k, latests[i])));
  screen.appendChild(sec);

  /* Предупреждения */
  if (alerts.length) {
    const s = el('<section class="section"><div class="section__head"><h2 class="section__title">Требует внимания</h2></div><div class="alerts"></div></section>');
    const box = $('.alerts', s);
    alerts.forEach((a) => {
      box.appendChild(
        el(`
        <div class="alert alert--${esc(a.type)}">
          <span class="alert__dot"></span>
          <div class="alert__body">
            <p class="alert__title">${esc(a.title)}</p>
            <p class="alert__meta">${esc(a.note || (a.norm ? 'Норма: ' + a.norm : ''))}</p>
          </div>
          ${a.value ? `<span class="alert__value">${esc(a.value)}</span>` : ''}
        </div>
      `)
      );
    });
    screen.appendChild(s);
  }

  /* Ближайшее */
  const upcoming = [];
  meds.forEach((m) => {
    if (m.reminder_time) upcoming.push({ icon: m.icon, title: m.name, sub: 'Приём сегодня', trailing: m.reminder_time });
    const nd = nextDose(m);
    if (nd) upcoming.push({ icon: m.icon, title: m.name, sub: 'Следующая доза', trailing: fmtDate(nd) });
  });
  const repeatNote = alerts.find((a) => a.type === 'info' && a.note);
  if (repeatNote) upcoming.push({ icon: '🩸', title: repeatNote.title, sub: repeatNote.note, trailing: '' });
  if (upcoming.length) {
    const s = el('<section class="section"><div class="section__head"><h2 class="section__title">Ближайшее</h2></div><div class="list-card"></div></section>');
    const box = $('.list-card', s);
    upcoming.forEach((u) => {
      box.appendChild(
        el(`
        <div class="row">
          <span class="row__icon">${esc(u.icon || '📌')}</span>
          <div class="row__body"><p class="row__title">${esc(u.title)}</p><p class="row__sub">${esc(u.sub)}</p></div>
          ${u.trailing ? `<span class="row__trailing">${esc(u.trailing)}</span>` : ''}
        </div>
      `)
      );
    });
    screen.appendChild(s);
  }

  /* Последние анализы */
  if (latestTest) {
    const fields = ['ldl', 'trig', 'glucose', 'vitd'];
    const s = el('<section class="section"><div class="section__head"><h2 class="section__title">Последние анализы</h2><button class="section__action" data-route="tests">Все</button></div><div class="metric-grid"></div></section>');
    const g = $('.metric-grid', s);
    fields.forEach((f) => {
      const ref = REFERENCE[f];
      const val = latestTest[f];
      const st = evaluate(f, val);
      g.appendChild(
        el(`
        <div class="metric-tile">
          <div class="metric-tile__top"><span class="metric-tile__name">${esc(ref.label)}</span><span class="dot-status dot-status--${st}"></span></div>
          <div class="metric-tile__value">${val ?? '—'}<span class="metric-tile__unit">${esc(ref.unit)}</span></div>
        </div>
      `)
      );
    });
    screen.appendChild(s);
  }

  screen.addEventListener('click', onRouteClick);
  return screen;
}

/* =========================================================
   Вкладка 2 — Показатели (сетка модулей)
   ========================================================= */
async function MetricsScreen() {
  const latests = await Promise.all(METRIC_ORDER.map((k) => Storage.getMetricLatest(k)));
  const screen = el('<div></div>');
  screen.appendChild(el('<header class="header"><h1 class="header__title">Показатели</h1></header>'));
  const sec = el('<section class="section" style="margin-top:8px"><div class="mcard-grid"></div></section>');
  const grid = $('.mcard-grid', sec);
  METRIC_ORDER.forEach((k, i) => grid.appendChild(metricCard(k, latests[i])));
  screen.appendChild(sec);
  screen.addEventListener('click', onRouteClick);
  return screen;
}

/* =========================================================
   Модуль показателя — единая структура для всех показателей
   ========================================================= */
async function MetricScreen(key) {
  const M = METRICS[key];
  const screen = el('<div></div>');
  let period = 'week';
  let editingGoal = false;

  async function paint() {
    const [log, cfg] = await Promise.all([Storage.getMetricLog(key), Storage.getMetricConfig(key)]);
    const goal = cfg.goal;
    const days = Object.keys(log).sort();
    const lastDay = days[days.length - 1];
    const cur = lastDay != null ? log[lastDay] : null;
    screen.innerHTML = '';

    screen.appendChild(backHeader(`${M.emoji} ${M.name}`, { label: 'Показатели', onBack: () => { location.hash = '#/metrics'; } }));

    /* 1. Текущее значение + 2. Цель */
    const card = el(`
      <div class="input-card metric-current">
        <div class="metric-current__val">${esc(fmtMetric(key, cur))}<span class="metric-current__unit">${esc(M.unit)}</span></div>
        <div class="metric-current__date">${cur != null ? 'обновлено ' + esc(fmtDate(lastDay)) : 'нет данных'}</div>
        <div class="metric-goal" id="goal-box"></div>
      </div>
    `);
    const goalBox = $('#goal-box', card);
    if (editingGoal) {
      goalBox.appendChild(goalEditor(goal));
    } else {
      goalBox.appendChild(el(`<span>Цель: <b>${esc(fmtMetric(key, goal))} ${esc(M.unit)}</b></span>`));
      const eb = el('<button class="metric-goal__edit" type="button">изменить</button>');
      eb.addEventListener('click', () => { editingGoal = true; paint(); });
      goalBox.appendChild(eb);
    }
    screen.appendChild(card);

    /* 3. Быстрый ввод */
    screen.appendChild(quickInput());

    /* 5. График Неделя/Месяц/Год */
    const seg = el(`
      <div class="seg" style="margin-top:6px">
        <button class="seg__btn ${period === 'week' ? 'is-active' : ''}" data-p="week" type="button">Неделя</button>
        <button class="seg__btn ${period === 'month' ? 'is-active' : ''}" data-p="month" type="button">Месяц</button>
        <button class="seg__btn ${period === 'year' ? 'is-active' : ''}" data-p="year" type="button">Год</button>
      </div>
    `);
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { period = b.dataset.p; paint(); } });
    screen.appendChild(seg);
    screen.appendChild(barChart(metricSeries(log, period, key), chartVal(key, goal)));

    /* 6. Статистика */
    screen.appendChild(metricStats(log, period, key, goal));

    /* 4. История изменений */
    screen.appendChild(historyList(log, key));
  }

  function goalEditor(goal) {
    const wrap = el('<div class="goal-editor"></div>');
    if (M.kind === 'pressure') {
      wrap.appendChild(el(`<input class="input" type="number" id="g-sys" value="${goal?.systolic ?? ''}" placeholder="сист.">`));
      wrap.appendChild(el(`<input class="input" type="number" id="g-dia" value="${goal?.diastolic ?? ''}" placeholder="диаст.">`));
    } else {
      wrap.appendChild(el(`<input class="input" type="number" step="${M.step}" id="g-val" value="${goal ?? ''}" placeholder="цель">`));
    }
    const ok = el('<button class="btn-primary" type="button" style="width:auto;margin:0;padding:11px 16px">OK</button>');
    ok.addEventListener('click', async () => {
      let g;
      if (M.kind === 'pressure') g = { systolic: Number($('#g-sys', wrap).value), diastolic: Number($('#g-dia', wrap).value) };
      else g = Number($('#g-val', wrap).value);
      await Storage.setMetricGoal(key, g);
      editingGoal = false;
      await paint();
      flash('Цель сохранена ✓');
    });
    wrap.appendChild(ok);
    return wrap;
  }

  function quickInput() {
    const wrap = el('<div class="input-card"></div>');
    wrap.appendChild(el('<label class="field__label">Быстрый ввод</label>'));
    if (M.kind === 'cumulative') {
      const quick = el('<div class="water-quick"></div>');
      M.quick.forEach((amt) => {
        const b = el(`<button class="water-add" type="button">+${fmtNum(amt)} ${esc(M.unit)}</button>`);
        b.addEventListener('click', async () => { await Storage.addMetricValue(key, amt); await paint(); flash(`+${fmtNum(amt)} ${M.unit}`); });
        quick.appendChild(b);
      });
      const reset = el('<button class="water-add water-add--reset" type="button">Сброс</button>');
      reset.addEventListener('click', async () => { await Storage.setMetricValue(key, 0); await paint(); });
      quick.appendChild(reset);
      wrap.appendChild(quick);
      const man = el(`<div class="water-manual" style="margin-top:10px"><input class="input" type="number" step="${M.step}" id="m-val" placeholder="итог за сегодня"><button class="btn-primary" id="m-ok" type="button">OK</button></div>`);
      $('#m-ok', man).addEventListener('click', async () => { const v = $('#m-val', man).value; if (v !== '') { await Storage.setMetricValue(key, Number(v)); await paint(); flash('Сохранено ✓'); } });
      wrap.appendChild(man);
    } else if (M.kind === 'pressure') {
      const row = el('<div class="water-manual"><input class="input" type="number" id="m-sys" placeholder="сист."><input class="input" type="number" id="m-dia" placeholder="диаст."><button class="btn-primary" id="m-ok" type="button">Записать</button></div>');
      $('#m-ok', row).addEventListener('click', async () => {
        const sys = $('#m-sys', row).value, dia = $('#m-dia', row).value;
        if (sys !== '' && dia !== '') { await Storage.setMetricValue(key, { systolic: Number(sys), diastolic: Number(dia) }); await paint(); flash('Записано ✓'); }
      });
      wrap.appendChild(row);
    } else {
      const row = el(`<div class="water-manual"><input class="input" type="number" step="${M.step}" id="m-val" placeholder="новое значение"><button class="btn-primary" id="m-ok" type="button">Записать</button></div>`);
      $('#m-ok', row).addEventListener('click', async () => { const v = $('#m-val', row).value; if (v !== '') { await Storage.setMetricValue(key, Number(v)); await paint(); flash('Записано ✓'); } });
      wrap.appendChild(row);
    }
    return wrap;
  }

  await paint();
  return screen;
}

/* серия для графика */
function metricSeries(log, p, key) {
  const labels = [];
  const values = [];
  const today = new Date();
  if (p === 'week' || p === 'month') {
    const n = p === 'week' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      values.push(chartVal(key, log[dateKey(d)]) || 0);
      if (p === 'week') labels.push(d.toLocaleDateString(RU, { weekday: 'short' }));
      else labels.push(i % 5 === 0 ? String(d.getDate()) : '');
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      let sum = 0, cnt = 0;
      for (const [k, v] of Object.entries(log)) {
        const dd = new Date(k + 'T00:00:00');
        const cv = chartVal(key, v);
        if (dd.getFullYear() === d.getFullYear() && dd.getMonth() === d.getMonth() && cv > 0) { sum += cv; cnt += 1; }
      }
      values.push(cnt ? sum / cnt : 0);
      labels.push(d.toLocaleDateString(RU, { month: 'short' }));
    }
  }
  return { labels, values };
}

function barChart(series, goalVal) {
  const sec = el('<section class="section"><div class="card" style="padding:14px 12px"><div class="wchart"></div></div></section>');
  const chart = $('.wchart', sec);
  const max = Math.max(goalVal || 0, ...series.values, 0.1) * 1.15;
  const plot = el('<div class="wchart__plot"></div>');
  if (goalVal) plot.appendChild(el(`<div class="wchart__goal" style="bottom:${(goalVal / max) * 100}%"><span class="wchart__goal-lbl">цель ${fmtNum(goalVal)}</span></div>`));
  const bars = el('<div class="wchart__bars"></div>');
  series.values.forEach((v) => {
    const h = v > 0 ? Math.max((v / max) * 100, 3) : 0;
    bars.appendChild(el(`<div class="wchart__barcol"><div class="wchart__bar" style="height:${h}%"></div></div>`));
  });
  plot.appendChild(bars);
  chart.appendChild(plot);
  const lbls = el('<div class="wchart__labels"></div>');
  series.labels.forEach((l) => lbls.appendChild(el(`<span class="wchart__lbl">${esc(l)}</span>`)));
  chart.appendChild(lbls);
  return sec;
}

function metricStats(log, p, key) {
  const today = new Date();
  const n = p === 'week' ? 7 : p === 'month' ? 30 : 365;
  const vals = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const cv = chartVal(key, log[dateKey(d)]);
    if (cv != null && cv > 0) vals.push(cv);
  }
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 0;
  const r = (x) => Math.round(x * 10) / 10;
  return el(`
    <div class="stat-row" style="margin-top:12px">
      <div class="stat"><div class="stat__num">${fmtNum(r(avg))}</div><div class="stat__label">среднее</div></div>
      <div class="stat"><div class="stat__num">${fmtNum(r(min))}</div><div class="stat__label">минимум</div></div>
      <div class="stat"><div class="stat__num">${fmtNum(r(max))}</div><div class="stat__label">максимум</div></div>
    </div>
  `);
}

function historyList(log, key) {
  const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">История</h2></div><div class="list-card"></div></section>');
  const box = $('.list-card', sec);
  const days = Object.keys(log).sort((a, b) => b.localeCompare(a)).slice(0, 14);
  if (!days.length) { box.appendChild(el('<div class="empty">Нет записей</div>')); return sec; }
  days.forEach((d) => {
    box.appendChild(
      el(`
      <div class="row">
        <div class="row__body"><p class="row__title">${esc(fmtMetric(key, log[d]))} <span style="color:var(--text2);font-weight:400;font-size:13px">${esc(METRICS[key].unit)}</span></p></div>
        <span class="row__trailing">${esc(fmtDate(d))}</span>
      </div>
    `)
    );
  });
  return sec;
}

/* =========================================================
   Модуль «Вода» — конфиг-движок (шаблон будущих показателей).
   Сейчас вариант kind:'cumulative'. Точечные показатели
   (вес/давление/пульс/температура) подключатся как kind:'point'
   с colorMode:'range' (цвет по норме) — структура уже готова.
   ========================================================= */
const WATER_CFG = {
  key: 'water', name: 'Вода', emoji: '💧', unit: 'мл', kind: 'cumulative',
  goalPresets: [2000, 2500, 3000], // мл
  quick: [200, 300, 500], // мл
};
/* цвет состояния по % цели: <50 красный · 50–80 жёлтый · 80–100 зелёный · 100+ синий */
function fillColor(pct) {
  if (pct >= 100) return 'var(--blue)';
  if (pct >= 80) return 'var(--green)';
  if (pct >= 50) return '#d4a72c';
  return 'var(--red)';
}

/* ---------- Гидратация: план по времени (фиксированные слоты) ---------- */
const hhmmToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const minToHHMM = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/* фиксированные слоты от подъёма до сна с шагом slotMinutes; объём ≈ цель/число слотов (до 50 мл) */
function buildPlan(goal, cfg) {
  const start = hhmmToMin(cfg.wakeStart);
  const end = hhmmToMin(cfg.wakeEnd);
  const step = cfg.slotMinutes || 120;
  const times = [];
  for (let t = start; t < end; t += step) times.push(t);
  if (!times.length) times.push(start);
  const base = Math.max(50, Math.floor(goal / times.length / 50) * 50);
  const slots = times.map((t) => ({ time: t, ml: base }));
  let rem = goal - base * slots.length;
  let i = 0;
  while (rem > 0) { const add = Math.min(50, rem); slots[i % slots.length].ml += add; rem -= add; i += 1; }
  let cum = 0;
  slots.forEach((s) => { cum += s.ml; s.cum = cum; });
  return slots;
}
/* сколько по плану должно быть выпито к моменту nowMin (линейно по окну) */
function plannedByNow(goal, cfg, nowMin) {
  const start = hhmmToMin(cfg.wakeStart);
  const end = hhmmToMin(cfg.wakeEnd);
  if (nowMin <= start || end <= start) return 0;
  if (nowMin >= end) return goal;
  return Math.round((goal * (nowMin - start)) / (end - start));
}
/* запрос разрешения на уведомления — seam под Этап 3 (push/local) */
async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

async function WaterScreen() {
  const screen = el('<div></div>');
  let period = 'day';
  let editingGoal = false;

  async function paint() {
    const [log, goal, record, streak, hyd] = await Promise.all([
      Storage.getWaterLog(), Storage.getWaterGoal(), Storage.getWaterRecord(), Storage.getWaterStreak(), Storage.getHydration(),
    ]);
    const today = dateKey();
    const dayObj = log[today] || { total: 0, entries: [] };
    const total = dayObj.total || 0;
    const pct = goal ? Math.round((total / goal) * 100) : 0;
    const remaining = Math.max(0, goal - total);
    const color = fillColor(pct);
    screen.innerHTML = '';
    screen.appendChild(backHeader('💧 Вода', { label: 'Показатели', onBack: () => { location.hash = '#/metrics'; } }));

    /* 1. Кольцо + 2. текущий объём / цель */
    const r = 60, circ = 2 * Math.PI * r;
    const off = circ * (1 - Math.min(pct, 100) / 100);
    screen.appendChild(el(`
      <div class="water-hero">
        <div class="wring">
          <svg width="150" height="150" viewBox="0 0 150 150">
            <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="13"/>
            <circle cx="75" cy="75" r="${r}" fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 75 75)"/>
          </svg>
          <div class="wring__center"><div class="wring__val">${fmtMl(total)}</div><div class="wring__sub" style="color:${color}">мл · ${pct}%</div></div>
        </div>
        <div class="water-goalrow"><span>осталось <b>${fmtMl(remaining)} мл</b></span><span>цель <b>${fmtMl(goal)} мл</b></span></div>
      </div>
    `));
    if (editingGoal) {
      screen.appendChild(buildGoalEditor(goal));
    } else {
      const gb = el('<button class="btn-ghost" type="button" style="margin-top:10px">✎ Редактировать цель</button>');
      gb.addEventListener('click', () => { editingGoal = true; paint(); });
      screen.appendChild(gb);
    }

    /* 3. Быстрое добавление */
    screen.appendChild(quickBar());

    /* 4. План гидратации по времени + 5. отставание/опережение */
    screen.appendChild(planSection(goal, hyd, total));
    screen.appendChild(deviationSection(goal, hyd, total));

    /* 6. История за день */
    screen.appendChild(journal(dayObj.entries, goal));

    /* 7. Графики неделя/месяц/год */
    const seg = el(`
      <div class="seg" style="margin-top:14px">
        <button class="seg__btn ${period === 'week' ? 'is-active' : ''}" data-p="week" type="button">Неделя</button>
        <button class="seg__btn ${period === 'month' ? 'is-active' : ''}" data-p="month" type="button">Месяц</button>
        <button class="seg__btn ${period === 'year' ? 'is-active' : ''}" data-p="year" type="button">Год</button>
      </div>
    `);
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { period = b.dataset.p; paint(); } });
    screen.appendChild(seg);
    screen.appendChild(barChart(metricSeries(log, period, 'water'), goal));

    /* 8. Статистика */
    const L = (ml) => fmtNum(Math.round(ml / 100) / 10);
    screen.appendChild(el(`
      <div class="stat-row" style="margin-top:14px">
        <div class="stat"><div class="stat__num">${record ? L(record.total) : '0'}</div><div class="stat__label">рекорд дня, л</div></div>
        <div class="stat"><div class="stat__num">${streak} 🔥</div><div class="stat__label">серия дней</div></div>
      </div>
    `));
    screen.appendChild(averagesBlock(log));

    /* 9. Настройки напоминаний */
    screen.appendChild(reminderSettings(hyd));
  }

  /* План гидратации (фиксированные слоты) */
  function planSection(goal, hyd, total) {
    const slots = buildPlan(goal, hyd);
    const now = nowMinutes();
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">План на день</h2></div><div class="list-card" id="planbox"></div></section>');
    const box = $('#planbox', sec);
    let currentSet = false;
    slots.forEach((s) => {
      const done = total >= s.cum;
      const current = !done && !currentSet;
      if (current) currentSet = true;
      const icon = done ? '✓' : current ? '•' : '○';
      const cls = done ? 'plan-row--done' : current ? 'plan-row--now' : '';
      box.appendChild(el(`
        <div class="row plan-row ${cls}">
          <span class="plan-row__icon">${icon}</span>
          <span class="plan-row__time">${minToHHMM(s.time)}</span>
          <div class="row__body"><p class="row__sub" style="margin:0">${fmtMl(s.ml)} мл${current ? ' · сейчас' : ''}</p></div>
        </div>
      `));
    });
    return sec;
  }

  /* Отставание / опережение + прогноз + «догнать» */
  function deviationSection(goal, hyd, total) {
    const now = nowMinutes();
    const planned = plannedByNow(goal, hyd, now);
    const dev = total - planned;
    const behind = dev < 0;
    const catchUp = Math.max(0, planned - total);
    const start = hhmmToMin(hyd.wakeStart), end = hhmmToMin(hyd.wakeEnd);
    const frac = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
    const projected = frac > 0.05 ? Math.min(Math.round(total / frac), goal * 2) : null;
    const accent = behind ? (dev < -goal * 0.15 ? 'var(--red)' : '#d4a72c') : 'var(--green)';
    const sec = el(`
      <div class="card" style="padding:14px; margin-top:14px; border-left:4px solid ${accent}">
        <div style="display:flex; align-items:baseline; gap:8px">
          <span style="font-size:24px; font-weight:800; font-family:var(--font-head); color:${accent}">${dev >= 0 ? '+' : '−'}${fmtMl(Math.abs(dev))} мл</span>
          <span style="font-size:13px; color:var(--text2)">${behind ? 'отстаёте от плана' : 'опережение'}</span>
        </div>
        <div style="font-size:12px; color:var(--text2); margin-top:4px">${minToHHMM(now)} · план ${fmtMl(planned)} · выпито ${fmtMl(total)}</div>
        ${projected != null ? `<div style="font-size:12px; color:var(--text2); margin-top:6px">прогноз к ${hyd.wakeEnd}: <b style="color:var(--text)">~${fmtMl(projected)} мл</b>${projected < goal ? ' · недобор ' + fmtMl(goal - projected) : ' · цель будет достигнута'}</div>` : ''}
      </div>
    `);
    if (catchUp > 0) {
      const row = el(`<div class="row" style="margin-top:10px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius)"><div class="row__body"><p class="row__sub" style="margin:0">догнать план — выпейте</p></div><button class="water-add" type="button" style="flex:0 0 auto">+${fmtMl(Math.round(catchUp / 50) * 50)} мл</button></div>`);
      $('.water-add', row).addEventListener('click', async () => { await Storage.addWaterEntry(Math.round(catchUp / 50) * 50); await paint(); flash('Добавлено ✓'); });
      const wrap = el('<div></div>');
      wrap.append(sec, row);
      return wrap;
    }
    return sec;
  }

  /* Настройки напоминаний (подъём/сон/интервал/тумблер) — каркас под Этап 3 */
  function reminderSettings(hyd) {
    const sec = el(`
      <section class="section">
        <div class="section__head"><h2 class="section__title">Напоминания</h2></div>
        <div class="input-card">
          <div class="rs-row"><label class="field__label" style="margin:0">Подъём</label><input class="input" type="time" id="rs-wake" value="${esc(hyd.wakeStart)}" style="width:120px"></div>
          <div class="rs-row"><label class="field__label" style="margin:0">Сон</label><input class="input" type="time" id="rs-sleep" value="${esc(hyd.wakeEnd)}" style="width:120px"></div>
          <div class="rs-row"><label class="field__label" style="margin:0">Интервал</label>
            <select class="select" id="rs-int" style="width:120px">
              ${[60, 90, 120, 180].map((m) => `<option value="${m}" ${hyd.slotMinutes === m ? 'selected' : ''}>${m === 60 ? '1 ч' : m === 90 ? '1,5 ч' : m === 120 ? '2 ч' : '3 ч'}</option>`).join('')}
            </select>
          </div>
          <div class="rs-row"><div><div class="field__label" style="margin:0">Напоминания</div><div style="font-size:11px; color:var(--text2)">локальные уведомления PWA</div></div>
            <button class="rs-toggle ${hyd.notify ? 'is-on' : ''}" id="rs-notify" type="button" role="switch" aria-checked="${hyd.notify}"><span class="rs-toggle__knob"></span></button>
          </div>
        </div>
      </section>
    `);
    const save = async (patch) => { await Storage.setHydration(patch); await paint(); };
    $('#rs-wake', sec).addEventListener('change', (e) => save({ wakeStart: e.target.value }));
    $('#rs-sleep', sec).addEventListener('change', (e) => save({ wakeEnd: e.target.value }));
    $('#rs-int', sec).addEventListener('change', (e) => save({ slotMinutes: Number(e.target.value) }));
    $('#rs-notify', sec).addEventListener('click', async () => {
      const next = !hyd.notify;
      if (next) await ensureNotifyPermission();
      await save({ notify: next });
      flash(next ? 'Напоминания включены' : 'Напоминания выключены');
    });
    return sec;
  }

  function buildGoalEditor(goal) {
    const wrap = el('<div class="goal-editor"></div>');
    WATER_CFG.goalPresets.forEach((g) => {
      const b = el(`<button class="water-add ${g === goal ? 'is-active' : ''}" type="button">${fmtNum(g / 1000)} л</button>`);
      b.addEventListener('click', async () => { await Storage.setWaterGoal(g); editingGoal = false; await paint(); flash('Цель сохранена ✓'); });
      wrap.appendChild(b);
    });
    const inp = el('<input class="input" type="number" step="0.1" id="g-l" placeholder="свой, л" style="width:96px">');
    const ok = el('<button class="btn-primary" type="button" style="width:auto;margin:0;padding:10px 14px">OK</button>');
    ok.addEventListener('click', async () => { if (inp.value !== '') { await Storage.setWaterGoal(Math.round(Number(inp.value) * 1000)); editingGoal = false; await paint(); flash('Цель сохранена ✓'); } });
    wrap.append(inp, ok);
    return wrap;
  }

  /* Дневной накопительный график (по приёмам) */
  function dayChart(entries, goal) {
    const sec = el('<section class="section"><div class="card" style="padding:14px 12px"><svg class="wday" width="100%" height="120" viewBox="0 0 320 120" preserveAspectRatio="none"></svg></div></section>');
    const svg = $('.wday', sec);
    const sorted = [...entries].sort((a, b) => a.t.localeCompare(b.t));
    const sum = sorted.reduce((s, e) => s + e.ml, 0);
    const maxY = Math.max(goal, sum, 1) * 1.1;
    const y = (v) => 110 - (v / maxY) * 100;
    const x = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return 10 + ((h * 60 + m) / 1440) * 300; };
    const gy = y(goal);
    let inner = `<line x1="10" y1="${gy.toFixed(1)}" x2="320" y2="${gy.toFixed(1)}" stroke="var(--orange)" stroke-width="1.2" stroke-dasharray="4 4"/><text x="12" y="${(gy - 4).toFixed(1)}" font-size="9" fill="var(--text2)">цель ${fmtMl(goal)}</text>`;
    if (sorted.length) {
      let cum = 0; const pts = [[10, 110]];
      sorted.forEach((e) => { cum += e.ml; pts.push([x(e.t), y(cum)]); });
      pts.push([320, y(cum)]);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      inner += `<path d="${line} L320,110 L10,110 Z" fill="var(--surface-2)"/><path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linecap="round"/>`;
      const last = pts[pts.length - 1];
      inner += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" fill="var(--blue)"/>`;
    } else {
      inner += '<text x="160" y="62" font-size="11" fill="var(--text2)" text-anchor="middle">нет приёмов сегодня</text>';
    }
    svg.innerHTML = inner;
    return sec;
  }

  /* средний суточный объём за последние n дней (по дням с записями) */
  function avgOver(log, n) {
    const today = new Date();
    const vals = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const o = log[dateKey(d)]; const t = o ? o.total || 0 : 0;
      if (t > 0) vals.push(t);
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  function averagesBlock(log) {
    const L = (ml) => fmtNum(Math.round(ml / 100) / 10);
    return el(`
      <div class="card" style="padding:12px; margin-top:10px">
        <div style="font-size:12px; color:var(--text2); margin-bottom:8px">среднее, л/день</div>
        <div class="wavg">
          <div><div class="wavg__num">${L(avgOver(log, 7))}</div><div class="wavg__lbl">неделя</div></div>
          <div class="wavg__mid"><div class="wavg__num">${L(avgOver(log, 30))}</div><div class="wavg__lbl">месяц</div></div>
          <div><div class="wavg__num">${L(avgOver(log, 365))}</div><div class="wavg__lbl">год</div></div>
        </div>
      </div>
    `);
  }

  /* Журнал приёмов за сегодня (с удалением) */
  function journal(entries, goal) {
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">Сегодня · приёмы</h2></div><div class="list-card" id="jbox"></div></section>');
    const box = $('#jbox', sec);
    if (!entries.length) { box.appendChild(el('<div class="empty">Пока нет приёмов</div>')); return sec; }
    entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.t.localeCompare(a.e.t)).forEach(({ e, i }) => {
      const row = el(`
        <div class="row">
          <span class="row__icon">💧</span>
          <div class="row__body"><p class="row__title">${esc(e.t)} · +${fmtMl(e.ml)} мл</p></div>
          <button class="wdel" type="button" aria-label="Удалить приём">✕</button>
        </div>
      `);
      $('.wdel', row).addEventListener('click', async () => {
        if (confirm(`Удалить запись ${e.t} · ${e.ml} мл?`)) { await Storage.removeWaterEntry(i); await paint(); flash('Удалено'); }
      });
      box.appendChild(row);
    });
    return sec;
  }

  /* Быстрый ввод снизу (зона большого пальца) */
  function quickBar() {
    const bar = el('<div class="wqbar"></div>');
    WATER_CFG.quick.forEach((ml) => {
      const b = el(`<button class="wqbar__chip" type="button">+${ml}</button>`);
      b.addEventListener('click', async () => { await Storage.addWaterEntry(ml); await paint(); flash(`+${ml} мл`); });
      bar.appendChild(b);
    });
    const fab = el('<button class="wqbar__fab" type="button" aria-label="Добавить произвольный объём">+</button>');
    fab.addEventListener('click', async () => {
      const v = prompt('Объём, мл');
      if (v) { const ml = Number(v); if (ml > 0) { await Storage.addWaterEntry(ml); await paint(); flash(`+${ml} мл`); } }
    });
    bar.appendChild(fab);
    return bar;
  }

  await paint();
  return screen;
}

/* =========================================================
   Вкладка 3 — Лекарства
   ========================================================= */
async function MedsScreen() {
  const screen = el('<div></div>');
  async function paint() {
    const [meds, takenToday] = await Promise.all([Storage.getMeds(), Storage.getMedLog()]);
    screen.innerHTML = '';
    screen.appendChild(el(`<header class="header"><p class="header__eyebrow">${esc(fmtFull(new Date()))}</p><h1 class="header__title">Лекарства</h1></header>`));
    const list = el('<section class="section" style="margin-top:14px"><div class="list-card"></div></section>');
    const box = $('.list-card', list);
    if (!meds.length) box.appendChild(el('<div class="empty">Пока нет лекарств</div>'));
    else meds.forEach((m) => {
      const taken = takenToday.includes(m.name);
      const nd = nextDose(m);
      const sub = [m.dose, m.purpose].filter(Boolean).join(' · ');
      const sched = m.reminder_time ? `Напоминание ${m.reminder_time}` : nd ? `След. доза: ${fmtDate(nd)}` : '';
      const row = el(`
        <div class="row ${taken ? 'row--done' : ''}">
          <span class="row__icon">${esc(m.icon || '💊')}</span>
          <div class="row__body"><p class="row__title">${esc(m.name)}</p><p class="row__sub">${esc(sub)}${sched ? ' · ' + esc(sched) : ''}</p></div>
          <button class="check ${taken ? 'check--done' : ''}" type="button" aria-label="Отметить приём">${CHECK_SVG}</button>
        </div>
      `);
      $('.check', row).addEventListener('click', async () => { await Storage.toggleMedTaken(m.name); await paint(); });
      box.appendChild(row);
    });
    screen.appendChild(list);
    screen.appendChild(el('<p class="empty">Отметьте «принял сегодня» галочкой. История приёма сохраняется по дням.</p>'));
  }
  await paint();
  return screen;
}

/* =========================================================
   Вкладка 4 — Анализы
   ========================================================= */
async function TestsScreen() {
  const screen = el('<div></div>');
  let showForm = false;
  async function paint() {
    const tests = await Storage.getTests();
    screen.innerHTML = '';
    screen.appendChild(el(`<header class="header"><p class="header__eyebrow">${tests.length} записей</p><h1 class="header__title">Анализы</h1></header>`));
    const addBtn = el('<button class="btn-ghost" type="button" style="margin:8px 0 4px">+ Добавить анализ</button>');
    addBtn.addEventListener('click', () => { showForm = !showForm; paint(); });
    screen.appendChild(addBtn);
    if (showForm) screen.appendChild(buildForm());
    const list = el('<section class="section" style="margin-top:16px"></section>');
    if (!tests.length) list.appendChild(el('<div class="empty">Пока нет анализов</div>'));
    else tests.forEach((t) => {
      const card = el('<div class="card test-card"></div>');
      card.appendChild(el(`<div class="test-card__head"><span class="test-card__date">${esc(fmtDate(t.date))}</span>${t.note ? `<span class="test-card__note">${esc(t.note)}</span>` : ''}</div>`));
      const values = el('<div class="test-values"></div>');
      TEST_FIELDS.forEach((f) => {
        if (t[f] == null) return;
        const ref = REFERENCE[f];
        const st = evaluate(f, t[f]);
        values.appendChild(el(`<div class="test-value"><span class="dot-status dot-status--${st}"></span><span class="test-value__label">${esc(ref.label)}</span><span class="test-value__num">${esc(t[f])}<span style="color:var(--text2);font-weight:400"> ${esc(ref.unit)}</span></span></div>`));
      });
      card.appendChild(values);
      list.appendChild(card);
    });
    screen.appendChild(list);
  }
  function buildForm() {
    const form = el('<div class="input-card"></div>');
    form.appendChild(el('<div class="input-card__head"><span class="input-card__title">Новый анализ</span></div>'));
    form.appendChild(el(`<div class="field"><label class="field__label">Дата анализа</label><input class="input" type="date" id="f-date" value="${dateKey()}"></div>`));
    TEST_FIELDS.forEach((f) => {
      const ref = REFERENCE[f];
      form.appendChild(el(`<div class="field"><label class="field__label">${esc(ref.label)} (${esc(ref.unit)})</label><input class="input" type="number" step="any" inputmode="decimal" data-field="${f}" placeholder="—"></div>`));
    });
    form.appendChild(el(`<div class="field"><label class="field__label">Заметка</label><input class="input" type="text" id="f-note" placeholder="напр. сдано не натощак"></div>`));
    const save = el('<button class="btn-primary" type="button">Сохранить анализ</button>');
    save.addEventListener('click', async () => {
      const entry = { date: $('#f-date', form).value || dateKey(), note: $('#f-note', form).value.trim() };
      $$('[data-field]', form).forEach((inp) => { if (inp.value !== '') entry[inp.dataset.field] = Number(inp.value); });
      await Storage.addTest(entry);
      showForm = false; await paint(); flash('Анализ сохранён ✓');
    });
    form.appendChild(save);
    return form;
  }
  await paint();
  return screen;
}

/* =========================================================
   Drawer-экраны
   ========================================================= */
async function ProfileScreen() {
  const screen = el('<div></div>');
  async function paint() {
    const p = await Storage.getProfile();
    screen.innerHTML = '';
    screen.appendChild(backHeader('Профиль', { label: 'Назад', onBack: goBack }));
    const avatar = p.photo ? `<img class="profile-avatar" src="${esc(p.photo)}" alt="">` : `<div class="profile-avatar profile-avatar--ph">👤</div>`;
    const card = el(`
      <div class="input-card" style="text-align:center">
        ${avatar}
        <div style="margin-top:12px"><label class="field__label">Имя</label><input class="input" id="p-name" value="${esc(p.name || '')}" placeholder="Имя"></div>
        <div style="margin-top:10px"><label class="field__label">Фото</label><input class="input" id="p-photo" type="file" accept="image/*"></div>
      </div>
    `);
    const save = el('<button class="btn-primary" type="button">Сохранить</button>');
    save.addEventListener('click', async () => {
      const patch = { name: $('#p-name', card).value.trim() };
      const file = $('#p-photo', card).files[0];
      if (file) patch.photo = await readImage(file);
      await Storage.setProfile(patch);
      await paint(); buildDrawer(); flash('Профиль сохранён ✓');
    });
    screen.appendChild(card);
    screen.appendChild(save);
  }
  await paint();
  return screen;
}
function readImage(file) {
  return new Promise((res) => {
    const img = new Image();
    const r = new FileReader();
    r.onload = () => {
      img.onload = () => {
        const sz = 200;
        const c = document.createElement('canvas');
        c.width = sz; c.height = sz;
        const ctx = c.getContext('2d');
        const min = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, sz, sz);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

/* =========================================================
   Резервная копия (#/export): создать файл / восстановить из файла.
   Файл остаётся только у пользователя — LexLife никуда его не отправляет.
   ========================================================= */
const fmtDateTime = (iso) => new Date(iso).toLocaleString(RU, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/* Сохранить JSON-файл: Share Sheet iOS («Сохранить в Файлы», iCloud Drive, AirDrop),
   если Web Share API умеет файлы; иначе — обычное скачивание Blob.
   → 'shared' | 'downloaded' | 'cancelled' | 'need-tap' (share требует нового касания) */
async function saveBackupFile(json, fileName) {
  const file = new File([json], fileName, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      if (err && err.name === 'NotAllowedError') return 'need-tap';
      /* иная ошибка share → запасной путь через скачивание */
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

async function ExportScreen() {
  const screen = el('<div></div>');
  screen.appendChild(backHeader('Резервная копия', { label: 'Назад', onBack: goBack }));

  const lastCard = el('<div class="input-card"><p class="backup-last"></p></div>');
  async function paintLast() {
    const last = await Storage.getLastBackupAt();
    $('.backup-last', lastCard).innerHTML = last
      ? `Последняя копия создана: <b>${esc(fmtDateTime(last))}</b>`
      : 'На этом устройстве резервная копия ещё не создавалась.';
  }
  await paintLast();
  screen.appendChild(lastCard);

  screen.appendChild(el(`
    <div class="input-card">
      <p class="backup-note">Резервная копия — один JSON-файл со всеми данными LexLife: показатели и их история, вода, лекарства, анализы, врачи и визиты, уведомления, цели, профиль и настройки.</p>
      <p class="backup-note">С помощью этого файла данные можно восстановить на этом или другом устройстве.</p>
    </div>
  `));
  screen.appendChild(el(`
    <div class="input-card backup-warn">
      <p class="backup-note"><b>🔒 Файл содержит личные данные о здоровье и не зашифрован.</b> Храните его в надёжном месте (например, «Файлы» → iCloud Drive) и не пересылайте посторонним.</p>
      <p class="backup-note">LexLife никуда не отправляет резервную копию — файл остаётся только у вас.</p>
    </div>
  `));

  const actions = el('<div class="backup-actions"></div>');
  const exp = el('<button class="btn-primary" type="button">Создать резервную копию</button>');
  exp.addEventListener('click', async () => {
    exp.classList.add('is-busy');
    try {
      const b = await Storage.createBackup();
      if (!b.verified) {
        const go = await showDialog({
          title: 'Проверка копии',
          body: '<p>Копия создана, но самопроверка обнаружила нестандартные данные — восстановить её может не получиться. Всё равно сохранить файл?</p>',
          actions: [{ label: 'Отмена', value: false }, { label: 'Сохранить', value: true, kind: 'primary' }],
        });
        if (!go) return;
      }
      let res = await saveBackupFile(b.json, b.fileName);
      if (res === 'need-tap') {
        /* iOS требует, чтобы Share Sheet открывался прямо из касания — даём кнопку */
        res = await new Promise((resolve) => {
          showDialog({
            title: 'Резервная копия готова',
            body: `<p>${esc(b.fileName)}</p><p class="dialog__muted">Нажмите «Сохранить», затем выберите «Сохранить в Файлы» или другое место.</p>`,
            actions: [
              { label: 'Отмена', value: 'cancelled' },
              { label: 'Сохранить', kind: 'primary', value: null, onClick: () => { saveBackupFile(b.json, b.fileName).then(resolve); } },
            ],
          }).then((v) => { if (v) resolve(v); });
        });
      }
      if (res === 'shared' || res === 'downloaded') {
        await Storage.markBackupCreated(b.createdAt);
        await paintLast();
        flash(res === 'shared' ? 'Резервная копия создана ✓' : 'Файл резервной копии сформирован ✓');
      }
    } catch (err) {
      await showDialog({ title: 'Не удалось создать копию', body: '<p>Попробуйте ещё раз.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
    } finally {
      exp.classList.remove('is-busy');
    }
  });
  actions.appendChild(exp);

  const impLabel = el('<label class="btn-ghost">Восстановить из копии<input type="file" accept=".json,application/json" hidden></label>');
  const input = $('input', impLabel);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = ''; // тот же файл можно выбрать повторно
    if (!file) return;
    impLabel.classList.add('is-busy');
    try {
      await restoreFlow(file);
    } finally {
      impLabel.classList.remove('is-busy');
    }
  });
  actions.appendChild(impLabel);
  screen.appendChild(actions);

  screen.appendChild(el('<p class="empty" style="padding-top:14px">Перед восстановлением LexLife делает защитную копию текущих данных и при любой ошибке автоматически возвращает их.</p>'));
  return screen;
}

/* Выбор файла → проверка → предпросмотр → (подтверждение) → атомарное восстановление */
async function restoreFlow(file) {
  const fail = (msg) => showDialog({
    title: 'Восстановление невозможно',
    body: `<p>${esc(msg)}</p><p class="dialog__muted">Текущие данные не изменены.</p>`,
    actions: [{ label: 'Понятно', value: true, kind: 'primary' }],
  });
  let prepared;
  try {
    if (file.size > 10 * 1024 * 1024) throw new BackupError('TOO_LARGE', 'Файл слишком большой для резервной копии LexLife.');
    prepared = await Storage.prepareRestore(parseBackup(await file.text()));
  } catch (err) {
    await fail(err instanceof BackupError ? err.message : 'Не удалось прочитать файл резервной копии.');
    return;
  }

  const { info, summary } = prepared;
  const rows = [
    ['Показатели', `${summary.metrics} ${plural(summary.metrics, 'запись', 'записи', 'записей')}`],
    ['Лекарства', summary.meds],
    ['Анализы', summary.tests],
    ['Визиты', summary.visits],
    ['Уведомления', summary.notifications],
    ['Дни активности', summary.activityDays],
  ];
  const schemaLine = info.migrated ? `${info.schemaVersion} → будет обновлена до ${CURRENT_SCHEMA_VERSION}` : String(info.schemaVersion);
  const skipped = prepared.ignoredKeys.length + prepared.strippedKeys;
  const body = `
    <ul class="dialog__list">
      <li><span>Дата создания</span><span>${esc(info.createdAt ? fmtDateTime(info.createdAt) : 'неизвестна')}</span></li>
      <li><span>Версия приложения</span><span>${esc(info.appVersion || 'неизвестна')}</span></li>
      <li><span>Версия схемы</span><span>${esc(schemaLine)}</span></li>
    </ul>
    <ul class="dialog__list">
      ${rows.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('')}
    </ul>
    ${skipped ? `<p class="dialog__muted">Пропущено неизвестных разделов: ${skipped}.</p>` : ''}
    <p class="dialog__warn">Восстановление заменит текущие данные LexLife данными из выбранной резервной копии.</p>
  `;
  const go = await showDialog({
    title: 'Резервная копия LexLife',
    body,
    actions: [{ label: 'Отмена', value: false }, { label: 'Восстановить', value: true, kind: 'danger' }],
  });
  if (!go) { flash('Восстановление отменено'); return; }

  try {
    await Storage.restoreBackup(prepared);
  } catch (err) {
    await showDialog({
      title: 'Ошибка восстановления',
      body: `<p>${esc(err instanceof BackupError ? err.message : 'Не удалось восстановить данные.')}</p>`,
      actions: [{ label: 'Понятно', value: true, kind: 'primary' }],
    });
    return;
  }
  applyTheme(getTheme());
  await showDialog({
    title: 'Готово',
    body: '<p>Данные успешно восстановлены</p>',
    actions: [{ label: 'Продолжить', value: true, kind: 'primary' }],
  });
  /* запись завершена и проверена — перезапуск, чтобы все экраны и напоминания перечитали базу */
  location.hash = '#/home';
  location.reload();
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function ThemeScreen() {
  const screen = el('<div></div>');
  function paint() {
    const t = getTheme();
    screen.innerHTML = '';
    screen.appendChild(backHeader('Тема оформления', { label: 'Назад', onBack: goBack }));
    const list = el('<section class="section" style="margin-top:8px"><div class="list-card"></div></section>');
    const box = $('.list-card', list);
    [['dark', '🌙 Тёмная'], ['light', '☀️ Светлая']].forEach(([val, label]) => {
      const row = el(`<div class="row" role="button"><div class="row__body"><p class="row__title">${label}</p></div>${t === val ? '<span class="row__trailing" style="color:var(--blue)">✓</span>' : ''}</div>`);
      row.addEventListener('click', () => { setTheme(val); paint(); });
      box.appendChild(row);
    });
    screen.appendChild(list);
  }
  paint();
  return screen;
}

async function SettingsScreen() {
  const screen = el('<div></div>');
  screen.appendChild(backHeader('Настройки', { label: 'Назад', onBack: goBack }));
  const list = el('<section class="section" style="margin-top:8px"><div class="list-card"></div></section>');
  const box = $('.list-card', list);
  [
    { route: 'theme', icon: '🌙', title: 'Тема оформления' },
    { route: 'export', icon: '💾', title: 'Резервная копия' },
    { route: 'security', icon: '🔒', title: 'Безопасность' },
  ].forEach((m) => {
    const row = el(`<div class="row" role="button" data-route="${m.route}"><span class="row__icon">${m.icon}</span><div class="row__body"><p class="row__title">${esc(m.title)}</p></div><span class="row__chevron">›</span></div>`);
    box.appendChild(row);
  });
  list.addEventListener('click', onRouteClick);
  screen.appendChild(list);

  const danger = el('<section class="section"><div class="list-card"></div></section>');
  const reset = el('<div class="row" role="button"><span class="row__icon">🗑️</span><div class="row__body"><p class="row__title" style="color:var(--red)">Сбросить все данные</p><p class="row__sub">Удалить все данные LexLife с этого устройства</p></div></div>');
  reset.addEventListener('click', async () => {
    const ok = await showDialog({
      title: 'Сбросить все данные',
      body: '<p>Удалить все данные LexLife с этого устройства? Это действие нельзя отменить, если у вас нет резервной копии.</p>',
      actions: [{ label: 'Отмена', value: false }, { label: 'Удалить данные', value: true, kind: 'danger' }],
    });
    if (ok) { await Storage.clearAll(); location.hash = '#/home'; location.reload(); }
  });
  $('.list-card', danger).appendChild(reset);
  screen.appendChild(danger);
  screen.appendChild(el(`
    <section class="section">
      <h2 class="group-label">О приложении</h2>
      <div class="list-card">
        <div class="row"><div class="row__body"><p class="row__title">Версия приложения</p></div><span class="row__trailing">${esc(APP_VERSION)}</span></div>
      </div>
    </section>
  `));
  screen.appendChild(appFooter());
  return screen;
}

/* Footer с версией (Настройки, Drawer): номер — из APP_VERSION, дата релиза — из APP_UPDATED */
function appFooter() {
  return el(`<footer class="app-footer"><p class="app-footer__name">LexLife · v${esc(APP_VERSION)}</p><p class="app-footer__date">Обновлено: ${esc(APP_UPDATED)}</p></footer>`);
}

/* ---------- под-экран: Активность ---------- */
async function ActivityScreen() {
  const screen = el('<div></div>');
  const goals = await Storage.getGoals();
  let intensity = 'Средняя';
  async function paint() {
    const [today, streak, waterToday] = await Promise.all([Storage.getActivity(), Storage.getStreak(), Storage.getWater()]);
    const cur = today || {};
    intensity = cur.bikeIntensity || intensity;
    screen.innerHTML = '';
    screen.appendChild(backHeader('Активность', { label: 'Назад', onBack: goBack }));
    const stats = el(`
      <div class="stat-row">
        <div class="stat"><div class="stat__num">${streak} 🔥</div><div class="stat__label">дней подряд</div></div>
        <div class="stat stat--link" data-route="metric/water"><div class="stat__num">${fmtMl(waterToday)} мл</div><div class="stat__label">вода сегодня ›</div></div>
      </div>
    `);
    $('[data-route="metric/water"]', stats).addEventListener('click', () => { location.hash = '#/metric/water'; });
    screen.appendChild(stats);

    const bike = el(`
      <div class="input-card">
        <div class="input-card__head"><span class="input-card__emoji">🚴</span><span class="input-card__title">Велотренажёр</span></div>
        <div class="field"><label class="field__label">Длительность (минуты), цель ${goals.bike_minutes}</label><input class="input" type="number" inputmode="numeric" id="a-bike" value="${esc(cur.bike ?? '')}" placeholder="0"></div>
        <label class="field__label">Интенсивность</label><div class="seg" id="a-intensity"></div>
      </div>
    `);
    const seg = $('#a-intensity', bike);
    ['Лёгкая', 'Средняя', 'Интенсивная'].forEach((lvl) => {
      const b = el(`<button class="seg__btn ${lvl === intensity ? 'is-active' : ''}" type="button">${lvl}</button>`);
      b.addEventListener('click', () => { intensity = lvl; $$('.seg__btn', seg).forEach((x) => x.classList.toggle('is-active', x.textContent === lvl)); });
      seg.appendChild(b);
    });
    screen.appendChild(bike);
    screen.appendChild(el(`<div class="input-card"><div class="input-card__head"><span class="input-card__emoji">👟</span><span class="input-card__title">Шаги</span></div><div class="field" style="margin:0"><label class="field__label">Количество, цель ${goals.steps}</label><input class="input" type="number" inputmode="numeric" id="a-steps" value="${esc(cur.steps ?? '')}" placeholder="0"></div></div>`));
    const plank = cur.plank || [];
    screen.appendChild(el(`<div class="input-card"><div class="input-card__head"><span class="input-card__emoji">🧘</span><span class="input-card__title">Планка</span></div><div class="field"><label class="field__label">Подходов</label><input class="input" type="number" inputmode="numeric" id="a-plank-sets" value="${plank.length || ''}" placeholder="0"></div><div class="field" style="margin:0"><label class="field__label">Секунд в подходе, цель ${goals.plank_seconds}</label><input class="input" type="number" inputmode="numeric" id="a-plank-sec" value="${plank[0] ?? ''}" placeholder="0"></div></div>`));
    screen.appendChild(el(`<div class="input-card"><div class="input-card__head"><span class="input-card__emoji">➕</span><span class="input-card__title">Другое упражнение</span></div><div class="field"><label class="field__label">Тип</label><input class="input" type="text" id="a-other-type" value="${esc(cur.otherType ?? '')}" placeholder="напр. плавание"></div><div class="field" style="margin:0"><label class="field__label">Длительность (минуты)</label><input class="input" type="number" inputmode="numeric" id="a-other-min" value="${esc(cur.otherMin ?? '')}" placeholder="0"></div></div>`));
    const save = el('<button class="btn-primary" type="button">Сохранить день</button>');
    save.addEventListener('click', onSave);
    screen.appendChild(save);
  }
  async function onSave() {
    const num = (id) => { const v = $(`#${id}`, screen).value; return v === '' ? null : Number(v); };
    const sets = num('a-plank-sets') || 0, sec = num('a-plank-sec') || 0;
    await Storage.saveActivity({ bike: num('a-bike'), bikeIntensity: intensity, steps: num('a-steps'), plank: sets > 0 ? Array(sets).fill(sec) : [], otherType: $('#a-other-type', screen).value.trim(), otherMin: num('a-other-min') });
    await paint(); flash('День сохранён ✓');
  }
  await paint();
  return screen;
}

/* ---------- под-экран: Архив ---------- */
/* =========================================================
   Модуль «Врачи и визиты» (Drawer): список → деталь → форма
   ========================================================= */
async function VisitsScreen() {
  const visits = await Storage.getVisits();
  const screen = el('<div></div>');
  screen.appendChild(backHeader('Врачи и визиты', { label: 'Назад', onBack: goBack }));

  const add = el('<button class="btn-ghost" type="button" style="margin:8px 0 4px">+ Добавить визит</button>');
  add.addEventListener('click', () => { location.hash = '#/visit/new'; });
  screen.appendChild(add);

  const planned = visits.filter((v) => v.status === 'planned').sort((a, b) => a.date.localeCompare(b.date));
  const done = visits.filter((v) => v.status !== 'planned');

  const group = (title, arr) => {
    if (!arr.length) return;
    const sec = el(`<section class="section" style="margin-top:14px"><div class="section__head"><h2 class="section__title">${esc(title)}</h2></div><div class="list-card"></div></section>`);
    const box = $('.list-card', sec);
    arr.forEach((v) => {
      const row = el(`
        <div class="row" role="button" data-id="${esc(v.id)}" style="align-items:flex-start">
          <span class="row__icon">🩺</span>
          <div class="row__body">
            <p class="row__title">${esc(v.doctor || 'Визит')}</p>
            <p class="row__sub">${esc([v.specialty, v.clinic].filter(Boolean).join(' · ') || v.conclusion || '')}</p>
          </div>
          <span class="row__trailing">${esc(fmtDate(v.date))}<br><span class="row__chevron">›</span></span>
        </div>
      `);
      box.appendChild(row);
    });
    sec.addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) location.hash = `#/visit/${r.dataset.id}`; });
    screen.appendChild(sec);
  };
  group('Запланированные', planned);
  group('Прошедшие', done);
  if (!visits.length) screen.appendChild(el('<div class="empty">Пока нет визитов</div>'));
  return screen;
}

async function VisitDetailScreen(id) {
  const [visit, tests, meds] = await Promise.all([Storage.getVisit(id), Storage.getTests(), Storage.getMeds()]);
  const screen = el('<div></div>');
  if (!visit) { screen.appendChild(backHeader('Визит', { label: 'Визиты', onBack: () => { location.hash = '#/visits'; } })); screen.appendChild(el('<div class="empty">Визит не найден</div>')); return screen; }
  screen.appendChild(backHeader('Визит', { label: 'Визиты', onBack: () => { location.hash = '#/visits'; } }));

  const statusChip = visit.status === 'planned'
    ? '<span class="vchip vchip--planned">запланирован</span>'
    : '<span class="vchip vchip--done">выполнен</span>';
  screen.appendChild(el(`
    <div class="visit-head">
      <span class="visit-head__icon">🩺</span>
      <div>
        <div class="visit-head__name">${esc(visit.doctor || 'Визит')}</div>
        <div class="visit-head__sub">${esc([visit.specialty, visit.clinic].filter(Boolean).join(' · '))}</div>
        <div style="margin-top:6px"><span class="visit-head__date">${esc(fmtDate(visit.date))}</span> ${statusChip}</div>
      </div>
    </div>
  `));

  const field = (label, val) => { if (val) screen.appendChild(el(`<div class="vfield"><div class="vfield__label">${esc(label)}</div><div class="vfield__val">${esc(val)}</div></div>`)); };
  field('Причина обращения', visit.reason);
  field('Заключение', visit.conclusion);
  field('Рекомендации', visit.recommendations);

  if (visit.nextDate) {
    screen.appendChild(el(`
      <div class="row" style="margin-top:14px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius)">
        <span class="row__icon">📅</span>
        <div class="row__body"><p class="row__sub" style="margin:0">Следующий визит</p><p class="row__title" style="margin:2px 0 0">${esc(fmtDate(visit.nextDate))}</p></div>
        <span class="row__trailing" style="color:var(--blue)">🔔 напомнить</span>
      </div>
    `));
  }

  const linkedTests = (visit.links?.testIds || []).map((tid) => tests.find((t) => t.id === tid)).filter(Boolean);
  const linkedMeds = (visit.links?.medIds || []).map((mid) => meds.find((m) => m.id === mid)).filter(Boolean);
  const chips = (label, arr, render) => {
    const sec = el(`<section class="section"><div class="section__head"><h2 class="section__title" style="font-size:15px">${esc(label)}</h2></div><div class="vchips"></div></section>`);
    const box = $('.vchips', sec);
    if (!arr.length) box.appendChild(el('<span class="empty" style="padding:6px 0">—</span>'));
    else arr.forEach((x) => box.appendChild(el(`<span class="vlink">${render(x)}</span>`)));
    screen.appendChild(sec);
  };
  chips('Связанные анализы', linkedTests, (t) => `🧪 ${esc(fmtDate(t.date))}`);
  chips('Связанные лекарства', linkedMeds, (m) => `💊 ${esc(m.name)}`);

  const att = el('<section class="section"><div class="section__head"><h2 class="section__title" style="font-size:15px">Вложения</h2></div><div class="list-card" id="attbox"></div></section>');
  const abox = $('#attbox', att);
  if (!(visit.attachments || []).length) abox.appendChild(el('<div class="empty">Нет вложений</div>'));
  else visit.attachments.forEach((a) => abox.appendChild(el(`<div class="row"><span class="row__icon">${a.kind === 'pdf' ? '📄' : '🖼️'}</span><div class="row__body"><p class="row__title">${esc(a.name)}</p><p class="row__sub">${a.size ? Math.round(a.size / 1024) + ' КБ' : ''} · файл подключим позже</p></div></div>`)));
  screen.appendChild(att);

  const actions = el('<div style="display:flex; gap:10px; margin-top:16px"></div>');
  const edit = el('<button class="btn-ghost" type="button" style="margin:0">Редактировать</button>');
  edit.addEventListener('click', () => { location.hash = `#/visit/${id}/edit`; });
  const del = el('<button class="btn-ghost" type="button" style="margin:0; color:var(--red)">Удалить</button>');
  del.addEventListener('click', async () => { if (confirm('Удалить визит?')) { await Storage.removeVisit(id); location.hash = '#/visits'; } });
  actions.append(edit, del);
  screen.appendChild(actions);
  return screen;
}

async function VisitFormScreen(id) {
  const [existing, tests, meds] = await Promise.all([id ? Storage.getVisit(id) : null, Storage.getTests(), Storage.getMeds()]);
  const v = existing || { date: dateKey(), status: 'done', links: { testIds: [], medIds: [], reminderIds: [] }, attachments: [] };
  const screen = el('<div></div>');
  screen.appendChild(backHeader(id ? 'Редактировать визит' : 'Новый визит', { label: 'Назад', onBack: goBack }));
  const form = el('<div class="input-card"></div>');
  const fld = (label, html) => `<div class="field"><label class="field__label">${esc(label)}</label>${html}</div>`;
  form.innerHTML = `
    ${fld('Дата', `<input class="input" type="date" id="f-date" value="${esc(v.date)}">`)}
    ${fld('Врач', `<input class="input" type="text" id="f-doctor" value="${esc(v.doctor || '')}" placeholder="напр. Dr. Ivanov">`)}
    ${fld('Специальность', `<input class="input" type="text" id="f-spec" value="${esc(v.specialty || '')}" placeholder="напр. Кардиолог">`)}
    ${fld('Клиника', `<input class="input" type="text" id="f-clinic" value="${esc(v.clinic || '')}">`)}
    ${fld('Причина обращения', `<input class="input" type="text" id="f-reason" value="${esc(v.reason || '')}">`)}
    ${fld('Заключение', `<textarea class="input" id="f-concl" rows="2">${esc(v.conclusion || '')}</textarea>`)}
    ${fld('Рекомендации', `<textarea class="input" id="f-rec" rows="2">${esc(v.recommendations || '')}</textarea>`)}
    ${fld('Дата следующего визита', `<input class="input" type="date" id="f-next" value="${esc(v.nextDate || '')}">`)}
    ${fld('Статус', `<select class="select" id="f-status"><option value="done" ${v.status === 'done' ? 'selected' : ''}>Выполнен</option><option value="planned" ${v.status === 'planned' ? 'selected' : ''}>Запланирован</option></select>`)}
  `;
  screen.appendChild(form);

  const pick = (label, items, sel, render) => {
    const sec = el(`<div class="input-card"><label class="field__label">${esc(label)}</label><div class="vpick"></div></div>`);
    const box = $('.vpick', sec);
    items.forEach((it) => {
      const on = sel.includes(it.id);
      const b = el(`<button class="vpick__chip ${on ? 'is-on' : ''}" type="button" data-id="${esc(it.id)}">${render(it)}</button>`);
      b.addEventListener('click', () => { b.classList.toggle('is-on'); });
      box.appendChild(b);
    });
    screen.appendChild(sec);
    return () => $$('.vpick__chip.is-on', sec).map((c) => c.dataset.id);
  };
  const getTestIds = pick('Связать анализы', tests, v.links?.testIds || [], (t) => `🧪 ${fmtDate(t.date)}`);
  const getMedIds = pick('Связать лекарства', meds, v.links?.medIds || [], (m) => `💊 ${esc(m.name)}`);

  const save = el(`<button class="btn-primary" type="button">${id ? 'Сохранить' : 'Добавить визит'}</button>`);
  save.addEventListener('click', async () => {
    const data = {
      date: $('#f-date', form).value || dateKey(),
      doctor: $('#f-doctor', form).value.trim(),
      specialty: $('#f-spec', form).value.trim(),
      clinic: $('#f-clinic', form).value.trim(),
      reason: $('#f-reason', form).value.trim(),
      conclusion: $('#f-concl', form).value.trim(),
      recommendations: $('#f-rec', form).value.trim(),
      nextDate: $('#f-next', form).value || null,
      status: $('#f-status', form).value,
      links: { testIds: getTestIds(), medIds: getMedIds(), reminderIds: v.links?.reminderIds || [] },
    };
    if (id) { await Storage.updateVisit(id, data); location.hash = `#/visit/${id}`; }
    else { const created = await Storage.addVisit(data); location.hash = `#/visit/${created.id}`; }
    flash('Сохранено ✓');
  });
  screen.appendChild(save);
  return screen;
}

/* =========================================================
   Центр уведомлений
   ========================================================= */
const NOTIF_TYPES = {
  meds: { emoji: '🔔', name: 'Лекарства' }, water: { emoji: '💧', name: 'Вода' },
  pressure: { emoji: '🩺', name: 'Давление' }, weight: { emoji: '⚖️', name: 'Вес' },
  tests: { emoji: '🧪', name: 'Анализы' }, visits: { emoji: '👨‍⚕️', name: 'Визиты' },
};
const NOTIF_ORDER = ['meds', 'water', 'pressure', 'weight', 'tests', 'visits'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const parseHM = (s) => { const [h, m] = (s || '09:00').split(':').map(Number); return { h, m }; };
const atTime = (date, hm) => { const d = new Date(date); d.setHours(hm.h, hm.m, 0, 0); return d; };
const okDay = (rule, d) => { const dow = d.getDay(); if (rule.repeat === 'weekdays') return dow >= 1 && dow <= 5; if (rule.repeat === 'weekly') return (rule.days || []).includes(dow); return true; };

function nextFire(rule, now = new Date()) {
  const hm = parseHM(rule.time);
  if (rule.repeat === 'once') { if (!rule.date) return null; const d = atTime(new Date(rule.date + 'T00:00:00'), hm); return d > now ? d : null; }
  if (rule.repeat === 'interval') {
    const s = parseHM(rule.startTime || '07:00'), e = parseHM(rule.endTime || '23:00'), step = rule.intervalMinutes || 120;
    const sM = s.h * 60 + s.m, eM = e.h * 60 + e.m, nM = now.getHours() * 60 + now.getMinutes();
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    if (nM < sM) { const d = new Date(d0); d.setMinutes(sM); return d; }
    if (nM <= eM) { const k = Math.floor((nM - sM) / step) + 1, slot = sM + k * step; if (slot <= eM) { const d = new Date(d0); d.setMinutes(slot); return d; } }
    const d = new Date(d0); d.setDate(d.getDate() + 1); d.setMinutes(sM); return d;
  }
  for (let i = 0; i < 8; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const f = atTime(d, hm); if (okDay(rule, d) && f > now) return f; }
  return null;
}
function prevFire(rule, now = new Date()) {
  const hm = parseHM(rule.time);
  if (rule.repeat === 'once') { if (!rule.date) return null; const d = atTime(new Date(rule.date + 'T00:00:00'), hm); return d <= now ? d : null; }
  if (rule.repeat === 'interval') {
    const s = parseHM(rule.startTime || '07:00'), e = parseHM(rule.endTime || '23:00'), step = rule.intervalMinutes || 120;
    const sM = s.h * 60 + s.m, eM = e.h * 60 + e.m, nM = now.getHours() * 60 + now.getMinutes();
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    if (nM >= sM) { const slot = sM + Math.floor((Math.min(nM, eM) - sM) / step) * step; if (slot <= nM) { const d = new Date(d0); d.setMinutes(slot); return d; } }
    const d = new Date(d0); d.setDate(d.getDate() - 1); d.setMinutes(sM + Math.floor((eM - sM) / step) * step); return d;
  }
  for (let i = 0; i < 8; i++) { const d = new Date(now); d.setDate(d.getDate() - i); const f = atTime(d, hm); if (okDay(rule, d) && f <= now) return f; }
  return null;
}
function fmtNext(d) {
  if (!d) return null;
  const now = new Date(), diff = d - now;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff > 0 && diff < 3600000) return `через ${Math.max(1, Math.round(diff / 60000))} мин`;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0); const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
  const days = Math.round((d0 - t0) / 86400000);
  if (days === 0) return `сегодня ${hm}`;
  if (days === 1) return `завтра ${hm}`;
  if (days > 1 && days < 7) return `${WD[d.getDay()]}, ${hm}`;
  return `${fmtDate(dateKey(d))}, ${hm}`;
}
function repeatSummary(r) {
  if (r.repeat === 'interval') return `каждые ${(r.intervalMinutes || 120) / 60} ч · ${r.startTime || '07:00'}–${r.endTime || '23:00'}`;
  if (r.repeat === 'weekly') return `${(r.days || []).map((d) => WD[d]).join(', ') || '—'} ${r.time} · еженедельно`;
  if (r.repeat === 'weekdays') return `${r.time} · будни`;
  if (r.repeat === 'once') return `${r.date ? fmtDate(r.date) : '—'} ${r.time} · разово`;
  return `${r.time} · ежедневно`;
}

/* доставка «пока приложение открыто» (PWA-ограничение; модель готова под push) */
const Notifier = {
  timer: null,
  start() { if (!('Notification' in window)) return; this.check(); clearInterval(this.timer); this.timer = setInterval(() => this.check(), 60000); },
  async check() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const list = await Storage.getNotifications(); const now = new Date();
    for (const r of list) {
      if (!r.enabled) continue;
      const prev = prevFire(r, now); if (!prev) continue;
      const last = r.lastFiredAt ? new Date(r.lastFiredAt) : null;
      if ((!last || prev > last) && (now - prev) < 10 * 60000) { this.show(r); await Storage.updateNotification(r.id, { lastFiredAt: prev.toISOString() }); }
    }
  },
  show(r) {
    const t = NOTIF_TYPES[r.type] || {};
    const title = `${t.emoji || '🔔'} ${t.name || 'Напоминание'}`;
    const opts = { body: r.text || '', tag: r.id, icon: 'icons/lexlife-icon-192.png' };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch (e) {} });
      else new Notification(title, opts);
    } catch (e) { /* ignore */ }
  },
};

async function NotificationsScreen() {
  const screen = el('<div></div>');
  let editing = null;

  async function paint() {
    const list = await Storage.getNotifications();
    screen.innerHTML = '';
    screen.appendChild(backHeader('Уведомления', { label: 'Назад', onBack: goBack }));

    const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    if (perm !== 'granted') {
      const banner = el(`<div class="notif-perm"><i style="font-size:18px">🔔</i><span style="flex:1">${perm === 'unsupported' ? 'Уведомления не поддерживаются браузером' : 'Разрешите уведомления, чтобы получать напоминания'}</span>${perm === 'default' ? '<button class="notif-perm__btn" type="button">Разрешить</button>' : ''}</div>`);
      const b = $('.notif-perm__btn', banner);
      if (b) b.addEventListener('click', async () => { await ensureNotifyPermission(); Notifier.start(); await paint(); });
      screen.appendChild(banner);
    }

    const wrap = el('<div class="notif-list"></div>');
    NOTIF_ORDER.forEach((type) => { const r = list.find((n) => n.type === type); if (r) wrap.appendChild(card(r)); });
    screen.appendChild(wrap);
  }

  function card(r) {
    const T = NOTIF_TYPES[r.type];
    const next = r.enabled ? fmtNext(nextFire(r)) : null;
    const c = el(`
      <div class="notif-card ${r.enabled ? '' : 'is-off'}">
        <div class="notif-card__top">
          <span class="notif-card__emoji">${T.emoji}</span>
          <span class="notif-card__name">${esc(T.name)}</span>
          <button class="rs-toggle ${r.enabled ? 'is-on' : ''}" type="button" role="switch" aria-checked="${r.enabled}"><span class="rs-toggle__knob"></span></button>
        </div>
        <div class="notif-card__body">
          <div class="notif-card__sum">${esc(repeatSummary(r))}</div>
          <div class="notif-card__text">«${esc(r.text)}»</div>
          <div class="notif-card__next">${r.enabled ? (next ? '⏰ следующее: ' + esc(next) : '⏰ —') : 'выключено'}</div>
        </div>
      </div>
    `);
    $('.rs-toggle', c).addEventListener('click', async (e) => {
      e.stopPropagation();
      const on = !r.enabled;
      if (on) await ensureNotifyPermission();
      await Storage.updateNotification(r.id, { enabled: on });
      Notifier.start();
      await paint();
    });
    $('.notif-card__body', c).addEventListener('click', () => { editing = editing === r.id ? null : r.id; paint(); });
    if (editing === r.id) c.appendChild(editor(r));
    return c;
  }

  function editor(r) {
    const wrap = el('<div class="notif-edit"></div>');
    const reps = [['daily', 'Ежедневно'], ['weekdays', 'Будни'], ['weekly', 'Еженедельно'], ['interval', 'Каждые N часов'], ['once', 'Разово']];
    wrap.innerHTML = `
      <div class="field"><label class="field__label">Текст</label><input class="input" id="e-text" value="${esc(r.text)}"></div>
      <div class="field"><label class="field__label">Периодичность</label><select class="select" id="e-rep">${reps.map(([v, l]) => `<option value="${v}" ${r.repeat === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div id="e-extra"></div>
    `;
    const extra = $('#e-extra', wrap);
    const addWD = (box, i) => { const on = (r.days || []).includes(i); const b = el(`<button class="wd-chip ${on ? 'is-on' : ''}" type="button" data-d="${i}">${WD[i]}</button>`); b.addEventListener('click', () => b.classList.toggle('is-on')); box.appendChild(b); };
    function renderExtra(rep) {
      extra.innerHTML = '';
      if (rep === 'interval') {
        extra.appendChild(el(`<div class="field"><label class="field__label">Интервал</label><select class="select" id="e-int">${[60, 90, 120, 180, 240].map((m) => `<option value="${m}" ${r.intervalMinutes === m ? 'selected' : ''}>${m / 60} ч</option>`).join('')}</select></div>`));
        extra.appendChild(el(`<div class="rs-row"><label class="field__label" style="margin:0">С</label><input class="input" type="time" id="e-start" value="${esc(r.startTime || '07:00')}" style="width:120px"></div>`));
        extra.appendChild(el(`<div class="rs-row"><label class="field__label" style="margin:0">До</label><input class="input" type="time" id="e-end" value="${esc(r.endTime || '23:00')}" style="width:120px"></div>`));
      } else if (rep === 'once') {
        extra.appendChild(el(`<div class="field"><label class="field__label">Дата</label><input class="input" type="date" id="e-date" value="${esc(r.date || dateKey())}"></div>`));
        extra.appendChild(el(`<div class="field"><label class="field__label">Время</label><input class="input" type="time" id="e-time" value="${esc(r.time)}"></div>`));
      } else {
        extra.appendChild(el(`<div class="field"><label class="field__label">Время</label><input class="input" type="time" id="e-time" value="${esc(r.time)}"></div>`));
        if (rep === 'weekly') {
          const days = el('<div class="field"><label class="field__label">Дни</label><div class="wd-pick"></div></div>');
          const box = $('.wd-pick', days);
          [1, 2, 3, 4, 5, 6, 0].forEach((i) => addWD(box, i));
          extra.appendChild(days);
        }
      }
    }
    renderExtra(r.repeat);
    $('#e-rep', wrap).addEventListener('change', (e) => renderExtra(e.target.value));
    const save = el('<button class="btn-primary" type="button" style="margin-top:6px">Сохранить</button>');
    save.addEventListener('click', async () => {
      const rep = $('#e-rep', wrap).value;
      const patch = { text: $('#e-text', wrap).value.trim(), repeat: rep, lastFiredAt: null };
      if (rep === 'interval') { patch.intervalMinutes = Number($('#e-int', wrap).value); patch.startTime = $('#e-start', wrap).value; patch.endTime = $('#e-end', wrap).value; }
      else if (rep === 'once') { patch.date = $('#e-date', wrap).value; patch.time = $('#e-time', wrap).value; }
      else { patch.time = $('#e-time', wrap).value; if (rep === 'weekly') patch.days = $$('.wd-chip.is-on', wrap).map((c) => Number(c.dataset.d)); }
      await Storage.updateNotification(r.id, patch); editing = null; Notifier.start(); await paint(); flash('Сохранено ✓');
    });
    wrap.appendChild(save);
    return wrap;
  }

  await paint();
  return screen;
}

/* =========================================================
   Календарь здоровья — агрегатор поверх существующих данных
   (визиты, анализы, лекарства, уведомления, вода).
   Без новой модели данных. Режимы: Месяц / Неделя / Список.
   ========================================================= */
const CAL_WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

async function loadCalendarData() {
  const [visits, tests, meds, notifs, waterGoal] = await Promise.all([
    Storage.getVisits(), Storage.getTests(), Storage.getMeds(), Storage.getNotifications(), Storage.getWaterGoal(),
  ]);
  const nextDoses = meds
    .filter((m) => m.active && m.every_days)
    .map((m) => ({ med: m, date: nextDose(m) }))
    .filter((x) => x.date);
  return { visits, tests, meds, notifs, waterGoal, nextDoses };
}

/* разовые события конкретной даты — они же дают точку на сетке месяца/недели */
function dayPointEvents(dateStr, data) {
  const ev = [];
  data.visits.forEach((v) => {
    if (v.date === dateStr) ev.push({ icon: '🩺', title: v.doctor || 'Визит', sub: [v.specialty, v.clinic].filter(Boolean).join(' · ') || 'Визит к врачу', time: null, route: `visit/${v.id}` });
    if (v.nextDate === dateStr) ev.push({ icon: '📅', title: 'Следующий визит', sub: v.doctor || '', time: null, route: `visit/${v.id}` });
  });
  data.tests.forEach((t) => { if (t.date === dateStr) ev.push({ icon: '🧪', title: 'Анализ крови', sub: t.note || 'Результаты внесены', time: null, route: 'tests' }); });
  data.nextDoses.forEach(({ med, date }) => { if (date === dateStr) ev.push({ icon: '💊', title: med.name, sub: 'Следующая доза', time: null, route: 'meds' }); });
  data.notifs.forEach((n) => { if (n.enabled && n.repeat === 'once' && n.date === dateStr) ev.push({ icon: (NOTIF_TYPES[n.type] || {}).emoji || '🔔', title: n.text, sub: 'Напоминание', time: n.time, route: 'notifications' }); });
  return ev;
}
function dayHasDot(dateStr, data) {
  return dayPointEvents(dateStr, data).length > 0;
}
/* полная повестка дня: разовые события + ежедневные (лекарства, цель воды) — для панели дня */
function dayAgendaEvents(dateStr, data) {
  const ev = dayPointEvents(dateStr, data).slice();
  data.meds.forEach((m) => { if (m.active && m.reminder_time) ev.push({ icon: '💊', title: m.name, sub: 'Приём лекарства', time: m.reminder_time, route: 'meds' }); });
  ev.push({ icon: '💧', title: `Цель воды: ${fmtNum(data.waterGoal / 1000)} л`, sub: 'Ежедневная цель', time: null, route: 'metric/water' });
  ev.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  return ev;
}
function eventRow(e) {
  return el(`
    <div class="row" role="button" data-route="${esc(e.route)}">
      <span class="row__icon">${e.icon}</span>
      <div class="row__body"><p class="row__title">${esc(e.title)}</p><p class="row__sub">${esc(e.sub || '')}</p></div>
      ${e.time ? `<span class="row__trailing">${esc(e.time)}</span>` : ''}
    </div>
  `);
}

async function CalendarScreen() {
  const screen = el('<div></div>');
  const data = await loadCalendarData();
  let mode = 'month';
  let cursor = new Date(); cursor.setHours(0, 0, 0, 0);
  let selected = dateKey(cursor);

  async function paint() {
    screen.innerHTML = '';
    screen.appendChild(backHeader('Календарь', { label: 'Назад', onBack: goBack }));

    const seg = el(`
      <div class="seg" style="margin-top:8px">
        <button class="seg__btn ${mode === 'month' ? 'is-active' : ''}" data-m="month" type="button">Месяц</button>
        <button class="seg__btn ${mode === 'week' ? 'is-active' : ''}" data-m="week" type="button">Неделя</button>
        <button class="seg__btn ${mode === 'list' ? 'is-active' : ''}" data-m="list" type="button">Список</button>
      </div>
    `);
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; paint(); } });
    screen.appendChild(seg);

    if (mode === 'month') screen.appendChild(monthView());
    else if (mode === 'week') screen.appendChild(weekView());
    else screen.appendChild(listView());

    if (mode !== 'list') {
      const sec = el(`<section class="section"><div class="section__head"><h2 class="section__title" style="font-size:16px">${esc(fmtDate(selected))}</h2></div><div class="list-card" id="daybox"></div></section>`);
      const box = $('#daybox', sec);
      const evs = dayAgendaEvents(selected, data);
      if (!evs.length) box.appendChild(el('<div class="empty">Нет событий</div>'));
      else evs.forEach((e) => box.appendChild(eventRow(e)));
      sec.addEventListener('click', onRouteClick);
      screen.appendChild(sec);
    }
  }

  function monthView() {
    const sec = el('<div class="card cal-card"></div>');
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const head = el(`
      <div class="cal-nav">
        <button class="cal-nav__btn" type="button" id="cal-prev">‹</button>
        <span class="cal-nav__title">${esc(cursor.toLocaleDateString(RU, { month: 'long', year: 'numeric' }))}</span>
        <button class="cal-nav__btn" type="button" id="cal-next">›</button>
      </div>
    `);
    sec.appendChild(head);
    $('#cal-prev', head).addEventListener('click', () => { cursor = new Date(y, m - 1, 1); paint(); });
    $('#cal-next', head).addEventListener('click', () => { cursor = new Date(y, m + 1, 1); paint(); });

    const grid = el('<div class="cal-grid"></div>');
    CAL_WD.forEach((w) => grid.appendChild(el(`<span class="cal-wd">${w}</span>`)));
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayKey = dateKey(new Date());
    for (let i = 0; i < startOffset; i++) grid.appendChild(el('<span class="cal-cell cal-cell--empty"></span>'));
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateKey(new Date(y, m, d));
      const cell = el(`<button class="cal-cell ${ds === selected ? 'is-selected' : ''} ${ds === todayKey ? 'is-today' : ''}" type="button" data-d="${ds}">${d}${dayHasDot(ds, data) ? '<span class="cal-dot"></span>' : ''}</button>`);
      grid.appendChild(cell);
    }
    sec.appendChild(grid);
    grid.addEventListener('click', (e) => { const c = e.target.closest('[data-d]'); if (c) { selected = c.dataset.d; paint(); } });
    return sec;
  }

  function weekView() {
    const sec = el('<div class="card cal-card"></div>');
    const d0 = new Date(cursor); const off = (d0.getDay() + 6) % 7; d0.setDate(d0.getDate() - off);
    const d6 = new Date(d0); d6.setDate(d0.getDate() + 6);
    const head = el(`
      <div class="cal-nav">
        <button class="cal-nav__btn" type="button" id="cal-prev">‹</button>
        <span class="cal-nav__title">${esc(fmtDate(dateKey(d0)))} – ${esc(fmtDate(dateKey(d6)))}</span>
        <button class="cal-nav__btn" type="button" id="cal-next">›</button>
      </div>
    `);
    sec.appendChild(head);
    $('#cal-prev', head).addEventListener('click', () => { cursor = new Date(cursor); cursor.setDate(cursor.getDate() - 7); paint(); });
    $('#cal-next', head).addEventListener('click', () => { cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 7); paint(); });

    const strip = el('<div class="cal-week"></div>');
    const todayKey = dateKey(new Date());
    for (let i = 0; i < 7; i++) {
      const d = new Date(d0); d.setDate(d0.getDate() + i);
      const ds = dateKey(d);
      strip.appendChild(el(`
        <button class="cal-weekday ${ds === selected ? 'is-selected' : ''} ${ds === todayKey ? 'is-today' : ''}" type="button" data-d="${ds}">
          <span class="cal-weekday__wd">${CAL_WD[i]}</span>
          <span class="cal-weekday__num">${d.getDate()}</span>
          ${dayHasDot(ds, data) ? '<span class="cal-dot"></span>' : ''}
        </button>
      `));
    }
    sec.appendChild(strip);
    strip.addEventListener('click', (e) => { const c = e.target.closest('[data-d]'); if (c) { selected = c.dataset.d; paint(); } });
    return sec;
  }

  function listView() {
    const sec = el('<div></div>');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let any = false;
    for (let i = 0; i < 60; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const ds = dateKey(d);
      const evs = dayPointEvents(ds, data);
      if (!evs.length) continue;
      const isFirst = !any;
      any = true;
      const block = el(`<section class="section" style="margin-top:${isFirst ? '8' : '14'}px"><div class="section__head"><h2 class="section__title" style="font-size:15px">${esc(fmtDate(ds))}</h2></div><div class="list-card"></div></section>`);
      const box = $('.list-card', block);
      evs.forEach((e) => box.appendChild(eventRow(e)));
      block.addEventListener('click', onRouteClick);
      sec.appendChild(block);
    }
    if (!any) sec.appendChild(el('<div class="empty" style="margin-top:8px">Ближайших событий нет</div>'));
    return sec;
  }

  await paint();
  return screen;
}

/* заглушка */
function Stub(emoji, title) {
  const screen = el('<div></div>');
  screen.appendChild(backHeader(title, { label: 'Назад', onBack: goBack }));
  screen.appendChild(el(`<div class="placeholder"><div class="placeholder__emoji">${emoji}</div><h2>${esc(title)}</h2><p>Раздел в разработке — скоро.</p></div>`));
  return screen;
}

/* ---------- общие хелперы экранов ---------- */
function onRouteClick(e) {
  const nav = e.target.closest('[data-route]');
  if (nav) location.hash = `#/${nav.getAttribute('data-route')}`;
}
function backHeader(title, { label = 'Назад', onBack } = {}) {
  const h = el(`<header class="header"><button class="back-btn" type="button">‹ ${esc(label)}</button><h1 class="header__title">${esc(title)}</h1></header>`);
  $('.back-btn', h).addEventListener('click', onBack || goBack);
  return h;
}
function goBack() { if (history.length > 1) history.back(); else location.hash = '#/home'; }

/* Модальный диалог: body — готовый HTML (данные экранируются вызывающим через esc).
   actions: [{ label, value, kind: 'primary'|'danger', onClick }] — onClick вызывается
   синхронно в обработчике касания (нужно для Share Sheet на iOS). → Promise<value> */
function showDialog({ title, body = '', actions }) {
  return new Promise((resolve) => {
    const wrap = el('<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title"><div class="dialog__card"><h2 class="dialog__title" id="dlg-title"></h2><div class="dialog__body"></div><div class="dialog__actions"></div></div></div>');
    $('.dialog__title', wrap).textContent = title;
    $('.dialog__body', wrap).innerHTML = body;
    const close = (v) => { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(actions[0].value); };
    actions.forEach((a) => {
      const b = el(`<button type="button" class="dialog__btn${a.kind ? ` dialog__btn--${a.kind}` : ''}"></button>`);
      b.textContent = a.label;
      b.addEventListener('click', () => { if (a.onClick) a.onClick(); close(a.value); });
      $('.dialog__actions', wrap).appendChild(b);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    $('.dialog__btn', wrap).focus();
  });
}

let flashTimer;
function flash(text) {
  let n = $('#flash');
  if (!n) {
    n = el('<div id="flash"></div>');
    Object.assign(n.style, { position: 'fixed', left: '50%', bottom: 'calc(var(--tab-h) + 20px)', transform: 'translateX(-50%)', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', padding: '10px 18px', borderRadius: '999px', fontSize: '14px', fontWeight: '700', zIndex: '400', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', transition: 'opacity .2s' });
    document.body.appendChild(n);
  }
  n.textContent = text; n.style.opacity = '1';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (n.style.opacity = '0'), 1600);
}

/* =========================================================
   Drawer (боковое меню справа)
   ========================================================= */
const DRAWER_SECTIONS = [
  [
    { route: 'notifications', icon: '🔔', title: 'Уведомления', badge: 1 },
    { route: 'goals', icon: '🎯', title: 'Цели' },
    { route: 'calendar', icon: '📅', title: 'Календарь' },
    { route: 'stats', icon: '📈', title: 'Статистика' },
  ],
  [
    { route: 'activity', icon: '🏃', title: 'Активность' },
    { route: 'metric/water', icon: '💧', title: 'Вода' },
    { route: 'visits', icon: '🩺', title: 'Врачи и визиты' },
  ],
  [
    { route: 'settings', icon: '⚙️', title: 'Настройки' },
    { route: 'export', icon: '💾', title: 'Резервная копия' },
    { route: 'security', icon: '🔒', title: 'Безопасность' },
    { route: 'theme', icon: '🌙', title: 'Тема оформления' },
  ],
];

async function buildDrawer() {
  const drawer = $('#drawer');
  const p = await Storage.getProfile();
  const avatar = p.photo ? `<img class="drawer-avatar" src="${esc(p.photo)}" alt="">` : `<div class="drawer-avatar drawer-avatar--ph">👤</div>`;
  drawer.innerHTML = '';
  const head = el(`
    <button class="drawer-head" type="button" data-route="profile">
      ${avatar}
      <div class="drawer-head__txt"><div class="drawer-head__name">${esc(p.name || 'Профиль')}</div><div class="drawer-head__sub">Нажмите, чтобы изменить</div></div>
    </button>
  `);
  drawer.appendChild(head);
  DRAWER_SECTIONS.forEach((items) => {
    const sec = el('<div class="drawer-sec"></div>');
    items.forEach((it) => {
      sec.appendChild(el(`
        <button class="drawer-item" type="button" data-route="${it.route}">
          <span class="drawer-item__icon">${it.icon}</span>
          <span class="drawer-item__title">${esc(it.title)}</span>
          ${it.badge ? `<span class="drawer-item__badge">${it.badge}</span>` : ''}
        </button>
      `));
    });
    drawer.appendChild(sec);
  });
  drawer.appendChild(appFooter());
  drawer.addEventListener('click', (e) => {
    const it = e.target.closest('[data-route]');
    if (it) { closeDrawer(); location.hash = `#/${it.getAttribute('data-route')}`; }
  });
}
function openDrawer() { $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }

/* =========================================================
   Роутер
   ========================================================= */
const TAB_ROUTES = ['home', 'metrics', 'meds', 'tests'];
const SCREENS = {
  home: HomeScreen, metrics: MetricsScreen, meds: MedsScreen, tests: TestsScreen,
  profile: ProfileScreen, activity: ActivityScreen, visits: VisitsScreen,
  settings: SettingsScreen, export: ExportScreen, theme: ThemeScreen,
  notifications: NotificationsScreen, goals: () => Stub('🎯', 'Цели'),
  calendar: CalendarScreen, stats: () => Stub('📈', 'Статистика'),
  security: () => Stub('🔒', 'Безопасность'),
};

function resolve() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'visit/new') return { fn: () => VisitFormScreen(null), tab: null, main: false };
  if (h.startsWith('visit/')) {
    const rest = h.slice(6);
    if (rest.endsWith('/edit')) return { fn: () => VisitFormScreen(rest.slice(0, -5)), tab: null, main: false };
    return { fn: () => VisitDetailScreen(rest), tab: null, main: false };
  }
  if (h.startsWith('metric/')) {
    const k = h.slice(7);
    if (k === 'water') return { fn: WaterScreen, tab: 'metrics', main: true };
    if (METRICS[k]) return { fn: () => MetricScreen(k), tab: 'metrics', main: true };
  }
  if (SCREENS[h]) return { fn: SCREENS[h], tab: TAB_ROUTES.includes(h) ? h : null, main: TAB_ROUTES.includes(h) };
  return { fn: HomeScreen, tab: 'home', main: true };
}

let renderToken = 0;
async function render() {
  const { fn, tab, main } = resolve();
  const token = ++renderToken;
  closeDrawer();
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.route === tab));
  $('#menu-btn').classList.toggle('hidden', !main);
  const node = await fn();
  if (token !== renderToken) return;
  const mount = $('#screen');
  mount.innerHTML = '';
  mount.appendChild(node);
  mount.scrollTop = 0;
}

function initChrome() {
  $('#tab-bar').addEventListener('click', (e) => { const tab = e.target.closest('.tab'); if (tab) location.hash = `#/${tab.dataset.route}`; });
  $('#menu-btn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err)); });
}

/* ---------- запуск ---------- */
applyTheme(getTheme());
async function boot() {
  await Storage.init();
  initChrome();
  await buildDrawer();
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); Notifier.check(); } });
  await render();
  registerSW();
  Notifier.start();
}
boot();
