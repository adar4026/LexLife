/* =========================================================
   app.js — точка входа, роутер, Drawer и экраны (MVP v1.0)
   Async-first: данные через StorageService с await.
   Навигация: нижний таб-бар (Главная/Показатели/Лекарства/Анализы)
   + боковое меню (Drawer, ☰ справа сверху).
   Показатели — единая модель: каждый показатель = модуль #/metric/<key>.
   ========================================================= */

import Storage, { REFERENCE, TEST_FIELDS, dateKey, APP_VERSION, APP_UPDATED, CURRENT_SCHEMA_VERSION, BackupError, parseBackup } from './services/storage.js';
import { createStatsEngine, evaluateWaterPlan, waterGoalDays, PERIODS, PERIOD_KEYS, DEFAULT_PERIOD, MIN_DELTA, TREND_MIN_POINTS, TREND_MIN_SPAN, isoOfDay, dayNum } from './services/analytics.js';
import { parseWaterMinderCsv, assignImportKeys, buildWaterImportPlan, applyWaterImportPlan, applyTodayWaterImport, isWaterMinderKey } from './services/waterImport.js';
import { lineChart, barChart as svgBarChart } from './ui/charts.js';
import { AttachmentService, IdbAttachmentStore, AttachmentError, ATTACHMENT_ACCEPT, ATTACHMENT_TYPES, checkAttachmentFile, formatBytes, attachmentOf } from './services/attachments.js';
import { createFullBackup, prepareFullRestore, applyFullRestore, isZipFile, countDocsLostOnRestore } from './services/fullBackup.js';
import { parsePreparedTest, importPreparedTest, PreparedImportError } from './services/preparedImport.js';
import { journal, groupSummary, testSections, sameDayNumber, indicatorHistory, evaluateField } from './services/testsJournal.js';
import { openDocViewer as showDocViewer } from './ui/docViewer.js';
import { setActiveTab } from './ui/bottomNav.js';
import { waterProgress, attentionItems, recentActivity, upcomingMed, nextDose } from './services/homeSummary.js';
import { nextFire } from './services/notifySchedule.js';
import { createNotifier, describeNotifyState, armPatch, waterRulePatch, NOTIF_ROUTES, isSafeRoute } from './services/notifier.js';
import { createPushClient, SYNC_FAIL_TEXT, SERVER_FALLBACK_MS } from './services/pushClient.js';
import { createOccurrenceStore } from './services/occurrenceStore.js';
import { NEW_HOME_URL, PRIMARY_URL, migrationMode, deploymentRole, serverPushAllowed } from './services/deployment.js';

/* Документы анализов: файлы в IndexedDB (только на этом устройстве), метаданные — в health_tests */
const Attachments = new AttachmentService(Storage, new IdbAttachmentStore());

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
/* Значение показателя лаборатории: число или качественный результат бланка («отрицательно») */
const fmtResult = (r) => (r.value == null && r.text ? r.text : fmtNum(r.value));

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
/* Цветовая отметка основных полей по справочным значениям приложения (REFERENCE) */
const evaluate = evaluateField;

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
   Отвечает на три вопроса: что сегодня (вода, показатели) · что требует внимания
   (отклонения последних анализов) · куда перейти (последняя активность).
   Данные — только из Storage; расчёты — js/services/homeSummary.js.
   ========================================================= */
const HOME_QUICK_METRICS = ['weight', 'pulse', 'pressure'];
const HOME_WATER_ADD = 250; // мл — та же запись, что и быстрый ввод модуля воды (Storage.addWaterEntry)

/* Линейные иконки одного семейства с таб-баром (24×24, обводка currentColor) */
const HOME_ICONS = {
  water: '<path d="M12 3.6c3.3 4.1 5.6 7.3 5.6 10.2a5.6 5.6 0 0 1-11.2 0c0-2.9 2.3-6.1 5.6-10.2z"/>',
  weight: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.3 10.4a5.2 5.2 0 0 1 7.4 0"/><path d="m12 11.4 1.5-2"/>',
  pulse: '<path d="M12 19.5s-7.5-4.4-7.5-10a4.2 4.2 0 0 1 7.5-2.6 4.2 4.2 0 0 1 7.5 2.6c0 5.6-7.5 10-7.5 10z"/><path d="M7.5 11.5h2.2l1.3-2.2 2 4.4 1.3-2.2h2.2"/>',
  pressure: '<path d="M4.6 16.8a8 8 0 1 1 14.8 0"/><path d="m12 13.2 3.2-3.6"/><circle cx="12" cy="13.6" r="1.1"/>',
  lab: '<path d="M9 3.5h6"/><path d="M10 3.5v6L5 18.3a1.8 1.8 0 0 0 1.6 2.7h10.8a1.8 1.8 0 0 0 1.6-2.7L14 9.5v-6"/><path d="M7.4 15h9.2"/>',
  med: '<rect x="2.8" y="8.3" width="18.4" height="7.4" rx="3.7" transform="rotate(-45 12 12)"/><path d="m9.4 9.4 5.2 5.2"/>',
  visit: '<path d="M6 3.5v5a4 4 0 0 0 8 0v-5"/><path d="M10 12.5v2a4.5 4.5 0 0 0 9 0V13"/><circle cx="19" cy="11" r="2"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>',
};
HOME_ICONS.temperature = HOME_ICONS.pulse;
HOME_ICONS.spo2 = HOME_ICONS.pulse;
HOME_ICONS.glucose = HOME_ICONS.lab;
const homeIcon = (name, cls = '') => `<svg class="hi ${cls}" viewBox="0 0 24 24" aria-hidden="true">${HOME_ICONS[name] || HOME_ICONS.lab}</svg>`;

const fmtLongDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString(RU, { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
function fmtWhen(iso, today) {
  if (iso === today) return 'сегодня';
  const y = new Date(today + 'T00:00:00');
  y.setDate(y.getDate() - 1);
  if (iso === dateKey(y)) return 'вчера';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(RU, d.getFullYear() === y.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\s*г\.$/, '');
}
function homeSection(title, route, label) {
  return el(`
    <section class="hsec">
      <div class="hsec__head">
        <h2 class="hsec__title">${esc(title)}</h2>
        ${route ? `<a class="hsec__more" href="#/${route}" aria-label="${esc(label)}">Все${homeIcon('chevron', 'hsec__chev')}</a>` : ''}
      </div>
    </section>
  `);
}

async function HomeScreen() {
  const today = dateKey();
  const [water, goal, tests, metricsLog, visits, meds, takenToday] = await Promise.all([
    Storage.getWater(today), Storage.getWaterGoal(), Storage.getTests(), Storage.getMetricsLog(), Storage.getVisits(),
    Storage.getMeds(), Storage.getMedLog(today),
  ]);
  const screen = el('<div class="home"></div>');

  /* дата — единственный заголовок; справа — общая кнопка ☰ (index.html) */
  screen.appendChild(el(`<header class="home-head"><p class="home-head__date">${esc(fmtFull(new Date()))}</p></header>`));
  if (deploymentRole() === 'legacy') screen.appendChild(legacyNotice());

  screen.appendChild(renderWaterHero(water, goal));
  screen.appendChild(renderQuickMetrics(metricsLog, today));
  const upcoming = renderUpcoming(meds, takenToday);
  if (upcoming) screen.appendChild(upcoming);
  const attention = renderAttentionSection(tests);
  if (attention) screen.appendChild(attention);
  const recent = renderRecentActivity({ tests, metricsLog, visits, today });
  if (recent) screen.appendChild(recent);
  return screen;
}

/* ---------- Вода сегодня (hero) ---------- */
function renderWaterHero(water, goal) {
  const card = el(`
    <section class="hw" aria-label="Вода сегодня">
      <a class="hw__head" href="#/metric/water" aria-label="Вода: открыть модуль воды">
        <span class="hw__icon">${homeIcon('water')}</span>
        <span class="hw__title">Вода сегодня</span>
        ${homeIcon('chevron', 'hw__chev')}
      </a>
      <p class="hw__val"><span class="hw__cur"></span><span class="hw__goal"></span></p>
      <div class="hw__bar" role="progressbar" aria-label="Выпито от цели" aria-valuemin="0" aria-valuemax="100"><span class="hw__fill"></span></div>
      <div class="hw__foot">
        <p class="hw__status" aria-live="polite"></p>
        <button class="hw__add" type="button" aria-label="Добавить ${HOME_WATER_ADD} мл воды">${homeIcon('plus')}${HOME_WATER_ADD} мл</button>
      </div>
    </section>
  `);
  const paint = (cur) => {
    const p = waterProgress(cur, goal);
    $('.hw__cur', card).textContent = fmtMl(p.current);
    $('.hw__goal', card).textContent = ` / ${fmtMl(p.goal)} мл`;
    const pct = Math.round(p.progress * 100);
    $('.hw__fill', card).style.width = `${pct}%`;
    const bar = $('.hw__bar', card);
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuetext', `${fmtMl(p.current)} из ${fmtMl(p.goal)} мл`);
    const st = $('.hw__status', card);
    st.classList.toggle('is-done', p.reached);
    st.innerHTML = p.reached
      ? `${homeIcon('check')}Цель выполнена${p.over ? ` <span class="hw__over">+${esc(fmtMl(p.over))} мл</span>` : ''}`
      : `Осталось <b>${esc(fmtMl(p.remaining))} мл</b>`;
  };
  paint(water);

  /* значение и прогресс тоже ведут в модуль воды (ссылка в заголовке — путь для VoiceOver) */
  card.addEventListener('click', (e) => {
    if (e.target.closest('.hw__add, .hw__head')) return;
    location.hash = '#/metric/water';
  });
  const add = $('.hw__add', card);
  add.addEventListener('click', async () => {
    if (add.disabled) return;
    add.disabled = true;
    try {
      paint(await Storage.addWaterEntry(HOME_WATER_ADD));
      flash(`+${HOME_WATER_ADD} мл`);
    } finally {
      add.disabled = false;
    }
  });
  return card;
}

/* ---------- Показатели: вес · пульс · давление ---------- */
function renderQuickMetrics(metricsLog, today) {
  const sec = homeSection('Показатели', 'metrics', 'Все показатели');
  const grid = el('<div class="qm-grid"></div>');
  const cells = HOME_QUICK_METRICS.map((key) => {
    const M = METRICS[key];
    const log = (metricsLog && metricsLog[key]) || {};
    const date = Object.keys(log).filter((d) => log[d] != null && d <= today).sort().pop();
    const value = date ? fmtMetric(key, log[date]) : null;
    /* давление «120/80» читается без единицы — в карточке её нет, в aria-label есть */
    const unit = key === 'pressure' ? '' : M.unit;
    return { key, M, date, value, unit };
  });
  /* один размер цифр для всего ряда: по самой длинной записи (CSS: --qm-chars) */
  const chars = Math.max(3, ...cells.filter((c) => c.value).map((c) => c.value.length + c.unit.length * 0.5));
  grid.style.setProperty('--qm-chars', String(chars));
  cells.forEach(({ key, M, date, value, unit }) => {
    const label = value
      ? `${M.name}: ${value} ${M.unit}, ${fmtWhen(date, today)}. Открыть`
      : `${M.name}: нет записей. Добавить`;
    grid.appendChild(el(`
      <a class="qm${value ? '' : ' qm--empty'}" href="#/metric/${key}" aria-label="${esc(label)}">
        ${homeIcon(key, 'qm__icon')}
        <span class="qm__name">${esc(M.name)}</span>
        ${value
          ? `<span class="qm__val">${esc(value)}${unit ? `<span class="qm__unit">${esc(unit)}</span>` : ''}</span><span class="qm__when">${esc(fmtWhen(date, today))}</span>`
          : `<span class="qm__val qm__val--none" aria-hidden="true">—</span><span class="qm__add">${homeIcon('plus')}Добавить</span>`}
      </a>
    `));
  });
  sec.appendChild(grid);
  return sec;
}

/* ---------- Ближайшее: одно предстоящее лекарство (расписание и отметки — экран «Лекарства») ---------- */
function renderUpcoming(meds, takenToday) {
  const now = new Date();
  const u = upcomingMed(meds, { now, takenToday });
  if (!u) return null;
  const today = dateKey(now);
  const tomorrow = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const day = u.date === today ? 'Сегодня' : u.date === tomorrow ? 'Завтра' : fmtWhen(u.date, today);
  const when = [day, u.time].filter(Boolean).join(', ');
  const sub = [when, u.dose].filter(Boolean).join(' · ');
  const sec = homeSection('Ближайшее');
  const row = el(`
    <a class="hrow hrow--compact" href="#/meds">
      <span class="hrow__icon">${homeIcon('med')}</span>
      <span class="hrow__body"><span class="hrow__title"></span><span class="hrow__sub hrow__sub--one"></span></span>
      ${homeIcon('chevron', 'hrow__chev')}
    </a>
  `);
  $('.hrow__title', row).textContent = u.name;
  $('.hrow__sub', row).textContent = sub;
  row.setAttribute('aria-label', `Ближайшее: ${u.name}, ${sub}; открыть лекарства`);
  const list = el('<div class="hlist"></div>');
  list.appendChild(row);
  sec.appendChild(list);
  return sec;
}

/* ---------- Требует внимания: только то, что приложение уже отмечает как вне диапазона ---------- */
function renderAttentionSection(tests) {
  const { items } = attentionItems(tests, { limit: 3 });
  if (!items.length) return null;
  const sec = homeSection('Требует внимания', 'tests', 'Все анализы');
  const list = el('<div class="hlist"></div>');
  items.forEach((it) => {
    const value = `${fmtNum(it.value)}${it.unit ? ` ${it.unit}` : ''}`;
    const row = el(`
      <a class="hrow" href="#/test-history/${encodeURIComponent(it.key)}">
        <span class="hrow__icon hrow__icon--${it.level}">${homeIcon('lab')}</span>
        <span class="hrow__body"><span class="hrow__title"></span><span class="hrow__sub">${esc(value)}</span></span>
        <span class="hrow__status hrow__status--${it.level}">${esc(it.label)}</span>
        ${homeIcon('chevron', 'hrow__chev')}
      </a>
    `);
    $('.hrow__title', row).textContent = it.name;
    row.setAttribute('aria-label', `${it.name}: ${value}, ${it.label.toLowerCase()}, анализ от ${fmtLongDate(it.date)}. История показателя`);
    list.appendChild(row);
  });
  sec.appendChild(list);
  sec.appendChild(el('<p class="hsec__note">По справочным значениям приложения и диапазонам бланка лаборатории — это не медицинская оценка.</p>'));
  return sec;
}

/* ---------- Последняя активность: анализ → измерение → визит ---------- */
function renderRecentActivity(data) {
  const a = recentActivity(data);
  if (!a) return null;
  let icon, title, sub, href;
  if (a.kind === 'test') {
    /* группы бланка («Гематология · Биохимия») — заголовок; без них просто «Анализы» */
    icon = 'lab'; title = a.summary || 'Анализы'; href = `#/test/${encodeURIComponent(a.testId)}`;
    sub = fmtLongDate(a.date);
  } else if (a.kind === 'metric') {
    const M = METRICS[a.key];
    icon = a.key; title = M.name; href = `#/metric/${a.key}`;
    sub = `${fmtMetric(a.key, a.value)} ${M.unit} · ${fmtLongDate(a.date)}`;
  } else {
    icon = 'visit'; title = a.title; href = `#/visit/${encodeURIComponent(a.visitId)}`;
    sub = fmtLongDate(a.date);
  }
  const sec = homeSection('Последняя активность');
  const row = el(`
    <a class="hrow" href="${href}">
      <span class="hrow__icon">${homeIcon(icon)}</span>
      <span class="hrow__body"><span class="hrow__title"></span><span class="hrow__sub hrow__sub--one"></span></span>
      ${homeIcon('chevron', 'hrow__chev')}
    </a>
  `);
  $('.hrow__title', row).textContent = title;
  $('.hrow__sub', row).textContent = sub;
  row.setAttribute('aria-label', `${title}: ${sub}. Открыть`);
  const list = el('<div class="hlist"></div>');
  list.appendChild(row);
  sec.appendChild(list);
  return sec;
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
/* запрос разрешения на уведомления — только из обработчика нажатия (iOS требует жест пользователя) */
async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}
/* после включения напоминания — честно сказать, если доставки не будет */
function flashNotifyResult(granted, onText) {
  if (granted) flash(onText);
  else if (!('Notification' in window)) flash('Сохранено, но уведомления здесь недоступны');
  else flash('Сохранено, но уведомления не разрешены');
}

async function WaterScreen() {
  const screen = el('<div></div>');
  let period = 'year'; // 'week' | 'month' | 'year' — по умолчанию «Год», как у графика
  let editingGoal = false;

  async function paint() {
    const [log, goal, record, loggedStreak, goalStreak, hyd] = await Promise.all([
      Storage.getWaterLog(), Storage.getWaterGoal(), Storage.getWaterRecord(), Storage.getWaterLoggedStreak(), Storage.getWaterStreak(), Storage.getHydration(),
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
    screen.appendChild(planSection(goal, hyd, dayObj.entries || []));
    screen.appendChild(deviationSection(goal, hyd, total));

    /* 6. История за день */
    screen.appendChild(journal(dayObj.entries || [], today));

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
      <div class="stat-row" style="margin-top:14px; margin-bottom:6px">
        <div class="stat"><div class="stat__num">${record ? L(record.total) : '0'}</div><div class="stat__label">рекорд дня, л</div></div>
        <div class="stat"><div class="stat__num">${loggedStreak} 🔥</div><div class="stat__label">дни с водой подряд</div></div>
        <div class="stat"><div class="stat__num">${goalStreak}</div><div class="stat__label">текущая серия цели, дней</div></div>
      </div>
    `));
    screen.appendChild(el('<p class="plan-hint" style="margin:0 0 14px">Текущая серия — дни подряд по сегодня с итогом не меньше цели. Пока сегодня цель не выполнена, серия считается по вчера.</p>'));
    screen.appendChild(goalPeriodStats(log, goal));
    screen.appendChild(averagesBlock(log));

    /* 9. Настройки напоминаний (тумблер = правило «Вода» центра уведомлений) */
    const waterRule = (await Storage.getNotifications()).find((n) => n.type === 'water') || null;
    screen.appendChild(reminderSettings(hyd, waterRule));
  }

  /* План гидратации (фиксированные слоты) — только ориентир. Статус порции считается по
     фактическим записям и их времени (evaluateWaterPlan): запись не переносится назад к
     первой незакрытой порции, время записи не меняется. */
  const PLAN_ROW = {
    done: { icon: '✓', cls: 'plan-row--done', text: (p, now) => (now < p.time ? 'выполнено заранее' : 'выполнено') },
    current: { icon: '•', cls: 'plan-row--now', text: (p) => `сейчас${p.got ? ` · засчитано ${fmtMl(p.got)} из ${fmtMl(p.ml)} мл` : ''}` },
    missed: { icon: '✕', cls: 'plan-row--missed', text: (p) => `пропущено${p.got ? ` · засчитано ${fmtMl(p.got)} из ${fmtMl(p.ml)} мл` : ''}` },
    upcoming: { icon: '○', cls: '', text: () => '' },
  };
  function planSection(goal, hyd, entries) {
    const slots = buildPlan(goal, hyd);
    const now = nowMinutes();
    const plan = evaluateWaterPlan(slots, entries, now, hhmmToMin(hyd.wakeEnd));
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">План на день</h2><span class="plan-note">ориентир</span></div><div class="list-card" id="planbox"></div></section>');
    const box = $('#planbox', sec);
    plan.forEach((p) => {
      const v = PLAN_ROW[p.status];
      const extra = v.text(p, now);
      box.appendChild(el(`
        <div class="row plan-row ${v.cls}">
          <span class="plan-row__icon">${v.icon}</span>
          <span class="plan-row__time">${minToHHMM(p.time)}</span>
          <div class="row__body"><p class="row__sub" style="margin:0">${fmtMl(p.ml)} мл${extra ? ` · ${esc(extra)}` : ''}</p></div>
        </div>
      `));
    });
    sec.appendChild(el('<p class="plan-hint">Записи сохраняются с фактическим временем. Выпитое засчитывается порции своего времени и следующим, но не пропущенным раньше.</p>'));
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

  /* Настройки напоминаний (подъём/сон/интервал/тумблер). Тумблер управляет правилом
     «Вода» центра уведомлений (единственный механизм доставки); hydration_cfg.notify
     сохраняется для совместимости бэкапов. */
  function reminderSettings(hyd, waterRule) {
    const on = !!(waterRule && waterRule.enabled);
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
          <div class="rs-row"><div><div class="field__label" style="margin:0">Напоминания</div><div style="font-size:11px; color:var(--text2)">${on ? esc(repeatSummary(waterRule)) + ' · ' : ''}${pushClient.state().enabled ? 'фоновые (сервер)' : 'только пока LexLife открыт'} · <a href="#/notifications" style="color:var(--blue)">статус</a></div></div>
            <button class="rs-toggle ${on ? 'is-on' : ''}" id="rs-notify" type="button" role="switch" aria-checked="${on}" ${waterRule ? '' : 'disabled'}><span class="rs-toggle__knob"></span></button>
          </div>
        </div>
      </section>
    `);
    const save = async (patch) => {
      const next = await Storage.setHydration(patch);
      /* включённые интервальные напоминания следуют за окном и интервалом плана */
      if (waterRule && waterRule.enabled && waterRule.repeat === 'interval') { await Storage.updateNotification(waterRule.id, armPatch(waterRulePatch(next))); rulesChanged(); }
      await paint();
    };
    $('#rs-wake', sec).addEventListener('change', (e) => save({ wakeStart: e.target.value }));
    $('#rs-sleep', sec).addEventListener('change', (e) => save({ wakeEnd: e.target.value }));
    $('#rs-int', sec).addEventListener('change', (e) => save({ slotMinutes: Number(e.target.value) }));
    $('#rs-notify', sec).addEventListener('click', async () => {
      if (!waterRule) return;
      const next = !on;
      const granted = next ? await ensureNotifyPermission() : false;
      await Storage.updateNotification(waterRule.id, next ? armPatch({ enabled: true, ...waterRulePatch(hyd) }) : { enabled: false });
      await Storage.setHydration({ notify: next });
      notifier.check();
      rulesChanged();
      await paint();
      if (next) flashNotifyResult(granted, 'Напоминания включены'); else flash('Напоминания выключены');
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

  /* Календарные дни выбранного периода — те же, что на графике: неделя — 7 дней,
     месяц — 30 дней, год — с 1-го числа месяца 11 месяцев назад; всё по сегодня. */
  function periodDayKeys(p) {
    const today = new Date();
    const start = p === 'week' || p === 'month'
      ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - (p === 'week' ? 6 : 29))
      : new Date(today.getFullYear(), today.getMonth() - 11, 1);
    const keys = [];
    for (const d = start; dateKey(d) <= dateKey(today); d.setDate(d.getDate() + 1)) keys.push(dateKey(d));
    return keys;
  }
  /* Выполнение цели за выбранный период: всего дней с целью (не обязательно подряд) и лучшая серия.
     Пересчитывается из журнала при каждой отрисовке — после добавления, правки, переноса и удаления. */
  function goalPeriodStats(log, goal) {
    const keys = periodDayKeys(period);
    const g = waterGoalDays(log, goal, keys);
    const name = period === 'week' ? 'неделя' : period === 'month' ? 'месяц' : 'год';
    const range = `${fmtDate(keys[0])} – ${fmtDate(keys[keys.length - 1])}`;
    const box = el(`
      <div>
        <div style="font-size:12px; color:var(--text2); margin-bottom:8px">за период: ${name} · ${esc(range)}</div>
        <div class="stat-row">
          <div class="stat stat--link" role="button" tabindex="0" aria-label="Цель выполнена, дней: ${g.count}. Показать даты"><div class="stat__num">${g.count}</div><div class="stat__label">цель выполнена, дней ›</div></div>
          <div class="stat"><div class="stat__num">${g.bestStreak}</div><div class="stat__label">лучшая серия цели, дней</div></div>
        </div>
      </div>
    `);
    const card = $('.stat--link', box);
    const open = () => {
      const list = g.days.slice().reverse().map((x) => `<li><span>${esc(fmtDate(x.date))}</span><span>${fmtMl(x.total)} мл</span></li>`).join('');
      showDialog({
        title: `Цель выполнена: ${g.count} ${plural(g.count, 'день', 'дня', 'дней')}`,
        body: `<p class="dialog__muted">Период: ${name}, ${esc(range)} (${keys.length} ${plural(keys.length, 'день', 'дня', 'дней')}). Засчитан день с итогом от ${fmtMl(goal)} мл — по текущей цели.</p>${
          g.count ? `<ul class="dialog__list">${list}</ul>` : '<p>За этот период нет дней с выполненной целью.</p>'}`,
        actions: [{ label: 'Закрыть', value: true }],
      });
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return box;
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
  function journal(entries, day) {
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">Сегодня · приёмы</h2><button class="section__action" type="button" data-route="water-log">Все записи ›</button></div><div class="list-card" id="jbox"></div></section>');
    $('.section__action', sec).addEventListener('click', onRouteClick);
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
        if (confirm(`Удалить запись ${e.t} · ${e.ml} мл?`)) { await Storage.removeWaterEntry(i, day, { t: e.t, ml: e.ml, key: e.key ?? null }); await paint(); flash('Удалено'); }
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
   Вкладка 4 — Анализы: журнал (#/tests) → полный анализ (#/test/<id>) →
   история показателя (#/test-history/<ключ>); форма — #/test/new, #/test/<id>/edit.
   ========================================================= */
const DOC_ICON = { pdf: '📄', image: '🖼️' };
const docKind = (type) => (ATTACHMENT_TYPES[type] || {}).kind || 'pdf';
const docLabel = (type) => (ATTACHMENT_TYPES[type] || {}).label || 'Файл';
const docLine = (meta) => [docLabel(meta.type), formatBytes(meta.size)].filter(Boolean).join(' · ');
const alertDialog = (title, html) => showDialog({ title, body: html, actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
const DOC_MISSING_HTML = '<p>Файл этого анализа не найден на устройстве.</p><p class="dialog__muted">Так бывает после восстановления из обычной резервной копии (она не содержит PDF и фото) или на другом устройстве. Анализ сохранён; прикрепите документ заново через «Изменить» или восстановите полную резервную копию с документами.</p>';
/* «14 февр. 2026 г.» */
const fmtTestDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString(RU, { day: '2-digit', month: 'short', year: 'numeric' });
const indicatorsWord = (n) => `${n} ${plural(n, 'показатель', 'показателя', 'показателей')}`;

/* Открыть документ анализа из хранилища; нет файла → понятное сообщение */
async function openTestDocument(meta) {
  let file = null;
  try {
    file = await Attachments.getFile(meta);
  } catch (err) {
    await alertDialog('Документ недоступен', `<p>${esc(err instanceof AttachmentError ? err.message : 'Не удалось прочитать документ.')}</p>`);
    return null;
  }
  if (!file) { await alertDialog('Документ не найден', DOC_MISSING_HTML); return null; }
  return openDocViewer(file);
}

/* «Документ анализа» поверх приложения (js/ui/docViewer.js): PDF целиком, фото с масштабом */
function openDocViewer(file) {
  return showDocViewer(file, { lockScroll: lockPageScroll, unlockScroll: unlockPageScroll });
}

/* Состояние журнала между переходами: фильтр года, подсветка только что добавленной записи */
let testsYear = 'all';
let testsHighlight = null;

async function TestsScreen() {
  const screen = el('<div class="tj"></div>');
  let importing = false;

  async function paint() {
    const tests = await Storage.getTests();
    const j = journal(tests, { year: testsYear });
    testsYear = j.year;
    screen.innerHTML = '';
    screen.appendChild(el(`<header class="header"><p class="header__eyebrow">${j.total} ${plural(j.total, 'запись', 'записи', 'записей')}</p><h1 class="header__title">Анализы</h1></header>`));

    const addBtn = el('<button class="btn-ghost tj-add" type="button">+ Добавить анализ</button>');
    addBtn.addEventListener('click', () => { location.hash = '#/test/new'; });
    screen.appendChild(addBtn);
    const impLabel = el(`<label class="btn-ghost tests-import${importing ? ' is-busy' : ''}">📥 Импортировать подготовленный анализ<input type="file" accept=".json,application/json" hidden></label>`);
    const impInput = $('input', impLabel);
    impInput.addEventListener('change', () => {
      const file = impInput.files && impInput.files[0];
      impInput.value = '';
      if (file) importPrepared(file, impLabel);
    });
    screen.appendChild(impLabel);

    if (!j.total) {
      screen.appendChild(el('<div class="empty tj-empty">Пока нет анализов.<br>Добавьте анализ вручную или импортируйте подготовленный файл.</div>'));
      return;
    }

    if (j.years.length > 1) {
      const f = el(`<div class="st-period tj-filter" role="group" aria-label="Период">
        ${['all', ...j.years].map((y) => `<button class="st-period__btn${j.year === y ? ' is-active' : ''}" type="button" data-year="${y}" aria-pressed="${j.year === y}">${y === 'all' ? 'Все' : y}</button>`).join('')}
      </div>`);
      f.addEventListener('click', (e) => {
        const b = e.target.closest('[data-year]');
        if (!b) return;
        testsYear = b.dataset.year === 'all' ? 'all' : Number(b.dataset.year);
        paint();
      });
      screen.appendChild(f);
    }

    const list = el('<div class="tj-list"></div>');
    j.groups.forEach((g) => {
      const sec = el(`<section class="tj-year"><h2 class="tj-year__title">${g.year}</h2><div class="list-card tj-card"></div></section>`);
      const box = $('.tj-card', sec);
      g.items.forEach((it) => box.appendChild(journalRow(it)));
      list.appendChild(sec);
    });
    screen.appendChild(list);

    if (testsHighlight) {
      const id = testsHighlight;
      testsHighlight = null;
      const row = $(`.tj-row[data-id="${CSS.escape(id)}"]`, screen);
      if (row) {
        row.classList.add('is-new');
        setTimeout(() => { if (row.isConnected) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 80);
      }
    }
  }

  /* Одна запись — одна строка: дата, группы, документ, ›.
     Строка → полный анализ; блок документа → сам документ. */
  function journalRow({ test: t, no, sameDay }) {
    const meta = attachmentOf(t);
    const summary = groupSummary(t) || t.note || 'Показатели не внесены';
    const row = el(`
      <div class="tj-row" data-id="${esc(t.id)}">
        <a class="tj-row__main" href="#/test/${encodeURIComponent(t.id)}">
          <span class="tj-row__date">${esc(fmtTestDate(t.date))}</span>
          ${sameDay > 1 ? `<span class="tj-row__no">Анализ № ${no}</span>` : ''}
          <span class="tj-row__groups">${esc(summary)}</span>
        </a>
        ${meta
          ? `<button class="tj-doc" type="button"><span class="tj-doc__badge tj-doc__badge--${docKind(meta.type)}">${esc(docLabel(meta.type))}</span><span class="tj-doc__text"><span class="tj-doc__name"></span><span class="tj-doc__meta">${esc(formatBytes(meta.size))}</span></span></button>`
          : '<span class="tj-doc tj-doc--none">Без документа</span>'}
        <span class="tj-row__chev" aria-hidden="true">›</span>
      </div>
    `);
    const label = `Анализ от ${fmtTestDate(t.date)}${sameDay > 1 ? `, № ${no}` : ''}`;
    $('.tj-row__main', row).setAttribute('aria-label', `${label}. ${summary}`);
    if (meta) {
      const doc = $('.tj-doc', row);
      $('.tj-doc__name', doc).textContent = meta.name || 'Документ';
      doc.setAttribute('aria-label', `Открыть документ ${meta.name || ''} (${docLine(meta)})`);
    }
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tj-doc:not(.tj-doc--none)')) { openTestDocument(meta); return; }
      e.preventDefault();
      location.hash = `#/test/${encodeURIComponent(t.id)}`;
    });
    return row;
  }

  /* Импорт подготовленного JSON: проверка → предпросмотр → добавление (без замены) */
  async function importPrepared(file, label) {
    if (importing) return;
    importing = true;
    label.classList.add('is-busy');
    try {
      let parsed;
      try {
        if (file.size > 1024 * 1024) throw new PreparedImportError('Файл слишком большой для одной записи анализа.');
        parsed = parsePreparedTest(await file.text());
      } catch (err) {
        await alertDialog('Импорт невозможен', `<p>${esc(err instanceof PreparedImportError ? err.message : 'Не удалось прочитать файл.')}</p><p class="dialog__muted">Данные не изменены.</p>`);
        return;
      }
      const tests = await Storage.getTests();
      const dup = tests.find((x) => x.importId === parsed.importId);
      if (dup) {
        await alertDialog('Уже импортировано', `<p>Этот анализ уже есть в LexLife (${esc(fmtDate(dup.date))}). Повторно он не добавляется.</p>`);
        return;
      }
      const { summary, entry } = parsed;
      const sameDate = tests.some((x) => x.date === summary.date);
      const mainRows = summary.main.map((f) => `<li><span>${esc(REFERENCE[f].label)}</span><span>${esc(fmtNum(entry[f]))} ${esc(REFERENCE[f].unit)}</span></li>`).join('');
      const groupRows = summary.groups.map((g) => `<li><span>${esc(g.name)}</span><span>${g.items.length}</span></li>`).join('');
      const allRows = summary.groups.map((g) => `<p class="dialog__muted" style="margin:10px 0 4px">${esc(g.name)}</p><ul class="dialog__list">${g.items.map((r) => `<li><span>${esc(r.name)}</span><span>${esc(fmtResult(r))} ${esc(r.unit || '')}</span></li>`).join('')}</ul>`).join('');
      const go = await showDialog({
        title: 'Подготовленный анализ',
        body: `
          <ul class="dialog__list">
            <li><span>Дата анализа</span><span>${esc(fmtDate(summary.date))}</span></li>
            ${entry.note ? `<li><span>Заметка</span><span>${esc(entry.note)}</span></li>` : ''}
            <li><span>Основные показатели</span><span>${summary.main.length}</span></li>
            <li><span>Показатели лаборатории</span><span>${summary.customCount}</span></li>
          </ul>
          ${mainRows ? `<ul class="dialog__list">${mainRows}</ul>` : ''}
          ${groupRows ? `<ul class="dialog__list">${groupRows}</ul>` : ''}
          ${allRows ? `<details class="dialog__details"><summary>Все показатели</summary>${allRows}</details>` : ''}
          ${sameDate ? '<p class="dialog__warn">На эту дату уже есть анализ — будет добавлена ещё одна, отдельная запись.</p>' : ''}
          <p class="dialog__muted">Запись будет добавлена к существующим анализам. Другие данные (вода, лекарства, показатели, настройки) не изменятся.</p>
        `,
        actions: [{ label: 'Отмена', value: false }, { label: 'Добавить анализ', value: true, kind: 'primary' }],
      });
      if (!go) return;
      let res;
      try {
        res = await importPreparedTest(Storage, parsed);
      } catch (err) {
        await alertDialog('Не удалось импортировать', `<p>${esc((err && err.message) || 'Попробуйте ещё раз.')}</p>`);
        return;
      }
      if (!res.added) { await alertDialog('Уже импортировано', '<p>Этот анализ уже есть в LexLife. Повторно он не добавлен.</p>'); return; }
      importing = false;
      testsYear = 'all';
      testsHighlight = res.entry.id;
      await paint();
      flash('Анализ добавлен ✓');
    } finally {
      importing = false;
      label.classList.remove('is-busy');
    }
  }

  await paint();
  screen.restoreScroll = true;
  return screen;
}

/* ---------- Полный анализ (#/test/<id>) ---------- */
async function TestDetailScreen(id) {
  const screen = el('<div class="tv"></div>');
  const tests = await Storage.getTests();
  const t = tests.find((x) => x.id === id);
  const back = () => goBackOr('tests');
  if (!t) {
    screen.appendChild(backHeader('Анализ', { label: 'Назад', onBack: back }));
    screen.appendChild(el('<div class="empty">Анализ не найден — возможно, он был удалён.</div>'));
    const b = el('<button class="btn-ghost" type="button">К списку анализов</button>');
    b.addEventListener('click', () => { location.replace('#/tests'); });
    screen.appendChild(b);
    return screen;
  }
  const { no, sameDay } = sameDayNumber(tests, id);
  const sections = testSections(t);
  const count = sections.reduce((n, s) => n + s.rows.length, 0);

  screen.appendChild(backHeader(`Анализ от ${fmtTestDate(t.date)}`, { label: 'Назад', onBack: back }));
  const sub = [sameDay > 1 ? `Анализ № ${no} из ${sameDay} за этот день` : '', count ? indicatorsWord(count) : ''].filter(Boolean).join(' · ');
  if (sub) screen.appendChild(el(`<p class="tv-sub">${esc(sub)}</p>`));
  if (t.note) screen.appendChild(el(`<p class="tv-note">${esc(t.note)}</p>`));

  /* документ */
  const meta = attachmentOf(t);
  if (meta) {
    const doc = el(`
      <button class="tv-doc" type="button">
        <span class="tv-doc__badge tj-doc__badge tj-doc__badge--${docKind(meta.type)}">${esc(docLabel(meta.type))}</span>
        <span class="tv-doc__body"><span class="tv-doc__name"></span><span class="tv-doc__meta">${esc(docLine(meta))} · ${docKind(meta.type) === 'pdf' ? 'все страницы' : 'с масштабом'}</span></span>
        <span class="tv-doc__open">Открыть</span>
      </button>
    `);
    $('.tv-doc__name', doc).textContent = meta.name || 'Документ';
    doc.setAttribute('aria-label', `Открыть документ ${meta.name || ''} (${docLine(meta)})`);
    doc.addEventListener('click', () => openTestDocument(meta));
    screen.appendChild(doc);
  } else {
    screen.appendChild(el('<div class="tv-doc tv-doc--none"><span class="tv-doc__badge tj-doc__badge tj-doc__badge--none">—</span><span class="tv-doc__body"><span class="tv-doc__name">Без документа</span><span class="tv-doc__meta">PDF или фото можно прикрепить через «Изменить»</span></span></div>'));
  }

  /* показатели по разделам */
  if (!sections.length) screen.appendChild(el('<div class="empty">Показатели не внесены</div>'));
  sections.forEach((s) => {
    const sec = el(`<section class="section tv-sec"><div class="section__head"><h2 class="section__title">${esc(s.title)}</h2><span class="tv-sec__count">${s.rows.length}</span></div><div class="list-card"></div></section>`);
    const box = $('.list-card', sec);
    s.rows.forEach((r) => {
      const hint = r.out === '↑' ? 'выше диапазона лаборатории' : r.out === '↓' ? 'ниже диапазона лаборатории' : '';
      /* labName — название на бланке, если на экране показано единое название (показатели мочи) */
      const refText = [r.labName ? `на бланке: ${r.labName}` : '', r.ref ? (r.kind === 'field' ? `лаборатория: ${r.ref}` : r.ref) : ''].filter(Boolean).join(' · ');
      const row = el(`
        <a class="row tv-row" href="#/test-history/${encodeURIComponent(r.key)}">
          <span class="dot-status dot-status--${r.status}" aria-hidden="true"></span>
          <span class="row__body"><span class="tv-row__name"></span>${refText ? '<span class="tv-row__ref"></span>' : ''}</span>
          <span class="tv-row__val">${r.out ? `<span class="test-value__out" title="${hint}" aria-label="${hint}">${r.out}</span> ` : ''}<b>${esc(fmtResult(r))}</b>${r.unit ? ` <span class="tv-row__unit">${esc(r.unit)}</span>` : ''}</span>
          <span class="row__chevron" aria-hidden="true">›</span>
        </a>
      `);
      $('.tv-row__name', row).textContent = r.name;
      if (refText) $('.tv-row__ref', row).textContent = refText;
      row.setAttribute('aria-label', `${r.name}: ${fmtResult(r)} ${r.unit}${hint ? `, ${hint}` : ''}. История показателя`);
      box.appendChild(row);
    });
    screen.appendChild(sec);
  });
  if (count) screen.appendChild(el('<p class="st-disclaimer" style="margin-top:14px">Точка — справочные значения приложения для основных показателей; ↑/↓ — вне диапазона, указанного лабораторией. Это не медицинская оценка. Нажмите на показатель, чтобы открыть его историю и график.</p>'));

  /* действия — только здесь */
  const actions = el('<div class="tv-actions"><button class="btn-ghost" type="button" data-act="edit">Изменить</button><button class="btn-ghost tv-actions__delete" type="button" data-act="delete">Удалить анализ</button></div>');
  actions.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'edit') { location.hash = `#/test/${encodeURIComponent(t.id)}/edit`; return; }
    const ok = await showDialog({
      title: 'Удалить анализ?',
      body: `<p>Анализ от <b>${esc(fmtTestDate(t.date))}</b>${sameDay > 1 ? ` (№ ${no})` : ''} будет удалён${meta ? ' вместе с прикреплённым документом' : ''}. Другие анализы не изменятся.</p><p class="dialog__muted">Это действие нельзя отменить, если у вас нет резервной копии.</p>`,
      actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try {
      await Attachments.deleteTest(t.id);
    } catch (err) {
      await alertDialog('Не удалось удалить', `<p>${esc((err && err.message) || 'Попробуйте ещё раз.')}</p>`);
      return;
    }
    goBackOr('tests');
    flash('Анализ удалён');
  });
  screen.appendChild(actions);
  screen.restoreScroll = true;
  return screen;
}

/* ---------- История одного показателя (#/test-history/<ключ>) ---------- */
async function TestHistoryScreen(key) {
  const screen = el('<div></div>');
  const h = indicatorHistory(await Storage.getTests(), key);
  screen.appendChild(backHeader(h.title, { label: 'Назад', onBack: () => goBackOr('tests') }));
  if (!h.entries.length) { screen.appendChild(el('<div class="empty">Нет записей этого показателя</div>')); return screen; }
  screen.appendChild(el(`<p class="tv-sub">${h.entries.length} ${plural(h.entries.length, 'значение', 'значения', 'значений')}${h.unit ? ` · ${esc(h.unit)}` : ''}</p>`));

  if (h.points.length >= 2) {
    const points = h.points.map((p) => ({ day: dayNum(p.date), value: p.value, date: p.date }));
    const card = el('<div class="card st-card" style="margin-top:12px"></div>');
    card.appendChild(lineChart({
      range: { start: points[0].day, end: Math.max(points[points.length - 1].day, dayNum(dateKey())) },
      series: [{ key, label: h.title, color: 'var(--viz-1)', points }],
      minSpan: 0.1,
      ariaLabel: `${h.title}: ${points.length} значений`,
      readout: (day) => { const p = points.find((q) => q.day === day); return `<span class="chart__rv">${esc(fmtNum(p.value))} <small>${esc(h.unit)}</small></span><span class="chart__rd">${esc(fmtDate(p.date))}</span>`; },
    }));
    screen.appendChild(card);
  } else if (h.entries.every((e) => e.value == null)) {
    screen.appendChild(el('<p class="backup-note" style="margin:12px 2px 4px">Результат лаборатории — текстом, без числа, поэтому графика нет.</p>'));
  } else if (h.entries.some((e) => e.value == null)) {
    screen.appendChild(el('<p class="backup-note" style="margin:12px 2px 4px">Текстовые результаты лаборатории в график не входят; он появится, когда будет хотя бы два числовых значения.</p>'));
  } else {
    screen.appendChild(el('<p class="backup-note" style="margin:12px 2px 4px">График появится, когда будет хотя бы два анализа с этим показателем.</p>'));
  }

  const list = el('<section class="section"><div class="list-card"></div></section>');
  h.entries.forEach((e) => {
    const hint = e.out === '↑' ? 'выше диапазона лаборатории' : e.out === '↓' ? 'ниже диапазона лаборатории' : '';
    const row = el(`
      <a class="row tv-row" href="#/test/${encodeURIComponent(e.testId)}">
        <span class="dot-status dot-status--${e.status}" aria-hidden="true"></span>
        <span class="row__body"><span class="tv-row__name">${esc(fmtTestDate(e.date))}${e.sameDay > 1 ? ` · № ${e.no}` : ''}</span>${e.ref || e.labName ? '<span class="tv-row__ref"></span>' : ''}</span>
        <span class="tv-row__val">${e.out ? `<span class="test-value__out" title="${hint}">${e.out}</span> ` : ''}<b>${esc(fmtResult(e))}</b>${e.unit ? ` <span class="tv-row__unit">${esc(e.unit)}</span>` : ''}</span>
        <span class="row__chevron" aria-hidden="true">›</span>
      </a>
    `);
    if (e.ref || e.labName) {
      $('.tv-row__ref', row).textContent = [e.labName ? `на бланке: ${e.labName}` : '', e.ref ? (TEST_FIELDS.includes(key) ? `лаборатория: ${e.ref}` : e.ref) : ''].filter(Boolean).join(' · ');
    }
    list.firstChild.appendChild(row);
  });
  screen.appendChild(list);
  screen.appendChild(el('<p class="st-disclaimer">Диапазоны — справочные значения лаборатории из бланка; это не медицинская оценка.</p>'));
  return screen;
}

/* ---------- Форма нового анализа / редактирования (#/test/new, #/test/<id>/edit) ----------
   Документ: выбор, «Открыть», «Удалить» — изменения применяются по «Сохранить» (отмена ничего не меняет).
   Показатели лаборатории (customResults) и прочие поля записи сохраняются без изменений. */
async function TestFormScreen(id) {
  const screen = el('<div></div>');
  const existing = id ? await Storage.getTest(id) : null;
  const done = () => goBackOr(existing ? `test/${encodeURIComponent(existing.id)}` : 'tests');
  screen.appendChild(backHeader(existing ? 'Изменить анализ' : 'Новый анализ', { label: 'Отмена', onBack: done }));
  if (id && !existing) {
    screen.appendChild(el('<div class="empty">Анализ не найден — возможно, он был удалён.</div>'));
    return screen;
  }
  const t = existing || { date: dateKey(), note: '' };
  const form = el('<div class="input-card test-form"></div>');
  form.appendChild(el(`<div class="field"><label class="field__label" for="f-date">Дата анализа</label><input class="input" type="date" id="f-date" value="${esc(t.date)}"></div>`));
  TEST_FIELDS.forEach((f) => {
    const ref = REFERENCE[f];
    form.appendChild(el(`<div class="field"><label class="field__label">${esc(ref.label)} (${esc(ref.unit)})</label><input class="input" type="number" step="any" inputmode="decimal" data-field="${f}" value="${t[f] != null ? esc(t[f]) : ''}" placeholder="—"></div>`));
  });
  form.appendChild(el(`<div class="field"><label class="field__label" for="f-note">Заметка</label><input class="input" type="text" id="f-note" value="${esc(t.note || '')}" placeholder="напр. сдано не натощак"></div>`));
  const extraCount = Array.isArray(t.customResults) ? t.customResults.length : 0;
  if (extraCount) form.appendChild(el(`<p class="doc-block__hint" style="margin:0 0 12px">Показатели лаборатории (${extraCount}) сохраняются без изменений.</p>`));

  /* ---- блок «Документ анализа» ---- */
  const origMeta = attachmentOf(t);
  let doc = origMeta ? { kind: 'existing', meta: origMeta } : { kind: 'none' };
  const block = el(`
    <div class="doc-block">
      <div class="doc-block__title">Документ анализа</div>
      <div class="doc-block__body"></div>
      <label class="btn-ghost doc-block__pick"><span></span><input type="file" accept="${ATTACHMENT_ACCEPT}" hidden></label>
      <p class="doc-block__hint">PDF, JPG, PNG или HEIC · до 15 МБ · файл хранится только на этом устройстве</p>
    </div>
  `);
  const bodyEl = $('.doc-block__body', block);
  const pickText = $('.doc-block__pick span', block);
  const pickInput = $('.doc-block__pick input', block);
  function paintDoc() {
    bodyEl.innerHTML = '';
    if (doc.kind === 'none') {
      bodyEl.appendChild(el(`<p class="doc-block__empty">${origMeta ? 'Документ будет удалён при сохранении.' : 'Файл не прикреплён.'}</p>`));
      pickText.textContent = 'Прикрепить PDF или фото';
      return;
    }
    const meta = doc.kind === 'new' ? { name: doc.file.name, type: doc.type, size: doc.file.size } : doc.meta;
    const row = el(`
      <div class="doc-row">
        <span class="doc-row__icon" aria-hidden="true">${DOC_ICON[docKind(meta.type)]}</span>
        <div class="doc-row__body"><p class="doc-row__name"></p><p class="doc-row__meta">${esc(docLine(meta))}${doc.kind === 'new' ? ' · сохранится вместе с анализом' : ''}</p></div>
      </div>
    `);
    $('.doc-row__name', row).textContent = meta.name || 'Документ';
    const acts = el('<div class="doc-row__actions"><button class="doc-btn" type="button" data-act="open">Открыть</button><button class="doc-btn doc-btn--danger" type="button" data-act="del">Удалить</button></div>');
    acts.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'open') {
        if (doc.kind === 'new') openDocViewer(new File([doc.file], doc.file.name, { type: doc.type }));
        else openTestDocument(doc.meta);
      } else {
        doc = { kind: 'none' };
        paintDoc();
      }
    });
    bodyEl.append(row, acts);
    pickText.textContent = 'Заменить файл';
  }
  pickInput.addEventListener('change', async () => {
    const file = pickInput.files && pickInput.files[0];
    pickInput.value = '';
    if (!file) return;
    const check = await checkAttachmentFile(file);
    if (!check.ok) { await alertDialog('Файл не прикреплён', `<p>${esc(check.message)}</p>`); return; }
    doc = { kind: 'new', file, type: check.type };
    paintDoc();
  });
  paintDoc();
  form.appendChild(block);

  const actions = el('<div class="test-form__actions"></div>');
  const save = el(`<button class="btn-primary" type="button">${existing ? 'Сохранить' : 'Сохранить анализ'}</button>`);
  const cancel = el('<button class="btn-ghost" type="button">Отмена</button>');
  cancel.addEventListener('click', done);
  actions.append(save, cancel);
  form.appendChild(actions);

  save.addEventListener('click', async () => {
    const date = $('#f-date', form).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { await alertDialog('Анализ не сохранён', '<p>Укажите дату анализа.</p>'); return; }
    const values = {};
    $$('[data-field]', form).forEach((inp) => { values[inp.dataset.field] = inp.value !== '' ? Number(inp.value) : undefined; });
    save.classList.add('is-busy');
    let testId = existing ? existing.id : null;
    try {
      if (existing) {
        const upd = await Storage.updateTest(existing.id, { date, note: $('#f-note', form).value.trim(), ...values });
        if (!upd) { await alertDialog('Анализ не найден', '<p>Запись была удалена. Ничего не изменено.</p>'); location.replace('#/tests'); return; }
      } else {
        const entry = { date, note: $('#f-note', form).value.trim() };
        Object.entries(values).forEach(([k, v]) => { if (v !== undefined) entry[k] = v; });
        testId = (await Storage.addTest(entry)).id;
      }
    } catch (err) {
      save.classList.remove('is-busy');
      await alertDialog('Анализ не сохранён', `<p>${esc((err && err.message) || 'Попробуйте ещё раз.')}</p>`);
      return;
    }
    let docError = null;
    try {
      if (doc.kind === 'new') await Attachments.attachToTest(testId, doc.file);
      else if (doc.kind === 'none' && origMeta) await Attachments.removeFromTest(testId);
    } catch (err) {
      docError = err instanceof AttachmentError ? err.message : 'Не удалось сохранить документ на устройстве.';
    }
    if (!existing) { testsYear = 'all'; testsHighlight = testId; }
    done();
    if (docError) await alertDialog('Анализ сохранён, документ — нет', `<p>${esc(docError)}</p><p class="dialog__muted">Попробуйте прикрепить файл ещё раз через «Изменить».</p>`);
    else flash(existing ? 'Сохранено ✓' : 'Анализ сохранён ✓');
  });
  screen.appendChild(form);
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
async function saveBackupFile(content, fileName) {
  const file = content instanceof Blob
    ? new File([content], fileName, { type: content.type || 'application/zip' })
    : new File([content], fileName, { type: 'application/json' });
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
      <p class="backup-note"><b>PDF и фото анализов</b> входят только в «Полную резервную копию с документами» — один ZIP-файл с теми же данными и всеми документами. Восстанавливаются оба вида копий одной кнопкой «Восстановить из копии».</p>
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

  /* Полная копия: данные + PDF/фото анализов одним ZIP-файлом */
  const fullBtn = el('<button class="btn-ghost" type="button">Полная резервная копия с документами</button>');
  fullBtn.addEventListener('click', async () => {
    fullBtn.classList.add('is-busy');
    try {
      let b;
      try {
        b = await createFullBackup(Storage, Attachments.store);
      } catch (err) {
        await alertDialog('Не удалось создать копию', `<p>${esc(err instanceof AttachmentError ? err.message : 'Попробуйте ещё раз.')}</p>`);
        return;
      }
      const notes = [];
      if (!b.verified) notes.push('Самопроверка обнаружила нестандартные данные — восстановить копию может не получиться.');
      if (b.missing) notes.push(`${b.missing} ${plural(b.missing, 'документ не найден', 'документа не найдены', 'документов не найдены')} на этом устройстве и не войдут в копию.`);
      if (notes.length) {
        const go = await showDialog({
          title: 'Проверка копии',
          body: `${notes.map((n) => `<p>${esc(n)}</p>`).join('')}<p>Всё равно сохранить файл?</p>`,
          actions: [{ label: 'Отмена', value: false }, { label: 'Сохранить', value: true, kind: 'primary' }],
        });
        if (!go) return;
      }
      /* сборка архива занимает время — iOS требует нового касания для Share Sheet */
      let res = await saveBackupFile(b.blob, b.fileName);
      if (res === 'need-tap') {
        res = await new Promise((resolve) => {
          showDialog({
            title: 'Полная копия готова',
            body: `<p>${esc(b.fileName)}</p><p class="dialog__muted">${b.attachments} ${plural(b.attachments, 'документ', 'документа', 'документов')} · ${esc(formatBytes(b.bytes))}. Нажмите «Сохранить», затем «Сохранить в Файлы».</p>`,
            actions: [
              { label: 'Отмена', value: 'cancelled' },
              { label: 'Сохранить', kind: 'primary', value: null, onClick: () => { saveBackupFile(b.blob, b.fileName).then(resolve); } },
            ],
          }).then((v) => { if (v) resolve(v); });
        });
      }
      if (res === 'shared' || res === 'downloaded') {
        await Storage.markBackupCreated(b.createdAt);
        await paintLast();
        flash(`Полная копия создана ✓ (${b.attachments} док.)`);
      }
    } finally {
      fullBtn.classList.remove('is-busy');
    }
  });
  actions.appendChild(fullBtn);

  const impLabel = el('<label class="btn-ghost">Восстановить из копии<input type="file" accept=".json,.zip,application/json,application/zip" hidden></label>');
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
  let full = null; // полная копия (ZIP с документами)
  let docsLost = 0;
  try {
    if (await isZipFile(file)) {
      full = await prepareFullRestore(Storage, file);
      prepared = full.prepared;
    } else {
      if (file.size > 10 * 1024 * 1024) throw new BackupError('TOO_LARGE', 'Файл слишком большой для резервной копии LexLife.');
      prepared = await Storage.prepareRestore(parseBackup(await file.text()));
    }
    docsLost = await countDocsLostOnRestore(Storage, prepared);
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
  if (full) rows.push(['Документы анализов (PDF/фото)', full.attachments.length]);
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
    ${full && full.missingInArchive ? `<p class="dialog__muted">${full.missingInArchive} ${plural(full.missingInArchive, 'документ отсутствовал', 'документа отсутствовали', 'документов отсутствовали')} при создании копии — эти анализы восстановятся без файла.</p>` : ''}
    <p class="dialog__warn">Восстановление заменит текущие данные LexLife${full ? ' и документы анализов' : ''} данными из выбранной резервной копии.</p>
    ${docsLost ? `<p class="dialog__warn">${docsLost} ${plural(docsLost, 'документ', 'документа', 'документов')} (PDF/фото) текущих анализов нет в этой копии — ${docsLost === 1 ? 'он будет удалён' : 'они будут удалены'} с устройства.</p>` : ''}
    ${!full ? '<p class="dialog__muted">Обычная копия не содержит PDF и фото. Для переноса документов используйте полную резервную копию (ZIP).</p>' : ''}
  `;
  const go = await showDialog({
    title: full ? 'Полная резервная копия LexLife' : 'Резервная копия LexLife',
    body,
    actions: [{ label: 'Отмена', value: false }, { label: 'Восстановить', value: true, kind: 'danger' }],
  });
  if (!go) { flash('Восстановление отменено'); return; }

  try {
    if (full) await applyFullRestore(Storage, Attachments, full);
    else await Storage.restoreBackup(prepared);
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

/* =========================================================
   Импорт истории воды из CSV WaterMinder (разовый перенос, #/water-import).
   Файл читается локально (никуда не отправляется). Каждая запись переносится
   отдельно, со своими датой/временем (без UTC/ISO-преобразований), включая
   внешне одинаковые повторы — они не схлопываются (см. services/waterImport.js).
   Перед записью данных создаётся резервная копия; существующие записи не
   удаляются и не перезаписываются. Сегодняшний день — отдельное действие:
   в LexLife к моменту импорта уже могут быть внесены сегодняшние записи вручную.
   ========================================================= */
async function backupBeforeImport(cancelled = 'Импорт отменён') {
  let b;
  try {
    b = await Storage.createBackup();
  } catch {
    await showDialog({
      title: 'Не удалось создать резервную копию',
      body: `<p>${esc(cancelled)}, данные не изменены.</p>`,
      actions: [{ label: 'Понятно', value: true, kind: 'primary' }],
    });
    return false;
  }
  let res = await saveBackupFile(b.json, b.fileName);
  if (res === 'need-tap') {
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
    return true;
  }
  return false; // cancelled — импорт не продолжаем
}

async function WaterImportScreen() {
  const screen = el('<div></div>');
  screen.appendChild(backHeader('Импорт истории воды', { label: 'Назад', onBack: goBack }));

  screen.appendChild(el(`
    <div class="input-card">
      <p class="backup-note">Перенос истории приёмов воды из экспорта WaterMinder (CSV). Каждая запись переносится отдельно, со своими датой и временем — без пересчёта в UTC и без привязки к пунктам плана.</p>
      <p class="backup-note">Перед переносом LexLife создаёт резервную копию текущих данных. Существующие записи не удаляются и не изменяются. Повторный импорт того же файла не создаёт дублей.</p>
    </div>
  `));

  const pickCard = el('<div class="input-card"></div>');
  const pickLabel = el('<label class="btn-ghost">Выбрать CSV-файл WaterMinder<input type="file" accept=".csv,text/csv" hidden></label>');
  const fileInput = $('input', pickLabel);
  pickCard.appendChild(pickLabel);
  const fileNameEl = el('<p class="backup-note" style="margin-top:8px"></p>');
  pickCard.appendChild(fileNameEl);
  screen.appendChild(pickCard);

  const previewHost = el('<div></div>');
  screen.appendChild(previewHost);

  const fixLink = el('<section class="section"><div class="list-card"><div class="row" role="button" data-route="water-log"><span class="row__icon">🗓️</span><div class="row__body"><p class="row__title">Журнал воды</p><p class="row__sub">Все записи по датам: добавить, изменить, перенести или удалить</p></div><span class="row__chevron">›</span></div></div></section>');
  fixLink.addEventListener('click', onRouteClick);
  screen.appendChild(fixLink);

  let state = null; // { parsed, planInfo }

  async function computePlan(rows) {
    const withKeys = assignImportKeys(rows);
    const existingLog = await Storage.getWaterLog();
    const today = dateKey();
    return { withKeys, plan: buildWaterImportPlan(withKeys, existingLog, today), today };
  }

  function renderPreview(parsed, planInfo) {
    previewHost.innerHTML = '';
    const { rows, errors, totalLines } = parsed;
    const { plan, today } = planInfo;
    const importDays = Object.keys(plan.additionsByDay).sort();

    const rangeLine = plan.minDate && plan.maxDate ? `${esc(fmtDate(plan.minDate))} – ${esc(fmtDate(plan.maxDate))}` : '—';
    const card = el('<div class="input-card"></div>');
    card.appendChild(el(`
      <ul class="dialog__list">
        <li><span>Строк в файле</span><span>${totalLines}</span></li>
        <li><span>Распознано</span><span>${rows.length}</span></li>
        ${errors.length ? `<li><span>Не удалось разобрать</span><span>${errors.length}</span></li>` : ''}
        <li><span>Период в файле</span><span>${rangeLine}</span></li>
        <li><span>Будет добавлено</span><span>${plan.addedCount}</span></li>
        <li><span>Уже импортировано ранее (дубли)</span><span>${plan.duplicateCount}</span></li>
        ${plan.removedByUserCount ? `<li><span>Удалены вами после импорта — не возвращаются</span><span>${plan.removedByUserCount}</span></li>` : ''}
        ${plan.csvTodayCount ? `<li><span>Сегодня, ${esc(fmtDate(today))}</span><span>${plan.csvTodayCount} в файле · ${plan.existingTodayManualCount} ручных уже в LexLife</span></li>` : ''}
      </ul>
    `));
    previewHost.appendChild(card);

    const actions = el('<div class="backup-actions"></div>');
    const mainBtn = el('<button class="btn-primary" type="button"></button>');
    if (importDays.length) {
      mainBtn.textContent = `Импортировать ${fmtDate(importDays[0])} – ${fmtDate(importDays[importDays.length - 1])} (${plan.addedCount})`;
    } else {
      mainBtn.textContent = 'Нечего импортировать';
      mainBtn.disabled = true;
    }
    mainBtn.addEventListener('click', async () => {
      const go = await showDialog({
        title: 'Импорт истории воды',
        body: `
          <p>Будет добавлено <b>${plan.addedCount}</b> ${plural(plan.addedCount, 'запись', 'записи', 'записей')} за ${importDays.length} ${plural(importDays.length, 'день', 'дня', 'дней')} (${esc(fmtDate(importDays[0]))} – ${esc(fmtDate(importDays[importDays.length - 1]))}).</p>
          ${plan.duplicateCount ? `<p class="dialog__muted">${plan.duplicateCount} ${plural(plan.duplicateCount, 'запись', 'записи', 'записей')} уже были импортированы ранее и будут пропущены.</p>` : ''}
          <p class="dialog__muted">Сегодняшняя дата (${esc(fmtDate(today))}) в этот импорт не входит — для неё отдельная кнопка ниже.</p>
          <p class="dialog__muted">Перед импортом будет создана резервная копия текущих данных.</p>
        `,
        actions: [{ label: 'Отмена', value: false }, { label: 'Создать копию и импортировать', value: true, kind: 'primary' }],
      });
      if (!go) return;
      mainBtn.classList.add('is-busy');
      try {
        if (!(await backupBeforeImport())) return;
        const res = await applyWaterImportPlan(Storage, plan);
        await showDialog({
          title: 'Импорт завершён',
          body: `
            <ul class="dialog__list">
              <li><span>Добавлено</span><span>${res.importedCount}</span></li>
              <li><span>Пропущено как дубли</span><span>${plan.duplicateCount}</span></li>
              <li><span>Дней</span><span>${res.days.length} (${esc(fmtDate(res.days[0]))} – ${esc(fmtDate(res.days[res.days.length - 1]))})</span></li>
            </ul>
          `,
          actions: [{ label: 'Готово', value: true, kind: 'primary' }],
        });
        flash('Импорт завершён ✓');
        await refresh();
      } catch (err) {
        await showDialog({ title: 'Не удалось импортировать', body: `<p>${esc((err && err.message) || 'Попробуйте ещё раз.')}</p>`, actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
      } finally {
        mainBtn.classList.remove('is-busy');
      }
    });
    actions.appendChild(mainBtn);

    if (plan.csvTodayCount) {
      const todayBtn = el('<button class="btn-ghost" type="button"></button>');
      todayBtn.textContent = plan.todayAdditions.length
        ? `Импортировать записи WaterMinder за сегодня (${plan.todayAdditions.length})`
        : 'Записи за сегодня уже импортированы';
      todayBtn.disabled = !plan.todayAdditions.length;
      todayBtn.addEventListener('click', async () => {
        const go = await showDialog({
          title: 'Записи WaterMinder за сегодня',
          body: `
            <p class="dialog__warn">Сегодня, ${esc(fmtDate(today))}, в LexLife уже есть <b>${plan.existingTodayManualCount}</b> ${plural(plan.existingTodayManualCount, 'ручная запись', 'ручные записи', 'ручных записей')} воды.</p>
            <p>В файле WaterMinder за сегодня — <b>${plan.csvTodayCount}</b> ${plural(plan.csvTodayCount, 'запись', 'записи', 'записей')}, новых из них — <b>${plan.todayAdditions.length}</b>.</p>
            <p class="dialog__muted">Импортируйте, только если эти объёмы ещё не внесены в LexLife вручную — иначе сегодняшняя вода задвоится.</p>
          `,
          actions: [{ label: 'Отмена', value: false }, { label: 'Всё равно импортировать', value: true, kind: 'danger' }],
        });
        if (!go) return;
        todayBtn.classList.add('is-busy');
        try {
          if (!(await backupBeforeImport())) return;
          const res = await applyTodayWaterImport(Storage, plan);
          await showDialog({ title: 'Импорт за сегодня завершён', body: `<p>Добавлено: <b>${res.importedCount}</b></p>`, actions: [{ label: 'Готово', value: true, kind: 'primary' }] });
          flash('Импорт завершён ✓');
          await refresh();
        } catch (err) {
          await showDialog({ title: 'Не удалось импортировать', body: `<p>${esc((err && err.message) || 'Попробуйте ещё раз.')}</p>`, actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
        } finally {
          todayBtn.classList.remove('is-busy');
        }
      });
      actions.appendChild(todayBtn);
    }
    previewHost.appendChild(actions);

    if (errors.length) {
      previewHost.appendChild(el(`<p class="empty" style="padding-top:10px">Пропущено ${errors.length} ${plural(errors.length, 'строка', 'строки', 'строк')} с нераспознанной датой/временем/объёмом — они не импортируются.</p>`));
    }
  }

  async function refresh() {
    if (!state) return;
    const planInfo = await computePlan(state.parsed.rows);
    state = { parsed: state.parsed, planInfo };
    renderPreview(state.parsed, planInfo);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileNameEl.textContent = file.name;
    pickLabel.classList.add('is-busy');
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = parseWaterMinderCsv(text);
      } catch (err) {
        await showDialog({ title: 'Не удалось прочитать файл', body: `<p>${esc(err.message)}</p>`, actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
        return;
      }
      if (!parsed.rows.length) {
        await showDialog({ title: 'Нет данных для импорта', body: '<p>В файле не найдено ни одной распознанной записи.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
        return;
      }
      const planInfo = await computePlan(parsed.rows);
      state = { parsed, planInfo };
      renderPreview(parsed, planInfo);
    } finally {
      pickLabel.classList.remove('is-busy');
    }
  });

  return screen;
}

/* =========================================================
   Журнал воды (#/water-log[/ГГГГ-ММ | /ГГГГ-ММ-ДД]): все записи за все даты по месяцам,
   сгруппированы по дням с итогом дня. Добавить запись (дата/время/объём), изменить
   (в т.ч. перенести на другую дату), удалить. Правки адресуют запись по дню + индексу +
   содержимому (+ ключу импорта), поэтому соседняя или внешне такая же запись не затрагивается.
   Для дней с записями WaterMinder — массовое удаление «позже ЧЧ:ММ» с резервной копией.
   ========================================================= */
const WL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WL_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function WaterLogScreen(param) {
  const screen = el('<div></div>');
  const today = dateKey();
  const curMonth = today.slice(0, 7);
  let focusDay = WL_DATE_RE.test(param || '') ? param : null;
  let month = focusDay ? focusDay.slice(0, 7) : (/^\d{4}-\d{2}$/.test(param || '') ? param : curMonth);
  if (month > curMonth) month = curMonth;

  const shiftMonth = (m, delta) => {
    const [y, mo] = m.split('-').map(Number);
    const d = new Date(y, mo - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const monthTitle = (m) => { const [y, mo] = m.split('-').map(Number); return cap(new Date(y, mo - 1, 1).toLocaleDateString(RU, { month: 'long', year: 'numeric' })); };
  const dayTitle = (d) => cap(new Date(`${d}T00:00:00`).toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'long' }));
  const hasWater = (o) => !!o && (((o.entries || []).length > 0) || (o.total || 0) > 0);
  const srcLabel = (e) => {
    const drink = e.drink && e.drink !== 'Вода' ? ` · ${esc(e.drink)}${e.hydrationMl ? ` (${fmtMl(e.hydrationMl)} мл напитка)` : ''}` : '';
    return `${isWaterMinderKey(e.key) ? 'WaterMinder' : 'вручную'}${drink}`;
  };
  const go = (m, d = null) => {
    month = m;
    focusDay = d;
    history.replaceState(null, '', `#/water-log/${d || m}`);
    paint();
  };

  async function paint() {
    const log = await Storage.getWaterLog();
    const days = Object.keys(log).filter((d) => d.startsWith(`${month}-`) && hasWater(log[d])).sort().reverse();
    const monthEntries = days.reduce((s, d) => s + (log[d].entries || []).length, 0);
    const monthTotal = days.reduce((s, d) => s + (log[d].total || 0), 0);
    screen.innerHTML = '';
    screen.appendChild(backHeader('Журнал воды', { label: 'Назад', onBack: goBack }));

    const ctrl = el(`
      <div class="input-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px">
          <button class="btn-ghost" type="button" data-nav="-1" style="width:auto; margin:0; padding:8px 14px" aria-label="Предыдущий месяц">‹</button>
          <b style="font-size:17px">${esc(monthTitle(month))}</b>
          <button class="btn-ghost" type="button" data-nav="1" style="width:auto; margin:0; padding:8px 14px" aria-label="Следующий месяц" ${month >= curMonth ? 'disabled' : ''}>›</button>
        </div>
        <div style="display:flex; gap:8px; margin-top:10px">
          <label style="flex:1; min-width:0"><span class="field__label">Месяц</span><input class="input" type="month" id="wl-month" style="width:100%; min-width:0; box-sizing:border-box" value="${esc(month)}" max="${esc(curMonth)}"></label>
          <label style="flex:1; min-width:0"><span class="field__label">Перейти к дате</span><input class="input" type="date" id="wl-goto" style="width:100%; min-width:0; box-sizing:border-box" max="${esc(today)}" value="${esc(focusDay || '')}"></label>
        </div>
        <p class="backup-note" style="margin-top:10px">За месяц: ${monthEntries} ${plural(monthEntries, 'запись', 'записи', 'записей')} · ${days.length} ${plural(days.length, 'день', 'дня', 'дней')} с водой · ${fmtMl(monthTotal)} мл</p>
        <button class="btn-primary" type="button" id="wl-add" style="margin-top:6px">+ Добавить запись</button>
      </div>
    `);
    ctrl.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
      const m = shiftMonth(month, Number(b.dataset.nav));
      if (m <= curMonth) go(m);
    }));
    $('#wl-month', ctrl).addEventListener('change', (ev) => { const v = ev.target.value; if (/^\d{4}-\d{2}$/.test(v) && v <= curMonth) go(v); });
    $('#wl-goto', ctrl).addEventListener('change', (ev) => { const v = ev.target.value; if (WL_DATE_RE.test(v) && v <= today) go(v.slice(0, 7), v); });
    $('#wl-add', ctrl).addEventListener('click', addEntry);
    screen.appendChild(ctrl);

    if (focusDay && !days.includes(focusDay)) {
      screen.appendChild(el(`<p class="empty">${esc(fmtDate(focusDay))}: записей нет.</p>`));
    }
    if (!days.length) screen.appendChild(el('<p class="empty">В этом месяце записей воды нет.</p>'));

    days.forEach((d) => {
      const o = log[d];
      const entries = (o.entries || []).map((e, i) => ({ e, i }));
      const importedCount = entries.filter(({ e }) => isWaterMinderKey(e.key)).length;
      const sec = el(`
        <section class="section" id="wl-${d}">
          <div class="section__head">
            <h2 class="section__title" style="font-size:16px">${esc(dayTitle(d))}</h2>
            <span style="display:flex; align-items:center; gap:6px"><b>${fmtMl(o.total || 0)} мл</b>${importedCount ? '<button class="section__action" type="button" data-bulk aria-label="Исправить ошибочную серию">⋯</button>' : ''}</span>
          </div>
          <div class="list-card"></div>
        </section>
      `);
      if (d === focusDay) sec.style.outline = '2px solid var(--blue)';
      const box = $('.list-card', sec);
      if (!entries.length) box.appendChild(el('<div class="empty">Итог без разбивки по приёмам</div>'));
      entries.forEach(({ e, i }) => {
        const row = el(`
          <div class="row">
            <div class="row__body"><p class="row__title">${esc(e.t)} · +${fmtMl(e.ml)} мл</p><p class="row__sub">${srcLabel(e)}</p></div>
            <button class="wdel" type="button" data-act="edit" aria-label="Редактировать запись ${esc(e.t)}">✎</button>
            <button class="wdel" type="button" data-act="del" aria-label="Удалить запись ${esc(e.t)}">✕</button>
          </div>
        `);
        $('[data-act="edit"]', row).addEventListener('click', () => editEntry(d, e, i));
        $('[data-act="del"]', row).addEventListener('click', () => deleteEntry(d, e, i, o.total || 0));
        box.appendChild(row);
      });
      const bulk = $('[data-bulk]', sec);
      if (bulk) bulk.addEventListener('click', () => bulkRemoveImported(d, o));
      screen.appendChild(sec);
    });

    if (focusDay) setTimeout(() => { const n = document.getElementById(`wl-${focusDay}`); if (n) n.scrollIntoView({ block: 'start' }); }, 60);
  }

  /* Форма записи: дату, фактическое время и объём задаёт пользователь */
  async function entryForm(title, submit, v) {
    let vals = null;
    const ok = await showDialog({
      title,
      body: `
        <label class="field__label" for="wl-d">Дата</label>
        <input class="input" type="date" id="wl-d" value="${esc(v.date)}" max="${esc(today)}">
        <label class="field__label" for="wl-t" style="margin-top:10px">Время</label>
        <input class="input" type="time" id="wl-t" value="${esc(v.t)}">
        <label class="field__label" for="wl-ml" style="margin-top:10px">Объём, мл</label>
        <input class="input" type="number" id="wl-ml" min="1" max="5000" step="1" inputmode="numeric" value="${esc(v.ml)}">
      `,
      actions: [
        { label: 'Отмена', value: false },
        { label: submit, value: true, kind: 'primary', onClick: () => { vals = { date: $('#wl-d').value, t: $('#wl-t').value, ml: Number($('#wl-ml').value) }; } },
      ],
    });
    if (!ok || !vals) return null;
    if (!WL_DATE_RE.test(vals.date) || vals.date > today || !WL_TIME_RE.test(vals.t) || !(vals.ml > 0 && vals.ml <= 5000)) {
      await showDialog({ title: 'Запись не сохранена', body: '<p>Укажите дату не позже сегодняшней, время ЧЧ:ММ и объём от 1 до 5000 мл.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
      return null;
    }
    vals.ml = Math.round(vals.ml);
    return vals;
  }

  async function addEntry() {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const vals = await entryForm('Новая запись', 'Добавить', { date: focusDay || today, t, ml: 250 });
    if (!vals) return;
    await Storage.addWaterEntry(vals.ml, vals.date, vals.t);
    flash(`+${fmtMl(vals.ml)} мл · ${fmtDate(vals.date)}`);
    go(vals.date.slice(0, 7), vals.date);
  }

  async function editEntry(d, e, i) {
    const vals = await entryForm('Редактировать запись', 'Сохранить', { date: d, t: e.t, ml: e.ml });
    if (!vals) return;
    const ok = await Storage.updateWaterEntry(d, i, { t: e.t, ml: e.ml, key: e.key ?? null }, vals);
    if (!ok) {
      await showDialog({ title: 'Запись не найдена', body: '<p>Данные изменились, пока была открыта форма. Ничего не изменено.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
    } else {
      flash(vals.date !== d ? `Перенесено на ${fmtDate(vals.date)}` : 'Сохранено ✓');
    }
    go(vals.date.slice(0, 7), vals.date);
  }

  async function deleteEntry(d, e, i, dayTotal) {
    const ok = await showDialog({
      title: 'Удалить запись?',
      body: `<p>${esc(fmtDate(d))}, <b>${esc(e.t)} · ${fmtMl(e.ml)} мл</b> (${srcLabel(e)}).</p><p class="dialog__muted">Будет удалена только эта запись. Итог дня станет ${fmtMl(Math.max(0, dayTotal - e.ml))} мл.</p>`,
      actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    const done = await Storage.removeWaterEntry(i, d, { t: e.t, ml: e.ml, key: e.key ?? null });
    if (!done) {
      await showDialog({ title: 'Запись не найдена', body: '<p>Данные изменились. Ничего не удалено.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
    } else {
      flash('Удалено');
    }
    go(month, d);
  }

  /* Массовое исправление: удалить импортированные записи дня позже ЧЧ:ММ (ручные не трогаем) */
  async function bulkRemoveImported(d, o) {
    const imported = (o.entries || []).filter((e) => isWaterMinderKey(e.key));
    let after = null;
    const ok = await showDialog({
      title: 'Ошибочная серия из WaterMinder',
      body: `
        <p>${esc(fmtDate(d))}: удалить импортированные записи позже указанного времени. Ручные записи не затрагиваются.</p>
        <label class="field__label" for="wl-after">Оставить записи до и включая</label>
        <input class="input" type="time" id="wl-after" value="${esc(imported[imported.length - 1].t)}">
      `,
      actions: [{ label: 'Отмена', value: false }, { label: 'Далее', value: true, kind: 'primary', onClick: () => { after = $('#wl-after').value; } }],
    });
    if (!ok || !WL_TIME_RE.test(after || '')) return;
    const victims = imported.filter((e) => e.t > after);
    if (!victims.length) { flash(`Импортированных записей позже ${after} нет`); return; }
    const sum = victims.reduce((s, e) => s + e.ml, 0);
    const confirm2 = await showDialog({
      title: 'Удалить ошибочные записи?',
      body: `
        <p>Будет удалено <b>${victims.length}</b> ${plural(victims.length, 'запись', 'записи', 'записей')} WaterMinder позже ${esc(after)} на ${fmtMl(sum)} мл.</p>
        <p>Итог ${esc(fmtDate(d))}: ${fmtMl(o.total || 0)} → <b>${fmtMl((o.total || 0) - sum)} мл</b>.</p>
        <p class="dialog__muted">Другие дни и ручные записи не затрагиваются. Повторный импорт CSV не вернёт удалённые записи. Перед удалением будет создана резервная копия.</p>
      `,
      actions: [{ label: 'Отмена', value: false }, { label: 'Создать копию и удалить', value: true, kind: 'danger' }],
    });
    if (!confirm2) return;
    if (!(await backupBeforeImport('Удаление отменено'))) return;
    const removed = await Storage.removeWaterEntriesWhere(d, (e) => isWaterMinderKey(e.key) && e.t > after);
    const total = (await Storage.getWaterDay(d)).total || 0;
    await showDialog({
      title: 'Исправлено',
      body: `<ul class="dialog__list"><li><span>Удалено записей</span><span>${removed.length}</span></li><li><span>Итог ${esc(fmtDate(d))}</span><span>${fmtMl(total)} мл</span></li></ul>`,
      actions: [{ label: 'Готово', value: true, kind: 'primary' }],
    });
    go(month, d);
  }

  await paint();
  return screen;
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
    { route: 'water-import', icon: '📥', title: 'Импорт истории воды' },
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
        ${aboutBuildRows(await readBuildInfo())}
      </div>
    </section>
  `));
  screen.appendChild(appFooter());
  return screen;
}

/* Сборка: build-info.json (Cloudflare — commit и время сборки; в репозитории/GitHub Pages — без них) */
async function readBuildInfo() {
  try { const r = await fetch('build-info.json'); return r.ok ? await r.json() : null; } catch { return null; }
}
const ROLE_LABEL = { primary: 'основной', legacy: 'резервный (GitHub Pages)', dev: 'локальная разработка', other: 'другой адрес' };
function aboutBuildRows(info) {
  const row = (t, v) => `<div class="row"><div class="row__body"><p class="row__title">${t}</p></div><span class="row__trailing">${esc(v)}</span></div>`;
  const sha = info && typeof info.sha === 'string' && /^[0-9a-f]{7,40}$/.test(info.sha) ? info.sha.slice(0, 7) : null;
  const at = info && info.builtAt && !Number.isNaN(Date.parse(info.builtAt))
    ? new Date(info.builtAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return row('Сборка', sha ? `build ${sha}${info.dirty ? '+' : ''}${at ? ` · ${at}` : ''}` : 'без номера сборки') + row('Адрес', ROLE_LABEL[deploymentRole()]);
}

/* Резервная копия на GitHub Pages: предупреждение без редиректа (данные этой копии остаются здесь) */
function legacyNotice() {
  const host = new URL(PRIMARY_URL).host;
  return el(`
    <section class="notif-status notif-status--warn" role="note" style="margin-top:12px">
      <div class="notif-status__head"><span class="notif-status__dot"></span><span class="notif-status__title">Резервная версия LexLife</span></div>
      <p class="notif-status__detail">Основная версия: <b>${esc(host)}</b>. Данные этой копии с ней не синхронизируются, фоновые уведомления здесь отключены.</p>
      <div class="notif-status__actions"><a class="doc-btn" href="${esc(PRIMARY_URL)}" target="_blank" rel="noopener">Открыть основную версию</a></div>
    </section>`);
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

/* Доставка напоминаний.
   - Фоновая (основная, если включена): Web Push с сервера LexLife (Cloudflare Worker +
     cron) — приходит и при закрытом приложении. js/services/pushClient.js
   - Локальная (запасная): проверка расписания кодом страницы — только пока LexLife
     открыт (js/services/notifier.js). Если push активен, ждёт его SERVER_FALLBACK_MS.
   Одно срабатывание показывается один раз: общий с SW журнал occurrenceId + tag. */
const notifyPermission = () => ('Notification' in window ? Notification.permission : 'unsupported');
async function showSystemNotification(title, opts) {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (reg && reg.active) return reg.showNotification(title, opts);
  if (!('Notification' in window)) throw new Error('Notification API недоступен');
  new Notification(title, opts); // без Service Worker (не iOS)
  return undefined;
}
function showRuleNotification(r, fireAt, occ) {
  const t = NOTIF_TYPES[r.type] || {};
  return showSystemNotification(`${t.emoji || '🔔'} ${t.name || 'Напоминание'}`, {
    body: r.text || '', tag: occ || r.id, icon: 'icons/lexlife-icon-192.png', data: { route: NOTIF_ROUTES[r.type] || '#/notifications', occurrenceId: occ || '' },
  });
}

const localKv = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* нет места — синхронизация повторится */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
/* SW мог ещё не зарегистрироваться (первый запуск) — не ждём бесконечно */
async function readyRegistration(ms = 5000) {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), ms))]);
}
const pushClient = createPushClient({
  kv: localKv,
  fetchImpl: (...a) => fetch(...a),
  apiBase: new URL('api/', document.baseURI), // Cloudflare: /api/ · GitHub Pages: /LexLife/api/ (нет → «нет на этом адресе»)
  getRules: () => Storage.getNotifications(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  pushManager: async () => { const reg = await readyRegistration(); return reg && 'pushManager' in reg ? reg.pushManager : null; },
  permission: notifyPermission,
  serverAllowed: serverPushAllowed(), // GitHub Pages (резерв): без /api, подписок и правил на сервере
});
const occurrences = 'caches' in window ? createOccurrenceStore({ base: document.baseURI }) : null;

const notifier = createNotifier({
  storage: Storage, show: showRuleNotification, permission: notifyPermission, occurrences,
  deferMs: async () => ((await pushClient.isServerPrimary()) ? SERVER_FALLBACK_MS : 0),
  onError: (err) => console.warn('[notify] не показано:', err && (err.message || err.name)),
});
let notifyTimer = null;
function startNotifier() {
  if (!('Notification' in window)) return;
  clearInterval(notifyTimer);
  notifyTimer = setInterval(() => notifier.check(), 30000);
  notifier.check();
}

/* Правила изменились (экран уведомлений, вода, restore): отправить расписание на сервер.
   Ошибка — честное сообщение; изменение не теряется и уйдёт при следующей синхронизации. */
async function rulesChanged({ quiet = false } = {}) {
  const r = await pushClient.sync();
  if (!r.ok && !quiet) flash(SYNC_FAIL_TEXT);
  return r;
}

/* Реальное состояние: поддержка, разрешение, режим PWA, Service Worker, push-подписка, сервер */
async function readNotifyEnv({ server = true } = {}) {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let reg = null;
  try { reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; } catch { reg = null; }
  let subscribed = false;
  try { subscribed = !!(reg && reg.pushManager && await reg.pushManager.getSubscription()); } catch { subscribed = false; }
  const st = pushClient.state();
  const background = { backend: 'error', enabled: !!st.enabled, subscription: st.subscription || 'none', syncError: !!st.lastError, pending: await pushClient.pendingSync(), lastSyncAt: st.syncedAt || null, lastPushAt: null };
  if (!pushClient.serverAllowed) {
    background.backend = 'legacy';
    background.primaryHost = new URL(PRIMARY_URL).host;
  } else if (server) {
    const cfg = await pushClient.config();
    background.backend = cfg.available ? 'ok' : cfg.offline ? 'offline' : 'absent';
    if (cfg.available && st.enabled) {
      const r = await pushClient.status();
      if (r.ok) {
        background.lastPushAt = r.data.lastPushAt;
        if (r.data.subscription !== 'active') background.subscription = 'lost';
      } else if (r.status !== 0) background.backend = 'error';
    }
  }
  if (st.enabled && !subscribed) background.subscription = 'lost';
  return {
    supported: 'Notification' in window, permission: notifyPermission(), ios, standalone,
    swActive: !!(reg && reg.active), pushSupported: !!(reg && 'pushManager' in reg), subscribed, background,
  };
}

async function NotificationsScreen() {
  const screen = el('<div></div>');
  let editing = null;

  async function paint() {
    const list = await Storage.getNotifications();
    screen.innerHTML = '';
    screen.appendChild(backHeader('Уведомления', { label: 'Назад', onBack: goBack }));

    screen.appendChild(await statusPanel());

    const wrap = el('<div class="notif-list"></div>');
    NOTIF_ORDER.forEach((type) => { const r = list.find((n) => n.type === type); if (r) wrap.appendChild(card(r)); });
    screen.appendChild(wrap);
  }

  /* Честный статус системы: локальная и фоновая доставка + проверки */
  async function statusPanel() {
    const env = await readNotifyEnv();
    const { status, items, limit, active } = describeNotifyState(env);
    const bg = env.background;
    const canLocal = env.supported && env.permission === 'granted';
    const canEnable = canLocal && env.swActive && env.pushSupported && bg.backend === 'ok';
    const p = el(`
      <section class="notif-status notif-status--${status.level}">
        <div class="notif-status__head"><span class="notif-status__dot"></span><span class="notif-status__title">${esc(status.title)}</span></div>
        <p class="notif-status__detail">${esc(status.detail)}</p>
        ${status.ask ? '<button class="notif-perm__btn notif-status__ask" type="button">Разрешить</button>' : ''}
        <dl class="notif-status__facts">${items.map((i) => `<dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd>`).join('')}</dl>
        <p class="notif-status__limit">${esc(limit)}</p>
        <div class="notif-status__actions">
          ${canLocal ? '<button class="doc-btn" type="button" data-act="local">Проверить локальное уведомление</button>' : ''}
          ${bg.enabled && bg.backend === 'ok' ? `<button class="doc-btn" type="button" data-act="push" ${active || bg.subscription === 'active' ? '' : 'disabled'}>Проверить фоновый push</button>` : ''}
          ${canEnable && (!bg.enabled || bg.subscription !== 'active') ? '<button class="doc-btn" type="button" data-act="enable">Включить фоновые уведомления</button>' : ''}
          ${bg.enabled && bg.syncError ? '<button class="doc-btn" type="button" data-act="sync">Синхронизировать снова</button>' : ''}
          ${bg.enabled ? '<button class="doc-btn" type="button" data-act="disable">Отключить фоновые уведомления</button>' : ''}
        </div>
        <p class="notif-status__result" aria-live="polite"></p>
      </section>
    `);
    const ask = $('.notif-status__ask', p);
    if (ask) ask.addEventListener('click', async () => { await ensureNotifyPermission(); startNotifier(); await paint(); });
    const result = $('.notif-status__result', p);
    const say = (t) => { if (result.isConnected) result.textContent = t; };
    const hhmm = () => new Date().toTimeString().slice(0, 5);
    const ENABLE_ERR = {
      permission: 'Нет разрешения на уведомления.', offline: 'Нет сети — попробуйте позже.',
      backend_unavailable: 'Сервер уведомлений недоступен по этому адресу.', legacy: 'Это резервная версия: фоновые уведомления — только в основной.', push_unsupported: 'Push не поддерживается: откройте LexLife с экрана «Домой».',
      register_failed: 'Сервер не зарегистрировал устройство.', subscribe_failed: 'iPhone не выдал push-подписку.',
      server: 'Сервер не принял подписку.', sync_failed: SYNC_FAIL_TEXT,
    };
    const actions = {
      local: async () => {
        await showSystemNotification('🔔 LexLife · тест', { body: 'Тестовое уведомление LexLife доставлено.', tag: 'lexlife-test', icon: 'icons/lexlife-icon-192.png', data: { route: '#/notifications' } });
        say(`Передано системе в ${hhmm()} (локально, без сервера). Нет баннера — проверьте Настройки → Уведомления → LexLife.`);
      },
      push: async () => {
        say('Отправка через сервер LexLife…');
        const r = await pushClient.testPush();
        if (r.ok) say(`Сервер отправил push в ${hhmm()}. Он придёт и при свёрнутом приложении — можно заблокировать экран.`);
        else if (r.status === 429) say(`Слишком часто: повторите через ${r.data.retryAfter || 20} с.`);
        else if (r.status === 0) say('Нет сети — сервер недоступен.');
        else if (r.status === 409) say('Push-подписка не найдена на сервере. Включите фоновые уведомления заново.');
        else say(`Сервер не смог отправить push (${r.data.error || r.status}).`);
      },
      enable: async () => {
        say('Подключение фоновых уведомлений…');
        const r = await pushClient.enable();
        await paint();
        flash(r.ok ? 'Фоновые уведомления включены ✓' : ENABLE_ERR[r.error] || 'Не удалось включить');
      },
      sync: async () => { const r = await rulesChanged(); await paint(); if (r.ok) flash('Синхронизировано ✓'); },
      disable: async () => {
        if (!confirm('Отключить фоновые уведомления? Подписка и расписание будут удалены с сервера. Напоминания останутся только пока LexLife открыт.')) return;
        const r = await pushClient.disable();
        await paint();
        flash(r.ok ? 'Фоновые уведомления отключены' : 'Отключено на устройстве; сервер будет уведомлён при появлении сети');
      },
    };
    $$('[data-act]', p).forEach((b) => b.addEventListener('click', async () => {
      $$('[data-act]', p).forEach((x) => { x.disabled = true; });
      try { await actions[b.dataset.act](); } catch (err) { say(`Ошибка: ${err && (err.message || err.name) || 'неизвестно'}`); }
      $$('[data-act]', p).forEach((x) => { if (x.isConnected) x.disabled = false; });
    }));
    return p;
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
      const granted = on ? await ensureNotifyPermission() : false;
      await Storage.updateNotification(r.id, on ? armPatch({ enabled: true }) : { enabled: false });
      startNotifier();
      rulesChanged();
      await paint();
      if (on) flashNotifyResult(granted, 'Включено');
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
      const patch = { text: $('#e-text', wrap).value.trim(), repeat: rep };
      if (rep === 'interval') { patch.intervalMinutes = Number($('#e-int', wrap).value); patch.startTime = $('#e-start', wrap).value; patch.endTime = $('#e-end', wrap).value; }
      else if (rep === 'once') { patch.date = $('#e-date', wrap).value; patch.time = $('#e-time', wrap).value; }
      else { patch.time = $('#e-time', wrap).value; if (rep === 'weekly') patch.days = $$('.wd-chip.is-on', wrap).map((c) => Number(c.dataset.d)); }
      await Storage.updateNotification(r.id, armPatch(patch)); editing = null; startNotifier(); await paint(); flash('Сохранено ✓');
      rulesChanged();
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
  data.tests.forEach((t) => { if (t.date === dateStr) ev.push({ icon: '🧪', title: 'Анализ крови', sub: t.note || 'Результаты внесены', time: null, route: `test/${encodeURIComponent(t.id)}` }); });
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

/* =========================================================
   Статистика (#/stats) — аналитика по сохранённым записям.
   Расчёты — services/analytics.js (чистые функции, модель периода мемоизирована),
   графики — ui/charts.js. Экран ничего не пишет в медицинские данные;
   выбранный период — UI-настройка STATS_PERIOD_KEY (вне DATA_KEYS и бэкапа).
   ========================================================= */
const STATS_PERIOD_KEY = 'lexlife_stats_period';
function loadStatsPeriod() {
  try { const v = localStorage.getItem(STATS_PERIOD_KEY); return PERIOD_KEYS.includes(v) ? v : DEFAULT_PERIOD; } catch { return DEFAULT_PERIOD; }
}
function saveStatsPeriod(v) { try { localStorage.setItem(STATS_PERIOD_KEY, v); } catch { /* не критично */ } }

/* подписи, точность и минимальный размах оси для показателей статистики */
const ST = {
  weight: { name: 'Вес', gen: 'веса', unit: 'кг', d: 1, minSpan: 2 },
  sys: { name: 'Систолическое давление', gen: 'систолического давления', unit: 'mmHg', d: 0 },
  dia: { name: 'Диастолическое давление', gen: 'диастолического давления', unit: 'mmHg', d: 0 },
  pulse: { name: 'Пульс', gen: 'пульса', unit: 'уд/мин', d: 0, minSpan: 10 },
  temperature: { name: 'Температура', gen: 'температуры', unit: '°C', d: 1, minSpan: 1 },
  spo2: { name: 'Сатурация', gen: 'сатурации', unit: '%', d: 0, minSpan: 4 },
  glucose: { name: 'Глюкоза', gen: 'глюкозы', unit: 'ммоль/л', d: 1, minSpan: 2 },
  water: { name: 'Потребление воды', gen: 'потребления воды', unit: 'мл', d: 0 },
  activityMin: { name: 'Время активности', gen: 'времени активности', unit: 'мин', d: 0 },
  steps: { name: 'Количество шагов', gen: 'количества шагов', unit: 'шагов', d: 0 },
};
const POINT_KEYS = ['weight', 'pulse', 'temperature', 'spo2', 'glucose'];
const EXTRA_KEYS = ['spo2', 'glucose', 'temperature'];

const fmtN = (v, d = 0) => (v == null ? '—' : v.toLocaleString(RU, { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtSigned = (v, d = 0) => {
  const r = Number(v.toFixed(d));
  return r === 0 ? fmtN(0, d) : `${r > 0 ? '+' : '−'}${fmtN(Math.abs(r), d)}`;
};
/* изменение без фиксированной точности (анализы): +0,5 / −12 / 0 */
const fmtDelta = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString(RU, { maximumFractionDigits: 2 })}`;
const fmtDay = (day) => fmtDate(isoOfDay(day));
const fmtDayShort = (day) => new Date(isoOfDay(day) + 'T00:00:00').toLocaleDateString(RU, { day: 'numeric', month: 'short' });
const daysWord = (n) => plural(n, 'день', 'дня', 'дней');
const daysDat = (n) => plural(n, 'дню', 'дням', 'дням');
/* разница средних по отображаемым (округлённым) значениям — «68 против 68» даёт 0, а не −1 */
const roundedDelta = (cur, prev, d = 0) => Number(cur.toFixed(d)) - Number(prev.toFixed(d));
function lastLabel(point, today) {
  const n = today - point.day;
  if (n <= 0) return 'сегодня';
  if (n === 1) return 'вчера';
  if (n <= 60) return `${n} ${daysWord(n)} назад`;
  return fmtDate(point.date);
}
const pressureTxt = (s, d) => (s && d ? `${fmtN(s, 0)}/${fmtN(d, 0)}` : '—');

async function StatsScreen() {
  const [metricsLog, metricsConfig, activityDays, activityGoals, tests, medLog, meds] = await Promise.all([
    Storage.getMetricsLog(), Storage.getMetricsConfig(), Storage.getAllActivity(), Storage.getGoals(),
    Storage.getTests(), Storage.getAllMedLog(), Storage.getMeds(),
  ]);
  const engine = createStatsEngine({ metricsLog, metricsConfig, activityDays, activityGoals, tests, medLog, meds, testFields: TEST_FIELDS }, dateKey());
  const screen = el('<div class="stats"></div>');
  let period = loadStatsPeriod();
  let actMode = null;

  screen.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-scroll]');
    if (sc) { const t = document.getElementById(sc.dataset.scroll); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const p = e.target.closest('[data-period]');
    if (p) { if (p.dataset.period !== period) { period = p.dataset.period; saveStatsPeriod(period); paint(); } return; }
    onRouteClick(e);
  });

  function paint() {
    const m = engine.forPeriod(period);
    screen.innerHTML = '';
    screen.appendChild(backHeader('Статистика', { label: 'Назад', onBack: goBack }));
    screen.appendChild(el(`
      <div class="st-period" role="tablist" aria-label="Период">
        ${PERIODS.map((p) => `<button class="st-period__btn ${p.key === period ? 'is-active' : ''}" type="button" role="tab" aria-selected="${p.key === period}" data-period="${p.key}" title="${esc(p.title)}">${esc(p.label)}</button>`).join('')}
      </div>
    `));
    const sameYear = isoOfDay(m.range.start).slice(0, 4) === isoOfDay(m.range.end).slice(0, 4);
    screen.appendChild(el(`<p class="st-range">${esc(sameYear ? fmtDayShort(m.range.start) : fmtDay(m.range.start))} — ${esc(fmtDay(m.range.end))} · ${m.range.days} ${daysWord(m.range.days)}</p>`));

    if (!m.hasAny) {
      screen.appendChild(el(`
        <div class="card st-empty st-empty--all">
          <div class="placeholder__emoji">📈</div>
          <p class="st-empty__title">Пока нет данных для статистики</p>
          <p class="st-empty__sub">Статистика строится только по вашим записям. Добавьте первые измерения — и здесь появятся графики, тренды и сравнение периодов.</p>
          <div class="st-empty__actions">
            <button class="btn-ghost" type="button" data-route="metric/weight">⚖️ Вес</button>
            <button class="btn-ghost" type="button" data-route="metric/pressure">🩸 Давление</button>
            <button class="btn-ghost" type="button" data-route="metric/water">💧 Вода</button>
            <button class="btn-ghost" type="button" data-route="activity">🏃 Активность</button>
          </div>
        </div>
      `));
      return;
    }

    screen.appendChild(summarySection(m));
    const att = attentionSection(m);
    if (att) screen.appendChild(att);
    screen.appendChild(trendsSection(m));
    screen.appendChild(compareSection(m));
    screen.appendChild(pointSection(m, 'weight', '⚖️'));
    screen.appendChild(pressureSection(m));
    screen.appendChild(pointSection(m, 'pulse', '❤️'));
    screen.appendChild(waterSection(m));
    screen.appendChild(activitySection(m));
    EXTRA_KEYS.forEach((k) => { if (m[k].points.length) screen.appendChild(pointSection(m, k, METRICS[k].emoji)); });
    if (m.tests.total) screen.appendChild(testsSection(m));
    screen.appendChild(dataSection(m));
    screen.appendChild(el('<p class="st-disclaimer">Статистика рассчитана только по вашим записям в LexLife. Это математическая сводка, а не медицинское заключение: диагноз и лечение определяет врач.</p>'));
  }

  /* ---------- Сводка ---------- */
  function changeLine(key, b) {
    const t = ST[key];
    if (!b.points.length) return b.totalDays ? 'нет измерений за период' : 'Недостаточно данных';
    if (!b.change) return 'Для анализа динамики нужно больше измерений';
    const { delta, spanDays } = b.change;
    if (Math.abs(delta) < MIN_DELTA[key]) return `→ без заметного изменения за ${spanDays} ${daysWord(spanDays)}`;
    return `${delta > 0 ? '↑' : '↓'} ${fmtN(Math.abs(delta), t.d)} ${t.unit} за ${spanDays} ${daysWord(spanDays)}`;
  }
  function card({ id, emoji, name, val, unit, sub }) {
    return `<button class="mcard scard" type="button" data-scroll="${id}">
      <div class="mcard__top"><span class="mcard__emoji">${emoji}</span><span class="mcard__name">${esc(name)}</span></div>
      <div class="mcard__val">${esc(val)}${val !== '—' && unit ? `<span class="mcard__unit">${esc(unit)}</span>` : ''}</div>
      <div class="scard__sub">${esc(sub)}</div>
    </button>`;
  }
  function summarySection(m) {
    const cards = [];
    const w = m.weight;
    cards.push(card({ id: 'st-weight', emoji: '⚖️', name: 'Вес', val: w.stats.last ? fmtN(w.stats.last.value, 1) : '—', unit: 'кг', sub: changeLine('weight', w) }));
    const { sys, dia } = m.pressure;
    const lastDia = sys.stats.last ? dia.points.find((p) => p.day === sys.stats.last.day) : null;
    cards.push(card({
      id: 'st-pressure', emoji: '🩸', name: 'Давление',
      val: sys.stats.last && lastDia ? pressureTxt(sys.stats.last.value, lastDia.value) : '—', unit: 'mmHg',
      sub: sys.points.length ? `среднее ${pressureTxt(sys.stats.avg, dia.stats.avg)} · ${sys.stats.count} изм.` : (sys.totalDays ? 'нет измерений за период' : 'Недостаточно данных'),
    }));
    const p = m.pulse;
    cards.push(card({
      id: 'st-pulse', emoji: '❤️', name: 'Пульс', val: p.stats.last ? fmtN(p.stats.last.value, 0) : '—', unit: 'уд/мин',
      sub: p.points.length > 1 ? `среднее ${fmtN(p.stats.avg, 0)} · ${p.stats.count} изм.` : changeLine('pulse', p),
    }));
    const wa = m.water, gc = wa.goalCompletion;
    cards.push(card({
      id: 'st-water', emoji: '💧', name: 'Вода', val: wa.points.length ? fmtN(wa.stats.avg, 0) : '—', unit: 'мл/день',
      sub: !wa.points.length ? (wa.totalDays ? 'нет записей за период' : 'Недостаточно данных')
        : gc ? `цель в ${fmtN(gc.pct * 100, 0)}% дней с записями` : `по ${wa.points.length} ${daysDat(wa.points.length)} с записями`,
    }));
    const a = m.activity, am = a.minutes, as = a.steps;
    const useSteps = !am.points.length && as.points.length;
    const actGoal = useSteps ? as.goalCompletion : a.bike.goalCompletion;
    cards.push(card({
      id: 'st-activity', emoji: '🏃', name: 'Активность',
      val: am.points.length ? fmtN(am.stats.avg, 0) : as.points.length ? fmtN(as.stats.avg, 0) : '—',
      unit: useSteps ? 'шагов/день' : 'мин/день',
      sub: !a.recordedDays ? (a.totalDays ? 'нет записей за период' : 'Недостаточно данных')
        : `активных дней: ${a.activeDays}${actGoal && actGoal.daysWithData ? ` · цель ${useSteps ? 'шагов' : 'вело'}: ${fmtN(actGoal.pct * 100, 0)}%` : ''}`,
    }));
    EXTRA_KEYS.forEach((k) => {
      const b = m[k];
      if (!b.totalDays) return;
      cards.push(card({ id: `st-${k}`, emoji: METRICS[k].emoji, name: ST[k].name, val: b.stats.last ? fmtN(b.stats.last.value, ST[k].d) : '—', unit: ST[k].unit, sub: changeLine(k, b) }));
    });
    return el(`<section class="section"><div class="section__head"><h2 class="section__title">Сводка</h2></div><div class="mcard-grid">${cards.join('')}</div></section>`);
  }

  /* ---------- Обратить внимание (только факты и справочные диапазоны из конфигурации) ---------- */
  function attentionSection(m) {
    const items = [];
    m.tests.fields.forEach((f) => {
      const st = evaluate(f.field, f.value);
      if (st === 'warn' || st === 'danger') {
        const ref = REFERENCE[f.field];
        items.push({ icon: `<span class="dot-status dot-status--${st}"></span>`, title: `${ref.label}: ${fmtNum(f.value)} ${ref.unit}`, sub: `значение выходит за установленный справочный диапазон · анализ от ${fmtDate(f.date)}` });
      }
    });
    [['weight', m.weight, 'Вес'], ['sys', m.pressure.sys, 'Давление'], ['pulse', m.pulse, 'Пульс']].forEach(([, b, name]) => {
      if (b.totalDays >= 3 && b.coverage.daysSinceLast > 30) {
        items.push({ icon: '<span class="row__icon">⏱</span>', title: `${name}: последнее измерение ${lastLabel(b.lastAll, m.todayDay)}`, sub: 'новых записей давно не было — статистика может быть неполной' });
      }
    });
    if (!items.length) return null;
    return el(`<section class="section"><div class="section__head"><h2 class="section__title">Обратить внимание</h2></div><div class="list-card">
      ${items.map((i) => `<div class="row">${i.icon}<div class="row__body"><p class="row__title">${esc(i.title)}</p><p class="row__sub">${esc(i.sub)}</p></div></div>`).join('')}
    </div></section>`);
  }

  /* ---------- Тренды (линейная регрессия, см. analytics.calculateTrend) ---------- */
  function trendRow(key, tr, unitPerWeek) {
    const t = ST[key];
    if (tr.status === 'insufficient') {
      return { icon: '·', title: `${t.name}: недостаточно данных для определения тенденции`, sub: `есть ${tr.n} ${plural(tr.n, 'день', 'дня', 'дней')} с данными; нужно от ${TREND_MIN_POINTS} дней на отрезке от ${TREND_MIN_SPAN + 1} дней` };
    }
    const basis = `по ${tr.n} ${daysDat(tr.n)} с данными за ${tr.spanDays + 1} ${daysWord(tr.spanDays + 1)}`;
    if (tr.status === 'flat') return { icon: '→', title: `За выбранный период выраженного изменения ${t.gen} не видно`, sub: basis };
    return {
      icon: tr.status === 'up' ? '↗' : '↘',
      title: `${t.name} имеет тенденцию к ${tr.status === 'up' ? 'росту' : 'снижению'}`,
      sub: `≈ ${fmtSigned(tr.perWeek, t.d === 0 && Math.abs(tr.perWeek) < 10 ? 1 : t.d)} ${unitPerWeek || t.unit} в неделю · ${basis}`,
    };
  }
  function trendsSection(m) {
    const rows = [];
    const add = (key, b, unit) => { if (b.points.length) rows.push(trendRow(key, b.trend, unit)); };
    add('weight', m.weight);
    add('sys', m.pressure.sys);
    add('dia', m.pressure.dia);
    add('pulse', m.pulse);
    add('water', m.water, 'мл/день');
    if (m.activity.minutes.points.length) add('activityMin', m.activity.minutes, 'мин/день');
    else add('steps', m.activity.steps, 'шагов/день');
    EXTRA_KEYS.forEach((k) => add(k, m[k]));
    /* регулярность измерений относительно предыдущего периода */
    [['веса', m.weight], ['давления', m.pressure.sys], ['пульса', m.pulse]].forEach(([gen, b]) => {
      const c = b.compare;
      if (!c) return;
      if (c.regularity === 'more') rows.push({ icon: '＋', title: `Измерения ${gen} стали регулярнее`, sub: `${c.cur.count} против ${c.prev.count} в предыдущем периоде` });
      if (c.regularity === 'less') rows.push({ icon: '－', title: `Измерений ${gen} стало меньше`, sub: `${c.cur.count} против ${c.prev.count} в предыдущем периоде` });
    });
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">Тренды</h2></div><div class="list-card"></div></section>');
    const box = $('.list-card', sec);
    if (!rows.length) box.appendChild(el('<div class="empty">За выбранный период нет записей — недостаточно данных для определения тенденций</div>'));
    rows.forEach((r) => box.appendChild(el(`<div class="row"><span class="st-trend-icon" aria-hidden="true">${esc(r.icon)}</span><div class="row__body"><p class="row__title">${esc(r.title)}</p><p class="row__sub">${esc(r.sub)}</p></div></div>`)));
    return sec;
  }

  /* ---------- Сравнение с предыдущим периодом ---------- */
  function compareSection(m) {
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">Сравнение периодов</h2></div><div class="list-card"></div></section>');
    const box = $('.list-card', sec);
    if (!m.prev) {
      box.appendChild(el('<div class="empty">Для периода «Всё время» нет предыдущего периода такой же длины — сравнение не выполняется</div>'));
      return sec;
    }
    sec.querySelector('.section__head').appendChild(el(`<span class="st-head-note">${esc(fmtDayShort(m.prev.start))} — ${esc(fmtDayShort(m.prev.end))}</span>`));
    const rows = [];
    const avgTitle = { weight: 'Средний вес', pulse: 'Средний пульс', temperature: 'Средняя температура', spo2: 'Средняя сатурация', glucose: 'Средняя глюкоза' };
    POINT_KEYS.forEach((k) => {
      const c = m[k].compare, t = ST[k];
      if (!c.cur.count && !c.prev.count) return;
      const counts = `измерений ${c.cur.count} против ${c.prev.count}`;
      if (c.deltaAvg != null) rows.push([avgTitle[k], `${fmtN(c.cur.avg, t.d)} против ${fmtN(c.prev.avg, t.d)} ${t.unit} · ${counts}`, `${fmtSigned(roundedDelta(c.cur.avg, c.prev.avg, t.d), t.d)} ${t.unit}`]);
      else rows.push([avgTitle[k], c.cur.count ? `в предыдущем периоде измерений нет · ${counts}` : `в этом периоде измерений нет · ${counts}`, c.cur.count ? `${fmtN(c.cur.avg, t.d)} ${t.unit}` : '—']);
    });
    const cs = m.pressure.sys.compare, cd = m.pressure.dia.compare;
    if (cs.cur.count || cs.prev.count) {
      const counts = `измерений ${cs.cur.count} против ${cs.prev.count}`;
      if (cs.deltaAvg != null && cd.deltaAvg != null) rows.push(['Среднее давление', `${pressureTxt(cs.cur.avg, cd.cur.avg)} против ${pressureTxt(cs.prev.avg, cd.prev.avg)} mmHg · ${counts}`, `${fmtSigned(roundedDelta(cs.cur.avg, cs.prev.avg))}/${fmtSigned(roundedDelta(cd.cur.avg, cd.prev.avg))}`]);
      else rows.push(['Среднее давление', cs.cur.count ? `в предыдущем периоде измерений нет · ${counts}` : `в этом периоде измерений нет · ${counts}`, cs.cur.count ? pressureTxt(cs.cur.avg, cd.cur.avg) : '—']);
    }
    const wc = m.water.compare;
    if (wc.cur.count || wc.prev.count) {
      const g = m.water.goalCompletion, pg = m.water.prevGoalCompletion;
      const goalTxt = g && pg && g.daysWithData && pg.daysWithData ? ` · цель в ${fmtN(g.pct * 100, 0)}% против ${fmtN(pg.pct * 100, 0)}% дней` : '';
      const daysTxt = `записи за ${wc.cur.days} против ${wc.prev.days} дн.`;
      if (wc.deltaAvg != null) rows.push(['Среднее потребление воды', `${fmtN(wc.cur.avg)} против ${fmtN(wc.prev.avg)} мл/день · ${daysTxt}${goalTxt}`, `${fmtSigned(roundedDelta(wc.cur.avg, wc.prev.avg))} мл/день`]);
      else rows.push(['Среднее потребление воды', `${wc.cur.count ? 'в предыдущем периоде записей нет' : 'в этом периоде записей нет'} · ${daysTxt}`, wc.cur.count ? `${fmtN(wc.cur.avg)} мл/день` : '—']);
    }
    const a = m.activity;
    if (a.recordedDays || a.prevRecordedDays) {
      const mc = a.minutes.compare;
      const minTxt = mc.deltaAvg != null ? ` · в среднем ${fmtN(mc.cur.avg)} против ${fmtN(mc.prev.avg)} мин/день` : '';
      rows.push(['Активных дней', `записи за ${a.recordedDays} против ${a.prevRecordedDays} дн.${minTxt}`, `${a.activeDays} против ${a.prevActiveDays}`]);
    }
    if (m.tests.inPeriod || m.tests.prevInPeriod) rows.push(['Анализов', '', `${m.tests.inPeriod} против ${m.tests.prevInPeriod}`]);
    if (!rows.length) box.appendChild(el('<div class="empty">Нет записей ни в текущем, ни в предыдущем периоде</div>'));
    rows.forEach(([title, sub, trailing]) => box.appendChild(el(`<div class="row"><div class="row__body"><p class="row__title">${esc(title)}</p>${sub ? `<p class="row__sub">${esc(sub)}</p>` : ''}</div><span class="row__trailing st-delta">${esc(trailing)}</span></div>`)));
    return sec;
  }

  /* ---------- общие блоки секций показателей ---------- */
  function sectionShell(id, title, route) {
    return el(`<section class="section st-sec" id="${id}"><div class="section__head"><h2 class="section__title">${esc(title)}</h2>${route ? `<button class="section__action" type="button" data-route="${route}">+ Добавить</button>` : ''}</div></section>`);
  }
  function emptyState(b, route, word = 'измерений') {
    const text = b.totalDays && b.lastAll ? `За выбранный период ${word} нет. Последняя запись — ${fmtDate(b.lastAll.date)}.` : 'Записей пока нет.';
    return el(`<div class="card st-empty"><p class="st-empty__title">Пока недостаточно данных</p><p class="st-empty__sub">${esc(text)}</p><button class="btn-ghost" type="button" data-route="${route}">Добавить измерение</button></div>`);
  }
  function singleState(value, unit, date) {
    return el(`<div class="card st-single"><div class="st-single__val">${esc(value)} <span>${esc(unit)}</span></div><div class="st-single__date">${esc(fmtDate(date))}</div><p class="st-single__note">Для анализа динамики нужно больше измерений.</p></div>`);
  }
  const tiles = (items) => `<div class="sgrid">${items.map(([label, value, sub]) => `<div class="sgrid__item"><div class="sgrid__label">${esc(label)}</div><div class="sgrid__val">${esc(value)}</div>${sub ? `<div class="sgrid__sub">${esc(sub)}</div>` : ''}</div>`).join('')}</div>`;
  /* табличный вид (все значения периода) — строится только при раскрытии */
  function tableView(count, rowsFn) {
    const d = el(`<details class="st-table"><summary>Все значения за период · ${count}</summary><div class="list-card"></div></details>`);
    d.addEventListener('toggle', () => {
      const box = $('.list-card', d);
      if (!d.open || box.childElementCount) return;
      box.innerHTML = rowsFn().map(([left, right]) => `<div class="row st-table__row"><div class="row__body"><p class="row__sub">${esc(left)}</p></div><span class="row__trailing">${esc(right)}</span></div>`).join('');
    });
    return d;
  }
  const newestFirst = (pts) => pts.slice().reverse();

  /* ---------- Точечный показатель: вес / пульс / температура / SpO2 / глюкоза ---------- */
  function pointSection(m, key, emoji) {
    const b = m[key], t = ST[key];
    const sec = sectionShell(`st-${key}`, `${emoji} ${t.name}`, `metric/${key}`);
    if (!b.points.length) { sec.appendChild(emptyState(b, `metric/${key}`)); return sec; }
    if (b.points.length === 1) { const p = b.points[0]; sec.appendChild(singleState(fmtN(p.value, t.d), t.unit, p.date)); return sec; }
    const byDay = new Map(b.points.map((p) => [p.day, p]));
    const goal = key === 'weight' && b.goal ? b.goal : null;
    const cardEl = el('<div class="card st-card"></div>');
    cardEl.appendChild(lineChart({
      range: m.range,
      series: [{ key, label: t.name, color: 'var(--viz-1)', points: b.points }],
      goals: goal ? [{ value: goal, label: `цель ${fmtN(goal, t.d)}` }] : [],
      trend: b.trend.status !== 'insufficient' ? b.trend.line : null,
      minSpan: t.minSpan,
      ariaLabel: `${t.name} за период: ${b.stats.count} измерений, от ${fmtN(b.stats.min.value, t.d)} до ${fmtN(b.stats.max.value, t.d)} ${t.unit}`,
      readout: (day) => { const p = byDay.get(day); return `<span class="chart__rv">${esc(fmtN(p.value, t.d))} <small>${esc(t.unit)}</small></span><span class="chart__rd">${esc(fmtDate(p.date))}${p.n > 1 ? ` · среднее из ${p.n} изм.` : ''}</span>`; },
    }));
    const s = b.stats, ch = b.change;
    const items = [
      ['Изменение', `${fmtSigned(ch.delta, t.d)} ${t.unit}`, `${fmtDayShort(ch.first.day)} → ${fmtDayShort(ch.last.day)}`],
      ['Среднее', `${fmtN(s.avg, t.d)} ${t.unit}`, `${s.count} изм.`],
      ['Минимум', `${fmtN(s.min.value, t.d)} ${t.unit}`, fmtDayShort(s.min.day)],
      ['Максимум', `${fmtN(s.max.value, t.d)} ${t.unit}`, fmtDayShort(s.max.day)],
      ['Первое', `${fmtN(s.first.value, t.d)} ${t.unit}`, fmtDayShort(s.first.day)],
      ['Последнее', `${fmtN(s.last.value, t.d)} ${t.unit}`, fmtDayShort(s.last.day)],
    ];
    if (key === 'pulse' && b.compare && b.compare.deltaAvg != null) items.push(['К пред. периоду', `${fmtSigned(roundedDelta(b.compare.cur.avg, b.compare.prev.avg), 0)} ${t.unit}`, `среднее было ${fmtN(b.compare.prev.avg, 0)}`]);
    if (goal) items.push(['Цель', `${fmtN(goal, t.d)} ${t.unit}`, `до цели ${fmtSigned(goal - s.last.value, t.d)} ${t.unit}`]);
    cardEl.appendChild(el(tiles(items)));
    sec.appendChild(cardEl);
    sec.appendChild(tableView(b.points.length, () => newestFirst(b.points).map((p) => [fmtDate(p.date), `${fmtN(p.value, t.d)} ${t.unit}`])));
    return sec;
  }

  /* ---------- Давление: SYS и DIA на одном графике ---------- */
  function pressureSection(m) {
    const { sys, dia, goal } = m.pressure;
    const sec = sectionShell('st-pressure', '🩸 Давление', 'metric/pressure');
    if (!sys.points.length) { sec.appendChild(emptyState(sys, 'metric/pressure')); return sec; }
    const diaBy = new Map(dia.points.map((p) => [p.day, p]));
    const sysBy = new Map(sys.points.map((p) => [p.day, p]));
    if (sys.points.length === 1) {
      const p = sys.points[0];
      sec.appendChild(singleState(pressureTxt(p.value, diaBy.get(p.day)?.value), 'mmHg', p.date));
      return sec;
    }
    /* goal — только явно сохранённая пользователем цель (analytics.isUserGoal), иначе null */
    const goals = goal ? [{ value: goal.systolic, label: `цель SYS ${goal.systolic}` }, { value: goal.diastolic, label: `цель DIA ${goal.diastolic}` }] : [];
    const cardEl = el('<div class="card st-card"></div>');
    cardEl.appendChild(lineChart({
      range: m.range,
      series: [
        { key: 'sys', label: 'SYS · систолическое', color: 'var(--viz-1)', points: sys.points },
        { key: 'dia', label: 'DIA · диастолическое', color: 'var(--viz-2)', points: dia.points },
      ],
      goals,
      goalLegend: goal ? `цель ${goal.systolic}/${goal.diastolic}` : '',
      minSpan: 20,
      ariaLabel: `Давление за период: ${sys.stats.count} измерений, среднее ${pressureTxt(sys.stats.avg, dia.stats.avg)} mmHg`,
      readout: (day) => {
        const s = sysBy.get(day), d = diaBy.get(day), pulse = engine.pulseOn(day);
        return `<span class="chart__rv">${esc(pressureTxt(s?.value, d?.value))} <small>mmHg</small></span><span class="chart__rd">${esc(fmtDate(isoOfDay(day)))} · SYS ${esc(fmtN(s?.value))} · DIA ${esc(fmtN(d?.value))}${pulse != null ? ` · пульс в этот день ${esc(fmtN(pulse))}` : ''}</span>`;
      },
    }));
    const items = [
      ['Среднее SYS', `${fmtN(sys.stats.avg)} mmHg`, `${sys.stats.count} изм.`],
      ['Среднее DIA', `${fmtN(dia.stats.avg)} mmHg`, `${dia.stats.count} изм.`],
      ['SYS мин–макс', `${fmtN(sys.stats.min.value)}–${fmtN(sys.stats.max.value)}`, 'mmHg'],
      ['DIA мин–макс', `${fmtN(dia.stats.min.value)}–${fmtN(dia.stats.max.value)}`, 'mmHg'],
      ['Последнее', pressureTxt(sys.stats.last.value, diaBy.get(sys.stats.last.day)?.value), fmtDayShort(sys.stats.last.day)],
      ['Измерений', String(sys.stats.count), `${sys.stats.days} ${daysWord(sys.stats.days)} с данными`],
    ];
    if (goal) items.push(['Цель', `${goal.systolic}/${goal.diastolic}`, 'ваша цель']);
    cardEl.appendChild(el(tiles(items)));
    sec.appendChild(cardEl);
    sec.appendChild(tableView(sys.points.length, () => newestFirst(sys.points).map((p) => [fmtDate(p.date), `${pressureTxt(p.value, diaBy.get(p.day)?.value)} mmHg`])));
    return sec;
  }

  /* ---------- Столбцы по дням / неделям: общий readout ---------- */
  function bucketReadout(bar, unit, size, extra) {
    const range = size === 1 ? fmtDay(bar.start) : `${fmtDayShort(bar.start)} — ${fmtDayShort(bar.end)}`;
    if (bar.value == null) return `<span class="chart__rv chart__rv--muted">нет данных</span><span class="chart__rd">${esc(range)}</span>`;
    if (size === 1) {
      const zero = bar.value === 0 ? ' · записано' : '';
      return `<span class="chart__rv">${esc(fmtN(bar.value))} <small>${esc(unit)}</small></span><span class="chart__rd">${esc(range)}${zero}${extra ? esc(extra(bar.value)) : ''}</span>`;
    }
    return `<span class="chart__rv">${esc(fmtN(bar.value))} <small>${esc(unit)}/день</small></span><span class="chart__rd">среднее · ${esc(range)} · записи за ${bar.days} из ${bar.size} дн.</span>`;
  }
  const aggNote = (size) => (size === 1 ? '' : size === 7 ? 'Столбец — среднее за неделю по дням с записями.' : 'Столбец — среднее за 30 дней по дням с записями.');

  /* ---------- Вода ---------- */
  function waterSection(m) {
    const w = m.water;
    const sec = sectionShell('st-water', '💧 Вода', 'metric/water');
    if (!w.points.length) { sec.appendChild(emptyState(w, 'metric/water', 'записей')); return sec; }
    const g = w.goalCompletion, goal = w.goal;
    const cardEl = el('<div class="card st-card"></div>');
    cardEl.appendChild(svgBarChart({
      range: m.range,
      bars: w.buckets,
      goal: goal ? { value: goal, label: `цель ${fmtN(goal)}` } : null,
      minSpan: 500,
      ariaLabel: `Вода за период: среднее ${fmtN(w.stats.avg)} мл в день, записи за ${w.stats.days} из ${m.range.days} дней`,
      readout: (bar) => bucketReadout(bar, 'мл', m.bucketSize, goal ? (v) => (v >= goal ? ' · цель достигнута' : ` · ${fmtN((v / goal) * 100)}% цели`) : null),
    }));
    const note = aggNote(m.bucketSize);
    if (note) cardEl.appendChild(el(`<p class="st-note">${esc(note)}</p>`));
    const items = [
      ['Среднее в день', `${fmtN(w.stats.avg)} мл`, `по ${w.stats.days} ${daysDat(w.stats.days)} с записями`],
      ['Цель', goal ? `${fmtN(goal)} мл` : '—', g && g.avgPctOfGoal != null ? `в среднем ${fmtN(g.avgPctOfGoal * 100)}% цели` : ''],
      ['Выполнение цели', g ? `${fmtN(g.pct * 100)}%` : '—', 'дней с записями'],
      ['Дней с целью', g ? `${g.daysMet} из ${g.daysWithData}` : '—', `записей нет: ${m.range.days - w.stats.days} дн.`],
      ['Текущая серия цели', g ? `${g.currentStreak} ${daysWord(g.currentStreak)}` : '—', 'дни подряд по сегодня'],
      ['Лучшая серия цели', g ? `${g.bestStreak} ${daysWord(g.bestStreak)}` : '—', 'подряд за период'],
    ];
    cardEl.appendChild(el(tiles(items)));
    sec.appendChild(cardEl);
    sec.appendChild(tableView(w.points.length, () => newestFirst(w.points).map((p) => [fmtDate(p.date), `${fmtN(p.value)} мл${p.value === 0 ? ' (записано)' : ''}`])));
    return sec;
  }

  /* ---------- Активность ---------- */
  function activitySection(m) {
    const a = m.activity;
    const sec = sectionShell('st-activity', '🏃 Активность', 'activity');
    const hasMin = a.minutes.points.length > 0, hasSteps = a.steps.points.length > 0;
    if (!hasMin && !hasSteps) {
      sec.appendChild(emptyState({ totalDays: a.totalDays, lastAll: a.lastAll }, 'activity', 'записей активности'));
      return sec;
    }
    if (!actMode || (actMode === 'min' && !hasMin) || (actMode === 'steps' && !hasSteps)) actMode = hasMin ? 'min' : 'steps';
    const cardEl = el('<div class="card st-card"></div>');
    if (hasMin && hasSteps) {
      const seg = el(`<div class="seg st-subseg"><button class="seg__btn ${actMode === 'min' ? 'is-active' : ''}" data-a="min" type="button">Минуты</button><button class="seg__btn ${actMode === 'steps' ? 'is-active' : ''}" data-a="steps" type="button">Шаги</button></div>`);
      seg.addEventListener('click', (e) => { const btn = e.target.closest('[data-a]'); if (btn && btn.dataset.a !== actMode) { actMode = btn.dataset.a; sec.replaceWith(activitySection(m)); } });
      cardEl.appendChild(seg);
    }
    const b = actMode === 'min' ? a.minutes : a.steps;
    const unit = actMode === 'min' ? 'мин' : 'шагов';
    const goal = actMode === 'steps' && a.steps.goal ? a.steps.goal : null;
    cardEl.appendChild(svgBarChart({
      range: m.range,
      bars: b.buckets,
      goal: goal ? { value: goal, label: `цель ${fmtN(goal)}` } : null,
      minSpan: actMode === 'min' ? 30 : 2000,
      color: 'var(--viz-1)',
      ariaLabel: `Активность за период: ${a.activeDays} активных дней`,
      readout: (bar) => bucketReadout(bar, unit, m.bucketSize),
    }));
    if (actMode === 'min') cardEl.appendChild(el('<p class="st-note">Минуты = велотренажёр + другое упражнение + планка.</p>'));
    const note = aggNote(m.bucketSize);
    if (note) cardEl.appendChild(el(`<p class="st-note">${esc(note)}</p>`));
    const items = [
      ['Среднее', b.points.length ? `${fmtN(b.stats.avg)} ${unit}` : '—', `по ${b.stats.days} ${daysDat(b.stats.days)} с записями`],
      ['Активных дней', String(a.activeDays), `записи за ${a.recordedDays} из ${m.range.days} дн.`],
      ['Лучший день', b.best ? `${fmtN(b.best.value)} ${unit}` : '—', b.best ? fmtDayShort(b.best.day) : ''],
    ];
    const bg = a.bike.goalCompletion;
    if (bg && bg.daysWithData) items.push([`Вело ≥ ${a.bike.goal} мин`, `${bg.daysMet} из ${bg.daysWithData}`, `${fmtN(bg.pct * 100)}% дней с записью`]);
    const sg = a.steps.goalCompletion;
    if (sg && sg.daysWithData) items.push([`Шаги ≥ ${fmtN(a.steps.goal)}`, `${sg.daysMet} из ${sg.daysWithData}`, `${fmtN(sg.pct * 100)}% дней с записью`]);
    cardEl.appendChild(el(tiles(items)));
    sec.appendChild(cardEl);
    sec.appendChild(tableView(b.points.length, () => newestFirst(b.points).map((p) => [fmtDate(p.date), `${fmtN(p.value)} ${unit}`])));
    return sec;
  }

  /* ---------- Анализы: последний анализ, изменение к предыдущему, справочные диапазоны ---------- */
  function testsSection(m) {
    const T = m.tests;
    const sec = sectionShell('st-tests', '🩸 Анализы', 'tests');
    sec.querySelector('[data-route]').textContent = 'Все';
    const box = el(`<div class="list-card"><div class="row"><div class="row__body"><p class="row__title">Последний анализ: ${esc(fmtDate(T.latest.date))}</p><p class="row__sub">за период: ${T.inPeriod} · всего: ${T.total}</p></div></div></div>`);
    T.fields.forEach((f) => {
      const ref = REFERENCE[f.field];
      const st = evaluate(f.field, f.value);
      const outTxt = st === 'warn' || st === 'danger' ? 'вне справочного диапазона · ' : '';
      const prevTxt = f.prev ? `пред.: ${fmtNum(f.prev.value)} (${fmtDate(f.prev.date)}) · изменение ${fmtDelta(f.delta)}` : 'первое значение';
      box.appendChild(el(`<div class="row" role="button" data-route="test-history/${f.field}"><span class="dot-status dot-status--${st}"></span><div class="row__body"><p class="row__title">${esc(ref.label)}</p><p class="row__sub">${esc(outTxt + prevTxt)}</p></div><span class="row__trailing">${esc(fmtNum(f.value))} ${esc(ref.unit)}</span></div>`));
    });
    sec.appendChild(box);
    return sec;
  }

  /* ---------- Данные (насколько статистика репрезентативна) ---------- */
  function dataSection(m) {
    const rows = [];
    const pointRow = (name, b, always) => {
      if (!b.totalDays && !always) return;
      if (!b.totalDays) { rows.push([name, 'нет данных', '']); return; }
      const c = b.coverage;
      rows.push([name, `${c.count} ${plural(c.count, 'измерение', 'измерения', 'измерений')} за период · последнее: ${lastLabel(c.last, m.todayDay)}`, `${c.days} из ${m.range.days} дн.`]);
    };
    pointRow('Вес', m.weight, true);
    pointRow('Давление', m.pressure.sys, true);
    pointRow('Пульс', m.pulse, true);
    const w = m.water;
    rows.push(['Вода', w.totalDays ? `записи за ${w.stats.days} ${daysWord(w.stats.days)} из ${m.range.days} · последняя: ${lastLabel(w.lastAll, m.todayDay)}` : 'нет данных', w.totalDays ? `${w.stats.days} из ${m.range.days} дн.` : '']);
    const a = m.activity;
    rows.push(['Активность', a.totalDays ? `записи за ${a.recordedDays} ${daysWord(a.recordedDays)} из ${m.range.days} · последняя: ${lastLabel(a.lastAll, m.todayDay)}` : 'нет данных', a.totalDays ? `${a.recordedDays} из ${m.range.days} дн.` : '']);
    EXTRA_KEYS.forEach((k) => pointRow(ST[k].name, m[k], false));
    if (m.tests.total) rows.push(['Анализы', `${m.tests.inPeriod} за период · последний: ${fmtDate(m.tests.latest.date)}`, '']);
    if (m.meds.count) rows.push(['Лекарства', `отметки приёма в ${m.meds.markedDays} ${plural(m.meds.markedDays, 'дне', 'днях', 'днях')} из ${m.range.days}`, '']);
    return el(`<section class="section"><div class="section__head"><h2 class="section__title">Данные</h2></div><div class="list-card">
      ${rows.map(([t, s, tr]) => `<div class="row"><div class="row__body"><p class="row__title">${esc(t)}</p><p class="row__sub">${esc(s)}</p></div>${tr ? `<span class="row__trailing">${esc(tr)}</span>` : ''}</div>`).join('')}
    </div></section>`);
  }

  paint();
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
    Object.assign(n.style, { position: 'fixed', left: '50%', bottom: 'calc(var(--tab-bottom) + var(--tab-h) + 12px)', transform: 'translateX(-50%)', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', padding: '10px 18px', borderRadius: '999px', fontSize: '14px', fontWeight: '700', zIndex: '400', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', transition: 'opacity .2s', pointerEvents: 'none' });
    document.body.appendChild(n);
  }
  n.textContent = text; n.style.opacity = '1';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (n.style.opacity = '0'), 1600);
}

/* =========================================================
   Перенос на новый адрес (GitHub Pages → Cloudflare).
   localStorage и IndexedDB привязаны к origin: на новом адресе данных
   старой копии НЕТ, и сами они туда не попадут. На iPhone у приложения
   с экрана «Домой» ещё и своё хранилище, отдельное от Safari, — поэтому
   «мост» через окно/iframe не увидит данные. Единственный надёжный путь:
   полная копия (ZIP с документами) внутри старого приложения → файл в «Файлах»
   → «Восстановить из копии» внутри нового установленного приложения.
   Данные не проходят через сервер.
   ========================================================= */
async function MoveScreen() {
  const screen = el('<div></div>');
  const mode = migrationMode();
  screen.appendChild(backHeader(mode === 'export' ? 'Перенос LexLife' : mode === 'import' ? 'Перенос из старой версии' : 'Перенос', { label: 'Назад', onBack: goBack }));
  if (!mode) { screen.appendChild(el('<div class="empty">Перенос сейчас не требуется</div>')); return screen; }
  const url = esc(NEW_HOME_URL);
  const steps = mode === 'export' ? [
    'Здесь, в старом приложении: <a href="#/export" style="color:var(--blue)">Резервная копия</a> → <b>«Полная резервная копия с документами»</b> → сохраните ZIP в «Файлы» (iCloud Drive или «На iPhone»).',
    `Откройте в Safari новый адрес: <b>${url}</b> → Поделиться → <b>«На экран „Домой“»</b>.`,
    'Запустите <b>новый</b> LexLife с экрана «Домой» (не во вкладке Safari — у неё отдельное хранилище) → Меню → Резервная копия → <b>«Восстановить из копии»</b> → выберите ZIP.',
    'Проверьте в новом приложении показатели, анализы с документами и воду. Затем включите там фоновые уведомления (Меню → Уведомления).',
    'Старое приложение пока не удаляйте: оно продолжит работать как раньше, пока вы не убедитесь, что всё перенесено.',
  ] : [
    'В <b>старом</b> LexLife (иконка, открывающая adar4026.github.io): Меню → Резервная копия → <b>«Полная резервная копия с документами»</b> → сохраните ZIP в «Файлы».',
    'Здесь, в новом приложении, открытом с экрана «Домой»: Меню → <a href="#/export" style="color:var(--blue)">Резервная копия</a> → <b>«Восстановить из копии»</b> → выберите этот ZIP.',
    'Проверьте данные, затем включите фоновые уведомления: Меню → Уведомления.',
  ];
  screen.appendChild(el(`
    <div class="input-card">
      <p class="backup-note"><b>Данные не переносятся автоматически.</b> Старый и новый адрес — разные сайты: каждый видит только своё хранилище на этом iPhone. Перенос — через файл полной резервной копии, который остаётся у вас; на сервер данные не отправляются.</p>
    </div>
  `));
  const list = el('<div class="input-card"><ol class="move-steps" style="margin:0; padding-left:20px; display:grid; gap:10px"></ol></div>');
  steps.forEach((t) => $('.move-steps', list).appendChild(el(`<li class="backup-note" style="margin:0">${t}</li>`)));
  screen.appendChild(list);
  if (mode === 'export') {
    const open = el(`<a class="btn-primary" style="display:block; text-align:center; text-decoration:none; margin-top:12px" href="${url}" target="_blank" rel="noopener">Открыть новый адрес</a>`);
    screen.appendChild(open);
  }
  return screen;
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
  const scroller = el('<div class="drawer-scroll"></div>');
  drawer.appendChild(scroller);
  const mode = migrationMode();
  /* Пункт переноса — только в резервной копии; на основном адресе перенос уже выполнен (#/move остаётся доступен) */
  const sections = mode === 'export'
    ? [[{ route: 'move', icon: '🚚', title: 'Перенести LexLife на новый адрес' }], ...DRAWER_SECTIONS]
    : DRAWER_SECTIONS;
  sections.forEach((items) => {
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
    scroller.appendChild(sec);
  });
  scroller.appendChild(appFooter());
  guardDrawerTouch(head, scroller);
  drawer.addEventListener('click', (e) => {
    const it = e.target.closest('[data-route]');
    if (it) { closeDrawer(); location.hash = `#/${it.getAttribute('data-route')}`; }
  });
}
function openDrawer() { lockPageScroll(); $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); unlockPageScroll(); }

/* Блокировка прокрутки страницы под открытой шторкой (надёжно для iOS Safari/PWA:
   overflow:hidden на body iOS игнорирует, поэтому body фиксируется на текущей позиции).
   Идемпотентно: повторные open/close не накапливают состояние. */
let lockedScrollY = null;
function lockPageScroll() {
  if (lockedScrollY !== null) return;
  lockedScrollY = window.scrollY;
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.classList.add('is-scroll-locked');
}
function unlockPageScroll() {
  if (lockedScrollY === null) return;
  const y = lockedScrollY;
  lockedScrollY = null;
  document.body.classList.remove('is-scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, y);
}

/* iOS: жест внутри шторки принадлежит только её scroll-контейнеру.
   – у края прокрутки сдвигаем на 1px, чтобы iOS не передавал жест дальше (iOS < 16
     не поддерживает overscroll-behavior);
   – на шапке профиля (не прокручивается) вертикальный жест гасится. */
function guardDrawerTouch(head, scroller) {
  scroller.addEventListener('touchstart', () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return;
    if (scroller.scrollTop <= 0) scroller.scrollTop = 1;
    else if (scroller.scrollTop >= max) scroller.scrollTop = max - 1;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (scroller.scrollHeight <= scroller.clientHeight) e.preventDefault();
  }, { passive: false });
  head.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}

/* =========================================================
   Роутер
   ========================================================= */
const TAB_ROUTES = ['home', 'metrics', 'meds', 'tests'];
const SCREENS = {
  home: HomeScreen, metrics: MetricsScreen, meds: MedsScreen, tests: TestsScreen,
  profile: ProfileScreen, activity: ActivityScreen, visits: VisitsScreen,
  settings: SettingsScreen, export: ExportScreen, 'water-import': WaterImportScreen, theme: ThemeScreen,
  notifications: NotificationsScreen, goals: () => Stub('🎯', 'Цели'),
  calendar: CalendarScreen, stats: StatsScreen,
  security: () => Stub('🔒', 'Безопасность'),
  move: MoveScreen,
};

function resolve() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'visit/new') return { fn: () => VisitFormScreen(null), tab: null, main: false };
  if (h.startsWith('visit/')) {
    const rest = h.slice(6);
    if (rest.endsWith('/edit')) return { fn: () => VisitFormScreen(rest.slice(0, -5)), tab: null, main: false };
    return { fn: () => VisitDetailScreen(rest), tab: null, main: false };
  }
  if (h === 'test/new') return { fn: () => TestFormScreen(null), tab: 'tests', main: false };
  if (h.startsWith('test/')) {
    const rest = h.slice(5);
    if (rest.endsWith('/edit')) return { fn: () => TestFormScreen(safeDecode(rest.slice(0, -5))), tab: 'tests', main: false };
    return { fn: () => TestDetailScreen(safeDecode(rest)), tab: 'tests', main: false };
  }
  if (h.startsWith('test-history/')) return { fn: () => TestHistoryScreen(safeDecode(h.slice(13))), tab: 'tests', main: false };
  if (h === 'water-log' || h.startsWith('water-log/')) return { fn: () => WaterLogScreen(h.slice(10)), tab: 'metrics', main: false };
  if (h.startsWith('metric/')) {
    const k = h.slice(7);
    if (k === 'water') return { fn: WaterScreen, tab: 'metrics', main: true };
    if (METRICS[k]) return { fn: () => MetricScreen(k), tab: 'metrics', main: true };
  }
  if (SCREENS[h]) return { fn: SCREENS[h], tab: TAB_ROUTES.includes(h) ? h : null, main: TAB_ROUTES.includes(h) };
  return { fn: HomeScreen, tab: 'home', main: true };
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/* Место прокрутки хранится в записи истории браузера (history.state.y): «Назад» возвращает
   экран туда, где он был, новый переход открывает экран сверху. Применяется к экранам
   с node.restoreScroll = true (журнал анализов, полный анализ). */
let scrollSaveTimer = 0;
function saveScrollState() {
  clearTimeout(scrollSaveTimer);
  const y = lockedScrollY ?? window.scrollY;
  try { history.replaceState({ ...(history.state || {}), y }, ''); } catch { /* Safari: лимит частоты replaceState */ }
}
/* Вернуться на предыдущий экран; открыт напрямую (истории нет) — на route */
function goBackOr(route) {
  if (history.length > 1) history.back();
  else location.replace(`#/${route}`);
}

let renderToken = 0;
let currentRoute = null;
async function render() {
  clearTimeout(scrollSaveTimer); // отложенное сохранение не должно попасть в запись нового экрана
  const { fn, tab, main } = resolve();
  const route = location.hash.replace(/^#\/?/, '');
  const routeChanged = route !== currentRoute;
  currentRoute = route;
  const token = ++renderToken;
  closeDrawer();
  setActiveTab($('#tab-bar'), tab);
  $('#menu-btn').classList.toggle('hidden', !main);
  const node = await fn();
  if (token !== renderToken) return;
  const mount = $('#screen');
  mount.innerHTML = '';
  mount.appendChild(node);
  mount.scrollTop = 0;
  if (routeChanged && node.restoreScroll) {
    const y = history.state && typeof history.state.y === 'number' ? history.state.y : 0;
    window.scrollTo(0, y);
  }
}

function initChrome() {
  $('#menu-btn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  /* затемнение не пропускает жест прокрутки на страницу (тап по-прежнему закрывает) */
  $('#scrim').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err)); });
  /* клик по уведомлению: SW просит открыть экран (только внутренние маршруты) */
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'lexlife:open' && isSafeRoute(d.route) && location.hash !== d.route) location.hash = d.route;
  });
}

/* ---------- запуск ---------- */
applyTheme(getTheme());
async function boot() {
  await Storage.init();
  initChrome();
  await buildDrawer();
  window.addEventListener('hashchange', render);
  window.addEventListener('scroll', () => { clearTimeout(scrollSaveTimer); scrollSaveTimer = setTimeout(saveScrollState, 250); }, { passive: true });
  document.addEventListener('click', saveScrollState, true); // до перехода по ссылке/кнопке
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); notifier.check(); rulesChanged({ quiet: true }); } });
  window.addEventListener('online', () => { rulesChanged({ quiet: true }); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) notifier.check(); });
  await render();
  registerSW();
  startNotifier();
  /* фоновые уведомления: подписка на месте? неотправленные изменения правил (offline, restore) */
  pushClient.checkSubscription().then(() => rulesChanged({ quiet: true })).catch(() => {});
  if (occurrences) occurrences.prune().catch(() => {});
  /* «висячие» документы (анализ удалён/заменён при восстановлении) — фоном, безопасно */
  if (IdbAttachmentStore.available()) Attachments.cleanupOrphans().catch((err) => console.warn('[attachments] очистка пропущена', err && err.name));
}
boot();
