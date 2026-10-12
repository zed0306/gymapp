// Все расчёты по телу и питанию.
// Источники формул — в README.md (раздел «Откуда цифры»).

export const ACTIVITY_BY_DAYS = { 0: 1.2, 1: 1.3, 2: 1.375, 3: 1.465, 4: 1.55, 5: 1.635, 6: 1.725, 7: 1.725 };
export const LIFESTYLE_BONUS = { office: 0, mixed: 0.075, physical: 0.15 };

export const GOALS = {
  lose: { title: 'Похудеть', kcalFactor: 0.8, proteinPerKg: 2.0, fatPerKg: 0.8 },
  maintain: { title: 'Поддерживать форму', kcalFactor: 1.0, proteinPerKg: 1.6, fatPerKg: 0.9 },
  gain: { title: 'Набрать массу', kcalFactor: 1.1, proteinPerKg: 1.8, fatPerKg: 1.0 },
};

export const LEVELS = {
  beginner: { title: 'Новичок', short: 'Новичок' },
  intermediate: { title: 'Средний уровень', short: 'Средний' },
  advanced: { title: 'Продвинутый', short: 'Профи' },
};

export const EXPERIENCE = {
  none: { title: 'Никогда не занимался(-ась)', hint: 'Или был очень долгий перерыв', level: 'beginner' },
  lt6m: { title: 'Меньше 6 месяцев', hint: 'Знаю базовые упражнения', level: 'beginner' },
  '6m2y': { title: 'От 6 месяцев до 2 лет', hint: 'Тренируюсь регулярно', level: 'intermediate' },
  gt2y: { title: 'Больше 2 лет', hint: 'Уверенно владею техникой', level: 'advanced' },
};

const round = (n, step = 1) => Math.round(n / step) * step;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function bmi(p) {
  const h = p.height / 100;
  return p.weight / (h * h);
}

// Классификация ВОЗ
export function bmiCategory(value) {
  if (value < 18.5) return { key: 'under', title: 'Недостаток веса' };
  if (value < 25) return { key: 'normal', title: 'Норма' };
  if (value < 30) return { key: 'over', title: 'Избыточный вес' };
  return { key: 'obese', title: 'Ожирение' };
}

// Mifflin–St Jeor (1990)
export function bmr(p) {
  const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
  return p.sex === 'f' ? base - 161 : base + 5;
}

export function activityFactor(p) {
  const days = (p.days || []).length;
  const f = (ACTIVITY_BY_DAYS[days] ?? 1.2) + (LIFESTYLE_BONUS[p.lifestyle] ?? 0);
  return clamp(f, 1.2, 1.9);
}

export function tdee(p) {
  return bmr(p) * activityFactor(p);
}

// Вес, от которого считаем белок и жир: при ИМТ > 27 берём вес при ИМТ 27,
// иначе у людей с большим весом получаются завышенные граммовки.
export function referenceWeight(p) {
  const h = p.height / 100;
  return Math.min(p.weight, 27 * h * h);
}

export function levelFromExperience(exp) {
  return EXPERIENCE[exp]?.level ?? 'beginner';
}

export function nutrition(p) {
  const goal = GOALS[p.goal] ?? GOALS.maintain;
  const base = bmr(p);
  const maintenance = tdee(p);
  let factor = goal.kcalFactor;
  // Новичкам при наборе можно чуть больше профицит — быстрее растут.
  if (p.goal === 'gain' && (p.level ?? 'beginner') === 'beginner') factor = 1.15;
  const minKcal = p.sex === 'f' ? 1200 : 1500;
  let kcal = maintenance * factor;
  if (p.goal === 'lose') kcal = Math.max(kcal, base, minKcal);
  kcal = round(kcal, 10);

  const ref = referenceWeight(p);
  const protein = round(ref * goal.proteinPerKg);
  let fat = ref * goal.fatPerKg;
  // жир — не меньше 20% и не больше 35% калорийности
  fat = clamp(fat, (kcal * 0.2) / 9, (kcal * 0.35) / 9);
  fat = round(fat);
  const carbs = Math.max(0, round((kcal - protein * 4 - fat * 9) / 4));
  const fiber = round((kcal / 1000) * 14);

  return {
    bmr: round(base),
    tdee: round(maintenance, 10),
    factor: activityFactor(p),
    kcal,
    protein,
    fat,
    carbs,
    fiber,
    deltaPct: Math.round((kcal / maintenance - 1) * 100),
  };
}

// 30 мл/кг в обычный день и 40 мл/кг в день тренировки
export function waterNorm(p, isTrainingDay) {
  const ml = p.weight * (isTrainingDay ? 40 : 30);
  return clamp(round(ml, 50), 1500, 5000);
}

// Примерный темп изменения веса, кг в неделю (1 кг жира ≈ 7700 ккал)
export function weeklyChange(p) {
  const n = nutrition(p);
  return ((n.kcal - n.tdee) * 7) / 7700;
}

export function weeksToTarget(p) {
  if (!p.targetWeight || p.goal === 'maintain') return null;
  const diff = p.targetWeight - p.weight;
  const perWeek = weeklyChange(p);
  if (!perWeek || Math.sign(diff) !== Math.sign(perWeek)) return null;
  return Math.ceil(Math.abs(diff / perWeek));
}

// Распределение калорий по приёмам пищи
export function mealSplit(kcal) {
  return [
    { title: 'Завтрак', pct: 25 },
    { title: 'Обед', pct: 35 },
    { title: 'Перекус', pct: 15 },
    { title: 'Ужин', pct: 25 },
  ].map((m) => ({ ...m, kcal: round((kcal * m.pct) / 100, 10) }));
}
