/* =========================================================
   analytics.js — слой аналитики для экрана «Статистика»
   Чистые функции: без DOM, без Storage, входные данные не изменяются.
   Экран получает готовую модель (createStatsEngine → forPeriod) и только рисует.

   Принципы:
     • только фактически сохранённые записи — пропуск дня ≠ 0;
     • 0 учитывается, только если он реально записан (вода: запись дня с total 0);
     • несколько измерений за день → среднее за день (n = число измерений);
     • тренд — линейная регрессия (МНК) по дневным значениям, а не «первая vs последняя».
   Даты — календарные ISO ГГГГ-ММ-ДД; внутри — номер дня (UTC-сутки), без влияния DST.
   ========================================================= */

const DAY_MS = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');

/* Периоды экрана. days: null — «Всё время» (от первой записи до сегодня). */
export const PERIODS = [
  { key: '7d', days: 7, label: '7 дн', title: '7 дней' },
  { key: '30d', days: 30, label: '30 дн', title: '30 дней' },
  { key: '3m', days: 90, label: '3 мес', title: '3 месяца' },
  { key: '6m', days: 180, label: '6 мес', title: '6 месяцев' },
  { key: '1y', days: 365, label: 'Год', title: '1 год' },
  { key: 'all', days: null, label: 'Всё', title: 'Всё время' },
];
export const PERIOD_KEYS = PERIODS.map((p) => p.key);
export const DEFAULT_PERIOD = '30d';

/* Минимальное изменение, которое считается «заметным» (в единицах показателя).
   Это порог читаемости графика, а не медицинская норма. */
export const MIN_DELTA = {
  weight: 0.5, sys: 3, dia: 3, pulse: 3, temperature: 0.2, spo2: 1, glucose: 0.3,
  water: 150, activityMin: 5, steps: 500,
};

/* Условия расчёта тренда: не меньше TREND_MIN_POINTS дней с данными,
   первая и последняя точка отстоят не меньше чем на TREND_MIN_SPAN дней,
   |t| наклона ≥ TREND_T_CRIT (≈ 95 % для умеренного n). */
export const TREND_MIN_POINTS = 5;
export const TREND_MIN_SPAN = 5;
export const TREND_T_CRIT = 2;

/* ---------- цели ----------
   Цель считается явно сохранённой пользователем, только если её запись не из пакета
   значений по умолчанию: defaultMetricsConfig() (seed / restore / миграция v3→v4) пишет
   все цели одним вызовом с одинаковой меткой at, а setMetricGoal() («изменить» в модуле
   показателя) — одну цель со своей меткой at. Нет метки — происхождение неизвестно → не цель. */
export function isUserGoal(cfg, metric) {
  const c = isObj(cfg) ? cfg[metric] : null;
  if (!isObj(c) || c.goal == null || typeof c.at !== 'string') return false;
  return !Object.keys(cfg).some((m) => m !== metric && isObj(cfg[m]) && cfg[m].at === c.at);
}

/* ---------- даты ---------- */
export function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}
export function isoOfDay(day) {
  const dt = new Date(day * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/* ---------- извлечение рядов ---------- */
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

/* История показателя { "ГГГГ-ММ-ДД": raw } → [{ date, day, value, n }] по возрастанию даты.
   pick(raw) → число | null. Если за день хранится массив измерений — среднее за день. */
export function toDailySeries(log, pick) {
  const out = [];
  if (!isObj(log)) return out;
  for (const date of Object.keys(log)) {
    if (!ISO_RE.test(date)) continue;
    const raw = log[date];
    const vals = (Array.isArray(raw) ? raw : [raw]).map(pick).filter(isNum);
    if (!vals.length) continue;
    out.push({ date, day: dayNum(date), value: mean(vals), n: vals.length });
  }
  return out.sort((a, b) => a.day - b.day);
}

/* Точечные показатели: только положительные числа (0/пусто — не измерение) */
export const pickPoint = (x) => (isNum(x) && x > 0 ? x : null);
export const pickSys = (x) => (isObj(x) && isNum(x.systolic) && x.systolic > 0 ? x.systolic : null);
export const pickDia = (x) => (isObj(x) && isNum(x.diastolic) && x.diastolic > 0 ? x.diastolic : null);
/* Вода: запись дня есть → total (включая реальный 0); без total — сумма приёмов */
export const pickWater = (x) => {
  if (!isObj(x)) return null;
  if (isNum(x.total)) return Math.max(0, x.total);
  if (Array.isArray(x.entries) && x.entries.length) return x.entries.reduce((s, e) => s + (isNum(e && e.ml) ? e.ml : 0), 0);
  return null;
};
/* Активность: минуты = вело + другое + планка (сек → мин). Только если хоть одно поле минут заполнено. */
export const pickActivityMin = (a) => {
  if (!isObj(a)) return null;
  const plank = Array.isArray(a.plank) ? a.plank.filter(isNum) : [];
  if (!isNum(a.bike) && !isNum(a.otherMin) && !plank.length) return null;
  const min = (isNum(a.bike) ? a.bike : 0) + (isNum(a.otherMin) ? a.otherMin : 0) + plank.reduce((s, v) => s + v, 0) / 60;
  return Math.max(0, Math.round(min * 10) / 10);
};
export const pickSteps = (a) => (isObj(a) && isNum(a.steps) ? Math.max(0, a.steps) : null);

/* ---------- периоды ---------- */
export function periodRange(key, todayDay, firstDay = null) {
  const p = PERIODS.find((x) => x.key === key) || PERIODS.find((x) => x.key === DEFAULT_PERIOD);
  if (p.days) return { key: p.key, start: todayDay - p.days + 1, end: todayDay, days: p.days };
  const start = firstDay != null ? Math.min(firstDay, todayDay) : todayDay;
  return { key: p.key, start, end: todayDay, days: todayDay - start + 1 };
}
/* Непосредственно предыдущий период той же длины; для «Всё время» — нет */
export function getPreviousPeriod(range) {
  if (!range || range.key === 'all') return null;
  return { key: range.key, start: range.start - range.days, end: range.start - 1, days: range.days };
}
export function filterByPeriod(series, range) {
  if (!range) return [];
  return series.filter((p) => p.day >= range.start && p.day <= range.end);
}

/* ---------- базовая статистика ---------- */
export function calculateAverage(points) {
  return points.length ? mean(points.map((p) => p.value)) : null;
}
export function calculateMinMax(points) {
  if (!points.length) return null;
  let min = points[0], max = points[0];
  for (const p of points) { if (p.value < min.value) min = p; if (p.value > max.value) max = p; }
  return { min, max };
}
/* Сводка по точкам периода. count — число измерений, days — число дней с данными. */
export function calculateStats(points) {
  if (!points.length) return { count: 0, days: 0, avg: null, min: null, max: null, first: null, last: null };
  const mm = calculateMinMax(points);
  return {
    count: points.reduce((s, p) => s + (p.n || 1), 0),
    days: points.length,
    avg: calculateAverage(points),
    min: mm.min,
    max: mm.max,
    first: points[0],
    last: points[points.length - 1],
  };
}
/* Изменение первое → последнее измерение периода (факт, не тренд) */
export function calculateChange(points) {
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  return { delta: last.value - first.value, first, last, spanDays: last.day - first.day };
}

/* ---------- тренд: линейная регрессия (МНК) ----------
   x — дни от первой точки, y — дневное значение.
   slope = Sxy / Sxx; SE(slope) = sqrt(SSE/(n−2)) / sqrt(Sxx); t = slope / SE.
   delta — изменение по линии тренда на наблюдаемом отрезке (slope × span).
   Направление объявляется, только если |delta| ≥ minDelta И |t| ≥ tCrit;
   иначе — «выраженного изменения нет». Мало данных — 'insufficient'. */
export function calculateTrend(points, { minDelta = 0, minPoints = TREND_MIN_POINTS, minSpan = TREND_MIN_SPAN, tCrit = TREND_T_CRIT } = {}) {
  const n = points.length;
  const span = n ? points[n - 1].day - points[0].day : 0;
  if (n < minPoints || span < minSpan) return { status: 'insufficient', n, spanDays: span };
  const x0 = points[0].day;
  const xs = points.map((p) => p.day - x0);
  const ys = points.map((p) => p.value);
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    sst += (ys[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const se = Math.sqrt(sse / (n - 2)) / Math.sqrt(sxx);
  const t = se > 1e-12 ? slope / se : slope === 0 ? 0 : Math.sign(slope) * Infinity;
  const delta = slope * span;
  const clear = Math.abs(delta) >= minDelta && Math.abs(t) >= tCrit;
  return {
    status: clear ? (slope > 0 ? 'up' : 'down') : 'flat',
    n,
    spanDays: span,
    slopePerDay: slope,
    perWeek: slope * 7,
    delta,
    t,
    r2: sst > 0 ? 1 - sse / sst : 0,
    line: { from: { day: x0, value: intercept }, to: { day: x0 + span, value: intercept + slope * span } },
  };
}

/* Сравнение с предыдущим периодом: средние и число измерений */
export function comparePeriods(curPoints, prevPoints) {
  const cur = calculateStats(curPoints);
  const prev = calculateStats(prevPoints);
  return {
    cur,
    prev,
    deltaAvg: cur.avg != null && prev.avg != null ? cur.avg - prev.avg : null,
    regularity: compareRegularity(cur.count, prev.count),
  };
}
/* «Регулярнее/реже»: разница ≥ 2 измерений и ≥ 1,5 раза; при пустом прошлом — 'new' */
export function compareRegularity(cur, prev) {
  if (!prev && !cur) return 'none';
  if (!prev) return 'new';
  if (cur >= prev + 2 && cur >= prev * 1.5) return 'more';
  if (prev >= cur + 2 && prev >= cur * 1.5) return 'less';
  return 'same';
}

/* ---------- цели ----------
   Дни периода с данными; из них — дни с достижением цели (value ≥ goal).
   Серии: подряд идущие календарные дни с выполненной целью; день без записи прерывает серию. */
export function calculateGoalCompletion(points, goal, { todayDay = null, allPoints = null } = {}) {
  if (!isNum(goal) || goal <= 0) return null;
  const met = points.filter((p) => p.value >= goal);
  let best = 0, run = 0, prevDay = null;
  for (const p of points) {
    if (p.value >= goal) { run = prevDay != null && p.day === prevDay + 1 && run > 0 ? run + 1 : 1; best = Math.max(best, run); } else run = 0;
    prevDay = p.day;
  }
  let current = 0;
  if (todayDay != null) {
    const byDay = new Map((allPoints || points).map((p) => [p.day, p.value]));
    let d = todayDay;
    if (!(byDay.get(d) >= goal)) d -= 1; // сегодня день ещё не закончен
    while (byDay.get(d) >= goal) { current += 1; d -= 1; }
  }
  const avg = calculateAverage(points);
  return {
    goal,
    daysWithData: points.length,
    daysMet: met.length,
    pct: points.length ? met.length / points.length : null,
    avgPctOfGoal: avg != null ? avg / goal : null,
    bestStreak: best,
    currentStreak: current,
  };
}

/* ---------- качество данных ---------- */
export function calculateDataCoverage(points, range, todayDay, allPoints = points) {
  const past = allPoints.filter((p) => p.day <= todayDay);
  const lastAll = past.length ? past[past.length - 1] : null;
  return {
    count: points.reduce((s, p) => s + (p.n || 1), 0),
    days: points.length,
    periodDays: range ? range.days : 0,
    last: lastAll,
    daysSinceLast: lastAll ? todayDay - lastAll.day : null,
  };
}

/* ---------- агрегация для отображения (исходные точки не меняются) ----------
   Слоты по size дней, выровненные от конца периода; value — среднее по дням с данными
   (null — в слоте нет ни одной записи). */
export function bucketize(points, range, size = 1) {
  const buckets = [];
  let i = points.length - 1;
  for (let end = range.end; end >= range.start; end -= size) {
    const start = Math.max(range.start, end - size + 1);
    const inside = [];
    while (i >= 0 && points[i].day > end) i -= 1;
    let j = i;
    while (j >= 0 && points[j].day >= start) { inside.push(points[j]); j -= 1; }
    buckets.push({
      start, end, size: end - start + 1,
      value: inside.length ? calculateAverage(inside) : null,
      days: inside.length,
      points: inside.reverse(),
    });
  }
  return buckets.reverse();
}
/* Шаг агрегации столбцов по длине периода: день / неделя / ~месяц */
export const bucketSizeFor = (days) => (days <= 92 ? 1 : days <= 400 ? 7 : 30);

/* =========================================================
   Модель экрана. raw — «сырые» разделы базы (только чтение).
   createStatsEngine извлекает ряды один раз; forPeriod(key) — мемоизирован.
   ========================================================= */
export function createStatsEngine(raw, todayIso) {
  const today = dayNum(todayIso);
  const log = isObj(raw.metricsLog) ? raw.metricsLog : {};
  const cfg = isObj(raw.metricsConfig) ? raw.metricsConfig : {};
  const activityDays = isObj(raw.activityDays) ? raw.activityDays : {};
  const goals = isObj(raw.activityGoals) ? raw.activityGoals : {};
  const noFuture = (s) => s.filter((p) => p.day <= today);

  const series = {
    weight: noFuture(toDailySeries(log.weight, pickPoint)),
    sys: noFuture(toDailySeries(log.pressure, pickSys)),
    dia: noFuture(toDailySeries(log.pressure, pickDia)),
    pulse: noFuture(toDailySeries(log.pulse, pickPoint)),
    temperature: noFuture(toDailySeries(log.temperature, pickPoint)),
    spo2: noFuture(toDailySeries(log.spo2, pickPoint)),
    glucose: noFuture(toDailySeries(log.glucose, pickPoint)),
    water: noFuture(toDailySeries(log.water, pickWater)),
    activityMin: noFuture(toDailySeries(activityDays, pickActivityMin)),
    steps: noFuture(toDailySeries(activityDays, pickSteps)),
  };
  const activityRecorded = noFuture(toDailySeries(activityDays, (a) => (isObj(a) ? 1 : null)));
  const tests = (Array.isArray(raw.tests) ? raw.tests : [])
    .filter((t) => isObj(t) && typeof t.date === 'string' && ISO_RE.test(t.date) && dayNum(t.date) <= today)
    .map((t) => ({ ...t, day: dayNum(t.date) }))
    .sort((a, b) => a.day - b.day);
  const medLog = isObj(raw.medLog) ? raw.medLog : {};
  const medDays = Object.keys(medLog)
    .filter((d) => ISO_RE.test(d) && Array.isArray(medLog[d]) && medLog[d].length)
    .map(dayNum)
    .filter((d) => d <= today);

  const firstDays = [...Object.values(series), activityRecorded].filter((s) => s.length).map((s) => s[0].day);
  tests.length && firstDays.push(tests[0].day);
  const firstDay = firstDays.length ? Math.min(...firstDays) : null;
  const hasAny = firstDay != null;

  /* давление: линия/плитка цели — только при явно сохранённой пользовательской цели */
  const pg = cfg.pressure && cfg.pressure.goal;
  const pressureGoal = isUserGoal(cfg, 'pressure') && isObj(pg) && isNum(pg.systolic) && pg.systolic > 0 && isNum(pg.diastolic) && pg.diastolic > 0
    ? { systolic: pg.systolic, diastolic: pg.diastolic } : null;
  const numGoal = (m) => (cfg[m] && isNum(cfg[m].goal) && cfg[m].goal > 0 ? cfg[m].goal : null);

  function block(key, range, prev) {
    const all = series[key];
    const points = filterByPeriod(all, range);
    const prevPoints = filterByPeriod(all, prev);
    return {
      key,
      totalDays: all.length,
      lastAll: all.length ? all[all.length - 1] : null,
      points,
      stats: calculateStats(points),
      change: calculateChange(points),
      trend: calculateTrend(points, { minDelta: MIN_DELTA[key] || 0 }),
      compare: prev ? comparePeriods(points, prevPoints) : null,
      coverage: calculateDataCoverage(points, range, today, all),
    };
  }

  const memo = new Map();
  function forPeriod(key) {
    if (memo.has(key)) return memo.get(key);
    const range = periodRange(key, today, firstDay);
    const prev = getPreviousPeriod(range);
    const size = bucketSizeFor(range.days);

    const water = block('water', range, prev);
    const waterGoal = numGoal('water');
    water.goal = waterGoal;
    water.goalCompletion = calculateGoalCompletion(water.points, waterGoal, { todayDay: today, allPoints: series.water });
    water.prevGoalCompletion = prev ? calculateGoalCompletion(filterByPeriod(series.water, prev), waterGoal) : null;
    water.buckets = bucketize(water.points, range, size);

    const actMin = block('activityMin', range, prev);
    const steps = block('steps', range, prev);
    const recorded = filterByPeriod(activityRecorded, range);
    const activeDays = (r) => {
      const days = new Set();
      filterByPeriod(series.activityMin, r).forEach((p) => p.value > 0 && days.add(p.day));
      filterByPeriod(series.steps, r).forEach((p) => p.value > 0 && days.add(p.day));
      return days.size;
    };
    const bikeGoal = isNum(goals.bike_minutes) && goals.bike_minutes > 0 ? goals.bike_minutes : null;
    const stepsGoal = isNum(goals.steps) && goals.steps > 0 ? goals.steps : null;
    const bikeSeries = filterByPeriod(toDailySeries(activityDays, (a) => (isObj(a) && isNum(a.bike) ? a.bike : null)), range);
    const bestOf = (pts) => pts.reduce((b, p) => (!b || p.value > b.value ? p : b), null);
    const activity = {
      minutes: { ...actMin, buckets: bucketize(actMin.points, range, size), best: bestOf(actMin.points) },
      steps: { ...steps, buckets: bucketize(steps.points, range, size), best: bestOf(steps.points), goal: stepsGoal,
        goalCompletion: calculateGoalCompletion(steps.points, stepsGoal) },
      bike: { goal: bikeGoal, goalCompletion: calculateGoalCompletion(bikeSeries, bikeGoal) },
      recordedDays: recorded.length,
      activeDays: activeDays(range),
      prevActiveDays: prev ? activeDays(prev) : null,
      prevRecordedDays: prev ? filterByPeriod(activityRecorded, prev).length : null,
      lastAll: activityRecorded.length ? activityRecorded[activityRecorded.length - 1] : null,
      totalDays: activityRecorded.length,
    };

    const inRange = (t) => t.day >= range.start && t.day <= range.end;
    const fields = Array.isArray(raw.testFields) ? raw.testFields : [];
    const latest = tests.length ? tests[tests.length - 1] : null;
    const testsModel = {
      total: tests.length,
      inPeriod: tests.filter(inRange).length,
      prevInPeriod: prev ? tests.filter((t) => t.day >= prev.start && t.day <= prev.end).length : null,
      latest,
      fields: latest ? fields.filter((f) => isNum(latest[f])).map((f) => {
        const earlier = tests.filter((t) => t.day < latest.day && isNum(t[f]));
        const prevT = earlier.length ? earlier[earlier.length - 1] : null;
        return {
          field: f,
          value: latest[f],
          date: latest.date,
          prev: prevT ? { value: prevT[f], date: prevT.date } : null,
          delta: prevT ? latest[f] - prevT[f] : null,
          history: tests.filter((t) => isNum(t[f])).length,
        };
      }) : [],
    };

    const model = {
      today: todayIso,
      todayDay: today,
      hasAny,
      range,
      prev,
      bucketSize: size,
      weight: { ...block('weight', range, prev), goal: numGoal('weight') },
      pressure: { sys: block('sys', range, prev), dia: block('dia', range, prev), goal: pressureGoal },
      pulse: block('pulse', range, prev),
      temperature: block('temperature', range, prev),
      spo2: block('spo2', range, prev),
      glucose: block('glucose', range, prev),
      water,
      activity,
      tests: testsModel,
      meds: {
        count: Array.isArray(raw.meds) ? raw.meds.length : 0,
        markedDays: medDays.filter((d) => d >= range.start && d <= range.end).length,
        lastDay: medDays.length ? Math.max(...medDays) : null,
      },
    };
    memo.set(key, model);
    return model;
  }

  /* Пульс в тот же день, что и измерение давления (для карточки точки) */
  const pulseByDay = new Map(series.pulse.map((p) => [p.day, p.value]));

  return { forPeriod, series, today, firstDay, hasAny, pulseOn: (day) => pulseByDay.get(day) ?? null };
}
