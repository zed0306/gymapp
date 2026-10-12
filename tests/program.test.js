import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram, splitFor, nextWeight, workoutForDate } from '../js/program.js';
import { EXERCISES, EXERCISE_BY_ID } from '../js/data/exercises.js';
import { EQUIPMENT, EQUIPMENT_PRESETS } from '../js/data/equipment.js';

const preset = (k) => EQUIPMENT_PRESETS.find((p) => p.key === k).ids;
const base = { sex: 'm', age: 25, height: 180, weight: 80, lifestyle: 'office', goal: 'maintain', limits: [] };

test('все упражнения ссылаются на существующие тренажёры', () => {
  const ids = new Set(EQUIPMENT.map((e) => e.id));
  for (const ex of EXERCISES) for (const req of ex.eq) for (const id of [req].flat()) assert.ok(ids.has(id), `${ex.id}: ${id}`);
});

test('сплит зависит от уровня и дней', () => {
  assert.deepEqual(splitFor('beginner', 3), ['FB_A', 'FB_B', 'FB_C']);
  assert.deepEqual(splitFor('advanced', 3), ['PUSH', 'PULL', 'LEGS']);
  assert.equal(splitFor('intermediate', 4)[0], 'UP_A');
  assert.ok(splitFor('beginner', 6).includes('CARDIO'));
});

test('программа использует только доступные тренажёры', () => {
  for (const k of ['typical', 'home', 'none', 'all']) {
    for (const level of ['beginner', 'intermediate', 'advanced']) {
      const owned = new Set(preset(k));
      const prog = buildProgram({ ...base, level, days: [1, 3, 5], equipment: preset(k) });
      for (const w of prog.workouts) {
        assert.ok(w.items.length >= 3, `${k}/${level}/${w.title}: ${w.items.length}`);
        for (const it of w.items) {
          for (const req of it.ex.eq) assert.ok([req].flat().some((r) => owned.has(r)), `${it.ex.id} needs ${req}`);
          assert.ok((it.ex.lvl ?? 0) <= ['beginner', 'intermediate', 'advanced'].indexOf(level));
        }
      }
    }
  }
});

test('ограничения исключают нагрузку на проблемные зоны', () => {
  const prog = buildProgram({ ...base, level: 'advanced', days: [1, 2, 3, 4, 5, 6], equipment: preset('all'), limits: ['knees', 'back'] });
  for (const w of prog.workouts) for (const it of w.items) assert.ok(!it.ex.stress.some((s) => s === 'knees' || s === 'back'), it.ex.id);
});

test('без повторов упражнения внутри дня', () => {
  const prog = buildProgram({ ...base, level: 'advanced', days: [1, 2, 3, 4, 5, 6], equipment: preset('all') });
  for (const w of prog.workouts) {
    const ids = w.items.map((i) => i.ex.id);
    assert.equal(new Set(ids).size, ids.length, w.title);
  }
});

test('кардио-финиш только при похудении/поддержании', () => {
  const gain = buildProgram({ ...base, goal: 'gain', level: 'beginner', days: [1, 3, 5], equipment: preset('typical') });
  const lose = buildProgram({ ...base, goal: 'lose', level: 'beginner', days: [1, 3, 5], equipment: preset('typical') });
  assert.ok(gain.workouts.every((w) => !w.items.some((i) => i.role === 'finisher')));
  assert.ok(lose.workouts.every((w) => w.items.some((i) => i.role === 'finisher')));
});

test('тренировка по дню недели', () => {
  const prog = buildProgram({ ...base, level: 'beginner', days: [1, 3, 5], equipment: preset('typical') });
  assert.equal(workoutForDate(prog, new Date(2026, 9, 12)).weekday, 1); // понедельник
  assert.equal(workoutForDate(prog, new Date(2026, 9, 13)), null);
});

test('прогрессия веса', () => {
  const ex = EXERCISE_BY_ID.leg_press;
  const item = { sets: 3, min: 8, max: 12 };
  assert.deepEqual(nextWeight(ex, item, { w: 100, r: [12, 12, 12] }), { w: 105, why: 'up' });
  assert.deepEqual(nextWeight(ex, item, { w: 100, r: [12, 10, 9] }), { w: 100, why: 'keep' });
  assert.deepEqual(nextWeight(ex, item, { w: 100, r: [7, 6, 6], fails: 2 }), { w: 90, why: 'down' });
  assert.deepEqual(nextWeight(EXERCISE_BY_ID.db_curl, item, { w: 10, r: [12, 12, 12] }), { w: 11, why: 'up' });
  assert.deepEqual(nextWeight(EXERCISE_BY_ID.assisted_pullup, item, { w: 30, r: [12, 12, 12] }), { w: 27.5, why: 'up' });
});
