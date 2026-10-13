import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validBarcode, normBarcode, upcEtoA, parseOff, parseQty, isStoreCode,
  packMyFoods, unpackMyFoods, addMyFood, MY_MAX, MAX_JSON,
} from '../js/features/barcode.js';

test('validBarcode: EAN-13, EAN-8, UPC-A, UPC-E, GTIN-14', () => {
  assert.equal(validBarcode('5449000000996'), true); // Coca-Cola
  assert.equal(validBarcode('4600000000008'), true);
  assert.equal(validBarcode('96385074'), true); // EAN-8
  assert.equal(validBarcode('036000291452'), true); // UPC-A
  assert.equal(validBarcode('04252614'), true); // UPC-E (EAN-8 сумма не сходится)
  assert.equal(validBarcode('10012345678902'), true); // GTIN-14
});

test('validBarcode: опечатки, длина, мусор', () => {
  assert.equal(validBarcode('5449000000997'), false);
  assert.equal(validBarcode('96385075'), false);
  assert.equal(validBarcode('036000291453'), false);
  assert.equal(validBarcode('1234567'), false); // 7 цифр
  assert.equal(validBarcode('123456789'), false); // 9 цифр — такого формата нет
  assert.equal(validBarcode('123456789012345'), false); // 15 цифр
  assert.equal(validBarcode('00000000'), false);
  assert.equal(validBarcode('5449 000000996'), false);
  assert.equal(validBarcode('abc'), false);
  assert.equal(validBarcode(''), false);
  assert.equal(validBarcode(null), false);
  assert.equal(validBarcode(undefined), false);
});

test('isStoreCode: внутренние коды магазина (весовой товар)', () => {
  assert.equal(isStoreCode('2200123004561'), true); // EAN-13 на «2» — этикетка весов
  assert.equal(isStoreCode('212345678906'), true); // UPC-A на «2» — товар переменного веса
  assert.equal(isStoreCode('4600000000008'), false);
  assert.equal(isStoreCode('5449000000996'), false);
  assert.equal(isStoreCode('20012347'), false); // EAN-8 частных марок (Lidl и т. п.) — код постоянный
  assert.equal(isStoreCode(''), false);
  assert.equal(isStoreCode(null), false);
});

test('UPC-E разворачивается в UPC-A', () => {
  assert.equal(upcEtoA('04252614'), '042100005264');
  assert.equal(upcEtoA('01234565'), '012345000065');
  assert.equal(upcEtoA('24252614'), ''); // система счисления только 0/1
  assert.equal(normBarcode('04252614'), '042100005264');
  assert.equal(normBarcode('01234565', 'upc_e'), '012345000065');
  assert.equal(normBarcode('01234565'), '01234565'); // валиден и как EAN-8 — оставляем
  assert.equal(normBarcode(' 4600-000 000008 '), '4600000000008');
});

const COLA = {
  code: '5449000000996',
  status: 1,
  product: {
    code: '5449000000996',
    product_name: 'Coca-Cola Original',
    product_name_ru: 'Coca Cola',
    generic_name: 'Bebida refrescante aromatizada',
    brands: 'COCA-COLA SERVICES SA/NV, Coca-Cola',
    quantity: '330 ml',
    serving_quantity: 330,
    serving_size: '1 portion (330 ml)',
    image_front_small_url: 'https://images.openfoodfacts.org/images/products/544/900/000/0996/front_en.1129.200.jpg',
    nutriments: { 'energy-kcal_100g': 42.4, energy_100g: 180, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 10.6 },
  },
};

test('parseOff: русское имя, КБЖУ на 100 г, порция и упаковка', () => {
  const f = parseOff(COLA);
  assert.equal(f.code, '5449000000996');
  assert.equal(f.name, 'Coca Cola');
  assert.equal(f.brand, 'COCA-COLA SERVICES SA/NV');
  assert.equal(f.qty, '330 ml');
  assert.deepEqual([f.k, f.p, f.f, f.c], [42, 0, 0, 10.6]);
  assert.equal(f.serving, 330);
  assert.equal(f.pack, 330);
  assert.equal(f.incomplete, false);
  assert.match(f.img, /^https:\/\/images\.openfoodfacts\.org\//);
});

test('parseOff: имя — product_name, затем generic_name', () => {
  const p = { ...COLA.product, product_name_ru: '  ' };
  assert.equal(parseOff({ status: 1, product: p }).name, 'Coca-Cola Original');
  assert.equal(parseOff({ status: 1, product: { ...p, product_name: '' } }).name, 'Bebida refrescante aromatizada');
  assert.equal(parseOff({ status: 1, product: { code: '4600000000008', brands: 'Бренд', nutriments: {} } }).name, 'Бренд');
});

test('parseOff: ккал из кДж', () => {
  const f = parseOff({ status: 1, product: { code: '4600000000008', product_name: 'Овсянка', nutriments: { energy_100g: 1569, proteins_100g: '12,5', fat_100g: 6, carbohydrates_100g: 60 } } });
  assert.equal(f.k, 375); // 1569 / 4.184
  assert.equal(f.p, 12.5); // строка с запятой
  assert.equal(f.incomplete, false);
  const kj = parseOff({ status: 1, product: { product_name: 'X', nutriments: { 'energy-kj_100g': 418.4 } } });
  assert.equal(kj.k, 100);
});

test('parseOff: отсутствующие поля', () => {
  const f = parseOff({ status: 1, product: { code: '4600000000008', product_name: 'Хлебцы', nutriments: { carbohydrates_100g: 70 } } });
  assert.deepEqual([f.p, f.f, f.c], [0, 0, 70]);
  assert.equal(f.k, 280); // нет энергии — оценка 4/9/4
  assert.equal(f.serving, 0);
  assert.equal(f.pack, 0);
  assert.equal(f.img, '');
  assert.equal(f.brand, '');
  const empty = parseOff({ status: 1, product: { product_name: 'Без КБЖУ' } });
  assert.equal(empty.incomplete, true);
  assert.deepEqual([empty.k, empty.p, empty.f, empty.c], [0, 0, 0, 0]);
  // порция из serving_size, если нет serving_quantity
  assert.equal(parseOff({ status: 1, product: { product_name: 'Печенье', serving_size: '2 шт (25 г)' } }).serving, 25);
  // небезопасная картинка не проходит
  assert.equal(parseOff({ status: 1, product: { product_name: 'X', image_front_small_url: 'javascript:alert(1)' } }).img, '');
  assert.equal(parseOff({ status: 1, product: { product_name: 'X', image_front_small_url: 'https://a.b/x.jpg" onerror="1' } }).img, '');
});

test('parseOff: не найден / мусор → null', () => {
  assert.equal(parseOff({ code: '4600000000008', status: 0, status_verbose: 'product not found' }), null);
  assert.equal(parseOff({ status: 1 }), null);
  assert.equal(parseOff(null), null);
  assert.equal(parseOff('oops'), null);
});

test('parseQty', () => {
  assert.equal(parseQty('330 ml'), 330);
  assert.equal(parseQty('1,5 л'), 1500);
  assert.equal(parseQty('0.5 kg'), 500);
  assert.equal(parseQty('400г'), 400);
  assert.equal(parseQty('6 x 330 ml'), 0);
  assert.equal(parseQty(''), 0);
});

const food = (i, extra = {}) => ({ code: String(4600000000000 + i), name: `Продукт ${i}`, k: 100 + i, p: 1.25, f: 2, c: 3.04, serving: i % 2 ? 30 : 0, ...extra });

test('myFoods: компактная упаковка и распаковка', () => {
  const packed = packMyFoods([food(1), food(2)]);
  assert.deepEqual(packed[0], ['4600000000001', 'Продукт 1', 101, 1.3, 2, 3, 30]);
  assert.deepEqual(packed[1][6], 0);
  const back = unpackMyFoods(packed);
  assert.deepEqual(back[0], { code: '4600000000001', name: 'Продукт 1', k: 101, p: 1.3, f: 2, c: 3, serving: 30 });
  // имя обрезается до 40 символов
  const long = packMyFoods([food(3, { name: 'Очень длинное название продукта из магазина у дома, 500 г' })]);
  assert.equal(long[0][1].length, 40);
});

test('myFoods: новые сверху, дубли по коду заменяются, максимум 20', () => {
  let raw = null;
  for (let i = 1; i <= 25; i++) raw = addMyFood(raw, food(i));
  assert.equal(raw.length, MY_MAX);
  assert.equal(raw[0][0], '4600000000025');
  assert.equal(raw[19][0], '4600000000006');
  raw = addMyFood(raw, food(10, { name: 'Обновлённый', k: 999 }));
  assert.equal(raw.length, MY_MAX);
  assert.deepEqual(raw[0].slice(0, 3), ['4600000000010', 'Обновлённый', 999]);
  assert.equal(raw.filter((r) => r[0] === '4600000000010').length, 1);
});

test('myFoods: JSON не длиннее лимита — старые обрезаются', () => {
  const big = Array.from({ length: 20 }, (_, i) => food(i, { name: '"\\'.repeat(20) }));
  const full = packMyFoods(big);
  assert.ok(JSON.stringify(full).length <= MAX_JSON);
  const small = packMyFoods(big, 600);
  assert.ok(JSON.stringify(small).length <= 600);
  assert.ok(small.length > 0 && small.length < 20);
  assert.equal(small[0][0], big[0].code); // остались самые свежие
  assert.equal(addMyFood(small, food(99), 300).length > 0, true);
  assert.ok(JSON.stringify(addMyFood(small, food(99), 300)).length <= 300);
});

test('myFoods: битые данные не ломают распаковку', () => {
  assert.deepEqual(unpackMyFoods(null), []);
  assert.deepEqual(unpackMyFoods('x'), []);
  const rows = unpackMyFoods([null, 'x', ['12', 'коротк.', 1], ['4600000000008', '', 1], ['4600000000008', 'Ок', -5, 'a', 200, '7,5', 99999], ['4600000000008', 'Дубль', 1]]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { code: '4600000000008', name: 'Ок', k: 0, p: 0, f: 100, c: 7.5, serving: 2000 });
});
