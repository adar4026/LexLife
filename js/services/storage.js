/* =========================================================
   storage.js — единый слой данных «StorageService»
   Реализация по ARCHITECTURE.md §6:
     • §6.1 единственная точка доступа к данным
     • §6.2 драйвер-адаптер + async-first API (Promise)
     • §6.3 schemaVersion + конвейер миграций
     • §6.4 exportBackup / importBackup (полный JSON-бэкап)
     • §6.5 даты только в ISO 8601
     • §6.6 каркас вложений (метаданные; бинарь — IndexedDbDriver)
   Ключи и модель данных — по ТЗ «LexLife».
   ========================================================= */

import { isValidSleepLog, isValidSleepSettings, isValidSleepEntry, normalizeSleepSettings, defaultSleepSettings, findSleepByExternalId, SLEEP_NOTE_MAX } from './sleep.js';
import {
  ACTIVITY_METRICS, ACTIVITY_NOTE_MAX, isValidStepsLog, isValidWalkLog, isValidBikeLog, isValidActivityMigration,
  isValidStepsEntry, isValidWalkEntry, isValidRide, migrateLegacyActivity, sortRides,
} from './activity.js';

const APP_ID = 'lexlife';
/* Старые бэкапы (экспортированные до ребрендинга) помечены прежним app id —
   принимаем их на импорт, чтобы не терять совместимость с уже сделанными бэкапами. */
const LEGACY_APP_IDS = ['moe-zdorovie'];
export const CURRENT_SCHEMA_VERSION = 8;
/* Версия приложения (UI/маркетинг) — отдельно от CURRENT_SCHEMA_VERSION (схема данных).
   Меняется при релизах, не влияет на миграции/хранение. */
export const APP_VERSION = '1.0.0';
/* Месяц релиза текущей APP_VERSION (показывается в UI как есть). Меняется вручную
   при выпуске новой версии вместе с APP_VERSION — не вычисляется из даты устройства. */
export const APP_UPDATED = 'сентябрь 2026';

/* Ключи: health_metrics (v2, теперь конфиг) + metrics_log (v4, единая история) */
export const KEYS = {
  meta: 'health_meta',
  alerts: 'health_alerts',
  visits: 'health_visits',
  meds: 'health_meds',
  tests: 'health_tests',
  metrics: 'health_metrics',   // конфиг показателей: { metric: { goal, unit } }
  metricsLog: 'metrics_log',    // история значений: { metric: { "ГГГГ-ММ-ДД": value } }
  profile: 'app_profile',
  hydration: 'hydration_cfg',   // план гидратации: окно бодрствования, интервал, напоминания
  notifications: 'notifications', // правила уведомлений (готовы под push)
  activityDays: 'activity_days',
  activityGoals: 'activity_goals',
  medLog: 'med_log',            // старый журнал: { "ГГГГ-ММ-ДД": ["Имя", ...] } — только чтение
  medIntakes: 'med_intakes',    // приёмы: { "ГГГГ-ММ-ДД": [{ medId, scheduledTime, takenAt }] }
  sleepLog: 'sleep_log',        // сон: [{ id, date (день пробуждения), sleepStart, sleepEnd, durationMinutes, … }] (services/sleep.js)
  sleepSettings: 'sleep_settings', // цель сна, желаемое время, модель будущих напоминаний
  stepsLog: 'steps_log',        // шаги: { "ГГГГ-ММ-ДД": { steps, note, source, … } } — один итог за день (services/activity.js)
  walkLog: 'walk_log',          // дистанция пешком: { "ГГГГ-ММ-ДД": { km, note, source, … } } — один итог за день
  bikeLog: 'bike_log',          // велосипед: [{ id, date, time, km, minutes, note, source, … }] — поездки, итог дня = сумма km
  activityMigration: 'activity_migration', // отметка однократного переноса из activity_days (входит в бэкап)
};

/* Ключи с пользовательскими данными (для бэкапа/очистки) — без служебного meta */
const DATA_KEYS = [
  KEYS.alerts, KEYS.tests, KEYS.meds, KEYS.visits, KEYS.metrics, KEYS.metricsLog, KEYS.profile, KEYS.hydration, KEYS.notifications,
  KEYS.activityDays, KEYS.activityGoals, KEYS.medLog, KEYS.medIntakes, KEYS.sleepLog, KEYS.sleepSettings,
  KEYS.stepsLog, KEYS.walkLog, KEYS.bikeLog, KEYS.activityMigration,
];

/* UI-настройка темы: хранится строкой (не JSON), живёт вне DATA_KEYS, но входит в бэкап (settings.theme) */
const THEME_KEY = 'app_theme';
const THEMES = ['dark', 'light'];

/* ---------- Резервная копия (§6.4) ----------
   Формат 1 — ранний (без backupFormatVersion, дата в exportedAt).
   Формат 2 — текущий: метаданные + data (whitelist DATA_KEYS) + settings + blobs.
   Задел под шифрование: зашифрованная копия будет отдельным форматом с полем
   `encryption` и шифротекстом вместо `data`; расшифровка встанет между
   parseBackup() и prepareRestore(), остальной конвейер не меняется. */
export const BACKUP_FORMAT_VERSION = 2;
const SUPPORTED_BACKUP_FORMATS = [1, 2];
const BACKUP_MAX_BYTES = 10 * 1024 * 1024;
/* Технические ключи (не пользовательские данные, в бэкап не входят) */
const ROLLBACK_KEY = 'lexlife_restore_rollback'; // единственная временная копия на время restore
const LAST_BACKUP_KEY = 'lexlife_last_backup_at'; // дата последнего созданного файла
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/* Человекочитаемые названия разделов (сообщения об ошибках валидации) */
const KEY_LABELS = {
  [KEYS.alerts]: 'Предупреждения', [KEYS.tests]: 'Анализы', [KEYS.meds]: 'Лекарства', [KEYS.visits]: 'Визиты',
  [KEYS.metrics]: 'Цели показателей', [KEYS.metricsLog]: 'История показателей', [KEYS.profile]: 'Профиль',
  [KEYS.hydration]: 'План воды', [KEYS.notifications]: 'Уведомления', [KEYS.activityDays]: 'Архив прежней версии (activity_days)',
  [KEYS.activityGoals]: 'Цели активности', [KEYS.medLog]: 'Журнал приёма лекарств',
  [KEYS.medIntakes]: 'Приёмы лекарств', [KEYS.sleepLog]: 'Сон', [KEYS.sleepSettings]: 'Настройки сна',
  [KEYS.stepsLog]: 'Шаги', [KEYS.walkLog]: 'Дистанция пешком', [KEYS.bikeLog]: 'Велосипед',
  [KEYS.activityMigration]: 'Перенос активности',
};

/* Ошибка бэкапа с кодом — UI показывает message как есть */
export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/* Ошибка сохранения сна: DUPLICATE_DATE (existing — запись этой даты) | INVALID | NO_SPACE */
export class SleepStoreError extends Error {
  constructor(code, message, existing = null) {
    super(message);
    this.name = 'SleepStoreError';
    this.code = code;
    this.existing = existing;
  }
}
/* Ошибка сохранения шагов / дистанции / поездки: DUPLICATE_DATE (existing — запись этой даты) | INVALID | NO_SPACE */
export class ActivityStoreError extends Error {
  constructor(code, message, existing = null) {
    super(message);
    this.name = 'ActivityStoreError';
    this.code = code;
    this.existing = existing;
  }
}

/* Происхождение новой записи: вручную — source 'manual' и пустые поля источника; будущий импорт
   передаёт свои значения (sleepStages — только если есть, у ручных записей поля нет) */
function sleepProvenance(v) {
  const o = v || {};
  const p = {
    source: typeof o.source === 'string' && o.source ? o.source : 'manual',
    externalId: o.externalId ?? null,
    sourceDevice: o.sourceDevice ? { ...o.sourceDevice } : null,
    importedAt: o.importedAt ?? null,
  };
  if (o.sleepStages) p.sleepStages = { ...o.sleepStages };
  return p;
}
/* Только поля модели сна (лишнее из формы не попадает в хранилище) */
function sleepFields(v) {
  const o = v || {};
  return {
    date: o.date, sleepStart: o.sleepStart, sleepEnd: o.sleepEnd, durationMinutes: o.durationMinutes,
    quality: o.quality ?? null, awakenings: o.awakenings ?? 0,
    naps: Array.isArray(o.naps) ? o.naps.map((n) => ({ minutes: n.minutes, start: n.start ?? null, end: n.end ?? null })) : [],
    tags: Array.isArray(o.tags) ? o.tags.slice() : [], note: typeof o.note === 'string' ? o.note.slice(0, SLEEP_NOTE_MAX) : '',
  };
}

/* Референсные значения для цветовой индикации (из ТЗ) */
export const REFERENCE = {
  chol: { good: 200, warn: 239, unit: 'mg/dl', label: 'Холестерин общий' },
  ldl: { good: 116, warn: 160, unit: 'mg/dl', label: 'LDL холестерин' },
  hdl: { goodMin: 50, unit: 'mg/dl', higherIsBetter: true, label: 'HDL холестерин' },
  trig: { good: 200, warn: 300, unit: 'mg/dl', label: 'Триглицериды' },
  glucose: { good: 110, warn: 125, unit: 'mg/dl', label: 'Глюкоза' },
  hba1c: { good: 5.7, warn: 6.4, unit: '%', label: 'HbA1c' },
  vitd: { goodMin: 30, unit: 'ng/mL', higherIsBetter: true, label: 'Витамин D3' },
  tsh: { goodMin: 0.27, good: 4.2, unit: 'mUI/L', label: 'ТТГ' },
  psa: { good: 4.0, unit: 'ng/ml', label: 'PSA' },
  hgb: { goodMin: 13, good: 18, unit: 'g/dl', label: 'Гемоглобин' },
  hct: { goodMin: 42, good: 52, unit: '%', label: 'Гематокрит' },
};

export const TEST_FIELDS = [
  'chol', 'ldl', 'hdl', 'trig', 'glucose',
  'hba1c', 'vitd', 'tsh', 'psa', 'hgb', 'hct',
];

/* Анализы от новых к старым. Одна дата — позже добавленный выше: записи хранятся
   в порядке добавления (addTest дописывает в конец, updateTest место не меняет). */
export function sortTests(list) {
  return list.map((t, i) => [t, i])
    .sort((a, b) => b[0].date.localeCompare(a[0].date) || b[1] - a[1])
    .map(([t]) => t);
}

/* ---------- утилиты ---------- */

/* §6.5 — календарная дата в ISO (YYYY-MM-DD, локальная) */
export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
/* Имя файла бэкапа: LexLife-backup-ГГГГ-ММ-ДД-ЧЧММ.json (локальное время создания) */
export function backupFileName(date = new Date()) {
  const hm = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  return `LexLife-backup-${dateKey(date)}-${hm}.json`;
}
/* Вода: часть total дня без разбивки по приёмам (легаси-данные) — не теряется при правках */
function waterExtra(day) {
  const sum = (day.entries || []).reduce((s, e) => s + (Number(e && e.ml) || 0), 0);
  return Math.max(0, (Number(day.total) || 0) - sum);
}
const sumMl = (entries) => entries.reduce((s, e) => s + (Number(e && e.ml) || 0), 0);
/* Найти показанную на экране запись: сначала по индексу, затем по содержимому.
   Если в expect есть key (null — ручная запись), он тоже должен совпасть. */
function findWaterEntry(entries, idx, expect) {
  const same = (e) => !!e && e.t === expect.t && e.ml === expect.ml
    && (!('key' in expect) || (e.key ?? null) === (expect.key ?? null));
  return same(entries[idx]) ? idx : entries.findIndex(same);
}
/* Ключи удалённых импортированных приёмов остаются в дне (removedKeys), чтобы повторный
   импорт того же CSV не вернул запись, которую пользователь удалил сознательно. */
function rememberRemovedKeys(day, removed) {
  const keys = removed.map((e) => e && e.key).filter((k) => typeof k === 'string');
  if (!keys.length) return;
  day.removedKeys = [...new Set([...(Array.isArray(day.removedKeys) ? day.removedKeys : []), ...keys])];
}
/* Один приём лекарства за день — чистая функция над записями дня.
   state: { intakes: [{ medId, scheduledTime, takenAt }] из med_intakes[day], legacy: [имена] из med_log[day] }.
   taken: true — добавить приём (повтор не дублирует), false — удалить только этот приём (medId + time).
   Старая отметка по имени (name в legacy) учитывается, пока у лекарства нет приёмов за день; при первой
   новой отметке она переносится в приём legacyTime (takenAt: null — время приёма неизвестно).
   → { intakes, legacy, legacyChanged } (вход не изменяется) */
export function applyMedIntake(state, { medId, time = null, taken, name = null, legacyTime = null, takenAt = nowISO() }) {
  let intakes = (Array.isArray(state && state.intakes) ? state.intakes : []).filter(isPlainObj).map((r) => ({ ...r }));
  let legacy = Array.isArray(state && state.legacy) ? state.legacy.slice() : [];
  let legacyChanged = false;
  const t = time || null;
  if (name && legacy.includes(name) && !intakes.some((r) => r.medId === medId)) {
    legacy = legacy.filter((x) => x !== name);
    legacyChanged = true;
    intakes.push({ medId, scheduledTime: legacyTime || null, takenAt: null });
  }
  const same = (r) => r.medId === medId && (r.scheduledTime || null) === t;
  if (taken) { if (!intakes.some(same)) intakes.push({ medId, scheduledTime: t, takenAt }); }
  else intakes = intakes.filter((r) => !same(r));
  return { intakes, legacy, legacyChanged };
}

/* §6.5 — метка времени в полном ISO (UTC) */
const nowISO = () => new Date().toISOString();
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* Витальные показатели по умолчанию (нейтральные системные значения; используются
   только миграцией v1→v2 для очень старых установок — новые пользователи их не видят). */
function defaultVitals() {
  const at = nowISO();
  return {
    weight: { value: 70, unit: 'кг', at },
    pressure: { systolic: 120, diastolic: 80, unit: 'mmHg', at },
    pulse: { value: 70, unit: 'bpm', at },
    water: { goal: 2.5, unit: 'л', at }, // значение воды живёт в water_log (единый модуль)
  };
}

/* Тестовая история воды за год: { "YYYY-MM-DD": литры }. Детерминированно, чтобы
   графики Неделя/Месяц/Год были наполнены. Сегодня = 1.8 (совпадает с «Сегодня»). */
function defaultWaterLog() {
  const log = {};
  const today = new Date();
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const s = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate();
    const base = 1.8 + 0.45 * Math.sin(s / 3);
    const noise = ((s * 9301 + 49297) % 233280) / 233280; // 0..1
    let v = base + (noise - 0.5) * 0.9;
    v = Math.max(0.4, Math.min(2.9, v));
    log[dateKey(d)] = Math.round(v * 10) / 10;
  }
  log[dateKey(today)] = 1.8;
  return log;
}

/* ---------- Обобщённая модель показателей (схема v4) ----------
   Все показатели (вес/давление/пульс/вода/температура/сатурация/глюкоза)
   используют единый формат: конфиг в health_metrics, история — в metrics_log. */

export const METRIC_KEYS = ['weight', 'pressure', 'pulse', 'water', 'temperature', 'spo2', 'glucose'];

/* Параметры генерации демо-истории (используется только миграцией v3→v4 для
   очень старых установок, где показателя ещё не было; новые пользователи получают
   пустую историю через _seed(), см. ниже). Нейтральные значения, не привязаны к
   реальным данным конкретного пользователя. */
const METRIC_SEED = {
  weight: { base: 70, spread: 0.5, decimals: 1, min: 60, max: 85 },
  pulse: { base: 72, spread: 6, decimals: 0, min: 52, max: 98 },
  water: { base: 1.8, spread: 0.5, decimals: 1, min: 0.4, max: 2.9 },
  temperature: { base: 36.6, spread: 0.22, decimals: 1, min: 35.8, max: 37.6 },
  spo2: { base: 97, spread: 1.1, decimals: 0, min: 92, max: 100 },
  glucose: { base: 5.5, spread: 0.7, decimals: 1, min: 4.0, max: 8.5 },
};

/* Детерминированная история за год для одного показателя */
function genHistory(metric) {
  const log = {};
  const today = new Date();
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const s = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate();
    const wave = Math.sin(s / 3);
    const noise = ((s * 9301 + 49297) % 233280) / 233280 - 0.5;
    if (metric === 'pressure') {
      log[dateKey(d)] = {
        systolic: Math.max(105, Math.min(150, Math.round(125 + wave * 6 + noise * 9))),
        diastolic: Math.max(65, Math.min(95, Math.round(80 + wave * 4 + noise * 6))),
      };
    } else if (metric === 'water') {
      let ml = 1800 + wave * 450 + noise * 900;
      ml = Math.max(600, Math.min(2900, Math.round(ml / 50) * 50));
      log[dateKey(d)] = { total: ml, entries: [] };
    } else {
      const c = METRIC_SEED[metric];
      const p = Math.pow(10, c.decimals);
      let v = c.base + wave * c.spread + noise * c.spread * 1.6;
      v = Math.max(c.min, Math.min(c.max, Math.round(v * p) / p));
      log[dateKey(d)] = v;
    }
  }
  return log;
}

/* Конфиг показателей по умолчанию (цель + единица) — нейтральные системные значения,
   пользователь меняет их на свои в модуле показателя. */
function defaultMetricsConfig() {
  const at = nowISO();
  return {
    weight: { goal: 75, unit: 'кг', at },
    pressure: { goal: { systolic: 120, diastolic: 80 }, unit: 'mmHg', at },
    pulse: { goal: 70, unit: 'уд/мин', at },
    water: { goal: 2600, unit: 'мл', at },
    temperature: { goal: 36.6, unit: '°C', at },
    spo2: { goal: 97, unit: '%', at },
    glucose: { goal: 5.5, unit: 'ммоль/л', at },
  };
}

/* История всех показателей — чистая база для нового пользователя (без демо-данных).
   genHistory()/METRIC_SEED остаются только для миграции v3→v4 старых установок. */
function defaultMetricsLog() {
  const log = {};
  METRIC_KEYS.forEach((m) => { log[m] = {}; });
  return log;
}

function defaultProfile() {
  return { name: '', photo: null };
}

/* Конфиг гидратации: окно бодрствования, интервал слотов, тумблер напоминаний.
   Цель воды живёт в health_metrics.water.goal (без дубля). */
function defaultHydration() {
  return { wakeStart: '07:00', wakeEnd: '23:00', slotMinutes: 120, notify: false };
}

/* Правила уведомлений по умолчанию — по одному на тип. Модель сразу под push
   (поле channel: 'local' | 'push'; подписка push — отдельный ключ позже). */
function defaultNotifications() {
  const base = { enabled: true, time: '09:00', repeat: 'daily', days: [], intervalMinutes: 120, startTime: '07:00', endTime: '23:00', date: null, ref: {}, channel: 'local', lastFiredAt: null };
  return [
    { id: uid(), type: 'meds', ...base, time: '21:00', text: 'Пора принять лекарства' },
    { id: uid(), type: 'water', ...base, repeat: 'interval', time: '07:00', text: 'Время попить воды' },
    { id: uid(), type: 'pressure', ...base, time: '09:00', text: 'Измерьте давление', ref: { metric: 'pressure' } },
    { id: uid(), type: 'weight', ...base, repeat: 'weekly', time: '08:00', days: [1], text: 'Контрольное взвешивание', ref: { metric: 'weight' } },
    { id: uid(), type: 'tests', ...base, enabled: false, repeat: 'once', date: '2026-09-01', text: 'Повторить анализы крови натощак' },
    { id: uid(), type: 'visits', ...base, time: '09:00', text: 'Проверьте предстоящие визиты' },
  ];
}

/* Аддитивные поля визита: вид события, название, время, метка импорта истории */
const VISIT_EXTRA_FIELDS = ['kind', 'title', 'time', 'importId', 'importedAt', 'source'];

/* Приводит визит к полной модели v7 (общий код для seed и миграции).
   Старый формат: doctor = "Врач · Специальность", desc = заключение. */
function normalizeVisit(v) {
  const parts = String(v.doctor || '').split('·').map((s) => s.trim());
  return {
    id: v.id || uid(),
    date: v.date || dateKey(),
    doctor: parts[0] || '',
    specialty: v.specialty != null ? v.specialty : parts.slice(1).join(' · '),
    clinic: v.clinic || '',
    reason: v.reason || '',
    conclusion: v.conclusion != null ? v.conclusion : (v.desc || ''),
    recommendations: v.recommendations || '',
    nextDate: v.nextDate || null,
    status: v.status || 'done',
    attachments: v.attachments || [],
    links: v.links || { testIds: [], medIds: [], reminderIds: [] },
    /* аддитивные поля (services/visitKinds.js, services/historyImport.js) — только если заданы */
    ...Object.fromEntries(VISIT_EXTRA_FIELDS.filter((k) => v[k] != null).map((k) => [k, v[k]])),
  };
}

/* =========================================================
   §6.4 Валидация резервной копии — чистые функции, ничего не пишут.
   Бэкап — недоверенный ввод: только whitelist ключей, строгие типы,
   без опасных ключей (__proto__/prototype/constructor), без исполнения кода.
   ========================================================= */

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v) => v == null || isNum(v);
const isStrOrNull = (v) => v == null || typeof v === 'string';
const isDateStr = (v) => typeof v === 'string' && (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v));
const isDateOrNull = (v) => v == null || isDateStr(v);
const isTimeStr = (v) => typeof v === 'string' && (v === '' || /^\d{2}:\d{2}$/.test(v));
const isTimeOrNull = (v) => v == null || isTimeStr(v);
const isSafeId = (v) => isNum(v) || (typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v));
const isIdList = (v) => v == null || (Array.isArray(v) && v.every(isSafeId));
const PHOTO_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/* Глубокая копия JSON-значения: опасные ключи отбрасываются (не присваиваются —
   сеттер __proto__ не вызывается), глубина ограничена. stats.stripped — счётчик. */
function sanitizeJson(value, stats, depth = 0) {
  if (depth > 24) throw new BackupError('CORRUPT', 'Резервная копия повреждена: слишком глубокая структура данных.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((x) => sanitizeJson(x, stats, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) { stats.stripped += 1; continue; }
      out[k] = sanitizeJson(value[k], stats, depth + 1);
    }
    return out;
  }
  return null; // undefined/function/symbol в JSON не бывают — на всякий случай
}

const listOf = (pred) => (v) => Array.isArray(v) && v.every((x) => isPlainObj(x) && pred(x));
const mapOf = (pred) => (v) => isPlainObj(v) && Object.entries(v).every(([k, x]) => pred(x, k));

/* Анализ: необязательные поля (все аддитивные — старые версии их просто не показывают).
   attachments — метаданные документа (сам файл в IndexedDB, services/attachments.js);
   customResults — показатели вне основных полей формы (value — число; text — качественный
   результат бланка без числа, например «отрицательно»); labRanges — диапазоны лаборатории
   для основных полей; importId — метка подготовленного импорта (защита от повторов). */
const TEST_ATTACHMENT_OK = (a) => isPlainObj(a) && (a.attachmentId == null || isSafeId(a.attachmentId))
  && isStrOrNull(a.name) && isStrOrNull(a.type) && isNumOrNull(a.size) && isStrOrNull(a.addedAt);
const TEST_RESULT_OK = (r) => isPlainObj(r) && typeof r.name === 'string' && isNumOrNull(r.value) && isStrOrNull(r.text)
  && isStrOrNull(r.unit) && isStrOrNull(r.ref) && isStrOrNull(r.group) && isNumOrNull(r.refLow) && isNumOrNull(r.refHigh);
export const IMPORT_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const testExtrasOk = (t) => (t.attachments == null || (Array.isArray(t.attachments) && t.attachments.every(TEST_ATTACHMENT_OK)))
  && (t.customResults == null || (Array.isArray(t.customResults) && t.customResults.every(TEST_RESULT_OK)))
  && (t.labRanges == null || mapOf((x, k) => TEST_FIELDS.includes(k) && typeof x === 'string')(t.labRanges))
  && (t.importId == null || (typeof t.importId === 'string' && IMPORT_ID_RE.test(t.importId)))
  && isStrOrNull(t.importedAt) && isStrOrNull(t.source);

const METRIC_VALUE_OK = {
  pressure: (x) => x == null || (isPlainObj(x) && isNumOrNull(x.systolic) && isNumOrNull(x.diastolic)),
  water: (x) => x == null || (isPlainObj(x) && isNumOrNull(x.total) && (x.entries == null
    || (Array.isArray(x.entries) && x.entries.every((e) => isPlainObj(e) && isTimeStr(e.t) && isNum(e.ml))))),
};
const metricValueOk = (m, x) => (METRIC_VALUE_OK[m] || isNumOrNull)(x);
const NOTIF_TYPE_LIST = ['meds', 'water', 'pressure', 'weight', 'tests', 'visits'];
/* Расписание лекарства (аддитивное поле): режим, дни недели (0=Вс…6=Сб, как в notifications), времена */
export const MED_MODES = ['daily', 'days', 'asNeeded'];
const isWeekdays = (v) => Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
const MED_SCHEDULE_OK = (s) => s == null || (isPlainObj(s) && MED_MODES.includes(s.mode)
  && (s.days == null || isWeekdays(s.days)) && (s.times == null || (Array.isArray(s.times) && s.times.every((t) => isTimeStr(t) && t !== ''))));
const MED_INTAKE_OK = (r) => isPlainObj(r) && isSafeId(r.medId) && isTimeOrNull(r.scheduledTime) && isStrOrNull(r.takenAt);

/* Структура каждого ключа финальной схемы (CURRENT_SCHEMA_VERSION).
   Поля, которые UI подставляет в разметку без экранирования (id, фото, числа, время),
   проверяются строго; свободный текст — только тип string. */
const KEY_VALIDATORS = {
  [KEYS.alerts]: listOf((a) => a.id == null || isSafeId(a.id)),
  [KEYS.tests]: listOf((t) => isDateStr(t.date) && (t.id == null || isSafeId(t.id)) && isStrOrNull(t.note)
    && TEST_FIELDS.every((f) => isNumOrNull(t[f])) && testExtrasOk(t)),
  [KEYS.meds]: listOf((m) => typeof m.name === 'string' && (m.id == null || isSafeId(m.id))
    && isTimeOrNull(m.reminder_time) && isNumOrNull(m.every_days) && isDateOrNull(m.start) && isStrOrNull(m.end)
    && isStrOrNull(m.icon) && isStrOrNull(m.dose) && isStrOrNull(m.purpose)
    && MED_SCHEDULE_OK(m.schedule) && isStrOrNull(m.note) && isStrOrNull(m.deletedAt)),
  [KEYS.visits]: listOf((v) => isSafeId(v.id) && isDateStr(v.date) && isDateOrNull(v.nextDate)
    && ['doctor', 'specialty', 'clinic', 'reason', 'conclusion', 'recommendations', 'status'].every((f) => isStrOrNull(v[f]))
    && (v.attachments == null || (Array.isArray(v.attachments) && v.attachments.every((a) => isPlainObj(a) && (a.attachmentId == null || isSafeId(a.attachmentId)))))
    && (v.links == null || (isPlainObj(v.links) && isIdList(v.links.testIds) && isIdList(v.links.medIds) && isIdList(v.links.reminderIds)))),
  [KEYS.metrics]: mapOf((c, m) => METRIC_KEYS.includes(m) && isPlainObj(c) && isStrOrNull(c.unit)
    && (m === 'pressure' ? c.goal == null || (isPlainObj(c.goal) && isNumOrNull(c.goal.systolic) && isNumOrNull(c.goal.diastolic)) : isNumOrNull(c.goal))),
  [KEYS.metricsLog]: mapOf((log, m) => METRIC_KEYS.includes(m) && mapOf((x, d) => isDateStr(d) && d !== '' && metricValueOk(m, x))(log)),
  [KEYS.profile]: (p) => isPlainObj(p) && isStrOrNull(p.name) && (p.photo == null || (typeof p.photo === 'string' && PHOTO_RE.test(p.photo))),
  [KEYS.hydration]: (h) => isPlainObj(h) && isTimeOrNull(h.wakeStart) && isTimeOrNull(h.wakeEnd) && isNumOrNull(h.slotMinutes)
    && (h.notify == null || typeof h.notify === 'boolean'),
  [KEYS.notifications]: listOf((n) => isSafeId(n.id) && NOTIF_TYPE_LIST.includes(n.type) && isTimeOrNull(n.time)
    && isTimeOrNull(n.startTime) && isTimeOrNull(n.endTime) && isDateOrNull(n.date) && isNumOrNull(n.intervalMinutes)
    && isStrOrNull(n.text) && isStrOrNull(n.repeat) && isStrOrNull(n.channel) && isStrOrNull(n.lastFiredAt)
    && (n.enabled == null || typeof n.enabled === 'boolean')
    && (n.days == null || (Array.isArray(n.days) && n.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)))
    && (n.ref == null || isPlainObj(n.ref))),
  [KEYS.activityDays]: mapOf((a, d) => isDateStr(d) && d !== '' && isPlainObj(a) && isNumOrNull(a.bike) && isNumOrNull(a.steps)
    && isNumOrNull(a.otherMin) && isStrOrNull(a.bikeIntensity) && isStrOrNull(a.otherType)
    && (a.plank == null || (Array.isArray(a.plank) && a.plank.every(isNumOrNull)))),
  [KEYS.activityGoals]: mapOf((x) => isNumOrNull(x)),
  [KEYS.medLog]: mapOf((list, d) => isDateStr(d) && d !== '' && Array.isArray(list) && list.every((x) => typeof x === 'string')),
  [KEYS.medIntakes]: mapOf((list, d) => isDateStr(d) && d !== '' && Array.isArray(list) && list.every(MED_INTAKE_OK)),
  [KEYS.sleepLog]: isValidSleepLog,
  [KEYS.sleepSettings]: isValidSleepSettings,
  [KEYS.stepsLog]: isValidStepsLog,
  [KEYS.walkLog]: isValidWalkLog,
  [KEYS.bikeLog]: isValidBikeLog,
  [KEYS.activityMigration]: isValidActivityMigration,
};

/* Проверка набора данных финальной схемы; бросает BackupError с названием раздела */
function validateData(data) {
  for (const k of DATA_KEYS) {
    if (!KEY_VALIDATORS[k](data[k])) {
      throw new BackupError('CORRUPT', `Резервная копия повреждена: некорректный раздел «${KEY_LABELS[k]}».`);
    }
  }
}

/* Ключи, допустимые во входном бэкапе конкретной схемы (whitelist).
   water_log существовал в схемах v3 (до переноса в metrics_log в v4). */
function allowedBackupKeys(schemaVersion) {
  return schemaVersion < 4 ? [...DATA_KEYS, 'water_log'] : DATA_KEYS;
}

/* Краткая сводка для экрана предпросмотра */
function summarize(data) {
  const log = data[KEYS.metricsLog] || {};
  const metricEntries = Object.values(log).reduce((s, byDay) => s + Object.keys(byDay || {}).length, 0);
  return {
    metrics: metricEntries,
    meds: (data[KEYS.meds] || []).length,
    tests: (data[KEYS.tests] || []).length,
    visits: (data[KEYS.visits] || []).length,
    notifications: (data[KEYS.notifications] || []).length,
    activityDays: Object.keys(data[KEYS.activityDays] || {}).length,
    sleep: Array.isArray(data[KEYS.sleepLog]) ? data[KEYS.sleepLog].length : 0,
    steps: Object.keys(data[KEYS.stepsLog] || {}).length,
    walk: Object.keys(data[KEYS.walkLog] || {}).length,
    bike: Array.isArray(data[KEYS.bikeLog]) ? data[KEYS.bikeLog].length : 0,
  };
}

/* Текст файла → объект. Только JSON.parse, никакого eval. */
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) throw new BackupError('INVALID_JSON', 'Файл пуст или не является резервной копией LexLife.');
  if (text.length > BACKUP_MAX_BYTES) throw new BackupError('TOO_LARGE', 'Файл слишком большой для резервной копии LexLife.');
  let raw;
  try { raw = JSON.parse(text); } catch {
    throw new BackupError('INVALID_JSON', 'Файл повреждён: это не корректный JSON.');
  }
  if (!isPlainObj(raw)) throw new BackupError('INVALID_JSON', 'Файл не является резервной копией LexLife.');
  return raw;
}

/* Проверка «конверта» бэкапа: приложение, формат, схема, data → нормализованная копия */
function inspectBackup(raw) {
  if (!isPlainObj(raw)) throw new BackupError('INVALID_JSON', 'Файл не является резервной копией LexLife.');
  if (raw.app !== APP_ID && !LEGACY_APP_IDS.includes(raw.app)) {
    throw new BackupError('NOT_LEXLIFE', 'Этот файл не является резервной копией LexLife.');
  }
  if (raw.encryption != null) {
    throw new BackupError('ENCRYPTED', 'Зашифрованные резервные копии не поддерживаются этой версией LexLife. Обновите приложение.');
  }
  const format = raw.backupFormatVersion ?? 1;
  if (!Number.isInteger(format)) throw new BackupError('UNSUPPORTED', 'Неизвестный формат резервной копии.');
  const schema = raw.schemaVersion;
  if (format > BACKUP_FORMAT_VERSION || (Number.isInteger(schema) && schema > CURRENT_SCHEMA_VERSION)) {
    throw new BackupError('NEWER_VERSION', 'Эта резервная копия создана более новой версией LexLife. Обновите приложение перед восстановлением.');
  }
  if (!SUPPORTED_BACKUP_FORMATS.includes(format)) throw new BackupError('UNSUPPORTED', 'Неподдерживаемый формат резервной копии.');
  if (!Number.isInteger(schema) || schema < 1) {
    throw new BackupError('UNSUPPORTED', 'В резервной копии нет корректной версии схемы данных.');
  }
  if (!isPlainObj(raw.data)) throw new BackupError('NO_DATA', 'Резервная копия повреждена: нет раздела с данными.');

  const stats = { stripped: 0 };
  const allowed = allowedBackupKeys(schema);
  const data = {};
  const ignoredKeys = [];
  for (const k of Object.keys(raw.data)) {
    if (FORBIDDEN_KEYS.has(k)) { stats.stripped += 1; continue; }
    if (!allowed.includes(k)) { ignoredKeys.push(k); continue; }
    if (raw.data[k] == null) continue; // null = раздел не создавался — получит значение по умолчанию
    data[k] = sanitizeJson(raw.data[k], stats);
  }
  if (!Object.keys(data).length) throw new BackupError('NO_DATA', 'Резервная копия не содержит данных LexLife.');

  const createdAtRaw = raw.createdAt ?? raw.exportedAt ?? null;
  const createdAt = typeof createdAtRaw === 'string' && !Number.isNaN(Date.parse(createdAtRaw)) ? createdAtRaw : null;
  const theme = isPlainObj(raw.settings) && THEMES.includes(raw.settings.theme) ? raw.settings.theme : null;
  return {
    app: raw.app,
    format,
    schemaVersion: schema,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion.slice(0, 32) : null,
    createdAt,
    data,
    theme,
    ignoredKeys,
    strippedKeys: stats.stripped,
  };
}

/* =========================================================
   §6.2 Драйверы хранилища (адаптер). Единый интерфейс:
     get(key) -> string|null, set, remove, keys, clear
   Доменный слой не знает, какой драйвер активен.
   ========================================================= */

class LocalStorageDriver {
  async get(key) {
    return localStorage.getItem(key);
  }
  async set(key, value) {
    localStorage.setItem(key, value);
  }
  async remove(key) {
    localStorage.removeItem(key);
  }
  async keys() {
    return Object.keys(localStorage);
  }
  async clear(prefixKeys) {
    (prefixKeys || Object.keys(localStorage)).forEach((k) => localStorage.removeItem(k));
  }
}

/* Драйвер в памяти — песочница для подготовки restore: бэкап загружается сюда,
   прогоняется через те же MIGRATIONS и проверяется, не касаясь реальной базы. */
export class MemoryDriver {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async set(key, value) { this.map.set(key, String(value)); }
  async remove(key) { this.map.delete(key); }
  async keys() { return [...this.map.keys()]; }
  async clear(prefixKeys) { (prefixKeys || [...this.map.keys()]).forEach((k) => this.map.delete(k)); }
}

/* Задел §6.2/§6.6: будущий драйвер для больших данных и бинарных вложений.
   В v1.0 не активен — оставлен как точка расширения интерфейса. */
// eslint-disable-next-line no-unused-vars
class IndexedDbDriver {
  async get() { throw new Error('IndexedDbDriver появится после v1.0 (ARCHITECTURE.md §6.2)'); }
  async set() { throw new Error('IndexedDbDriver появится после v1.0 (ARCHITECTURE.md §6.2)'); }
  async remove() { throw new Error('IndexedDbDriver появится после v1.0'); }
  async keys() { throw new Error('IndexedDbDriver появится после v1.0'); }
  async clear() { throw new Error('IndexedDbDriver появится после v1.0'); }
}

/* =========================================================
   §6.3 Конвейер миграций.
   Каждая миграция: { to: N, async run(service) }.
   В v1.0 список пуст — структура готова к будущим версиям.
   ========================================================= */
const MIGRATIONS = [
  // v1 → v2: добавлены витальные показатели (health_metrics) для вкладки «Показатели»
  {
    to: 2,
    async run(svc) {
      if (!svc.noDemoData && (await svc._read(KEYS.metrics, null)) == null) {
        await svc._write(KEYS.metrics, defaultVitals());
      }
    },
  },
  // v2 → v3: добавлена история воды (water_log) для страницы «Вода»
  {
    to: 3,
    async run(svc) {
      if ((await svc._read('water_log', null)) == null) {
        await svc._write('water_log', svc.noDemoData ? {} : defaultWaterLog());
      }
    },
  },
  // v3 → v4: обобщение показателей. water_log → metrics_log.water; health_metrics → конфиг;
  // добавлены temperature/spo2/glucose; текущие vitals перенесены в историю. Данные не теряются.
  {
    to: 4,
    async run(svc) {
      const today = dateKey();
      const mlog = (await svc._read(KEYS.metricsLog, null)) || {};

      // 1) перенести историю воды 1:1
      const oldWater = await svc._read('water_log', null);
      if (oldWater && !mlog.water) mlog.water = oldWater;

      // 2) недостающим показателям — тестовая история
      METRIC_KEYS.forEach((m) => { if (!mlog[m]) mlog[m] = svc.noDemoData ? {} : genHistory(m); });

      // 3) перенести текущие vitals из старого health_metrics в сегодняшнюю запись
      const oldHm = (await svc._read(KEYS.metrics, {})) || {};
      if (oldHm.weight && oldHm.weight.value != null) mlog.weight[today] = oldHm.weight.value;
      if (oldHm.pulse && oldHm.pulse.value != null) mlog.pulse[today] = oldHm.pulse.value;
      if (oldHm.pressure && oldHm.pressure.systolic != null) {
        mlog.pressure[today] = { systolic: oldHm.pressure.systolic, diastolic: oldHm.pressure.diastolic };
      }
      await svc._write(KEYS.metricsLog, mlog);

      // 4) health_metrics → конфиг (сохранить пользовательские цели, где были)
      const cfg = defaultMetricsConfig();
      if (oldHm.water && oldHm.water.goal != null) cfg.water.goal = oldHm.water.goal;
      if (oldHm.weight && oldHm.weight.goal != null) cfg.weight.goal = oldHm.weight.goal;
      await svc._write(KEYS.metrics, cfg);

      // 5) профиль
      if ((await svc._read(KEYS.profile, null)) == null) await svc._write(KEYS.profile, defaultProfile());

      // 6) удалить устаревший water_log (данные уже перенесены в metrics_log.water)
      await svc.driver.remove('water_log');
    },
  },
  // v4 → v5: вода получает приёмы по времени. water[date]: число(л) → { total(мл), entries:[{t,ml}] };
  // конфиг воды переводится в мл. Данные сохраняются.
  {
    to: 5,
    async run(svc) {
      const mlog = (await svc._read(KEYS.metricsLog, {})) || {};
      if (mlog.water) {
        const conv = {};
        for (const [d, v] of Object.entries(mlog.water)) {
          if (v && typeof v === 'object' && 'total' in v) conv[d] = v;
          else conv[d] = { total: Math.round((Number(v) || 0) * 1000), entries: [] };
        }
        mlog.water = conv;
        await svc._write(KEYS.metricsLog, mlog);
      }
      const cfg = (await svc._read(KEYS.metrics, {})) || {};
      if (cfg.water) {
        const g = cfg.water.goal;
        cfg.water = { ...cfg.water, goal: g != null && g < 100 ? Math.round(g * 1000) : g || 2500, unit: 'мл' };
        await svc._write(KEYS.metrics, cfg);
      }
    },
  },
  // v5 → v6: конфиг гидратации (план по времени) + цель воды 2500 → 2600 (если не менялась).
  {
    to: 6,
    async run(svc) {
      if ((await svc._read(KEYS.hydration, null)) == null) await svc._write(KEYS.hydration, defaultHydration());
      const cfg = (await svc._read(KEYS.metrics, {})) || {};
      if (cfg.water && cfg.water.goal === 2500) {
        cfg.water = { ...cfg.water, goal: 2600 };
        await svc._write(KEYS.metrics, cfg);
      }
    },
  },
  // v6 → v7: расширение визитов (специальность/клиника/причина/заключение/рекомендации/
  // следующий визит/связи). Старые поля сохраняются (desc → conclusion, doctor разбивается).
  {
    to: 7,
    async run(svc) {
      const list = (await svc._read(KEYS.visits, [])) || [];
      if (list.some((v) => v.specialty === undefined)) {
        await svc._write(KEYS.visits, list.map(normalizeVisit));
      }
    },
  },
  // v7 → v8: центр уведомлений (правила по типам, модель под push)
  {
    to: 8,
    async run(svc) {
      if ((await svc._read(KEYS.notifications, null)) == null) await svc._write(KEYS.notifications, defaultNotifications());
    },
  },
];

/* =========================================================
   StorageService — единый слой (§6.1)
   ========================================================= */

export class StorageService {
  constructor(driver) {
    this.driver = driver;
    this.KEYS = KEYS;
    this.dateKey = dateKey;
    this.uid = uid;
    this.noDemoData = false; // true — песочница restore: миграции не добавляют демо-историю
  }

  /* ---- низкоуровневые (JSON поверх драйвера) ---- */
  async _read(key, fallback) {
    try {
      const raw = await this.driver.get(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn(`[storage] чтение ${key} не удалось`, err);
      return fallback;
    }
  }
  async _write(key, value) {
    try {
      await this.driver.set(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn(`[storage] запись ${key} не удалась`, err);
      return false;
    }
  }

  /* ---- инициализация: свежая установка → seed (финальная схема);
         существующие данные → конвейер миграций ---- */
  async init() {
    await this._recoverInterruptedRestore();
    const meta = await this._read(KEYS.meta, null);
    if (!meta || !meta.seededAt) await this._seed();
    else await this._migrate();
    /* аддитивные разделы без смены схемы: у существующих установок появляются пустыми / по умолчанию */
    if ((await this._read(KEYS.medIntakes, null)) == null) await this._write(KEYS.medIntakes, {});
    if ((await this._read(KEYS.sleepLog, null)) == null) await this._write(KEYS.sleepLog, []);
    if ((await this._read(KEYS.sleepSettings, null)) == null) await this._write(KEYS.sleepSettings, defaultSleepSettings());
    await this._ensureActivityKeys();
    await this._migrateActivity();
    return this;
  }

  /* Шаги / дистанция / велосипед — аддитивные разделы (как sleep_log): появляются пустыми */
  async _ensureActivityKeys() {
    if ((await this._read(KEYS.stepsLog, null)) == null) await this._write(KEYS.stepsLog, {});
    if ((await this._read(KEYS.walkLog, null)) == null) await this._write(KEYS.walkLog, {});
    if ((await this._read(KEYS.bikeLog, null)) == null) await this._write(KEYS.bikeLog, []);
  }

  /* Однократный перенос старой «Активности» (activity_days) в steps_log / bike_log.
     Отметка activity_migration пишется последней и только после успешной записи данных:
     сбой посередине → при следующем запуске перенос повторится, но не задублирует
     (migrateLegacyActivity пропускает занятые даты и уже перенесённые поездки).
     Отметка есть → ничего не делается (удалённые пользователем записи не возвращаются).
     activity_days не изменяется. → отметка | null (перенос уже был / не удалось записать) */
  async _migrateActivity() {
    if ((await this._read(KEYS.activityMigration, null)) != null) return null;
    const res = migrateLegacyActivity({
      activityDays: await this._read(KEYS.activityDays, {}),
      stepsLog: await this._read(KEYS.stepsLog, {}),
      bikeLog: await this._read(KEYS.bikeLog, []),
    }, { now: nowISO() });
    if (res.changed) {
      if (!(await this._write(KEYS.stepsLog, res.stepsLog))) return null;
      if (!(await this._write(KEYS.bikeLog, res.bikeLog))) return null;
    }
    if (!(await this._write(KEYS.activityMigration, res.marker))) return null;
    return res.marker;
  }

  /* §6.3 привести схему к текущей версии */
  async _migrate() {
    const meta = await this._read(KEYS.meta, null);
    let from = meta ? meta.schemaVersion ?? meta.version ?? 0 : 0;
    for (const m of MIGRATIONS) {
      if (m.to > from && m.to <= CURRENT_SCHEMA_VERSION) {
        await m.run(this);
        from = m.to;
      }
    }
    const next = { ...(meta || {}), schemaVersion: CURRENT_SCHEMA_VERSION };
    await this._write(KEYS.meta, next);
  }

  /* первичная инициализация (однократно) — чистая база, без демо/медицинских данных.
     Новый пользователь начинает с пустых коллекций; заполняет их сам через UI. */
  async _seed() {
    const meta = await this._read(KEYS.meta, {});
    if (meta.seededAt) return;

    await this._ensureDefaults();

    meta.seededAt = nowISO();
    meta.schemaVersion = CURRENT_SCHEMA_VERSION;
    await this._write(KEYS.meta, meta);
  }

  /* недостающие разделы финальной схемы → значения по умолчанию (seed и restore) */
  async _ensureDefaults() {
    if ((await this._read(KEYS.alerts, null)) == null) {
      await this._write(KEYS.alerts, []);
    }
    if ((await this._read(KEYS.tests, null)) == null) {
      await this._write(KEYS.tests, []);
    }
    if ((await this._read(KEYS.meds, null)) == null) {
      await this._write(KEYS.meds, []);
    }
    if ((await this._read(KEYS.visits, null)) == null) {
      await this._write(KEYS.visits, []);
    }
    if ((await this._read(KEYS.activityGoals, null)) == null) {
      await this._write(KEYS.activityGoals, { bike_minutes: 45, steps: 8000, water_liters: 2.3, plank_seconds: 60 });
    }
    // Показатели (финальная модель v4): конфиг + история + профиль
    if ((await this._read(KEYS.metrics, null)) == null) await this._write(KEYS.metrics, defaultMetricsConfig());
    if ((await this._read(KEYS.metricsLog, null)) == null) await this._write(KEYS.metricsLog, defaultMetricsLog());
    if ((await this._read(KEYS.profile, null)) == null) await this._write(KEYS.profile, defaultProfile());
    if ((await this._read(KEYS.hydration, null)) == null) await this._write(KEYS.hydration, defaultHydration());
    if ((await this._read(KEYS.notifications, null)) == null) await this._write(KEYS.notifications, defaultNotifications());
    if ((await this._read(KEYS.activityDays, null)) == null) await this._write(KEYS.activityDays, {});
    if ((await this._read(KEYS.medLog, null)) == null) await this._write(KEYS.medLog, {});
    if ((await this._read(KEYS.medIntakes, null)) == null) await this._write(KEYS.medIntakes, {});
    if ((await this._read(KEYS.sleepLog, null)) == null) await this._write(KEYS.sleepLog, []);
    if ((await this._read(KEYS.sleepSettings, null)) == null) await this._write(KEYS.sleepSettings, defaultSleepSettings());
    await this._ensureActivityKeys();
  }

  /* ---- Предупреждения ---- */
  async getAlerts() {
    return this._read(KEYS.alerts, []);
  }

  /* ---- Показатели: обобщённый API (вес/давление/пульс/вода/темп./сатур./глюкоза) ----
     Конфиг (цель/единица) — в health_metrics; история — в metrics_log. */
  async getMetricsConfig() {
    return this._read(KEYS.metrics, {});
  }
  async getMetricConfig(metric) {
    return (await this.getMetricsConfig())[metric] || {};
  }
  async getMetricGoal(metric) {
    return (await this.getMetricConfig(metric)).goal;
  }
  async setMetricGoal(metric, goal) {
    const cfg = await this.getMetricsConfig();
    cfg[metric] = { ...(cfg[metric] || {}), goal, at: nowISO() };
    await this._write(KEYS.metrics, cfg);
    return cfg[metric];
  }
  async getMetricsLog() {
    return this._read(KEYS.metricsLog, {});
  }
  async getMetricLog(metric) {
    return (await this.getMetricsLog())[metric] || {};
  }
  /* последнее значение по дате: { date, value } | null */
  async getMetricLatest(metric) {
    const log = await this.getMetricLog(metric);
    const days = Object.keys(log).sort();
    const d = days[days.length - 1];
    return d ? { date: d, value: log[d] } : null;
  }
  async getMetricValue(metric, day = dateKey()) {
    return (await this.getMetricLog(metric))[day];
  }
  async setMetricValue(metric, value, day = dateKey()) {
    const all = await this.getMetricsLog();
    all[metric] = { ...(all[metric] || {}) };
    all[metric][day] = value;
    await this._write(KEYS.metricsLog, all);
    return value;
  }
  /* инкремент (для накопительных показателей — вода) */
  async addMetricValue(metric, amount, day = dateKey()) {
    const log = await this.getMetricLog(metric);
    const cur = typeof log[day] === 'number' ? log[day] : 0;
    return this.setMetricValue(metric, Math.max(0, Math.round((cur + amount) * 10) / 10), day);
  }

  /* ---- Вода: приёмы по времени { total(мл), entries:[{t:"ЧЧ:ММ", ml}] } ----
     Всё в той же metrics_log.water — отдельной модели нет. */
  async getWaterLog() { return this.getMetricLog('water'); }
  async getWaterDay(day = dateKey()) {
    return (await this.getMetricLog('water'))[day] || { total: 0, entries: [] };
  }
  async getWater(day = dateKey()) { return (await this.getWaterDay(day)).total || 0; }
  async getWaterEntries(day = dateKey()) { return (await this.getWaterDay(day)).entries || []; }
  async getWaterGoal() { return (await this.getMetricGoal('water')) || 2500; }
  async setWaterGoal(ml) { return this.setMetricGoal('water', Math.round(ml)); }
  /* Приём воды. Без day/t — фактические локальные дата и время нажатия, взятые из ОДНОГО
     момента (около полуночи дата и время не разойдутся). План дня время записи не меняет. */
  async addWaterEntry(ml, day, t) {
    const now = new Date();
    day = day || dateKey(now);
    const time = t || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const all = await this.getMetricsLog();
    all.water = { ...(all.water || {}) };
    const cur = all.water[day] || { total: 0, entries: [] };
    const entries = [...(cur.entries || []), { t: time, ml: Math.round(ml) }].sort((a, b) => a.t.localeCompare(b.t));
    const total = sumMl(entries) + waterExtra(cur);
    all.water[day] = { ...cur, total, entries };
    await this._write(KEYS.metricsLog, all);
    return total;
  }
  /* Удалить приём. expect ({ t, ml[, key] }) — какая запись показана на экране: если индекс
     устарел (другая вкладка, смена суток), удаляется совпадающая запись, иначе ничего.
     С key совпадение точное: из внешне одинаковых импортированных записей удаляется именно
     показанная. Удалённая импортированная запись запоминается (removedKeys). */
  async removeWaterEntry(idx, day = dateKey(), expect = null) {
    const all = await this.getMetricsLog();
    const cur = all.water && all.water[day];
    if (!cur || !cur.entries) return false;
    if (expect) idx = findWaterEntry(cur.entries, idx, expect);
    if (idx < 0 || !cur.entries[idx]) return false;
    const extra = waterExtra(cur);
    const [removed] = cur.entries.splice(idx, 1);
    cur.total = sumMl(cur.entries) + extra;
    rememberRemovedKeys(cur, [removed]);
    all.water = { ...all.water, [day]: cur };
    await this._write(KEYS.metricsLog, all);
    return true;
  }
  /* Удалить все записи дня, подходящие под pred(entry). Итог пересчитывается, «легаси»
     остаток total (без разбивки по приёмам) сохраняется. → удалённые записи. */
  async removeWaterEntriesWhere(day, pred) {
    const all = await this.getMetricsLog();
    const cur = all.water && all.water[day];
    if (!cur || !Array.isArray(cur.entries)) return [];
    const removed = cur.entries.filter(pred);
    if (!removed.length) return [];
    const extra = waterExtra(cur);
    const entries = cur.entries.filter((e) => !pred(e));
    const next = { ...cur, entries, total: sumMl(entries) + extra };
    rememberRemovedKeys(next, removed);
    all.water = { ...all.water, [day]: next };
    await this._write(KEYS.metricsLog, all);
    return removed;
  }
  /* Исправить приём: время, объём и (patch.date) дату — запись переносится в другой день
     одной операцией записи. Прочие поля (key/drink/…) переезжают вместе с записью, поэтому
     повторный импорт узнаёт её и не создаёт дубль. expect — как в removeWaterEntry.
     → true, если запись найдена и сохранена. */
  async updateWaterEntry(day, idx, expect, patch) {
    const t = patch.t;
    const ml = Math.round(Number(patch.ml));
    const toDay = patch.date || day;
    if (typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t) || !(ml > 0)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(toDay)) return false;
    const all = await this.getMetricsLog();
    const water = { ...(all.water || {}) };
    const cur = water[day];
    if (!cur || !Array.isArray(cur.entries)) return false;
    idx = findWaterEntry(cur.entries, idx, expect);
    if (idx < 0) return false;
    const byT = (a, b) => a.t.localeCompare(b.t);
    const edited = { ...cur.entries[idx], t, ml };
    const rest = cur.entries.filter((_, i) => i !== idx);
    if (toDay === day) {
      const entries = [...rest, edited].sort(byT);
      water[day] = { ...cur, entries, total: sumMl(entries) + waterExtra(cur) };
    } else {
      water[day] = { ...cur, entries: rest, total: sumMl(rest) + waterExtra(cur) };
      const dst = water[toDay] || { total: 0, entries: [] };
      const entries = [...(dst.entries || []), edited].sort(byT);
      water[toDay] = { ...dst, entries, total: sumMl(entries) + waterExtra(dst) };
    }
    all.water = water;
    await this._write(KEYS.metricsLog, all);
    return true;
  }
  /* Массовый импорт приёмов воды за много дней одной записью (например, разовый
     перенос истории из другого приложения). Только добавляет — существующие записи
     не удаляются и не перезаписываются; доп. поля записи (key/drink/hydrationMl и т.п.)
     проходят как есть, модель этого не ограничивает (см. METRIC_VALUE_OK.water).
     entriesByDay: { "ГГГГ-ММ-ДД": [{t, ml, ...}] }. extra сохраняет «безразрывный»
     старый total дня, если он был больше суммы его entries (легаси-данные без разбивки
     по приёмам) — приёмы добавляются поверх, старое значение не теряется. */
  async bulkAddWaterEntries(entriesByDay) {
    const all = await this.getMetricsLog();
    all.water = { ...(all.water || {}) };
    for (const [day, list] of Object.entries(entriesByDay || {})) {
      if (!Array.isArray(list) || !list.length) continue;
      const cur = all.water[day] || { total: 0, entries: [] };
      const priorEntries = cur.entries || [];
      const priorSum = priorEntries.reduce((s, e) => s + (Number(e && e.ml) || 0), 0);
      const extra = Math.max(0, (Number(cur.total) || 0) - priorSum);
      const entries = [...priorEntries, ...list].sort((a, b) => a.t.localeCompare(b.t));
      const total = entries.reduce((s, e) => s + (Number(e.ml) || 0), 0) + extra;
      all.water[day] = { ...cur, total, entries };
    }
    await this._write(KEYS.metricsLog, all);
  }
  /* рекорд дня за всё время: { date, total } | null */
  async getWaterRecord() {
    const log = await this.getMetricLog('water');
    let best = null;
    for (const [d, o] of Object.entries(log)) {
      const t = o && o.total ? o.total : 0;
      if (!best || t > best.total) best = { date: d, total: t };
    }
    return best && best.total > 0 ? best : null;
  }
  /* серия учёта: календарных дней подряд, в которые есть хотя бы одна запись воды
     (включая сегодня; если сегодня записей ещё нет — считая со вчера) */
  async getWaterLoggedStreak(today = new Date()) {
    const log = await this.getMetricLog('water');
    const has = (d) => {
      const o = log[dateKey(d)];
      return !!o && ((Array.isArray(o.entries) && o.entries.length > 0) || (o.total || 0) > 0);
    };
    let streak = 0;
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!has(d)) d.setDate(d.getDate() - 1);
    while (has(d)) { streak += 1; d.setDate(d.getDate() - 1); }
    return streak;
  }
  /* серия: дней подряд с выполненной целью (включая/со вчера) */
  async getWaterStreak() {
    const log = await this.getMetricLog('water');
    const goal = await this.getWaterGoal();
    const met = (d) => { const o = log[dateKey(d)]; return o && (o.total || 0) >= goal; };
    let streak = 0;
    const d = new Date();
    if (!met(d)) d.setDate(d.getDate() - 1);
    while (met(d)) { streak += 1; d.setDate(d.getDate() - 1); }
    return streak;
  }

  /* ---- Профиль пользователя ---- */
  async getProfile() {
    return this._read(KEYS.profile, defaultProfile());
  }
  async setProfile(patch) {
    const p = await this.getProfile();
    const next = { ...p, ...patch };
    await this._write(KEYS.profile, next);
    return next;
  }

  /* ---- Гидратация (план воды по времени) ---- */
  async getHydration() {
    return this._read(KEYS.hydration, defaultHydration());
  }
  async setHydration(patch) {
    const cur = await this.getHydration();
    const next = { ...cur, ...patch };
    await this._write(KEYS.hydration, next);
    return next;
  }

  /* ---- Уведомления (центр уведомлений) ---- */
  async getNotifications() {
    return this._read(KEYS.notifications, []);
  }
  async updateNotification(id, patch) {
    const list = await this.getNotifications();
    const i = list.findIndex((n) => n.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    await this._write(KEYS.notifications, list);
    return list[i];
  }

  /* ---- Анализы (новые сверху) ---- */
  async getTests() {
    return sortTests(await this._read(KEYS.tests, []));
  }
  async getLatestTest() {
    return (await this.getTests())[0] || null;
  }
  async getTest(id) {
    return (await this._read(KEYS.tests, [])).find((t) => t.id === id) || null;
  }
  /* Изменения анализов выполняются по очереди: чтение-изменение-запись двух операций
     (двойное касание, импорт + вложение) не перекрываются и не теряют запись. */
  _serialTests(fn) {
    const run = (this._testsQueue || Promise.resolve()).then(fn, fn);
    this._testsQueue = run.catch(() => {});
    return run;
  }
  /* Запись списка анализов с проверкой: при ошибке (нет места) — исключение, а не тихий false */
  async _writeTests(list) {
    if (!(await this._write(KEYS.tests, list))) throw new Error('Не удалось сохранить анализы: недостаточно места на устройстве.');
  }
  async addTest(test) {
    return this._serialTests(async () => {
      const list = await this._read(KEYS.tests, []);
      const entry = { id: uid(), note: '', attachments: [], ...test };
      list.push(entry);
      await this._writeTests(list);
      return entry;
    });
  }
  /* Добавить анализ однократно: запись с тем же importId уже есть → не добавляется.
     → { added: true, entry } | { added: false, existing } */
  async addTestOnce(test) {
    return this._serialTests(async () => {
      const list = await this._read(KEYS.tests, []);
      const existing = test.importId ? list.find((t) => t.importId === test.importId) : null;
      if (existing) return { added: false, existing };
      const entry = { id: uid(), note: '', attachments: [], ...test };
      list.push(entry);
      await this._writeTests(list);
      return { added: true, entry };
    });
  }
  /* Изменить анализ: поля patch со значением undefined удаляются (очищенное поле формы). id не меняется. */
  async updateTest(id, patch) {
    return this._serialTests(async () => {
      const list = await this._read(KEYS.tests, []);
      const i = list.findIndex((t) => t.id === id);
      if (i < 0) return null;
      const next = { ...list[i] };
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id') continue;
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      list[i] = next;
      await this._writeTests(list);
      return next;
    });
  }
  /* Удалить анализ → удалённая запись | null (вложения удаляет AttachmentService) */
  async removeTest(id) {
    return this._serialTests(async () => {
      const list = await this._read(KEYS.tests, []);
      const rec = list.find((t) => t.id === id);
      if (!rec) return null;
      await this._writeTests(list.filter((t) => t.id !== id));
      return rec;
    });
  }
  /* Строгое чтение анализов для очистки «висячих» вложений: при любой неясности
     (ключа нет, JSON повреждён, идёт восстановление) → null, и очистка не выполняется. */
  async readTestsStrict() {
    try {
      if ((await this.driver.get(ROLLBACK_KEY)) != null) return null;
      const raw = await this.driver.get(KEYS.tests);
      if (raw == null) return null;
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }
  /* история показателя по датам (для графиков, Приоритет 2) */
  async getTestSeries(field) {
    const list = await this._read(KEYS.tests, []);
    return list
      .filter((t) => t[field] != null)
      .map((t) => ({ date: t.date, value: t[field] }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /* ---- Лекарства ----
     health_meds — препараты; schedule / note / deletedAt — аддитивные поля (services/meds.js).
     med_intakes — отметки по локальной дате: одна запись = один принятый приём
     (medId + scheduledTime, null — приём без времени). med_log — старый журнал по имени:
     только чтение, кроме переноса старой отметки дня в приём (applyMedIntake).
     Изменения лекарств и приёмов сериализуются: быстрые касания не теряют запись. */
  _serialMeds(fn) {
    const run = (this._medsQueue || Promise.resolve()).then(fn, fn);
    this._medsQueue = run.catch(() => {});
    return run;
  }
  async _writeMedsKey(key, value) {
    if (!(await this._write(key, value))) throw new Error('Не удалось сохранить: недостаточно места на устройстве.');
  }
  /* удалённые (deletedAt) остаются в базе ради истории приёмов и связей визитов — в списках их нет */
  async getMeds({ includeDeleted = false } = {}) {
    const list = await this._read(KEYS.meds, []);
    return includeDeleted ? list : list.filter((m) => !m.deletedAt);
  }
  async getMed(id) {
    return (await this._read(KEYS.meds, [])).find((m) => m.id === id && !m.deletedAt) || null;
  }
  async addMed(med) {
    return this._serialMeds(async () => {
      const list = await this._read(KEYS.meds, []);
      const entry = { id: uid(), icon: '💊', active: true, ...med };
      list.push(entry);
      await this._writeMedsKey(KEYS.meds, list);
      return entry;
    });
  }
  /* Правка: остальные поля записи (every_days, start, end, purpose, icon, active) сохраняются */
  async updateMed(id, patch) {
    return this._serialMeds(async () => {
      const list = await this._read(KEYS.meds, []);
      const i = list.findIndex((m) => m.id === id && !m.deletedAt);
      if (i < 0) return null;
      list[i] = { ...list[i], ...patch, id };
      await this._writeMedsKey(KEYS.meds, list);
      return list[i];
    });
  }
  /* «Удалить»: препарат пропадает из списков; запись остаётся с deletedAt, история приёмов не трогается */
  async removeMed(id) {
    return this._serialMeds(async () => {
      const list = await this._read(KEYS.meds, []);
      const i = list.findIndex((m) => m.id === id && !m.deletedAt);
      if (i < 0) return false;
      list[i] = { ...list[i], active: false, deletedAt: nowISO() };
      await this._writeMedsKey(KEYS.meds, list);
      return true;
    });
  }
  /* У лекарств из старых копий может не быть id (схема это допускала) — без него приём не отметить.
     Дописывает только id, остальное не меняется; пишет, лишь если такие записи есть. */
  async ensureMedIds() {
    return this._serialMeds(async () => {
      const list = await this._read(KEYS.meds, []);
      let changed = false;
      list.forEach((m) => { if (isPlainObj(m) && m.id == null) { m.id = uid(); changed = true; } });
      if (changed) await this._writeMedsKey(KEYS.meds, list);
      return changed;
    });
  }

  /* старый журнал «принял сегодня»: { "ГГГГ-ММ-ДД": ["Имя", ...] } (формат ТЗ) */
  async getMedLog(day = dateKey()) {
    const all = await this._read(KEYS.medLog, {});
    return all[day] || [];
  }
  /* весь старый журнал (только чтение — статистика) */
  async getAllMedLog() {
    return this._read(KEYS.medLog, {});
  }
  async getMedIntakes(day = dateKey()) {
    const all = await this._read(KEYS.medIntakes, {});
    return Array.isArray(all[day]) ? all[day] : [];
  }
  async getAllMedIntakes() {
    return this._read(KEYS.medIntakes, {});
  }
  /* Отметить / снять один приём (medId + время) за день day — меняется только запись этого дня.
     name + legacyTime: старая отметка дня по имени (med_log) переносится в приём legacyTime,
     чтобы не пропасть при первой новой отметке этого лекарства в тот же день. */
  async setMedIntake({ medId, time = null, taken, day = dateKey(), name = null, legacyTime = null, now = new Date() }) {
    if (!isSafeId(medId) || !isDateStr(day) || day === '' || !isTimeOrNull(time)) throw new Error('setMedIntake: некорректный приём');
    return this._serialMeds(async () => {
      const [intakes, log] = await Promise.all([this._read(KEYS.medIntakes, {}), this._read(KEYS.medLog, {})]);
      const next = applyMedIntake({ intakes: intakes[day], legacy: log[day] }, { medId, time, taken, name, legacyTime, takenAt: now.toISOString() });
      if (next.intakes.length) intakes[day] = next.intakes;
      else delete intakes[day];
      await this._writeMedsKey(KEYS.medIntakes, intakes);
      if (next.legacyChanged) {
        if (next.legacy.length) log[day] = next.legacy;
        else delete log[day];
        await this._writeMedsKey(KEYS.medLog, log);
      }
      return next.intakes;
    });
  }

  /* ---- Сон ----
     sleep_log — записи сна (одна на дату пробуждения), sleep_settings — цель и желаемое время.
     Модель, валидация и аналитика — services/sleep.js; UI обращается только к этим методам.
     Запись проверяется перед сохранением (isValidSleepEntry); изменения сериализуются. */
  _serialSleep(fn) {
    const run = (this._sleepQueue || Promise.resolve()).then(fn, fn);
    this._sleepQueue = run.catch(() => {});
    return run;
  }
  async _writeSleepKey(key, value) {
    if (!(await this._write(key, value))) throw new SleepStoreError('NO_SPACE', 'Не удалось сохранить: недостаточно места на устройстве.');
  }
  /* новые сверху (по дате пробуждения) */
  async getSleepEntries() {
    const list = await this._read(KEYS.sleepLog, []);
    return (Array.isArray(list) ? list : []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }
  async getSleepEntry(id) {
    return (await this.getSleepEntries()).find((e) => e.id === id) || null;
  }
  /* value — результат normalizeSleepInput(…).value. Дата пробуждения уже занята → SleepStoreError DUPLICATE_DATE */
  async addSleepEntry(value) {
    return this._serialSleep(async () => {
      const list = await this._read(KEYS.sleepLog, []);
      const at = nowISO();
      const entry = { ...sleepFields(value), ...sleepProvenance(value), id: uid(), createdAt: at, updatedAt: at };
      if (!isValidSleepEntry(entry)) throw new SleepStoreError('INVALID', 'Запись сна заполнена некорректно.');
      /* повторный импорт той же внешней записи не создаёт дубль */
      const ext = findSleepByExternalId(list, entry.source, entry.externalId);
      if (ext) throw new SleepStoreError('DUPLICATE_EXTERNAL', 'Эта запись сна уже импортирована.', ext);
      const dup = list.find((e) => e.date === entry.date);
      if (dup) throw new SleepStoreError('DUPLICATE_DATE', 'За эту дату сон уже записан.', dup);
      list.push(entry);
      await this._writeSleepKey(KEYS.sleepLog, list);
      return entry;
    });
  }
  /* правка из формы меняет только поля сна; происхождение (source, externalId, sourceDevice,
     importedAt, sleepStages) остаётся как было — у старой записи без source его и не появляется */
  async updateSleepEntry(id, value) {
    return this._serialSleep(async () => {
      const list = await this._read(KEYS.sleepLog, []);
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const next = { ...list[i], ...sleepFields(value), id, createdAt: list[i].createdAt || nowISO(), updatedAt: nowISO() };
      if (!isValidSleepEntry(next)) throw new SleepStoreError('INVALID', 'Запись сна заполнена некорректно.');
      const dup = list.find((e) => e.id !== id && e.date === next.date);
      if (dup) throw new SleepStoreError('DUPLICATE_DATE', 'За эту дату сон уже записан.', dup);
      list[i] = next;
      await this._writeSleepKey(KEYS.sleepLog, list);
      return next;
    });
  }
  /* → удалённая запись | null */
  async removeSleepEntry(id) {
    return this._serialSleep(async () => {
      const list = await this._read(KEYS.sleepLog, []);
      const rec = list.find((e) => e.id === id);
      if (!rec) return null;
      await this._writeSleepKey(KEYS.sleepLog, list.filter((e) => e.id !== id));
      return rec;
    });
  }
  async getSleepSettings() {
    return normalizeSleepSettings(await this._read(KEYS.sleepSettings, null));
  }
  async updateSleepSettings(patch) {
    return this._serialSleep(async () => {
      const cur = normalizeSleepSettings(await this._read(KEYS.sleepSettings, null));
      const next = normalizeSleepSettings({ ...cur, ...patch, reminders: { ...cur.reminders, ...((patch && patch.reminders) || {}) } });
      await this._writeSleepKey(KEYS.sleepSettings, next);
      return next;
    });
  }

  /* ---- Шаги, дистанция пешком, велосипед ----
     steps_log / walk_log — один итог за календарный день (дубль даты невозможен: ключ — дата);
     bike_log — поездки, итог дня = сумма km. Модель, проверка и статистика — services/activity.js.
     Изменения сериализуются; запись проверяется перед сохранением. */
  _serialActivity(fn) {
    const run = (this._activityQueue || Promise.resolve()).then(fn, fn);
    this._activityQueue = run.catch(() => {});
    return run;
  }
  async _writeActivityKey(key, value) {
    if (!(await this._write(key, value))) throw new ActivityStoreError('NO_SPACE', 'Не удалось сохранить: недостаточно места на устройстве.');
  }
  _dailyActivityKey(metric) {
    if (metric === 'steps') return KEYS.stepsLog;
    if (metric === 'walk') return KEYS.walkLog;
    throw new Error(`не дневной показатель: ${metric}`);
  }
  async getDailyActivityLog(metric) {
    const v = await this._read(this._dailyActivityKey(metric), {});
    return isPlainObj(v) ? v : {};
  }
  async getDailyActivity(metric, date) {
    return (await this.getDailyActivityLog(metric))[date] || null;
  }
  /* Сохранить дневной итог. value — normalizeDailyInput(…).value ({ date, steps|km, note }).
     from — дата редактируемой записи: другая дата value.date → запись переносится одной записью.
     Целевая дата уже занята другой записью → ActivityStoreError DUPLICATE_DATE (existing), пока
     вызывающий не подтвердит замену (overwrite: true) — так случайный дубль/затирание невозможны.
     Происхождение (source, createdAt) остаётся у записи и при правке, и при переносе. → { date, entry } */
  async saveDailyActivity(metric, value, { from = null, overwrite = false } = {}) {
    return this._serialActivity(async () => {
      const M = ACTIVITY_METRICS[metric];
      const key = this._dailyActivityKey(metric);
      const log = { ...(await this.getDailyActivityLog(metric)) };
      const date = value && value.date;
      if (!isDateStr(date) || !date) throw new ActivityStoreError('INVALID', 'Укажите дату записи.');
      const moving = from != null && from !== date;
      const orig = from != null ? log[from] || null : null;
      if (from != null && !orig) throw new ActivityStoreError('NOT_FOUND', 'Запись не найдена — данные изменились, пока была открыта форма.');
      const target = log[date] || null;
      if (target && (from == null || moving) && !overwrite) throw new ActivityStoreError('DUPLICATE_DATE', 'За эту дату уже есть запись.', { date, ...target });
      const base = orig || target || {};
      const at = nowISO();
      const entry = {
        ...base,
        [M.field]: value[M.field],
        note: typeof value.note === 'string' ? value.note.slice(0, ACTIVITY_NOTE_MAX) : (base.note || ''),
        source: base.source || (typeof value.source === 'string' && value.source ? value.source : 'manual'),
        createdAt: base.createdAt || at,
        updatedAt: at,
      };
      if (!(metric === 'steps' ? isValidStepsEntry(entry) : isValidWalkEntry(entry))) throw new ActivityStoreError('INVALID', 'Запись заполнена некорректно.');
      if (moving) delete log[from];
      log[date] = entry;
      await this._writeActivityKey(key, log);
      return { date, entry };
    });
  }
  /* → удалённая запись | null */
  async removeDailyActivity(metric, date) {
    return this._serialActivity(async () => {
      const key = this._dailyActivityKey(metric);
      const log = { ...(await this.getDailyActivityLog(metric)) };
      const rec = log[date];
      if (!rec) return null;
      delete log[date];
      await this._writeActivityKey(key, log);
      return rec;
    });
  }
  /* поездки: новые сверху */
  async getBikeRides() {
    const list = await this._read(KEYS.bikeLog, []);
    return sortRides(Array.isArray(list) ? list : []);
  }
  async getBikeRide(id) {
    return (await this.getBikeRides()).find((r) => r.id === id) || null;
  }
  /* value — normalizeRideInput(…).value ({ date, time, km, minutes, note }) → новая поездка */
  async addBikeRide(value) {
    return this._serialActivity(async () => {
      const list = await this._read(KEYS.bikeLog, []);
      const at = nowISO();
      const v = value || {};
      const ride = {
        id: uid(), date: v.date, time: v.time ?? null, km: v.km ?? null, minutes: v.minutes ?? null,
        note: typeof v.note === 'string' ? v.note.slice(0, ACTIVITY_NOTE_MAX) : '',
        source: typeof v.source === 'string' && v.source ? v.source : 'manual', createdAt: at, updatedAt: at,
      };
      if (!isValidRide(ride)) throw new ActivityStoreError('INVALID', 'Поездка заполнена некорректно.');
      await this._writeActivityKey(KEYS.bikeLog, [...(Array.isArray(list) ? list : []), ride]);
      return ride;
    });
  }
  /* Правка поездки: дата (перенос на другой день), время, km, минуты, заметка; id и происхождение остаются */
  async updateBikeRide(id, value) {
    return this._serialActivity(async () => {
      const list = await this._read(KEYS.bikeLog, []);
      const i = Array.isArray(list) ? list.findIndex((r) => r && r.id === id) : -1;
      if (i < 0) return null;
      const v = value || {};
      const next = {
        ...list[i], date: v.date, time: v.time ?? null, km: v.km ?? null, minutes: v.minutes ?? null,
        note: typeof v.note === 'string' ? v.note.slice(0, ACTIVITY_NOTE_MAX) : (list[i].note || ''),
        id, createdAt: list[i].createdAt || nowISO(), updatedAt: nowISO(),
      };
      if (!isValidRide(next)) throw new ActivityStoreError('INVALID', 'Поездка заполнена некорректно.');
      const out = list.slice();
      out[i] = next;
      await this._writeActivityKey(KEYS.bikeLog, out);
      return next;
    });
  }
  /* → удалённая поездка | null */
  async removeBikeRide(id) {
    return this._serialActivity(async () => {
      const list = await this._read(KEYS.bikeLog, []);
      const rec = Array.isArray(list) ? list.find((r) => r && r.id === id) : null;
      if (!rec) return null;
      await this._writeActivityKey(KEYS.bikeLog, list.filter((r) => r.id !== id));
      return rec;
    });
  }
  /* хранилище показателя целиком (для экрана и статистики): объект дней или массив поездок */
  async getActivityStore(metric) {
    return metric === 'bike' ? this.getBikeRides() : this.getDailyActivityLog(metric);
  }

  /* ---- Врачи и визиты ---- */
  async getVisits() {
    const list = await this._read(KEYS.visits, []);
    return list.slice().sort((a, b) => b.date.localeCompare(a.date));
  }
  async getVisit(id) {
    return (await this._read(KEYS.visits, [])).find((v) => v.id === id) || null;
  }
  async addVisit(visit) {
    const list = await this._read(KEYS.visits, []);
    const entry = normalizeVisit(visit);
    list.push(entry);
    await this._write(KEYS.visits, list);
    return entry;
  }
  async updateVisit(id, patch) {
    const list = await this._read(KEYS.visits, []);
    const i = list.findIndex((v) => v.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    await this._write(KEYS.visits, list);
    return list[i];
  }
  /* Импорт медицинской истории (services/historyImport.js) — только слияние (merge), только ДОБАВЛЕНИЕ.
     Каждый раздел перечитывается непосредственно перед записью, новые записи дописываются
     в конец текущего списка; существующие не удаляются, не заменяются и не изменяются.
     Записи с уже существующим id/importId пропускаются (повторный импорт → 0).
     После записи — проверка: каждая прежняя запись на месте байт-в-байт, их не стало меньше.
     Сбой записи или проверки → из разделов убираются ТОЛЬКО добавленные этим импортом id
     (тоже через перечитывание и слияние), и бросается ошибка. → { medsAdded, visitsAdded, before, after } */
  async addImportedHistory({ meds = [], visits = [] } = {}) {
    return this._serialMeds(async () => {
      const has = (list, r) => list.some((x) => x.id === r.id || (r.importId && x.importId === r.importId));
      const prevMeds = await this._read(KEYS.meds, []);
      const prevVisits = await this._read(KEYS.visits, []);
      if (!Array.isArray(prevMeds) || !Array.isArray(prevVisits)) throw new Error('Разделы «Лекарства» или «Визиты» повреждены — импорт отменён, данные не изменены.');
      const newMeds = meds.filter((m) => !has(prevMeds, m));
      const newVisits = visits.filter((v) => !has(prevVisits, v)).map(normalizeVisit);
      const addedIds = new Set([...newMeds, ...newVisits].map((r) => r.id));
      const append = async (key, items) => {
        if (!items.length) return true;
        const cur = await this._read(key, []); // перечитать прямо перед записью — слияние с актуальным списком
        if (!Array.isArray(cur)) return false;
        return this._write(key, [...cur, ...items.filter((r) => !has(cur, r))]);
      };
      const undo = async () => {
        for (const key of [KEYS.visits, KEYS.meds]) {
          const cur = await this._read(key, []);
          if (Array.isArray(cur) && cur.some((r) => addedIds.has(r.id))) await this._write(key, cur.filter((r) => !addedIds.has(r.id)));
        }
      };
      /* все прежние записи на месте и не изменены; количество не уменьшилось */
      const kept = (prev, cur) => Array.isArray(cur) && cur.length >= prev.length
        && JSON.stringify(cur.slice(0, prev.length)) === JSON.stringify(prev); // дописывание только в конец: прежние — неизменный префикс

      let ok = (await append(KEYS.meds, newMeds)) && (await append(KEYS.visits, newVisits));
      const curMeds = await this._read(KEYS.meds, []);
      const curVisits = await this._read(KEYS.visits, []);
      if (ok) ok = kept(prevMeds, curMeds) && kept(prevVisits, curVisits);
      if (!ok) {
        await undo();
        throw new Error('Импорт не выполнен: запись или проверка сохранности не прошла. Добавленные записи убраны, прежние данные не изменены.');
      }
      return {
        medsAdded: newMeds.length, visitsAdded: newVisits.length,
        before: { meds: prevMeds.length, visits: prevVisits.length },
        after: { meds: curMeds.length, visits: curVisits.length },
      };
    });
  }
  /* → удалённая запись | null (документы удаляет VisitAttachmentService.deleteVisit) */
  async removeVisit(id) {
    const list = await this._read(KEYS.visits, []);
    const rec = list.find((v) => v.id === id);
    if (!rec) return null;
    await this._write(KEYS.visits, list.filter((v) => v.id !== id));
    return rec;
  }
  /* Документы записи (services/attachments.js, VisitAttachmentService): меняется только поле
     attachments этой записи — новые метаданные ДОПИСЫВАЮТСЯ к уже прикреплённым. → запись | null */
  async addVisitAttachments(id, metas) {
    const list = await this._read(KEYS.visits, []);
    const i = list.findIndex((v) => v.id === id);
    if (i < 0) return null;
    const cur = Array.isArray(list[i].attachments) ? list[i].attachments : [];
    const fresh = metas.filter((m) => !cur.some((a) => a && a.attachmentId === m.attachmentId));
    list[i] = { ...list[i], attachments: [...cur, ...fresh] };
    if (!(await this._write(KEYS.visits, list))) throw new Error('Не удалось сохранить: недостаточно места на устройстве.');
    return list[i];
  }
  /* Убрать один документ из записи (сама запись и другие документы остаются) → true | false */
  async removeVisitAttachment(id, attachmentId) {
    const list = await this._read(KEYS.visits, []);
    const i = list.findIndex((v) => v.id === id);
    if (i < 0 || !Array.isArray(list[i].attachments) || !list[i].attachments.some((a) => a && a.attachmentId === attachmentId)) return false;
    list[i] = { ...list[i], attachments: list[i].attachments.filter((a) => !(a && a.attachmentId === attachmentId)) };
    if (!(await this._write(KEYS.visits, list))) throw new Error('Не удалось сохранить: недостаточно места на устройстве.');
    return true;
  }
  /* Строгое чтение визитов для очистки «висячих» документов (как readTestsStrict) */
  async readVisitsStrict() {
    try {
      if ((await this.driver.get(ROLLBACK_KEY)) != null) return null;
      const raw = await this.driver.get(KEYS.visits);
      if (raw == null) return null;
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }

  /* ---- Активность ---- */
  async getGoals() {
    return this._read(KEYS.activityGoals, { bike_minutes: 45, steps: 8000, water_liters: 2.3, plank_seconds: 60 });
  }
  async setGoals(goals) {
    const cur = await this.getGoals();
    await this._write(KEYS.activityGoals, { ...cur, ...goals });
  }
  async getActivity(day = dateKey()) {
    const all = await this._read(KEYS.activityDays, {});
    return all[day] || null;
  }
  async getAllActivity() {
    return this._read(KEYS.activityDays, {});
  }
  async saveActivity(data, day = dateKey()) {
    const all = await this._read(KEYS.activityDays, {});
    all[day] = { ...all[day], ...data, savedAt: nowISO() };
    await this._write(KEYS.activityDays, all);
    return all[day];
  }
  /* стрик: дней подряд с записью активности (включая сегодня) */
  async getStreak() {
    const all = await this._read(KEYS.activityDays, {});
    let streak = 0;
    const d = new Date();
    if (!all[dateKey(d)]) d.setDate(d.getDate() - 1);
    while (all[dateKey(d)]) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  /* =====================================================
     §6.6 Вложения — метаданные (бинарь требует IndexedDbDriver)
     recordType: 'tests' | 'visits'
     ===================================================== */
  _attKey(recordType) {
    return recordType === 'visits' ? KEYS.visits : KEYS.tests;
  }
  async getAttachments(recordType, recordId) {
    const list = await this._read(this._attKey(recordType), []);
    const rec = list.find((r) => r.id === recordId);
    return rec ? rec.attachments || [] : [];
  }
  async addAttachmentMeta(recordType, recordId, meta) {
    const key = this._attKey(recordType);
    const list = await this._read(key, []);
    const rec = list.find((r) => r.id === recordId);
    if (!rec) throw new Error('Запись не найдена');
    rec.attachments = rec.attachments || [];
    const entry = { id: uid(), addedAt: nowISO(), blobRef: null, ...meta };
    rec.attachments.push(entry);
    await this._write(key, list);
    return entry;
  }
  async removeAttachmentMeta(recordType, recordId, attId) {
    const key = this._attKey(recordType);
    const list = await this._read(key, []);
    const rec = list.find((r) => r.id === recordId);
    if (!rec || !rec.attachments) return;
    rec.attachments = rec.attachments.filter((a) => a.id !== attId);
    await this._write(key, list);
  }
  /* Бинарные данные вложений — только через IndexedDbDriver (§6.6). */
  async putAttachmentBlob() {
    throw new Error('Бинарные вложения требуют IndexedDbDriver (ARCHITECTURE.md §6.6)');
  }
  async getAttachmentBlob() {
    throw new Error('Бинарные вложения требуют IndexedDbDriver (ARCHITECTURE.md §6.6)');
  }

  /* =====================================================
     §6.4 Резервная копия JSON
     Конвейер: exportBackup → файл → parseBackup → prepareRestore (проверка +
     миграции в песочнице, без записи) → предпросмотр → restoreBackup (атомарно,
     с защитной копией и откатом).
     ===================================================== */
  async exportBackup() {
    const data = {};
    for (const k of DATA_KEYS) data[k] = await this._read(k, null);
    const theme = await this.driver.get(THEME_KEY);
    return {
      app: APP_ID,
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      appVersion: APP_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: nowISO(),
      settings: { theme: THEMES.includes(theme) ? theme : null },
      data,
      blobs: {}, // §6.6: бинарные вложения добавятся вместе с IndexedDbDriver
    };
  }

  /* Готовый файл бэкапа + самопроверка: созданную копию можно восстановить */
  async createBackup() {
    const backup = await this.exportBackup();
    const json = JSON.stringify(backup, null, 2);
    let verified = true;
    try { await this.prepareRestore(parseBackup(json)); } catch { verified = false; }
    return { json, fileName: backupFileName(new Date(backup.createdAt)), createdAt: backup.createdAt, verified };
  }

  /* Дата последнего созданного файла (техническая отметка, в бэкап не входит) */
  async getLastBackupAt() {
    const v = await this.driver.get(LAST_BACKUP_KEY);
    return v && !Number.isNaN(Date.parse(v)) ? v : null;
  }
  async markBackupCreated(iso = nowISO()) {
    try { await this.driver.set(LAST_BACKUP_KEY, iso); } catch { /* не критично */ }
  }

  /* Проверка и подготовка к восстановлению — реальную базу НЕ трогает.
     Бэкап загружается в песочницу (MemoryDriver), старая схема проходит через
     те же MIGRATIONS, недостающие разделы получают значения по умолчанию,
     результат проверяется по структуре финальной схемы. */
  async prepareRestore(raw) {
    const env = inspectBackup(raw);
    const sandbox = new StorageService(new MemoryDriver());
    sandbox.noDemoData = true; // в восстановленную базу не попадают демо-значения миграций
    for (const [k, v] of Object.entries(env.data)) await sandbox.driver.set(k, JSON.stringify(v));
    await sandbox.driver.set(KEYS.meta, JSON.stringify({ schemaVersion: env.schemaVersion }));
    try {
      if (env.schemaVersion < CURRENT_SCHEMA_VERSION) await sandbox._migrate();
      await sandbox._ensureDefaults();
      await sandbox._migrateActivity(); // старая копия без отметки — шаги/велотренажёр переносятся так же, как при запуске
    } catch {
      throw new BackupError('MIGRATION_FAILED', 'Не удалось обновить данные из старой резервной копии: структура файла повреждена.');
    }
    const data = {};
    for (const k of DATA_KEYS) data[k] = await sandbox._read(k, null);
    validateData(data);
    return {
      info: {
        app: env.app,
        legacyApp: env.app !== APP_ID,
        backupFormatVersion: env.format,
        appVersion: env.appVersion,
        schemaVersion: env.schemaVersion,
        migrated: env.schemaVersion < CURRENT_SCHEMA_VERSION,
        createdAt: env.createdAt,
      },
      data,
      theme: env.theme,
      summary: summarize(data),
      ignoredKeys: env.ignoredKeys,
      strippedKeys: env.strippedKeys,
    };
  }

  /* Атомарное восстановление: либо новая база целиком, либо прежняя.
     1) снимок текущих ключей → одна защитная копия (ROLLBACK_KEY) + в памяти;
     2) запись всех ключей; 3) перечитывание и проверка;
     4) ошибка → откат из снимка; успех → защитная копия удаляется.
     Если приложение закрылось посреди записи — init() откатит при следующем запуске. */
  async restoreBackup(prepared) {
    if (!prepared || !isPlainObj(prepared.data)) throw new BackupError('INVALID', 'Нет подготовленной резервной копии.');
    validateData(prepared.data);

    const snapshot = {};
    for (const k of [...DATA_KEYS, KEYS.meta, THEME_KEY]) snapshot[k] = await this.driver.get(k);
    try {
      await this.driver.set(ROLLBACK_KEY, JSON.stringify({ state: 'pending', createdAt: nowISO(), snapshot }));
    } catch {
      await this.driver.remove(ROLLBACK_KEY).catch(() => {});
      throw new BackupError('NO_SPACE', 'Недостаточно места для защитной копии текущих данных. Восстановление отменено, данные не изменены.');
    }

    let curMeta = null;
    try { curMeta = JSON.parse(snapshot[KEYS.meta]); } catch { /* нет или повреждён */ }
    if (!isPlainObj(curMeta)) curMeta = {};
    const plan = {};
    for (const k of DATA_KEYS) plan[k] = JSON.stringify(prepared.data[k]);
    plan[KEYS.meta] = JSON.stringify({
      ...curMeta, schemaVersion: CURRENT_SCHEMA_VERSION, seededAt: curMeta.seededAt || nowISO(), restoredAt: nowISO(),
    });
    if (THEMES.includes(prepared.theme)) plan[THEME_KEY] = prepared.theme;

    let summary;
    try {
      for (const [k, v] of Object.entries(plan)) await this.driver.set(k, v);
      for (const [k, v] of Object.entries(plan)) {
        if ((await this.driver.get(k)) !== v) throw new Error(`verify ${k}`);
      }
      summary = await this.verifyIntegrity();
    } catch {
      const rolledBack = await this._applySnapshot(snapshot);
      if (rolledBack) await this.driver.remove(ROLLBACK_KEY).catch(() => {});
      throw new BackupError('RESTORE_FAILED', rolledBack
        ? 'Не удалось восстановить данные. Прежние данные возвращены без изменений.'
        : 'Не удалось восстановить данные. Прежние данные будут возвращены при следующем запуске LexLife.');
    }
    await this.driver.remove(ROLLBACK_KEY);
    return summary;
  }

  /* Перечитать базу через StorageService: схема, структура, основные геттеры */
  async verifyIntegrity() {
    const meta = await this._read(KEYS.meta, null);
    if (!meta || meta.schemaVersion !== CURRENT_SCHEMA_VERSION) throw new Error('schemaVersion');
    const data = {};
    for (const k of DATA_KEYS) data[k] = await this._read(k, null);
    validateData(data);
    await Promise.all([
      this.getTests(), this.getVisits(), this.getMeds(), this.getMetricsLog(), this.getMetricsConfig(),
      this.getNotifications(), this.getProfile(), this.getHydration(), this.getAllActivity(), this.getGoals(),
      this.getSleepEntries(), this.getSleepSettings(), this.getDailyActivityLog('steps'), this.getDailyActivityLog('walk'), this.getBikeRides(),
    ]);
    return summarize(data);
  }

  /* Вернуть ключи из снимка (только управляемые ключи — не ключи из снимка) */
  async _applySnapshot(snapshot) {
    try {
      for (const k of [...DATA_KEYS, KEYS.meta, THEME_KEY]) {
        const v = snapshot[k];
        if (typeof v === 'string') await this.driver.set(k, v);
        else await this.driver.remove(k);
      }
      return true;
    } catch (err) {
      console.warn('[storage] откат не завершён', err && err.name);
      return false;
    }
  }

  /* Восстановление было прервано (закрытие приложения/сбой) — вернуть прежнюю базу */
  async _recoverInterruptedRestore() {
    let raw = null;
    try { raw = await this.driver.get(ROLLBACK_KEY); } catch { return; }
    if (raw == null) return;
    let rb = null;
    try { rb = JSON.parse(raw); } catch { /* повреждён — просто удалить */ }
    if (rb && rb.state === 'pending' && isPlainObj(rb.snapshot)) {
      if (!(await this._applySnapshot(rb.snapshot))) return; // повторим при следующем запуске
      console.warn('[storage] прерванное восстановление отменено — возвращены прежние данные');
    }
    await this.driver.remove(ROLLBACK_KEY);
  }

  /* Совместимость со старым API: проверка + атомарная замена */
  async importBackup(backup) {
    return this.restoreBackup(await this.prepareRestore(backup));
  }

  /* полная очистка пользовательских данных (Настройки → сброс) */
  async clearAll() {
    for (const k of [...DATA_KEYS, KEYS.meta, ROLLBACK_KEY]) await this.driver.remove(k);
  }
}

/* Активный драйвер v1.0 — localStorage. Замена на IndexedDbDriver — одна строка (§6.2). */
export const Storage = new StorageService(new LocalStorageDriver());
export default Storage;
