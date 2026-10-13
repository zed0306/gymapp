import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyFat, bfCategory, whtr, whtrCategory, whtrShown, whtrNormRange, parseCm, checkField, upsertMeasure, trimMeasures, normalizeEntry,
  deltaTone, fieldStats, daysBetween, lastKnown, formValues, entryDeltas, changesBase, FIELDS, MAX_ENTRIES, MAX_JSON,
} from '../js/features/measures.js';
import measures from '../js/features/measures.js';

const close = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// Независимая проверка: исходная формула ВМС США в дюймах (Hodgdon & Beckett, 1984)
const IN = 2.54;
const navyInchesMale = (h, neck, waist) => 86.010 * Math.log10((waist - neck) / IN) - 70.041 * Math.log10(h / IN) + 36.76;
const navyInchesFemale = (h, neck, waist, hips) => 163.205 * Math.log10((waist + hips - neck) / IN) - 97.684 * Math.log10(h / IN) - 78.387;

test('% жира, мужчины: контрольные значения метрической формулы', () => {
  // 495 / (1.0324 − 0.19077·log10(талия − шея) + 0.15456·log10(рост)) − 450
  assert.equal(bodyFat('m', 180, ['2026-01-01', 38, null, 85, null, null, null]), 16.1);
  assert.equal(bodyFat('m', 178, { neck: 40, waist: 95 }), 22.2);
  assert.equal(bodyFat('m', 175, { neck: 37, waist: 78 }), 12);
  assert.equal(bodyFat('m', 182, { neck: 42, waist: 110 }), 29.6);
});

test('% жира, женщины: контрольные значения метрической формулы', () => {
  // 495 / (1.29579 − 0.35004·log10(талия + бёдра − шея) + 0.22100·log10(рост)) − 450
  assert.equal(bodyFat('f', 165, ['2026-01-01', 32, null, 70, 96, null, null]), 25.4);
  assert.equal(bodyFat('f', 170, { neck: 33, waist: 80, hips: 105 }), 32.9);
  assert.equal(bodyFat('f', 160, { neck: 30, waist: 64, hips: 90 }), 21.4);
});

test('% жира совпадает с исходной формулой в дюймах (±0,5%)', () => {
  for (const [h, n, w] of [[180, 38, 85], [170, 36, 90], [190, 41, 100]]) {
    close(bodyFat('m', h, { neck: n, waist: w }), navyInchesMale(h, n, w), 0.5);
  }
  for (const [h, n, w, hp] of [[165, 32, 70, 96], [158, 31, 80, 104]]) {
    close(bodyFat('f', h, { neck: n, waist: w, hips: hp }), navyInchesFemale(h, n, w, hp), 0.5);
  }
});

test('% жира: нет нужных замеров или нереальный результат → null', () => {
  assert.equal(bodyFat('m', 180, { waist: 85 }), null); // нет шеи
  assert.equal(bodyFat('m', 180, { neck: 38 }), null); // нет талии
  assert.equal(bodyFat('f', 165, { neck: 32, waist: 70 }), null); // женщинам нужны бёдра
  assert.equal(bodyFat('m', 0, { neck: 38, waist: 85 }), null); // нет роста
  assert.equal(bodyFat('m', 180, { neck: 40, waist: 40 }), null); // талия = шея
  assert.equal(bodyFat('m', 180, { neck: 40, waist: 60 }), null); // формула < 2%
  assert.equal(bodyFat('m', 180, ['2026-01-01', null, 100, 85, null, null, null]), null);
  // мужчине бёдра не нужны
  assert.equal(bodyFat('m', 180, { neck: 38, waist: 85, hips: 999 }), 16.1);
});

test('категории ACE', () => {
  const m = (p) => bfCategory('m', p).key;
  const f = (p) => bfCategory('f', p).key;
  assert.equal(m(3), 'essential');
  assert.equal(m(5.9), 'essential');
  assert.equal(m(6), 'athletes');
  assert.equal(m(13.9), 'athletes');
  assert.equal(m(14), 'fitness');
  assert.equal(m(17.5), 'fitness');
  assert.equal(m(18), 'average');
  assert.equal(m(24.9), 'average');
  assert.equal(m(25), 'obese');
  assert.equal(f(12), 'essential');
  assert.equal(f(14), 'athletes');
  assert.equal(f(20.9), 'athletes');
  assert.equal(f(21), 'fitness');
  assert.equal(f(25), 'average');
  assert.equal(f(31.9), 'average');
  assert.equal(f(32), 'obese');
  assert.equal(bfCategory('m', null), null);
  assert.equal(bfCategory('m', 30).tone, 'danger');
  assert.equal(bfCategory('m', 10).tone, 'ok');
});

test('отношение талии к росту и его категории', () => {
  assert.equal(whtr(90, 180), 0.5);
  close(whtr(80, 180), 0.4444, 0.0001); // без округления
  assert.equal(whtrShown(whtr(80, 180)), 0.44);
  assert.equal(whtr(null, 180), null);
  assert.equal(whtr(80, 0), null);
  const k = (v) => whtrCategory(v).key;
  assert.equal(k(0.38), 'low');
  assert.equal(k(0.4), 'norm');
  assert.equal(k(0.49), 'norm');
  assert.equal(k(0.5), 'elevated');
  assert.equal(k(0.59), 'elevated');
  assert.equal(k(0.6), 'high');
  assert.equal(k(0.75), 'high');
  assert.deepEqual(['low', 'norm', 'elevated', 'high'].map((x) => ({ low: 0.3, norm: 0.45, elevated: 0.55, high: 0.65 })[x]).map((v) => whtrCategory(v).tone), ['warn', 'ok', 'warn', 'danger']);
});

test('WHtR у границ: категория по точному отношению, показ не спорит с категорией', () => {
  const cat = (w, h) => whtrCategory(whtr(w, h)).key;
  // раньше округление до сотых давало соседнюю категорию
  assert.equal(cat(87, 175), 'norm'); // 0,4971
  assert.equal(cat(89.9, 180), 'norm'); // 0,4994
  assert.equal(cat(69.2, 174), 'low'); // 0,3977
  assert.equal(cat(107.6, 180), 'elevated'); // 0,5978
  // ровно на границе — верхняя категория (без ошибок плавающей точки)
  assert.equal(cat(69.6, 174), 'norm'); // 0,4
  assert.equal(cat(87.5, 175), 'elevated'); // 0,5
  assert.equal(cat(108, 180), 'high'); // 0,6
  assert.equal(cat(104.4, 174), 'high'); // 0,6
  assert.equal(whtrShown(whtr(87, 175)), 0.49);
  assert.equal(whtrShown(whtr(87.5, 175)), 0.5);
  assert.equal(whtrShown(null), null);
  // показанное число всегда в той же категории, что и точное
  for (let h = 150; h <= 200; h += 0.5) {
    for (let w = 55; w <= 125; w = Math.round((w + 0.1) * 10) / 10) {
      const raw = whtr(w, h);
      assert.equal(whtrCategory(whtrShown(raw)).key, whtrCategory(raw).key, `${w}/${h}`);
    }
  }
});

test('whtrNormRange: границы нормы талии при шаге ввода 0,1 см', () => {
  assert.deepEqual(whtrNormRange(175), { lo: 70, hi: 87.4 });
  assert.deepEqual(whtrNormRange(180), { lo: 72, hi: 89.9 });
  assert.deepEqual(whtrNormRange(174), { lo: 69.6, hi: 86.9 });
  assert.equal(whtrNormRange(0), null);
  const cat = (w, h) => whtrCategory(whtr(w, h)).key;
  const r1 = (x) => Math.round(x * 10) / 10;
  for (let h = 140; h <= 210; h += 0.5) {
    const { lo, hi } = whtrNormRange(h);
    assert.equal(cat(lo, h), 'norm', `lo ${lo}/${h}`);
    assert.equal(cat(r1(lo - 0.1), h), 'low', `lo−0,1 ${lo}/${h}`);
    assert.equal(cat(hi, h), 'norm', `hi ${hi}/${h}`);
    assert.equal(cat(r1(hi + 0.1), h), 'elevated', `hi+0,1 ${hi}/${h}`);
  }
});

test('parseCm: разбор поля формы', () => {
  assert.equal(parseCm(''), null);
  assert.equal(parseCm('   '), null);
  assert.equal(parseCm(undefined), null);
  assert.equal(parseCm('88,5'), 88.5);
  assert.equal(parseCm('88.5'), 88.5);
  assert.equal(parseCm(' 88 '), 88);
  assert.equal(parseCm('88,'), 88);
  assert.equal(parseCm('88,25'), 88.3);
  assert.equal(parseCm(',5'), 0.5);
  // любое неотрицательное число разбирается: диапазон проверяет checkField, а не «не понял число»
  assert.equal(parseCm('0'), 0);
  assert.equal(parseCm('0,0'), 0);
  assert.equal(parseCm('1000'), 1000);
  assert.equal(parseCm('1234'), 1234);
  for (const bad of ['87-', '8e', '1e2', '0x50', '-5', '88,5,1', '88 5', 'abc', '+88', '∞', '.', ',']) {
    assert.ok(Number.isNaN(parseCm(bad)), bad);
  }
});

test('checkField: пусто, мусор и выход за диапазон — разные ответы', () => {
  const neck = FIELDS.find((f) => f.k === 'neck');
  const waist = FIELDS.find((f) => f.k === 'waist');
  assert.deepEqual(checkField(neck, ''), { value: null });
  assert.deepEqual(checkField(neck, '   '), { value: null });
  assert.deepEqual(checkField(neck, undefined), { value: null });
  assert.deepEqual(checkField(neck, '39,5'), { value: 39.5 });
  assert.deepEqual(checkField(neck, '20'), { value: 20 }); // границы включительно
  assert.deepEqual(checkField(neck, '70'), { value: 70 });
  // 0 и 1000 — числа, просто вне диапазона: подсказываем диапазон
  assert.deepEqual(checkField(neck, '0'), { error: 'Шея — от 20 до 70 см' });
  assert.deepEqual(checkField(neck, '1000'), { error: 'Шея — от 20 до 70 см' });
  assert.deepEqual(checkField(neck, '19,9'), { error: 'Шея — от 20 до 70 см' });
  assert.deepEqual(checkField(waist, '0,0'), { error: 'Талия — от 40 до 200 см' });
  // мусор — просим число, пример зависит от пола
  assert.deepEqual(checkField(neck, '8e'), { error: 'Шея: не понял число — введи, например, 39,5' });
  assert.deepEqual(checkField(neck, 'abc', 'f'), { error: 'Шея: не понял число — введи, например, 32,5' });
  assert.deepEqual(checkField(waist, '87-'), { error: 'Талия: не понял число — введи, например, 86,5' });
});

// Талию мерят чаще остального: 3.09 — только талия, 17.09 — все места, 1.10 — снова только талия
const PARTIAL = [
  ['2026-09-03', null, null, 95, null, null, null],
  ['2026-09-17', 40, 104, 93, 101, 34, 57],
  ['2026-10-01', null, null, 91, null, null, null],
];

test('lastKnown: последнее известное значение каждого места', () => {
  assert.deepEqual(lastKnown(PARTIAL, 'waist'), { value: 91, date: '2026-10-01' });
  assert.deepEqual(lastKnown(PARTIAL, 'chest'), { value: 104, date: '2026-09-17' });
  assert.deepEqual(lastKnown(PARTIAL, 'thigh'), { value: 57, date: '2026-09-17' });
  assert.equal(lastKnown(PARTIAL.slice(0, 1), 'chest'), null);
  assert.equal(lastKnown([], 'neck'), null);
  assert.equal(lastKnown(null, 'neck'), null);
});

test('formValues: предзаполнение и сравнение — по последнему известному значению каждого места', () => {
  // новый замер: в последнем мерили только талию, остальное берём из 17.09, а не оставляем пустым
  const add = formValues(PARTIAL, '2026-10-13');
  assert.equal(add.own, null);
  assert.equal(add.prevDate, '2026-10-01');
  assert.deepEqual(add.fields.waist, { value: 91, was: 91, wasDate: '2026-10-01' });
  assert.deepEqual(add.fields.chest, { value: 104, was: 104, wasDate: '2026-09-17' });
  assert.deepEqual(add.fields.neck, { value: 40, was: 40, wasDate: '2026-09-17' });
  // правка записи: в полях — её значения, сравнение — с последним известным до неё
  const ed = formValues(PARTIAL, '2026-10-01');
  assert.deepEqual(ed.own, PARTIAL[2]);
  assert.equal(ed.prevDate, '2026-09-17');
  assert.deepEqual(ed.fields.waist, { value: 91, was: 93, wasDate: '2026-09-17' });
  assert.deepEqual(ed.fields.chest, { value: null, was: 104, wasDate: '2026-09-17' });
  // задним числом между замерами: только то, что было известно до этой даты
  const back = formValues(PARTIAL, '2026-09-10');
  assert.equal(back.prevDate, '2026-09-03');
  assert.deepEqual(back.fields.waist, { value: 95, was: 95, wasDate: '2026-09-03' });
  assert.deepEqual(back.fields.chest, { value: null, was: null, wasDate: null });
  // первый замер
  const first = formValues([], '2026-10-13');
  assert.equal(first.own, null);
  assert.equal(first.prevDate, null);
  for (const f of FIELDS) assert.deepEqual(first.fields[f.k], { value: null, was: null, wasDate: null });
  assert.equal(formValues(null, '2026-10-13').fields.neck.value, null);
});

test('entryDeltas: изменение каждого места к его последнему известному значению', () => {
  // полный → только талия → полный: грудь и остальное сравниваются с первым, талия — со вторым
  const H = [
    ['2026-08-01', 40, 104, 95, 102, 34, 57],
    ['2026-08-15', null, null, 93, null, null, null],
    ['2026-09-01', 39.5, 103, 92, 101, 34.5, 57],
  ];
  const c = entryDeltas(H, 2);
  assert.deepEqual(c.chest, { value: 103, prev: 104, prevDate: '2026-08-01', delta: -1 });
  assert.deepEqual(c.waist, { value: 92, prev: 93, prevDate: '2026-08-15', delta: -1 });
  assert.equal(c.neck.delta, -0.5);
  assert.equal(c.biceps.delta, 0.5);
  assert.equal(c.thigh.delta, 0);
  // место не мерили — изменения нет, но прошлое значение известно
  assert.deepEqual(entryDeltas(H, 1).neck, { value: null, prev: 40, prevDate: '2026-08-01', delta: null });
  assert.deepEqual(entryDeltas(H, 1).waist, { value: 93, prev: 95, prevDate: '2026-08-01', delta: -2 });
  // первый замер — сравнивать не с чем
  assert.deepEqual(entryDeltas(H, 0).waist, { value: 95, prev: null, prevDate: null, delta: null });
  assert.equal(entryDeltas(null, 0).waist.delta, null);
});

test('changesBase: дата в заголовке «Изменения с …» совпадает с отсчётом большинства плиток', () => {
  const stats = (list) => FIELDS.map((f) => fieldStats(list, f.k));
  // талия — с 3.09, остальные пять мест — с 17.09: заголовок «с 17.09», у талии своя дата
  const L = [...PARTIAL.slice(0, 2), ['2026-10-01', 39.5, 102, 91, 100, 34.5, 56]];
  assert.equal(changesBase(stats(L)), '2026-09-17');
  assert.equal(fieldStats(L, 'waist').firstDate, '2026-09-03');
  // все места с одной даты
  assert.equal(changesBase(stats([['2026-01-01', 40, 100, 90, 100, 34, 56], ['2026-02-01', 39, 99, 89, 99, 34, 56]])), '2026-01-01');
  // поровну — более ранняя
  assert.equal(changesBase(stats([
    ['2026-01-01', 40, 100, null, null, null, null],
    ['2026-01-10', null, null, 90, 100, null, null],
    ['2026-02-01', 39, 99, 89, 99, null, null],
  ])), '2026-01-01');
  // у плиток с одним замером изменения нет — они не в счёт; изменений нет вовсе → null
  assert.equal(changesBase(stats(PARTIAL)), '2026-09-03');
  assert.equal(changesBase(stats([['2026-01-01', 40, 100, 90, 100, 34, 56]])), null);
  assert.equal(changesBase([]), null);
  assert.equal(changesBase(null), null);
});

test('upsertMeasure: одна запись на дату, сортировка, перезапись', () => {
  let list = [];
  list = upsertMeasure(list, ['2026-03-10', 38, 100, 90, 100, 34, 56]);
  list = upsertMeasure(list, ['2026-02-10', 39, 101, 92, 101, 33, 57]);
  assert.deepEqual(list.map((e) => e[0]), ['2026-02-10', '2026-03-10']);
  list = upsertMeasure(list, ['2026-03-10', 37.5, null, 89.5, null, null, null]);
  assert.equal(list.length, 2);
  assert.deepEqual(list[1], ['2026-03-10', 37.5, null, 89.5, null, null, null]);
  // строки, запятые, пустые значения, округление до 0,1
  list = upsertMeasure(list, ['2026-04-01', '38,5', '', '88.04', 0, null, undefined]);
  assert.deepEqual(list[2], ['2026-04-01', 38.5, null, 88, null, null, null]);
  // запись без значений удаляет дату; кривая дата игнорируется
  assert.deepEqual(upsertMeasure(list, ['2026-04-01', null, null, null, null, null, null]).map((e) => e[0]), ['2026-02-10', '2026-03-10']);
  assert.equal(upsertMeasure(list, ['вчера', 1, 2, 3, 4, 5, 6]).length, 3);
  // исходный список не меняется
  const before = JSON.stringify(list);
  upsertMeasure(list, ['2026-05-01', 38, 100, 87, 99, 35, 57]);
  assert.equal(JSON.stringify(list), before);
});

test('trimMeasures: максимум 60 записей и ≤ 4096 символов JSON', () => {
  const big = [];
  const d0 = Date.UTC(2020, 0, 1);
  for (let i = 0; i < 100; i++) {
    const d = new Date(d0 + i * 7 * 864e5).toISOString().slice(0, 10);
    // самые длинные значения: 199,5 и т. п.
    big.push([d, 69.5, 199.5, 199.5, 199.5, 69.5, 99.5]);
  }
  const t = trimMeasures(big);
  assert.equal(t.length, MAX_ENTRIES);
  assert.equal(t[t.length - 1][0], big[big.length - 1][0]); // оставлены последние
  assert.ok(JSON.stringify(t).length <= MAX_JSON, `JSON ${JSON.stringify(t).length}`);
  // через upsert тоже
  let list = [];
  for (const e of big) list = upsertMeasure(list, e);
  assert.equal(list.length, 60);
  assert.ok(JSON.stringify(list).length <= MAX_JSON);
});

test('trimMeasures: мусор отбрасывается, дубликаты дат схлопываются, длинные дроби округляются', () => {
  const t = trimMeasures([
    null, 'x', [], ['2026-01-01'], ['2026-13-01x', 1, 2, 3, 4, 5, 6],
    ['2026-01-02', 38.333333333, -5, 'abc', NaN, Infinity, true],
    ['2026-01-02', 38.5, null, 90, null, null, null],
    ['2026-01-01', null, null, null, null, null, 55.55],
  ]);
  assert.deepEqual(t, [
    ['2026-01-01', null, null, null, null, null, 55.6],
    ['2026-01-02', 38.5, null, 90, null, null, null],
  ]);
  assert.deepEqual(trimMeasures(null), []);
  assert.deepEqual(trimMeasures({ a: 1 }), []);
  // даже если значения раздуты длинными дробями, JSON не превышает лимит
  const fat = Array.from({ length: 60 }, (_, i) => [
    new Date(Date.UTC(2021, 0, 1) + i * 864e5).toISOString().slice(0, 10),
    ...[38, 100, 85, 99, 33, 56].map((v) => v + 0.123456789),
  ]);
  const ft = trimMeasures(fat);
  assert.equal(ft.length, 60);
  assert.equal(ft[0][1], 38.1);
  assert.ok(JSON.stringify(ft).length <= MAX_JSON);
  // значения вне диапазона поля (мусор из хранилища) считаются пустыми
  assert.deepEqual(
    trimMeasures([['2020-01-11', 0.4, 123456.7, 200, 1e21, 0.2, 100]]),
    [['2020-01-11', null, null, 200, null, null, 100]],
  );
  assert.deepEqual(trimMeasures([['2020-01-11', 19.9, 201, 39, 49, 14, 101]]), []);
});

test('normalizeEntry', () => {
  assert.equal(normalizeEntry(['2026-01-01', null, null, null, null, null, null]), null);
  assert.equal(normalizeEntry(['2026-13-01', 40]), null);
  assert.equal(normalizeEntry(['2026-02-30', 40]), null);
  assert.deepEqual(normalizeEntry(['2028-02-29', 40])[0], '2028-02-29');
  assert.deepEqual(normalizeEntry(['2026-01-01', 40]), ['2026-01-01', 40, null, null, null, null, null]);
  assert.equal(FIELDS.length, 6);
  assert.deepEqual(FIELDS.map((f) => f.i), [1, 2, 3, 4, 5, 6]);
});

test('цвет изменения зависит от цели', () => {
  assert.equal(deltaTone('lose', 'waist', -2), 'good');
  assert.equal(deltaTone('lose', 'hips', -0.5), 'good');
  assert.equal(deltaTone('lose', 'waist', 1), 'neutral');
  assert.equal(deltaTone('lose', 'biceps', 1), 'neutral');
  assert.equal(deltaTone('gain', 'biceps', 1), 'good');
  assert.equal(deltaTone('gain', 'chest', 2), 'good');
  assert.equal(deltaTone('gain', 'thigh', 0.5), 'good');
  assert.equal(deltaTone('gain', 'waist', -1), 'neutral');
  assert.equal(deltaTone('maintain', 'waist', -3), 'neutral');
  assert.equal(deltaTone('lose', 'waist', 0), 'neutral');
});

test('fieldStats и daysBetween', () => {
  const list = [
    ['2026-01-01', 39, null, 92, null, null, null],
    ['2026-01-15', null, null, 90.5, null, null, null],
    ['2026-02-01', 38.5, null, null, null, null, null],
  ];
  assert.deepEqual(fieldStats(list, 'waist'), { value: 90.5, date: '2026-01-15', first: 92, firstDate: '2026-01-01', delta: -1.5, count: 2 });
  assert.equal(fieldStats(list, 'neck').delta, -0.5);
  assert.equal(fieldStats(list, 'chest'), null);
  assert.equal(daysBetween('2026-03-28', '2026-04-11'), 14); // через переход на летнее время
  assert.equal(daysBetween('2026-10-12', '2026-10-12'), 0);
});

test('контракт модуля', () => {
  assert.equal(measures.id, 'measures');
  assert.deepEqual(measures.keys, ['measures']);
  assert.equal(typeof measures.screens.msHome, 'function');
  assert.equal(typeof measures.sheets.msAdd, 'function');
  assert.equal(typeof measures.sheets.msEntry, 'function');
  assert.equal(typeof measures.slots['profile.links'], 'function');
  for (const name of [...Object.keys(measures.actions), ...Object.keys(measures.screens), ...Object.keys(measures.sheets)]) {
    assert.ok(name.startsWith('ms'), name);
  }
  for (const name of Object.keys(measures.binds)) assert.ok(name.startsWith('ms.'), name);
});
