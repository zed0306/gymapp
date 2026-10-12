import test from 'node:test';
import assert from 'node:assert/strict';
import { bmr, bmi, nutrition, waterNorm, levelFromExperience, weeksToTarget } from '../js/calc.js';

const man = { sex: 'm', age: 25, height: 180, weight: 80, lifestyle: 'office', goal: 'maintain', days: [1, 3, 5], level: 'beginner' };

test('Mifflin–St Jeor BMR', () => {
  assert.equal(bmr(man), 10 * 80 + 6.25 * 180 - 5 * 25 + 5);
  assert.equal(bmr({ ...man, sex: 'f' }), 10 * 80 + 6.25 * 180 - 5 * 25 - 161);
});

test('BMI', () => {
  assert.equal(bmi(man).toFixed(1), '24.7');
});

test('калории под цель', () => {
  const m = nutrition(man);
  const lose = nutrition({ ...man, goal: 'lose' });
  const gain = nutrition({ ...man, goal: 'gain' });
  assert.ok(lose.kcal < m.kcal && m.kcal < gain.kcal);
  assert.equal(lose.deltaPct, -20);
  assert.equal(gain.deltaPct, 15); // новичку +15%
  assert.equal(nutrition({ ...man, goal: 'gain', level: 'advanced' }).deltaPct, 10);
});

test('дефицит не опускается ниже BMR', () => {
  const p = { sex: 'f', age: 30, height: 160, weight: 50, lifestyle: 'office', goal: 'lose', days: [1], level: 'beginner' };
  assert.ok(nutrition(p).kcal >= Math.round(bmr(p) / 10) * 10 - 10);
});

test('БЖУ сходятся с калориями', () => {
  for (const goal of ['lose', 'maintain', 'gain']) {
    const n = nutrition({ ...man, goal });
    const sum = n.protein * 4 + n.fat * 9 + n.carbs * 4;
    assert.ok(Math.abs(sum - n.kcal) <= 12, `${goal}: ${sum} vs ${n.kcal}`);
  }
});

test('вода 30/40 мл на кг', () => {
  assert.equal(waterNorm(man, false), 2400);
  assert.equal(waterNorm(man, true), 3200);
  assert.equal(waterNorm({ ...man, weight: 200 }, true), 5000);
});

test('уровень по опыту', () => {
  assert.equal(levelFromExperience('none'), 'beginner');
  assert.equal(levelFromExperience('6m2y'), 'intermediate');
  assert.equal(levelFromExperience('gt2y'), 'advanced');
});

test('срок до цели', () => {
  assert.ok(weeksToTarget({ ...man, goal: 'lose', targetWeight: 75 }) > 0);
  assert.equal(weeksToTarget({ ...man, goal: 'lose', targetWeight: 85 }), null);
});
