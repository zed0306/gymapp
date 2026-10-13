// Модуль «Достижения и серии тренировок».
//
// Ключи хранилища:
//   'ach'   — {achievementId: 'YYYY-MM-DD'} — когда получено
//   'stats' — сводка за всё время: S.hist хранит только 60 последних тренировок, поэтому
//             счётчики копятся здесь (ядро отправляет S.stats на сервер в /api/sync)
//
// Серии считаются чистыми функциями (экспортируются для тестов), «сегодня» — параметром.

import { ctx } from '../core.js';
import { waterNorm } from '../calc.js';

const LIMIT = 4096; // лимит CloudStorage на значение, символов JSON

// ── Даты: 'YYYY-MM-DD' → номер дня (UTC, без перескоков часовых поясов) ──
const isKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
export const dayNum = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 864e5);
};
const numKey = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
// ISO-неделя (Пн–Вс): 1 января 1970 — четверг, поэтому сдвиг на 3 дня
const weekOf = (n) => Math.floor((n + 3) / 7);
const weekMonday = (w) => 7 * w - 3; // номер дня понедельника недели w
const perWeek = (n) => Math.min(7, Math.max(1, Math.round(+n) || 3));

// «Замороженная» часть серии — уже засчитанная при прошлом пересчёте: {end, count}.
// Её не перепроверяем: смена плана или веса не должна задним числом обнулять серию,
// а дни/недели, выпавшие из обрезанной истории ядра (S.hist — 60, S.water — 14 дней), сохраняются.
const frozenOf = (count, end) => (Number.isFinite(+count) && +count > 0 && Number.isFinite(+end) ? { count: +count, end: +end } : null);

// Допустимый разрыв между соседними тренировками серии, дней
export const maxGap = (daysPerWeek) => Math.ceil(7 / perWeek(daysPerWeek)) + 1;

// Уникальные дни тренировок (номера), по возрастанию, не позже today
function trainDays(dates, today) {
  const t = isKey(today) ? dayNum(today) : Infinity;
  const set = new Set();
  for (const k of dates || []) if (isKey(k)) set.add(dayNum(k));
  return [...set].filter((d) => d <= t).sort((a, b) => a - b);
}

// ── Серии ────────────────────────────────────────────
// Цепочка последних тренировок, где соседние не дальше maxGap дней; несколько в день = одна.
// Серия жива, если с последней тренировки прошло ≤ maxGap дней, иначе 0.
// frozen {end: номер дня последней тренировки сохранённой серии, count} — дойдя до этого дня,
// берём сохранённое число, не перепроверяя старые разрывы по новому плану.
export function workoutStreak(histDates, daysPerWeek, today, frozen = null) {
  const d = trainDays(histDates, today);
  if (!d.length || !isKey(today)) return 0;
  const gap = maxGap(daysPerWeek);
  let i = d.length - 1;
  if (dayNum(today) - d[i] > gap) return 0;
  let n = 0;
  for (;;) {
    if (frozen && d[i] === frozen.end) return n + frozen.count;
    n += 1;
    if (i === 0 || d[i] - d[i - 1] > gap) return n;
    i -= 1;
  }
}

// Самая длинная цепочка в истории (для инициализации лучшей серии)
export function longestWorkoutStreak(histDates, daysPerWeek) {
  const d = trainDays(histDates);
  const gap = maxGap(daysPerWeek);
  let best = 0;
  let run = 0;
  d.forEach((x, i) => {
    run = i && x - d[i - 1] <= gap ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

function weekCounts(histDates, today) {
  const m = new Map();
  for (const d of trainDays(histDates, today)) m.set(weekOf(d), (m.get(weekOf(d)) || 0) + 1);
  return m;
}

// ISO-недель подряд с тренировками (по дням) ≥ daysPerWeek. Текущая неделя засчитывается,
// если уже выполнена, и не обрывает серию, если ещё нет.
// frozen {end: номер ISO-недели, count} — уже засчитанные недели; текущая всегда проверяется заново.
// → {count, end: номер последней засчитанной недели}
export function weekChain(histDates, daysPerWeek, today, frozen = null) {
  if (!isKey(today)) return { count: 0, end: 0 };
  const need = perWeek(daysPerWeek);
  const m = weekCounts(histDates, today);
  const cur = weekOf(dayNum(today));
  const curDone = (m.get(cur) || 0) >= need;
  const fz = frozen ? { start: frozen.end - frozen.count + 1, end: Math.min(frozen.end, cur - 1) } : null;
  let n = curDone ? 1 : 0;
  for (let w = cur - 1; ; w -= 1) {
    if (fz && w >= fz.start && w <= fz.end) { n += w - fz.start + 1; break; }
    if ((m.get(w) || 0) < need) break;
    n += 1;
  }
  return { count: n, end: curDone ? cur : cur - 1 };
}

export function weekStreak(histDates, daysPerWeek, today, frozen = null) {
  return weekChain(histDates, daysPerWeek, today, frozen).count;
}

export function longestWeekStreak(histDates, daysPerWeek) {
  const need = perWeek(daysPerWeek);
  const weeks = [...weekCounts(histDates)].filter(([, c]) => c >= need).map(([w]) => w).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  weeks.forEach((w, i) => {
    run = i && w - weeks[i - 1] === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

function waterDone(log, normFn, n) {
  const k = numKey(n);
  const list = log?.[k];
  if (!Array.isArray(list) || !list.length) return false;
  const ml = list.reduce((s, e) => s + (+(Array.isArray(e) ? e[0] : e) || 0), 0);
  const norm = +normFn(k);
  return ml > 0 && norm > 0 && ml >= norm;
}

// Цепочка дней с выполненной нормой воды: {count, start, end} (номера дней).
// frozen {end: номер дня, count} — уже засчитанные дни: норму за них не пересчитываем
// (она зависит от текущего веса и плана). Сегодня проверяется всегда.
export function waterChain(waterLog, normFn, today, frozen = null) {
  if (!isKey(today)) return { count: 0, start: 0, end: 0 };
  const t = dayNum(today);
  const fz = frozen ? { start: frozen.end - frozen.count + 1, end: Math.min(frozen.end, t - 1) } : null;
  const end = waterDone(waterLog, normFn, t) ? t : t - 1;
  let d = end;
  while (end - d < 4000) {
    if (fz && d >= fz.start && d <= fz.end) { d = fz.start - 1; break; }
    if (!waterDone(waterLog, normFn, d)) break;
    d -= 1;
  }
  return { count: end - d, start: d + 1, end };
}

// Дней подряд с нормой воды; сегодня — если уже выполнено, иначе считаем со вчера
export function waterStreak(waterLog, normFn, today, frozen = null) {
  return waterChain(waterLog, normFn, today, frozen).count;
}

export function longestWaterStreak(waterLog, normFn) {
  const days = Object.keys(waterLog || {}).filter(isKey).map(dayNum).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    if (!waterDone(waterLog, normFn, d)) { run = 0; prev = d; continue; }
    run = prev !== null && d - prev === 1 && run ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

// ── Сводка stats ─────────────────────────────────────
const num = (v) => (Number.isFinite(+v) ? +v : 0);

export function statsFromHist(hist, daysPerWeek = 3) {
  const h = (Array.isArray(hist) ? hist : []).filter((x) => Array.isArray(x) && isKey(x[0]));
  const dates = h.map((x) => x[0]);
  return {
    workouts: h.length,
    volume: Math.round(h.reduce((s, x) => s + Math.max(0, num(x[3])), 0)),
    prs: 0,
    firstDate: [...dates].sort()[0] || null,
    streak: 0,
    bestStreak: longestWorkoutStreak(dates, daysPerWeek),
    weekStreak: 0,
    bestWeekStreak: longestWeekStreak(dates, daysPerWeek),
    bestWaterStreak: 0,
  };
}

// Пересчитать текущие серии и лучшие. Уже засчитанная часть каждой серии хранится в stats
// (streak + streakEnd, weekStreak + weekEnd, waterStreak + waterEnd) и не перепроверяется:
// так серия переживает обрезку S.hist/S.water и не обнуляется задним числом при смене плана или веса.
export function updateStreaks(stats, { hist, water, daysPerWeek, normFn, today }) {
  const st = { ...stats };
  const dates = (Array.isArray(hist) ? hist : []).map((h) => h?.[0]).filter(isKey);
  const uniq = trainDays(dates, today);
  const at = (k, conv = (n) => n) => (isKey(k) ? conv(dayNum(k)) : NaN);

  const s = workoutStreak(dates, daysPerWeek, today, frozenOf(st.streak, at(st.streakEnd)));
  const wk = weekChain(dates, daysPerWeek, today, frozenOf(st.weekStreak, at(st.weekEnd, weekOf)));
  const ch = waterChain(water, normFn, today, frozenOf(st.waterStreak, at(st.waterEnd)));

  st.streak = s;
  if (s > 0) st.streakEnd = numKey(uniq[uniq.length - 1]);
  else delete st.streakEnd;
  st.bestStreak = Math.max(num(st.bestStreak), s);

  st.weekStreak = wk.count;
  if (wk.count > 0) st.weekEnd = numKey(weekMonday(wk.end));
  else delete st.weekEnd;
  st.bestWeekStreak = Math.max(num(st.bestWeekStreak), wk.count);

  st.waterStreak = ch.count;
  if (ch.count > 0) st.waterEnd = numKey(ch.end);
  else delete st.waterEnd;
  st.bestWaterStreak = Math.max(num(st.bestWaterStreak), ch.count);
  return st;
}

// Стартовый вес — свой, в stats: S.weights ядро обрезает до 120 записей, и S.weights[0]
// со временем «уплывает» вслед за текущим весом. Берём первую запись веса один раз;
// пока идёт день старта, следуем за правкой веса (исправление опечатки в анкете — не прогресс).
export function withStart(stats, S, today) {
  const st = { ...stats };
  const w = num(S?.profile?.weight);
  if (num(st.startWeight) > 0 && isKey(st.startDate)) {
    if (st.startDate === today && w > 0) st.startWeight = r1(w);
    return st;
  }
  const first = (Array.isArray(S?.weights) ? S.weights : []).find((x) => Array.isArray(x) && num(x[1]) > 0);
  const v = r1(num(first?.[1]) || w);
  if (v > 0) {
    st.startWeight = v;
    st.startDate = isKey(first?.[0]) && first[0] <= today ? first[0] : today;
  }
  return st;
}

// ── Каталог ──────────────────────────────────────────
const count = (x) => (Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0);

// Всё, что нужно check(): собирается из S
export function buildState(S, today) {
  const st = S.stats || {};
  const p = S.profile || {};
  const lift = (id) => {
    const l = S.lifts?.[id];
    return l ? num(l.best) || num(l.w) : 0;
  };
  const ws = (Array.isArray(S.weights) ? S.weights : []).filter((w) => Array.isArray(w) && num(w[1]) > 0);
  const weight = num(p.weight) || num(ws[ws.length - 1]?.[1]);
  const fh = S.foodHist && typeof S.foodHist === 'object' ? Object.keys(S.foodHist).filter((k) => isKey(k) && k !== today) : [];
  const foodToday = S.food?.d === today && Array.isArray(S.food.items) && S.food.items.length > 0;
  return {
    workouts: num(st.workouts),
    volume: num(st.volume),
    prs: num(st.prs),
    bestStreak: Math.max(num(st.bestStreak), num(st.streak)),
    bestWeekStreak: Math.max(num(st.bestWeekStreak), num(st.weekStreak)),
    bestWaterStreak: Math.max(num(st.bestWaterStreak), num(st.waterStreak)),
    bench: lift('bb_bench'),
    squat: lift('bb_squat'),
    deadlift: lift('deadlift'),
    weight,
    startWeight: num(st.startWeight) || num(ws[0]?.[1]) || weight,
    goal: p.goal || 'maintain',
    target: num(p.targetWeight),
    foodDays: fh.length + (foodToday ? 1 : 0),
    measures: count(S.measures),
    photos: count(S.photos),
  };
}

const r1 = (x) => Math.round(x * 10) / 10;
const reach = (key, goal) => (s) => ({ done: s[key] >= goal, value: Math.min(s[key], goal), goal });
// Дата получения по полной истории (для тихой инициализации): h — S.hist по возрастанию дат
const nth = (n) => (h) => h[n - 1]?.[0];
const tons = (kg) => (h) => {
  let sum = 0;
  for (const x of h) if ((sum += Math.max(0, num(x[3]))) >= kg) return x[0];
  return null;
};

function A(id, cat, tier, icon, title, desc, check, extra = {}) {
  return { id, cat, tier, icon, title, desc, check, ...extra };
}

const KG = { unit: 'кг', dec: 1 };
const TONS = { unit: 'т', scale: 1000, dec: 1 };

export const CATEGORIES = [
  ['train', 'Тренировки'],
  ['streak', 'Серии'],
  ['power', 'Сила'],
  ['volume', 'Объём'],
  ['water', 'Вода и питание'],
  ['body', 'Тело'],
];

export const TIERS = { bronze: 'Бронза', silver: 'Серебро', gold: 'Золото', platinum: 'Платина' };

export const ACHIEVEMENTS = [
  A('w1', 'train', 'bronze', 'play', 'Первый шаг', 'Заверши первую тренировку', reach('workouts', 1), { when: nth(1) }),
  A('w5', 'train', 'bronze', 'dumbbell', 'Втянулся', 'Заверши 5 тренировок', reach('workouts', 5), { when: nth(5) }),
  A('w10', 'train', 'silver', 'check', 'Десятка', 'Заверши 10 тренировок', reach('workouts', 10), { when: nth(10) }),
  A('w25', 'train', 'silver', 'target', 'Привычка', 'Заверши 25 тренировок', reach('workouts', 25), { when: nth(25) }),
  A('w50', 'train', 'gold', 'trophy', 'Полсотни', 'Заверши 50 тренировок', reach('workouts', 50), { when: nth(50) }),
  A('w100', 'train', 'gold', 'medal', 'Сотня', 'Заверши 100 тренировок', reach('workouts', 100), { when: nth(100) }),
  A('w250', 'train', 'platinum', 'crown', 'Легенда зала', 'Заверши 250 тренировок', reach('workouts', 250), { when: nth(250) }),

  A('s3', 'streak', 'bronze', 'flame', 'Разогрев', '3 тренировки подряд без пропусков', reach('bestStreak', 3), { rule: 'gap' }),
  A('s5', 'streak', 'silver', 'flame', 'В ритме', '5 тренировок подряд без пропусков', reach('bestStreak', 5), { rule: 'gap' }),
  A('s10', 'streak', 'gold', 'flame', 'Дисциплина', '10 тренировок подряд без пропусков', reach('bestStreak', 10), { rule: 'gap' }),
  A('s20', 'streak', 'platinum', 'bolt', 'Несгибаемый', '20 тренировок подряд без пропусков', reach('bestStreak', 20), { rule: 'gap' }),
  A('wk4', 'streak', 'silver', 'calendar', 'Месяц по плану', '4 недели подряд выполняй план тренировок', reach('bestWeekStreak', 4), { rule: 'week' }),
  A('wk8', 'streak', 'gold', 'calendar', 'Два месяца по плану', '8 недель подряд выполняй план тренировок', reach('bestWeekStreak', 8), { rule: 'week' }),
  A('wk12', 'streak', 'platinum', 'calendar', 'Квартал без срывов', '12 недель подряд выполняй план тренировок', reach('bestWeekStreak', 12), { rule: 'week' }),

  A('pr1', 'power', 'bronze', 'zap', 'Первый рекорд', 'Подними больше, чем раньше, в любом упражнении', reach('prs', 1)),
  A('pr10', 'power', 'silver', 'star', 'Охотник за рекордами', 'Поставь 10 личных рекордов', reach('prs', 10)),
  A('b60', 'power', 'bronze', 'dumbbell', 'Жим 60', 'Пожми штангу лёжа 60 кг', reach('bench', 60), KG),
  A('b80', 'power', 'silver', 'dumbbell', 'Жим 80', 'Пожми штангу лёжа 80 кг', reach('bench', 80), KG),
  A('b100', 'power', 'gold', 'crown', 'Клуб 100', 'Пожми штангу лёжа 100 кг', reach('bench', 100), KG),
  A('bbw', 'power', 'gold', 'scale', 'Свой вес', 'Пожми штангу лёжа столько, сколько весишь сам', (s) => {
    const goal = r1(s.weight);
    return { done: goal > 0 && s.bench >= goal, value: Math.min(s.bench, goal), goal: goal || 1 };
  }, KG),
  A('sq100', 'power', 'silver', 'body', 'Присед 100', 'Присядь со штангой 100 кг', reach('squat', 100), KG),
  A('sq140', 'power', 'gold', 'body', 'Присед 140', 'Присядь со штангой 140 кг', reach('squat', 140), KG),
  A('dl100', 'power', 'silver', 'up', 'Тяга 100', 'Сделай становую тягу 100 кг', reach('deadlift', 100), KG),
  A('dl140', 'power', 'gold', 'up', 'Тяга 140', 'Сделай становую тягу 140 кг', reach('deadlift', 140), KG),
  A('dl180', 'power', 'platinum', 'up', 'Тяга 180', 'Сделай становую тягу 180 кг', reach('deadlift', 180), KG),

  A('v10', 'volume', 'bronze', 'chart', '10 тонн', 'Подними 10 тонн за все тренировки', reach('volume', 10000), { ...TONS, when: tons(10000) }),
  A('v50', 'volume', 'silver', 'chart', '50 тонн', 'Подними 50 тонн за все тренировки', reach('volume', 50000), { ...TONS, when: tons(50000) }),
  A('v100', 'volume', 'gold', 'chart', '100 тонн', 'Подними 100 тонн за все тренировки', reach('volume', 100000), { ...TONS, when: tons(100000) }),
  A('v500', 'volume', 'platinum', 'trophy', '500 тонн', 'Подними 500 тонн за все тренировки', reach('volume', 500000), { ...TONS, when: tons(500000) }),

  A('h3', 'water', 'bronze', 'drop', 'Водный баланс', 'Выполни норму воды 3 дня подряд', reach('bestWaterStreak', 3)),
  A('h7', 'water', 'silver', 'drop', 'Неделя без жажды', 'Выполни норму воды 7 дней подряд', reach('bestWaterStreak', 7)),
  A('f7', 'water', 'silver', 'food', 'Дневник питания', 'Записывай питание 7 дней', reach('foodDays', 7)),

  A('m1', 'body', 'bronze', 'ruler', 'Первый замер', 'Запиши замеры тела', reach('measures', 1)),
  A('p1', 'body', 'bronze', 'camera', 'Фото прогресса', 'Сделай первое фото прогресса', reach('photos', 1)),
  A('kg5', 'body', 'gold', 'down', 'Минус 5 кг', 'Сбрось 5 кг от стартового веса', (s) => {
    // Веса хранятся с точностью 0,1: сравниваем округлённую разность (59,1 → 64,1 — это ровно 5)
    const diff = r1(s.goal === 'gain' ? s.weight - s.startWeight : s.startWeight - s.weight);
    return { done: s.goal !== 'maintain' && s.weight > 0 && diff >= 5, value: Math.max(0, Math.min(5, diff)), goal: 5 };
  }, {
    ...KG,
    title: (s) => (s.goal === 'gain' ? 'Плюс 5 кг' : 'Минус 5 кг'),
    desc: (s) => (s.goal === 'gain' ? 'Набери 5 кг от стартового веса' : 'Сбрось 5 кг от стартового веса'),
    icon: (s) => (s.goal === 'gain' ? 'up' : 'down'),
    hidden: (s) => s.goal === 'maintain',
  }),
  A('goal', 'body', 'platinum', 'target', 'Цель достигнута', 'Дойди до желаемого веса', (s) => {
    if (!s.target || s.goal === 'maintain') return { done: false, value: 0, goal: 1, hint: 'Укажи желаемый вес в профиле — «Мои данные и цели».' };
    const total = r1(Math.abs(s.startWeight - s.target)) || 1;
    const passed = s.goal === 'lose' ? s.startWeight - s.weight : s.weight - s.startWeight;
    const done = s.weight > 0 && (s.goal === 'lose' ? r1(s.weight) <= r1(s.target) : r1(s.weight) >= r1(s.target));
    return { done, value: done ? total : Math.max(0, Math.min(total, r1(passed))), goal: total };
  }, KG),
];

const BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
const pick = (v, s) => (typeof v === 'function' ? v(s) : v);

export function runCheck(a, state) {
  try {
    const r = a.check(state) || {};
    return { done: !!r.done, value: num(r.value), goal: num(r.goal) || 1, hint: r.hint || '' };
  } catch {
    return { done: false, value: 0, goal: 1, hint: '' };
  }
}

// ── Хранилище: ≤ 4096 символов JSON ──────────────────
export function fitAch(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) if (isKey(v) && /^[\w-]{1,24}$/.test(k)) out[k] = v;
  if (JSON.stringify(out).length <= LIMIT) return out;
  // Сначала выбрасываем неизвестные (из старых версий), потом самые старые
  const keys = Object.keys(out).sort((a, b) => (!!BY_ID[a] - !!BY_ID[b]) || out[a].localeCompare(out[b]));
  while (keys.length && JSON.stringify(out).length > LIMIT) delete out[keys.shift()];
  return out;
}

const STAT_KEYS = [
  'workouts', 'volume', 'prs', 'firstDate',
  'streak', 'streakEnd', 'bestStreak', 'weekStreak', 'weekEnd', 'bestWeekStreak',
  'waterStreak', 'waterEnd', 'bestWaterStreak', 'startWeight', 'startDate',
];
const DATE_STATS = new Set(['firstDate', 'streakEnd', 'weekEnd', 'waterEnd', 'startDate']);

export function fitStats(st) {
  const out = {};
  for (const k of STAT_KEYS) {
    if (!(k in (st || {}))) continue;
    if (DATE_STATS.has(k)) { if (isKey(st[k])) out[k] = st[k]; } else if (k === 'startWeight') {
      const v = r1(num(st[k]));
      if (v > 0 && v < 1000) out[k] = v;
    } else out[k] = Math.max(0, Math.round(num(st[k])));
  }
  if (!('firstDate' in out)) out.firstDate = null;
  return JSON.stringify(out).length <= LIMIT ? out : {};
}

// ── Состояние модуля ─────────────────────────────────
let queue = []; // id достижений, ждущих праздника
let showing = false; // праздничное окно на экране
let pending = false; // показ запланирован (защита от повторного render)
let lastNew = []; // новые за последнюю тренировку — для шторки «Тренировка завершена»
let animated = null; // id достижения, чьё окно уже проиграло анимацию появления
let gid = 0; // счётчик id градиентов SVG в пределах одной отрисовки

const S = () => ctx.S?.() || {};
const todayKey = () => ctx.dkey();
const dpw = () => (S().profile?.days || []).length || 3;

function normFn() {
  const s = S();
  const p = s.profile;
  const today = todayKey();
  const prog = ctx.program?.();
  const done = new Set((s.hist || []).map((h) => h?.[0]));
  return (k) => {
    if (!p?.weight) return 0;
    let train;
    if (k === today) train = ctx.isTrainingDay();
    else {
      const wd = ((ctx.parseKey(k).getDay() + 6) % 7) + 1;
      train = done.has(k) || (prog ? prog.workouts.some((w) => w.weekday === wd) : (p.days || []).includes(wd));
    }
    return waterNorm(p, train);
  };
}

function initialStats(s) {
  const st = statsFromHist(s.hist, dpw());
  st.bestWaterStreak = longestWaterStreak(s.water, normFn());
  return st;
}

// Пересчёт: серии, лучшие значения, новые достижения.
// quiet — записать без праздника (первый запуск); workout — payload события workout.
function refresh({ quiet = false, workout = null } = {}) {
  const s = S();
  if (!s.profile?.done) return [];
  const today = todayKey();
  let st;
  if (!s.stats || typeof s.stats !== 'object') {
    // Впервые: всё уже есть в S.hist (в том числе только что завершённая тренировка)
    st = initialStats(s);
    if (workout) st.prs = (workout.prs || []).length;
  } else {
    st = { ...s.stats };
    const hist = Array.isArray(s.hist) ? s.hist : [];
    if (workout) {
      st.workouts = num(st.workouts) + 1;
      st.volume = num(st.volume) + Math.max(0, Math.round(num(workout.volume)));
      st.prs = num(st.prs) + (workout.prs || []).length;
    }
    // Счётчики не меньше того, что видно в истории
    const fromHist = statsFromHist(hist, dpw());
    st.workouts = Math.max(num(st.workouts), fromHist.workouts);
    st.volume = Math.max(num(st.volume), fromHist.volume);
    if (fromHist.firstDate && (!isKey(st.firstDate) || fromHist.firstDate < st.firstDate)) st.firstDate = fromHist.firstDate;
  }
  st = updateStreaks(st, { hist: s.hist, water: s.water, daysPerWeek: dpw(), normFn: normFn(), today });
  st = fitStats(withStart(st, s, today));
  if (JSON.stringify(st) !== JSON.stringify(s.stats)) ctx.save('stats', st);

  const ach = { ...(s.ach && typeof s.ach === 'object' ? s.ach : {}) };
  const state = buildState({ ...s, stats: st }, today);
  const fresh = [];
  // При тихой инициализации датируем по истории, если она полная (не обрезана до 60)
  const sorted = (Array.isArray(s.hist) ? s.hist : []).filter((h) => Array.isArray(h) && isKey(h[0]) && h[0] <= today)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const complete = quiet && sorted.length && sorted.length === st.workouts;
  for (const a of ACHIEVEMENTS) {
    if (ach[a.id]) continue;
    if (runCheck(a, state).done) {
      let when = null;
      if (complete && a.when) try { when = a.when(sorted); } catch { when = null; }
      ach[a.id] = isKey(when) ? when : today;
      fresh.push(a.id);
    }
  }
  if (fresh.length || !s.ach) ctx.save('ach', fitAch(ach));
  if (!quiet) for (const id of fresh) if (!queue.includes(id)) queue.push(id);
  return fresh;
}

// ── Вид ──────────────────────────────────────────────
function view() {
  const s = S();
  const today = todayKey();
  const st = s.stats || statsFromHist(s.hist, dpw());
  const state = buildState({ ...s, stats: st }, today);
  const ach = s.ach || {};
  const dates = (s.hist || []).map((h) => h?.[0]);
  // Серии на сегодня (в stats могут быть устаревшими, если давно не открывали)
  const live = updateStreaks(st, { hist: s.hist, water: s.water, daysPerWeek: dpw(), normFn: normFn(), today });
  const cur = weekOf(dayNum(today));
  const thisWeek = trainDays(dates, today).filter((d) => weekOf(d) === cur).length;
  const items = ACHIEVEMENTS.map((a, i) => {
    const r = runCheck(a, state);
    const earned = isKey(ach[a.id]) ? ach[a.id] : null;
    return {
      a, i, r, earned,
      title: pick(a.title, state), desc: pick(a.desc, state), icon: pick(a.icon, state),
      hidden: !earned && !!pick(a.hidden, state),
    };
  }).filter((x) => !x.hidden);
  const got = items.filter((x) => x.earned);
  const next = items
    .filter((x) => !x.earned && !x.r.hint)
    .sort((x, y) => y.r.value / y.r.goal - x.r.value / x.r.goal || x.i - y.i)[0] || null;
  return {
    st, state, items, got, next,
    streak: live.streak, bestStreak: Math.max(num(st.bestStreak), live.streak),
    week: live.weekStreak, bestWeek: Math.max(num(st.bestWeekStreak), live.weekStreak), thisWeek,
    water: live.waterStreak, bestWater: Math.max(num(st.bestWaterStreak), live.waterStreak),
    workouts: num(st.workouts),
  };
}

// Число для показа: в тоннах/кг с одним знаком. Прогресс невыполненного округляем вниз —
// 9 960 кг это «9,9 / 10 т», а не «10,0 / 10 т» при закрытом достижении.
export function shownValue(a, v, down = false) {
  const x = a.scale ? v / a.scale : v;
  if (!a.dec) return down ? Math.floor(x + 1e-9) : x;
  const m = 10 ** a.dec;
  return (down ? Math.floor(x * m + 1e-6) : Math.round(x * m)) / m;
}
const fmtNum = (a, x) => ctx.fmt(x, a.dec && x % 1 ? a.dec : 0);
export const progText = (x) => `${fmtNum(x.a, shownValue(x.a, x.r.value, !x.r.done))} / ${fmtNum(x.a, shownValue(x.a, x.r.goal))}${x.a.unit ? ` ${x.a.unit}` : ''}`;
const pctOf = (x) => Math.max(0, Math.min(1, x.r.value / x.r.goal));

// Круглый медальон: обод с градиентом уровня, бусины, диск, блик, иконка в центре.
// Закрытый — приглушённый, с дугой прогресса по ободу и замком.
// size = null — размер задаёт CSS (праздничное окно уменьшает медальон на низких экранах)
function medal(x, { size = 64, earned = !!x.earned, lock = true } = {}) {
  gid += 1;
  const id = `achg${gid}`;
  const pct = earned ? 0 : pctOf(x);
  const c = 2 * Math.PI * 45.5;
  return `<span class="ach-med ${earned ? `ach-t-${x.a.tier}` : 'locked'}"${size ? ` style="--sz:${size}px"` : ''} aria-hidden="true">
    <svg viewBox="0 0 100 100">
      <defs>
        <linearGradient id="${id}r" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" class="s1"/><stop offset=".55" class="s2"/><stop offset="1" class="s3"/></linearGradient>
        <linearGradient id="${id}d" x1=".25" y1="0" x2=".75" y2="1"><stop offset="0" class="s4"/><stop offset="1" class="s5"/></linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#${id}r)"/>
      <circle class="tk" cx="50" cy="50" r="43" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="0.01 5.63"/>
      <circle cx="50" cy="50" r="37.5" fill="url(#${id}d)"/>
      <circle class="edge" cx="50" cy="50" r="37.5" fill="none" stroke-width="1.6"/>
      ${earned ? '<path class="sh" d="M23 40a28 28 0 0 1 30-25" fill="none" stroke-width="4" stroke-linecap="round"/>' : ''}
      ${pct > 0 ? `<circle class="pg" cx="50" cy="50" r="45.5" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>` : ''}
    </svg>
    <span class="ach-ic">${ctx.icon(x.icon)}</span>
    ${!earned && lock ? `<span class="ach-lock">${ctx.icon('lock')}</span>` : ''}
  </span>`;
}

function itemFor(id, v = view()) {
  const a = BY_ID[id];
  if (!a) return null;
  return v.items.find((x) => x.a.id === id) || {
    a, r: runCheck(a, v.state), earned: S().ach?.[id] || null,
    title: pick(a.title, v.state), desc: pick(a.desc, v.state), icon: pick(a.icon, v.state),
  };
}

const workoutsWord = (n) => ctx.plural(n, 'тренировка', 'тренировки', 'тренировок');
const weeksWord = (n) => ctx.plural(n, 'неделя', 'недели', 'недель');
const daysWord = (n) => ctx.plural(n, 'день', 'дня', 'дней');

// Правила серий словами. maxGap — разница дат: Пн → Пт при gap 4 — «через 4 дня».
export function gapRule(gap) {
  return `следующая тренировка — не позже чем через ${gap} ${daysWord(gap)} после предыдущей`;
}
export function weekRule(n) {
  return `с понедельника по воскресенье ты тренируешься в ${n} ${n === 1 ? 'день' : ctx.plural(n, 'день', 'разных дня', 'разных дней')}`;
}

function longDate(k) {
  if (!isKey(k)) return '';
  const d = ctx.parseKey(k);
  return `${d.getDate()} ${ctx.MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function streakTitle(v) {
  if (v.streak >= 2) return `${v.streak} ${workoutsWord(v.streak)} подряд`;
  if (v.streak === 1) return 'Серия началась';
  return v.workouts ? 'Начни новую серию' : 'Начни свою серию';
}

function homeCard() {
  const s = S();
  if (!s.profile?.done) return '';
  const v = view();
  const esc = ctx.esc;
  let sub;
  if (!v.workouts) sub = 'Первая тренировка — первая медаль. Занимайся по плану, и серия будет расти.';
  else if (!v.streak) sub = `Лучшая серия — ${v.bestStreak} ${workoutsWord(v.bestStreak)}. Тренировка сегодня запустит новую.`;
  else {
    const n = dpw();
    const wk = v.week ? `${v.week} ${weeksWord(v.week)} по плану` : `На этой неделе ${Math.min(v.thisWeek, n)} из ${n}`;
    sub = `${wk}${v.bestStreak > v.streak ? ` · рекорд ${v.bestStreak}` : ''}`;
  }
  const n = v.next;
  return `<button class="card ach-home" data-act="push" data-name="achHome">
    <div class="ach-home-top">
      <div class="ach-flame ${v.streak ? 'on' : ''}">${ctx.icon('flame')}${v.streak ? `<b class="num">${v.streak}</b>` : ''}</div>
      <div class="grow"><div class="h3">${esc(streakTitle(v))}</div><div class="sub small">${esc(sub)}</div></div>
      <span class="chev">${ctx.icon('right', 'sm')}</span>
    </div>
    ${n ? `<div class="ach-home-next">
      ${medal(n, { size: 46, lock: false })}
      <div class="grow">
        <div class="ach-next-row"><span class="tiny muted">Ближайшее</span><span class="tiny muted num">${esc(progText(n))}</span></div>
        <div class="ach-next-title ellipsis">${esc(n.title)}</div>
        ${ctx.meter(n.r.value, n.r.goal, 'var(--accent)')}
      </div>
    </div>` : ''}
  </button>`;
}

function profileLink() {
  const s = S();
  if (!s.profile?.done) return '';
  const v = view();
  return `<button class="list-item" data-act="push" data-name="achHome">
    <div class="icon-box accent">${ctx.icon('medal')}</div>
    <div class="grow"><div class="h3">Достижения</div><div class="sub small num">${v.got.length} из ${v.items.length} · серия ${v.streak}</div></div>
    <span class="muted">${ctx.icon('right')}</span></button>`;
}

function streakTile(ic, cls, value, word, best, label) {
  return `<div class="ach-st ${cls}">
    <div class="ach-st-ic">${ctx.icon(ic, 'sm')}</div>
    <div class="ach-st-v num">${value}</div>
    <div class="ach-st-l">${word}<br>${label}</div>
    <div class="ach-st-b num">лучшая: ${best}</div>
  </div>`;
}

function achHome() {
  const v = view();
  const esc = ctx.esc;
  const n = dpw();
  const gap = maxGap(n);
  const tiers = Object.keys(TIERS).map((t) => [t, v.got.filter((x) => x.a.tier === t).length]);
  const sections = CATEGORIES.map(([cat, name]) => {
    const list = v.items.filter((x) => x.a.cat === cat);
    if (!list.length) return '';
    const got = list.filter((x) => x.earned).length;
    return `<div class="section-title"><div class="h3">${esc(name)}</div><span class="sub small num">${got} из ${list.length}</span></div>
      <div class="ach-grid">${list.map((x) => `<button class="ach-cell ${x.earned ? 'on' : ''}" data-act="achOpen" data-id="${x.a.id}">
        ${medal(x, { size: 68 })}
        <span class="ach-name">${esc(x.title)}</span>
        <span class="ach-meta num">${x.earned ? esc(ctx.shortDate(x.earned)) : x.r.hint ? 'нет цели' : esc(progText(x))}</span>
      </button>`).join('')}</div>`;
  }).join('');
  return `<div class="page no-tabs ach-page">
    ${ctx.backHeader('Достижения', `${v.got.length} из ${v.items.length} получено`)}
    <div class="card ach-sum">
      ${ctx.ring({ value: v.got.length, max: v.items.length, size: 104, stroke: 10, center: `<div><div class="val num">${v.got.length}</div><div class="muted tiny">из ${v.items.length}</div></div>` })}
      <div class="grow">
        <div class="ach-tiers">${tiers.map(([t, c]) => `<span class="ach-tier-row"><i class="ach-dot ach-t-${t}"></i>${TIERS[t]}<b class="num">${c}</b></span>`).join('')}</div>
      </div>
    </div>
    <div class="ach-streaks">
      ${streakTile('flame', 'is-fire', v.streak, workoutsWord(v.streak), v.bestStreak, 'подряд')}
      ${streakTile('calendar', 'is-week', v.week, weeksWord(v.week), v.bestWeek, 'по плану')}
      ${streakTile('drop', 'is-water', v.water, daysWord(v.water), v.bestWater, 'с нормой воды')}
    </div>
    <div class="notice" style="margin-top:12px">${ctx.icon('info', 'sm')}<div>Серия не прервётся, если ${gapRule(gap)}. Неделя засчитывается, если ${weekRule(n)}.</div></div>
    ${sections}
  </div>`;
}

function achDetail({ id }) {
  const v = view();
  const x = itemFor(id, v);
  if (!x) return '<div class="empty">Достижение не найдено</div>';
  const esc = ctx.esc;
  const n = dpw();
  const gap = maxGap(n);
  let rule = '';
  if (x.a.rule === 'gap') rule = `«Без пропусков» значит: ${gapRule(gap)}. Сейчас: ${v.streak}, лучшая серия: ${v.bestStreak}.`;
  if (x.a.rule === 'week') rule = `Неделя по плану засчитывается, если ${weekRule(n)}. Сейчас: ${v.week}, лучшая серия: ${v.bestWeek}.`;
  return `<div class="ach-detail">
    <div class="ach-detail-med ${x.earned ? `ach-t-${x.a.tier}` : ''}">${medal(x, { size: 128 })}</div>
    <span class="ach-tier ${x.earned ? `ach-t-${x.a.tier}` : 'locked'}">${TIERS[x.a.tier]}</span>
    <div class="h2" style="margin-top:10px">${esc(x.title)}</div>
    <div class="sub" style="margin-top:6px">${esc(x.desc)}</div>
    ${x.earned
      ? `<div class="ach-got">${ctx.icon('check', 'sm')}<span>Получено ${esc(longDate(x.earned))}</span></div>`
      : x.r.hint
        ? `<div class="notice" style="margin-top:16px;text-align:left">${ctx.icon('target', 'sm')}<div>${esc(x.r.hint)}</div></div>`
        : `<div class="ach-prog"><div class="row between small"><span class="muted">Прогресс</span><b class="num">${esc(progText(x))}</b></div>${ctx.meter(x.r.value, x.r.goal, 'var(--accent)')}</div>`}
    ${rule ? `<div class="sub small" style="margin-top:14px;text-align:left">${esc(rule)}</div>` : ''}
    <button class="btn block ghost" style="margin-top:18px" data-act="closeSheet">Закрыть</button>
  </div>`;
}

function doneExtra() {
  const v = view();
  const items = lastNew.map((id) => itemFor(id, v)).filter(Boolean);
  const esc = ctx.esc;
  const streak = v.streak >= 2
    ? `<div class="ach-done-streak">${ctx.icon('flame', 'sm')}<span><b>${v.streak} ${workoutsWord(v.streak)} подряд</b>${v.week ? ` · ${v.week} ${weeksWord(v.week)} по плану` : ''}</span></div>`
    : '';
  if (!items.length) return streak;
  return `<div class="ach-done">
    <div class="ach-done-head">${ctx.icon('medal', 'sm')}<b>Новые достижения</b><span class="badge accent num">+${items.length}</span></div>
    <div class="ach-done-list">${items.map((x) => `<div class="ach-mini">${medal({ ...x, earned: x.earned || todayKey() }, { size: 56 })}<span>${esc(x.title)}</span></div>`).join('')}</div>
  </div>${streak}`;
}

// Конфетти: 22 частицы, позиции — детерминированный псевдослучай (не прыгают при перерисовке)
const COLORS = ['var(--accent)', 'var(--water)', 'var(--protein)', 'var(--fat)', 'var(--carbs)', 'var(--warn)'];
const rnd = (i, k) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function confetti() {
  return Array.from({ length: 22 }, (_, i) => {
    const w = 6 + Math.round(rnd(i, 1) * 4);
    const h = i % 3 === 0 ? w : w + 4 + Math.round(rnd(i, 2) * 6);
    return `<i style="--x:${(3 + rnd(i, 3) * 94).toFixed(1)}%;--y:${(4 + rnd(i, 4) * 88).toFixed(1)}%;--w:${w}px;--h:${h}px;--c:${COLORS[i % COLORS.length]};--d:${(rnd(i, 5) * 0.9).toFixed(2)}s;--t:${(2.4 + rnd(i, 6) * 1.6).toFixed(2)}s;--dx:${Math.round(rnd(i, 7) * 120 - 60)}px;--r:${Math.round(360 + rnd(i, 8) * 540)}deg;--r0:${Math.round(rnd(i, 9) * 180)}deg${i % 3 === 0 ? ';border-radius:50%' : ''}"></i>`;
  }).join('');
}

function overlay() {
  if (!showing) return '';
  if (!queue.length || !S().profile?.done) { showing = false; animated = null; return ''; }
  const x = itemFor(queue[0]);
  if (!x) { queue.shift(); return overlay(); }
  const esc = ctx.esc;
  const more = queue.length - 1;
  // Посторонний render (тема, полночь, другой модуль) не должен заново запускать появление и конфетти
  const again = animated === x.a.id;
  animated = x.a.id;
  return `<div class="ach-ov${again ? ' again' : ''}" role="dialog" aria-modal="true" aria-label="Новое достижение">
    <div class="ach-ov-bg" data-act="achClose"></div>
    <div class="ach-ov-card ach-t-${x.a.tier}">
      <div class="ach-ov-kicker">${ctx.icon('spark', 'sm')}Новое достижение</div>
      <div class="ach-ov-med">${medal({ ...x, earned: x.earned || todayKey() }, { size: null })}</div>
      <span class="ach-tier ach-t-${x.a.tier}">${TIERS[x.a.tier]}</span>
      <div class="h1 ach-ov-title">${esc(x.title)}</div>
      <div class="sub">${esc(x.desc)}</div>
      <button class="btn block ach-ov-btn" data-act="achClose">${more ? `Круто! · ещё ${more}` : 'Круто!'}</button>
    </div>
    <div class="ach-confetti" aria-hidden="true">${confetti()}</div>
  </div>`;
}

// Праздник — только когда на экране нет шторки, таймера отдыха и активной тренировки
function blocked(root) {
  return !!root?.querySelector('.sheet, .rest') || ctx.current?.()?.name === 'session';
}

export default {
  id: 'achievements',
  keys: ['ach', 'stats'],

  screens: { achHome },
  sheets: { achDetail },

  actions: {
    achOpen: ({ id }) => ctx.openSheet('achDetail', { id }),
    achClose: () => {
      queue.shift();
      animated = null;
      if (queue.length) ctx.haptic.ok();
      else {
        showing = false;
        ctx.haptic.tap();
      }
      ctx.render();
    },
  },

  slots: {
    'home.top': homeCard,
    'profile.links': profileLink,
    'done.extra': doneExtra,
    overlay,
  },

  on: {
    boot: () => {
      if (!S().profile?.done) return;
      const before = JSON.stringify([S().stats, S().ach]);
      refresh({ quiet: true });
      if (JSON.stringify([S().stats, S().ach]) !== before) ctx.render();
    },
    workout: (p) => {
      lastNew = refresh({ workout: p || {} });
    },
    water: () => refresh(),
    food: () => refresh(),
    weight: () => refresh(),
    measure: () => refresh(),
    photo: () => refresh(),
    profile: () => refresh(),
    reset: () => {
      queue = [];
      lastNew = [];
      showing = false;
      pending = false;
      animated = null;
    },
  },

  unmount() {
    gid = 0;
  },

  mount(root) {
    if (showing || pending || !queue.length || !S().profile?.done || blocked(root)) return;
    // Один отложенный render с флагом показа: mount вызывается внутри render, поэтому не
    // перерисовываем синхронно; повторный mount уже видит showing/pending — цикла нет.
    pending = true;
    setTimeout(() => {
      pending = false;
      const app = document.getElementById('app');
      if (showing || !queue.length || blocked(app)) return;
      // Подсказка ядра («Норма воды выполнена!») легла бы поверх окна — окно и так сообщает об успехе
      document.querySelector('.toast')?.remove();
      showing = true;
      ctx.haptic.ok();
      ctx.render();
    }, 0);
  },
};
