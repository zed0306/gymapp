// Генератор персональной программы тренировок.
// Схемы подходов/повторов — по ACSM Position Stand «Progression Models in Resistance
// Training» (2009): новичкам 8–12 повторов 2–3 раза в неделю, далее — периодизация
// и больше объёма; прогрессия нагрузки +2–10%, когда верх диапазона выполнен.

import { EXERCISES, EXERCISE_BY_ID } from './data/exercises.js';
import { bmi } from './calc.js';

const LEVEL_IDX = { beginner: 0, intermediate: 1, advanced: 2 };

// Слот: [паттерн, роль, мин. уровень]. Роль: main | comp | iso | core | cardio
const T = {
  FB_A: { title: 'Всё тело A', focus: 'Присед · жим · тяга сверху', slots: [['squat', 'main'], ['hpush', 'comp'], ['vpull', 'comp'], ['ham', 'iso'], ['triceps', 'iso'], ['lateral', 'iso', 1], ['core', 'core']] },
  FB_B: { title: 'Всё тело B', focus: 'Наклон · жим вверх · тяга', slots: [['hinge', 'main'], ['vpush', 'comp'], ['hpull', 'comp'], ['quad', 'iso'], ['biceps', 'iso'], ['calves', 'iso', 1], ['core', 'core']] },
  FB_C: { title: 'Всё тело C', focus: 'Ноги · наклонный жим · спина', slots: [['squat', 'comp'], ['ipush', 'comp'], ['vpull', 'comp'], ['glutes', 'iso'], ['lateral', 'iso'], ['reardelt', 'iso', 1], ['core', 'core']] },
  UP_A: { title: 'Верх тела A', focus: 'Грудь · спина · плечи · руки', slots: [['hpush', 'main'], ['hpull', 'comp'], ['vpush', 'comp'], ['vpull', 'comp'], ['lateral', 'iso', 1], ['biceps', 'iso'], ['triceps', 'iso'], ['fly', 'iso', 2]] },
  LO_A: { title: 'Низ тела A', focus: 'Квадрицепсы · задняя цепь', slots: [['squat', 'main'], ['hinge', 'comp'], ['lunge', 'comp', 1], ['quad', 'iso'], ['ham', 'iso'], ['calves', 'iso'], ['core', 'core']] },
  UP_B: { title: 'Верх тела B', focus: 'Верх груди · спина · дельты', slots: [['ipush', 'main'], ['vpull', 'comp'], ['vpush', 'comp'], ['hpull', 'comp'], ['reardelt', 'iso', 1], ['triceps', 'iso'], ['biceps', 'iso'], ['lateral', 'iso', 2]] },
  LO_B: { title: 'Низ тела B', focus: 'Ягодицы · бицепс бедра', slots: [['hinge', 'main'], ['squat', 'comp'], ['glutes', 'comp'], ['ham', 'iso'], ['quad', 'iso', 1], ['calves', 'iso'], ['core', 'core']] },
  PUSH: { title: 'Жимы', focus: 'Грудь · плечи · трицепс', slots: [['hpush', 'main'], ['ipush', 'comp'], ['vpush', 'comp'], ['fly', 'iso'], ['lateral', 'iso'], ['triceps', 'iso'], ['triceps', 'iso', 2]] },
  PULL: { title: 'Тяги', focus: 'Спина · задняя дельта · бицепс', slots: [['vpull', 'main'], ['hpull', 'comp'], ['hpull', 'comp', 1], ['reardelt', 'iso'], ['biceps', 'iso'], ['biceps', 'iso', 2], ['core', 'core']] },
  LEGS: { title: 'Ноги', focus: 'Квадрицепсы · ягодицы · икры', slots: [['squat', 'main'], ['hinge', 'comp'], ['lunge', 'comp'], ['quad', 'iso'], ['ham', 'iso'], ['calves', 'iso'], ['glutes', 'iso', 2]] },
  CARDIO: { title: 'Кардио и кор', focus: 'Выносливость · восстановление', slots: [['cardio', 'cardio'], ['core', 'core'], ['core', 'core']] },
};

export const TEMPLATES = T;

export function splitFor(level, nDays) {
  const lv = LEVEL_IDX[level] ?? 0;
  const n = Math.max(1, Math.min(7, nDays));
  if (n === 1) return ['FB_A'];
  if (n === 2) return ['FB_A', 'FB_B'];
  if (n === 3) return lv === 2 ? ['PUSH', 'PULL', 'LEGS'] : ['FB_A', 'FB_B', 'FB_C'];
  if (n === 4) return ['UP_A', 'LO_A', 'UP_B', 'LO_B'];
  if (n === 5) return lv === 0 ? ['UP_A', 'LO_A', 'CARDIO', 'UP_B', 'LO_B'] : ['UP_A', 'LO_A', 'PUSH', 'PULL', 'LEGS'];
  const six = lv === 0 ? ['UP_A', 'LO_A', 'CARDIO', 'UP_B', 'LO_B', 'CARDIO'] : ['PUSH', 'PULL', 'LEGS', 'PUSH', 'PULL', 'LEGS'];
  return n === 6 ? six : [...six, 'CARDIO'];
}

export function splitName(keys) {
  const set = new Set(keys);
  if (set.has('PUSH') && set.has('UP_A')) return 'Верх/Низ + Жимы/Тяги/Ноги';
  if (set.has('PUSH')) return 'Жимы / Тяги / Ноги';
  if (set.has('UP_A')) return 'Верх / Низ';
  return 'Всё тело (фулбади)';
}

export function hasEquipment(ex, owned) {
  return ex.eq.every((req) => (Array.isArray(req) ? req.some((r) => owned.has(r)) : owned.has(req)));
}

export function candidatesFor(pattern, profile) {
  const owned = new Set(profile.equipment || []);
  const lv = LEVEL_IDX[profile.level] ?? 0;
  const limits = new Set(profile.limits || []);
  return EXERCISES.filter(
    (ex) => ex.p.includes(pattern) && (ex.lvl ?? 0) <= lv && hasEquipment(ex, owned) && !ex.stress.some((s) => limits.has(s)),
  );
}

function score(ex, profile, usage) {
  const lv = LEVEL_IDX[profile.level] ?? 0;
  let s = ex.pref[lv];
  // Новичкам с большим весом или 50+ — тренажёры безопаснее свободных весов
  const cautious = lv === 0 && (profile.age >= 50 || bmi(profile) >= 30);
  if (cautious && ex.stress.length) s -= 3;
  // Разнообразие: каждое повторное использование за неделю снижает приоритет
  s -= 2 * (usage[ex.id] || 0);
  return s;
}

// Подходы × повторы × отдых
export function scheme(profile, role, ex) {
  const lv = LEVEL_IDX[profile.level] ?? 0;
  const goal = profile.goal;
  const unit = ex.unit || 'reps';

  if (unit === 'min') {
    const mins = role === 'cardio' ? [30, 40] : goal === 'lose' ? [20, 25] : goal === 'maintain' ? [10, 15] : [5, 10];
    return { sets: 1, min: mins[0], max: mins[1], unit, rest: 0 };
  }
  if (unit === 'sec') {
    const secs = [[30, 40], [40, 60], [60, 90]][lv];
    return { sets: 3, min: secs[0], max: secs[1], unit, rest: 45 };
  }

  const table = {
    main: [{ sets: 3, min: 8, max: 12, rest: 90 }, { sets: 4, min: 6, max: 10, rest: 120 }, { sets: 4, min: 5, max: 8, rest: 180 }],
    comp: [{ sets: 3, min: 8, max: 12, rest: 90 }, { sets: 3, min: 8, max: 12, rest: 90 }, { sets: 4, min: 6, max: 10, rest: 120 }],
    iso: [{ sets: 2, min: 12, max: 15, rest: 60 }, { sets: 3, min: 10, max: 15, rest: 60 }, { sets: 3, min: 10, max: 15, rest: 75 }],
    core: [{ sets: 2, min: 12, max: 15, rest: 45 }, { sets: 3, min: 12, max: 15, rest: 45 }, { sets: 3, min: 15, max: 20, rest: 45 }],
  };
  // Базовое упражнение в «изолирующем» слоте (брусья, узкий жим) — по схеме базовых
  const row = role === 'iso' && ex.c ? 'comp' : role;
  const r = { ...(table[row] || table.comp)[lv], unit };
  // Упражнения с собственным весом — больше повторов
  if (!ex.eq.length && role !== 'core') Object.assign(r, { min: Math.max(r.min, 10), max: Math.max(r.max, 15) });
  if (ex.reps) Object.assign(r, { min: ex.reps[0], max: ex.reps[1] });
  // При похудении отдых короче — тренировка плотнее, вес оставляем рабочим
  if (goal === 'lose') r.rest = Math.max(45, Math.round((r.rest * 0.75) / 15) * 15);
  return r;
}

export function buildProgram(profile) {
  const days = [...(profile.days || [])].sort((a, b) => a - b);
  const keys = splitFor(profile.level, days.length || 3);
  const lv = LEVEL_IDX[profile.level] ?? 0;
  const usage = {};
  const swaps = profile.swaps || {};
  const seen = {};

  const workouts = keys.map((key, i) => {
    seen[key] = (seen[key] || 0) + 1;
    const uid = seen[key] > 1 ? `${key}_${seen[key]}` : key;
    const tpl = T[key];
    const used = new Set();
    const items = [];

    tpl.slots.forEach(([pattern, role, minLv = 0], slotIdx) => {
      if (lv < minLv) return;
      const cands = candidatesFor(pattern, profile).filter((ex) => !used.has(ex.id));
      if (!cands.length) return;
      const swapId = swaps[`${uid}:${slotIdx}`];
      let ex = swapId && cands.find((c) => c.id === swapId);
      if (!ex) ex = cands.reduce((best, c) => (score(c, profile, usage) > score(best, profile, usage) ? c : best));
      used.add(ex.id);
      usage[ex.id] = (usage[ex.id] || 0) + 1;
      items.push({ slot: slotIdx, pattern, role, ex, ...scheme(profile, role, ex) });
    });

    // Кардио в конце силовой тренировки — для похудения и поддержания
    if (key !== 'CARDIO' && profile.goal !== 'gain') {
      const cardio = candidatesFor('cardio', profile);
      if (cardio.length) {
        const ex = cardio.reduce((b, c) => (score(c, profile, {}) > score(b, profile, {}) ? c : b));
        items.push({ slot: 99, pattern: 'cardio', role: 'finisher', ex, ...scheme(profile, 'finisher', ex) });
      }
    }

    return { uid, key, title: tpl.title, focus: tpl.focus, weekday: days[i] ?? null, items };
  });

  return { name: splitName(keys), workouts, notes: programNotes(profile) };
}

export function programNotes(profile) {
  const notes = [
    'Разминка 5–10 минут: лёгкое кардио, суставная гимнастика и 1–2 лёгких подхода первого упражнения.',
    'Подбирай вес так, чтобы последние 1–2 повтора давались тяжело, но техника не ломалась.',
    'Сделал(а) верхнюю границу повторов во всех подходах — в следующий раз добавь вес: +2,5 кг на верх тела, +5 кг на ноги (гантели +1–2 кг).',
  ];
  if (profile.level !== 'beginner') notes.push('Раз в 6–8 недель делай разгрузочную неделю: те же упражнения, но вес −30–40%.');
  if (profile.age >= 50 || bmi(profile) >= 30) notes.push('Разминайся дольше (10 минут) и избегай прыжков — суставам так спокойнее.');
  if ((profile.limits || []).length) notes.push('Упражнения, нагружающие проблемные зоны, исключены. Если что-то болит — остановись и обратись к врачу.');
  if (profile.goal === 'lose') notes.push('Для похудения главное — дефицит калорий. Кардио после силовой помогает, но питание важнее.');
  if (profile.goal === 'gain') notes.push('Для набора массы важно есть свою норму каждый день и спать 7–9 часов.');
  return notes;
}

// Тренировка на конкретную дату по выбранным дням недели (1 = Пн … 7 = Вс)
export function workoutForDate(program, date = new Date()) {
  const wd = ((date.getDay() + 6) % 7) + 1;
  return program.workouts.find((w) => w.weekday === wd) || null;
}

// Шаг прогрессии для упражнения
export function progressionStep(ex) {
  if (ex.eq.includes('dumbbells') || ex.eq.includes('kettlebell')) return 1;
  return ex.legs && ex.c ? 5 : 2.5;
}

// Рекомендация веса на следующий раз по последнему результату
// last = { w, r: [повторы по подходам], fails: сколько тренировок подряд не добрал низ диапазона }
// Для гравитрона вес — это помощь, поэтому прогресс = уменьшение веса.
export function nextWeight(ex, item, last) {
  if (!last || !last.w) return null;
  const dir = ex.assist ? -1 : 1;
  const allTop = last.r.length >= item.sets && last.r.every((r) => r >= item.max);
  const round = (w) => Math.max(0, Math.round(w * 2) / 2);
  if (allTop) return { w: round(last.w + dir * progressionStep(ex)), why: 'up' };
  if ((last.fails || 0) >= 2) return { w: round(last.w * (ex.assist ? 1.1 : 0.9)), why: 'down' };
  return { w: last.w, why: 'keep' };
}

export { EXERCISE_BY_ID };
