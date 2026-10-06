/* =========================================================
   workouts.js — раздел «Тренировки» (Планка и «Другое упражнение»): модель записи, проверка
   ввода, порядок журнала, форматирование и однократный перенос старых записей из
   activity_days. Чистые функции без DOM и без хранилища (storage.js импортирует этот файл).

   Модель (аддитивные ключи, схема v8 не меняется — как bike_log):
   • workouts_log = [{ id, date, kind, …, note, source, createdAt, updatedAt }]
       kind 'plank' — Планка:  sets (подходов), seconds (секунд в подходе); всего = sets × seconds;
                               legacySeconds — исходные секунды подходов, если они были разными
                               при переносе (seconds тогда хранит среднее); ручной ввод не создаёт
                               это поле и теряет его при правке (sets/seconds вводятся заново);
       kind 'other' — Другое:  name (название — любое, вводит пользователь), minutes (длительность).
     Несколько тренировок за день — отдельные записи. Шаги, велосипед, сон и вода сюда не входят:
     у них свои разделы.
   • workouts_migration = { version, migratedAt, plankAdded, otherAdded, … } — отметка
     однократного переноса из activity_days (входит в бэкап, как activity_migration), поэтому
     удалённая пользователем перенесённая запись не возвращается ни при следующем запуске,
     ни после восстановления копии.
   Старый формат (activity_days[день]): plank — массив секунд по подходам ([60, 60, 60] = 3 × 60),
   otherType — название, otherMin — минуты. activity_days при переносе не изменяется.
   source: 'manual' — вручную, 'activity' — перенесено из прежнего раздела «Активность».
   ========================================================= */

export const WORKOUT_KINDS = ['plank', 'other'];
export const WORKOUT_TITLES = { plank: 'Планка', other: 'Другое упражнение' };
export const PLANK_SETS_MAX = 100;
export const PLANK_SECONDS_MAX = 3600;
export const WORKOUT_MINUTES_MAX = 1440;
export const WORKOUT_NAME_MAX = 60;
export const WORKOUT_NOTE_MAX = 500;
export const LEGACY_WORKOUT_SOURCE = 'activity';
export const WORKOUTS_MIGRATION_VERSION = 1;
/* подсказки названия (свободный ввод — любое название) */
export const WORKOUT_NAME_SUGGESTIONS = ['Отжимания', 'Приседания', 'Пресс', 'Растяжка', 'Гантели', 'Йога'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const NB = ' ';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function isWorkoutDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/* «3», « 60 » → целое | NaN (пусто → null) */
export function parseWorkoutInt(raw) {
  if (raw == null) return null;
  if (isNum(raw)) return raw;
  const s = String(raw).replace(/[\s  ]/g, '');
  if (!s) return null;
  return /^\d+([.,]\d+)?$/.test(s) ? Number(s.replace(',', '.')) : NaN;
}
const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, WORKOUT_NAME_MAX);

/* ---------- форма → запись ----------
   input: { kind, date, sets, seconds, name, minutes, note }, opts.today
   → { ok, errors, value: { kind, date, sets, seconds, note } | { kind, date, name, minutes, note } } */
export function normalizeWorkoutInput(input = {}, { today = localDay() } = {}) {
  const errors = {};
  const kind = input.kind;
  if (!WORKOUT_KINDS.includes(kind)) errors.kind = 'Выберите тип тренировки';
  const date = String(input.date || '');
  if (!isWorkoutDay(date)) errors.date = 'Укажите дату';
  else if (date > today) errors.date = 'Дата не может быть в будущем';
  const note = String(input.note ?? '').trim().slice(0, WORKOUT_NOTE_MAX);
  let value = null;
  if (kind === 'plank') {
    const sets = parseWorkoutInt(input.sets);
    const seconds = parseWorkoutInt(input.seconds);
    if (sets == null || Number.isNaN(sets) || !isInt(sets) || sets < 1 || sets > PLANK_SETS_MAX) errors.sets = `Подходов — целое число от 1 до ${PLANK_SETS_MAX}`;
    if (seconds == null || Number.isNaN(seconds) || !isInt(seconds) || seconds < 1 || seconds > PLANK_SECONDS_MAX) errors.seconds = `Секунд в подходе — целое число от 1 до ${PLANK_SECONDS_MAX}`;
    value = { kind, date, sets, seconds, note };
  } else if (kind === 'other') {
    const name = cleanName(input.name);
    const minutes = parseWorkoutInt(input.minutes);
    if (!name) errors.name = 'Укажите название упражнения';
    if (minutes == null || Number.isNaN(minutes) || !isInt(minutes) || minutes < 1 || minutes > WORKOUT_MINUTES_MAX) errors.minutes = `Длительность — целое число минут от 1 до ${WORKOUT_MINUTES_MAX}`;
    value = { kind, date, name, minutes, note };
  }
  const ok = !Object.keys(errors).length;
  return { ok, errors, value: ok ? value : null };
}

/* ---------- проверка структуры (хранилище, резервная копия) ---------- */
const isText = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
export function isValidWorkout(w) {
  if (!isObj(w) || typeof w.id !== 'string' || !ID_RE.test(w.id) || !isWorkoutDay(w.date)) return false;
  if (!(isText(w.note, WORKOUT_NOTE_MAX * 2) && isText(w.createdAt, 40) && isText(w.updatedAt, 40)
    && (w.source == null || (typeof w.source === 'string' && SOURCE_RE.test(w.source))))) return false;
  if (w.kind === 'plank') {
    return isInt(w.sets) && w.sets >= 1 && w.sets <= PLANK_SETS_MAX && isInt(w.seconds) && w.seconds >= 1 && w.seconds <= PLANK_SECONDS_MAX
      /* legacySeconds — точные секунды подходов из прежней «Активности», когда они были разными
         (seconds тогда — среднее); только у перенесённых записей, ручной ввод его не создаёт */
      && (w.legacySeconds == null || (Array.isArray(w.legacySeconds) && w.legacySeconds.length === w.sets
        && w.legacySeconds.every((s) => isInt(s) && s >= 1 && s <= PLANK_SECONDS_MAX)));
  }
  if (w.kind === 'other') {
    /* minutes null — только у перенесённых записей, где в прежней «Активности» было название без минут */
    return typeof w.name === 'string' && w.name.trim().length > 0 && w.name.length <= WORKOUT_NAME_MAX
      && (w.minutes == null || (isInt(w.minutes) && w.minutes >= 1 && w.minutes <= WORKOUT_MINUTES_MAX));
  }
  return false;
}
export const isValidWorkoutsLog = (v) => Array.isArray(v) && v.every(isValidWorkout);
export const isValidWorkoutsMigration = (v) => v == null || (isObj(v) && isInt(v.version) && v.version >= 1 && isText(v.migratedAt, 40));

/* ---------- порядок, расчёты ---------- */

/* Новые сверху: дата, затем позже добавленная выше (createdAt), затем порядок в массиве */
export function sortWorkouts(list) {
  return (Array.isArray(list) ? list : []).map((w, i) => [w, i])
    .sort((a, b) => b[0].date.localeCompare(a[0].date)
      || String(b[0].createdAt || '').localeCompare(String(a[0].createdAt || '')) || b[1] - a[1])
    .map(([w]) => w);
}
/* Общая длительность планки, секунд: 3 × 60 = 180 */
export const plankTotalSeconds = (w) => (w && isInt(w.sets) && isInt(w.seconds) ? w.sets * w.seconds : null);

/* ---------- форматирование ---------- */
export function plural(n, one, few, many) {
  const a = Math.abs(Math.round(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
/* «180 сек», «3 мин», «3 мин 30 сек», «1 ч 5 мин» */
export function fmtSeconds(total) {
  if (!isNum(total) || total < 0) return '—';
  const s = Math.round(total);
  if (s < 60) return `${s}${NB}сек`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h ? `${h}${NB}ч` : '', m ? `${m}${NB}мин` : '', r ? `${r}${NB}сек` : ''].filter(Boolean).join(' ');
}
/* «15 мин», «1 ч 30 мин» */
export function fmtMinutes(min) {
  if (!isNum(min) || min <= 0) return '';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return [h ? `${h}${NB}ч` : '', m ? `${m}${NB}мин` : ''].filter(Boolean).join(' ');
}
/* Название записи: «Планка» / название упражнения */
export const workoutTitle = (w) => (w && w.kind === 'plank' ? WORKOUT_TITLES.plank : (w && w.name) || WORKOUT_TITLES.other);
/* Значение: «3 подхода × 60 сек» / «15 мин» / «без длительности» */
export function workoutValue(w) {
  if (!w) return '';
  if (w.kind === 'plank') return `${w.sets}${NB}${plural(w.sets, 'подход', 'подхода', 'подходов')} × ${w.seconds}${NB}сек`;
  return fmtMinutes(w.minutes) || 'без длительности';
}
/* Подпись: «всего 3 мин» у планки (если подходов больше одного) · заметка */
export function workoutSub(w) {
  if (!w) return '';
  const parts = [];
  if (w.kind === 'plank' && w.sets > 1) parts.push(`всего ${fmtSeconds(plankTotalSeconds(w))}`);
  if (typeof w.note === 'string' && w.note) parts.push(w.note);
  return parts.join(' · ');
}

/* ---------- перенос старой «Активности» (activity_days) ----------
   Планка: подходы с секундами > 0 → одна запись дня; одинаковые подходы — sets × seconds,
   разные (в прежнем UI такого не было, но формат позволял) — средняя длительность подхода,
   а исходные секунды — в заметке. «Другое»: минуты > 0 или непустое название → запись
   (название не указано — «Другое упражнение»; минут нет — запись без длительности).
   id детерминированные (legacy-plank-<дата>, legacy-other-<дата>): уже есть — пропуск,
   поэтому повторный или прерванный запуск ничего не дублирует. Вход не изменяется.
   → { workoutsLog, marker, changed } */
export function migrateLegacyWorkouts({ activityDays, workoutsLog } = {}, { now = new Date().toISOString() } = {}) {
  const list = Array.isArray(workoutsLog) ? workoutsLog.slice() : [];
  const ids = new Set(list.map((w) => w && w.id));
  const marker = { version: WORKOUTS_MIGRATION_VERSION, migratedAt: now, plankAdded: 0, otherAdded: 0, skipped: 0, invalid: 0 };
  const days = isObj(activityDays) ? Object.keys(activityDays).filter(isWorkoutDay).sort() : [];
  const add = (w, counter) => {
    if (ids.has(w.id)) { marker.skipped += 1; return; }
    if (!isValidWorkout(w)) { marker.invalid += 1; return; }
    list.push(w); ids.add(w.id); marker[counter] += 1;
  };
  for (const d of days) {
    const a = activityDays[d];
    if (!isObj(a)) continue;
    const at = typeof a.savedAt === 'string' && a.savedAt.length <= 40 ? a.savedAt : null;
    const base = { date: d, source: LEGACY_WORKOUT_SOURCE, createdAt: at, updatedAt: at };
    const sets = Array.isArray(a.plank) ? a.plank.filter((s) => isNum(s) && s > 0).map((s) => Math.round(s)) : [];
    if (sets.length) {
      const same = sets.every((s) => s === sets[0]);
      const seconds = same ? sets[0] : Math.round(sets.reduce((s, x) => s + x, 0) / sets.length);
      add({ id: `legacy-plank-${d}`, ...base, kind: 'plank', sets: sets.length, seconds, legacySeconds: same ? null : sets, note: same ? '' : `Подходы: ${sets.join(', ')} сек` }, 'plankAdded');
    }
    const name = cleanName(a.otherType);
    const min = isNum(a.otherMin) && a.otherMin > 0 ? Math.round(a.otherMin) : null;
    if (name || min != null) {
      add({ id: `legacy-other-${d}`, ...base, kind: 'other', name: name || WORKOUT_TITLES.other, minutes: min, note: '' }, 'otherAdded');
    }
  }
  return { workoutsLog: list, marker, changed: marker.plankAdded + marker.otherAdded > 0 };
}
