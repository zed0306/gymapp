import test from 'node:test';
import assert from 'node:assert/strict';
import mod, {
  workoutStreak, weekStreak, weekChain, waterStreak, maxGap, longestWorkoutStreak, longestWeekStreak, longestWaterStreak,
  statsFromHist, updateStreaks, withStart, buildState, runCheck, ACHIEVEMENTS, fitAch, fitStats,
  dayNum, shownValue, progText, gapRule, weekRule,
} from '../js/features/achievements.js';
import { ctx } from '../js/core.js';
import { fmt, plural } from '../js/ui.js';
import { waterNorm } from '../js/calc.js';

const A = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
const check = (id, state) => runCheck(A[id], state);
const base = {
  workouts: 0, volume: 0, prs: 0, bestStreak: 0, bestWeekStreak: 0, bestWaterStreak: 0,
  bench: 0, squat: 0, deadlift: 0, weight: 80, startWeight: 80, goal: 'maintain', target: 0,
  foodDays: 0, measures: 0, photos: 0,
};

// ── workoutStreak ─────────────────────────────────────
test('maxGap = ceil(7 / дней в неделю) + 1', () => {
  assert.equal(maxGap(3), 4);
  assert.equal(maxGap(2), 5);
  assert.equal(maxGap(4), 3);
  assert.equal(maxGap(7), 2);
  assert.equal(maxGap(1), 8);
  assert.equal(maxGap(0), 4); // нет данных — как 3 раза в неделю
});

test('workoutStreak: пустая история', () => {
  assert.equal(workoutStreak([], 3, '2026-10-12'), 0);
  assert.equal(workoutStreak(undefined, 3, '2026-10-12'), 0);
});

test('workoutStreak: тренировка сегодня и вчера', () => {
  assert.equal(workoutStreak(['2026-10-12'], 3, '2026-10-12'), 1);
  assert.equal(workoutStreak(['2026-10-11'], 3, '2026-10-12'), 1);
  assert.equal(workoutStreak(['2026-10-11', '2026-10-12'], 3, '2026-10-12'), 2);
});

test('workoutStreak: Пн/Ср/Пт при плане 3 раза — серия без пропусков', () => {
  const d = ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09'];
  assert.equal(workoutStreak(d, 3, '2026-10-09'), 6);
  // разрыв Пт → Вт = 4 дня — ещё в серии
  assert.equal(workoutStreak([...d, '2026-10-13'], 3, '2026-10-13'), 7);
});

test('workoutStreak: разрыв больше maxGap обрывает цепочку', () => {
  const d = ['2026-09-20', '2026-09-22', '2026-10-01', '2026-10-03'];
  assert.equal(workoutStreak(d, 3, '2026-10-03'), 2);
});

test('workoutStreak: серия гаснет, если с последней тренировки прошло больше maxGap', () => {
  const d = ['2026-10-01', '2026-10-03'];
  assert.equal(workoutStreak(d, 3, '2026-10-07'), 2); // 4 дня — ещё жива
  assert.equal(workoutStreak(d, 3, '2026-10-08'), 0); // 5 дней — сгорела
  assert.equal(workoutStreak(d, 7, '2026-10-05'), 2);
  assert.equal(workoutStreak(d, 7, '2026-10-06'), 0);
});

test('workoutStreak: несколько тренировок в день считаются одной', () => {
  const d = ['2026-10-10', '2026-10-10', '2026-10-12', '2026-10-12', '2026-10-12'];
  assert.equal(workoutStreak(d, 3, '2026-10-12'), 2);
});

test('workoutStreak: порядок дат не важен, разные планы', () => {
  const d = ['2026-10-12', '2026-10-05', '2026-10-08'];
  assert.equal(workoutStreak(d, 3, '2026-10-12'), 3); // разрывы 3 и 4 ≤ 4
  assert.equal(workoutStreak(d, 5, '2026-10-12'), 1); // maxGap 3: 08 → 12 = 4 > 3
  assert.equal(workoutStreak(d, 2, '2026-10-12'), 3);
});

test('longestWorkoutStreak — самая длинная цепочка в истории', () => {
  const d = ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07', '2026-09-20', '2026-09-22'];
  assert.equal(longestWorkoutStreak(d, 3), 4);
  assert.equal(longestWorkoutStreak([], 3), 0);
});

// ── weekStreak ────────────────────────────────────────
test('weekStreak: пусто', () => {
  assert.equal(weekStreak([], 3, '2026-10-12'), 0);
});

test('weekStreak: текущая неделя не обрывает серию, выполненная — засчитывается', () => {
  // 2026-09-28 Пн … 2026-10-04 Вс; 2026-10-05 Пн … 2026-10-11 Вс; 2026-10-12 Пн
  const prev = ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09'];
  assert.equal(weekStreak(prev, 3, '2026-10-12'), 2); // текущая пуста — не обрывает
  assert.equal(weekStreak([...prev, '2026-10-12'], 3, '2026-10-12'), 2);
  const full = [...prev, '2026-10-12', '2026-10-13', '2026-10-14'];
  assert.equal(weekStreak(full, 3, '2026-10-14'), 3); // текущая выполнена
});

test('weekStreak: смена недели — Вс и Пн в разных неделях', () => {
  const d = ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'];
  assert.equal(weekStreak(d, 3, '2026-10-12'), 1); // Пт+Сб+Вс = прошлая неделя
  assert.equal(weekStreak(d, 4, '2026-10-12'), 0);
});

test('weekStreak: пропущенная неделя обрывает серию', () => {
  const d = ['2026-09-21', '2026-09-23', '2026-09-25', '2026-10-05', '2026-10-07', '2026-10-09'];
  assert.equal(weekStreak(d, 3, '2026-10-12'), 1);
  assert.equal(longestWeekStreak(d, 3), 1);
});

test('weekStreak: несколько тренировок в один день — один день недели', () => {
  const d = ['2026-10-05', '2026-10-05', '2026-10-05'];
  assert.equal(weekStreak(d, 3, '2026-10-12'), 0);
  assert.equal(weekStreak(d, 1, '2026-10-12'), 1);
});

test('weekStreak: разные daysPerWeek', () => {
  const d = ['2026-09-29', '2026-10-01', '2026-10-06', '2026-10-08'];
  assert.equal(weekStreak(d, 2, '2026-10-12'), 2);
  assert.equal(weekStreak(d, 3, '2026-10-12'), 0);
  assert.equal(weekStreak(d, 1, '2026-10-12'), 2);
});

// ── waterStreak ───────────────────────────────────────
const norm = () => 2000;
const log = (days) => Object.fromEntries(days.map(([k, ml]) => [k, [[ml, 600]]]));

test('waterStreak: пусто', () => {
  assert.equal(waterStreak({}, norm, '2026-10-12'), 0);
  assert.equal(waterStreak(undefined, norm, '2026-10-12'), 0);
});

test('waterStreak: сегодня засчитывается, только если норма уже выполнена', () => {
  const w = log([['2026-10-10', 2100], ['2026-10-11', 2000], ['2026-10-12', 900]]);
  assert.equal(waterStreak(w, norm, '2026-10-12'), 2); // считаем со вчера
  w['2026-10-12'].push([1200, 900]);
  assert.equal(waterStreak(w, norm, '2026-10-12'), 3);
});

test('waterStreak: разрыв и недобор обрывают серию', () => {
  const w = log([['2026-10-08', 2500], ['2026-10-10', 2500], ['2026-10-11', 1999]]);
  assert.equal(waterStreak(w, norm, '2026-10-12'), 0);
  assert.equal(waterStreak(w, norm, '2026-10-11'), 1);
});

test('waterStreak: норма зависит от дня', () => {
  const w = log([['2026-10-10', 2500], ['2026-10-11', 2500]]);
  const byDay = (k) => (k === '2026-10-10' ? 3000 : 2000);
  assert.equal(waterStreak(w, byDay, '2026-10-12'), 1);
  assert.equal(longestWaterStreak(w, norm), 2);
});

// ── stats ─────────────────────────────────────────────
test('statsFromHist: инициализация из истории', () => {
  const hist = [
    ['2026-10-01', 'Фулбади A', 50, 3200, 12],
    ['2026-10-03', 'Фулбади B', 55, 4100.4, 14],
    ['2026-10-05', 'Фулбади A', 48, 0, 10],
  ];
  const st = statsFromHist(hist, 3);
  assert.equal(st.workouts, 3);
  assert.equal(st.volume, 7300);
  assert.equal(st.prs, 0);
  assert.equal(st.firstDate, '2026-10-01');
  assert.equal(st.bestStreak, 3);
  assert.equal(st.bestWeekStreak, 0); // 01–03 в одной неделе (2 дня), 05 — в следующей
  assert.deepEqual(statsFromHist(null), { workouts: 0, volume: 0, prs: 0, firstDate: null, streak: 0, bestStreak: 0, weekStreak: 0, bestWeekStreak: 0, bestWaterStreak: 0 });
  assert.equal(statsFromHist([['bad'], null, ['2026-10-01', 'x', 1, 100, 1]]).workouts, 1);
});

test('updateStreaks: текущие и лучшие серии', () => {
  const hist = [['2026-10-05', 'A', 1, 100, 1], ['2026-10-07', 'B', 1, 100, 1], ['2026-10-09', 'A', 1, 100, 1]];
  const st = updateStreaks({ bestStreak: 5 }, { hist, water: {}, daysPerWeek: 3, normFn: norm, today: '2026-10-12' });
  assert.equal(st.streak, 3);
  assert.equal(st.bestStreak, 5);
  assert.equal(st.weekStreak, 1);
  assert.equal(st.bestWeekStreak, 1);
  assert.equal(st.waterStreak, 0);
});

test('updateStreaks: обрезанная история (60) продолжает сохранённую серию', () => {
  const hist = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 7, 1) + i * 2 * 864e5).toISOString().slice(0, 10);
    hist.push([d, 'A', 1, 100, 1]);
  }
  const today = hist[59][0];
  // до этой тренировки серия была 75, последняя засчитанная — hist[58]
  const st = updateStreaks({ streak: 75, streakEnd: hist[58][0] }, { hist, water: {}, daysPerWeek: 3, normFn: norm, today });
  assert.equal(st.streak, 76);
  assert.equal(st.streakEnd, today);
  // повторный пересчёт в тот же день не накручивает
  assert.equal(updateStreaks(st, { hist, water: {}, daysPerWeek: 3, normFn: norm, today }).streak, 76);
});

// ── «Замороженная» часть серий: смена плана/веса не обнуляет задним числом ──
test('workoutStreak: сохранённая часть серии не перепроверяется по новому плану', () => {
  // Пн/Ср/Пт/Вт: разрыв Пт → Вт = 4 дня — при 3 разах в неделю это серия, при 4 (maxGap 3) — нет
  const d = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-13'];
  assert.equal(workoutStreak(d, 3, '2026-10-13'), 4);
  assert.equal(workoutStreak(d, 4, '2026-10-13'), 1);
  const frozen = { end: dayNum('2026-10-13'), count: 4 };
  assert.equal(workoutStreak(d, 4, '2026-10-13', frozen), 4);
  // новая тренировка после смены плана проверяется уже по новому правилу
  assert.equal(workoutStreak([...d, '2026-10-15'], 4, '2026-10-15', frozen), 5);
  assert.equal(workoutStreak([...d, '2026-10-17'], 4, '2026-10-17', frozen), 1); // 13 → 17 = 4 > 3
  // серия сгорела — сохранённое значение не воскрешает её
  assert.equal(workoutStreak(d, 4, '2026-10-20', frozen), 0);
});

test('weekStreak: смена плана не обнуляет уже засчитанные недели, текущая проверяется заново', () => {
  const d = [];
  for (let n = 42; n >= 0; n--) {
    const k = new Date(Date.UTC(2026, 9, 12) - n * 864e5).toISOString().slice(0, 10);
    if ([1, 3, 5].includes(((new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7) + 1)) d.push(k);
  }
  const today = '2026-10-12'; // Пн, на этой неделе пока 1 тренировка
  const ch = weekChain(d, 3, today);
  assert.deepEqual([ch.count, weekStreak(d, 3, today)], [6, 6]);
  assert.equal(weekStreak(d, 5, today), 0); // без заморозки план 5 дней обнулил бы серию
  const frozen = { end: ch.end, count: ch.count };
  assert.equal(weekStreak(d, 5, today, frozen), 6);
  // неделя, засчитанная по старому плану, но текущая — пересчитывается
  const fri = '2026-10-16';
  const full = [...d, '2026-10-14', fri];
  const now = weekChain(full, 3, fri);
  assert.equal(now.count, 7);
  assert.equal(weekStreak(full, 5, fri, { end: now.end, count: now.count }), 6);
});

test('waterStreak: засчитанные дни не пересчитываются по новой норме, сегодня — всегда', () => {
  const w = log([['2026-10-09', 2000], ['2026-10-10', 2000], ['2026-10-11', 2000], ['2026-10-12', 2000]]);
  assert.equal(waterStreak(w, norm, '2026-10-12'), 4);
  const higher = () => 2100; // вес вырос — норма выше
  assert.equal(waterStreak(w, higher, '2026-10-12'), 0);
  const frozen = { end: dayNum('2026-10-12'), count: 4 };
  assert.equal(waterStreak(w, higher, '2026-10-12', frozen), 3); // сегодня по новой норме не выполнено
  assert.equal(waterStreak(w, norm, '2026-10-12', frozen), 4);
  // дни, выпавшие из S.water (хранится 14), остаются в серии
  const only = log([['2026-10-12', 2000]]);
  assert.equal(waterStreak(only, norm, '2026-10-12', { end: dayNum('2026-10-11'), count: 30 }), 31);
  // пропущенный день после сохранённой серии обрывает её
  assert.equal(waterStreak(only, norm, '2026-10-12', { end: dayNum('2026-10-10'), count: 30 }), 1);
});

// ── достижения ────────────────────────────────────────
test('каталог: ~30 достижений, у всех есть уровень, иконка и check', () => {
  assert.ok(ACHIEVEMENTS.length >= 28 && ACHIEVEMENTS.length <= 40);
  const ids = new Set();
  for (const a of ACHIEVEMENTS) {
    assert.ok(!ids.has(a.id), a.id);
    ids.add(a.id);
    assert.ok(['bronze', 'silver', 'gold', 'platinum'].includes(a.tier), a.id);
    assert.equal(typeof a.check, 'function');
    const r = runCheck(a, base);
    assert.equal(typeof r.done, 'boolean');
    assert.ok(r.goal > 0);
  }
});

test('check: число тренировок', () => {
  assert.deepEqual(check('w10', { ...base, workouts: 7 }), { done: false, value: 7, goal: 10, hint: '' });
  assert.equal(check('w10', { ...base, workouts: 10 }).done, true);
  assert.equal(check('w10', { ...base, workouts: 12 }).value, 10);
  assert.equal(check('w1', { ...base, workouts: 1 }).done, true);
});

test('check: серии', () => {
  assert.equal(check('s3', { ...base, bestStreak: 2 }).done, false);
  assert.equal(check('s3', { ...base, bestStreak: 3 }).done, true);
  assert.equal(check('wk4', { ...base, bestWeekStreak: 4 }).done, true);
  assert.equal(check('h7', { ...base, bestWaterStreak: 6 }).done, false);
});

test('check: сила — Клуб 100 и жим собственного веса', () => {
  assert.equal(check('b100', { ...base, bench: 97.5 }).done, false);
  assert.equal(check('b100', { ...base, bench: 100 }).done, true);
  assert.equal(check('bbw', { ...base, bench: 80, weight: 82 }).done, false);
  assert.equal(check('bbw', { ...base, bench: 82.5, weight: 82 }).done, true);
  assert.equal(check('bbw', { ...base, bench: 50, weight: 0 }).done, false);
  assert.equal(check('dl180', { ...base, deadlift: 180 }).done, true);
});

test('check: объём в тоннах', () => {
  const r = check('v10', { ...base, volume: 7300 });
  assert.equal(r.done, false);
  assert.equal(r.value, 7300);
  assert.equal(r.goal, 10000);
  assert.equal(check('v10', { ...base, volume: 10000 }).done, true);
});

test('check: цель по весу — с нужной стороны', () => {
  const lose = { ...base, goal: 'lose', startWeight: 90, target: 80 };
  assert.equal(check('goal', { ...lose, weight: 85 }).done, false);
  assert.equal(check('goal', { ...lose, weight: 85 }).value, 5);
  assert.equal(check('goal', { ...lose, weight: 79.8 }).done, true);
  const gain = { ...base, goal: 'gain', startWeight: 70, target: 75 };
  assert.equal(check('goal', { ...gain, weight: 74 }).done, false);
  assert.equal(check('goal', { ...gain, weight: 75 }).done, true);
  assert.ok(check('goal', { ...base }).hint); // нет желаемого веса — подсказка
});

test('check: −5 / +5 кг от стартового веса', () => {
  assert.equal(check('kg5', { ...base, goal: 'lose', startWeight: 90, weight: 85.5 }).done, false);
  assert.equal(check('kg5', { ...base, goal: 'lose', startWeight: 90, weight: 85 }).done, true);
  assert.equal(check('kg5', { ...base, goal: 'gain', startWeight: 70, weight: 75 }).done, true);
  assert.equal(check('kg5', { ...base, goal: 'gain', startWeight: 70, weight: 65 }).done, false);
  assert.equal(check('kg5', { ...base, goal: 'maintain', startWeight: 90, weight: 80 }).done, false);
});

test('buildState: данные из S', () => {
  const S = {
    stats: { workouts: 12, volume: 23000, prs: 3, bestStreak: 4, streak: 6 },
    lifts: { bb_bench: { w: 60, best: 70 }, deadlift: { w: 100 } },
    profile: { weight: 81, goal: 'lose', targetWeight: 75 },
    weights: [['2026-09-01', 84], ['2026-10-01', 81]],
    foodHist: { '2026-10-09': [1800, 1, 1, 1], '2026-10-10': [2000, 1, 1, 1] },
    food: { d: '2026-10-12', items: [['Гречка', 100, 110, 4, 1, 21]] },
    measures: [[1]], photos: [],
  };
  const s = buildState(S, '2026-10-12');
  assert.equal(s.bench, 70);
  assert.equal(s.deadlift, 100);
  assert.equal(s.squat, 0);
  assert.equal(s.bestStreak, 6);
  assert.equal(s.startWeight, 84);
  assert.equal(s.weight, 81);
  assert.equal(s.foodDays, 3);
  assert.equal(s.measures, 1);
  assert.equal(s.photos, 0);
  assert.equal(check('m1', s).done, true);
  assert.equal(check('p1', s).done, false);
});

// ── лимит 4096 ────────────────────────────────────────
test('fitAch / fitStats: значения ≤ 4096 символов JSON', () => {
  const all = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, '2026-10-12']));
  assert.ok(JSON.stringify(fitAch(all)).length <= 4096);
  assert.equal(Object.keys(fitAch(all)).length, ACHIEVEMENTS.length);
  const huge = { ...all };
  for (let i = 0; i < 400; i++) huge[`old${i}`] = '2020-01-01';
  const fitted = fitAch(huge);
  assert.ok(JSON.stringify(fitted).length <= 4096);
  for (const a of ACHIEVEMENTS) assert.equal(fitted[a.id], '2026-10-12'); // известные сохранились
  assert.equal(fitAch({ w1: 'bad', '<x>': '2026-10-12' }).w1, undefined);
  const st = fitStats({ workouts: 3.4, volume: -5, firstDate: 'x', junk: 'a'.repeat(5000) });
  assert.deepEqual(st, { workouts: 3, volume: 0, firstDate: null });
});

test('fitStats: стартовый вес — с точностью 0,1, даты концов серий сохраняются', () => {
  const st = fitStats({ startWeight: 82.34, startDate: '2026-10-01', streakEnd: '2026-10-12', weekEnd: '2026-10-05', waterEnd: 'bad', streak: 2 });
  assert.deepEqual(st, { firstDate: null, streak: 2, streakEnd: '2026-10-12', weekEnd: '2026-10-05', startWeight: 82.3, startDate: '2026-10-01' });
  assert.equal(fitStats({ startWeight: -1 }).startWeight, undefined);
});

// ── Вес: дробные числа и стартовый вес ────────────────
test('check: ровно 5,0 кг засчитывается (без ошибки округления дробей)', () => {
  let missed = 0;
  for (let i = 500; i <= 1500; i++) {
    const s0 = i / 10;
    const gain = { ...base, goal: 'gain', startWeight: s0, weight: +(s0 + 5).toFixed(1) };
    const lose = { ...base, goal: 'lose', startWeight: s0, weight: +(s0 - 5).toFixed(1) };
    if (!check('kg5', gain).done || !check('kg5', lose).done) missed += 1;
  }
  assert.equal(missed, 0);
  assert.equal(check('kg5', { ...base, goal: 'gain', startWeight: 59.1, weight: 64.1 }).done, true);
  assert.equal(check('kg5', { ...base, goal: 'gain', startWeight: 59.1, weight: 64 }).done, false);
  assert.equal(check('goal', { ...base, goal: 'lose', startWeight: 80.3, target: 75.3, weight: 75.3 }).done, true);
});

test('withStart: стартовый вес фиксируется и не уплывает вместе с обрезкой S.weights', () => {
  const S = { profile: { weight: 82 }, weights: [['2026-10-01', 82]] };
  let st = withStart({}, S, '2026-10-01');
  assert.deepEqual([st.startWeight, st.startDate], [82, '2026-10-01']);
  // в день старта правка веса — это исправление анкеты, старт следует за ней
  st = withStart(st, { profile: { weight: 81.4 }, weights: [['2026-10-01', 81.4]] }, '2026-10-01');
  assert.equal(st.startWeight, 81.4);
  // на следующий день старт уже не меняется, даже если S.weights[0] другой
  st = withStart(st, { profile: { weight: 79 }, weights: [['2026-12-01', 80], ['2027-02-01', 79]] }, '2027-02-01');
  assert.equal(st.startWeight, 81.4);
  assert.equal(buildState({ stats: st, profile: { weight: 79 }, weights: [['2026-12-01', 80]] }, '2027-02-01').startWeight, 81.4);
  // без записей веса — вес из анкеты
  assert.equal(withStart({}, { profile: { weight: 70 } }, '2026-10-01').startWeight, 70);
});

// ── Показ прогресса и правила словами ─────────────────
test('progText: прогресс невыполненного округляется вниз', () => {
  ctx.fmt = fmt;
  ctx.plural = plural;
  const a = (id) => A[id];
  const t = (id, value) => progText({ a: a(id), r: runCheck(a(id), { ...base, volume: value }) });
  assert.equal(shownValue(a('v10'), 9960, true), 9.9);
  assert.equal(t('v10', 9960).replace(/\s/g, ' '), '9,9 / 10 т');
  assert.equal(t('v50', 49951).replace(/\s/g, ' '), '49,9 / 50 т');
  assert.equal(t('v10', 7300).replace(/\s/g, ' '), '7,3 / 10 т');
  assert.equal(t('v10', 12000).replace(/\s/g, ' '), '10 / 10 т');
  assert.equal(shownValue(a('b100'), 97.5, true), 97.5);
  assert.equal(shownValue(a('kg5'), 4.3, true), 4.3);
});

test('правила серий: правильные падежи', () => {
  ctx.plural = plural;
  assert.match(gapRule(3), /через 3 дня после предыдущей/);
  assert.match(gapRule(4), /через 4 дня/);
  assert.match(gapRule(5), /через 5 дней/);
  assert.match(gapRule(2), /через 2 дня/);
  assert.match(weekRule(3), /в 3 разных дня$/);
  assert.match(weekRule(5), /в 5 разных дней$/);
  assert.match(weekRule(1), /в 1 день$/);
});

// ── Сквозные сценарии через обработчики событий модуля ─
const keyOf = (start, n) => new Date(dayNum(start) * 864e5 + n * 864e5).toISOString().slice(0, 10);
const wdOf = (k) => ((new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
function useCtx(S, today) {
  const env = { S, today };
  Object.assign(ctx, {
    S: () => env.S,
    save: (k, v) => { env.S[k] = v; },
    program: () => null,
    dkey: () => env.today,
    parseKey: (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); },
    isTrainingDay: () => (env.S.profile.days || []).includes(wdOf(env.today)),
    render() {}, haptic: { ok() {}, tap() {} }, fmt, plural,
  });
  mod.on.reset();
  return env;
}

test('сценарий: набор 0,25 кг/нед, ежедневное взвешивание год — «Плюс 5 кг» получено', () => {
  const start = '2026-01-01';
  const env = useCtx({ profile: { done: true, weight: 70, goal: 'gain', targetWeight: 85, days: [1, 3, 5] }, hist: [], water: {}, weights: [[start, 70]] }, start);
  for (let day = 0; day <= 365; day++) {
    env.today = keyOf(start, day);
    const kg = +(70 + (day / 7) * 0.25).toFixed(1);
    env.S.weights = [...env.S.weights.filter((w) => w[0] !== env.today), [env.today, kg]].slice(-120); // как saveWeight
    env.S.profile = { ...env.S.profile, weight: kg };
    mod.on.weight({ kg });
  }
  assert.equal(env.S.weights.length, 120);
  assert.equal(env.S.stats.startWeight, 70);
  assert.ok(env.S.ach.kg5, '«Плюс 5 кг» должно быть получено');
  assert.ok(env.S.ach.kg5 <= keyOf(start, 141), env.S.ach.kg5); // +5 кг — на 140-й день
  const goal = runCheck(A.goal, buildState(env.S, env.today));
  assert.equal(goal.goal, 15); // 70 → 85: знаменатель не сжимается
});

test('сценарий: правка веса в день анкеты не даёт ложного «Минус 5 кг»', () => {
  const d0 = '2026-10-01';
  const env = useCtx({ profile: { done: true, weight: 92, goal: 'lose', targetWeight: 75, days: [1, 3, 5] }, hist: [], water: {}, weights: [[d0, 92]] }, d0);
  mod.on.boot();
  env.S.weights = [[d0, 82]];
  env.S.profile = { ...env.S.profile, weight: 82 };
  mod.on.weight({ kg: 82 });
  assert.equal(env.S.stats.startWeight, 82);
  assert.equal(env.S.ach.kg5, undefined);
});

test('сценарий: смена дней плана и веса не обнуляет серию воды задним числом', () => {
  const today = '2026-10-12'; // Пн
  const env = useCtx({ profile: { done: true, weight: 82, goal: 'lose', days: [1, 3, 5] }, hist: [], water: {}, weights: [['2026-09-01', 82]] }, today);
  for (let i = 13; i >= 0; i--) {
    const k = keyOf(today, -i);
    env.S.water[k] = [[waterNorm(env.S.profile, env.S.profile.days.includes(wdOf(k))), 600]];
  }
  mod.on.water({});
  assert.equal(env.S.stats.waterStreak, 14);
  env.S.profile = { ...env.S.profile, days: [2, 4, 6] };
  mod.on.profile({});
  assert.equal(env.S.stats.waterStreak, 14); // сегодня по новому плану — день отдыха, норма ниже
  env.S.profile = { ...env.S.profile, days: [1, 3, 5], weight: 84 }; // норма дня тренировки 3300 → 3350
  mod.on.weight({ kg: 84 });
  // прошлые 13 дней не пересчитываются; сегодня по новой норме ещё не добрал
  assert.equal(env.S.stats.waterStreak, 13);
  assert.equal(env.S.stats.bestWaterStreak, 14);
  env.S.water[today].push([100, 700]);
  mod.on.water({});
  assert.equal(env.S.stats.waterStreak, 14);
  // назавтра серия продолжается, хотя вчерашние записи по старой норме
  env.today = keyOf(today, 1);
  env.S.water[env.today] = [[5000, 600]];
  mod.on.water({});
  assert.equal(env.S.stats.waterStreak, 15);
});

test('сценарий: смена плана не обнуляет серию недель', () => {
  const today = '2026-10-12';
  const hist = [];
  for (let n = 42; n >= 0; n--) {
    const k = keyOf(today, -n);
    if ([1, 3, 5].includes(wdOf(k))) hist.push([k, 'A', 50, 3000, 15]);
  }
  const env = useCtx({ profile: { done: true, weight: 82, goal: 'lose', days: [1, 3, 5] }, hist, water: {}, weights: [] }, today);
  mod.on.boot();
  assert.equal(env.S.stats.weekStreak, 6);
  env.S.profile = { ...env.S.profile, days: [1, 2, 3, 4, 5] };
  mod.on.profile({});
  assert.equal(env.S.stats.weekStreak, 6);
  assert.equal(env.S.stats.streak, 19);
});
