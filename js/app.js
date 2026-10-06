/* =========================================================
   app.js — точка входа, роутер, Drawer и экраны (MVP v1.0)
   Async-first: данные через StorageService с await.
   Навигация: нижний таб-бар (Главная/Показатели/Лекарства/Анализы)
   + боковое меню (Drawer; открывается аватаром профиля справа сверху).
   Показатели — единая модель: каждый показатель = модуль #/metric/<key>.
   ========================================================= */

import Storage, { REFERENCE, TEST_FIELDS, dateKey, APP_VERSION, APP_UPDATED, CURRENT_SCHEMA_VERSION, BackupError, parseBackup, SleepStoreError, ActivityStoreError, EntryStoreError } from './services/storage.js';
import { createStatsEngine, evaluateWaterPlan, waterGoalDays, getWaterStatsRange, PERIODS, PERIOD_KEYS, DEFAULT_PERIOD, MIN_DELTA, TREND_MIN_POINTS, TREND_MIN_SPAN, isoOfDay, dayNum } from './services/analytics.js';
import { parseWaterMinderCsv, assignImportKeys, buildWaterImportPlan, applyWaterImportPlan, applyTodayWaterImport, isWaterMinderKey } from './services/waterImport.js';
import { lineChart, barChart as svgBarChart } from './ui/charts.js';
import { AttachmentService, IdbAttachmentStore, AttachmentError, ATTACHMENT_ACCEPT, ATTACHMENT_TYPES, checkAttachmentFile, formatBytes, attachmentOf, VisitAttachmentService, VISIT_FILES_DB, visitDocsOf, MAX_FILES_PER_PICK } from './services/attachments.js';
import { createFullBackup, prepareFullRestore, applyFullRestore, isZipFile, countDocsLostOnRestore } from './services/fullBackup.js';
import { parsePreparedTest, importPreparedTest, PreparedImportError } from './services/preparedImport.js';
import { parseMedicalHistory, buildHistoryImportPlan, applyHistoryImportPlan, HistoryImportError } from './services/historyImport.js';
import { visitIcon, visitTitle, visitSub, visitTime, visitKindLabel, visitStatusChip, visitMatchesQuery, relativeVisitLabel } from './services/visitKinds.js';
import { journal, groupSummary, testSections, sameDayNumber, indicatorHistory, evaluateField } from './services/testsJournal.js';
import { openDocViewer as showDocViewer } from './ui/docViewer.js';
import { setActiveTab, initBottomNav } from './ui/bottomNav.js';
import { BackButton, goBack, goBackTo, replaceRoute, replaceUrl, initNavHistory, readEntryUi, saveEntryUi, prevRoute } from './ui/backNav.js';
import { HOME_WATER_QUICK_ADD, waterProgress, homeWaterStatus, waterPlanMarker, waterPlanDelta, medsToday, upcomingVisit, attentionItems, recentActivity, upcomingMed } from './services/homeSummary.js';
import { WEEKDAYS, MED_NAME_MAX, MED_DOSE_MAX, MED_NOTE_MAX, MED_TIMES_MAX, nextDose, medSchedule, medStatusOn, medDaySlots, isMedDueOn, nextDueDay, scheduleLabel, intakeSummary, normalizeMedInput, intakeHistory, medOccurrences, endedCourseWord } from './services/meds.js';
import {
  SLEEP_QUALITY, SLEEP_TAGS, SLEEP_GOAL_MIN, SLEEP_GOAL_MAX, SLEEP_GOAL_STEP, AWAKENINGS_MAX, NAP_MAX_MINUTES, SLEEP_NOTE_MAX, INSIGHT_MIN_DAYS,
  qualityInfo, tagInfo, formatSleepDuration, formatSleepDelta, normalizeSleepInput, inferBedDate, calculateDuration, makeStamp, stampDay, stampTime,
  getSleepForDate, averageSleep, averageBedtime, averageWakeTime, averageQuality, sleepConsistency, sleepGoalRate, currentSleepStreak, bestSleepStreak,
  aggregateByWeek, aggregateByMonth, aggregateByYear, comparePeriods, factorInsights, insightText, periodBounds, shiftPeriod, entriesInRange,
  napMinutes, totalDayMinutes, minutesToClock, clampSleepGoal, addDays as sleepAddDays,
} from './services/sleep.js';
import {
  ACTIVITY_METRICS, ACTIVITY_KEYS, LEGACY_ACTIVITY_SOURCE, ACTIVITY_NOTE_MAX, STEPS_SOURCES, STEPS_SOURCE_CHOICES,
  normalizeDailyInput, normalizeRideInput, dayValues, ridesByDate, rideDayKm, latestValue, lastDays, activityPeriodStats, comparePrevPeriod,
  fmtActivityValue, fmtActivity, activityUnit, stepsToKm, fmtKmApprox, parseActivityNumber,
} from './services/activity.js';
import { nextFire } from './services/notifySchedule.js';
import { createNotifier, describeNotifyState, armPatch, waterRulePatch, NOTIF_ROUTES, isSafeRoute } from './services/notifier.js';
import { createPushClient, SYNC_FAIL_TEXT, SERVER_FALLBACK_MS } from './services/pushClient.js';
import { createOccurrenceStore } from './services/occurrenceStore.js';
import { NEW_HOME_URL, PRIMARY_URL, migrationMode, deploymentRole, serverPushAllowed } from './services/deployment.js';
import { createUpdateController, isFormRoute, hasUnsavedInput, UPDATE_MSG } from './services/swUpdate.js';
import { PERIOD_KINDS, PERIOD_SHORT, PERIOD_NAME, periodWindow, aggregatePeriod, niceScale, fmtGroup } from './services/metricPeriods.js';
import { PeriodSelector, PeriodNavigator, MetricHeader, HealthBarChart } from './ui/healthChart.js';
import { WAIST_PERIOD_KINDS, normalizeWaistInput, latestWaist, waistPeriod, fmtCm, fmtWaist, fmtWaistChange } from './services/waist.js';
import {
  WORKOUT_TITLES, WORKOUT_NAME_SUGGESTIONS, WORKOUT_NAME_MAX, WORKOUT_NOTE_MAX, normalizeWorkoutInput, parseWorkoutInt,
  workoutTitle, workoutValue, fmtSeconds,
} from './services/workouts.js';
import { buildJournal, filterJournal, groupJournal, journalFilters, journalEmptyText, journalType, visibleDays, todayJournal, parseJournalRoute, journalRoute, JOURNAL_PAGE_DAYS } from './services/journals.js';

/* Документы анализов: файлы в IndexedDB (только на этом устройстве), метаданные — в health_tests */
const Attachments = new AttachmentService(Storage, new IdbAttachmentStore());
/* документы медицинских записей — отдельная база IndexedDB (services/attachments.js) */
const VisitFiles = new VisitAttachmentService(Storage, new IdbAttachmentStore(VISIT_FILES_DB));

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
/* Подпись диапазона: год у начальной даты опускается, если он тот же, что у конечной
   («6 сент. — 5 окт. 2026 г.»), иначе показывается у обеих («1 нояб. 2025 г. — 5 окт. 2026 г.»). */
const fmtDateRange = (from, to) =>
  `${from.slice(0, 4) === to.slice(0, 4)
    ? new Date(from + 'T00:00:00').toLocaleDateString(RU, { day: 'numeric', month: 'short' })
    : fmtDate(from)} — ${fmtDate(to)}`;
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
  /* свой модуль и свой ключ (waist_log, services/waist.js) — не metrics_log, поэтому не в METRIC_ORDER */
  waist: { key: 'waist', name: 'Обхват талии', emoji: '📏', unit: 'см', kind: 'waist', step: '0.1' },
};
const METRIC_ORDER = ['weight', 'pressure', 'pulse', 'water', 'temperature', 'spo2', 'glucose'];
const METRICS_GRID = ['weight', 'waist', 'pressure', 'pulse', 'water', 'temperature', 'spo2', 'glucose']; // сетка «Показателей»: талия рядом с весом
const POINT_JOURNAL_KEYS = METRIC_ORDER.filter((k) => METRICS[k].kind !== 'water'); // значение за день — «Все журналы»

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
   Hero прямо на фоне страницы: главный показатель дня (вода и план гидратации) · показатели
   дня 2×2 · действия. Ниже — ближайшее (лекарство, визит) · требует внимания (отклонения
   последних анализов) · последняя активность.
   Данные — только из Storage; расчёты — js/services/homeSummary.js.
   ========================================================= */
const HOME_QUICK_METRICS = ['pressure', 'pulse', 'weight']; // ячейки после «Лекарств»
const HOME_WATER_ADD = HOME_WATER_QUICK_ADD; // мл — кнопка hero «+ 300 мл», запись через Storage.addWaterEntry
let homeEntered = false;
let homeMarkerTimer = null; // лёгкое обновление раз в минуту: только положение плановой метки + a11y, без перерендера
function stopHomeMarkerTimer() { clearInterval(homeMarkerTimer); homeMarkerTimer = null; }

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
  sleep: '<path d="M19.6 14.8A7.9 7.9 0 0 1 9.2 4.4a7.9 7.9 0 1 0 10.4 10.4z"/>',
  sliders: '<path d="M4 7.5h9M17.5 7.5H20M4 16.5h3M11.5 16.5H20"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="9.2" cy="16.5" r="2.2"/>',
  steps: '<path d="M8.6 3.8c1.7 0 2.6 1.7 2.6 3.8s-1.1 4-2.6 4-2.7-1.6-2.7-3.9.9-3.9 2.7-3.9z"/><path d="M6.3 14.1h4.6l-.3 2.1a2.2 2.2 0 0 1-4.3 0z"/><path d="M15.6 7.8c1.7 0 2.6 1.7 2.6 3.8s-1.1 4-2.6 4-2.7-1.6-2.7-3.9.9-3.9 2.7-3.9z"/><path d="M13.3 18.1h4.6l-.3 2.1a2.2 2.2 0 0 1-4.3 0z"/>',
  bike: '<circle cx="6" cy="15.8" r="3.7"/><circle cx="18" cy="15.8" r="3.7"/><path d="M6 15.8l3.7-6.9h6.4L18 15.8"/><path d="M9.7 8.9l2.6 6.9H6"/><path d="M8.4 6.4h2.8"/><path d="M14.8 6h2.4l-1.1 2.9"/>',
};
/* сантиметровая лента · гантель */
HOME_ICONS.waist = '<path d="M3.5 9.5h14a3 3 0 0 1 0 6h-14z"/><path d="M7 9.5v2.2M10.5 9.5v3M14 9.5v2.2"/><path d="M17.5 15.5H21"/>';
HOME_ICONS.workout = '<path d="M7 8.5v7M17 8.5v7"/><rect x="3.8" y="9.8" width="3.2" height="4.4" rx="1"/><rect x="17" y="9.8" width="3.2" height="4.4" rx="1"/><path d="M7 12h10"/>';
HOME_ICONS.temperature = HOME_ICONS.pulse;
HOME_ICONS.spo2 = HOME_ICONS.pulse;
HOME_ICONS.glucose = HOME_ICONS.lab;
/* капля главного показателя: заливка — мягкий вертикальный градиент фирменных цветов (токены темы) */
const WATER_DROP_SVG = '<svg class="hh__drop" viewBox="0 0 24 30" aria-hidden="true"><defs><linearGradient id="hh-drop-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--hm-drop-top)"/><stop offset="1" style="stop-color:var(--hm-drop-bottom)"/></linearGradient></defs><path fill="url(#hh-drop-g)" d="M12 1.5c-.5 0-.9.3-1.2.7C6.6 8 3 12.9 3 18.6 3 24 7 28.5 12 28.5s9-4.5 9-9.9c0-5.7-3.6-10.6-7.8-16.4-.3-.4-.7-.7-1.2-.7z"/></svg>';
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
function homeSection(title, route, label, more = 'Все') {
  return el(`
    <section class="hsec">
      <div class="hsec__head">
        <h2 class="hsec__title">${esc(title)}</h2>
        ${route ? `<a class="hsec__more" href="#/${route}" aria-label="${esc(label)}">${esc(more)}${homeIcon('chevron', 'hsec__chev')}</a>` : ''}
      </div>
    </section>
  `);
}

async function HomeScreen() {
  const now = new Date();
  const today = dateKey(now);
  const [water, goal, hyd, tests, metricsLog, visits, meds, takenToday, intakes, sleepEntries, sleepSettings, stepsLog, bikeRides] = await Promise.all([
    Storage.getWater(today), Storage.getWaterGoal(), Storage.getHydration(), Storage.getTests(), Storage.getMetricsLog(),
    Storage.getVisits(), Storage.getMeds(), Storage.getMedLog(today), Storage.getMedIntakes(today),
    Storage.getSleepEntries(), Storage.getSleepSettings(),
    Storage.getDailyActivityLog('steps'), Storage.getBikeRides(),
  ]);
  const [waistLog, workouts] = await Promise.all([Storage.getWaistLog(), Storage.getWorkouts()]);
  const screen = el('<div class="home"></div>');
  /* мягкое появление — только при первом открытии Главной за запуск (не на каждом переключении вкладки) */
  const enter = !homeEntered;
  homeEntered = true;

  screen.appendChild(renderHomeHero({ now, today, water, goal, hyd, meds, takenToday, intakes, metricsLog, enter }));
  screen.appendChild(renderHomeSleep(getSleepForDate(sleepEntries, today), sleepSettings.goalMinutes));
  const activityStores = { steps: stepsLog, bike: bikeRides };
  ACTIVITY_KEYS.forEach((k) => screen.appendChild(renderHomeActivity(k, activityStores[k], today)));
  const journalItems = buildJournal({ metricsLog, sleep: sleepEntries, steps: stepsLog, bike: bikeRides, waist: waistLog, workouts }, { waterGoal: goal, sleepGoal: sleepSettings.goalMinutes });
  screen.appendChild(renderTodayJournals(journalItems, today));
  const upcoming = renderUpcoming({ meds, takenToday, intakes, visits, now });
  if (upcoming) screen.appendChild(upcoming);
  const attention = renderAttentionSection(tests);
  if (attention) screen.appendChild(attention);
  const recent = renderRecentActivity({ tests, metricsLog, visits, today });
  if (recent) screen.appendChild(recent);
  return screen;
}

/* ---------- Hero: композиция прямо на фоне страницы (без карточки) ----------
   Главный показатель дня — вода: выпито / цель и остаток до цели (homeWaterStatus) в одной строке,
   на шкале красная метка плана к текущему моменту (plannedByNow → waterPlanMarker), под шкалой
   справа — её числовая подпись: отклонение от этого же плана (waterPlanDelta).
   Ниже — показатели дня 2×2 и два действия. Фон — световые волны
   .hh-ambient (только CSS, в границах hero, растворяются к «Ближайшему»). */
function renderHomeHero({ now, today, water, goal, hyd, meds, takenToday, intakes, metricsLog, enter }) {
  const hero = el(`
    <section class="hh${enter ? ' hh--enter' : ''}" aria-labelledby="hh-title">
      <div class="hh-ambient" aria-hidden="true"><span class="hh-wave hh-wave--a"></span><span class="hh-wave hh-wave--b"></span><span class="hh-wave hh-wave--c"></span></div>
      <header class="hh__head">
        <h1 class="hh__date" id="hh-title">${esc(fmtFull(now))}</h1>
      </header>
      <div class="hh__main">
        <a class="hh__value water-main-value" href="#/metric/water">${WATER_DROP_SVG}<span class="hh__num"></span><span class="hh__unit">мл</span></a>
        <p class="hh__caption"><span class="hh__goal"></span><span class="hh__left" aria-live="polite"></span></p>
        <div class="hh__bar" role="progressbar" aria-label="Вода: выпито от цели" aria-valuemin="0" aria-valuemax="100"><span class="hh__fill"></span><span class="hh__plan" aria-hidden="true" hidden></span></div>
        <p class="hh__meta"><span class="hh__pct"></span><span class="hh__dev"></span></p>
      </div>
      <div class="hh__cta">
        <a class="hh-btn hh-btn--soft" href="#/metric/water" aria-label="Подробнее о воде: план дня и журнал">Подробнее</a>
        <button class="hh-btn hh-btn--accent" type="button" aria-label="Добавить ${HOME_WATER_ADD} мл воды">${homeIcon('plus')}${HOME_WATER_ADD} мл</button>
      </div>
      <div class="hm-grid"></div>
    </section>
  `);
  if (deploymentRole() === 'legacy') $('.hh__head', hero).after(legacyNotice());

  let currentWaterMl = water; // для периодического обновления метки и отклонения (та же вода, меняется только время)
  const paint = (cur) => {
    currentWaterMl = cur;
    const p = waterProgress(cur, goal);
    const s = homeWaterStatus(p.current, p.goal);
    const planned = hyd && hyd.wakeStart && hyd.wakeEnd ? plannedByNow(p.goal, hyd, nowMinutes()) : 0;
    const mark = waterPlanMarker(planned, p.goal);
    const d = waterPlanDelta(p.current, p.goal, planned);
    const pct = p.goal ? Math.round((p.current / p.goal) * 100) : 0;
    $('.hh__num', hero).textContent = fmtMl(p.current);
    $('.hh__goal', hero).textContent = p.goal ? `воды из ${fmtMl(p.goal)} мл` : 'воды сегодня';
    const left = $('.hh__left', hero);
    left.className = `hh__left hh__left--${s.state}`;
    left.innerHTML = s.state === 'done'
      ? `${homeIcon('check')}Выполнено${s.over ? ` · +${esc(fmtMl(s.over))} мл` : ''}` // коротко: «Цель выполнена · +1 200 мл» не помещается рядом с «воды из 2 600 мл» на 375px
      : s.state === 'remaining'
        ? `Осталось: ${esc(fmtMl(s.remaining))} мл`
        : '';
    $('.hh__fill', hero).style.width = `${p.progress * 100}%`;
    const plan = $('.hh__plan', hero);
    plan.hidden = mark == null;
    if (mark != null) plan.style.setProperty('--plan', String(mark));
    const bar = $('.hh__bar', hero);
    bar.setAttribute('aria-valuenow', String(Math.min(pct, 100)));
    bar.setAttribute('aria-valuetext', p.goal ? `${fmtMl(p.current)} из ${fmtMl(p.goal)} мл, ${pct}%; по плану к этому времени ${fmtMl(planned)} мл` : `${fmtMl(p.current)} мл`);
    $('.hh__pct', hero).textContent = p.goal ? `${pct}% от цели` : '';
    const dev = $('.hh__dev', hero);
    dev.className = `hh__dev hh__dev--${d.state}`;
    dev.innerHTML = d.state === 'behind'
      ? `<b>−${esc(fmtMl(-d.delta))} мл</b> · отстаёте`
      : d.state === 'ahead'
        ? `<b>+${esc(fmtMl(d.delta))} мл</b> · опережаете`
        : d.state === 'onPlan' ? 'По плану' : 'Цель не задана';
    $('.hh__value', hero).setAttribute('aria-label', `Вода сегодня: ${fmtMl(p.current)}${p.goal ? ` из ${fmtMl(p.goal)}` : ''} мл. Открыть модуль воды`);
  };
  paint(water);
  /* плановая метка и отклонение от плана зависят от времени (вода и цель — нет): раз в минуту пересчитываем
     то же paint() — он лишь переставляет метку, обновляет отклонение и aria-valuetext, без перерендера экрана.
     stopHomeMarkerTimer() в render() гасит таймер при уходе с Главной или при повторном входе на неё. */
  stopHomeMarkerTimer();
  homeMarkerTimer = setInterval(() => paint(currentWaterMl), 60000);

  const grid = $('.hm-grid', hero);
  homeMetricCells({ meds, takenToday, intakes, metricsLog, today }).forEach((c, i) => {
    const cell = el(`
      <a class="hm hm--${c.tone}" href="${c.href}" style="--i:${i}">
        <span class="hm__label">${homeIcon(c.icon, 'hm__icon')}<span class="hm__name"></span></span>
        <span class="hm__val${c.value ? '' : ' hm__val--none'}"></span>
        <span class="hm__when"></span>
      </a>
    `);
    $('.hm__name', cell).textContent = c.name;
    const val = $('.hm__val', cell);
    val.textContent = c.value || '—';
    if (c.value && c.unit) val.appendChild(el(`<span class="hm__unit">${esc(c.unit)}</span>`));
    $('.hm__when', cell).textContent = c.when;
    cell.setAttribute('aria-label', c.label);
    grid.appendChild(cell);
  });

  const add = $('.hh-btn--accent', hero);
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
  return hero;
}

/* Показатели дня 2×2: лекарства (отмеченные приёмы сегодня) · давление · пульс · вес (последние записи) */
function homeMetricCells({ meds, takenToday, intakes, metricsLog, today }) {
  const m = medsToday(meds, { today, takenToday, intakes });
  const cells = [{
    tone: 'med', icon: 'med', name: 'Лекарства', href: '#/meds', unit: '',
    value: m.due ? `${m.taken} / ${m.due}` : null,
    when: !m.due ? 'на сегодня нет' : m.taken >= m.due ? 'всё принято' : 'принято сегодня',
    label: m.due ? `Лекарства сегодня: принято ${m.taken} из ${m.due}. Открыть лекарства` : 'Лекарства: на сегодня приёмов нет. Открыть лекарства',
  }];
  HOME_QUICK_METRICS.forEach((key) => {
    const M = METRICS[key];
    const log = (metricsLog && metricsLog[key]) || {};
    const date = Object.keys(log).filter((d) => log[d] != null && d <= today).sort().pop();
    const value = date ? fmtMetric(key, log[date]) : null;
    cells.push({
      tone: key, icon: key, name: M.name, href: `#/metric/${key}`,
      /* давление «120/80» читается без единицы — в aria-label она есть */
      value, unit: key === 'pressure' ? '' : M.unit,
      when: date ? fmtWhen(date, today) : 'нет записей',
      label: value ? `${M.name}: ${value} ${M.unit}, ${fmtWhen(date, today)}. Открыть` : `${M.name}: нет записей. Добавить`,
    });
  });
  return cells;
}

/* ---------- Сон: запись за сегодня (день пробуждения) или приглашение записать ---------- */
function renderHomeSleep(e, goal) {
  const sec = homeSection('Сон', 'sleep', 'Открыть раздел «Сон»');
  const met = e && e.durationMinutes >= goal;
  const row = el(`
    <a class="hrow" href="#/sleep">
      <span class="hrow__icon hrow__icon--sleep">${homeIcon('sleep')}</span>
      <span class="hrow__body"><span class="hrow__title"></span>${e ? '<span class="hrow__sub hrow__sub--one"></span>' : ''}</span>
      <span class="hrow__status ${e ? (met ? 'hrow__status--ok' : '') : 'hrow__status--add'}"></span>
      ${homeIcon('chevron', 'hrow__chev')}
    </a>
  `);
  const status = $('.hrow__status', row);
  if (e) {
    const pct = Math.round((e.durationMinutes / goal) * 100);
    $('.hrow__title', row).textContent = formatSleepDuration(e.durationMinutes);
    $('.hrow__sub', row).textContent = `${stampTime(e.sleepStart)} → ${stampTime(e.sleepEnd)}`;
    status.innerHTML = met ? `Цель выполнена ${homeIcon('check', 'hrow__ok')}` : `${pct}% цели`;
    row.setAttribute('aria-label', `Сон сегодня: ${formatSleepDuration(e.durationMinutes)}, ${stampTime(e.sleepStart)} → ${stampTime(e.sleepEnd)}, ${met ? 'цель выполнена' : `${pct}% цели`}. Открыть раздел «Сон»`);
  } else {
    $('.hrow__title', row).textContent = 'Сегодня нет записи';
    status.textContent = 'Добавить';
    row.setAttribute('aria-label', 'Сон: сегодня нет записи. Открыть раздел «Сон», чтобы добавить');
  }
  const list = el('<div class="hlist"></div>');
  list.appendChild(row);
  sec.appendChild(list);
  return sec;
}

/* ---------- Шаги / Велосипед: отдельная карточка каждого показателя ----------
   Как карточка сна: значение за сегодня (или последнее записанное и его дата; у шагов — с расчётными
   км: «8 450 шагов · ≈ 6,3 км»), справа — мини-график
   последних 7 дней; нажатие — экран показателя. Значения — services/activity.js (dayValues). */
const plRides = (n) => `${n} ${plural(n, 'поездка', 'поездки', 'поездок')}`;
function activitySpark(values, today) {
  const days = lastDays(values, 7, today);
  if (!days.some((d) => d.value != null)) return '';
  const max = Math.max(...days.map((d) => d.value || 0), 1);
  const bars = days.map((d, i) => {
    const x = i * 9;
    if (d.value == null) return `<rect x="${x}" y="25" width="6" height="2" rx="1" class="hspark__none"/>`;
    const h = Math.max(3, Math.round((d.value / max) * 26));
    return `<rect x="${x}" y="${27 - h}" width="6" height="${h}" rx="2" class="${d.date === today ? 'hspark__today' : 'hspark__bar'}"/>`;
  }).join('');
  return `<svg class="hspark" viewBox="0 0 60 27" aria-hidden="true">${bars}</svg>`;
}
function renderHomeActivity(metric, store, today) {
  const M = ACTIVITY_METRICS[metric];
  const sec = homeSection(M.title, M.route, `Открыть раздел «${M.title}»`);
  const values = dayValues(metric, store);
  const last = latestValue(values, today);
  const row = el(`
    <a class="hrow hact" href="#/${M.route}" data-activity="${metric}">
      <span class="hrow__icon hrow__icon--${metric}">${homeIcon(metric)}</span>
      <span class="hrow__body"><span class="hrow__title"></span><span class="hrow__sub hrow__sub--one"></span></span>
      ${last ? activitySpark(values, today) : '<span class="hrow__status hrow__status--add">Добавить</span>'}
      ${homeIcon('chevron', 'hrow__chev')}
    </a>
  `);
  let title, sub;
  if (last) {
    title = fmtActivity(metric, last.value);
    sub = fmtWhen(last.date, today);
    if (metric === 'bike') { const n = (ridesByDate(store).get(last.date) || []).length; sub = `${capFirst(sub)} · ${plRides(n)}`; }
    else sub = capFirst(sub);
  } else if (metric === 'bike' && Array.isArray(store) && store.length) {
    /* только перенесённые записи велотренажёра — минуты без дистанции */
    title = rideTitle({ ...store[0], time: null });
    sub = `${NO_KM} · ${fmtWhen(store[0].date, today)}`;
  } else {
    title = 'Нет записей';
    sub = 'Нажмите, чтобы добавить';
  }
  $('.hrow__title', row).textContent = title;
  $('.hrow__sub', row).textContent = sub;
  row.setAttribute('aria-label', `${M.title}: ${title}, ${sub}. Открыть раздел «${M.title}»`);
  const list = el('<div class="hlist"></div>');
  list.appendChild(row);
  sec.appendChild(list);
  return sec;
}

/* ---------- Ближайшее: следующее лекарство и следующий визит (время · тип · действие) ---------- */
function renderUpcoming({ meds, takenToday, intakes, visits, now }) {
  const today = dateKey(now);
  const tomorrow = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const dayWord = (d) => (d === today ? 'Сегодня' : d === tomorrow ? 'Завтра' : fmtWhen(d, today));
  const items = [];
  const u = upcomingMed(meds, { now, takenToday, intakes });
  if (u) items.push({ sort: `${u.date}T${u.time || '00:00'}`, tone: 'med', icon: 'med', href: '#/meds', title: u.name,
    top: u.time || dayWord(u.date), bottom: u.time ? dayWord(u.date) : '', sub: ['Лекарство', u.dose].filter(Boolean).join(' · ') });
  const v = upcomingVisit(visits, today);
  if (v) items.push({ sort: `${v.date}T99`, tone: 'visit', icon: 'visit', href: `#/visit/${encodeURIComponent(v.visitId)}`, title: v.title,
    top: dayWord(v.date), bottom: '', sub: v.next ? 'Следующий визит' : 'Визит к врачу' });
  if (!items.length) return null;
  items.sort((a, b) => a.sort.localeCompare(b.sort));

  const sec = homeSection('Ближайшее', 'calendar', 'Открыть календарь', 'Календарь');
  const list = el('<div class="hev-list"></div>');
  items.forEach((it) => {
    const row = el(`
      <a class="hev" href="${it.href}">
        <span class="hev__when"><b></b><small></small></span>
        <span class="hev__icon hev__icon--${it.tone}">${homeIcon(it.icon)}</span>
        <span class="hev__body"><span class="hev__title"></span><span class="hev__sub"></span></span>
        ${homeIcon('chevron', 'hrow__chev')}
      </a>
    `);
    $('.hev__when b', row).textContent = it.top;
    $('.hev__when small', row).textContent = it.bottom;
    $('.hev__title', row).textContent = it.title;
    $('.hev__sub', row).textContent = it.sub;
    row.setAttribute('aria-label', `${it.sub}: ${it.title}, ${[it.bottom, it.top].filter(Boolean).join(' ')}. Открыть`);
    list.appendChild(row);
  });
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
  const waistLog = await Storage.getWaistLog();
  const latests = await Promise.all(METRICS_GRID.map((k) => {
    if (k !== 'waist') return Storage.getMetricLatest(k);
    const w = latestWaist(waistLog, dateKey());
    return w ? { date: w.date, value: w.cm } : null;
  }));
  const screen = el('<div></div>');
  screen.appendChild(el('<header class="header"><h1 class="header__title">Показатели</h1></header>'));
  const sec = el('<section class="section" style="margin-top:8px"><div class="mcard-grid"></div></section>');
  const grid = $('.mcard-grid', sec);
  METRICS_GRID.forEach((k, i) => grid.appendChild(metricCard(k, latests[i])));
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
  const PERIOD_UI = ['week', 'month', 'year'];
  let period = PERIOD_UI.includes(readEntryUi('metric')) ? readEntryUi('metric') : 'week';
  let editingGoal = false;

  async function paint() {
    saveEntryUi('metric', period); // «Назад» с вложенного экрана — тот же период
    const [log, cfg] = await Promise.all([Storage.getMetricLog(key), Storage.getMetricConfig(key)]);
    const goal = cfg.goal;
    const days = Object.keys(log).sort();
    const lastDay = days[days.length - 1];
    const cur = lastDay != null ? log[lastDay] : null;
    screen.innerHTML = '';

    screen.appendChild(backHeader(`${M.emoji} ${M.name}`, { fallback: 'metrics' }));

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

/* Серия для графика. Диапазон — всегда canonical range периода (getWaterStatsRange):
   график, подпись диапазона и среднее на экране «Вода» обязаны строиться по одному
   и тому же startDate/endDate. range можно передать готовым, чтобы экран и график
   гарантированно смотрели на один объект. */
function metricSeries(log, p, key, range = null) {
  const r = range || getWaterStatsRange(p, new Date());
  const labels = [];
  const values = [];
  if (r.period !== 'year') {
    r.dayKeys.forEach((k, i) => {
      values.push(chartVal(key, log[k]) || 0);
      const d = new Date(k + 'T00:00:00');
      if (r.period === 'week') labels.push(d.toLocaleDateString(RU, { weekday: 'short' }));
      else labels.push((r.numberOfDays - 1 - i) % 5 === 0 ? String(d.getDate()) : '');
    });
  } else {
    /* 12 месячных столбцов: среднее по дням месяца с записями (дни без записей столбец не занижают) */
    const byMonth = new Map(r.months.map((m) => [m.ym, []]));
    for (const k of r.dayKeys) {
      const cv = chartVal(key, log[k]);
      if (cv > 0) byMonth.get(k.slice(0, 7)).push(cv);
    }
    r.months.forEach((m) => {
      const vals = byMonth.get(m.ym);
      values.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
      labels.push(new Date(m.start + 'T00:00:00').toLocaleDateString(RU, { month: 'short' }));
    });
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
  const sec = el(`<section class="section"><div class="section__head"><h2 class="section__title">История</h2><a class="section__action metric-journal" href="#/journals/${esc(key)}">Журнал ›</a></div><div class="list-card"></div></section>`);
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

/* Слой воды резервуара экрана «Вода»: две мягкие волны (задняя бледнее) и тело с градиентом.
   Волна — два периода на ширину 200%: сдвиг на −50% бесшовно повторяет её. */
const WATER_WAVE_PATH = 'M0,9 C16.5,2.5 33.5,2.5 50,9 S83.5,15.5 100,9 S133.5,2.5 150,9 S183.5,15.5 200,9 V19 H0 Z';
const WATER_TANK_LAYER = `<div class="wtank__water" aria-hidden="true">
  <svg class="wtank__wave wtank__wave--back" viewBox="0 0 200 18" preserveAspectRatio="none" focusable="false"><path d="${WATER_WAVE_PATH}"/></svg>
  <svg class="wtank__wave" viewBox="0 0 200 18" preserveAspectRatio="none" focusable="false"><path d="${WATER_WAVE_PATH}"/></svg>
  <div class="wtank__body"></div>
</div>`;

/* Шкала резервуара: 0 % — верх кнопки цели (или редактора цели), 100 % — верх заголовка
   «💧 Вода». Середина волны ставится в px от верха резервуара (--surf-y); при 0 % слой целиком
   ниже резервуара. Меряется по вёрстке — верно и на маленьких экранах, и с открытым редактором. */
function placeTankWater(tank, level) {
  const box = tank.getBoundingClientRect();
  const low = tank.querySelector(':scope > .btn-ghost, :scope > .goal-editor').getBoundingClientRect().top - box.top;
  const high = tank.querySelector('.header__title').getBoundingClientRect().top - box.top;
  const waveH = parseFloat(getComputedStyle(tank).getPropertyValue('--wave-h')) || 0;
  const y = level > 0 ? low - Math.min(level, 1) * (low - high) : box.height + waveH / 2;
  tank.style.setProperty('--lvl', String(level));
  tank.style.setProperty('--surf-y', `${y.toFixed(1)}px`);
}

async function WaterScreen() {
  const screen = el('<div></div>');
  /* Статистика: тип периода (ДН · НЕД · МЕС · 6 МЕС · ГОД) и смещение ‹ › — в записи истории:
     «Назад» из журнала возвращает тот же период. Прежнее значение ('week'|'month'|'year') тоже понимаем. */
  const savedUi = readEntryUi('water');
  let stats = savedUi && typeof savedUi === 'object' && PERIOD_KINDS.includes(savedUi.k)
    ? { kind: savedUi.k, offset: Math.min(0, Math.trunc(savedUi.o) || 0) }
    : { kind: PERIOD_KINDS.includes(savedUi) ? savedUi : 'week', offset: 0 };
  let editingGoal = false;
  let tankLevel = null; // уровень резервуара прошлой отрисовки — от него анимируется новый
  let tankRO = null;
  const statsHost = el('<section class="section hstats" aria-label="Статистика воды"></section>');
  let segFrom = null; // сегмент до переключения — для анимации бегунка
  let statsData = null; // { log, goal } последней отрисовки — для смены периода без перечитывания экрана

  async function paint() {
    saveEntryUi('water', { k: stats.kind, o: stats.offset });
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
    /* Резервуар: верх экрана — от края экрана (с safe area) до низа кнопки цели. Вода поднимается
       по сегодняшнему прогрессу (waterProgress: выпито / цель, 0…1) от верха кнопки цели (0 %) до
       верха заголовка «💧 Вода» (100 %). Слой — под содержимым, без касаний; при записи уровень
       плавно поднимается от прежнего значения. */
    const level = waterProgress(total, goal).progress;
    const tank = el(`<div class="wtank is-init${level > 0 ? ' is-wet' : ''}">${WATER_TANK_LAYER}</div>`);
    screen.appendChild(tank);
    tank.appendChild(backHeader('💧 Вода', { fallback: 'metrics' }));

    /* 1. Кольцо + 2. текущий объём / цель */
    const r = 60, circ = 2 * Math.PI * r;
    const off = circ * (1 - Math.min(pct, 100) / 100);
    tank.appendChild(el(`
      <div class="water-hero">
        <div class="wring">
          <svg width="150" height="150" viewBox="0 0 150 150">
            <circle class="wring__disc" cx="75" cy="75" r="${r - 6.5}"/>
            <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="13"/>
            <circle cx="75" cy="75" r="${r}" fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 75 75)"/>
          </svg>
          <div class="wring__center"><div class="wring__val">${fmtMl(total)}</div><div class="wring__sub" style="color:${color}">мл · ${pct}%</div></div>
        </div>
        <div class="water-goalrow"><span>осталось <b>${fmtMl(remaining)} мл</b></span><span>цель <b>${fmtMl(goal)} мл</b></span></div>
      </div>
    `));
    if (editingGoal) {
      tank.appendChild(buildGoalEditor(goal));
    } else {
      const gb = el('<button class="btn-ghost" type="button" style="margin-top:10px">✎ Редактировать цель</button>');
      gb.addEventListener('click', () => { editingGoal = true; paint(); });
      tank.appendChild(gb);
    }
    /* Первая расстановка — без анимации (is-init), затем подъём от прежнего уровня к новому;
       ResizeObserver переставляет воду при изменении вёрстки (шрифты, поворот экрана) */
    let shown = tankLevel == null ? level : tankLevel;
    let placed = false;
    tankLevel = level;
    if (tankRO) tankRO.disconnect();
    tankRO = new ResizeObserver(() => {
      placeTankWater(tank, shown);
      if (placed) return;
      placed = true;
      requestAnimationFrame(() => {
        tank.classList.remove('is-init');
        if (shown !== level) requestAnimationFrame(() => { shown = level; placeTankWater(tank, level); });
      });
    });
    tankRO.observe(tank);

    /* 3. Быстрое добавление */
    screen.appendChild(quickBar());

    /* 4. План гидратации по времени + 5. отставание/опережение */
    screen.appendChild(planSection(goal, hyd, dayObj.entries || []));
    screen.appendChild(deviationSection(goal, hyd, total));

    /* 6. История за день */
    screen.appendChild(journal(dayObj.entries || [], today));

    /* 7. Статистика периода (Apple Health по структуре): ДН · НЕД · МЕС · 6 МЕС · ГОД, среднее,
       диапазон, ‹ ›, график с осью Y и целью. Один и тот же период — у среднего, графика,
       подписи и «цель выполнена, дней» ниже. */
    statsData = { log, goal };
    screen.appendChild(statsHost);
    paintStats();

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
    screen.appendChild(goalStatsHost);

    /* 9. Настройки напоминаний (тумблер = правило «Вода» центра уведомлений) */
    const waterRule = (await Storage.getNotifications()).find((n) => n.type === 'water') || null;
    screen.appendChild(reminderSettings(hyd, waterRule));
  }

  const goalStatsHost = el('<div></div>');
  /* Блок статистики: перерисовывается сам (смена периода, ‹ ›), остальной экран не трогается */
  function paintStats() {
    const { log, goal } = statsData;
    saveEntryUi('water', { k: stats.kind, o: stats.offset });
    const today = dateKey();
    const win = periodWindow(stats.kind, stats.offset, today);
    const agg = aggregatePeriod(win, (d) => {
      const o = log[d];
      return o && typeof o.total === 'number' ? Math.max(0, o.total) : null;
    }, { hourValues: waterByHour });
    const isDay = win.kind === 'day';
    const scale = niceScale(agg.max, isDay ? null : goal);
    const ml = (v) => `${fmtGroup(v)} мл`;
    const tip = (b) => (isDay ? { title: b.tip, value: ml(b.value) }
      : win.kind === 'week' ? { title: b.tip, value: ml(b.value) }
        : { title: b.tip, value: `в среднем ${fmtGroup(b.value)} мл/день` });
    const shift = (d) => { stats = { ...stats, offset: Math.min(0, stats.offset + d) }; paintStats(); };

    statsHost.innerHTML = '';
    const segFromNow = segFrom;
    segFrom = null;
    statsHost.appendChild(PeriodSelector({
      kinds: PERIOD_KINDS.map((k) => ({ id: k, label: PERIOD_SHORT[k], title: PERIOD_NAME[k] })),
      active: win.kind,
      onChange: (k) => { segFrom = stats.kind; stats = { kind: k, offset: 0 }; paintStats(); },
      prev: segFromNow,
    }));
    statsHost.appendChild(MetricHeader({
      caption: isDay ? 'Всего' : 'В среднем',
      value: fmtGroup(isDay ? agg.total : agg.average),
      unit: 'мл', // как в Apple Health: «В СРЕДНЕМ 1 375 мл»; «в день» — в подсказке столбца
      range: win.range,
      nav: PeriodNavigator({ hasNext: win.hasNext, onPrev: () => shift(-1), onNext: () => shift(1) }),
    }));
    statsHost.appendChild(HealthBarChart({
      buckets: agg.buckets, scale, goal: isDay ? null : goal, goalLabel: `цель ${fmtGroup(goal)}`,
      yFormat: fmtGroup, tip, compact: win.kind === 'year', ariaLabel: `Вода, ${PERIOD_NAME[win.kind]}: ${win.range}`,
      emptyText: isDay ? 'В этот день записей нет' : 'Нет записей за период',
    }));
    if (isDay && log[win.start] && (log[win.start].entries || []).length === 0 && log[win.start].total > 0) {
      statsHost.appendChild(el('<p class="hstats__note">Итог дня без разбивки по времени — по часам не показан.</p>'));
    }
    goalStatsHost.innerHTML = '';
    goalStatsHost.appendChild(goalPeriodStats(log, goal, { dayKeys: win.dayKeys, label: PERIOD_NAME[win.kind], startDate: win.start, endDate: win.effEnd }));
  }
  /* приёмы дня по часам (фактическое время записи) */
  function waterByHour(d) {
    const out = new Array(24).fill(0);
    for (const e of ((statsData && statsData.log[d]) || {}).entries || []) {
      const hr = Number(String(e.t || '').slice(0, 2));
      if (Number.isInteger(hr) && hr >= 0 && hr < 24 && typeof e.ml === 'number') out[hr] += Math.max(0, e.ml);
    }
    return out;
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

  /* Выполнение цели за выбранный период: всего дней с целью (не обязательно подряд) и лучшая серия.
     Дни периода — те же range.dayKeys, по которым построены график и среднее. Диапазон уже
     показан над графиком (MetricHeader) — здесь не дублируется, только сами цифры периода.
     Пересчитывается из журнала при каждой отрисовке — после добавления, правки, переноса и удаления. */
  function goalPeriodStats(log, goal, rng) {
    const keys = rng.dayKeys;
    const g = waterGoalDays(log, goal, keys);
    const name = rng.label;
    const range = fmtDateRange(rng.startDate, rng.endDate);
    const box = el(`
      <div class="stat-row">
        <div class="stat stat--link" role="button" tabindex="0" aria-label="Цель выполнена, дней: ${g.count}. Показать даты"><div class="stat__num">${g.count}</div><div class="stat__label">цель выполнена, дней ›</div></div>
        <div class="stat"><div class="stat__num">${g.bestStreak}</div><div class="stat__label">лучшая серия цели, дней</div></div>
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

  /* Журнал приёмов за сегодня (с удалением) */
  function journal(entries, day) {
    const sec = el('<section class="section"><div class="section__head"><h2 class="section__title">Сегодня · приёмы</h2><button class="section__action" type="button" data-route="journals/water">Журнал ›</button></div><div class="list-card" id="jbox"></div></section>');
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
   Вкладка 3 — Лекарства: приёмы на сегодня (отметка — на каждый приём, не на препарат),
   история по дням. Форма — #/med/new, #/med/<id>/edit. Расписание и приёмы — services/meds.js.
   ========================================================= */
const MED_MORE_SVG = '<svg class="hi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>';
const hhmmOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function medDayWord(day, today) {
  const d = new Date(day + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  return d.toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\s*г\.$/, '');
}

/* Порядок карточек: приёмы сегодня (по первому времени) → «по необходимости» → не сегодня → не принимается */
function medRank(m, today) {
  if (medStatusOn(m, today) !== 'active') return [3, ''];
  if (medSchedule(m).mode === 'asNeeded') return [1, ''];
  if (!isMedDueOn(m, today)) return [2, ''];
  return [0, medSchedule(m).times[0] || '99:99'];
}

async function MedsScreen() {
  const screen = el('<div class="meds"></div>');
  const today = dateKey();
  let meds = [];
  let intakes = [];
  let legacyNames = [];

  const header = () => el(`<header class="header"><p class="header__eyebrow">${esc(fmtFull(new Date()))}</p><h1 class="header__title">Лекарства</h1></header>`);

  function summaryText() {
    const s = intakeSummary(meds, today, { intakes, legacyNames });
    if (!s.due) return 'Сегодня приёмов по расписанию нет';
    if (s.taken >= s.due) return `Сегодня всё принято · ${s.due} ${plural(s.due, 'приём', 'приёма', 'приёмов')}`;
    return `Сегодня принято ${s.taken} из ${s.due}`;
  }

  function renderSlot(m, x) {
    const at = x.takenAt ? hhmmOf(x.takenAt) : '';
    const state = x.taken ? (at ? `Принято${x.time ? '' : ' сегодня'} в ${at}` : 'Принято') : (x.time ? 'Не принято' : 'Принял сегодня');
    const li = el(`
      <li class="med-slot${x.taken ? ' is-taken' : ''}">
        <button class="med-slot__btn" type="button" aria-pressed="${x.taken}">
          ${x.time ? `<span class="med-slot__time">${esc(x.time)}</span>` : ''}
          <span class="med-slot__state">${esc(state)}${x.extra ? '<small> · вне расписания</small>' : ''}</span>
          <span class="med-slot__check" aria-hidden="true">${CHECK_SVG}</span>
        </button>
      </li>
    `);
    const btn = $('button', li);
    btn.setAttribute('aria-label', `${m.name}, ${x.time ? x.time : 'приём сегодня'}: ${x.taken ? 'принято' : 'не принято'}`);
    btn.dataset.slot = x.time || '';
    btn.addEventListener('click', () => toggle(m, x, btn));
    return li;
  }

  function offLine(m) {
    const st = medStatusOn(m, today);
    if (st === 'inactive') return 'Приём выключен';
    if (st === 'ended') return m.start ? `Курс ${fmtWhen(m.start, today)} – ${fmtWhen(m.end, today)} · ${endedCourseWord(m)}` : `Курс ${endedCourseWord(m)} ${fmtWhen(m.end, today)}`;
    const next = nextDueDay(m, today, 400);
    if (st === 'notStarted') return `Начало курса — ${medDayWord(m.start, today)}`;
    return next ? `Сегодня приёма нет · следующий — ${medDayWord(next, today)}` : 'Сегодня приёма нет';
  }

  function renderCard(m) {
    const slots = medDaySlots(m, today, { intakes, legacyNames });
    const s = medSchedule(m);
    const meta = [m.dose, scheduleLabel(m), m.purpose].filter(Boolean);
    if (!slots.length && s.times.length) meta.push(s.times.join(', '));
    const card = el(`
      <article class="med-card" data-id="${esc(m.id)}">
        <div class="med-card__head">
          <span class="med-card__icon" aria-hidden="true">${homeIcon('med')}</span>
          <div class="med-card__body">
            <h3 class="med-card__name"></h3>
            <p class="med-card__meta"></p>
          </div>
          <button class="med-card__more" type="button">${MED_MORE_SVG}</button>
        </div>
      </article>
    `);
    $('.med-card__name', card).textContent = m.name;
    $('.med-card__meta', card).textContent = meta.join(' · ');
    $('.med-card__more', card).setAttribute('aria-label', `Действия: ${m.name}`);
    if (m.note) {
      const note = el('<p class="med-card__note"></p>');
      note.textContent = m.note;
      $('.med-card__body', card).appendChild(note);
    }
    if (slots.length) {
      const ul = el('<ul class="med-slots"></ul>');
      slots.forEach((x) => ul.appendChild(renderSlot(m, x)));
      card.appendChild(ul);
    } else {
      const off = el('<p class="med-card__off"></p>');
      off.textContent = offLine(m);
      card.appendChild(off);
    }
    $('.med-card__more', card).addEventListener('click', () => medActions(m));
    return card;
  }

  async function toggle(m, x, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const first = medDaySlots(m, today, { intakes, legacyNames })[0];
    try {
      await Storage.setMedIntake({ medId: m.id, time: x.time, taken: !x.taken, day: today, name: m.name, legacyTime: first ? first.time : null });
    } catch {
      btn.disabled = false;
      flash('Не удалось сохранить отметку');
      return;
    }
    [intakes, legacyNames] = await Promise.all([Storage.getMedIntakes(today), Storage.getMedLog(today)]);
    /* перерисовать только эту карточку и сводку: прокрутка и фокус остаются на месте */
    const old = btn.closest('.med-card');
    const fresh = renderCard(m);
    old.replaceWith(fresh);
    const again = $$('.med-slot__btn', fresh).find((b) => b.dataset.slot === (x.time || ''));
    if (again) again.focus({ preventScroll: true });
    const sum = $('.med-sum', screen);
    if (sum) sum.textContent = summaryText();
    paintHistory();
  }

  async function medActions(m) {
    const act = await showDialog({
      title: m.name, stack: true, cancelValue: null,
      actions: [
        { label: 'Редактировать', value: 'edit' },
        { label: 'Удалить', value: 'delete', kind: 'destructive' },
        { label: 'Отмена', value: null },
      ],
    });
    if (act === 'edit') location.hash = `#/med/${encodeURIComponent(m.id)}/edit`;
    if (act !== 'delete') return;
    const ok = await showDialog({
      title: `Удалить ${m.name}?`,
      body: '<p class="dialog__muted">Лекарство исчезнет из списка. История приёма сохранится.</p>',
      actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try { await Storage.removeMed(m.id); } catch { flash('Не удалось удалить'); return; }
    flash('Удалено');
    await paint();
  }

  let historyOpen = false;
  let endedOpen = false;
  async function paintHistory() {
    const box = $('.med-history:not(.med-ended)', screen);
    if (!box) return;
    const [all, allIntakes, allLegacy] = await Promise.all([Storage.getMeds({ includeDeleted: true }), Storage.getAllMedIntakes(), Storage.getAllMedLog()]);
    const days = intakeHistory(all, allIntakes, allLegacy, { until: today, days: 14 });
    box.hidden = !days.length;
    const list = $('.med-history__list', box);
    list.innerHTML = '';
    days.forEach(({ day, items }) => {
      const row = el('<li class="med-history__day"><span class="med-history__date"></span><span class="med-history__items"></span></li>');
      const w = medDayWord(day, today);
      $('.med-history__date', row).textContent = w.charAt(0).toUpperCase() + w.slice(1);
      $('.med-history__items', row).textContent = items.map((it) => (it.time ? `${it.name} ${it.time}` : it.name)).join(' · ');
      list.appendChild(row);
    });
  }

  async function paint() {
    meds = await Storage.getMeds();
    if (meds.some((m) => m.id == null)) { await Storage.ensureMedIds(); meds = await Storage.getMeds(); }
    [intakes, legacyNames] = await Promise.all([Storage.getMedIntakes(today), Storage.getMedLog(today)]);
    screen.innerHTML = '';
    screen.appendChild(header());

    if (!meds.length) {
      const empty = el(`
        <section class="med-empty">
          <span class="med-empty__icon" aria-hidden="true">${homeIcon('med')}</span>
          <h2 class="med-empty__title">Лекарств пока нет</h2>
          <p class="med-empty__text">Добавьте препарат и укажите расписание приёма.</p>
          <button class="btn-primary btn-primary--brand med-empty__add" type="button">${homeIcon('plus')}<span>Добавить лекарство</span></button>
        </section>
      `);
      $('.med-empty__add', empty).addEventListener('click', () => { location.hash = '#/med/new'; });
      screen.appendChild(empty);
      screen.appendChild(el('<p class="med-hint">Здесь можно отмечать приём лекарств и видеть историю по дням.</p>'));
    } else {
      const head = el(`
        <div class="med-head">
          <p class="med-sum"></p>
          <button class="med-add" type="button" aria-label="Добавить лекарство">${homeIcon('plus')}<span>Добавить</span></button>
        </div>
      `);
      $('.med-sum', head).textContent = summaryText();
      $('.med-add', head).addEventListener('click', () => { location.hash = '#/med/new'; });
      screen.appendChild(head);
      const list = el('<div class="med-list"></div>');
      /* завершённые курсы (дата окончания прошла) — отдельным свёрнутым блоком, новые сверху */
      const ended = meds.filter((m) => medStatusOn(m, today) === 'ended').sort((a, b) => String(b.end).localeCompare(String(a.end)));
      meds.filter((m) => !ended.includes(m)).map((m, i) => ({ m, i, r: medRank(m, today) }))
        .sort((a, b) => a.r[0] - b.r[0] || a.r[1].localeCompare(b.r[1]) || a.i - b.i)
        .forEach(({ m }) => list.appendChild(renderCard(m)));
      screen.appendChild(list);
      if (ended.length) {
        const box = el(`
          <details class="med-history med-ended"${endedOpen ? ' open' : ''}>
            <summary class="med-history__head">Завершённые курсы <small>${ended.length}</small></summary>
            <div class="med-list"></div>
          </details>
        `);
        box.addEventListener('toggle', () => { endedOpen = box.open; });
        ended.forEach((m) => $('.med-list', box).appendChild(renderCard(m)));
        screen.appendChild(box);
      }
    }

    const hist = el(`
      <details class="med-history" hidden${historyOpen ? ' open' : ''}>
        <summary class="med-history__head">История приёма <small>14 дней</small></summary>
        <ul class="med-history__list"></ul>
      </details>
    `);
    hist.addEventListener('toggle', () => { historyOpen = hist.open; });
    screen.appendChild(hist);
    await paintHistory();
  }
  await paint();
  return screen;
}

/* Форма лекарства: название (обязательно), дозировка, режим приёма, дни, времена, комментарий */
async function MedFormScreen(id) {
  const existing = id ? await Storage.getMed(id) : null;
  const screen = el('<div class="med-form"></div>');
  const leave = () => goBack('meds');
  screen.appendChild(backHeader(id ? 'Редактировать' : 'Новое лекарство', { onBack: leave }));
  if (id && !existing) {
    screen.appendChild(el('<div class="empty">Лекарство не найдено</div>'));
    return screen;
  }
  const sched = existing ? medSchedule(existing) : { mode: 'daily', days: [], times: [] };
  const state = { mode: sched.mode, days: new Set(sched.days), times: sched.times.slice() };
  const MODES = [['daily', 'Каждый день'], ['days', 'По выбранным дням'], ['asNeeded', 'По необходимости']];

  const form = el(`
    <form class="med-form__form" novalidate>
      <div class="input-card">
        <div class="field">
          <label class="field__label" for="mf-name">Название препарата</label>
          <input class="input" id="mf-name" type="text" maxlength="${MED_NAME_MAX}" autocomplete="off" autocapitalize="sentences"
            placeholder="Например, Витамин D" aria-required="true" aria-describedby="mf-name-err" enterkeyhint="next">
          <p class="med-form__err" id="mf-name-err" role="alert" hidden></p>
        </div>
        <div class="field med-form__last">
          <label class="field__label" for="mf-dose">Дозировка <span class="med-form__opt">· необязательно</span></label>
          <input class="input" id="mf-dose" type="text" maxlength="${MED_DOSE_MAX}" autocomplete="off" placeholder="Например, 10 мг или 1 таблетка" enterkeyhint="done">
        </div>
      </div>

      <div class="input-card">
        <fieldset class="med-form__set">
          <legend class="field__label">Режим приёма</legend>
          <div class="med-modes">
            ${MODES.map(([v, t]) => `<label class="med-mode"><input type="radio" name="mf-mode" value="${v}"${state.mode === v ? ' checked' : ''}><span class="med-mode__dot" aria-hidden="true"></span><span>${t}</span></label>`).join('')}
          </div>
        </fieldset>
        <fieldset class="med-form__set" data-part="days">
          <legend class="field__label">Дни приёма</legend>
          <div class="med-days" aria-describedby="mf-days-err">
            ${WEEKDAYS.map((w) => `<button class="med-day" type="button" data-day="${w.day}" aria-pressed="${state.days.has(w.day)}" aria-label="${w.name}">${w.short}</button>`).join('')}
          </div>
          <p class="med-form__err" id="mf-days-err" role="alert" hidden></p>
        </fieldset>
        <fieldset class="med-form__set med-form__last" data-part="times">
          <legend class="field__label">Время приёма</legend>
          <div class="med-times"></div>
          <button class="med-times__add" type="button">${homeIcon('plus')}<span>Добавить время</span></button>
          <p class="med-form__hint" data-part="times-hint">Без времени — одна отметка в день.</p>
        </fieldset>
        ${existing && existing.every_days && existing.start ? `<p class="med-form__hint">Курс «раз в ${esc(existing.every_days)} дн.» с ${esc(fmtDate(existing.start))} сохраняется: приёмы — только в дни курса.</p>` : ''}
      </div>

      <div class="input-card">
        <div class="field med-form__last">
          <label class="field__label" for="mf-note">Комментарий <span class="med-form__opt">· необязательно</span></label>
          <input class="input" id="mf-note" type="text" maxlength="${MED_NOTE_MAX}" autocomplete="off" placeholder="Например, после еды" enterkeyhint="done">
        </div>
      </div>

      <div class="med-form__actions">
        <button class="btn-primary btn-primary--brand" type="submit">Сохранить</button>
        <button class="btn-ghost med-form__cancel" type="button">Отмена</button>
      </div>
    </form>
  `);
  const nameIn = $('#mf-name', form);
  nameIn.value = existing ? existing.name || '' : '';
  $('#mf-dose', form).value = existing ? existing.dose || '' : '';
  $('#mf-note', form).value = existing ? existing.note || '' : '';
  const timesBox = $('.med-times', form);
  const nameErr = $('#mf-name-err', form);
  const daysErr = $('#mf-days-err', form);

  const syncTimes = () => { state.times = $$('.med-time__input', timesBox).map((i) => i.value).filter(Boolean); };
  function paintTimes() {
    timesBox.innerHTML = '';
    state.times.forEach((t, i) => {
      const row = el(`
        <div class="med-time">
          <label class="sr-only" for="mf-t${i}">Время приёма ${i + 1}</label>
          <input class="input med-time__input" type="time" id="mf-t${i}" value="${esc(t)}">
          <button class="med-time__del" type="button" aria-label="Удалить время ${esc(t)}">×</button>
        </div>
      `);
      $('.med-time__del', row).addEventListener('click', () => { syncTimes(); state.times.splice(i, 1); paintTimes(); $('.med-times__add', form).focus(); });
      timesBox.appendChild(row);
    });
    $('.med-times__add', form).hidden = state.times.length >= MED_TIMES_MAX;
    $('[data-part="times-hint"]', form).hidden = state.times.length > 0;
  }
  function paintMode() {
    $('[data-part="days"]', form).hidden = state.mode !== 'days';
    $('[data-part="times"]', form).hidden = state.mode === 'asNeeded';
  }
  $$('input[name="mf-mode"]', form).forEach((r) => r.addEventListener('change', () => { state.mode = r.value; daysErr.hidden = true; paintMode(); }));
  $$('.med-day', form).forEach((b) => b.addEventListener('click', () => {
    const d = Number(b.dataset.day);
    if (state.days.has(d)) state.days.delete(d); else state.days.add(d);
    b.setAttribute('aria-pressed', String(state.days.has(d)));
    if (state.days.size) daysErr.hidden = true;
  }));
  $('.med-times__add', form).addEventListener('click', () => {
    syncTimes();
    const next = ['08:00', '20:00', '14:00', '12:00', '22:00', '10:00', '18:00', '16:00'].find((t) => !state.times.includes(t)) || '12:00';
    state.times.push(next);
    paintTimes();
    const inputs = $$('.med-time__input', timesBox);
    inputs[inputs.length - 1].focus();
  });
  nameIn.addEventListener('input', () => { if (nameIn.value.trim()) { nameErr.hidden = true; nameIn.removeAttribute('aria-invalid'); } });
  $('.med-form__cancel', form).addEventListener('click', leave);

  let saving = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    syncTimes();
    const r = normalizeMedInput({
      name: nameIn.value, dose: $('#mf-dose', form).value, note: $('#mf-note', form).value,
      mode: state.mode, days: [...state.days], times: state.times,
    });
    nameErr.hidden = !r.errors.name;
    nameErr.textContent = r.errors.name || '';
    if (r.errors.name) nameIn.setAttribute('aria-invalid', 'true'); else nameIn.removeAttribute('aria-invalid');
    daysErr.hidden = !r.errors.days;
    daysErr.textContent = r.errors.days || '';
    if (!r.ok) {
      (r.errors.name ? nameIn : $('.med-day', form)).focus();
      return;
    }
    saving = true;
    const btn = $('button[type="submit"]', form);
    btn.classList.add('is-busy');
    try {
      if (id) await Storage.updateMed(id, r.value);
      else await Storage.addMed(r.value);
    } catch {
      saving = false;
      btn.classList.remove('is-busy');
      flash('Не удалось сохранить');
      return;
    }
    flash('Сохранено ✓');
    goBackTo('meds');
  });

  screen.appendChild(form);
  paintTimes();
  paintMode();
  return screen;
}

/* =========================================================
   Сон (#/sleep): последний сон · аналитика за неделю/месяц/год · история по месяцам.
   Запись — #/sleep/new (#/sleep/new/<дата>), #/sleep/<id>; настройки — #/sleep/settings.
   Модель и расчёты — services/sleep.js, хранение — Storage (sleep_log, sleep_settings).
   ========================================================= */
/* выбранный период аналитики и месяц истории живут, пока открыт LexLife (возврат из формы — туда же) */
const sleepUi = { kind: 'month', anchor: null, histMonth: null };
/* черновик формы: возврат в приложение (visibilitychange → render) не теряет введённое */
let sleepDraft = null;

const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sleepTimes = (e) => `${stampTime(e.sleepStart)} → ${stampTime(e.sleepEnd)}`;
const awakeningsText = (n) => (n ? `${n} ${plural(n, 'пробуждение', 'пробуждения', 'пробуждений')}` : 'без пробуждений');
function sleepDayMonth(iso, today = dateKey()) {
  const d = new Date(`${iso}T00:00:00`);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString(RU, sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
}
function sleepDayWord(iso, today = dateKey()) {
  if (iso === today) return 'Сегодня';
  if (iso === sleepAddDays(today, -1)) return 'Вчера';
  return capFirst(sleepDayMonth(iso, today));
}
/* мелкая строка карточки: пробуждения · дневной сон */
function sleepMeta(e) {
  const parts = [];
  if (e.awakenings != null) parts.push(awakeningsText(e.awakenings));
  const nap = napMinutes(e);
  if (nap) parts.push(`Дневной сон: ${formatSleepDuration(nap)}`);
  return parts.join(' · ');
}
const SLEEP_MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const SLEEP_WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const SLEEP_KINDS = [['week', 'Неделя'], ['month', 'Месяц'], ['year', 'Год']];
const SLEEP_PREV = { week: 'прошлой неделей', month: 'прошлым месяцем', year: 'прошлым годом' };
const monthTitleOf = (ym) => { const [y, m] = ym.split('-').map(Number); return capFirst(new Date(y, m - 1, 1).toLocaleDateString(RU, { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '')); };
function sleepPeriodTitle(b) {
  if (b.kind === 'year') return b.start.slice(0, 4);
  if (b.kind === 'month') return monthTitleOf(b.start.slice(0, 7));
  const f = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(RU, { day: 'numeric', month: 'short' });
  return `${f(b.start)} – ${f(b.end)}`;
}
/* время суток → часы от полудня (ось графика режима: вечер и ночь идут подряд, без разрыва в полночь) */
const clockHoursFromNoon = (hhmm) => (((Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) - 720) + 1440) % 1440) / 60;
const hoursFromNoonClock = (h) => minutesToClock(h * 60 + 720);

async function SleepScreen() {
  const screen = el('<div class="sleep"></div>');
  const today = dateKey();
  const [entries, settings] = await Promise.all([Storage.getSleepEntries(), Storage.getSleepSettings()]);
  const goal = settings.goalMinutes;
  if (!sleepUi.anchor || sleepUi.anchor > today) sleepUi.anchor = today;
  if (!sleepUi.histMonth || sleepUi.histMonth > today.slice(0, 7)) sleepUi.histMonth = today.slice(0, 7);

  const header = el(`
    <header class="header header--nav sleep-header">
      <div class="sleep-header__row">
        <h1 class="header__title">Сон</h1>
        <a class="sleep-gear" href="#/sleep/settings" aria-label="Настройки сна">${homeIcon('sliders')}</a>
      </div>
    </header>
  `);
  header.prepend(BackButton({ fallback: 'home' }));
  screen.appendChild(header);

  if (!entries.length) {
    const empty = el(`
      <section class="med-empty sleep-empty">
        <span class="med-empty__icon sleep-empty__icon" aria-hidden="true">${homeIcon('sleep')}</span>
        <h2 class="med-empty__title">Здесь появится история вашего сна</h2>
        <p class="med-empty__text">Добавьте первую запись, чтобы LexLife начал строить аналитику.</p>
        <a class="btn-primary btn-primary--brand med-empty__add sleep-cta" href="#/sleep/new">${homeIcon('plus')}<span>Добавить сон</span></a>
      </section>
    `);
    screen.appendChild(empty);
    return screen;
  }

  screen.appendChild(sleepLastCard(entries, goal, today));
  const analytics = el('<section class="section sleep-analytics" aria-labelledby="sl-an-title"></section>');
  const history = el('<section class="section sleep-history" aria-labelledby="sl-hist-title"></section>');
  screen.append(analytics, history);

  function paintAnalytics() {
    analytics.innerHTML = '';
    const b = periodBounds(sleepUi.kind, sleepUi.anchor);
    const next = shiftPeriod(b, 1);
    analytics.appendChild(el('<div class="section__head"><h2 class="section__title" id="sl-an-title">Аналитика</h2></div>'));
    const seg = el(`<div class="st-period" role="group" aria-label="Период аналитики">${SLEEP_KINDS.map(([k, t]) => `<button class="st-period__btn${k === sleepUi.kind ? ' is-active' : ''}" type="button" data-k="${k}" aria-pressed="${k === sleepUi.kind}">${t}</button>`).join('')}</div>`);
    seg.addEventListener('click', (e) => { const x = e.target.closest('[data-k]'); if (x && x.dataset.k !== sleepUi.kind) { sleepUi.kind = x.dataset.k; sleepUi.anchor = today; paintAnalytics(); } });
    const nav = el(`
      <div class="sleep-nav">
        <button class="cal-nav__btn sleep-nav__btn" type="button" data-d="-1" aria-label="Предыдущий период">‹</button>
        <span class="sleep-nav__title" aria-live="polite">${esc(sleepPeriodTitle(b))}</span>
        <button class="cal-nav__btn sleep-nav__btn" type="button" data-d="1" aria-label="Следующий период"${next.start > today ? ' disabled' : ''}>›</button>
      </div>
    `);
    nav.addEventListener('click', (e) => {
      const x = e.target.closest('[data-d]');
      if (!x || x.disabled) return;
      sleepUi.anchor = shiftPeriod(b, Number(x.dataset.d)).start;
      paintAnalytics();
    });
    analytics.append(seg, nav);

    const cur = entriesInRange(entries, b.start, b.end);
    if (cur.length < 2) {
      analytics.appendChild(el(`
        <div class="card st-empty sleep-wait">
          <p class="st-empty__title">${cur.length ? 'Нужно несколько дней данных, чтобы показать тенденции' : 'За этот период записей нет'}</p>
          <p class="st-empty__sub">${cur.length ? `Пока одна запись: ${esc(sleepDayMonth(cur[0].date, today))} · ${esc(formatSleepDuration(cur[0].durationMinutes))}. Графики появятся со второй.` : 'Выберите другой период или добавьте запись сна.'}</p>
        </div>
      `));
      return;
    }
    const prev = shiftPeriod(b, -1);
    analytics.appendChild(durationCard(b, cur, entriesInRange(entries, prev.start, prev.end)));
    analytics.appendChild(regimeCard(b, cur));
    analytics.appendChild(qualityCard(b, cur));
    const nap = napCard(cur);
    if (nap) analytics.appendChild(nap);
    const ins = insightsCard(entries);
    if (ins) analytics.appendChild(ins);
  }

  /* 1. Продолжительность: средний сон, сравнение, столбцы по дням / месяцам, цель и серии */
  function durationCard(b, cur, prevList) {
    const avg = averageSleep(cur);
    const cmp = comparePeriods(cur, prevList);
    const card = el(`
      <div class="card st-card sleep-card">
        <p class="sleep-kpi__label">Средний сон</p>
        <p class="sleep-kpi__val">${esc(formatSleepDuration(avg))}</p>
        ${cmp ? `<p class="sleep-kpi__sub">${esc(formatSleepDelta(cmp.delta))} по сравнению с ${SLEEP_PREV[b.kind]}</p>` : ''}
      </div>
    `);
    const range = { start: dayNum(b.start), end: dayNum(b.end) };
    let bars, xLabels;
    if (b.kind === 'year') {
      bars = aggregateByYear(entries, b.start).map((m) => ({ start: dayNum(m.start), end: dayNum(m.end), value: m.minutes == null ? null : m.minutes / 60, month: m }));
      xLabels = bars.map((x, i) => ({ day: x.start + 14, label: SLEEP_MONTHS[i] }));
    } else {
      const slots = b.kind === 'week' ? aggregateByWeek(entries, b.start) : aggregateByMonth(entries, b.start);
      bars = slots.map((s) => ({ start: dayNum(s.date), end: dayNum(s.date), value: s.minutes == null ? null : s.minutes / 60, slot: s }));
      xLabels = b.kind === 'week'
        ? slots.map((s, i) => ({ day: dayNum(s.date), label: SLEEP_WD[i] }))
        : slots.filter((s) => [1, 5, 10, 15, 20, 25, 30].includes(Number(s.date.slice(8)))).map((s) => ({ day: dayNum(s.date), label: String(Number(s.date.slice(8))) }));
    }
    const metOf = (v) => v != null && v * 60 >= goal;
    card.appendChild(svgBarChart({
      range, bars, fit: false, xLabels,
      goal: { value: goal / 60, label: `цель ${formatSleepDuration(goal)}` },
      minSpan: 2,
      yFormat: (v) => `${fmtN(v)} ч`,
      barColor: (x) => (metOf(x.value) ? 'var(--viz-1)' : 'var(--sleep-below)'),
      legendExtra: '<span class="chart__key"><i class="chart__swatch sleep-swatch"></i>цель выполнена</span><span class="chart__key"><i class="chart__swatch sleep-swatch sleep-swatch--below"></i>меньше цели</span>',
      ariaLabel: `Продолжительность сна, ${sleepPeriodTitle(b)}: в среднем ${formatSleepDuration(avg)}, цель ${formatSleepDuration(goal)}. Выберите столбец, чтобы увидеть значение.`,
      readout: (x) => {
        if (x.month) {
          const name = capFirst(new Date(`${x.month.start}T00:00:00`).toLocaleDateString(RU, { month: 'long' }));
          if (x.value == null) return `<span class="chart__rv chart__rv--muted">нет записей</span><span class="chart__rd">${esc(name)}</span>`;
          return `<span class="chart__rv">${esc(formatSleepDuration(x.month.minutes))} <small>в среднем</small></span><span class="chart__rd">${esc(name)} · ${x.month.count} ${plural(x.month.count, 'запись', 'записи', 'записей')}</span>`;
        }
        const s = x.slot;
        const day = capFirst(new Date(`${s.date}T00:00:00`).toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'short' }));
        if (!s.entry) return `<span class="chart__rv chart__rv--muted">нет записи</span><span class="chart__rd">${esc(day)}</span>`;
        const diff = s.minutes - goal;
        const st = diff >= 0 ? 'цель выполнена' : `на ${formatSleepDuration(-diff)} меньше цели`;
        return `<span class="chart__rv">${esc(formatSleepDuration(s.minutes))}</span><span class="chart__rd">${esc(day)} · ${esc(sleepTimes(s.entry))} · ${esc(st)}</span>`;
      },
    }));
    const rate = sleepGoalRate(cur, goal);
    const cs = currentSleepStreak(entries, goal, today);
    const bs = bestSleepStreak(entries, goal);
    card.appendChild(el(`
      <div class="sgrid sleep-grid">
        <div class="sgrid__item"><div class="sgrid__label">Цель сна выполнена</div><div class="sgrid__val">${rate.rate == null ? '—' : `${Math.round(rate.rate * 100)}%`}</div><div class="sgrid__sub">${rate.met} из ${rate.total} ${plural(rate.total, 'дня', 'дней', 'дней')} с записью</div></div>
        <div class="sgrid__item"><div class="sgrid__label">Цель</div><div class="sgrid__val">${esc(formatSleepDuration(goal))}</div><div class="sgrid__sub"><a href="#/sleep/settings">изменить</a></div></div>
        <div class="sgrid__item"><div class="sgrid__label">Текущая серия</div><div class="sgrid__val">${cs} ${daysWord(cs)}</div><div class="sgrid__sub">подряд с целью</div></div>
        <div class="sgrid__item"><div class="sgrid__label">Лучшая серия</div><div class="sgrid__val">${bs} ${daysWord(bs)}</div><div class="sgrid__sub">за всё время</div></div>
      </div>
    `));
    card.appendChild(el('<p class="st-note">День без записи не считается ни выполненным, ни пропущенным: проценты и средние — только по записанным ночам. Серия — ночной сон не меньше цели подряд по сегодня (пока сегодня не записано — по вчера).</p>'));
    return card;
  }

  /* 2. Режим сна: обычное время, стабильность, график времени отхода ко сну и подъёма */
  function regimeCard(b, cur) {
    const bed = averageBedtime(cur), wake = averageWakeTime(cur);
    const cons = sleepConsistency(cur);
    const card = el(`
      <div class="card st-card sleep-card">
        <h3 class="sleep-card__title">Режим сна</h3>
        <div class="sleep-regime">
          <div><p class="sleep-kpi__label">Обычно ложитесь</p><p class="sleep-kpi__val sleep-kpi__val--sm">${bed == null ? '—' : minutesToClock(bed)}</p></div>
          <div><p class="sleep-kpi__label">Обычно просыпаетесь</p><p class="sleep-kpi__val sleep-kpi__val--sm">${wake == null ? '—' : minutesToClock(wake)}</p></div>
        </div>
        <div class="sleep-cons">
          <div class="sleep-cons__head">
            <span class="sleep-kpi__label">Стабильность режима</span>
            <button class="sleep-info" type="button" aria-label="Что такое стабильность режима">?</button>
            <b class="sleep-cons__val">${cons == null ? '—' : `${cons}%`}</b>
          </div>
          ${cons == null ? '<p class="sleep-kpi__sub">Нужно не меньше 3 записей за период.</p>' : `<div class="sleep-bar" role="progressbar" aria-label="Стабильность режима" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${cons}"><span style="width:${cons}%"></span></div>`}
        </div>
      </div>
    `);
    $('.sleep-info', card).addEventListener('click', () => showDialog({
      title: 'Стабильность режима',
      body: `<p>Показывает, насколько одинаковым было время сна и пробуждения в выбранный период.</p><p class="dialog__muted">Считается среднее отклонение времени отхода ко сну и подъёма от обычного для вас времени (по кругу суток, без скачка в полночь): 0 минут — 100%, 2 часа и больше — 0%. Это не медицинский показатель.</p>`,
      actions: [{ label: 'Понятно', value: true, kind: 'primary' }],
    }));
    const bedPts = cur.map((e) => ({ day: dayNum(e.date), value: clockHoursFromNoon(stampTime(e.sleepStart)), e }));
    const wakePts = cur.map((e) => ({ day: dayNum(e.date), value: clockHoursFromNoon(stampTime(e.sleepEnd)), e }));
    card.appendChild(lineChart({
      range: { start: dayNum(b.start), end: dayNum(b.end) }, fit: false,
      xLabels: b.kind === 'year' ? SLEEP_MONTHS.map((m, i) => ({ day: dayNum(`${b.start.slice(0, 4)}-${String(i + 1).padStart(2, '0')}-15`), label: m })) : null,
      series: [
        { key: 'bed', label: 'отход ко сну', color: 'var(--viz-1)', points: bedPts },
        { key: 'wake', label: 'подъём', color: 'var(--viz-2)', points: wakePts },
      ],
      goals: [{ value: clockHoursFromNoon(settings.bedtime), label: settings.bedtime }, { value: clockHoursFromNoon(settings.wakeTime), label: settings.wakeTime }],
      goalLegend: `желаемое время ${settings.bedtime} и ${settings.wakeTime}`,
      minSpan: 2,
      yStep: (() => { const v = [...bedPts, ...wakePts].map((p) => p.value); return Math.max(...v) - Math.min(...v) > 10 ? 4 : 2; })(),
      yFormat: (v) => hoursFromNoonClock(v),
      ariaLabel: `Время отхода ко сну и подъёма, ${sleepPeriodTitle(b)}: обычно ${bed == null ? '—' : minutesToClock(bed)} и ${wake == null ? '—' : minutesToClock(wake)}`,
      readout: (day) => {
        const p = bedPts.find((q) => q.day === day);
        const d = capFirst(new Date(`${p.e.date}T00:00:00`).toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'short' }));
        return `<span class="chart__rv">${esc(sleepTimes(p.e))}</span><span class="chart__rd">${esc(d)} · легли → проснулись</span>`;
      },
    }));
    return card;
  }

  /* 3. Качество: среднее и динамика (год — средние по месяцам) */
  function qualityCard(b, cur) {
    const avg = averageQuality(cur);
    const rated = cur.filter((e) => e.quality != null);
    const card = el(`
      <div class="card st-card sleep-card">
        <h3 class="sleep-card__title">Качество сна</h3>
        <p class="sleep-kpi__label">Среднее качество</p>
        <p class="sleep-kpi__val">${avg == null ? '—' : `${fmtN(avg, 1)} <small>/ 5</small>`}</p>
        <p class="sleep-kpi__sub">${rated.length ? `по ${rated.length} ${plural(rated.length, 'оценённой ночи', 'оценённым ночам', 'оценённым ночам')}` : 'В этом периоде нет оценок качества.'}</p>
      </div>
    `);
    let pts;
    if (b.kind === 'year') {
      pts = aggregateByYear(entries, b.start).filter((m) => m.quality != null).map((m) => ({ day: dayNum(m.start) + 14, value: m.quality, label: capFirst(new Date(`${m.start}T00:00:00`).toLocaleDateString(RU, { month: 'long' })), month: true }));
    } else {
      pts = rated.map((e) => ({ day: dayNum(e.date), value: e.quality, label: capFirst(new Date(`${e.date}T00:00:00`).toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'short' })) }));
    }
    if (pts.length >= 2) {
      card.appendChild(lineChart({
        range: { start: dayNum(b.start), end: dayNum(b.end) }, fit: false,
        xLabels: b.kind === 'year' ? SLEEP_MONTHS.map((m, i) => ({ day: dayNum(`${b.start.slice(0, 4)}-${String(i + 1).padStart(2, '0')}-15`), label: m })) : null,
        series: [{ key: 'q', label: 'качество', color: 'var(--viz-1)', points: pts }],
        domain: { lo: 1, hi: 5 }, minSpan: 4,
        yFormat: (v) => (Number.isInteger(v) ? String(v) : ''),
        ariaLabel: `Качество сна по шкале 1–5, ${sleepPeriodTitle(b)}: в среднем ${avg == null ? '—' : fmtN(avg, 1)}`,
        readout: (day) => {
          const p = pts.find((q) => q.day === day);
          const qi = qualityInfo(Math.round(p.value));
          return `<span class="chart__rv">${p.month ? `${esc(fmtN(p.value, 1))} <small>/ 5 в среднем</small>` : `${qi ? `${qi.emoji} ` : ''}${esc(qi ? qi.label : '')}`}</span><span class="chart__rd">${esc(p.label)}</span>`;
        },
      }));
    }
    return card;
  }

  /* 4. Дневной сон — отдельно от ночного; общий сон за сутки — с подписью */
  function napCard(cur) {
    const withNap = cur.filter((e) => napMinutes(e) > 0);
    if (!withNap.length) return null;
    const avgNap = Math.round(withNap.reduce((s, e) => s + napMinutes(e), 0) / withNap.length);
    const total = Math.round(cur.reduce((s, e) => s + totalDayMinutes(e), 0) / cur.length);
    return el(`
      <div class="card st-card sleep-card">
        <h3 class="sleep-card__title">Дневной сон</h3>
        <div class="sgrid sleep-grid">
          <div class="sgrid__item"><div class="sgrid__label">Дней с дневным сном</div><div class="sgrid__val">${withNap.length}</div><div class="sgrid__sub">в среднем ${esc(formatSleepDuration(avgNap))}</div></div>
          <div class="sgrid__item"><div class="sgrid__label">Общий сон за сутки</div><div class="sgrid__val">${esc(formatSleepDuration(total))}</div><div class="sgrid__sub">ночной + дневной, в среднем</div></div>
        </div>
        <p class="st-note">Средний сон, цель и серии считаются только по ночному сну.</p>
      </div>
    `);
  }

  /* 5. Что связано с вашим сном — по всем записям, только простые наблюдения */
  function insightsCard(all) {
    const list = factorInsights(all);
    const anyTags = all.some((e) => Array.isArray(e.tags) && e.tags.length);
    if (!list.length && !anyTags) return null;
    const card = el(`
      <div class="card st-card sleep-card">
        <h3 class="sleep-card__title">Что связано с вашим сном</h3>
        ${list.length ? `<ul class="sleep-insights">${list.slice(0, 5).map((x) => `<li><span aria-hidden="true">${tagInfo(x.key).emoji}</span><span>${esc(insightText(x))}</span></li>`).join('')}</ul>` : ''}
        <p class="st-note">${list.length ? 'Это наблюдения по вашим записям за всё время, а не медицинские выводы: совпадение не означает причину.' : `Наблюдения появятся, когда будет не меньше ${INSIGHT_MIN_DAYS} дней с фактором и ${INSIGHT_MIN_DAYS} без него.`}</p>
      </div>
    `);
    return card;
  }

  /* История: месяц, новые сверху; карточка → запись */
  function paintHistory() {
    history.innerHTML = '';
    const curMonth = today.slice(0, 7);
    const ym = sleepUi.histMonth;
    const [y, m] = ym.split('-').map(Number);
    const shift = (d) => { const x = new Date(y, m - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
    const head = el(`
      <div class="section__head sleep-history__head">
        <h2 class="section__title" id="sl-hist-title">История</h2>
        <span class="sleep-history__acts"><a class="section__action sleep-journal" href="#/journals/sleep">Журнал ›</a><a class="med-add" href="#/sleep/new" aria-label="Добавить запись сна">${homeIcon('plus')}<span>Добавить</span></a></span>
      </div>
    `);
    const nav = el(`
      <div class="sleep-nav">
        <button class="cal-nav__btn sleep-nav__btn" type="button" data-d="-1" aria-label="Предыдущий месяц">‹</button>
        <span class="sleep-nav__title" aria-live="polite">${esc(monthTitleOf(ym))}</span>
        ${ym < curMonth ? '<button class="sleep-today" type="button" data-today>Сегодня</button>' : ''}
        <button class="cal-nav__btn sleep-nav__btn" type="button" data-d="1" aria-label="Следующий месяц"${ym >= curMonth ? ' disabled' : ''}>›</button>
      </div>
    `);
    nav.addEventListener('click', (e) => {
      const x = e.target.closest('button');
      if (!x || x.disabled) return;
      sleepUi.histMonth = x.hasAttribute('data-today') ? curMonth : shift(Number(x.dataset.d));
      paintHistory();
    });
    history.append(head, nav);
    const list = entries.filter((e) => e.date.startsWith(`${ym}-`));
    if (!list.length) { history.appendChild(el('<div class="list-card"><div class="empty">В этом месяце записей сна нет.</div></div>')); return; }
    const box = el('<div class="list-card sleep-list"></div>');
    list.forEach((e) => {
      const q = qualityInfo(e.quality);
      const meta = sleepMeta(e);
      const row = el(`
        <a class="row sleep-row" href="#/sleep/${encodeURIComponent(e.id)}">
          <div class="row__body">
            <p class="sleep-row__date"></p>
            <p class="sleep-row__main"><b class="sleep-row__dur"></b><span class="sleep-row__times"></span></p>
            ${meta ? '<p class="sleep-row__meta"></p>' : ''}
          </div>
          ${q ? `<span class="sleep-row__q"><span aria-hidden="true">${q.emoji}</span> ${esc(q.label)}</span>` : ''}
          <span class="row__chevron" aria-hidden="true">›</span>
        </a>
      `);
      const wd = new Date(`${e.date}T00:00:00`).toLocaleDateString(RU, { weekday: 'short' });
      $('.sleep-row__date', row).textContent = `${capFirst(sleepDayMonth(e.date, today))} · ${wd}`;
      $('.sleep-row__dur', row).textContent = formatSleepDuration(e.durationMinutes);
      $('.sleep-row__times', row).textContent = sleepTimes(e);
      if (meta) $('.sleep-row__meta', row).textContent = meta;
      row.setAttribute('aria-label', `${sleepDayMonth(e.date, today)}: ${formatSleepDuration(e.durationMinutes)}, ${sleepTimes(e)}${q ? `, ${q.label}` : ''}${meta ? `, ${meta}` : ''}. Открыть запись`);
      box.appendChild(row);
    });
    history.appendChild(box);
  }

  paintAnalytics();
  paintHistory();
  return screen;
}

/* Карточка «Последний сон»: сегодня записан — итог дня; нет — приглашение записать */
function sleepLastCard(entries, goal, today) {
  const e = getSleepForDate(entries, today);
  if (!e) {
    const last = entries[0];
    const card = el(`
      <section class="card sleep-last sleep-last--none" aria-label="Сон сегодня">
        <p class="sleep-last__when">Сегодня</p>
        <p class="sleep-last__title">Сегодня сон ещё не записан</p>
        <a class="btn-primary btn-primary--brand sleep-cta" href="#/sleep/new">${homeIcon('plus')}<span>Добавить сон</span></a>
        ${last ? `<a class="sleep-last__prev" href="#/sleep/${encodeURIComponent(last.id)}"><span>Последняя запись · ${esc(sleepDayWord(last.date, today).toLowerCase())}: <b>${esc(formatSleepDuration(last.durationMinutes))}</b></span>${homeIcon('chevron', 'sleep-last__chev')}</a>` : ''}
      </section>
    `);
    return card;
  }
  const q = qualityInfo(e.quality);
  const pct = Math.round((e.durationMinutes / goal) * 100);
  const met = e.durationMinutes >= goal;
  const meta = sleepMeta(e);
  const card = el(`
    <a class="card sleep-last" href="#/sleep/${encodeURIComponent(e.id)}">
      <p class="sleep-last__when">Сегодня</p>
      <p class="sleep-last__dur">${esc(formatSleepDuration(e.durationMinutes))}</p>
      <p class="sleep-last__times">${esc(sleepTimes(e))}</p>
      ${q ? `<p class="sleep-last__q"><span aria-hidden="true">${q.emoji}</span> ${esc(q.sleep)}</p>` : ''}
      <div class="sleep-bar" role="progressbar" aria-label="Сон от цели" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(pct, 100)}"><span style="width:${Math.min(pct, 100)}%"></span></div>
      <p class="sleep-last__goal">${met ? `${homeIcon('check', 'sleep-last__ok')}Цель выполнена` : `${pct}% от цели`} · цель ${esc(formatSleepDuration(goal))}</p>
      ${meta ? `<p class="sleep-last__meta">${esc(meta)}</p>` : ''}
    </a>
  `);
  card.setAttribute('aria-label', `Сон сегодня: ${formatSleepDuration(e.durationMinutes)}, ${sleepTimes(e)}${q ? `, ${q.sleep.toLowerCase()}` : ''}, ${met ? 'цель выполнена' : `${pct}% от цели`}. Открыть запись`);
  return card;
}

/* Форма записи сна: новая (#/sleep/new[/<дата пробуждения>]) или правка (#/sleep/<id>) */
async function SleepFormScreen(id, presetDate = null) {
  const today = dateKey();
  const [existing, settings] = await Promise.all([id ? Storage.getSleepEntry(id) : null, Storage.getSleepSettings()]);
  const screen = el('<div class="med-form sleep-form"></div>');
  const route = location.hash;
  /* открыта из журнала сна, «Всех журналов» или Главной — после сохранения / удаления возвращается
     туда же (тот же фильтр и прокрутка — из записи истории), иначе — в «Сон» */
  const from = prevRoute() || '';
  const backTo = /^#\/(?:sleep-log|journals)(?:\/|$)|^#\/home$/.test(from) ? from.slice(2) : 'sleep';
  const leave = () => { sleepDraft = null; goBack(backTo); };
  screen.appendChild(backHeader(id ? 'Запись сна' : 'Новая запись сна', { onBack: leave }));
  if (id && !existing) {
    screen.appendChild(el('<div class="empty">Запись сна не найдена — возможно, она удалена.</div>'));
    return screen;
  }
  const wake0 = presetDate && /^\d{4}-\d{2}-\d{2}$/.test(presetDate) && presetDate <= today ? presetDate : today;
  let st = existing ? {
    bedDate: stampDay(existing.sleepStart), bedTime: stampTime(existing.sleepStart),
    wakeDate: existing.date, wakeTime: stampTime(existing.sleepEnd),
    quality: existing.quality ?? null, awakenings: existing.awakenings ?? 0,
    napEnabled: napMinutes(existing) > 0, napMinutes: napMinutes(existing) || 30,
    tags: new Set(existing.tags || []), note: existing.note || '', bedManual: true,
  } : {
    bedDate: inferBedDate(wake0, settings.bedtime, settings.wakeTime), bedTime: settings.bedtime,
    wakeDate: wake0, wakeTime: settings.wakeTime,
    quality: null, awakenings: 0, napEnabled: false, napMinutes: 30, tags: new Set(), note: '', bedManual: false,
  };
  if (sleepDraft && sleepDraft.route === route && Date.now() - sleepDraft.at < 30 * 60000) st = { ...sleepDraft.state, tags: new Set(sleepDraft.state.tags) };
  const saveDraft = () => { sleepDraft = { route, at: Date.now(), state: { ...st, tags: [...st.tags] } }; };

  const form = el(`
    <form class="med-form__form" novalidate>
      <div class="input-card">
        <fieldset class="med-form__set">
          <legend class="field__label">Лёг спать</legend>
          <div class="sleep-when">
            <input class="input sleep-when__date" id="sf-bed-date" type="date" aria-label="Дата, когда легли спать" required>
            <input class="input sleep-when__time" id="sf-bed-time" type="time" aria-label="Время, когда легли спать" required>
          </div>
        </fieldset>
        <fieldset class="med-form__set">
          <legend class="field__label">Проснулся</legend>
          <div class="sleep-when">
            <input class="input sleep-when__date" id="sf-wake-date" type="date" max="${today}" aria-label="Дата пробуждения" aria-describedby="sf-day-hint" required>
            <input class="input sleep-when__time" id="sf-wake-time" type="time" aria-label="Время пробуждения" required>
          </div>
          <p class="med-form__hint" id="sf-day-hint"></p>
        </fieldset>
        <div class="sleep-dur">
          <span class="sleep-dur__label">Продолжительность</span>
          <b class="sleep-dur__val" aria-live="polite"></b>
        </div>
        <p class="med-form__err" id="sf-time-err" role="alert" hidden></p>
      </div>

      <div class="input-card">
        <fieldset class="med-form__set">
          <legend class="field__label">Качество сна <span class="med-form__opt">· необязательно</span></legend>
          <div class="sleep-quality" role="radiogroup" aria-label="Качество сна">
            ${SLEEP_QUALITY.map((q) => `<button class="sleep-q" type="button" role="radio" data-q="${q.value}" aria-checked="false" aria-label="${q.value} из 5: ${q.label}"><span class="sleep-q__emoji" aria-hidden="true">${q.emoji}</span><span class="sleep-q__label" aria-hidden="true">${q.label}</span></button>`).join('')}
          </div>
        </fieldset>
        <div class="sleep-step-row med-form__last">
          <span class="field__label" id="sf-aw-label">Пробуждения ночью</span>
          <div class="sleep-stepper" role="group" aria-labelledby="sf-aw-label">
            <button class="sleep-stepper__btn" type="button" data-aw="-1" aria-label="Меньше пробуждений">−</button>
            <output class="sleep-stepper__val" id="sf-aw" aria-live="polite"></output>
            <button class="sleep-stepper__btn" type="button" data-aw="1" aria-label="Больше пробуждений">+</button>
          </div>
        </div>
        <p class="med-form__err" id="sf-aw-err" role="alert" hidden></p>
      </div>

      <div class="input-card">
        <div class="rs-row sleep-nap-row">
          <div><div class="field__label sleep-nap-row__title" id="sf-nap-label">Дневной сон</div><div class="sleep-nap-row__sub">Есть дневной сон</div></div>
          <button class="rs-toggle" id="sf-nap" type="button" role="switch" aria-labelledby="sf-nap-label" aria-checked="false"><span class="rs-toggle__knob"></span></button>
        </div>
        <div class="sleep-step-row" data-part="nap">
          <label class="field__label" for="sf-nap-min">Длительность, мин</label>
          <div class="sleep-stepper">
            <button class="sleep-stepper__btn" type="button" data-nap="-10" aria-label="Меньше на 10 минут">−</button>
            <input class="input sleep-stepper__input" id="sf-nap-min" type="number" inputmode="numeric" min="1" max="${NAP_MAX_MINUTES}" step="5">
            <button class="sleep-stepper__btn" type="button" data-nap="10" aria-label="Больше на 10 минут">+</button>
          </div>
        </div>
        <p class="med-form__err" id="sf-nap-err" role="alert" hidden></p>
      </div>

      <div class="input-card">
        <fieldset class="med-form__set med-form__last">
          <legend class="field__label">Что могло повлиять на сон? <span class="med-form__opt">· необязательно</span></legend>
          <div class="sleep-tags">
            ${SLEEP_TAGS.map((t) => `<button class="sleep-tag" type="button" data-tag="${t.key}" aria-pressed="false"><span aria-hidden="true">${t.emoji}</span> ${esc(t.label)}</button>`).join('')}
          </div>
        </fieldset>
      </div>

      <div class="input-card">
        <div class="field med-form__last">
          <label class="field__label" for="sf-note">Заметка <span class="med-form__opt">· необязательно</span></label>
          <textarea class="input sleep-note" id="sf-note" rows="3" maxlength="${SLEEP_NOTE_MAX}" placeholder="Например, долго не мог заснуть, проснулся около 4 утра"></textarea>
        </div>
      </div>

      <div class="med-form__actions">
        <button class="btn-primary btn-primary--brand" type="submit">Сохранить</button>
        <button class="btn-ghost med-form__cancel" type="button">Отмена</button>
        ${existing ? '<button class="btn-ghost sleep-delete" type="button">Удалить запись</button>' : ''}
      </div>
    </form>
  `);
  const bedDate = $('#sf-bed-date', form), bedTime = $('#sf-bed-time', form);
  const wakeDate = $('#sf-wake-date', form), wakeTime = $('#sf-wake-time', form);
  const durVal = $('.sleep-dur__val', form), timeErr = $('#sf-time-err', form);
  const napMin = $('#sf-nap-min', form);
  bedDate.value = st.bedDate; bedTime.value = st.bedTime; wakeDate.value = st.wakeDate; wakeTime.value = st.wakeTime;
  napMin.value = String(st.napMinutes);
  $('#sf-note', form).value = st.note;

  const input = () => ({ ...st, tags: [...st.tags] });
  function paintTime() {
    const r = normalizeSleepInput(input(), { today });
    const terr = r.errors.start || r.errors.end || r.errors.duration;
    const dur = calculateDuration(makeStamp(st.bedDate, st.bedTime), makeStamp(st.wakeDate, st.wakeTime));
    durVal.textContent = terr ? '—' : formatSleepDuration(dur);
    $('#sf-day-hint', form).textContent = st.wakeDate ? `Запись относится к дню пробуждения: ${sleepDayMonth(st.wakeDate, today)}` : '';
    return terr;
  }
  function showTimeErr(msg) {
    timeErr.hidden = !msg;
    timeErr.textContent = msg || '';
    [bedDate, bedTime, wakeDate, wakeTime].forEach((x) => (msg ? x.setAttribute('aria-invalid', 'true') : x.removeAttribute('aria-invalid')));
  }
  const onTime = () => {
    st.bedTime = bedTime.value; st.wakeTime = wakeTime.value; st.wakeDate = wakeDate.value;
    /* дата засыпания подстраивается, пока её не меняли вручную: 23:40 → накануне, 00:30 → тот же день */
    if (!st.bedManual && st.wakeDate) { st.bedDate = inferBedDate(st.wakeDate, st.bedTime, st.wakeTime); bedDate.value = st.bedDate; }
    const err = paintTime();
    if (!timeErr.hidden) showTimeErr(err);
    saveDraft();
  };
  [bedTime, wakeTime, wakeDate].forEach((x) => { x.addEventListener('input', onTime); x.addEventListener('change', onTime); });
  const onBedDate = () => { st.bedDate = bedDate.value; st.bedManual = true; const err = paintTime(); if (!timeErr.hidden) showTimeErr(err); saveDraft(); };
  bedDate.addEventListener('input', onBedDate);
  bedDate.addEventListener('change', onBedDate);

  const paintQuality = () => $$('.sleep-q', form).forEach((b) => {
    const on = Number(b.dataset.q) === st.quality;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on || (st.quality == null && b.dataset.q === '1') ? 0 : -1;
  });
  $('.sleep-quality', form).addEventListener('click', (e) => {
    const b = e.target.closest('.sleep-q');
    if (!b) return;
    const q = Number(b.dataset.q);
    st.quality = st.quality === q ? null : q; // повторное касание снимает оценку
    paintQuality(); saveDraft();
  });
  $('.sleep-quality', form).addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    st.quality = Math.min(5, Math.max(1, (st.quality || (d > 0 ? 0 : 6)) + d));
    paintQuality(); saveDraft();
    $(`.sleep-q[data-q="${st.quality}"]`, form).focus();
  });

  const paintAw = () => {
    $('#sf-aw', form).textContent = String(st.awakenings);
    $('[data-aw="-1"]', form).disabled = st.awakenings <= 0;
    $('[data-aw="1"]', form).disabled = st.awakenings >= AWAKENINGS_MAX;
  };
  $$('[data-aw]', form).forEach((b) => b.addEventListener('click', () => {
    st.awakenings = Math.min(AWAKENINGS_MAX, Math.max(0, st.awakenings + Number(b.dataset.aw)));
    paintAw(); saveDraft();
  }));

  const napToggle = $('#sf-nap', form);
  const paintNap = () => {
    napToggle.classList.toggle('is-on', st.napEnabled);
    napToggle.setAttribute('aria-checked', String(st.napEnabled));
    $('[data-part="nap"]', form).hidden = !st.napEnabled;
    if (!st.napEnabled) $('#sf-nap-err', form).hidden = true;
  };
  napToggle.addEventListener('click', () => { st.napEnabled = !st.napEnabled; paintNap(); saveDraft(); });
  /* вся строка — зона касания переключателя (сам он 48×28) */
  $('.sleep-nap-row', form).addEventListener('click', (e) => { if (!e.target.closest('#sf-nap')) napToggle.click(); });
  napMin.addEventListener('input', () => { st.napMinutes = napMin.value === '' ? '' : Number(napMin.value); saveDraft(); });
  $$('[data-nap]', form).forEach((b) => b.addEventListener('click', () => {
    const cur = Number(st.napMinutes) || 0;
    st.napMinutes = Math.min(NAP_MAX_MINUTES, Math.max(10, Math.round((cur + Number(b.dataset.nap)) / 5) * 5));
    napMin.value = String(st.napMinutes);
    saveDraft();
  }));

  const paintTags = () => $$('.sleep-tag', form).forEach((b) => b.setAttribute('aria-pressed', String(st.tags.has(b.dataset.tag))));
  $('.sleep-tags', form).addEventListener('click', (e) => {
    const b = e.target.closest('.sleep-tag');
    if (!b) return;
    if (st.tags.has(b.dataset.tag)) st.tags.delete(b.dataset.tag); else st.tags.add(b.dataset.tag);
    paintTags(); saveDraft();
  });
  $('#sf-note', form).addEventListener('input', (e) => { st.note = e.target.value; saveDraft(); });
  $('.med-form__cancel', form).addEventListener('click', leave);

  async function openDuplicate(dup) {
    const go = await showDialog({
      title: `За ${sleepDayMonth(dup.date, today)} сон уже записан`,
      body: `<p class="dialog__muted">Одна дата пробуждения — одна запись: ${esc(formatSleepDuration(dup.durationMinutes))}, ${esc(sleepTimes(dup))}. Откройте её, чтобы изменить, или выберите другую дату.</p>`,
      actions: [{ label: 'Отмена', value: false }, { label: 'Открыть запись', value: true, kind: 'primary' }],
    });
    if (go) { sleepDraft = null; replaceRoute(`sleep/${encodeURIComponent(dup.id)}`); }
  }

  let saving = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const r = normalizeSleepInput(input(), { today });
    showTimeErr(r.errors.start || r.errors.end || r.errors.duration);
    const awErr = $('#sf-aw-err', form), napErr = $('#sf-nap-err', form);
    awErr.hidden = !r.errors.awakenings; awErr.textContent = r.errors.awakenings || '';
    napErr.hidden = !r.errors.nap; napErr.textContent = r.errors.nap || '';
    if (r.errors.nap) napMin.setAttribute('aria-invalid', 'true'); else napMin.removeAttribute('aria-invalid');
    if (!r.ok) {
      const first = r.errors.start ? bedTime : r.errors.end || r.errors.duration ? wakeTime : r.errors.nap ? napMin : null;
      if (first) first.focus();
      return;
    }
    saving = true;
    const btn = $('button[type="submit"]', form);
    btn.classList.add('is-busy');
    try {
      if (existing) await Storage.updateSleepEntry(existing.id, r.value);
      else await Storage.addSleepEntry(r.value);
    } catch (err) {
      saving = false;
      btn.classList.remove('is-busy');
      if (err instanceof SleepStoreError && err.code === 'DUPLICATE_DATE' && err.existing) { await openDuplicate(err.existing); return; }
      flash(err instanceof SleepStoreError && err.code !== 'INVALID' ? err.message : 'Не удалось сохранить запись сна');
      return;
    }
    sleepDraft = null;
    flash('Сохранено ✓');
    goBackTo(backTo);
  });

  const del = $('.sleep-delete', form);
  if (del) del.addEventListener('click', async () => {
    const ok = await showDialog({
      title: `Удалить запись сна за ${sleepDayMonth(existing.date, today)}?`,
      body: `<p class="dialog__muted">${esc(formatSleepDuration(existing.durationMinutes))}, ${esc(sleepTimes(existing))}. Аналитика пересчитается без этой ночи.</p>`,
      actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try { await Storage.removeSleepEntry(existing.id); } catch { flash('Не удалось удалить'); return; }
    sleepDraft = null;
    flash('Удалено');
    goBackTo(backTo);
  });

  screen.appendChild(form);
  paintTime(); paintQuality(); paintAw(); paintNap(); paintTags();
  return screen;
}

/* Настройки сна: цель (4–12 ч, шаг 15 мин), желаемое время сна и подъёма */
async function SleepSettingsScreen() {
  const s = await Storage.getSleepSettings();
  const screen = el('<div class="med-form sleep-form"></div>');
  const leave = () => goBack('sleep');
  screen.appendChild(backHeader('Настройки сна', { onBack: leave }));
  let goal = s.goalMinutes;
  const form = el(`
    <form class="med-form__form" novalidate>
      <div class="input-card">
        <div class="sleep-step-row sleep-step-row--stack med-form__last">
          <span class="field__label" id="ss-goal-label">Целевая продолжительность</span>
          <div class="sleep-stepper sleep-stepper--wide" role="group" aria-labelledby="ss-goal-label">
            <button class="sleep-stepper__btn" type="button" data-g="-1" aria-label="Меньше на 15 минут">−</button>
            <output class="sleep-stepper__val" id="ss-goal" aria-live="polite"></output>
            <button class="sleep-stepper__btn" type="button" data-g="1" aria-label="Больше на 15 минут">+</button>
          </div>
        </div>
        <p class="med-form__hint">От ${SLEEP_GOAL_MIN / 60} до ${SLEEP_GOAL_MAX / 60} часов, шаг ${SLEEP_GOAL_STEP} минут. Цель — для ночного сна: по ней считаются выполнение и серии.</p>
      </div>
      <div class="input-card">
        <div class="rs-row"><label class="field__label" for="ss-bed" style="margin:0">Желаемое время сна</label><input class="input sleep-set-time" id="ss-bed" type="time" required></div>
        <div class="rs-row"><label class="field__label" for="ss-wake" style="margin:0">Желаемое время подъёма</label><input class="input sleep-set-time" id="ss-wake" type="time" required></div>
        <p class="med-form__hint">Подставляется в новую запись и показывается на графике режима. Напоминания «Пора готовиться ко сну» и «Записать сон» появятся в одном из следующих обновлений.</p>
      </div>
      <div class="med-form__actions">
        <button class="btn-primary btn-primary--brand" type="submit">Сохранить</button>
        <button class="btn-ghost med-form__cancel" type="button">Отмена</button>
      </div>
    </form>
  `);
  const paintGoal = () => {
    $('#ss-goal', form).textContent = formatSleepDuration(goal);
    $('[data-g="-1"]', form).disabled = goal <= SLEEP_GOAL_MIN;
    $('[data-g="1"]', form).disabled = goal >= SLEEP_GOAL_MAX;
    form.toggleAttribute('data-unsaved', goal !== s.goalMinutes); // цель — не поле ввода: изменённость отмечаем явно
  };
  $$('[data-g]', form).forEach((b) => b.addEventListener('click', () => { goal = clampSleepGoal(goal + Number(b.dataset.g) * SLEEP_GOAL_STEP); paintGoal(); }));
  /* сохранённые значения — исходные значения полей (defaultValue), а не правка пользователя:
     изменённой форма становится только после ввода (js/services/swUpdate.js → hasUnsavedInput) */
  $('#ss-bed', form).defaultValue = s.bedtime;
  $('#ss-wake', form).defaultValue = s.wakeTime;
  $('.med-form__cancel', form).addEventListener('click', leave);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bedtime = $('#ss-bed', form).value, wakeTime = $('#ss-wake', form).value;
    if (!/^\d{2}:\d{2}$/.test(bedtime) || !/^\d{2}:\d{2}$/.test(wakeTime)) { flash('Укажите время сна и подъёма'); return; }
    try { await Storage.updateSleepSettings({ goalMinutes: goal, bedtime, wakeTime }); } catch { flash('Не удалось сохранить'); return; }
    flash('Сохранено ✓');
    goBackTo('sleep');
  });
  screen.appendChild(form);
  paintGoal();
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
function openDocViewer(file, title) {
  return showDocViewer(file, { lockScroll: lockPageScroll, unlockScroll: unlockPageScroll, ...(title ? { title } : {}) });
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
  return screen;
}

/* ---------- Полный анализ (#/test/<id>) ---------- */
async function TestDetailScreen(id) {
  const screen = el('<div class="tv"></div>');
  const tests = await Storage.getTests();
  const t = tests.find((x) => x.id === id);
  if (!t) {
    screen.appendChild(backHeader('Анализ', { fallback: 'tests' }));
    screen.appendChild(el('<div class="empty">Анализ не найден — возможно, он был удалён.</div>'));
    const b = el('<button class="btn-ghost" type="button">К списку анализов</button>');
    b.addEventListener('click', () => { goBackTo('tests'); });
    screen.appendChild(b);
    return screen;
  }
  const { no, sameDay } = sameDayNumber(tests, id);
  const sections = testSections(t);
  const count = sections.reduce((n, s) => n + s.rows.length, 0);

  screen.appendChild(backHeader(`Анализ от ${fmtTestDate(t.date)}`, { fallback: 'tests' }));
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
    goBack('tests');
    flash('Анализ удалён');
  });
  screen.appendChild(actions);
  return screen;
}

/* ---------- История одного показателя (#/test-history/<ключ>) ---------- */
async function TestHistoryScreen(key) {
  const screen = el('<div></div>');
  const h = indicatorHistory(await Storage.getTests(), key);
  screen.appendChild(backHeader(h.title, { fallback: 'tests' }));
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
  const done = () => goBack(existing ? `test/${encodeURIComponent(existing.id)}` : 'tests');
  screen.appendChild(backHeader(existing ? 'Изменить анализ' : 'Новый анализ', { onBack: done }));
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
        if (!upd) { await alertDialog('Анализ не найден', '<p>Запись была удалена. Ничего не изменено.</p>'); replaceRoute('tests'); return; }
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
    screen.appendChild(backHeader('Профиль'));
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
  screen.appendChild(backHeader('Резервная копия'));

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
      <p class="backup-note"><b>PDF и фото анализов и медицинских записей</b> входят только в «Полную резервную копию с документами» — один ZIP-файл с теми же данными и всеми документами. Восстанавливаются оба вида копий одной кнопкой «Восстановить из копии».</p>
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
        b = await createFullBackup(Storage, Attachments.store, { visitStore: VisitFiles.store });
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
            body: `<p>${esc(b.fileName)}</p><p class="dialog__muted">${b.attachments + (b.visitAttachments || 0)} ${plural(b.attachments + (b.visitAttachments || 0), 'документ', 'документа', 'документов')} · ${esc(formatBytes(b.bytes))}. Нажмите «Сохранить», затем «Сохранить в Файлы».</p>`,
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
        flash(`Полная копия создана ✓ (${b.attachments + (b.visitAttachments || 0)} док.)`);
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
    ['Архив прежней версии (планка и др.), дней', summary.activityDays],
    ['Сон', `${summary.sleep || 0} ${plural(summary.sleep || 0, 'запись', 'записи', 'записей')}`],
    ['Шаги', `${summary.steps || 0} ${plural(summary.steps || 0, 'день', 'дня', 'дней')}`],
    ['Велосипед', `${summary.bike || 0} ${plural(summary.bike || 0, 'поездка', 'поездки', 'поездок')}`],
    ['Обхват талии', `${summary.waist || 0} ${plural(summary.waist || 0, 'измерение', 'измерения', 'измерений')}`],
    ['Тренировки', `${summary.workouts || 0} ${plural(summary.workouts || 0, 'запись', 'записи', 'записей')}`],
  ];
  if (full) rows.push(['Документы анализов (PDF/фото)', full.attachments.length], ['Документы врачей и визитов', (full.visitAttachments || []).length]);
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
    if (full) await applyFullRestore(Storage, Attachments, full, { visitService: VisitFiles });
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
  screen.appendChild(backHeader('Импорт истории воды', { fallback: 'settings' }));

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
   Импорт медицинской истории (#/history-import) — services/historyImport.js.
   Файл JSON читается локально. Сначала проверка без записи (dry-run): сколько записей,
   что уже есть, что будет добавлено, что пропускается как дубль или требует уточнения.
   Затем — резервная копия текущих данных и только добавление новых записей
   в «Врачи и визиты» и «Лекарства». Повторный импорт того же файла добавляет 0.
   ========================================================= */
async function HistoryImportScreen() {
  const screen = el('<div></div>');
  screen.appendChild(backHeader('Импорт медицинской истории', { fallback: 'settings' }));
  screen.appendChild(el(`
    <div class="input-card">
      <p class="backup-note">Перенос прошлых визитов, процедур, обследований и курсов лекарств из подготовленного файла (JSON). Файл читается только на этом устройстве.</p>
      <p class="backup-note">Сначала LexLife показывает, что будет добавлено, а что уже есть. Существующие записи не изменяются и не удаляются; результаты анализов этот импорт не добавляет. Перед переносом создаётся резервная копия. Повторный импорт того же файла не создаёт дублей.</p>
    </div>
  `));
  const pickCard = el('<div class="input-card"></div>');
  const pickLabel = el('<label class="btn-ghost">Выбрать файл истории (JSON)<input type="file" accept=".json,application/json" hidden></label>');
  const fileInput = $('input', pickLabel);
  pickCard.appendChild(pickLabel);
  const fileNameEl = el('<p class="backup-note" style="margin-top:8px"></p>');
  pickCard.appendChild(fileNameEl);
  screen.appendChild(pickCard);
  const previewHost = el('<div></div>');
  screen.appendChild(previewHost);

  const STATUS = [
    ['add', 'Будут добавлены', true],
    ['duplicate', 'Уже есть в LexLife — пропуск', false],
    ['conflict', 'Требуют уточнения — пропуск', true],
    ['imported', 'Импортированы ранее', false],
  ];
  let parsed = null;

  const itemLine = (p, isMed) => {
    const it = p.item;
    const when = isMed ? `${fmtDate(it.start)}${it.end ? ` – ${fmtDate(it.end)}` : ''}` : `${fmtDate(it.date)}${it.time ? ` · ${it.time}` : ''}`;
    const title = isMed ? `💊 ${it.name}` : `${visitIcon(it)} ${it.title}`;
    return `<li class="hist-item"><span class="hist-item__when">${esc(when)}</span><span class="hist-item__title">${esc(title)}</span>${p.reason ? `<small class="hist-item__why">${esc(p.reason)}</small>` : ''}</li>`;
  };

  async function computePlan() {
    const [visits, meds, tests] = await Promise.all([Storage.getVisits(), Storage.getMeds({ includeDeleted: true }), Storage.getTests()]);
    return buildHistoryImportPlan(parsed, { visits, meds, tests });
  }

  function renderPreview(plan, { justImported = false } = {}) {
    previewHost.innerHTML = '';
    const c = plan.counts;
    const card = el(`
      <div class="input-card">
        <ul class="dialog__list">
          <li><span>Записей в файле</span><span>${plan.eventsTotal + plan.medsTotal}</span></li>
          <li><span>— событий истории</span><span>${plan.eventsTotal}</span></li>
          <li><span>— курсов лекарств</span><span>${plan.medsTotal}</span></li>
          <li><span>Будет добавлено</span><span>${c.add}${c.add ? ` (${plan.eventsAdd} соб. · ${plan.medsAdd} курс.)` : ''}</span></li>
          <li><span>Уже есть в LexLife (дубли)</span><span>${c.duplicate}</span></li>
          <li><span>Требуют уточнения</span><span>${c.conflict}</span></li>
          <li><span>Импортированы ранее</span><span>${c.imported}</span></li>
          <li><span>Ошибки проверки</span><span>0</span></li>
        </ul>
        ${justImported ? `<p class="backup-note" style="margin-top:8px">Повторная проверка после импорта: к добавлению — <b>${c.add}</b>.</p>` : ''}
      </div>
    `);
    previewHost.appendChild(card);
    STATUS.forEach(([st, label, open]) => {
      const evs = plan.events.filter((p) => p.status === st);
      const ms = plan.meds.filter((p) => p.status === st);
      if (!evs.length && !ms.length) return;
      const det = el(`<details class="med-history hist-group"${open && evs.length + ms.length <= 60 ? ' open' : ''}><summary class="med-history__head">${esc(label)} <small>${evs.length + ms.length}</small></summary><ul class="hist-list">${ms.map((p) => itemLine(p, true)).join('')}${evs.map((p) => itemLine(p, false)).join('')}</ul></details>`);
      previewHost.appendChild(det);
    });

    const actions = el('<div class="backup-actions"></div>');
    const btn = el('<button class="btn-primary" type="button"></button>');
    btn.textContent = c.add ? `Создать копию и импортировать (${c.add})` : 'Нечего импортировать';
    btn.disabled = !c.add;
    btn.addEventListener('click', async () => {
      const go = await showDialog({
        title: 'Импорт медицинской истории',
        body: `
          <p>Будет добавлено: <b>${plan.eventsAdd}</b> ${plural(plan.eventsAdd, 'событие', 'события', 'событий')} в «Врачи и визиты» и <b>${plan.medsAdd}</b> ${plural(plan.medsAdd, 'курс', 'курса', 'курсов')} в «Лекарства».</p>
          ${c.duplicate + c.imported ? `<p class="dialog__muted">${c.duplicate + c.imported} ${plural(c.duplicate + c.imported, 'запись уже есть', 'записи уже есть', 'записей уже есть')} — будут пропущены.</p>` : ''}
          ${c.conflict ? `<p class="dialog__warn">${c.conflict} ${plural(c.conflict, 'запись требует', 'записи требуют', 'записей требуют')} уточнения и не импортируются.</p>` : ''}
          <p class="dialog__muted">Перед импортом будет создана резервная копия текущих данных.</p>
        `,
        actions: [{ label: 'Отмена', value: false }, { label: 'Создать копию и импортировать', value: true, kind: 'primary' }],
      });
      if (!go) return;
      btn.classList.add('is-busy');
      try {
        if (!(await backupBeforeImport())) return;
        const fresh = await computePlan(); // данные могли измениться, пока открыт диалог
        const res = await applyHistoryImportPlan(Storage, fresh);
        const again = await computePlan();
        await showDialog({
          title: 'Импорт завершён',
          body: `
            <ul class="dialog__list">
              <li><span>Добавлено событий</span><span>${res.visitsAdded}</span></li>
              <li><span>Добавлено курсов лекарств</span><span>${res.medsAdded}</span></li>
              <li><span>Пропущено как дубли</span><span>${fresh.counts.duplicate + fresh.counts.imported}</span></li>
              <li><span>Требуют уточнения</span><span>${fresh.counts.conflict}</span></li>
              <li><span>Повторная проверка: к добавлению</span><span>${again.counts.add}</span></li>
              <li><span>Визиты: было → стало</span><span>${res.before.visits} → ${res.after.visits}</span></li>
              <li><span>Лекарства: было → стало</span><span>${res.before.meds} → ${res.after.meds}</span></li>
            </ul>
            <p class="dialog__muted">Все прежние записи проверены: на месте и не изменены.</p>
          `,
          actions: [{ label: 'Готово', value: true, kind: 'primary' }],
        });
        flash('Импорт завершён ✓');
        renderPreview(again, { justImported: true });
      } catch (err) {
        await showDialog({ title: 'Не удалось импортировать', body: `<p>${esc((err && err.message) || 'Попробуйте ещё раз.')}</p><p class="dialog__muted">Существующие данные не изменены.</p>`, actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
      } finally {
        btn.classList.remove('is-busy');
      }
    });
    actions.appendChild(btn);
    previewHost.appendChild(actions);
    const link = el('<section class="section"><div class="list-card"><div class="row" role="button" data-route="visits"><span class="row__icon">🩺</span><div class="row__body"><p class="row__title">Врачи и визиты</p><p class="row__sub">Импортированные события — в разделе «Прошедшие»</p></div><span class="row__chevron">›</span></div></div></section>');
    link.addEventListener('click', onRouteClick);
    previewHost.appendChild(link);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    fileNameEl.textContent = file.name;
    pickLabel.classList.add('is-busy');
    previewHost.innerHTML = '';
    try {
      try {
        parsed = parseMedicalHistory(await file.text());
      } catch (err) {
        parsed = null;
        const list = err instanceof HistoryImportError && err.errors.length
          ? `<ul class="dialog__list">${err.errors.slice(0, 8).map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ul>${err.errors.length > 8 ? `<p class="dialog__muted">…и ещё ${err.errors.length - 8}</p>` : ''}`
          : '';
        await showDialog({ title: 'Файл не принят', body: `<p>${esc(err instanceof HistoryImportError ? err.message : 'Не удалось прочитать файл.')}</p>${list}<p class="dialog__muted">Данные LexLife не изменены.</p>`, actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
        return;
      }
      renderPreview(await computePlan());
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

/* =========================================================
   Единый журнал показателя — вода, сон, шаги, велосипед.
   Один сценарий: показатель → «Журнал» → любая дата → добавить / изменить / удалить.
   Месяц ‹ › и «Сегодня», поля «Месяц» и «Перейти к дате», итог месяца, «+ Добавить запись»;
   ниже — дни месяца (новые сверху) с итогом дня и записями ✎ / ✕. Выбранная дата
   подсвечивается и прокручивается к себе; адрес журнала (#/<журнал>/ГГГГ-ММ[-ДД]) хранит
   месяц и дату — «Назад» из формы и перезапуск возвращают туда же.
   ========================================================= */
const JR_CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const jrMonthTitle = (m) => { const [y, mo] = m.split('-').map(Number); return JR_CAP(new Date(y, mo - 1, 1).toLocaleDateString(RU, { month: 'long', year: 'numeric' })); };
const jrDayTitle = (d) => JR_CAP(new Date(`${d}T00:00:00`).toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'long' }));
function jrShiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/* Разбор адреса журнала: «ГГГГ-ММ-ДД» → выбранная дата и её месяц, «ГГГГ-ММ» → месяц; не позже сегодня */
function journalState(param, today) {
  const curMonth = today.slice(0, 7);
  const focusDay = WL_DATE_RE.test(param || '') && param <= today ? param : null;
  let month = focusDay ? focusDay.slice(0, 7) : (/^\d{4}-\d{2}$/.test(param || '') ? param : curMonth);
  if (month > curMonth) month = curMonth;
  return { month, focusDay };
}
/* Панель журнала. prefix — id полей (вода — «wl»); onGo(month, day|null); onAdd() */
function journalControls({ prefix, month, focusDay, today, summary, onGo, onAdd, addLabel = '+ Добавить запись' }) {
  const curMonth = today.slice(0, 7);
  const atToday = month === curMonth && focusDay === today;
  const ctrl = el(`
    <div class="input-card jctrl">
      <div class="jctrl__nav">
        <button class="btn-ghost jctrl__arrow" type="button" data-nav="-1" aria-label="Предыдущий месяц">‹</button>
        <b class="jctrl__title">${esc(jrMonthTitle(month))}</b>
        <button class="sleep-today jctrl__today" type="button" data-today ${atToday ? 'disabled' : ''}>Сегодня</button>
        <button class="btn-ghost jctrl__arrow" type="button" data-nav="1" aria-label="Следующий месяц" ${month >= curMonth ? 'disabled' : ''}>›</button>
      </div>
      <div class="jctrl__fields">
        <label><span class="field__label">Месяц</span><input class="input" type="month" id="${prefix}-month" value="${esc(month)}" max="${esc(curMonth)}"></label>
        <label><span class="field__label">Перейти к дате</span><input class="input" type="date" id="${prefix}-goto" max="${esc(today)}" value="${esc(focusDay || '')}"></label>
      </div>
      <p class="backup-note jctrl__sum">${summary}</p>
      <button class="btn-primary" type="button" id="${prefix}-add">${esc(addLabel)}</button>
    </div>
  `);
  ctrl.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    const m = jrShiftMonth(month, Number(b.dataset.nav));
    if (m <= curMonth) onGo(m);
  }));
  $('[data-today]', ctrl).addEventListener('click', () => onGo(curMonth, today));
  $(`#${prefix}-month`, ctrl).addEventListener('change', (ev) => { const v = ev.target.value; if (/^\d{4}-\d{2}$/.test(v) && v <= curMonth) onGo(v); });
  $(`#${prefix}-goto`, ctrl).addEventListener('change', (ev) => { const v = ev.target.value; if (WL_DATE_RE.test(v) && v <= today) onGo(v.slice(0, 7), v); });
  $(`#${prefix}-add`, ctrl).addEventListener('click', onAdd);
  return ctrl;
}
/* День журнала: заголовок (дата · итог дня [· доп. кнопка]) и записи */
function journalDay({ prefix, date, focus, totalHtml, extraHead = '', emptyText = '' }) {
  const sec = el(`
    <section class="section jday" id="${prefix}-${date}">
      <div class="section__head">
        <h2 class="section__title" style="font-size:16px">${esc(jrDayTitle(date))}</h2>
        <span style="display:flex; align-items:center; gap:6px"><b class="jday__total">${totalHtml}</b>${extraHead}</span>
      </div>
      <div class="list-card"></div>
    </section>
  `);
  if (focus) sec.classList.add('jday--focus');
  if (emptyText) $('.list-card', sec).appendChild(el(`<div class="empty">${esc(emptyText)}</div>`));
  return sec;
}
/* Запись дня: заголовок, подпись, ✎ и ✕ (подписи для экранного диктора — label) */
function journalRow({ titleHtml, subHtml = '', label, onEdit, onDelete }) {
  const row = el(`
    <div class="row jrow">
      <div class="row__body"><p class="row__title">${titleHtml}</p>${subHtml ? `<p class="row__sub">${subHtml}</p>` : ''}</div>
      <button class="wdel" type="button" data-act="edit" aria-label="Редактировать запись ${esc(label)}">✎</button>
      <button class="wdel" type="button" data-act="del" aria-label="Удалить запись ${esc(label)}">✕</button>
    </div>
  `);
  $('[data-act="edit"]', row).addEventListener('click', onEdit);
  $('[data-act="del"]', row).addEventListener('click', onDelete);
  return row;
}
/* Выбранная дата без записей — подсказка; прокрутка к дню после отрисовки */
function journalFocus(screen, prefix, focusDay, hasDay) {
  if (focusDay && !hasDay) screen.appendChild(el(`<p class="empty jempty">${esc(fmtDate(focusDay))}: записей нет. «+ Добавить запись» добавит запись на эту дату.</p>`));
  if (focusDay) setTimeout(() => { const n = document.getElementById(`${prefix}-${focusDay}`); if (n) n.scrollIntoView({ block: 'start' }); }, 60);
}

/* Запись воды: подпись источника, форма, добавление, правка (в т.ч. перенос на другую дату) и удаление.
   Общие для журнала воды (#/water-log) и «Всех журналов» — один и тот же редактор. */
const waterSrcLabel = (e) => {
  const drink = e.drink && e.drink !== 'Вода' ? ` · ${esc(e.drink)}${e.hydrationMl ? ` (${fmtMl(e.hydrationMl)} мл напитка)` : ''}` : '';
  return `${isWaterMinderKey(e.key) ? 'WaterMinder' : 'вручную'}${drink}`;
};
/* Форма записи: дату, фактическое время и объём задаёт пользователь.
   withDelete — третья кнопка «Удалить» (→ 'delete'). → значения | 'delete' | null */
async function waterEntryForm(title, submit, v, { withDelete = false } = {}) {
  const today = dateKey();
  let vals = null;
  const choice = await showDialog({
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
      ...(withDelete ? [{ label: 'Удалить', value: 'delete', kind: 'danger' }] : []),
      { label: submit, value: true, kind: 'primary', onClick: () => { vals = { date: $('#wl-d').value, t: $('#wl-t').value, ml: Number($('#wl-ml').value) }; } },
    ],
    cancelValue: false,
  });
  if (choice === 'delete') return 'delete';
  if (!choice || !vals) return null;
  if (!WL_DATE_RE.test(vals.date) || vals.date > today || !WL_TIME_RE.test(vals.t) || !(vals.ml > 0 && vals.ml <= 5000)) {
    await showDialog({ title: 'Запись не сохранена', body: '<p>Укажите дату не позже сегодняшней, время ЧЧ:ММ и объём от 1 до 5000 мл.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
    return null;
  }
  vals.ml = Math.round(vals.ml);
  return vals;
}
/* Новая запись на дату date (по умолчанию — сегодня, текущее время). → дата записи | null */
async function addWaterEntryDialog(date = dateKey()) {
  const vals = await waterEntryForm('Новая запись', 'Добавить', { date, t: hhmmNow(), ml: 250 });
  if (!vals) return null;
  await Storage.addWaterEntry(vals.ml, vals.date, vals.t);
  flash(`+${fmtMl(vals.ml)} мл · ${fmtDate(vals.date)}`);
  return vals.date;
}
/* Правка записи e (индекс i) дня d. withDelete — в форме есть «Удалить» (подтверждение — deleteWaterEntry).
   → { date } — куда смотреть после правки | { deleted } | null — отменено */
async function editWaterEntry(d, e, i, { withDelete = false, dayTotal = null } = {}) {
  const vals = await waterEntryForm('Редактировать запись', 'Сохранить', { date: d, t: e.t, ml: e.ml }, { withDelete });
  if (vals === 'delete') return (await deleteWaterEntry(d, e, i, dayTotal ?? (await Storage.getWater(d)))) ? { deleted: true, date: d } : null;
  if (!vals) return null;
  const ok = await Storage.updateWaterEntry(d, i, { t: e.t, ml: e.ml, key: e.key ?? null }, vals);
  if (!ok) {
    await showDialog({ title: 'Запись не найдена', body: '<p>Данные изменились, пока была открыта форма. Ничего не изменено.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
  } else {
    flash(vals.date !== d ? `Перенесено на ${fmtDate(vals.date)}` : 'Сохранено ✓');
  }
  return { date: vals.date };
}
/* Удаление одной записи (с подтверждением). → true — подтверждено (удалено или уже нет), false — отменено */
async function deleteWaterEntry(d, e, i, dayTotal) {
  const ok = await showDialog({
    title: 'Удалить запись?',
    body: `<p>${esc(fmtDate(d))}, <b>${esc(e.t)} · ${fmtMl(e.ml)} мл</b> (${waterSrcLabel(e)}).</p><p class="dialog__muted">Будет удалена только эта запись. Итог дня станет ${fmtMl(Math.max(0, dayTotal - e.ml))} мл.</p>`,
    actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
  });
  if (!ok) return false;
  const done = await Storage.removeWaterEntry(i, d, { t: e.t, ml: e.ml, key: e.key ?? null });
  if (!done) {
    await showDialog({ title: 'Запись не найдена', body: '<p>Данные изменились. Ничего не удалено.</p>', actions: [{ label: 'Понятно', value: true, kind: 'primary' }] });
  } else {
    flash('Удалено');
  }
  return true;
}

async function WaterLogScreen(param) {
  const screen = el('<div></div>');
  const today = dateKey();
  let { month, focusDay } = journalState(param, today);
  const hasWater = (o) => !!o && (((o.entries || []).length > 0) || (o.total || 0) > 0);
  const srcLabel = waterSrcLabel;
  const go = (m, d = null) => {
    month = m;
    focusDay = d;
    replaceUrl(`water-log/${d || m}`);
    paint();
  };

  async function paint() {
    const log = await Storage.getWaterLog();
    const days = Object.keys(log).filter((d) => d.startsWith(`${month}-`) && hasWater(log[d])).sort().reverse();
    const monthEntries = days.reduce((s, d) => s + (log[d].entries || []).length, 0);
    const monthTotal = days.reduce((s, d) => s + (log[d].total || 0), 0);
    screen.innerHTML = '';
    screen.appendChild(backHeader('Журнал воды', { fallback: 'metric/water' }));
    screen.appendChild(journalControls({
      prefix: 'wl', month, focusDay, today, onGo: go, onAdd: addEntry,
      summary: `За месяц: ${monthEntries} ${plural(monthEntries, 'запись', 'записи', 'записей')} · ${days.length} ${plural(days.length, 'день', 'дня', 'дней')} с водой · ${fmtMl(monthTotal)} мл`,
    }));

    if (!days.length) screen.appendChild(el('<p class="empty">В этом месяце записей воды нет.</p>'));
    journalFocus(screen, 'wl', focusDay, days.includes(focusDay));

    days.forEach((d) => {
      const o = log[d];
      const entries = (o.entries || []).map((e, i) => ({ e, i }));
      const importedCount = entries.filter(({ e }) => isWaterMinderKey(e.key)).length;
      const sec = journalDay({
        prefix: 'wl', date: d, focus: d === focusDay, totalHtml: `${fmtMl(o.total || 0)} мл`,
        extraHead: importedCount ? '<button class="section__action" type="button" data-bulk aria-label="Исправить ошибочную серию">⋯</button>' : '',
        emptyText: entries.length ? '' : 'Итог без разбивки по приёмам',
      });
      const box = $('.list-card', sec);
      entries.forEach(({ e, i }) => box.appendChild(journalRow({
        titleHtml: `${esc(e.t)} · +${fmtMl(e.ml)} мл`, subHtml: srcLabel(e), label: e.t,
        onEdit: () => editEntry(d, e, i), onDelete: () => deleteEntry(d, e, i, o.total || 0),
      })));
      const bulk = $('[data-bulk]', sec);
      if (bulk) bulk.addEventListener('click', () => bulkRemoveImported(d, o));
      screen.appendChild(sec);
    });
  }

  async function addEntry() {
    const saved = await addWaterEntryDialog(focusDay || today);
    if (saved) go(saved.slice(0, 7), saved);
  }

  async function editEntry(d, e, i) {
    const r = await editWaterEntry(d, e, i);
    if (r) go(r.date.slice(0, 7), r.date);
  }

  async function deleteEntry(d, e, i, dayTotal) {
    if (await deleteWaterEntry(d, e, i, dayTotal)) go(month, d);
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

/* =========================================================
   Шаги (#/steps) · Велосипед (#/bike) — самостоятельные показатели
   по образцу «Сна»: значение за выбранный день · статистика Неделя / Месяц / Год (календарные
   периоды с ‹ ›) · последние записи · «Журнал» (#/steps-log, #/bike-log — единый журнал).
   «Шаги» — вся ходьба (прогулка, дома, беговая дорожка); рядом с шагами — расчётные км
   (stepsToKm, только оценка, не хранится). Модель и расчёты — services/activity.js,
   хранение — Storage (steps_log, bike_log).
   Выбранные период и день живут в записи истории (saveEntryUi): «Назад» из журнала — туда же.
   ========================================================= */
const ACT_PERIOD_KINDS = SLEEP_KINDS.map(([k]) => k);
const ACT_SOURCE = { manual: 'вручную', [LEGACY_ACTIVITY_SOURCE]: 'перенесено из прежней версии' };
const actSourceText = (e) => ACT_SOURCE[(e && e.source) || 'manual'] || esc(e.source);
const ACT_JOURNAL_TITLE = { steps: 'Журнал шагов', bike: 'Журнал поездок' };
const hhmmNow = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/* Поездка без километров (перенесённый велотренажёр — только минуты) — никогда не «0 км»:
   «Велотренажёр · 35 мин» и подпись «Дистанция не указана»; в километры не входит. */
const TRAINER_RE = /^Велотренажёр(?: · )?/;
const isTrainerRide = (r) => r.source === LEGACY_ACTIVITY_SOURCE || TRAINER_RE.test(r.note || '');
/* «08:30 · 7,4 км · 25 мин»; без времени — «без времени»; без км — «Велотренажёр · 35 мин» */
function rideTitle(r) {
  if (r.km == null) return [r.time, isTrainerRide(r) ? 'Велотренажёр' : 'Поездка', r.minutes != null ? `${r.minutes} мин` : ''].filter(Boolean).join(' · ');
  const parts = [r.time || 'без времени', `${fmtActivityValue('bike', r.km)} км`];
  if (r.minutes != null) parts.push(`${r.minutes} мин`);
  return parts.join(' · ');
}
function rideSub(r) {
  const note = r.km == null && isTrainerRide(r) ? (r.note || '').replace(TRAINER_RE, '') : r.note || '';
  return [r.km == null ? 'Дистанция не указана' : '', actSourceText(r), note ? esc(note) : ''].filter(Boolean).join(' · ');
}
const NO_KM = 'Дистанция не указана';
/* источник итога шагов — вторичная строка: «Беговая дорожка · заметка» */
const stepsSourceText = (e) => esc(STEPS_SOURCES[(e && e.source) || 'manual'] || e.source);
const dailySub = (e) => [stepsSourceText(e), e.note ? esc(e.note) : ''].filter(Boolean).join(' · ');
/* «8 450 <small>шагов · ≈ 6,3 км</small>» — крупное значение дня / среднего */
const actValueHtml = (metric, v) => {
  const km = metric === 'steps' ? fmtKmApprox(stepsToKm(v)) : '';
  return `${esc(fmtActivityValue(metric, v))} <small>${esc(activityUnit(metric, v))}${km ? ` · ${esc(km)}` : ''}</small>`;
};
/* число для поля ввода: 8450 / «6,4» */
const actInputValue = (metric, v) => (v == null ? '' : metric === 'steps' ? String(v) : String(v).replace('.', ','));
const actErrorsHtml = (errors) => `<p>${Object.values(errors).map((t) => esc(t)).join('<br>')}</p>`;

/* Дневной итог шагов: добавить или изменить, в т.ч. перенести на другую дату.
   Вся ходьба дня — одним итогом; источник (вручную / прогулка / беговая дорожка) — только метка.
   Под полем — расчётные км, пересчитываются при вводе. from — дата редактируемой записи (null — новая).
   Дата уже занята → «Заменить?» (у дня один итог, дубля не бывает). Ошибка ввода → форма снова
   с введёнными значениями. withDelete (правка) — в форме есть «Удалить» (подтверждение —
   deleteDailyActivity) → { deleted: true }. → сохранённая дата | null */
async function editDailyActivity(metric, { date, from = null, existing = null, withDelete = false } = {}) {
  const M = ACTIVITY_METRICS[metric];
  let v = { date, value: existing ? actInputValue(metric, existing[M.field]) : '', note: existing ? existing.note || '' : '', source: (existing && existing.source) || 'manual' };
  for (;;) {
    let raw = null;
    /* прочие метки (перенесённые записи, будущий автоматический источник) остаются выбранными как есть */
    const choices = STEPS_SOURCE_CHOICES.includes(v.source) || !STEPS_SOURCES[v.source] ? STEPS_SOURCE_CHOICES : [...STEPS_SOURCE_CHOICES, v.source];
    const kmHint = (val) => { const n = parseActivityNumber(val); return fmtKmApprox(n != null && !Number.isNaN(n) ? stepsToKm(n) : null); };
    const pending = showDialog({
      title: from ? 'Изменить запись' : 'Новая запись',
      body: `
        <label class="field__label" for="jr-d">Дата</label>
        <input class="input" type="date" id="jr-d" value="${esc(v.date)}" max="${esc(dateKey())}">
        <label class="field__label" for="jr-v" style="margin-top:10px">Шаги за день</label>
        <input class="input" type="text" id="jr-v" inputmode="numeric" autocomplete="off" value="${esc(v.value)}" placeholder="8 450">
        <p class="dialog__muted act-km-hint" id="jr-km" aria-live="polite" style="margin:6px 0 0">${esc(kmHint(v.value))}</p>
        <label class="field__label" for="jr-src" style="margin-top:10px">Источник</label>
        <select class="select" id="jr-src">${choices.map((k) => `<option value="${esc(k)}"${k === v.source ? ' selected' : ''}>${esc(STEPS_SOURCES[k])}</option>`).join('')}</select>
        <p class="dialog__muted" style="margin:6px 0 0">Прогулка, ходьба дома, беговая дорожка — всё входит в один итог шагов за день.</p>
        <label class="field__label" for="jr-note" style="margin-top:10px">Заметка (необязательно)</label>
        <input class="input" type="text" id="jr-note" maxlength="${ACTIVITY_NOTE_MAX}" value="${esc(v.note)}">
      `,
      actions: [
        { label: 'Отмена', value: false },
        ...(withDelete && from ? [{ label: 'Удалить', value: 'delete', kind: 'danger' }] : []),
        { label: from ? 'Сохранить' : 'Добавить', value: true, kind: 'primary', onClick: () => { raw = { date: $('#jr-d').value, value: $('#jr-v').value, source: $('#jr-src').value, note: $('#jr-note').value }; } },
      ],
      cancelValue: false,
    });
    $('#jr-v').addEventListener('input', (e) => { $('#jr-km').textContent = kmHint(e.target.value); });
    const ok = await pending;
    if (ok === 'delete') return (await deleteDailyActivity(metric, from, existing)) ? { deleted: true } : null;
    if (!ok || !raw) return null;
    const n = normalizeDailyInput(metric, raw, { today: dateKey() });
    if (!n.ok) { await alertDialog('Запись не сохранена', actErrorsHtml(n.errors)); v = raw; continue; }
    try {
      await Storage.saveDailyActivity(metric, n.value, { from });
    } catch (err) {
      if (!(err instanceof ActivityStoreError)) throw err;
      if (err.code === 'DUPLICATE_DATE') {
        const old = err.existing || {};
        const replace = await showDialog({
          title: 'За эту дату уже есть запись',
          body: `<p>${esc(fmtDate(n.value.date))}: <b>${esc(fmtActivity(metric, old[M.field]))}</b>.</p><p>Заменить на <b>${esc(fmtActivity(metric, n.value[M.field]))}</b>?</p><p class="dialog__muted">У дня один итог — второй записи за ту же дату не будет.</p>`,
          actions: [{ label: 'Отмена', value: false }, { label: 'Заменить', value: true, kind: 'primary' }],
        });
        if (!replace) return null;
        try { await Storage.saveDailyActivity(metric, n.value, { from, overwrite: true }); } catch (e2) { await alertDialog('Запись не сохранена', `<p>${esc(e2.message)}</p>`); return null; }
      } else {
        await alertDialog(err.code === 'NOT_FOUND' ? 'Запись не найдена' : 'Запись не сохранена', `<p>${esc(err.message)}</p>`);
        return null;
      }
    }
    flash(from && from !== n.value.date ? `Перенесено на ${fmtDate(n.value.date)}` : from ? 'Сохранено ✓' : `${fmtActivity(metric, n.value[M.field])} · ${fmtDate(n.value.date)}`);
    return n.value.date;
  }
}
async function deleteDailyActivity(metric, date, entry) {
  const M = ACTIVITY_METRICS[metric];
  const ok = await showDialog({
    title: 'Удалить запись?',
    body: `<p>${esc(fmtDate(date))}: <b>${esc(fmtActivity(metric, entry[M.field]))}</b>.</p><p class="dialog__muted">Будет удалён итог только этого дня.</p>`,
    actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
  });
  if (!ok) return false;
  if (!(await Storage.removeDailyActivity(metric, date))) { await alertDialog('Запись не найдена', '<p>Данные изменились. Ничего не удалено.</p>'); return false; }
  flash('Удалено');
  return true;
}
/* Поездка: добавить (presetDate) или изменить ride — время, км, минуты, заметка, дата (перенос).
   withDelete (правка) — в форме есть «Удалить» (подтверждение — deleteRide) → { deleted: true }. → дата | null */
async function editRide(ride, presetDate = dateKey(), { withDelete = false } = {}) {
  const today = dateKey();
  let v = ride
    ? { date: ride.date, time: ride.time || '', km: actInputValue('bike', ride.km), minutes: ride.minutes ?? '', note: ride.note || '' }
    : { date: presetDate, time: presetDate === today ? hhmmNow() : '', km: '', minutes: '', note: '' };
  for (;;) {
    let raw = null;
    const ok = await showDialog({
      title: ride ? 'Изменить поездку' : 'Новая поездка',
      body: `
        <label class="field__label" for="jr-d">Дата</label>
        <input class="input" type="date" id="jr-d" value="${esc(v.date)}" max="${esc(today)}">
        <label class="field__label" for="jr-t" style="margin-top:10px">Время (необязательно)</label>
        <input class="input" type="time" id="jr-t" value="${esc(v.time)}">
        <label class="field__label" for="jr-km" style="margin-top:10px">Дистанция, км</label>
        <input class="input" type="text" id="jr-km" inputmode="decimal" autocomplete="off" value="${esc(v.km)}" placeholder="7,4">
        <label class="field__label" for="jr-min" style="margin-top:10px">Время в пути, мин (необязательно)</label>
        <input class="input" type="text" id="jr-min" inputmode="numeric" autocomplete="off" value="${esc(v.minutes)}">
        <label class="field__label" for="jr-note" style="margin-top:10px">Заметка (необязательно)</label>
        <input class="input" type="text" id="jr-note" maxlength="${ACTIVITY_NOTE_MAX}" value="${esc(v.note)}">
      `,
      actions: [
        { label: 'Отмена', value: false },
        ...(withDelete && ride ? [{ label: 'Удалить', value: 'delete', kind: 'danger' }] : []),
        { label: ride ? 'Сохранить' : 'Добавить', value: true, kind: 'primary', onClick: () => { raw = { date: $('#jr-d').value, time: $('#jr-t').value, km: $('#jr-km').value, minutes: $('#jr-min').value, note: $('#jr-note').value }; } },
      ],
      cancelValue: false,
    });
    if (ok === 'delete') return (await deleteRide(ride)) ? { deleted: true } : null;
    if (!ok || !raw) return null;
    const n = normalizeRideInput(raw, { today });
    if (!n.ok) { await alertDialog('Поездка не сохранена', actErrorsHtml(n.errors)); v = raw; continue; }
    try {
      if (ride) {
        if (!(await Storage.updateBikeRide(ride.id, n.value))) { await alertDialog('Поездка не найдена', '<p>Данные изменились, пока была открыта форма. Ничего не изменено.</p>'); return null; }
      } else {
        await Storage.addBikeRide(n.value);
      }
    } catch (err) {
      if (!(err instanceof ActivityStoreError)) throw err;
      await alertDialog('Поездка не сохранена', `<p>${esc(err.message)}</p>`);
      return null;
    }
    flash(ride && ride.date !== n.value.date ? `Перенесено на ${fmtDate(n.value.date)}` : ride ? 'Сохранено ✓' : `${n.value.km != null ? `+${fmtActivityValue('bike', n.value.km)} км` : 'Поездка добавлена'} · ${fmtDate(n.value.date)}`);
    return n.value.date;
  }
}
async function deleteRide(ride) {
  const ok = await showDialog({
    title: 'Удалить поездку?',
    body: `<p>${esc(fmtDate(ride.date))}, <b>${esc(rideTitle(ride))}</b>.</p><p class="dialog__muted">Будет удалена только эта поездка; итог дня пересчитается.</p>`,
    actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
  });
  if (!ok) return false;
  if (!(await Storage.removeBikeRide(ride.id))) { await alertDialog('Поездка не найдена', '<p>Данные изменились. Ничего не удалено.</p>'); return false; }
  flash('Удалено');
  return true;
}

async function ActivityMetricScreen(metric) {
  const M = ACTIVITY_METRICS[metric];
  const today = dateKey();
  const saved = readEntryUi(`act-${metric}`) || {};
  const okDay = (d) => typeof d === 'string' && WL_DATE_RE.test(d) && d <= today;
  const ui = {
    kind: ACT_PERIOD_KINDS.includes(saved.kind) ? saved.kind : 'week',
    anchor: okDay(saved.anchor) ? saved.anchor : today,
    day: okDay(saved.day) ? saved.day : today,
  };
  const screen = el(`<div class="act act--${metric}"></div>`);
  const daySlot = el('<div></div>'), statsSlot = el('<section class="section act-stats" aria-labelledby="act-st-title"></section>'), recentSlot = el('<section class="section act-recent"></section>');
  screen.append(backHeader(M.title, { fallback: 'home' }), daySlot, statsSlot, recentSlot);
  let store, values, byDate;

  async function reload() {
    store = await Storage.getActivityStore(metric);
    values = dayValues(metric, store);
    byDate = metric === 'bike' ? ridesByDate(store) : null;
    paintAll();
  }
  function paintAll() { paintDay(); paintStats(); paintRecent(); }
  const remember = () => saveEntryUi(`act-${metric}`, { ...ui });

  /* 1. Выбранный день: значение, переход по дням, «Сегодня», добавить / изменить, журнал */
  function paintDay() {
    remember();
    const d = ui.day;
    const v = values[d] ?? null;
    const entry = metric === 'bike' ? null : store[d] || null;
    const rides = metric === 'bike' ? byDate.get(d) || [] : [];
    const val = v != null ? actValueHtml(metric, v) : rides.length ? NO_KM : 'Нет записи';
    let sub = '';
    if (entry) sub = dailySub(entry);
    else if (rides.length) sub = `${plRides(rides.length)}: ${rides.map((r) => esc(rideTitle(r))).join(', ')}`;
    const action = entry ? 'Изменить' : 'Добавить'; // у велосипеда — всегда новая поездка (правка — в журнале)
    const card = el(`
      <section class="card sleep-last act-day" aria-label="${esc(M.title)}: выбранный день">
        <div class="act-day__nav">
          <button class="cal-nav__btn sleep-nav__btn" type="button" data-dd="-1" aria-label="Предыдущий день">‹</button>
          <span class="act-day__when" aria-live="polite">${esc(sleepDayWord(d, today))}</span>
          ${d !== today ? '<button class="sleep-today" type="button" data-dtoday>Сегодня</button>' : ''}
          <button class="cal-nav__btn sleep-nav__btn" type="button" data-dd="1" aria-label="Следующий день" ${d >= today ? 'disabled' : ''}>›</button>
        </div>
        <p class="sleep-last__dur act-day__val">${val}</p>
        ${sub ? `<p class="sleep-last__meta act-day__sub">${sub}</p>` : ''}
        <div class="act-day__actions">
          <button class="btn-primary btn-primary--brand act-day__edit" type="button">${entry ? '' : homeIcon('plus')}<span>${action}</span></button>
          <a class="btn-ghost act-day__log" href="#/journals/${metric}/${d}">Журнал</a>
        </div>
      </section>
    `);
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dd], [data-dtoday]');
      if (!b || b.disabled) return;
      ui.day = b.hasAttribute('data-dtoday') ? today : sleepAddDays(d, Number(b.dataset.dd));
      if (ui.day > today) ui.day = today;
      paintDay();
    });
    $('.act-day__edit', card).addEventListener('click', async () => {
      const saved = metric === 'bike' ? await editRide(null, d) : await editDailyActivity(metric, { date: d, from: entry ? d : null, existing: entry });
      if (saved) { ui.day = saved; await reload(); }
    });
    daySlot.replaceChildren(card);
  }

  /* 2. Статистика выбранного периода: среднее, график, лучший день, минимум, дни с данными, сумма.
     Всё — из одного activityPeriodStats, поэтому смена периода пересчитывает все цифры сразу. */
  function paintStats() {
    remember();
    const b = periodBounds(ui.kind, ui.anchor);
    const next = shiftPeriod(b, 1);
    const st = activityPeriodStats(values, ui.kind, ui.anchor, today);
    const cmp = comparePrevPeriod(values, ui.kind, ui.anchor, today);
    statsSlot.innerHTML = '';
    statsSlot.appendChild(el('<div class="section__head"><h2 class="section__title" id="act-st-title">Статистика</h2></div>'));
    const seg = el(`<div class="st-period" role="group" aria-label="Период статистики">${SLEEP_KINDS.map(([k, t]) => `<button class="st-period__btn${k === ui.kind ? ' is-active' : ''}" type="button" data-k="${k}" aria-pressed="${k === ui.kind}">${t}</button>`).join('')}</div>`);
    seg.addEventListener('click', (e) => { const x = e.target.closest('[data-k]'); if (x && x.dataset.k !== ui.kind) { ui.kind = x.dataset.k; ui.anchor = today; paintStats(); } });
    const nav = el(`
      <div class="sleep-nav">
        <button class="cal-nav__btn sleep-nav__btn" type="button" data-d="-1" aria-label="Предыдущий период">‹</button>
        <span class="sleep-nav__title" aria-live="polite">${esc(sleepPeriodTitle(b))}</span>
        <button class="cal-nav__btn sleep-nav__btn" type="button" data-d="1" aria-label="Следующий период"${next.start > today ? ' disabled' : ''}>›</button>
      </div>
    `);
    nav.addEventListener('click', (e) => { const x = e.target.closest('[data-d]'); if (x && !x.disabled) { ui.anchor = shiftPeriod(b, Number(x.dataset.d)).start; paintStats(); } });
    statsSlot.append(seg, nav);

    if (!st.daysWithData) {
      statsSlot.appendChild(el(`
        <div class="card st-empty sleep-wait act-empty">
          <p class="st-empty__title">За этот период записей нет</p>
          <p class="st-empty__sub">Выберите другой период или добавьте запись — в журнале можно внести данные за любую прошлую дату.</p>
        </div>
      `));
      return;
    }
    const PREV = { week: 'прошлой неделей', month: 'прошлым месяцем', year: 'прошлым годом' };
    const card = el(`
      <div class="card st-card sleep-card act-card">
        <p class="sleep-kpi__label">В среднем за день</p>
        <p class="sleep-kpi__val act-avg">${actValueHtml(metric, st.average)}</p>
        <p class="sleep-kpi__sub">по ${st.daysWithData} ${daysDat(st.daysWithData)} с записями из ${st.elapsedDays}${cmp ? ` · ${cmp.delta >= 0 ? '+' : '−'}${esc(fmtActivity(metric, Math.abs(cmp.delta), { km: false }))} по сравнению с ${PREV[ui.kind]}` : ''}</p>
      </div>
    `);
    const bars = st.bars.map((x) => ({ start: dayNum(x.start), end: dayNum(x.end), value: x.value, src: x }));
    const xLabels = ui.kind === 'year'
      ? bars.map((x, i) => ({ day: x.start + 14, label: SLEEP_MONTHS[i] }))
      : ui.kind === 'week'
        ? bars.map((x, i) => ({ day: x.start, label: SLEEP_WD[i] }))
        : bars.filter((x) => [1, 5, 10, 15, 20, 25, 30].includes(Number(x.src.start.slice(8)))).map((x) => ({ day: x.start, label: String(Number(x.src.start.slice(8))) }));
    card.appendChild(svgBarChart({
      range: { start: dayNum(st.start), end: dayNum(st.end) }, bars, fit: false, xLabels,
      minSpan: metric === 'steps' ? 2000 : 2,
      color: 'var(--viz-1)',
      ariaLabel: `${M.title}, ${sleepPeriodTitle(b)}: в среднем ${fmtActivity(metric, st.average)} за день. Выберите столбец, чтобы увидеть значение.`,
      readout: (x) => {
        const s = x.src;
        if (s.kind === 'month') {
          const name = capFirst(new Date(`${s.start}T00:00:00`).toLocaleDateString(RU, { month: 'long' }));
          if (s.value == null) return `<span class="chart__rv chart__rv--muted">нет записей</span><span class="chart__rd">${esc(name)}</span>`;
          return `<span class="chart__rv">${esc(fmtActivity(metric, s.value))} <small>в среднем</small></span><span class="chart__rd">${esc(name)} · ${s.days} ${daysWord(s.days)} с записями · всего ${esc(fmtActivity(metric, s.total))}</span>`;
        }
        const dayTxt = capFirst(new Date(`${s.date}T00:00:00`).toLocaleDateString(RU, { weekday: 'short', day: 'numeric', month: 'short' }));
        if (s.value == null) return `<span class="chart__rv chart__rv--muted">нет записи</span><span class="chart__rd">${esc(dayTxt)}</span>`;
        const n = metric === 'bike' ? (byDate.get(s.date) || []).length : 0;
        return `<span class="chart__rv">${esc(fmtActivity(metric, s.value))}</span><span class="chart__rd">${esc(dayTxt)}${n ? ` · ${plRides(n)}` : ''}</span>`;
      },
    }));
    const best = st.max, min = st.min;
    /* в узкой плитке шаги — значение, расчётные км — вторичной строкой */
    const tileVal = (v) => esc(fmtActivity(metric, v, { km: false }));
    const tileSub = (v, text) => esc([metric === 'steps' ? fmtKmApprox(stepsToKm(v)) : '', text].filter(Boolean).join(' · '));
    card.appendChild(el(`
      <div class="sgrid sleep-grid act-grid">
        <div class="sgrid__item"><div class="sgrid__label">Лучший день</div><div class="sgrid__val act-best">${tileVal(best.value)}</div><div class="sgrid__sub">${tileSub(best.value, sleepDayMonth(best.date, today))}</div></div>
        <div class="sgrid__item"><div class="sgrid__label">Минимум</div><div class="sgrid__val act-min">${tileVal(min.value)}</div><div class="sgrid__sub">${tileSub(min.value, sleepDayMonth(min.date, today))}</div></div>
        <div class="sgrid__item"><div class="sgrid__label">Дней с данными</div><div class="sgrid__val act-days">${st.daysWithData} из ${st.elapsedDays}</div><div class="sgrid__sub">${esc(sleepPeriodTitle(b))}</div></div>
        <div class="sgrid__item"><div class="sgrid__label">Всего за период</div><div class="sgrid__val act-total">${tileVal(st.total)}</div><div class="sgrid__sub">${tileSub(st.total, 'сумма записанных дней')}</div></div>
      </div>
    `));
    card.appendChild(el(`<p class="st-note">Среднее, минимум и лучший день — только по дням с записями: пропущенный день не считается нулём.${ui.kind === 'year' ? ' Год показан по месяцам (среднее за день с записями); записи каждого дня сохраняются как есть.' : ''}${metric === 'bike' ? ' Итог дня — сумма дистанций всех поездок; поездки без дистанции в километры не входят.' : ''}</p>`));
    statsSlot.appendChild(card);
  }

  /* 3. Последние записи → журнал на дату записи */
  function paintRecent() {
    recentSlot.innerHTML = '';
    const head = el(`<div class="section__head"><h2 class="section__title">Последние записи</h2><a class="section__action" href="#/journals/${metric}">Журнал ›</a></div>`);
    const box = el('<div class="list-card"></div>');
    let items;
    if (metric === 'bike') {
      items = store.filter((r) => r.date <= today).slice(0, 5).map((r) => ({ date: r.date, title: rideTitle(r), trailing: '' }));
    } else {
      items = Object.keys(store).filter((d) => d <= today).sort().reverse().slice(0, 5).map((d) => ({ date: d, title: fmtActivity(metric, store[d][M.field]), trailing: '' }));
    }
    if (!items.length) box.appendChild(el(`<div class="empty">Записей пока нет. Добавьте первую — за сегодня или любую прошлую дату.</div>`));
    items.forEach((x) => {
      box.appendChild(el(`
        <a class="row act-row" href="#/journals/${metric}/${x.date}">
          <div class="row__body"><p class="row__title">${esc(x.title)}</p><p class="row__sub">${esc(capFirst(sleepDayMonth(x.date, today)))}</p></div>
          <span class="row__chevron" aria-hidden="true">›</span>
        </a>
      `));
    });
    recentSlot.append(head, box);
  }

  await reload();
  return screen;
}

/* Журнал шагов / поездок — тот же журнал, что у воды */
async function ActivityLogScreen(metric, param) {
  const M = ACTIVITY_METRICS[metric];
  const screen = el(`<div class="act-log act-log--${metric}"></div>`);
  const today = dateKey();
  let { month, focusDay } = journalState(param, today);
  const go = (m, d = null) => { month = m; focusDay = d; replaceUrl(`${M.logRoute}/${d || m}`); paint(); };
  const after = async (saved) => { if (saved) go(saved.slice(0, 7), saved); };

  async function paint() {
    const store = await Storage.getActivityStore(metric);
    screen.innerHTML = '';
    screen.appendChild(backHeader(ACT_JOURNAL_TITLE[metric], { fallback: M.route }));
    let days, summary;
    const byDate = metric === 'bike' ? ridesByDate(store) : null;
    if (metric === 'bike') {
      days = [...byDate.keys()].filter((d) => d.startsWith(`${month}-`)).sort().reverse();
      const rides = days.reduce((s, d) => s + byDate.get(d).length, 0);
      const kmDays = days.map((d) => rideDayKm(byDate.get(d))).filter((x) => x != null);
      const km = kmDays.reduce((s, x) => s + x, 0);
      summary = `За месяц: ${plRides(rides)} · ${days.length} ${plural(days.length, 'день', 'дня', 'дней')} · ${kmDays.length ? esc(fmtActivity('bike', km)) : NO_KM.toLowerCase()}`;
    } else {
      days = Object.keys(store).filter((d) => d.startsWith(`${month}-`)).sort().reverse();
      const total = days.reduce((s, d) => s + store[d][M.field], 0);
      summary = `За месяц: ${days.length} ${plural(days.length, 'день', 'дня', 'дней')} с записями${days.length ? ` · всего ${esc(fmtActivity(metric, total))} · в среднем ${esc(fmtActivity(metric, total / days.length))} за день` : ''}`;
    }
    screen.appendChild(journalControls({
      prefix: 'jr', month, focusDay, today, summary,
      addLabel: metric === 'bike' ? '+ Добавить поездку' : '+ Добавить запись',
      onGo: go,
      onAdd: async () => after(metric === 'bike' ? await editRide(null, focusDay || today) : await editDailyActivity(metric, { date: focusDay || today })),
    }));
    if (!days.length) screen.appendChild(el(`<p class="empty">В этом месяце записей нет.</p>`));
    journalFocus(screen, 'jr', focusDay, days.includes(focusDay));

    days.forEach((d) => {
      if (metric === 'bike') {
        const list = byDate.get(d);
        const km = rideDayKm(list);
        const sec = journalDay({ prefix: 'jr', date: d, focus: d === focusDay, totalHtml: km != null ? esc(fmtActivity('bike', km)) : `<span class="jday__nokm">${NO_KM}</span>` });
        list.forEach((r) => $('.list-card', sec).appendChild(journalRow({
          titleHtml: esc(rideTitle(r)), subHtml: rideSub(r), label: rideTitle(r),
          onEdit: async () => after(await editRide(r)),
          onDelete: async () => { if (await deleteRide(r)) go(month, d); },
        })));
        screen.appendChild(sec);
      } else {
        const e = store[d];
        const sec = journalDay({ prefix: 'jr', date: d, focus: d === focusDay, totalHtml: esc(fmtActivity(metric, e[M.field])) });
        $('.list-card', sec).appendChild(journalRow({
          titleHtml: esc(fmtActivity(metric, e[M.field])), subHtml: dailySub(e), label: fmtDate(d),
          onEdit: async () => after(await editDailyActivity(metric, { date: d, from: d, existing: e })),
          onDelete: async () => { if (await deleteDailyActivity(metric, d, e)) go(month, d); },
        }));
        screen.appendChild(sec);
      }
    });
  }

  await paint();
  return screen;
}

/* Журнал сна (#/sleep-log[/ГГГГ-ММ | /ГГГГ-ММ-ДД]) — тот же журнал. День — дата пробуждения;
   ✎ открывает форму записи (там же меняется дата), «+ Добавить» — форму на выбранную дату.
   Форма после сохранения / удаления возвращается сюда (SleepFormScreen: backTo). */
async function SleepLogScreen(param) {
  const screen = el('<div class="sleep-log"></div>');
  const today = dateKey();
  let { month, focusDay } = journalState(param, today);
  const go = (m, d = null) => { month = m; focusDay = d; replaceUrl(`sleep-log/${d || m}`); paint(); };

  async function paint() {
    const entries = await Storage.getSleepEntries();
    const inMonth = entries.filter((e) => e.date.startsWith(`${month}-`));
    const days = [...new Set(inMonth.map((e) => e.date))].sort().reverse();
    const avg = inMonth.length ? averageSleep(inMonth) : null;
    screen.innerHTML = '';
    screen.appendChild(backHeader('Журнал сна', { fallback: 'sleep' }));
    screen.appendChild(journalControls({
      prefix: 'jr', month, focusDay, today, onGo: go,
      summary: `За месяц: ${inMonth.length} ${plural(inMonth.length, 'запись', 'записи', 'записей')}${avg != null ? ` · в среднем ${esc(formatSleepDuration(avg))}` : ''}`,
      onAdd: () => { location.hash = `#/sleep/new/${focusDay || today}`; },
    }));
    if (!days.length) screen.appendChild(el('<p class="empty">В этом месяце записей сна нет.</p>'));
    journalFocus(screen, 'jr', focusDay, days.includes(focusDay));
    days.forEach((d) => {
      const list = inMonth.filter((e) => e.date === d);
      const sec = journalDay({ prefix: 'jr', date: d, focus: d === focusDay, totalHtml: esc(formatSleepDuration(list[0].durationMinutes)) });
      list.forEach((e) => {
        const q = qualityInfo(e.quality);
        const sub = [q ? `${q.emoji} ${esc(q.label)}` : '', esc(sleepMeta(e))].filter(Boolean).join(' · ');
        $('.list-card', sec).appendChild(journalRow({
          titleHtml: `${esc(formatSleepDuration(e.durationMinutes))} · ${esc(sleepTimes(e))}`, subHtml: sub, label: sleepTimes(e),
          onEdit: () => { location.hash = `#/sleep/${encodeURIComponent(e.id)}`; },
          onDelete: async () => {
            const ok = await showDialog({
              title: 'Удалить запись сна?',
              body: `<p>${esc(fmtDate(d))}: <b>${esc(formatSleepDuration(e.durationMinutes))}</b>, ${esc(sleepTimes(e))}.</p><p class="dialog__muted">Будет удалена только эта запись.</p>`,
              actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
            });
            if (!ok) return;
            try { if (!(await Storage.removeSleepEntry(e.id))) { await alertDialog('Запись не найдена', '<p>Данные изменились. Ничего не удалено.</p>'); } else flash('Удалено'); } catch { flash('Не удалось удалить'); }
            go(month, d);
          },
        }));
      });
      screen.appendChild(sec);
    });
  }

  await paint();
  return screen;
}

/* =========================================================
   Обхват талии (#/metric/waist) — модуль раздела «Показатели» (services/waist.js, ключ waist_log).
   Шапка: «Назад» · «Обхват талии» · «+». Периоды НЕД · МЕС · 6 МЕС · ГОД (те же календарные
   окна и переключатель, что у статистики воды), крупно — последнее измерение, линейный график
   периода (ui/charts.js lineChart: шкала Y по данным, не от нуля), «Последнее» и «Изменение»
   (последнее − первое измерение периода, без оценки), «Журнал измерений ›» → «Все журналы».
   Пустое состояние — без «0 см». Период и смещение ‹ › — в записи истории (saveEntryUi).
   ========================================================= */
const WAIST_KIND_LABEL = { week: 'НЕД', month: 'МЕС', '6m': '6 МЕС', year: 'ГОД' };

/* Добавить (current == null) или изменить / перенести / удалить измерение.
   Дата занята → «Заменить?» (за день одно измерение). → { date } | { deleted: true, date } | null */
async function editWaist({ date = dateKey(), current = null } = {}) {
  const today = dateKey();
  let v = { date, value: current ? fmtCm(current.cm) : '' };
  for (;;) {
    let raw = null;
    const choice = await showDialog({
      title: current ? 'Обхват талии' : 'Новое измерение',
      body: `
        <label class="field__label" for="ws-d">Дата</label>
        <input class="input" type="date" id="ws-d" value="${esc(v.date)}" max="${esc(today)}">
        <label class="field__label" for="ws-v" style="margin-top:10px">Обхват талии, см</label>
        <input class="input" type="text" id="ws-v" inputmode="decimal" autocomplete="off" value="${esc(v.value)}" placeholder="92,5">
        <p class="dialog__muted" style="margin:8px 0 0">За день хранится одно измерение. Можно указать любую прошлую дату.</p>
      `,
      actions: [
        { label: 'Отмена', value: false },
        ...(current ? [{ label: 'Удалить', value: 'delete', kind: 'danger' }] : []),
        { label: 'Сохранить', value: true, kind: 'primary', onClick: () => { raw = { date: $('#ws-d').value, value: $('#ws-v').value }; } },
      ],
      cancelValue: false,
    });
    if (choice === 'delete') return (await deleteWaist(date, current)) ? { deleted: true, date } : null;
    if (!choice || !raw) return null;
    const n = normalizeWaistInput(raw, { today });
    if (!n.ok) { await alertDialog('Измерение не сохранено', actErrorsHtml(n.errors)); v = raw; continue; }
    const from = current ? date : null;
    try {
      await Storage.saveWaist(n.value, { from });
    } catch (err) {
      if (!(err instanceof EntryStoreError)) throw err;
      if (err.code !== 'DUPLICATE_DATE') { await alertDialog(err.code === 'NOT_FOUND' ? 'Измерение не найдено' : 'Измерение не сохранено', `<p>${esc(err.message)}</p>`); return null; }
      const old = err.existing || {};
      const replace = await showDialog({
        title: 'За эту дату уже есть измерение',
        body: `<p>${esc(fmtDate(n.value.date))}: <b>${esc(fmtWaist(old.cm))}</b>.</p><p>Изменить его на <b>${esc(fmtWaist(n.value.cm))}</b>?</p><p class="dialog__muted">Второго измерения за ту же дату не будет.</p>`,
        actions: [{ label: 'Отмена', value: false }, { label: 'Изменить', value: true, kind: 'primary' }],
      });
      if (!replace) return null;
      try { await Storage.saveWaist(n.value, { from, overwrite: true }); } catch (e2) { await alertDialog('Измерение не сохранено', `<p>${esc(e2.message)}</p>`); return null; }
    }
    flash(from && from !== n.value.date ? `Перенесено на ${fmtDate(n.value.date)}` : from ? 'Сохранено ✓' : `${fmtWaist(n.value.cm)} · ${fmtDate(n.value.date)}`);
    return { date: n.value.date };
  }
}
async function deleteWaist(date, entry) {
  const ok = await showDialog({
    title: 'Удалить измерение?',
    body: `<p>${esc(fmtDate(date))}: <b>${esc(fmtWaist(entry && entry.cm))}</b>.</p><p class="dialog__muted">Будет удалено измерение только этого дня.</p>`,
    actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
  });
  if (!ok) return false;
  if (!(await Storage.removeWaist(date))) { await alertDialog('Измерение не найдено', '<p>Данные изменились. Ничего не удалено.</p>'); return false; }
  flash('Удалено');
  return true;
}

/* шапка внутреннего экрана с кнопкой «+» справа (как «Сон» с кнопкой настроек) */
function addHeader(title, { fallback, addLabel, onAdd }) {
  const header = el(`
    <header class="header header--nav sleep-header">
      <div class="sleep-header__row">
        <h1 class="header__title"></h1>
        <button class="sleep-gear hdr-add" type="button" aria-label="${esc(addLabel)}">${homeIcon('plus')}</button>
      </div>
    </header>
  `);
  $('.header__title', header).textContent = title;
  $('.hdr-add', header).addEventListener('click', onAdd);
  header.prepend(BackButton({ fallback }));
  return header;
}

async function WaistScreen() {
  const saved = readEntryUi('waist');
  let ui = saved && typeof saved === 'object' && WAIST_PERIOD_KINDS.includes(saved.k)
    ? { kind: saved.k, offset: Math.min(0, Math.trunc(saved.o) || 0) }
    : { kind: 'month', offset: 0 };
  let segFrom = null;
  let log = {};
  const screen = el('<div class="waist"></div>');
  const body = el('<div></div>');
  const add = async () => { const r = await editWaist({ date: dateKey() }); if (r) { ui = { ...ui, offset: 0 }; await reload(); } };
  screen.append(addHeader('Обхват талии', { fallback: 'metrics', addLabel: 'Добавить измерение', onAdd: add }), body);

  async function reload() { log = await Storage.getWaistLog(); paint(); }

  function paint() {
    saveEntryUi('waist', { k: ui.kind, o: ui.offset });
    const today = dateKey();
    const latest = latestWaist(log, today);
    body.innerHTML = '';
    if (!latest) {
      const empty = el(`
        <section class="med-empty waist-empty">
          <span class="med-empty__icon" aria-hidden="true">${homeIcon('waist')}</span>
          <h2 class="med-empty__title">Пока нет измерений</h2>
          <p class="med-empty__text">Записывайте обхват талии за сегодня или любую прошлую дату — здесь появятся график и изменение за период.</p>
          <button class="btn-primary btn-primary--brand med-empty__add waist-first" type="button">${homeIcon('plus')}<span>Добавить первое измерение</span></button>
        </section>
      `);
      $('.waist-first', empty).addEventListener('click', add);
      body.appendChild(empty);
      return;
    }
    const P = waistPeriod(log, ui.kind, ui.offset, today);
    const win = P.win;
    const stats = el('<section class="section hstats waist-stats" aria-label="Обхват талии: динамика"></section>');
    const segFromNow = segFrom;
    segFrom = null;
    stats.appendChild(PeriodSelector({
      kinds: WAIST_PERIOD_KINDS.map((k) => ({ id: k, label: WAIST_KIND_LABEL[k], title: PERIOD_NAME[k] })),
      active: win.kind,
      onChange: (k) => { segFrom = ui.kind; ui = { kind: k, offset: 0 }; paint(); },
      prev: segFromNow,
    }));
    stats.appendChild(MetricHeader({ caption: 'Последнее измерение', value: fmtCm(latest.cm), unit: 'см', range: fmtDate(latest.date) }));

    const card = el(`
      <div class="card waist-card">
        <div class="waist-period"><span class="waist-period__range" aria-live="polite"></span></div>
        <div class="waist-chart"></div>
      </div>
    `);
    $('.waist-period__range', card).textContent = win.range;
    const shift = (d) => { ui = { ...ui, offset: Math.min(0, ui.offset + d) }; paint(); };
    $('.waist-period', card).appendChild(PeriodNavigator({ hasNext: win.hasNext, onPrev: () => shift(-1), onNext: () => shift(1) }));
    const chartBox = $('.waist-chart', card);
    if (!P.points.length) {
      chartBox.appendChild(el('<p class="empty waist-chart__empty">Нет измерений за этот период</p>'));
    } else {
      const xLabels = win.kind === 'week' || win.kind === '6m' || win.kind === 'year'
        ? win.buckets.map((b) => ({ day: dayNum(b.start) + (win.kind === 'week' ? 0 : 14), label: b.label }))
        : null;
      chartBox.appendChild(lineChart({
        range: { start: dayNum(win.start), end: dayNum(win.end) }, fit: false, xLabels, minSpan: 2,
        series: [{ key: 'waist', label: 'Обхват талии', color: 'var(--viz-1)', points: P.points.map((p) => ({ day: dayNum(p.date), value: p.cm })) }],
        ariaLabel: `Обхват талии, ${win.range}: ${P.points.length} ${plural(P.points.length, 'измерение', 'измерения', 'измерений')}. Выберите точку, чтобы увидеть значение и дату.`,
        readout: (day) => {
          const p = P.points.find((x) => dayNum(x.date) === day);
          return p ? `<span class="chart__rv">${esc(fmtWaist(p.cm))}</span><span class="chart__rd">${esc(fmtDate(p.date))}</span>` : '';
        },
      }));
    }
    const changeSub = P.change != null ? `${fmtDate(P.first.date)} → ${fmtDate(P.last.date)}` : P.points.length === 1 ? 'в периоде одно измерение' : 'нет измерений в периоде';
    card.appendChild(el(`
      <div class="sgrid waist-grid">
        <div class="sgrid__item"><div class="sgrid__label">Последнее</div><div class="sgrid__val waist-last">${esc(P.last ? fmtWaist(P.last.cm) : '—')}</div><div class="sgrid__sub">${esc(P.last ? fmtDate(P.last.date) : 'нет измерений в периоде')}</div></div>
        <div class="sgrid__item"><div class="sgrid__label">Изменение</div><div class="sgrid__val waist-change">${esc(fmtWaistChange(P.change))}</div><div class="sgrid__sub">${esc(changeSub)}</div></div>
      </div>
    `));
    card.appendChild(el('<p class="st-note">Изменение — разница между первым и последним измерением выбранного периода.</p>'));
    stats.appendChild(card);
    body.appendChild(stats);

    body.appendChild(el(`
      <section class="section">
        <div class="list-card">
          <a class="row act-row waist-journal" href="#/journals/waist">
            <div class="row__body"><p class="row__title">Журнал измерений</p><p class="row__sub">${Object.keys(log).length} ${plural(Object.keys(log).length, 'измерение', 'измерения', 'измерений')} · добавить, изменить, удалить</p></div>
            <span class="row__chevron" aria-hidden="true">›</span>
          </a>
        </div>
      </section>
    `));
  }

  await reload();
  return screen;
}

/* =========================================================
   Тренировки (#/workouts, пункт бокового меню) — журнал Планки и «Другого упражнения»
   (services/workouts.js, ключ workouts_log). Шаги, велосипед, сон и вода — свои разделы,
   сюда не входят. Записи по дням (новые сверху) — те же карточки, что во «Всех журналах»;
   запись → форма: изменить / удалить. Старые планка и «другое» из прежней «Активности»
   перенесены сюда при запуске (Storage._migrateWorkouts).
   ========================================================= */

/* «+ Добавить тренировку»: сначала тип, затем форма. → дата | null */
async function addWorkoutFlow(date = dateKey()) {
  const kind = await showDialog({
    title: 'Добавить тренировку',
    body: '<p class="dialog__muted" style="margin:0">Выберите тип тренировки.</p>',
    actions: [
      { label: WORKOUT_TITLES.plank, value: 'plank', kind: 'primary' },
      { label: WORKOUT_TITLES.other, value: 'other', kind: 'primary' },
      { label: 'Отмена', value: false },
    ],
    stack: true,
    cancelValue: false,
  });
  return kind ? editWorkout(null, { kind, date }) : null;
}

/* Форма тренировки: новая (kind, date) или правка w (дата, поля, заметка; тип не меняется).
   Ошибка ввода → форма снова с введёнными значениями. → дата | { deleted: true } | null */
async function editWorkout(w, { kind = w ? w.kind : 'plank', date = dateKey() } = {}) {
  const today = dateKey();
  const names = [...new Set([...WORKOUT_NAME_SUGGESTIONS, ...(await Storage.getWorkouts()).filter((x) => x.kind === 'other').map((x) => x.name)])];
  let v = w
    ? { date: w.date, sets: w.sets ?? '', seconds: w.seconds ?? '', name: w.name || '', minutes: w.minutes ?? '', note: w.note || '' }
    : { date, sets: '', seconds: '', name: '', minutes: '', note: '' };
  const plankHint = (sets, seconds) => {
    const a = parseWorkoutInt(sets), b = parseWorkoutInt(seconds);
    return Number.isInteger(a) && Number.isInteger(b) && a > 0 && b > 0 ? `Всего: ${a} × ${b} = ${a * b} сек${a * b >= 60 ? ` (${fmtSeconds(a * b)})` : ''}` : '';
  };
  for (;;) {
    let raw = null;
    const fields = kind === 'plank'
      ? `<label class="field__label" for="wo-sets" style="margin-top:10px">Количество подходов</label>
         <input class="input" type="text" id="wo-sets" inputmode="numeric" autocomplete="off" value="${esc(v.sets)}" placeholder="3">
         <label class="field__label" for="wo-sec" style="margin-top:10px">Секунд в подходе</label>
         <input class="input" type="text" id="wo-sec" inputmode="numeric" autocomplete="off" value="${esc(v.seconds)}" placeholder="60">
         <p class="dialog__muted wo-total" id="wo-total" aria-live="polite" style="margin:6px 0 0">${esc(plankHint(v.sets, v.seconds))}</p>`
      : `<label class="field__label" for="wo-name" style="margin-top:10px">Название упражнения</label>
         <input class="input" type="text" id="wo-name" list="wo-names" maxlength="${WORKOUT_NAME_MAX}" autocomplete="off" value="${esc(v.name)}" placeholder="Отжимания">
         <datalist id="wo-names">${names.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
         <label class="field__label" for="wo-min" style="margin-top:10px">Длительность, минут</label>
         <input class="input" type="text" id="wo-min" inputmode="numeric" autocomplete="off" value="${esc(v.minutes)}" placeholder="15">`;
    const pending = showDialog({
      title: w ? workoutTitle(w) : kind === 'plank' ? 'Планка' : 'Другое упражнение',
      body: `
        <label class="field__label" for="wo-d">Дата</label>
        <input class="input" type="date" id="wo-d" value="${esc(v.date)}" max="${esc(today)}">
        ${fields}
        <label class="field__label" for="wo-note" style="margin-top:10px">Заметка (необязательно)</label>
        <input class="input" type="text" id="wo-note" maxlength="${WORKOUT_NOTE_MAX}" value="${esc(v.note)}">
      `,
      actions: [
        { label: 'Отмена', value: false },
        ...(w ? [{ label: 'Удалить', value: 'delete', kind: 'danger' }] : []),
        {
          label: 'Сохранить', value: true, kind: 'primary',
          onClick: () => {
            raw = { kind, date: $('#wo-d').value, note: $('#wo-note').value };
            if (kind === 'plank') Object.assign(raw, { sets: $('#wo-sets').value, seconds: $('#wo-sec').value });
            else Object.assign(raw, { name: $('#wo-name').value, minutes: $('#wo-min').value });
          },
        },
      ],
      cancelValue: false,
    });
    if (kind === 'plank') {
      const upd = () => { $('#wo-total').textContent = plankHint($('#wo-sets').value, $('#wo-sec').value); };
      $('#wo-sets').addEventListener('input', upd);
      $('#wo-sec').addEventListener('input', upd);
    }
    const choice = await pending;
    if (choice === 'delete') return (await deleteWorkout(w)) ? { deleted: true } : null;
    if (!choice || !raw) return null;
    const n = normalizeWorkoutInput(raw, { today });
    if (!n.ok) { await alertDialog('Тренировка не сохранена', actErrorsHtml(n.errors)); v = { ...v, ...raw }; continue; }
    try {
      if (w) {
        if (!(await Storage.updateWorkout(w.id, n.value))) { await alertDialog('Тренировка не найдена', '<p>Данные изменились, пока была открыта форма. Ничего не изменено.</p>'); return null; }
      } else {
        await Storage.addWorkout(n.value);
      }
    } catch (err) {
      if (!(err instanceof EntryStoreError)) throw err;
      await alertDialog('Тренировка не сохранена', `<p>${esc(err.message)}</p>`);
      return null;
    }
    flash(w && w.date !== n.value.date ? `Перенесено на ${fmtDate(n.value.date)}` : w ? 'Сохранено ✓' : `${workoutTitle(n.value)} · ${fmtDate(n.value.date)}`);
    return n.value.date;
  }
}
async function deleteWorkout(w) {
  const ok = await showDialog({
    title: 'Удалить тренировку?',
    body: `<p>${esc(fmtDate(w.date))}: <b>${esc(workoutTitle(w))}</b>, ${esc(workoutValue(w))}.</p><p class="dialog__muted">Будет удалена только эта запись.</p>`,
    actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
  });
  if (!ok) return false;
  if (!(await Storage.removeWorkout(w.id))) { await alertDialog('Тренировка не найдена', '<p>Данные изменились. Ничего не удалено.</p>'); return false; }
  flash('Удалено');
  return true;
}

async function WorkoutsScreen() {
  const today = dateKey();
  const ui = readEntryUi('workouts');
  let limit = ui && Number.isInteger(ui.limit) && ui.limit > 0 ? ui.limit : JOURNAL_PAGE_DAYS;
  const types = [journalType('workout')];
  const screen = el('<div class="workouts"></div>');
  screen.appendChild(backHeader('Тренировки', { fallback: 'home' }));
  const tools = el('<div class="jtools"></div>');
  const list = el('<div class="jlist"></div>');
  screen.append(tools, list);
  let groups = [];
  const remember = () => saveEntryUi('workouts', { limit });

  async function reload() {
    groups = groupJournal(buildJournal({ workouts: await Storage.getWorkouts() }, {}, types), { today });
    paint();
  }
  /* после правки / удаления / добавления — перечитать на месте (та же прокрутка) */
  async function after(res) {
    if (!res) return;
    const y = window.scrollY;
    await reload();
    const d = typeof res === 'string' ? res : null;
    const i = d ? groups.findIndex((g) => g.date === d) : -1;
    if (i >= limit) { limit = i + 1; paint(); }
    window.scrollTo(0, y);
  }
  const addNew = async () => after(await addWorkoutFlow(today));

  function paint() {
    remember();
    tools.innerHTML = '';
    list.innerHTML = '';
    if (!groups.length) {
      const empty = el(`
        <section class="med-empty workouts-empty">
          <span class="med-empty__icon" aria-hidden="true">${homeIcon('workout')}</span>
          <h2 class="med-empty__title">Пока нет тренировок</h2>
          <p class="med-empty__text">Планка или любое упражнение — за сегодня или прошлую дату.</p>
          <button class="btn-primary btn-primary--brand med-empty__add workouts-first" type="button">${homeIcon('plus')}<span>Добавить первую тренировку</span></button>
        </section>
      `);
      $('.workouts-first', empty).addEventListener('click', addNew);
      list.appendChild(empty);
      return;
    }
    const addBtn = el(`<button class="btn-primary btn-primary--brand jtools__add workouts-add" type="button">${homeIcon('plus')}<span>Добавить тренировку</span></button>`);
    addBtn.addEventListener('click', addNew);
    tools.appendChild(addBtn);
    const shown = visibleDays(groups, limit);
    shown.forEach((g) => {
      const sec = el(`
        <section class="jgroup" data-date="${g.date}">
          <h2 class="jgroup__head"><span class="jgroup__day"></span> <span class="jgroup__sum"><span class="jgroup__dot" aria-hidden="true">•</span> <span class="jgroup__val"></span></span></h2>
          <div class="jcards"></div>
        </section>
      `);
      $('.jgroup__day', sec).textContent = g.label;
      $('.jgroup__val', sec).textContent = g.summary;
      g.items.forEach((it) => $('.jcards', sec).appendChild(journalCard(it, async (x) => after(await editWorkout(x.ref.workout)))));
      list.appendChild(sec);
    });
    if (shown.length < groups.length) {
      const rest = groups.length - shown.length;
      const more = el(`<button class="btn-ghost jmore" type="button">Показать ещё · ${rest} ${plural(rest, 'день', 'дня', 'дней')}</button>`);
      more.addEventListener('click', () => { limit += JOURNAL_PAGE_DAYS; paint(); });
      list.appendChild(more);
    }
  }

  await reload();
  return screen;
}

/* =========================================================
   Все журналы (#/journals[/<тип>[/ГГГГ-ММ-ДД]]) — единый журнал всех записей.
   Данные — те же ключи Storage, что у разделов: services/journals.js превращает их при чтении
   в одинаковые элементы (отдельного хранилища нет). Здесь — только общий UI и действия по типу:
   нажатие на запись открывает существующий редактор этого типа (вода / шаги / поездка /
   значение показателя — диалог с «Удалить»; сон — форма записи сна). После правки или удаления
   журнал перечитывается на месте: итог дня пересчитывается, пустой день исчезает.
   Фильтр — в адресе (#/journals/water), число показанных дней — в записи истории
   (saveEntryUi), прокрутка — общая (history.state.y): «Назад» из формы возвращает тот же вид.
   Раздел (Вода / Сон / Шаги / Велосипед / показатель) → «Журнал» → этот же экран с фильтром.
   ========================================================= */

/* Значение точечного показателя дня: добавить (current == null), изменить, перенести на другую
   дату, удалить. За день одно значение (metrics_log) — занятая дата → «Заменить?».
   → { date } | { deleted: true } | null */
async function editPointMetric(key, { date = dateKey(), current = null } = {}) {
  const M = METRICS[key];
  const isP = M.kind === 'pressure';
  const today = dateKey();
  let v = { date, a: current == null ? '' : isP ? current.systolic : current, b: current != null && isP ? current.diastolic : '' };
  for (;;) {
    let raw = null;
    const valueField = isP
      ? `<div class="jpm__pair">
           <label><span class="field__label">Верхнее</span><input class="input" type="text" id="jpm-a" inputmode="numeric" autocomplete="off" value="${esc(v.a)}"></label>
           <label><span class="field__label">Нижнее</span><input class="input" type="text" id="jpm-b" inputmode="numeric" autocomplete="off" value="${esc(v.b)}"></label>
         </div>`
      : `<label class="field__label" for="jpm-a" style="margin-top:10px">${esc(M.name)}, ${esc(M.unit)}</label>
         <input class="input" type="text" id="jpm-a" inputmode="decimal" autocomplete="off" value="${esc(String(v.a).replace('.', ','))}">`;
    const choice = await showDialog({
      title: current == null ? `${M.name}: новая запись` : M.name,
      body: `
        <label class="field__label" for="jpm-d">Дата</label>
        <input class="input" type="date" id="jpm-d" value="${esc(v.date)}" max="${esc(today)}">
        ${valueField}
        <p class="dialog__muted" style="margin:8px 0 0">За день хранится одно значение.</p>
      `,
      actions: [
        { label: 'Отмена', value: false },
        ...(current != null ? [{ label: 'Удалить', value: 'delete', kind: 'danger' }] : []),
        { label: current == null ? 'Добавить' : 'Сохранить', value: true, kind: 'primary', onClick: () => { raw = { date: $('#jpm-d').value, a: $('#jpm-a').value, b: isP ? $('#jpm-b').value : '' }; } },
      ],
      cancelValue: false,
    });
    if (choice === 'delete') {
      const ok = await showDialog({
        title: 'Удалить запись?',
        body: `<p>${esc(fmtDate(date))}: <b>${esc(fmtMetric(key, current))} ${esc(M.unit)}</b>.</p><p class="dialog__muted">Будет удалено значение только этого дня.</p>`,
        actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
      });
      if (!ok) return null;
      if (!(await Storage.removeMetricValue(key, date))) { await alertDialog('Запись не найдена', '<p>Данные изменились. Ничего не удалено.</p>'); return null; }
      flash('Удалено');
      return { deleted: true, date };
    }
    if (!choice || !raw) return null;
    const num = (x) => (String(x).trim() === '' ? NaN : Number(String(x).trim().replace(',', '.')));
    const a = num(raw.a);
    const b = num(raw.b);
    const okDate = WL_DATE_RE.test(raw.date) && raw.date <= today;
    const okVal = isP ? Number.isInteger(a) && Number.isInteger(b) && a >= 40 && a <= 300 && b >= 20 && b <= 250 : a > 0 && a < 10000;
    if (!okDate || !okVal) {
      await alertDialog('Запись не сохранена', `<p>Укажите дату не позже сегодняшней и ${isP ? 'давление целыми числами (верхнее 40–300, нижнее 20–250)' : 'значение больше нуля'}.</p>`);
      v = raw;
      continue;
    }
    const value = isP ? { systolic: a, diastolic: b } : Math.round(a * 100) / 100;
    if (raw.date !== date || current == null) {
      const busy = await Storage.getMetricValue(key, raw.date);
      if (busy != null) {
        const replace = await showDialog({
          title: 'За эту дату уже есть запись',
          body: `<p>${esc(fmtDate(raw.date))}: <b>${esc(fmtMetric(key, busy))} ${esc(M.unit)}</b>.</p><p>Заменить на <b>${esc(fmtMetric(key, value))} ${esc(M.unit)}</b>?</p>`,
          actions: [{ label: 'Отмена', value: false }, { label: 'Заменить', value: true, kind: 'primary' }],
        });
        if (!replace) return null;
      }
    }
    if (current == null) await Storage.setMetricValue(key, value, raw.date);
    else if (!(await Storage.moveMetricValue(key, date, raw.date, value))) { await alertDialog('Запись не найдена', '<p>Данные изменились, пока была открыта форма. Ничего не изменено.</p>'); return null; }
    flash(current != null && raw.date !== date ? `Перенесено на ${fmtDate(raw.date)}` : current != null ? 'Сохранено ✓' : `${fmtMetric(key, value)} ${M.unit} · ${fmtDate(raw.date)}`);
    return { date: raw.date };
  }
}

/* Действия по типу записи. open(item) / add(date) → что-то (запись изменена — журнал перечитать)
   | null (отменено или открыт другой экран). month — журнал типа по месяцам (итоги месяца,
   исправление серии WaterMinder). Новый тип — новая строка здесь и провайдер в journals.js. */
const JOURNAL_ACTIONS = {
  water: {
    month: 'water-log',
    add: (date) => addWaterEntryDialog(date),
    open: (it) => {
      if (it.ref.legacy) { location.hash = `#/water-log/${it.ref.date}`; return null; }
      return editWaterEntry(it.ref.date, it.ref.entry, it.ref.index, { withDelete: true });
    },
  },
  sleep: {
    month: 'sleep-log',
    add: (date) => { location.hash = `#/sleep/new/${date}`; return null; },
    open: (it) => { location.hash = `#/sleep/${encodeURIComponent(it.ref.id)}`; return null; },
  },
  steps: {
    month: 'steps-log',
    add: (date) => editDailyActivity('steps', { date }),
    open: (it) => editDailyActivity('steps', { date: it.ref.date, from: it.ref.date, existing: it.ref.entry, withDelete: true }),
  },
  bike: {
    month: 'bike-log',
    add: (date) => editRide(null, date),
    open: (it) => editRide(it.ref.ride, it.ref.date, { withDelete: true }),
  },
};
JOURNAL_ACTIONS.waist = {
  add: (date) => editWaist({ date }),
  open: (it) => editWaist({ date: it.ref.date, current: it.ref.entry }),
};
JOURNAL_ACTIONS.workout = {
  add: (date) => addWorkoutFlow(date),
  open: (it) => editWorkout(it.ref.workout),
};
POINT_JOURNAL_KEYS.forEach((k) => {
  JOURNAL_ACTIONS[k] = {
    add: (date) => editPointMetric(k, { date }),
    open: (it) => editPointMetric(k, { date: it.ref.date, current: it.ref.value }),
  };
});

/* Все элементы журнала из уже прочитанных данных (Главная читает их сама) или из Storage */
async function loadJournalItems() {
  const [metricsLog, waterGoal, sleep, sleepSettings, steps, bike, waist, workouts] = await Promise.all([
    Storage.getMetricsLog(), Storage.getWaterGoal(), Storage.getSleepEntries(), Storage.getSleepSettings(),
    Storage.getDailyActivityLog('steps'), Storage.getBikeRides(), Storage.getWaistLog(), Storage.getWorkouts(),
  ]);
  return buildJournal({ metricsLog, sleep, steps, bike, waist, workouts }, { waterGoal, sleepGoal: sleepSettings.goalMinutes });
}

/* Кольцо прогресса (цель дня): доля до 100 %, сверх цели — полное кольцо */
function journalRing(pct) {
  const r = 15, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(pct, 100)) / 100;
  return `<svg class="jring" viewBox="0 0 36 36" aria-hidden="true"><circle class="jring__track" cx="18" cy="18" r="${r}"/><circle class="jring__fill" cx="18" cy="18" r="${r}" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 18 18)"/></svg>`;
}
/* Карточка записи — одна на все типы: значок · «Название — значение» · подпись · [цель дня] */
function journalCard(it, onOpen) {
  const t = journalType(it.type);
  const card = el(`
    <button class="jcard" type="button" data-type="${esc(it.type)}" data-id="${esc(it.id)}">
      <span class="jcard__icon jcard__icon--${esc(it.type)}">${homeIcon(t ? t.icon : 'lab')}</span>
      <span class="jcard__body"><span class="jcard__title"></span><span class="jcard__sub"></span></span>
      ${it.progress ? `<span class="jcard__goal"><span class="jcard__goal-text"><small></small><b></b></span>${journalRing(it.progress.pct)}</span>` : ''}
    </button>
  `);
  $('.jcard__title', card).textContent = `${it.title} — ${it.value}`;
  const sub = $('.jcard__sub', card);
  if (it.sub) sub.textContent = it.sub; else sub.remove();
  if (it.progress) {
    $('.jcard__goal small', card).textContent = it.progress.label;
    $('.jcard__goal b', card).textContent = `${it.progress.pct}%`;
  }
  card.setAttribute('aria-label', `${it.title} — ${it.value}${it.sub ? `, ${it.sub}` : ''}${it.progress ? `, ${it.progress.label} ${it.progress.pct}%` : ''}, ${fmtLongDate(it.date)}. Открыть запись`);
  card.addEventListener('click', () => onOpen(it));
  return card;
}

/* Главная: «Сегодняшние журналы» — несколько последних записей за сегодня и «Просмотреть все» */
function renderTodayJournals(items, today) {
  const { items: list, total } = todayJournal(items, today, 3);
  const sec = homeSection('Сегодняшние журналы');
  sec.classList.add('hjournals');
  if (list.length) {
    const box = el('<div class="jcards"></div>');
    list.forEach((it) => box.appendChild(journalCard(it, async (x) => { if (await JOURNAL_ACTIONS[x.type].open(x)) render(); })));
    sec.appendChild(box);
  } else {
    sec.appendChild(el('<p class="hsec__note hjournals__empty">Сегодня записей пока нет</p>'));
  }
  const more = el(`<a class="jall-btn" href="#/journals">Просмотреть все${total > list.length ? ` · ещё ${total - list.length}` : ''}</a>`);
  sec.appendChild(more);
  return sec;
}

async function JournalsScreen(param) {
  const today = dateKey();
  let { filter, focus } = parseJournalRoute(param);
  const ui = readEntryUi('journals');
  let limit = ui && Number.isInteger(ui.limit) && ui.limit > 0 ? ui.limit : JOURNAL_PAGE_DAYS;
  /* возврат по истории — прокрутку восстанавливает роутер; к дате прокручиваем только при первом открытии */
  const returning = !!(history.state && typeof history.state.y === 'number');
  let items = await loadJournalItems();
  let observer = null;

  const screen = el('<div class="jall"></div>');
  screen.appendChild(backHeader('Все журналы', { fallback: 'home' }));
  const chips = el('<div class="jchips" role="toolbar" aria-label="Тип записей"></div>');
  const tools = el('<div class="jtools"></div>');
  const list = el('<div class="jlist"></div>');
  screen.append(chips, tools, list);

  const remember = () => saveEntryUi('journals', { limit });
  const setRoute = () => { replaceUrl(journalRoute(filter, focus)); remember(); };

  function paintChips() {
    chips.innerHTML = '';
    journalFilters(items, filter).forEach((f) => {
      const b = el(`<button class="jchip" type="button" data-filter="${esc(f.id)}" aria-pressed="${f.id === filter}"></button>`);
      b.textContent = f.label;
      b.addEventListener('click', () => {
        if (f.id === filter) return;
        filter = f.id;
        focus = null;
        limit = JOURNAL_PAGE_DAYS;
        setRoute();
        paint();
        window.scrollTo(0, 0);
      });
      chips.appendChild(b);
    });
    const active = $('.jchip[aria-pressed="true"]', chips);
    if (active) requestAnimationFrame(() => { chips.scrollLeft = Math.max(0, active.offsetLeft - 16); });
  }

  function paintTools() {
    tools.innerHTML = '';
    const A = filter !== 'all' ? JOURNAL_ACTIONS[filter] : null;
    if (!A) return;
    const add = el('<button class="btn-primary btn-primary--brand jtools__add" type="button"></button>');
    add.innerHTML = `${homeIcon('plus')}<span>Добавить запись</span>`;
    add.addEventListener('click', async () => after(await A.add(focus || today)));
    tools.appendChild(add);
    if (A.month) tools.appendChild(el(`<a class="btn-ghost jtools__month" href="#/${A.month}">По месяцам</a>`));
  }

  /* после правки / удаления / добавления: перечитать и перерисовать на месте (та же прокрутка) */
  async function after(res) {
    if (!res) return;
    const y = window.scrollY;
    items = await loadJournalItems();
    const d = typeof res === 'string' ? res : !res.deleted ? res.date : null;
    /* запись добавлена / перенесена в день, который ещё не показан, — показать до него */
    if (d) {
      const groups = groupJournal(filterJournal(items, filter), { today });
      const i = groups.findIndex((g) => g.date === d);
      if (i >= limit) { limit = i + 1; remember(); }
    }
    paint();
    window.scrollTo(0, y);
  }

  function paintList() {
    if (observer) { observer.disconnect(); observer = null; }
    list.innerHTML = '';
    const groups = groupJournal(filterJournal(items, filter), { today });
    if (!groups.length) {
      list.appendChild(el(`<p class="empty jempty-all"></p>`));
      $('.jempty-all', list).textContent = journalEmptyText(filter);
      return;
    }
    const shown = visibleDays(groups, limit, focus);
    if (shown.length > limit) { limit = shown.length; remember(); }
    const open = async (it) => after(await JOURNAL_ACTIONS[it.type].open(it));
    shown.forEach((g) => {
      const sec = el(`
        <section class="jgroup" id="jg-${g.date}" data-date="${g.date}">
          <h2 class="jgroup__head"><span class="jgroup__day"></span> <span class="jgroup__sum"><span class="jgroup__dot" aria-hidden="true">•</span> <span class="jgroup__val"></span></span></h2>
          <div class="jcards"></div>
        </section>
      `);
      $('.jgroup__day', sec).textContent = g.label;
      $('.jgroup__val', sec).textContent = g.summary; // «• итог» не разрывается: длинная дата переносит итог целиком на вторую строку
      if (focus && g.date === focus) sec.classList.add('jgroup--focus');
      const box = $('.jcards', sec);
      g.items.forEach((it) => box.appendChild(journalCard(it, open)));
      list.appendChild(sec);
    });
    if (focus && !groups.some((g) => g.date === focus)) {
      const note = el('<p class="empty jempty"></p>');
      note.textContent = `${fmtDate(focus)}: записей нет.`;
      list.prepend(note);
    }
    if (shown.length < groups.length) {
      const rest = groups.length - shown.length;
      const more = el(`<button class="btn-ghost jmore" type="button">Показать ещё · ${rest} ${plural(rest, 'день', 'дня', 'дней')}</button>`);
      const loadMore = () => { limit += JOURNAL_PAGE_DAYS; remember(); paintList(); };
      more.addEventListener('click', loadMore);
      list.appendChild(more);
      /* дальше — по мере прокрутки (кнопка остаётся запасным вариантом) */
      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '600px 0px' });
        observer.observe(more);
      }
    }
  }

  function paint() {
    paintChips();
    paintTools();
    paintList();
  }

  remember();
  paint();
  if (focus && !returning) {
    setTimeout(() => { const n = document.getElementById(`jg-${focus}`); if (n && n.isConnected) n.scrollIntoView({ block: 'start' }); }, 60);
  }
  return screen;
}

async function ThemeScreen() {
  const screen = el('<div></div>');
  function paint() {
    const t = getTheme();
    screen.innerHTML = '';
    screen.appendChild(backHeader('Тема оформления'));
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
  screen.appendChild(backHeader('Настройки'));
  const list = el('<section class="section" style="margin-top:8px"><div class="list-card"></div></section>');
  const box = $('.list-card', list);
  [
    { route: 'theme', icon: '🌙', title: 'Тема оформления' },
    { route: 'export', icon: '💾', title: 'Резервная копия' },
    { route: 'water-import', icon: '📥', title: 'Импорт истории воды' },
    { route: 'history-import', icon: '🗂️', title: 'Импорт медицинской истории' },
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

/* ---------- под-экран: Архив ---------- */
/* =========================================================
   Модуль «Врачи и визиты» (Drawer): список → деталь → форма
   ========================================================= */
async function VisitsScreen() {
  const visits = await Storage.getVisits();
  const screen = el('<div></div>');
  screen.appendChild(backHeader('Врачи и визиты'));

  const search = el(`
    <div class="search-box">
      <span class="search-box__icon" aria-hidden="true">🔍</span>
      <input class="search-box__input" type="text" inputmode="search" enterkeyhint="search" placeholder="Поиск" aria-label="Поиск по визитам и врачам">
      <button class="search-box__clear" type="button" aria-label="Очистить поиск" hidden>✕</button>
    </div>
  `);
  const searchInput = $('.search-box__input', search);
  const clearBtn = $('.search-box__clear', search);
  screen.appendChild(search);

  const add = el('<button class="btn-ghost" type="button" style="margin:8px 0 4px">+ Добавить визит</button>');
  add.addEventListener('click', () => { location.hash = '#/visit/new'; });
  screen.appendChild(add);

  const list = el('<div></div>');
  screen.appendChild(list);

  const group = (title, arr) => {
    if (!arr.length) return;
    const sec = el(`<section class="section" style="margin-top:14px"><div class="section__head"><h2 class="section__title">${esc(title)}</h2></div><div class="list-card"></div></section>`);
    const box = $('.list-card', sec);
    arr.forEach((v) => {
      const rel = relativeVisitLabel(v.date);
      const row = el(`
        <div class="row" role="button" data-id="${esc(v.id)}" style="align-items:flex-start">
          <span class="row__icon">${visitIcon(v)}</span>
          <div class="row__body">
            <p class="row__title">${esc(visitTitle(v))}</p>
            <p class="row__sub">${esc(visitSub(v) || v.conclusion || '')}</p>
            ${rel ? `<p class="row__meta">${esc(rel)}</p>` : ''}
          </div>
          <span class="row__trailing">${esc(fmtDate(v.date))}<br><span class="row__chevron">›</span></span>
        </div>
      `);
      box.appendChild(row);
    });
    sec.addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) location.hash = `#/visit/${r.dataset.id}`; });
    list.appendChild(sec);
  };

  function render(query) {
    list.innerHTML = '';
    const filtered = query ? visits.filter((v) => visitMatchesQuery(v, query)) : visits;
    const planned = filtered.filter((v) => v.status === 'planned').sort((a, b) => a.date.localeCompare(b.date) || (visitTime(a) || '').localeCompare(visitTime(b) || ''));
    /* прошедшие — новые сверху; в один день — позднее время выше */
    const done = filtered.filter((v) => v.status !== 'planned').sort((a, b) => b.date.localeCompare(a.date) || (visitTime(b) || '').localeCompare(visitTime(a) || ''));
    group('Запланированные', planned);
    /* прошедшие — по годам: после импорта истории список длинный */
    const years = [...new Set(done.map((v) => v.date.slice(0, 4)))];
    years.forEach((y) => group(years.length > 1 ? `Прошедшие · ${y}` : 'Прошедшие', done.filter((v) => v.date.startsWith(y))));
    if (!filtered.length) list.appendChild(el(`<div class="empty">${query ? 'Ничего не найдено' : 'Пока нет визитов'}</div>`));
  }

  searchInput.addEventListener('input', () => {
    clearBtn.hidden = !searchInput.value;
    render(searchInput.value);
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.hidden = true;
    render('');
    searchInput.focus();
  });

  render('');
  return screen;
}

async function VisitDetailScreen(id) {
  const [visit, tests, meds] = await Promise.all([Storage.getVisit(id), Storage.getTests(), Storage.getMeds({ includeDeleted: true })]);
  const screen = el('<div></div>');
  if (!visit) { screen.appendChild(backHeader('Визит', { fallback: 'visits' })); screen.appendChild(el('<div class="empty">Визит не найден</div>')); return screen; }
  screen.appendChild(backHeader('Визит', { fallback: 'visits' }));

  const chip = visitStatusChip(visit);
  const statusChip = chip ? `<span class="vchip vchip--${chip.cls}">${esc(chip.text)}</span>` : '';
  screen.appendChild(el(`
    <div class="visit-head">
      <span class="visit-head__icon">${visitIcon(visit)}</span>
      <div>
        <div class="visit-head__name">${esc(visitTitle(visit))}</div>
        <div class="visit-head__sub">${esc(visitSub(visit) || (visit.kind ? visitKindLabel(visit) : ''))}</div>
        <div style="margin-top:6px"><span class="visit-head__date">${esc(fmtDate(visit.date))}${visitTime(visit) ? ` · ${esc(visitTime(visit))}` : ''}</span> ${statusChip}</div>
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

  screen.appendChild(await visitDocsSection(visit));

  const actions = el('<div style="display:flex; gap:10px; margin-top:16px"></div>');
  const edit = el('<button class="btn-ghost" type="button" style="margin:0">Редактировать</button>');
  edit.addEventListener('click', () => { location.hash = `#/visit/${id}/edit`; });
  const del = el('<button class="btn-ghost" type="button" style="margin:0; color:var(--red)">Удалить</button>');
  del.addEventListener('click', async () => {
    const n = visitDocsOf(visit).length;
    if (!confirm(n ? `Удалить запись вместе с документами (${n})?` : 'Удалить визит?')) return;
    try { await VisitFiles.deleteVisit(id); } catch { await Storage.removeVisit(id); }
    goBackTo('visits');
  });
  actions.append(edit, del);
  screen.appendChild(actions);
  return screen;
}

/* «Документы» медицинской записи: PDF и фото (несколько), миниатюры, просмотр тем же
   просмотрщиком, что у анализов; удаление одного документа запись не удаляет. */
const fmtAddedAt = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(RU, { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\s*г\.$/, ''); };
let visitThumbUrls = [];
function revokeVisitThumbs() { visitThumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u)); }
window.addEventListener('hashchange', revokeVisitThumbs);

async function openVisitDocument(meta) {
  let file = null;
  try { file = await VisitFiles.getFile(meta); } catch (err) {
    await alertDialog('Документ недоступен', `<p>${esc(err instanceof AttachmentError ? err.message : 'Не удалось прочитать документ.')}</p>`);
    return null;
  }
  if (!file) { await alertDialog('Документ не найден', '<p>Файла нет на этом устройстве.</p><p class="dialog__muted">Так бывает после восстановления из обычной резервной копии (она не содержит PDF и фото) или на другом устройстве. Запись сохранена; прикрепите файл заново или восстановите полную резервную копию с документами.</p>'); return null; }
  return openDocViewer(file, 'Документ записи');
}

async function visitDocsSection(visit) {
  const sec = el(`
    <section class="section vdocs">
      <div class="section__head"><h2 class="section__title" style="font-size:15px">Документы</h2></div>
      <div class="list-card vdocs__list"></div>
      <label class="btn-ghost vdocs__add">Добавить файл<input type="file" multiple accept="${esc(ATTACHMENT_ACCEPT)}" hidden></label>
      <p class="vdocs__hint">PDF или фото (JPG, PNG, HEIC) — из «Файлов» или медиатеки, можно несколько сразу, до 15 МБ каждый.</p>
    </section>
  `);
  const box = $('.vdocs__list', sec);
  const label = $('.vdocs__add', sec);
  const input = $('input', label);

  async function paint() {
    revokeVisitThumbs();
    const cur = (await Storage.getVisit(visit.id)) || visit;
    const docs = visitDocsOf(cur);
    const legacy = (cur.attachments || []).filter((a) => a && !a.attachmentId); // каркас старых версий: только имя
    box.innerHTML = '';
    if (!docs.length && !legacy.length) box.appendChild(el('<div class="empty">Нет документов</div>'));
    docs.forEach((a) => {
      const kind = docKind(a.type);
      const row = el(`
        <div class="row vdoc" role="button" tabindex="0">
          <span class="vdoc__thumb vdoc__thumb--${kind}" aria-hidden="true">${kind === 'pdf' ? '<b>PDF</b>' : DOC_ICON.image}</span>
          <div class="row__body">
            <p class="row__title vdoc__name"></p>
            <p class="row__sub"></p>
          </div>
          <button class="vdoc__more" type="button">${MED_MORE_SVG}</button>
        </div>
      `);
      $('.vdoc__name', row).textContent = a.name || 'Документ';
      $('.row__sub', row).textContent = [docLabel(a.type), formatBytes(a.size), a.addedAt ? `добавлен ${fmtAddedAt(a.addedAt)}` : ''].filter(Boolean).join(' · ');
      $('.vdoc__more', row).setAttribute('aria-label', `Действия: ${a.name || 'документ'}`);
      row.setAttribute('aria-label', `Открыть ${a.name || 'документ'}`);
      row.addEventListener('click', (e) => { if (!e.target.closest('.vdoc__more')) openVisitDocument(a); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openVisitDocument(a); });
      $('.vdoc__more', row).addEventListener('click', () => docActions(a));
      box.appendChild(row);
      if (kind === 'image') {
        VisitFiles.getFile(a).then((f) => {
          if (!f) return;
          const url = URL.createObjectURL(f);
          visitThumbUrls.push(url);
          const img = new Image();
          img.alt = '';
          img.onload = () => { const t = $('.vdoc__thumb', row); t.textContent = ''; t.appendChild(img); };
          img.onerror = () => {}; // HEIC без поддержки в браузере — остаётся значок
          img.src = url;
        }).catch(() => {});
      }
    });
    legacy.forEach((a) => box.appendChild(el(`<div class="row"><span class="row__icon">📎</span><div class="row__body"><p class="row__title">${esc(a.name || 'Вложение')}</p><p class="row__sub">файла нет на устройстве</p></div></div>`)));
  }

  async function docActions(a) {
    const act = await showDialog({
      title: a.name || 'Документ', stack: true, cancelValue: null,
      actions: [
        { label: 'Открыть', value: 'open' },
        { label: 'Удалить документ', value: 'delete', kind: 'destructive' },
        { label: 'Отмена', value: null },
      ],
    });
    if (act === 'open') { openVisitDocument(a); return; }
    if (act !== 'delete') return;
    const ok = await showDialog({
      title: 'Удалить документ?',
      body: `<p>${esc(a.name || 'Документ')}</p><p class="dialog__muted">Удаляется только этот файл. Сама запись и другие документы остаются.</p>`,
      actions: [{ label: 'Отмена', value: false }, { label: 'Удалить', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try { await VisitFiles.removeFromVisit(visit.id, a.attachmentId); } catch { flash('Не удалось удалить'); return; }
    flash('Документ удалён');
    await paint();
  }

  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = ''; // тот же файл можно выбрать снова
    if (!files.length) return;
    label.classList.add('is-busy');
    try {
      const res = await VisitFiles.attachToVisit(visit.id, files);
      if (res.errors.length) {
        await alertDialog(res.added.length ? 'Часть файлов не добавлена' : 'Файлы не добавлены', `<ul class="dialog__list">${res.errors.map((x) => `<li><span>${esc(x.name)}</span></li><li><span class="dialog__muted">${esc(x.message)}</span></li>`).join('')}</ul>`);
      }
      if (res.added.length) flash(res.added.length === 1 ? 'Документ добавлен ✓' : `Добавлено документов: ${res.added.length} ✓`);
    } catch (err) {
      await alertDialog('Не удалось добавить', `<p>${esc(err instanceof AttachmentError ? err.message : 'Попробуйте ещё раз.')}</p>`);
    } finally {
      label.classList.remove('is-busy');
      await paint();
    }
  });
  await paint();
  return sec;
}

async function VisitFormScreen(id) {
  const [existing, tests, allMeds] = await Promise.all([id ? Storage.getVisit(id) : null, Storage.getTests(), Storage.getMeds({ includeDeleted: true })]);
  /* удалённое лекарство остаётся в выборе, только если визит уже на него ссылается — связь не теряется при сохранении */
  const meds = allMeds.filter((m) => !m.deletedAt || (existing?.links?.medIds || []).includes(m.id));
  const v = existing || { date: dateKey(), status: 'done', links: { testIds: [], medIds: [], reminderIds: [] }, attachments: [] };
  const screen = el('<div></div>');
  screen.appendChild(backHeader(id ? 'Редактировать визит' : 'Новый визит', { fallback: id ? `visit/${id}` : 'visits' }));
  const form = el('<div class="input-card"></div>');
  const fld = (label, html) => `<div class="field"><label class="field__label">${esc(label)}</label>${html}</div>`;
  form.innerHTML = `
    ${fld('Дата', `<input class="input" type="date" id="f-date" value="${esc(v.date)}">`)}
    ${fld('Название (необязательно)', `<input class="input" type="text" id="f-title" value="${esc(v.title || '')}" placeholder="напр. УЗИ сосудов шеи">`)}
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
      title: $('#f-title', form).value.trim(),
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
    /* правка — на карточку визита (она перечитает данные); новый визит — карточка вместо формы; без дублей в истории */
    if (id) { await Storage.updateVisit(id, data); goBackTo(`visit/${id}`); }
    else { const created = await Storage.addVisit(data); replaceRoute(`visit/${created.id}`); }
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
  serverCheck: (occ) => pushClient.occurrenceStatus(occ), // запасной показ — только если push точно не ушёл
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
    screen.appendChild(backHeader('Уведомления'));

    screen.appendChild(await statusPanel());
    if (pushClient.serverAllowed && pushClient.state().enabled) screen.appendChild(deliveryLog());

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

  /* Журнал доставки с сервера: почему конкретное напоминание пришло / не пришло / опоздало.
     «Показано» — время, когда iPhone реально вывел уведомление (подтверждение от SW). */
  function deliveryLog() {
    const box = el('<details class="notif-log"><summary>Журнал доставки (сервер)</summary><div class="notif-log__body"><p class="notif-log__empty">Загрузка…</p></div></details>');
    const body = $('.notif-log__body', box);
    const hm = (iso, sec) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', sec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) : '');
    const lagText = (from, to) => { const m = Math.round((Date.parse(to) - Date.parse(from)) / 60000); return m <= 0 ? 'вовремя' : `+${m} мин`; };
    box.addEventListener('toggle', async () => {
      if (!box.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      const r = await pushClient.deliveries();
      if (!r.ok) { body.innerHTML = `<p class="notif-log__empty">${r.status === 0 ? 'Нет сети — журнал недоступен.' : 'Сервер не отдал журнал.'}</p>`; return; }
      const list = r.data.deliveries || [];
      if (!list.length) { body.innerHTML = '<p class="notif-log__empty">Записей пока нет.</p>'; return; }
      body.innerHTML = list.map((d) => {
        const T = NOTIF_TYPES[d.type] || {};
        const when = `${new Date(d.scheduledAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${hm(d.scheduledAt)}`;
        let res;
        if (d.status === 'sent' && d.shownAt) res = `показано в ${hm(d.shownAt)} (${lagText(d.scheduledAt, d.shownAt)})`;
        else if (d.status === 'sent') res = `отправлено в ${hm(d.sentAt, true)}, показ на iPhone не подтверждён`;
        else res = d.reason + (d.errorCode && d.errorCode !== 'late' ? ` (${d.errorCode})` : '');
        const lvl = d.status === 'sent' ? (d.shownAt && Date.parse(d.shownAt) - Date.parse(d.scheduledAt) < 5 * 60000 ? 'ok' : 'warn') : 'bad';
        return `<div class="notif-log__row notif-log__row--${lvl}"><span>${esc(T.emoji || '🔔')} ${esc(when)}</span><span>${esc(res)}</span></div>`;
      }).join('');
    });
    return box;
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
  const [visits, tests, meds, notifs, waterGoal, sleep] = await Promise.all([
    Storage.getVisits(), Storage.getTests(), Storage.getMeds(), Storage.getNotifications(), Storage.getWaterGoal(), Storage.getSleepEntries(),
  ]);
  const nextDoses = meds
    .filter((m) => m.active && m.every_days)
    .map((m) => ({ med: m, date: nextDose(m) }))
    .filter((x) => x.date);
  return { visits, tests, meds, notifs, waterGoal, nextDoses, sleep };
}

/* разовые события конкретной даты — они же дают точку на сетке месяца/недели */
function dayPointEvents(dateStr, data) {
  const ev = [];
  data.visits.forEach((v) => {
    if (v.date === dateStr) ev.push({ icon: visitIcon(v), title: visitTitle(v), sub: visitSub(v) || visitKindLabel(v), time: visitTime(v), route: `visit/${v.id}` });
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
/* полная повестка дня: разовые события + ежедневные (сон, лекарства, цель воды) — для панели дня.
   Сон — запись за день пробуждения (строится из sleep_log, отдельно не хранится); точку на сетке
   не ставит, как и другие ежедневные записи, иначе точки визитов и анализов потеряются. */
function dayAgendaEvents(dateStr, data) {
  const ev = dayPointEvents(dateStr, data).slice();
  const sl = getSleepForDate(data.sleep || [], dateStr);
  if (sl) ev.push({ icon: '😴', title: `Сон · ${formatSleepDuration(sl.durationMinutes)}`, sub: `${stampTime(sl.sleepStart)} → ${stampTime(sl.sleepEnd)}${sl.quality ? ` · ${qualityInfo(sl.quality).label}` : ''}`, time: null, route: `sleep/${encodeURIComponent(sl.id)}` });
  data.meds.forEach((m) => medOccurrences(m, dateStr).forEach(({ time }) => { if (time) ev.push({ icon: '💊', title: m.name, sub: 'Приём лекарства', time, route: 'meds' }); }));
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
  /* вид, период и выбранный день — из записи истории («Назад» с карточки визита) */
  const ui = readEntryUi('calendar');
  if (ui && ['month', 'week', 'list'].includes(ui.mode) && /^\d{4}-\d{2}-\d{2}$/.test(ui.cursor) && /^\d{4}-\d{2}-\d{2}$/.test(ui.selected)) {
    mode = ui.mode;
    cursor = new Date(`${ui.cursor}T00:00:00`);
    selected = ui.selected;
  }

  async function paint() {
    saveEntryUi('calendar', { mode, cursor: dateKey(cursor), selected });
    screen.innerHTML = '';
    screen.appendChild(backHeader('Календарь'));

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
  steps: { name: 'Количество шагов', gen: 'количества шагов', unit: 'шагов', d: 0 },
  bike: { name: 'Дистанция на велосипеде', gen: 'дистанции на велосипеде', unit: 'км', d: 1 },
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
  const [metricsLog, metricsConfig, tests, medLog, meds, medIntakes, stepsLog, bikeLog] = await Promise.all([
    Storage.getMetricsLog(), Storage.getMetricsConfig(),
    Storage.getTests(), Storage.getAllMedLog(), Storage.getMeds(), Storage.getAllMedIntakes(),
    Storage.getDailyActivityLog('steps'), Storage.getBikeRides(),
  ]);
  const engine = createStatsEngine({ metricsLog, metricsConfig, tests, medLog, medIntakes, meds, stepsLog, bikeLog, testFields: TEST_FIELDS }, dateKey());
  const screen = el('<div class="stats"></div>');
  let period = loadStatsPeriod();

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
    screen.appendChild(backHeader('Статистика'));
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
            <button class="btn-ghost" type="button" data-route="steps">👟 Шаги</button>
            <button class="btn-ghost" type="button" data-route="bike">🚴 Велосипед</button>
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
    ACTIVITY_KEYS.forEach((k) => screen.appendChild(activityStatSection(m, k)));
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
    ACTIVITY_KEYS.forEach((k) => {
      const b = m[k], A = ACTIVITY_METRICS[k];
      const noKm = k === 'bike' && !b.points.length && b.noKm.count;
      cards.push(card({
        id: `st-${k}`, emoji: A.emoji, name: A.title,
        val: b.points.length ? fmtActivityValue(k, b.stats.avg) : '—', unit: k === 'steps' ? 'шагов/день' : 'км/день',
        sub: b.points.length ? `${k === 'steps' ? `${fmtKmApprox(stepsToKm(b.stats.avg))}/день · ` : ''}по ${b.stats.days} ${daysDat(b.stats.days)} с записями`
          : noKm ? `${plRides(b.noKm.count)} без дистанции` : (b.totalDays ? 'нет записей за период' : 'Недостаточно данных'),
      }));
    });
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
    add('steps', m.steps, 'шагов/день');
    add('bike', m.bike, 'км/день');
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
    [['steps', 'Шаги в среднем', 'шагов/день'], ['bike', 'Велосипед в среднем', 'км/день']].forEach(([k, title, unit]) => {
      const c = m[k].compare, d = ST[k].d;
      if (!c.cur.days && !c.prev.days) return;
      const daysTxt = `записи за ${c.cur.days} против ${c.prev.days} дн.`;
      if (c.deltaAvg != null) rows.push([title, `${fmtN(c.cur.avg, d)} против ${fmtN(c.prev.avg, d)} ${unit} · ${daysTxt}`, `${fmtSigned(roundedDelta(c.cur.avg, c.prev.avg, d), d)} ${unit}`]);
      else rows.push([title, `${c.cur.days ? 'в предыдущем периоде записей нет' : 'в этом периоде записей нет'} · ${daysTxt}`, c.cur.days ? `${fmtN(c.cur.avg, d)} ${unit}` : '—']);
    });
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
  function bucketReadout(bar, unit, size, extra, d = 0) {
    const range = size === 1 ? fmtDay(bar.start) : `${fmtDayShort(bar.start)} — ${fmtDayShort(bar.end)}`;
    if (bar.value == null) return `<span class="chart__rv chart__rv--muted">нет данных</span><span class="chart__rd">${esc(range)}</span>`;
    if (size === 1) {
      const zero = bar.value === 0 ? ' · записано' : '';
      return `<span class="chart__rv">${esc(fmtN(bar.value, d))} <small>${esc(unit)}</small></span><span class="chart__rd">${esc(range)}${zero}${extra ? esc(extra(bar.value)) : ''}</span>`;
    }
    return `<span class="chart__rv">${esc(fmtN(bar.value, d))} <small>${esc(unit)}/день</small></span><span class="chart__rd">среднее · ${esc(range)} · записи за ${bar.days} из ${bar.size} дн.</span>`;
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

  /* ---------- Шаги / Велосипед: у каждого свой блок, своё хранилище и свой экран ---------- */
  function activityStatSection(m, k) {
    const A = ACTIVITY_METRICS[k], b = m[k];
    const unit = k === 'steps' ? 'шагов' : 'км';
    const sec = sectionShell(`st-${k}`, `${A.emoji} ${A.title}`, A.route);
    /* велотренажёр без дистанции — не 0 км: отдельной строкой, в километры не входит */
    const noKmNote = k === 'bike' && b.noKm.count
      ? el(`<p class="st-note st-nokm">Без дистанции: ${plRides(b.noKm.count)}${b.noKm.minutes ? ` · ${b.noKm.minutes} мин` : ''} — дистанция не указана, в километры не входит.</p>`) : null;
    if (!b.points.length) {
      sec.appendChild(emptyState({ totalDays: b.totalDays, lastAll: b.lastAll }, A.route, 'записей'));
      if (noKmNote) sec.appendChild(noKmNote);
      return sec;
    }
    const cardEl = el('<div class="card st-card"></div>');
    cardEl.appendChild(svgBarChart({
      range: m.range,
      bars: b.buckets,
      minSpan: k === 'steps' ? 2000 : 2,
      color: 'var(--viz-1)',
      ariaLabel: `${A.title} за период: в среднем ${fmtActivity(k, b.stats.avg)} в день, записи за ${b.stats.days} из ${m.range.days} дней`,
      readout: (bar) => bucketReadout(bar, unit, m.bucketSize, null, k === 'steps' ? 0 : 1),
    }));
    const note = aggNote(m.bucketSize);
    if (note) cardEl.appendChild(el(`<p class="st-note">${esc(note)}</p>`));
    const total = b.points.reduce((s, p) => s + p.value, 0);
    /* шаги — основное значение плитки, расчётные км — вторичной строкой */
    const val = (v) => fmtActivity(k, v, { km: false });
    const sub = (v, text) => [k === 'steps' && v != null ? fmtKmApprox(stepsToKm(v)) : '', text].filter(Boolean).join(' · ');
    cardEl.appendChild(el(tiles([
      ['Среднее в день', val(b.stats.avg), sub(b.stats.avg, `по ${b.stats.days} ${daysDat(b.stats.days)} с записями`)],
      ['Лучший день', b.best ? val(b.best.value) : '—', b.best ? sub(b.best.value, fmtDayShort(b.best.day)) : ''],
      ['Минимум', b.stats.min ? val(b.stats.min.value) : '—', b.stats.min ? sub(b.stats.min.value, fmtDayShort(b.stats.min.day)) : ''],
      ['Дней с данными', `${b.stats.days} из ${m.range.days}`, `записей нет: ${m.range.days - b.stats.days} дн.`],
      ['Всего за период', val(total), sub(total, 'сумма записанных дней')],
    ])));
    if (noKmNote) cardEl.appendChild(noKmNote);
    sec.appendChild(cardEl);
    sec.appendChild(tableView(b.points.length, () => newestFirst(b.points).map((p) => [fmtDate(p.date), fmtActivity(k, p.value)])));
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
    ACTIVITY_KEYS.forEach((k) => {
      const b = m[k];
      rows.push([ACTIVITY_METRICS[k].title, b.totalDays ? `записи за ${b.stats.days} ${daysWord(b.stats.days)} из ${m.range.days} · последняя: ${lastLabel(b.lastAll, m.todayDay)}` : 'нет данных', b.totalDays ? `${b.stats.days} из ${m.range.days} дн.` : '']);
    });
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
  screen.appendChild(backHeader(title));
  screen.appendChild(el(`<div class="placeholder"><div class="placeholder__emoji">${emoji}</div><h2>${esc(title)}</h2><p>Раздел в разработке — скоро.</p></div>`));
  return screen;
}

/* ---------- общие хелперы экранов ---------- */
function onRouteClick(e) {
  const nav = e.target.closest('[data-route]');
  if (nav) location.hash = `#/${nav.getAttribute('data-route')}`;
}
/* Шапка внутреннего экрана: круглая кнопка «Назад» (js/ui/backNav.js) + заголовок.
   fallback — куда вернуться, если экран открыт напрямую (нет истории LexLife) */
function backHeader(title, { fallback = 'home', onBack } = {}) {
  const h = el(`<header class="header header--nav"><h1 class="header__title">${esc(title)}</h1></header>`);
  h.prepend(BackButton({ fallback, onBack }));
  return h;
}

/* Модальный диалог: body — готовый HTML (данные экранируются вызывающим через esc).
   actions: [{ label, value, kind: 'primary'|'danger', onClick }] — onClick вызывается
   синхронно в обработчике касания (нужно для Share Sheet на iOS). → Promise<value> */
function showDialog({ title, body = '', actions, stack = false, cancelValue }) {
  return new Promise((resolve) => {
    const wrap = el(`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title"><div class="dialog__card"><h2 class="dialog__title" id="dlg-title"></h2><div class="dialog__body"></div><div class="dialog__actions${stack ? ' dialog__actions--stack' : ''}"></div></div></div>`);
    $('.dialog__title', wrap).textContent = title;
    $('.dialog__body', wrap).innerHTML = body;
    const close = (v) => { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(v); };
    /* stack — действия столбцом (меню); cancelValue — что вернуть по Escape, если не первое действие */
    const onKey = (e) => { if (e.key === 'Escape') close(cancelValue !== undefined ? cancelValue : actions[0].value); };
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
  screen.appendChild(backHeader(mode === 'export' ? 'Перенос LexLife' : mode === 'import' ? 'Перенос из старой версии' : 'Перенос'));
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
    { route: 'journals', icon: '📋', title: 'Все журналы' },
    { route: 'sleep', icon: '😴', title: 'Сон' },
    { route: 'metric/water', icon: '💧', title: 'Вода' },
    { route: 'steps', icon: '👟', title: 'Шаги' },
    { route: 'bike', icon: '🚴', title: 'Велосипед' },
    { route: 'workouts', icon: '🏋️', title: 'Тренировки' },
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
  paintAvatarBtn(p);
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
/* Аватар в шапке — кнопка Drawer: фото профиля, без фото — инициалы или силуэт.
   Обновляется вместе с шапкой Drawer (buildDrawer вызывается и после сохранения профиля). */
const AVATAR_PH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="4"/><path d="M4.5 20.5c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/></svg>';
function paintAvatarBtn(p) {
  const box = $('#avatar-btn-img');
  const initials = String(p.name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  box.classList.toggle('avatar-btn__img--ph', !p.photo);
  box.innerHTML = p.photo ? `<img src="${esc(p.photo)}" alt="" decoding="async">`
    : initials ? `<span class="avatar-btn__initials">${esc(initials)}</span>` : AVATAR_PH_SVG;
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
  profile: ProfileScreen, visits: VisitsScreen,
  settings: SettingsScreen, export: ExportScreen, 'water-import': WaterImportScreen, 'history-import': HistoryImportScreen, theme: ThemeScreen,
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
  if (h === 'sleep') return { fn: SleepScreen, tab: null, main: false };
  if (h === 'sleep-log' || h.startsWith('sleep-log/')) return { fn: () => SleepLogScreen(h.slice(10)), tab: null, main: false };
  for (const k of ACTIVITY_KEYS) {
    const M = ACTIVITY_METRICS[k];
    if (h === M.route) return { fn: () => ActivityMetricScreen(k), tab: null, main: false };
    if (h === M.logRoute || h.startsWith(`${M.logRoute}/`)) return { fn: () => ActivityLogScreen(k, h.slice(M.logRoute.length + 1)), tab: null, main: false };
  }
  if (h === 'sleep/settings') return { fn: SleepSettingsScreen, tab: null, main: false };
  if (h === 'sleep/new' || h.startsWith('sleep/new/')) return { fn: () => SleepFormScreen(null, h.slice(10) || null), tab: null, main: false };
  if (h.startsWith('sleep/')) return { fn: () => SleepFormScreen(safeDecode(h.slice(6))), tab: null, main: false };
  if (h === 'med/new') return { fn: () => MedFormScreen(null), tab: 'meds', main: false };
  if (h.startsWith('med/') && h.endsWith('/edit')) return { fn: () => MedFormScreen(safeDecode(h.slice(4, -5))), tab: 'meds', main: false };
  if (h === 'test/new') return { fn: () => TestFormScreen(null), tab: 'tests', main: false };
  if (h.startsWith('test/')) {
    const rest = h.slice(5);
    if (rest.endsWith('/edit')) return { fn: () => TestFormScreen(safeDecode(rest.slice(0, -5))), tab: 'tests', main: false };
    return { fn: () => TestDetailScreen(safeDecode(rest)), tab: 'tests', main: false };
  }
  if (h.startsWith('test-history/')) return { fn: () => TestHistoryScreen(safeDecode(h.slice(13))), tab: 'tests', main: false };
  if (h === 'water-log' || h.startsWith('water-log/')) return { fn: () => WaterLogScreen(h.slice(10)), tab: 'metrics', main: false };
  if (h === 'journals' || h.startsWith('journals/')) return { fn: () => JournalsScreen(h.slice(9)), tab: null, main: false };
  if (h === 'workouts') return { fn: WorkoutsScreen, tab: null, main: false };
  if (h.startsWith('metric/')) {
    const k = h.slice(7);
    if (k === 'water') return { fn: WaterScreen, tab: 'metrics', main: true };
    if (k === 'waist') return { fn: WaistScreen, tab: 'metrics', main: false }; // справа в шапке «+», аватара нет
    if (METRICS[k]) return { fn: () => MetricScreen(k), tab: 'metrics', main: true };
  }
  if (SCREENS[h]) return { fn: SCREENS[h], tab: TAB_ROUTES.includes(h) ? h : null, main: TAB_ROUTES.includes(h) };
  return { fn: HomeScreen, tab: 'home', main: true };
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/* Место прокрутки хранится в записи истории браузера (history.state.y): «Назад» возвращает
   экран туда, где он был, новый переход открывает экран сверху. Для всех экранов
   (вкладки/период/дата экрана — там же, history.state.ui, см. js/ui/backNav.js). */
let scrollSaveTimer = 0;
function saveScrollState() {
  clearTimeout(scrollSaveTimer);
  const y = lockedScrollY ?? window.scrollY;
  try { history.replaceState({ ...(history.state || {}), y }, ''); } catch { /* Safari: лимит частоты replaceState */ }
}

let renderToken = 0;
let currentRoute = null;
async function render() {
  stopHomeMarkerTimer(); // уходим с текущего экрана (в т.ч. повторно на Главную) — старый таймер не должен жить дальше
  clearTimeout(scrollSaveTimer); // отложенное сохранение не должно попасть в запись нового экрана
  const { fn, tab, main } = resolve();
  const route = location.hash.replace(/^#\/?/, '');
  const routeChanged = route !== currentRoute;
  currentRoute = route;
  const token = ++renderToken;
  closeDrawer();
  setActiveTab($('#tab-bar'), tab);
  $('#avatar-btn').classList.toggle('hidden', !main);
  const node = await fn();
  if (token !== renderToken) return;
  const mount = $('#screen');
  mount.innerHTML = '';
  mount.appendChild(node);
  mount.scrollTop = 0;
  if (routeChanged) {
    const y = history.state && typeof history.state.y === 'number' ? history.state.y : 0;
    window.scrollTo(0, y);
  }
  updates.retry(); // отложенное обновление: экран сменился — если ввода нет, перезагрузка на новую версию
}

function initChrome() {
  $('#avatar-btn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  /* затемнение не пропускает жест прокрутки на страницу (тап по-прежнему закрывает) */
  $('#scrim').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}

/* Обновление после deploy (js/services/swUpdate.js): документ из кэша прежней версии
   перезагружается один раз, когда новый SW активен, — не во время формы или ввода. */
const sessionStore = (() => { try { return window.sessionStorage; } catch { return null; } })();
const updates = createUpdateController({
  reload: () => location.reload(),
  session: sessionStore,
  isSafe: () => !isFormRoute(location.hash) && !document.querySelector('.dialog') && !hasUnsavedInput(document.body),
});

/* Сообщения SW. Подписка — при загрузке модуля, до boot(): сообщение об обновлении
   может прийти, пока экран ещё строится (иначе SW сочтёт вкладку старой и перезагрузит сам). */
function listenSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    /* клик по уведомлению: SW просит открыть экран (только внутренние маршруты) */
    if (d.type === 'lexlife:open' && isSafeRoute(d.route) && location.hash !== d.route) location.hash = d.route;
    /* новая версия активна: подтвердить SW (он не будет перезагружать вкладку сам) и перейти на неё */
    if (d.type === UPDATE_MSG) {
      if (e.ports && e.ports[0]) e.ports[0].postMessage({ ok: true });
      updates.onUpdateReady(d.version);
    }
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err));
  /* boot() ждёт данные и первый экран — к этому моменту load мог уже пройти */
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/* Вкладка открыта давно (iOS: возврат PWA из фона — не навигация, браузер sw.js не проверяет):
   спросить сервер о новой версии. Не чаще раза в минуту; офлайн — молча. */
function checkForUpdate() {
  if (!('serviceWorker' in navigator) || !updates.shouldCheck()) return;
  navigator.serviceWorker.getRegistration().then((r) => (r ? r.update() : null)).catch(() => {});
}

/* ---------- запуск ---------- */
applyTheme(getTheme());
async function boot() {
  await Storage.init();
  initChrome();
  initBottomNav($('#tab-bar'));
  await buildDrawer();
  initNavHistory(); // до роутера: глубина записи истории должна быть известна к render()
  window.addEventListener('hashchange', render);
  window.addEventListener('scroll', () => { clearTimeout(scrollSaveTimer); scrollSaveTimer = setTimeout(saveScrollState, 250); }, { passive: true });
  document.addEventListener('click', saveScrollState, true); // до перехода по ссылке/кнопке
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); notifier.check(); rulesChanged({ quiet: true }); checkForUpdate(); } });
  window.addEventListener('online', () => { rulesChanged({ quiet: true }); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { notifier.check(); checkForUpdate(); } });
  await render();
  registerSW();
  startNotifier();
  /* фоновые уведомления: подписка на месте? неотправленные изменения правил (offline, restore) */
  pushClient.checkSubscription().then(() => rulesChanged({ quiet: true })).catch(() => {});
  if (occurrences) occurrences.prune().catch(() => {});
  /* «висячие» документы (анализ удалён/заменён при восстановлении) — фоном, безопасно */
  if (IdbAttachmentStore.available()) Attachments.cleanupOrphans().catch((err) => console.warn('[attachments] очистка пропущена', err && err.name));
  if (IdbAttachmentStore.available()) VisitFiles.cleanupOrphans().catch((err) => console.warn('[visit files] очистка пропущена', err && err.name));
}
listenSW();
boot();
