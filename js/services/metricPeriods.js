/* =========================================================
   js/services/metricPeriods.js — периоды и агрегация показателя для экранов статистики
   в духе Apple Health: ДН · НЕД · МЕС · 6 МЕС · ГОД, навигация ‹ › по целым периодам,
   столбцы графика, среднее, «красивая» шкала Y, подписи диапазона и подсказок.

   Без DOM и без Storage: вход — функция «значение дня» (и, для режима ДН, «значения по часам»),
   выход — готовая модель экрана. Подходит любому показателю с дневным значением
   (вода, шаги, велосипед — сумма дня; вес, давление — среднее по дням с данными).

   Календарь — локальный (как dateKey): дни — 'ГГГГ-ММ-ДД', арифметика только через
   год/месяц/число (переход на летнее время не сдвигает день).

   Периоды (offset 0 — текущий, −1 — предыдущий, …; вперёд дальше текущего нельзя):
     day   — один день;                         24 столбца по часам;
     week  — календарная неделя Пн–Вс;           7 столбцов (Пн … Вс);
     month — календарный месяц;                  столбцы по неделям месяца: 1–7, 8–14, 15–21, 22–28, 29–конец;
     6m    — 6 календарных месяцев по текущий;   6 столбцов-месяцев;
     year  — 12 календарных месяцев по текущий;  12 столбцов-месяцев.
   Будущие дни текущего периода в расчёт не входят: «прошедшие дни» = с начала периода по
   сегодня. Завершённые периоды — полностью.

   Режим 'sum' (по умолчанию; вода, шаги): день без записей = 0, среднее периода =
   сумма / число прошедших календарных дней; столбец недели — итог дня, столбец месяца /
   6 мес / года — среднее в день по прошедшим дням своего интервала.
   Режим 'mean' (точечные показатели): учитываются только дни с данными.
   ========================================================= */

export const PERIOD_KINDS = ['day', 'week', 'month', '6m', 'year'];
export const PERIOD_SHORT = { day: 'ДН', week: 'НЕД', month: 'МЕС', '6m': '6 МЕС', year: 'ГОД' };
export const PERIOD_NAME = { day: 'день', week: 'неделя', month: 'месяц', '6m': '6 месяцев', year: 'год' };

const NB = ' ';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const mk = (y, m, d) => key(new Date(y, m, d));
export const addDays = (k, n) => { const d = parse(k); return mk(d.getFullYear(), d.getMonth(), d.getDate() + n); };
const lastOfMonth = (y, m) => mk(y, m + 1, 0);
const minKey = (a, b) => (a < b ? a : b);
function daysBetween(start, end) {
  const out = [];
  for (let k = start; k <= end; k = addDays(k, 1)) out.push(k);
  return out;
}

/* ---------- подписи ---------- */
const MON_GEN = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']; // «5 окт.», «1 мая»
const MON_SHORT = ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']; // подписи столбцов
const MON3 = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']; // год: 12 столбцов
const MON_LETTER = ['Я', 'Ф', 'М', 'А', 'М', 'И', 'И', 'А', 'С', 'О', 'Н', 'Д']; // крайний запасной вариант — очень узкий экран
const MON_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAY = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const dm = (k) => { const d = parse(k); return `${d.getDate()}${NB}${MON_GEN[d.getMonth()]}`; };
const dmy = (k) => `${dm(k)} ${parse(k).getFullYear()}${NB}г.`;

/* Диапазон дат: «5 окт. 2026 г.» · «1 — 5 окт. 2026 г.» · «29 сент. — 5 окт. 2026 г.» ·
   «1 нояб. 2025 г. — 31 окт. 2026 г.» */
export function formatPeriodRange(start, end) {
  if (start === end) return dmy(end);
  const a = parse(start), b = parse(end);
  if (a.getFullYear() !== b.getFullYear()) return `${dmy(start)} — ${dmy(end)}`;
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} — ${dmy(end)}`;
  return `${dm(start)} — ${dmy(end)}`;
}

/* ---------- окно периода ---------- */

/* → { kind, offset, start, end (конец календарного периода), effEnd (не позже сегодня), dayKeys
   (прошедшие дни периода), days, isCurrent, hasNext, range (подпись), buckets } */
export function periodWindow(kind, offset = 0, today) {
  const k = PERIOD_KINDS.includes(kind) ? kind : 'week';
  const off = Math.min(0, Math.trunc(Number(offset) || 0));
  const t = parse(today);
  const Y = t.getFullYear(), M = t.getMonth();
  let start, end;
  if (k === 'day') {
    start = end = addDays(today, off);
  } else if (k === 'week') {
    const dow = (t.getDay() + 6) % 7; // Пн = 0
    start = mk(Y, M, t.getDate() - dow + 7 * off);
    end = addDays(start, 6);
  } else if (k === 'month') {
    start = mk(Y, M + off, 1);
    const s = parse(start);
    end = lastOfMonth(s.getFullYear(), s.getMonth());
  } else {
    const n = k === '6m' ? 6 : 12;
    const last = new Date(Y, M + n * off, 1);
    start = mk(last.getFullYear(), last.getMonth() - (n - 1), 1);
    end = lastOfMonth(last.getFullYear(), last.getMonth());
  }
  const effEnd = minKey(end, today);
  const dayKeys = start <= effEnd ? daysBetween(start, effEnd) : [];
  return {
    kind: k, offset: off, start, end, effEnd, dayKeys, days: dayKeys.length,
    isCurrent: off === 0, hasNext: off < 0,
    range: formatPeriodRange(start, effEnd),
    buckets: buildBuckets(k, start, end, today),
  };
}

function buildBuckets(kind, start, end, today) {
  const past = (s, e) => (s <= today ? daysBetween(s, minKey(e, today)) : []);
  if (kind === 'day') {
    return Array.from({ length: 24 }, (_, h) => ({
      key: `h${pad(h)}`, hour: h, start, end, dayKeys: start <= today ? [start] : [],
      label: h % 6 === 0 ? pad(h) : '', tip: `${pad(h)}:00–${pad((h + 1) % 24)}:00`, sep: h % 6 === 0 && h > 0,
    }));
  }
  if (kind === 'week') {
    return daysBetween(start, end).map((d, i) => ({
      key: d, start: d, end: d, dayKeys: past(d, d), label: WEEKDAY[i], tip: dmy(d).replace(`${NB}г.`, ''), sep: i > 0,
    }));
  }
  if (kind === 'month') {
    const s = parse(start);
    const y = s.getFullYear(), m = s.getMonth();
    const lastDay = parse(end).getDate();
    const out = [];
    for (let d = 1; d <= lastDay; d += 7) {
      const a = mk(y, m, d), b = mk(y, m, Math.min(d + 6, lastDay));
      const da = d, db = Math.min(d + 6, lastDay);
      out.push({ key: a, start: a, end: b, dayKeys: past(a, b), label: `${da}–${db}`, tip: `${da}–${db}${NB}${MON_GEN[m]}`, sep: d > 1 });
    }
    return out;
  }
  const out = [];
  const s = parse(start);
  const n = kind === '6m' ? 6 : 12;
  for (let i = 0; i < n; i++) {
    const md = new Date(s.getFullYear(), s.getMonth() + i, 1);
    const y = md.getFullYear(), m = md.getMonth();
    const a = mk(y, m, 1), b = lastOfMonth(y, m);
    out.push({
      key: a.slice(0, 7), start: a, end: b, dayKeys: past(a, b), month: m,
      label: kind === 'year' ? MON3[m] : MON_SHORT[m], letter: MON_LETTER[m], tip: `${MON_FULL[m]} ${y}`,
      sep: kind === '6m' ? i > 0 : i > 0 && i % 3 === 0,
    });
  }
  return out;
}

/* ---------- агрегация ----------
   dayValue(date) → число | null (значение дня; null — записей нет);
   hourValues(date) → массив 24 чисел (только для режима ДН).
   → окно периода + { total, average, buckets[i].value (null — нет прошедших дней / данных),
     buckets[i].avg (true — значение «в среднем в день»), max } */
export function aggregatePeriod(win, dayValue, { mode = 'sum', hourValues = null } = {}) {
  const val = (d) => { const v = dayValue(d); return isNum(v) ? v : null; };
  if (win.kind === 'day') {
    const day = win.dayKeys[0];
    const hours = day && hourValues ? hourValues(day) : [];
    const buckets = win.buckets.map((b) => ({ ...b, avg: false, value: day ? (isNum(hours[b.hour]) ? hours[b.hour] : 0) : null }));
    const total = day ? val(day) ?? 0 : 0;
    return finish(win, buckets, total, total);
  }
  const reduce = (keys) => {
    const vals = keys.map(val);
    if (mode === 'mean') {
      const has = vals.filter((v) => v != null);
      return { sum: has.reduce((s, v) => s + v, 0), n: has.length, value: has.length ? has.reduce((s, v) => s + v, 0) / has.length : null };
    }
    const sum = vals.reduce((s, v) => s + (v ?? 0), 0);
    return { sum, n: keys.length, value: keys.length ? sum / keys.length : null };
  };
  const buckets = win.buckets.map((b) => {
    const r = reduce(b.dayKeys);
    return { ...b, avg: win.kind !== 'week', value: r.value };
  });
  const all = reduce(win.dayKeys);
  return finish(win, buckets, all.sum, all.n ? all.value : (mode === 'mean' ? null : 0));
}
function finish(win, buckets, total, average) {
  const max = buckets.reduce((m, b) => (isNum(b.value) && b.value > m ? b.value : m), 0);
  return { ...win, buckets, total, average, max };
}

/* ---------- шкала Y ----------
   top = max(данные, цель) × запас (10 %), округление вверх до «красивого» шага (1 · 2 · 2,5 · 5 × 10ⁿ)
   так, чтобы интервалов было 2–4: 2350 и цель 2600 → 0…3000 (шаг 1000); 3600 → 0…4000;
   5100 → 0…6000. Цель всегда внутри шкалы. → { max, step, ticks } */
export function niceScale(dataMax, goal = null, { headroom = 1.1, minTop = 0 } = {}) {
  const base = Math.max(isNum(dataMax) ? dataMax : 0, isNum(goal) ? goal : 0, minTop);
  if (!(base > 0)) return { max: 1000, step: 500, ticks: [0, 500, 1000] };
  const top = base * headroom;
  const raw = top / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * p).find((s) => s >= raw);
  const max = Math.ceil(top / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { max, step, ticks };
}

/* «1 000», «2 500» — разряды неразрывным пробелом */
export const fmtGroup = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NB);
