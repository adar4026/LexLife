/* =========================================================
   sleep.js — модуль «Сон»: модель записи, валидация, настройки и аналитика.
   Чистые функции без DOM и без хранилища (storage.js импортирует этот файл,
   обратного импорта нет — цикла модулей не будет).

   Модель (аддитивные ключи, схема v8 не меняется):
   • sleep_log = [{ id, date, sleepStart, sleepEnd, durationMinutes, quality, awakenings,
                    naps: [{ minutes, start, end }], tags: [...], note, createdAt, updatedAt }]
     date — ЛОКАЛЬНЫЙ день пробуждения («ГГГГ-ММ-ДД»), всегда = дате sleepEnd;
     sleepStart / sleepEnd — локальное время стены «ГГГГ-ММ-ДДTЧЧ:ММ» (без UTC: сон не уезжает
     на соседний день); durationMinutes — разница настоящих моментов времени на момент
     сохранения (переход CET/CEST учтён), хранится, чтобы не зависеть от часового пояса
     устройства при последующем просмотре. Одна дата пробуждения — одна запись (основной сон).
     naps — дневной сон отдельными эпизодами (сейчас форма пишет один эпизод с minutes).
     Происхождение (необязательно, для будущих внешних источников — Apple Health и др.):
     source 'manual' | 'apple_health' (нет поля → 'manual'), externalId — id записи во внешнем
     источнике (дедупликация повторного импорта), sourceDevice { name, manufacturer, model },
     importedAt ISO, sleepStages { awakeMinutes, coreMinutes, deepMinutes, remMinutes }.
     Аналитика и интерфейс эти поля пока не используют.
   • sleep_settings = { goalMinutes, bedtime, wakeTime, reminders: { bedtime, log } }
     reminders — модель будущих уведомлений (в центр уведомлений пока не подключена).
   Пропущенный день — «нет данных» (null), а не 0 часов: средние считаются только по записям.
   ========================================================= */

export const SLEEP_GOAL_DEFAULT = 480;
export const SLEEP_GOAL_MIN = 240;
export const SLEEP_GOAL_MAX = 720;
export const SLEEP_GOAL_STEP = 15;
/* верхний предел ночного сна — только защита от ошибки ввода (36 ч из-за не той даты), не норма */
export const SLEEP_MAX_MINUTES = 20 * 60;
export const AWAKENINGS_MAX = 20;
export const NAP_MAX_MINUTES = 600;
export const NAPS_MAX = 6;
export const SLEEP_NOTE_MAX = 1000;
/* «Что связано с вашим сном»: не меньше стольких дней с фактором и без него */
export const INSIGHT_MIN_DAYS = 5;
export const INSIGHT_MIN_DURATION_DELTA = 15; // мин — меньшие различия не показываются
export const INSIGHT_MIN_QUALITY_DELTA = 0.3;
/* «Стабильность режима»: среднее отклонение 2 ч и больше → 0 % */
export const CONSISTENCY_SPAN_MINUTES = 120;
export const CONSISTENCY_MIN_ENTRIES = 3;

export const SLEEP_QUALITY = [
  { value: 1, emoji: '😫', label: 'Очень плохо', sleep: 'Очень плохой сон' },
  { value: 2, emoji: '😕', label: 'Плохо', sleep: 'Плохой сон' },
  { value: 3, emoji: '😐', label: 'Нормально', sleep: 'Нормальный сон' },
  { value: 4, emoji: '🙂', label: 'Хорошо', sleep: 'Хороший сон' },
  { value: 5, emoji: '😴', label: 'Отлично', sleep: 'Отличный сон' },
];
export const qualityInfo = (q) => SLEEP_QUALITY.find((x) => x.value === q) || null;

/* Факторы: машинные ключи стабильны (хранятся), подписи — только для интерфейса.
   when — начало фразы наблюдения («В дни со стрессом …»). */
export const SLEEP_TAGS = [
  { key: 'coffee', emoji: '☕', label: 'Кофе', when: 'В дни с кофе' },
  { key: 'alcohol', emoji: '🍷', label: 'Алкоголь', when: 'В дни с алкоголем' },
  { key: 'late_meal', emoji: '🍽', label: 'Поздний ужин', when: 'После позднего ужина' },
  { key: 'stress', emoji: '😰', label: 'Стресс', when: 'В дни со стрессом' },
  { key: 'exercise', emoji: '🏃', label: 'Тренировка', when: 'В дни с тренировкой' },
  { key: 'medication', emoji: '💊', label: 'Лекарства', when: 'В дни с лекарствами' },
  { key: 'illness', emoji: '🤒', label: 'Болезнь', when: 'Во время болезни' },
  { key: 'screen', emoji: '📱', label: 'Телефон перед сном', when: 'После телефона перед сном' },
  { key: 'travel', emoji: '✈️', label: 'Поездка', when: 'В поездках' },
  { key: 'nap', emoji: '💤', label: 'Дневной сон', when: 'В дни с дневным сном' },
];
export const SLEEP_TAG_KEYS = SLEEP_TAGS.map((t) => t.key);
export const tagInfo = (key) => SLEEP_TAGS.find((t) => t.key === key) || null;

/* Будущие напоминания: типы, тексты и маршруты. Правила в формате центра уведомлений
   (sleepReminderRules) — чтобы подключение было добавлением, а не новой моделью. */
export const SLEEP_REMINDERS = {
  bedtime: { type: 'sleep_bedtime', title: 'Пора готовиться ко сну', text: 'Пора готовиться ко сну', route: '#/sleep', defaultTime: '23:00' },
  log: { type: 'sleep_log', title: 'Записать сон', text: 'Запишите, как вы спали', route: '#/sleep/new', defaultTime: '08:00' },
};
export const SLEEP_REMINDER_TYPES = Object.values(SLEEP_REMINDERS).map((r) => r.type);

/* Источники записи. Отсутствие source (записи до этого поля) = 'manual'. Неизвестный, но
   безопасный ключ источника из копии более новой версии не ломает восстановление. */
export const SLEEP_SOURCES = ['manual', 'apple_health'];
export const SLEEP_STAGE_KEYS = ['awakeMinutes', 'coreMinutes', 'deepMinutes', 'remMinutes'];
export const sleepSource = (e) => (e && typeof e.source === 'string' && e.source ? e.source : 'manual');
/* Ключ дедупликации внешнего импорта: источник + id записи в нём; у ручных записей — null */
export const sleepExternalKey = (e) => (e && typeof e.externalId === 'string' && e.externalId ? `${sleepSource(e)}:${e.externalId}` : null);
export function findSleepByExternalId(entries, source, externalId) {
  if (typeof externalId !== 'string' || !externalId) return null;
  const key = `${source || 'manual'}:${externalId}`;
  return (Array.isArray(entries) ? entries : []).find((e) => sleepExternalKey(e) === key) || null;
}

/* ---------- примитивы ---------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const TAG_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MIN_MS = 60000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const pad = (n) => String(n).padStart(2, '0');
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

export const isSleepDay = (v) => typeof v === 'string' && DAY_RE.test(v) && parseDay(v) != null;
export const isSleepTime = (v) => typeof v === 'string' && TIME_RE.test(v);
export const isSleepStamp = (v) => typeof v === 'string' && parseStamp(v) != null;

/* «ГГГГ-ММ-ДД» → Date в локальную полночь (несуществующая дата — null) */
function parseDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}
export const localDay = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export function addDays(day, n) {
  const d = parseDay(day);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}
/* Разница календарных дней b − a (без часов: DST не влияет) */
export function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

/* Локальное время стены «ГГГГ-ММ-ДДTЧЧ:ММ» → настоящий момент (Date) в часовом поясе устройства.
   В «пропущенный» час весеннего перевода (02:30) Date сдвигает время вперёд — длительность
   всё равно считается между реальными моментами. */
export function parseStamp(stamp) {
  const m = typeof stamp === 'string' ? stamp.match(STAMP_RE) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}
export const makeStamp = (day, time) => `${day}T${time}`;
export const stampDay = (stamp) => stamp.slice(0, 10);
export const stampTime = (stamp) => stamp.slice(11, 16);
const clockOf = (stamp) => { const t = stampTime(stamp); return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); };
export const minutesToClock = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

/* ---------- длительность ---------- */

/* Минуты между засыпанием и пробуждением — по настоящим моментам времени, не по «ЧЧ:ММ».
   Некорректный ввод → null. Отрицательная разница возвращается как есть (валидатор её отклонит). */
export function calculateDuration(sleepStart, sleepEnd) {
  const a = parseStamp(sleepStart);
  const b = parseStamp(sleepEnd);
  if (!a || !b) return null;
  return Math.round((b - a) / MIN_MS);
}

/* 450 → «7 ч 30 мин», 480 → «8 ч», 45 → «45 мин»; null → «—».
   Число и единица — через неразрывный пробел (не разрываются переносом строки). */
const NB = '\u00a0';
export function formatSleepDuration(min) {
  if (!isNum(min)) return '—';
  const m = Math.round(Math.abs(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const s = h && r ? `${h}${NB}ч ${r}${NB}мин` : h ? `${h}${NB}ч` : `${r}${NB}мин`;
  return min < 0 && m ? `−${s}` : s;
}
/* Разница со знаком: «+18 мин», «−1 ч 5 мин», «0 мин» */
export function formatSleepDelta(min) {
  if (!isNum(min)) return '—';
  const m = Math.round(min);
  if (!m) return `0${NB}мин`;
  return `${m > 0 ? '+' : '−'}${formatSleepDuration(Math.abs(m))}`;
}

/* Дата записи — день пробуждения */
export const sleepDateFor = (sleepEnd) => (isSleepStamp(sleepEnd) ? stampDay(sleepEnd) : null);

/* Дата засыпания по умолчанию: время отхода позже времени подъёма (23:40 и 07:20) — накануне,
   иначе (00:30 и 08:00) — тот же день */
export function inferBedDate(wakeDate, bedTime, wakeTime) {
  if (!isSleepDay(wakeDate)) return wakeDate;
  return isSleepTime(bedTime) && isSleepTime(wakeTime) && bedTime < wakeTime ? wakeDate : addDays(wakeDate, -1);
}

export const napMinutes = (e) => (e && Array.isArray(e.naps) ? e.naps.reduce((s, n) => s + (isNum(n && n.minutes) ? n.minutes : 0), 0) : 0);
/* Общий сон за сутки: ночной + дневной (отдельный показатель, всегда с подписью) */
export const totalDayMinutes = (e) => (e && isNum(e.durationMinutes) ? e.durationMinutes + napMinutes(e) : null);

/* ---------- форма → запись ---------- */

/* input: { bedDate, bedTime, wakeDate, wakeTime, quality, awakenings, napEnabled, napMinutes, tags, note }
   opts.today — локальная дата «сегодня» (дата пробуждения не может быть позже).
   → { ok, value, errors } — value без id/createdAt/updatedAt (их ставит хранилище). */
export function normalizeSleepInput(input = {}, { today = localDay() } = {}) {
  const errors = {};
  const bedDate = String(input.bedDate || '');
  const wakeDate = String(input.wakeDate || '');
  const bedTime = String(input.bedTime || '');
  const wakeTime = String(input.wakeTime || '');
  if (!isSleepDay(bedDate) || !isSleepTime(bedTime)) errors.start = 'Укажите дату и время, когда вы легли спать';
  if (!isSleepDay(wakeDate) || !isSleepTime(wakeTime)) errors.end = 'Укажите дату и время пробуждения';
  else if (wakeDate > today) errors.end = 'Дата пробуждения не может быть в будущем';
  const sleepStart = makeStamp(bedDate, bedTime);
  const sleepEnd = makeStamp(wakeDate, wakeTime);
  let durationMinutes = null;
  if (!errors.start && !errors.end) {
    durationMinutes = calculateDuration(sleepStart, sleepEnd);
    if (durationMinutes == null || durationMinutes <= 0) errors.duration = 'Время пробуждения должно быть позже времени засыпания';
    else if (durationMinutes > SLEEP_MAX_MINUTES) errors.duration = 'Получается больше 20 часов сна — проверьте даты';
  }

  let quality = input.quality == null || input.quality === '' ? null : Number(input.quality);
  if (quality != null && !(isInt(quality) && quality >= 1 && quality <= 5)) { errors.quality = 'Оценка качества — от 1 до 5'; quality = null; }

  const awakenings = input.awakenings == null || input.awakenings === '' ? 0 : Number(input.awakenings);
  if (!(isInt(awakenings) && awakenings >= 0 && awakenings <= AWAKENINGS_MAX)) errors.awakenings = `Пробуждений — от 0 до ${AWAKENINGS_MAX}`;

  const naps = [];
  if (input.napEnabled) {
    const nm = Number(input.napMinutes);
    if (!(isInt(nm) && nm >= 1 && nm <= NAP_MAX_MINUTES)) errors.nap = `Дневной сон — от 1 до ${NAP_MAX_MINUTES} минут`;
    else naps.push({ minutes: nm, start: null, end: null });
  }

  const chosen = new Set(Array.isArray(input.tags) ? input.tags : []);
  const tags = SLEEP_TAG_KEYS.filter((k) => chosen.has(k));
  const note = String(input.note || '').trim().slice(0, SLEEP_NOTE_MAX);

  const ok = !Object.keys(errors).length;
  return {
    ok,
    errors,
    value: ok ? { date: wakeDate, sleepStart, sleepEnd, durationMinutes, quality, awakenings, naps, tags, note } : null,
  };
}

/* ---------- проверка структуры (резервная копия, хранилище) ---------- */
const NAP_OK = (n) => isObj(n) && isInt(n.minutes) && n.minutes >= 0 && n.minutes <= 1440
  && (n.start == null || isSleepStamp(n.start)) && (n.end == null || isSleepStamp(n.end));

const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const isShortStr = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const isStrOrNull = (v, max) => v == null || isShortStr(v, max);
/* лишние поля вложенных объектов (будущие версии) — только простые значения */
const isPlainValue = (v) => v == null || typeof v === 'boolean' || isNum(v) || isShortStr(v, 200);
const SOURCE_DEVICE_OK = (d) => d == null || (isObj(d) && Object.keys(d).length <= 20 && Object.values(d).every(isPlainValue)
  && isStrOrNull(d.name, 100) && isStrOrNull(d.manufacturer, 100) && isStrOrNull(d.model, 100));
const STAGES_OK = (s) => s == null || (isObj(s) && Object.keys(s).length <= 20
  && Object.values(s).every((v) => v == null || (isNum(v) && v >= 0 && v <= 1440)));
/* Происхождение записи: всё необязательно; externalId не требуется ни для manual, ни для apple_health */
const provenanceOk = (e) => (e.source == null || (typeof e.source === 'string' && SOURCE_RE.test(e.source)))
  && isStrOrNull(e.externalId, 200) && (e.externalId == null || e.externalId.length > 0)
  && SOURCE_DEVICE_OK(e.sourceDevice) && isStrOrNull(e.importedAt, 40) && STAGES_OK(e.sleepStages);

/* Одна запись: строго то, что UI подставляет в разметку и что нужно аналитике;
   неизвестные теги допустимы (будущие версии), но только как безопасные ключи. */
export function isValidSleepEntry(e) {
  return isObj(e)
    && typeof e.id === 'string' && ID_RE.test(e.id)
    && isSleepDay(e.date) && isSleepStamp(e.sleepStart) && isSleepStamp(e.sleepEnd)
    && stampDay(e.sleepEnd) === e.date && e.sleepStart < e.sleepEnd
    && isNum(e.durationMinutes) && e.durationMinutes > 0 && e.durationMinutes <= SLEEP_MAX_MINUTES
    && (e.quality == null || (isInt(e.quality) && e.quality >= 1 && e.quality <= 5))
    && (e.awakenings == null || (isInt(e.awakenings) && e.awakenings >= 0 && e.awakenings <= AWAKENINGS_MAX))
    && (e.naps == null || (Array.isArray(e.naps) && e.naps.length <= 24 && e.naps.every(NAP_OK)))
    && (e.tags == null || (Array.isArray(e.tags) && e.tags.length <= 50 && e.tags.every((t) => typeof t === 'string' && TAG_RE.test(t))))
    && (e.note == null || (typeof e.note === 'string' && e.note.length <= SLEEP_NOTE_MAX * 2))
    && (e.createdAt == null || typeof e.createdAt === 'string') && (e.updatedAt == null || typeof e.updatedAt === 'string')
    && provenanceOk(e);
}
export const isValidSleepLog = (v) => Array.isArray(v) && v.every(isValidSleepEntry);

/* ---------- настройки ---------- */
export function defaultSleepSettings() {
  return {
    goalMinutes: SLEEP_GOAL_DEFAULT,
    bedtime: '23:30',
    wakeTime: '07:30',
    reminders: {
      bedtime: { enabled: false, time: SLEEP_REMINDERS.bedtime.defaultTime },
      log: { enabled: false, time: SLEEP_REMINDERS.log.defaultTime },
    },
  };
}
export const clampSleepGoal = (min) => {
  const n = Number(min);
  if (!Number.isFinite(n)) return SLEEP_GOAL_DEFAULT;
  return Math.min(SLEEP_GOAL_MAX, Math.max(SLEEP_GOAL_MIN, Math.round(n / SLEEP_GOAL_STEP) * SLEEP_GOAL_STEP));
};
const REMINDER_OK = (r) => r == null || (isObj(r) && (r.enabled == null || typeof r.enabled === 'boolean') && (r.time == null || isSleepTime(r.time)));
export function isValidSleepSettings(s) {
  return isObj(s)
    && (s.goalMinutes == null || (isNum(s.goalMinutes) && s.goalMinutes >= SLEEP_GOAL_MIN && s.goalMinutes <= SLEEP_GOAL_MAX))
    && (s.bedtime == null || isSleepTime(s.bedtime)) && (s.wakeTime == null || isSleepTime(s.wakeTime))
    && (s.reminders == null || (isObj(s.reminders) && REMINDER_OK(s.reminders.bedtime) && REMINDER_OK(s.reminders.log)));
}
/* Любое сохранённое значение → полные настройки (недостающее — по умолчанию; лишние поля сохраняются) */
export function normalizeSleepSettings(raw) {
  const d = defaultSleepSettings();
  const s = isObj(raw) ? raw : {};
  const rem = isObj(s.reminders) ? s.reminders : {};
  const reminder = (key) => {
    const r = isObj(rem[key]) ? rem[key] : {};
    return { ...r, enabled: r.enabled === true, time: isSleepTime(r.time) ? r.time : d.reminders[key].time };
  };
  return {
    ...s,
    goalMinutes: s.goalMinutes == null ? d.goalMinutes : clampSleepGoal(s.goalMinutes),
    bedtime: isSleepTime(s.bedtime) ? s.bedtime : d.bedtime,
    wakeTime: isSleepTime(s.wakeTime) ? s.wakeTime : d.wakeTime,
    reminders: { ...rem, bedtime: reminder('bedtime'), log: reminder('log') },
  };
}

/* Напоминания сна в формате правил центра уведомлений (ежедневно, своё время).
   Пока не попадают в ключ notifications: сервер фоновых уведомлений принимает только
   известные ему типы — подключение будет отдельным этапом вместе с сервером. */
export function sleepReminderRules(settings) {
  const s = normalizeSleepSettings(settings);
  return Object.entries(SLEEP_REMINDERS).map(([key, def]) => ({
    id: def.type, type: def.type, enabled: s.reminders[key].enabled, repeat: 'daily', time: s.reminders[key].time,
    days: [], intervalMinutes: null, startTime: null, endTime: null, date: null,
    text: def.text, ref: { route: def.route }, channel: 'local', lastFiredAt: null,
  }));
}

/* ---------- выборки ---------- */

/* Основной сон по дате пробуждения. Если по ошибке (ручная правка копии) записей за дату
   несколько — берётся самая длинная, чтобы день не считался дважды. */
export function mainSleepByDate(entries) {
  const map = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isObj(e) || !isSleepDay(e.date) || !isNum(e.durationMinutes)) continue;
    const cur = map.get(e.date);
    if (!cur || e.durationMinutes > cur.durationMinutes) map.set(e.date, e);
  }
  return map;
}
export const getSleepForDate = (entries, date) => mainSleepByDate(entries).get(date) || null;
/* Записи (по одной на дату) в диапазоне дат включительно, по возрастанию даты */
export function entriesInRange(entries, start, end) {
  return [...mainSleepByDate(entries).values()].filter((e) => e.date >= start && e.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}
/* Новые сверху */
export const sortSleepEntries = (entries) => (Array.isArray(entries) ? entries.slice() : []).sort((a, b) => b.date.localeCompare(a.date) || String(b.sleepEnd).localeCompare(String(a.sleepEnd)));

/* ---------- средние ---------- */
export function averageSleep(entries) {
  const v = (Array.isArray(entries) ? entries : []).map((e) => e && e.durationMinutes).filter(isNum);
  return v.length ? Math.round(mean(v)) : null;
}
export function averageQuality(entries) {
  const v = (Array.isArray(entries) ? entries : []).map((e) => e && e.quality).filter((q) => isInt(q) && q >= 1 && q <= 5);
  return v.length ? mean(v) : null;
}

/* Циклическое среднее времени суток: 23:50 и 00:10 → 00:00, а не 12:00.
   Минуты → углы на окружности суток, среднее направление вектора. Разброс «по кругу»
   без преобладающего направления (00:00 и 12:00) → null. */
export function circularMeanMinutes(list) {
  const v = (Array.isArray(list) ? list : []).filter(isNum);
  if (!v.length) return null;
  let x = 0, y = 0;
  for (const m of v) { const a = (m / 1440) * 2 * Math.PI; x += Math.cos(a); y += Math.sin(a); }
  if (Math.hypot(x, y) / v.length < 1e-6) return null;
  let a = Math.atan2(y, x);
  if (a < 0) a += 2 * Math.PI;
  return Math.round((a / (2 * Math.PI)) * 1440) % 1440;
}
/* Кратчайшая разница времени суток a − b по кругу: −720…720 мин */
export function clockDiff(a, b) {
  let d = ((a - b) % 1440 + 1440) % 1440;
  if (d > 720) d -= 1440;
  return d;
}
export const averageBedtime = (entries) => circularMeanMinutes((entries || []).filter((e) => e && isSleepStamp(e.sleepStart)).map((e) => clockOf(e.sleepStart)));
export const averageWakeTime = (entries) => circularMeanMinutes((entries || []).filter((e) => e && isSleepStamp(e.sleepEnd)).map((e) => clockOf(e.sleepEnd)));

/* Стабильность режима, %: насколько одинаковыми были время отхода ко сну и подъёма.
   Среднее отклонение (по кругу суток) от обычного времени, по засыпанию и пробуждению;
   0 мин → 100 %, CONSISTENCY_SPAN_MINUTES и больше → 0 %. Меньше 3 записей → null. */
export function sleepConsistency(entries, { minEntries = CONSISTENCY_MIN_ENTRIES, span = CONSISTENCY_SPAN_MINUTES } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && isSleepStamp(e.sleepStart) && isSleepStamp(e.sleepEnd));
  if (list.length < minEntries) return null;
  const bed = averageBedtime(list);
  const wake = averageWakeTime(list);
  if (bed == null || wake == null) return 0;
  const dev = mean(list.map((e) => (Math.abs(clockDiff(clockOf(e.sleepStart), bed)) + Math.abs(clockDiff(clockOf(e.sleepEnd), wake))) / 2));
  return Math.round(100 * Math.max(0, 1 - dev / span));
}

/* ---------- цель и серии ---------- */
const metGoal = (e, goal) => !!e && isNum(e.durationMinutes) && e.durationMinutes >= goal;

/* Выполнение цели: среди дней с записью (пропущенный день — не провал и не успех) */
export function sleepGoalRate(entries, goal) {
  const list = [...mainSleepByDate(entries).values()];
  const met = list.filter((e) => metGoal(e, goal)).length;
  return { met, total: list.length, rate: list.length ? met / list.length : null };
}

/* Текущая серия: дни подряд, где основной ночной сон ≥ цели, по сегодня.
   Сегодня записи ещё нет — серия считается по вчера (утро может быть впереди);
   сегодня записан сон короче цели — серия прервана (0). Пропущенный день прерывает серию. */
export function currentSleepStreak(entries, goal, today = localDay()) {
  const map = mainSleepByDate(entries);
  let d = today;
  if (!map.has(d)) d = addDays(d, -1);
  let n = 0;
  while (metGoal(map.get(d), goal)) { n += 1; d = addDays(d, -1); }
  return n;
}
/* Лучшая серия за всё время (или за переданные записи) */
export function bestSleepStreak(entries, goal) {
  const days = [...mainSleepByDate(entries).values()].filter((e) => metGoal(e, goal)).map((e) => e.date).sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/* ---------- периоды ---------- */
export const PERIOD_KINDS = ['week', 'month', 'year'];
/* Календарный период, содержащий anchor: неделя Пн–Вс, месяц, год */
export function periodBounds(kind, anchor) {
  const d = parseDay(anchor);
  if (kind === 'week') {
    const start = localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));
    return { kind, start, end: addDays(start, 6) };
  }
  if (kind === 'year') return { kind, start: `${d.getFullYear()}-01-01`, end: `${d.getFullYear()}-12-31` };
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  return { kind: 'month', start: `${ym}-01`, end: `${ym}-${pad(last)}` };
}
/* Сдвиг периода на delta (−1 — предыдущий) → границы нового периода */
export function shiftPeriod(bounds, delta) {
  const d = parseDay(bounds.start);
  if (bounds.kind === 'week') return periodBounds('week', addDays(bounds.start, 7 * delta));
  if (bounds.kind === 'year') return periodBounds('year', `${d.getFullYear() + delta}-01-01`);
  return periodBounds('month', localDay(new Date(d.getFullYear(), d.getMonth() + delta, 1)));
}

/* Дневные слоты недели/месяца: { date, minutes|null, entry|null } — без записи null, не 0 */
function dailySlots(entries, start, end) {
  const map = mainSleepByDate(entries);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const e = map.get(d) || null;
    out.push({ date: d, minutes: e ? e.durationMinutes : null, quality: e && isInt(e.quality) ? e.quality : null, entry: e });
  }
  return out;
}
export const aggregateByWeek = (entries, anchor) => { const b = periodBounds('week', anchor); return dailySlots(entries, b.start, b.end); };
export const aggregateByMonth = (entries, anchor) => { const b = periodBounds('month', anchor); return dailySlots(entries, b.start, b.end); };
/* Год: 12 месяцев — средняя продолжительность и качество по дням с записями */
export function aggregateByYear(entries, anchor) {
  const y = parseDay(anchor).getFullYear();
  const list = entriesInRange(entries, `${y}-01-01`, `${y}-12-31`);
  return Array.from({ length: 12 }, (_, i) => {
    const ym = `${y}-${pad(i + 1)}`;
    const month = list.filter((e) => e.date.startsWith(ym));
    const q = averageQuality(month);
    return { month: ym, start: `${ym}-01`, end: periodBounds('month', `${ym}-01`).end, minutes: averageSleep(month), quality: q, count: month.length };
  });
}

/* Средний сон: текущий период против предыдущего. Нет данных хотя бы в одном → null */
export function comparePeriods(curEntries, prevEntries) {
  const current = averageSleep(curEntries);
  const previous = averageSleep(prevEntries);
  if (current == null || previous == null) return null;
  return { current, previous, delta: current - previous };
}

/* ---------- «Что связано с вашим сном» ----------
   Только фактические сравнения средних в записях пользователя, без причинных выводов.
   Фактор учитывается, если есть ≥ minDays дней с ним и ≥ minDays без него (для качества —
   с оценкой качества). Маленькие различия не показываются. */
export function factorInsights(entries, { minDays = INSIGHT_MIN_DAYS, minDuration = INSIGHT_MIN_DURATION_DELTA, minQuality = INSIGHT_MIN_QUALITY_DELTA } = {}) {
  const list = [...mainSleepByDate(entries).values()];
  const out = [];
  for (const t of SLEEP_TAGS) {
    const has = (e) => Array.isArray(e.tags) && e.tags.includes(t.key);
    const withT = list.filter(has);
    const without = list.filter((e) => !has(e));
    if (withT.length >= minDays && without.length >= minDays) {
      const a = averageSleep(withT), b = averageSleep(without);
      if (Math.abs(a - b) >= minDuration) out.push({ key: t.key, kind: 'duration', with: a, without: b, delta: a - b, withDays: withT.length, withoutDays: without.length });
    }
    const qWith = withT.filter((e) => isInt(e.quality));
    const qWithout = without.filter((e) => isInt(e.quality));
    if (qWith.length >= minDays && qWithout.length >= minDays) {
      const a = averageQuality(qWith), b = averageQuality(qWithout);
      if (Math.abs(a - b) >= minQuality) out.push({ key: t.key, kind: 'quality', with: a, without: b, delta: a - b, withDays: qWith.length, withoutDays: qWithout.length });
    }
  }
  return out.sort((x, y) => (y.kind === 'duration' ? Math.abs(y.delta) / 60 : Math.abs(y.delta)) - (x.kind === 'duration' ? Math.abs(x.delta) / 60 : Math.abs(x.delta)));
}
const fmtQ = (q) => q.toFixed(1).replace('.', ',');
/* Текст наблюдения: «В дни со стрессом сон в среднем был на 38 мин короче (6 ч 40 мин против 7 ч 18 мин).» */
export function insightText(x) {
  const t = tagInfo(x.key);
  const when = t ? t.when : 'В дни с этим фактором';
  if (x.kind === 'duration') {
    return `${when} сон в среднем был на ${formatSleepDuration(Math.abs(x.delta))} ${x.delta < 0 ? 'короче' : 'дольше'} (${formatSleepDuration(x.with)} против ${formatSleepDuration(x.without)}).`;
  }
  return `${when} качество сна в среднем было ${fmtQ(x.with)} против ${fmtQ(x.without)}.`;
}
