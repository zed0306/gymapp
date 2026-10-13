// Модуль «Замеры тела»: обхваты в сантиметрах, % жира (формула ВМС США),
// отношение талии к росту, график и история.
//
// Хранилище: ключ 'measures' = [[date, neck, chest, waist, hips, biceps, thigh], …]
// date — 'YYYY-MM-DD', значения в см с точностью 0,1 или null (не мерил).
// Одна запись на дату, по возрастанию даты, не больше 60 записей и 4096 символов JSON.
import { ctx } from '../core.js';

export const KEY = 'measures';
export const MAX_ENTRIES = 60;
export const MAX_JSON = 4096;
export const STALE_DAYS = 14;

// i — индекс в записи; min/max — допустимый диапазон, см; typ — стартовое значение для пустого поля
export const FIELDS = [
  { k: 'neck', i: 1, t: 'Шея', min: 20, max: 70, hint: 'Под кадыком', typ: { m: 39, f: 32 } },
  { k: 'chest', i: 2, t: 'Грудь', min: 50, max: 200, hint: 'По самым выступающим точкам', typ: { m: 100, f: 90 } },
  { k: 'waist', i: 3, t: 'Талия', min: 40, max: 200, hint: 'На уровне пупка, на выдохе', typ: { m: 86, f: 72 } },
  { k: 'hips', i: 4, t: 'Бёдра', min: 50, max: 200, hint: 'По самой выступающей точке ягодиц', typ: { m: 98, f: 98 } },
  { k: 'biceps', i: 5, t: 'Бицепс', min: 15, max: 70, hint: 'Самая широкая часть расслабленной руки', typ: { m: 33, f: 28 } },
  { k: 'thigh', i: 6, t: 'Бедро', min: 30, max: 100, hint: 'Под ягодичной складкой', typ: { m: 56, f: 55 } },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.k, f]));

// ── Чистые функции (покрыты tests/measures.test.js) ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r1 = (x) => Math.round(x * 10) / 10;

function num(v) {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'string' ? +v.replace(',', '.') : +v;
  return Number.isFinite(n) && n > 0 ? r1(n) : null;
}

// Разбор поля формы: '' → null (не мерил), '88,5' / '88.5' → 88.5, мусор ('87-', '8e', '0x50') → NaN.
// Любое неотрицательное число (0, 1000) разбирается — его отсечёт проверка диапазона в checkField.
export function parseCm(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (!s) return null;
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  return r1(+s);
}

// Проверка поля формы: { value } (null — пусто) или { error } с текстом для человека
export function checkField(f, raw, sex = 'm') {
  const v = parseCm(raw);
  if (v === null) return { value: null };
  if (Number.isNaN(v)) return { error: `${f.t}: не понял число — введи, например, ${String(f.typ[sex === 'f' ? 'f' : 'm'] + 0.5).replace('.', ',')}` };
  if (v < f.min || v > f.max) return { error: `${f.t} — от ${f.min} до ${f.max} см` };
  return { value: v };
}

function validDate(k) {
  if (typeof k !== 'string' || !DATE_RE.test(k)) return false;
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Запись к виду [date, 6 × (число | null)]; null — если дата неверна или всё пусто.
// Значения вне допустимого диапазона поля (мусор из хранилища) считаются пустыми.
export function normalizeEntry(e) {
  if (!Array.isArray(e) || !validDate(e[0])) return null;
  const vals = FIELDS.map((f) => {
    const v = num(e[f.i]);
    return v !== null && v >= f.min && v <= f.max ? v : null;
  });
  if (vals.every((v) => v === null)) return null;
  return [e[0], ...vals];
}

// Чистка списка: валидные записи, одна на дату (последняя побеждает), по возрастанию даты,
// не больше MAX_ENTRIES и не длиннее MAX_JSON символов JSON (старые отбрасываются)
export function trimMeasures(list) {
  const byDate = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    const n = normalizeEntry(e);
    if (n) byDate.set(n[0], n);
  }
  let out = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(-MAX_ENTRIES);
  while (out.length && JSON.stringify(out).length > MAX_JSON) out = out.slice(1);
  return out;
}

// Добавить или заменить запись за дату. Запись без единого значения удаляет дату.
export function upsertMeasure(list, entry) {
  const date = Array.isArray(entry) ? entry[0] : null;
  const rest = (Array.isArray(list) ? list : []).filter((e) => !(Array.isArray(e) && e[0] === date));
  const n = normalizeEntry(entry);
  return trimMeasures(n ? [...rest, n] : rest);
}

function pick(entry, k) {
  if (Array.isArray(entry)) return num(entry[BY_KEY[k].i]);
  return num(entry?.[k]);
}

// % жира по формуле ВМС США (метрическая): рост и обхваты в см.
// entry — запись [date, neck, chest, waist, hips, …] или объект {neck, waist, hips}.
// null — если не хватает замеров или результат вне 2–75% (замеры с ошибкой).
export function bodyFat(sex, height, entry) {
  const h = num(height);
  const neck = pick(entry, 'neck');
  const waist = pick(entry, 'waist');
  if (!h || !neck || !waist) return null;
  let pct;
  if (sex === 'f') {
    const hips = pick(entry, 'hips');
    if (!hips || waist + hips - neck <= 0) return null;
    pct = 495 / (1.29579 - 0.35004 * Math.log10(waist + hips - neck) + 0.221 * Math.log10(h)) - 450;
  } else {
    if (waist - neck <= 0) return null;
    pct = 495 / (1.0324 - 0.19077 * Math.log10(waist - neck) + 0.15456 * Math.log10(h)) - 450;
  }
  if (!Number.isFinite(pct) || pct < 2 || pct > 75) return null;
  return r1(pct);
}

// Категории ACE: верхние границы (не включая) и шкала для отрисовки
const BF_CATS = {
  m: { lo: 2, hi: 40, cuts: [6, 14, 18, 25] },
  f: { lo: 10, hi: 45, cuts: [14, 21, 25, 32] },
};
const BF_INFO = [
  { key: 'essential', title: 'Необходимый', tone: 'low', note: 'Минимум для здоровья — долго так держать не стоит' },
  { key: 'athletes', title: 'Атлеты', tone: 'ok', note: 'Уровень спортсменов' },
  { key: 'fitness', title: 'Фитнес', tone: 'ok', note: 'Подтянутая спортивная форма' },
  { key: 'average', title: 'Средний', tone: 'warn', note: 'Типичный уровень, есть куда расти' },
  { key: 'obese', title: 'Ожирение', tone: 'danger', note: 'Лишний жир повышает риски для здоровья' },
];

export function bfCategory(sex, pct) {
  if (pct === null || pct === undefined || !Number.isFinite(+pct)) return null;
  const { cuts } = BF_CATS[sex === 'f' ? 'f' : 'm'];
  let i = cuts.findIndex((c) => +pct < c);
  if (i < 0) i = cuts.length;
  return { ...BF_INFO[i], index: i };
}

// Отношение талии к росту без округления (категория считается по нему); null — если данных нет.
// Делим целые десятые доли сантиметра: точное деление даёт ровно 0.4 / 0.5 / 0.6 на границах.
export function whtr(waist, height) {
  const w = num(waist);
  const h = num(height);
  if (!w || !h) return null;
  return Math.round(w * 10) / Math.round(h * 10);
}

// Число для показа: две цифры после запятой с отбрасыванием (не округлением),
// чтобы 0,497 не показывалось как «0,50» рядом с категорией «Норма»
export function whtrShown(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return null;
  return Math.floor(+v * 100 + 1e-9) / 100;
}

// Талия в норме (0,4 ≤ WHtR < 0,5) при данном росте, с шагом ввода 0,1 см: { lo, hi } включительно
export function whtrNormRange(height) {
  const h = num(height);
  if (!h) return null;
  const H = Math.round(h * 10);
  // lo: наименьшее W (десятые см) с W/H ≥ 0,4; hi: наибольшее W с W/H < 0,5
  return { lo: Math.ceil((4 * H) / 10) / 10, hi: (Math.ceil(H / 2) - 1) / 10 };
}

const WHTR_INFO = [
  { key: 'low', title: 'Низкое', tone: 'warn', note: 'Талия заметно меньше нормы — проверь, хватает ли питания' },
  { key: 'norm', title: 'Норма', tone: 'ok', note: 'Талия меньше половины роста — так и держи' },
  { key: 'elevated', title: 'Повышенный риск', tone: 'warn', note: 'Талия больше половины роста — стоит её уменьшить' },
  { key: 'high', title: 'Высокий риск', tone: 'danger', note: 'Жир на животе повышает риски для сердца — уменьшай талию' },
];
const WHTR_CUTS = [0.4, 0.5, 0.6];

export function whtrCategory(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return null;
  let i = WHTR_CUTS.findIndex((c) => +v < c);
  if (i < 0) i = WHTR_CUTS.length;
  return { ...WHTR_INFO[i], index: i };
}

// Хорошо ли изменение для цели: lose — талия/бёдра вниз, gain — бицепс/грудь/бедро вверх
export function deltaTone(goal, k, delta) {
  if (!delta) return 'neutral';
  if (goal === 'lose' && (k === 'waist' || k === 'hips') && delta < 0) return 'good';
  if (goal === 'gain' && (k === 'biceps' || k === 'chest' || k === 'thigh') && delta > 0) return 'good';
  return 'neutral';
}

// Последнее и первое известное значение поля и изменение между ними
export function fieldStats(list, k) {
  const i = BY_KEY[k].i;
  const has = (list || []).filter((e) => e[i] !== null && e[i] !== undefined);
  if (!has.length) return null;
  const first = has[0];
  const last = has[has.length - 1];
  return { value: last[i], date: last[0], first: first[i], firstDate: first[0], delta: r1(last[i] - first[i]), count: has.length };
}

// Разница в днях между 'YYYY-MM-DD' (b − a), без влияния перехода на летнее время
export function daysBetween(a, b) {
  const day = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  return Math.round(day(b) - day(a));
}

// Последнее известное значение поля в списке (по возрастанию даты): { value, date } или null.
// Места меряют не все сразу (талия — каждую неделю, остальное — раз в месяц),
// поэтому сравнивать и предзаполнять нужно по каждому полю отдельно, а не по одной записи.
export function lastKnown(entries, k) {
  const i = BY_KEY[k].i;
  for (let j = (entries || []).length - 1; j >= 0; j--) {
    const v = entries[j][i];
    if (v !== null && v !== undefined) return { value: v, date: entries[j][0] };
  }
  return null;
}

// Значения формы за дату: own — запись за эту дату (правка) или null, prevDate — дата прошлого замера.
// По полям: value — что подставить (своё значение или последнее известное до даты),
// was / wasDate — с чем сравнивать: последнее известное значение места до даты
export function formValues(entries, date) {
  const list = entries || [];
  const own = list.find((e) => e[0] === date) || null;
  const before = list.filter((e) => e[0] < date);
  const prevDate = before.length ? before[before.length - 1][0] : null;
  const fields = Object.fromEntries(FIELDS.map((f) => {
    const known = lastKnown(before, f.k);
    const value = own ? own[f.i] ?? null : known ? known.value : null;
    return [f.k, { value, was: known ? known.value : null, wasDate: known ? known.date : null }];
  }));
  return { own, prevDate, fields };
}

// Изменения записи entries[idx] по каждому полю к его последнему известному значению до неё
export function entryDeltas(entries, idx) {
  const before = (entries || []).slice(0, Math.max(0, idx));
  const e = (entries || [])[idx];
  return Object.fromEntries(FIELDS.map((f) => {
    const v = e ? e[f.i] ?? null : null;
    const prev = lastKnown(before, f.k);
    return [f.k, {
      value: v,
      prev: prev ? prev.value : null,
      prevDate: prev ? prev.date : null,
      delta: v !== null && prev ? r1(v - prev.value) : null,
    }];
  }));
}

// Общая точка отсчёта для сетки изменений: дата первого замера, от которой считается
// большинство плиток (при равенстве — более ранняя); null — изменений ещё нет
export function changesBase(statsList) {
  const counts = new Map();
  for (const st of statsList || []) {
    if (st && st.count > 1) counts.set(st.firstDate, (counts.get(st.firstDate) || 0) + 1);
  }
  let best = null;
  for (const [d, n] of counts) {
    if (!best || n > best[1] || (n === best[1] && d < best[0])) best = [d, n];
  }
  return best ? best[0] : null;
}

// ── Состояние экрана ────────────────────────────────────────────────────────

// [ключ, подпись чипа, винительный падеж для «… ещё не измеряли»]
const CHART_METRICS = [
  ['waist', 'Талия', 'Талию'], ['chest', 'Грудь', 'Грудь'], ['hips', 'Бёдра', 'Бёдра'], ['biceps', 'Бицепс', 'Бицепс'],
  ['thigh', 'Бедро', 'Бедро'], ['neck', 'Шея', 'Шею'], ['bf', '% жира', ''],
];
let metric = 'waist';
let showAll = false;
const HISTORY_SHORT = 6;
// Черновик формы msAdd: переживает перерисовки ядра (смена темы в Telegram, полночь, конец
// таймера отдыха). { date, vals: {k: строка поля}, focus: {k, s, e} | null, err, bad: [k] }
let draft = null;
// Защита от двойного тапа: кнопка «Сохранить» шторки лежит ровно над «Добавить замер», строки
// истории — под фоном шторки. Второй тап на том же месте вскоре после закрытия (открытия) шторки
// не должен открыть её снова (или сохранить только что открытую форму). Тап в другом месте — можно.
let lastTap = null; // {x, y, t} — последний клик в документе (фаза перехвата, до ядра)
let closed = null; // {x, y, t} — тап, которым шторку закрыли
let opened = null; // {x, y, t} — тап, которым шторку открыли
function sameTap(mark, e, ms) {
  if (!mark || Date.now() - mark.t > ms) return false;
  if (!e || !Number.isFinite(e.clientX) || (!e.clientX && !e.clientY)) return false;
  return Math.hypot(e.clientX - mark.x, e.clientY - mark.y) < 48;
}
const justClosed = (e) => sameTap(closed, e, 650);
const justOpened = (e) => sameTap(opened, e, 450);
// Отметка для только что закрытой/открытой шторки — по тапу, который это сделал (если он был)
const tapMark = () => (lastTap && Date.now() - lastTap.t < 1000 ? { ...lastTap, t: Date.now() } : null);
// Что было на экране до перерисовки (unmount → mount): экран замеров, шторка «имя:дата», её прокрутка
let hadPage = false;
let hadSheet = null;
let sheetScroll = 0;
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const list = () => trimMeasures(ctx.S()[KEY]);
const sexOf = () => (ctx.profile()?.sex === 'f' ? 'f' : 'm');
const n1 = (v) => ctx.fmt(v, v % 1 ? 1 : 0);
const MINUS = '−';
const signed = (d) => (d > 0 ? `+${n1(d)}` : d < 0 ? `${MINUS}${n1(-d)}` : '0');

function dateLong(k) {
  const d = ctx.parseKey(k);
  const s = ctx.dayMonth(d);
  return d.getFullYear() === new Date().getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

// Короткая дата: D.MM, для прошлых лет — D.MM.ГГ (иначе «с 9.08» при истории больше года неоднозначно)
function sd(k) {
  const s = ctx.shortDate(k);
  return k.slice(0, 4) === String(new Date().getFullYear()) ? s : `${s}.${k.slice(2, 4)}`;
}

function agoText(days) {
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} ${ctx.plural(days, 'день', 'дня', 'дней')} назад`;
}

function series(entries, m) {
  const p = ctx.profile() || {};
  if (m === 'bf') {
    return entries
      .map((e) => ({ label: sd(e[0]), date: e[0], value: bodyFat(p.sex, p.height, e) }))
      .filter((x) => x.value !== null);
  }
  const i = BY_KEY[m].i;
  return entries.filter((e) => e[i] !== null).map((e) => ({ label: sd(e[0]), date: e[0], value: e[i] }));
}

// Последняя запись, по которой считается % жира
function lastBodyFat(entries) {
  const p = ctx.profile() || {};
  for (let j = entries.length - 1; j >= 0; j--) {
    const v = bodyFat(p.sex, p.height, entries[j]);
    if (v !== null) return { value: v, date: entries[j][0], entry: entries[j] };
  }
  return null;
}

// ── Силуэт ──────────────────────────────────────────────────────────────────
// viewBox 0 0 200 400, центр x = 100. Контур задан точками правой половины (dx от центра, y),
// отражается и сглаживается сплайном Катмулла — Рома. Третий элемент точки — «угол».

const f1 = (x) => Math.round(x * 10) / 10;

function smoothPath(pts) {
  const n = pts.length;
  const t = 1 / 6;
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = p1[2] ? p1 : [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = p2[2] ? p2 : [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += `C${f1(c1[0])},${f1(c1[1])} ${f1(c2[0])},${f1(c2[1])} ${f1(p2[0])},${f1(p2[1])}`;
  }
  return `${d}Z`;
}

// Правая половина туловища с ногой: от шеи вниз и обратно по внутренней стороне ноги
function mirrorBody(half) {
  const right = half.map(([dx, y, c]) => [100 + dx, y, c]);
  const left = half.filter(([dx]) => dx !== 0).map(([dx, y, c]) => [100 - dx, y, c]).reverse();
  return smoothPath([...right, ...left]);
}

const limb = (pts, side) => smoothPath(pts.map(([dx, y, c]) => [100 + side * dx, y, c]));

const SHAPES = {
  m: {
    head: [100, 35, 17, 22],
    body: [
      [9.5, 42, 1], [10, 60], [11, 72], [25, 80], [42, 85], [49, 94],
      [43, 112, 1], [43, 128], [37, 150], [33.5, 166], [36, 186], [39, 204], [38, 226],
      [33, 270], [30.5, 292], [32, 318], [27, 348], [22, 366], [27, 383, 1], [9, 386, 1],
      [8, 366], [10, 342], [10, 318], [8, 292], [6, 260], [3, 240], [0, 234, 1],
    ],
    arm: [
      [38, 84], [50, 88], [57, 102], [59, 124], [60, 150], [63, 180], [64, 208], [67, 226], [61, 242, 1],
      [55, 230], [54, 210], [50, 182], [47, 156], [44, 130], [42, 108],
    ],
    tapes: {
      neck: { y: 66, cx: 0, rx: 11, side: 'r' },
      chest: { y: 120, cx: 0, rx: 42.5, side: 'l' },
      biceps: { y: 124, cx: 51.5, rx: 7.6, side: 'r', limb: true },
      waist: { y: 166, cx: 0, rx: 33.5, side: 'l', down: true },
      hips: { y: 204, cx: 0, rx: 39, side: 'r' },
      thigh: { y: 248, cx: -20, rx: 16, side: 'l', limb: true },
    },
  },
  f: {
    head: [100, 36, 15.5, 21],
    hair: [
      [100, 11], [114, 14], [121, 28], [121, 46], [123, 62], [119, 76, 1], [108, 74], [100, 70],
      [92, 74], [81, 76, 1], [77, 62], [79, 46], [79, 28], [86, 14],
    ],
    body: [
      [7.5, 44, 1], [7.8, 60], [8.5, 72], [20, 80], [34, 85], [41, 95],
      [35, 110, 1], [37, 122], [35, 136], [29, 150], [26.5, 162], [32, 182], [40, 202], [41.5, 216],
      [37, 250], [29, 292], [30, 318], [25, 348], [19, 366], [24, 383, 1], [7, 386, 1],
      [6.5, 366], [8.5, 342], [9, 318], [7, 292], [5, 262], [3, 242], [0, 236, 1],
    ],
    arm: [
      [32, 84], [42, 89], [47, 102], [49, 124], [50, 148], [53, 178], [55, 206], [58, 224], [53, 238, 1],
      [47, 226], [46, 208], [42.5, 180], [40, 154], [37, 128], [35.5, 108],
    ],
    tapes: {
      neck: { y: 66, cx: 0, rx: 8.5, side: 'r' },
      chest: { y: 122, cx: 0, rx: 37.5, side: 'l' },
      biceps: { y: 124, cx: 43, rx: 6, side: 'r', limb: true },
      waist: { y: 162, cx: 0, rx: 26.5, side: 'l', down: true },
      hips: { y: 208, cx: 0, rx: 41, side: 'r' },
      thigh: { y: 250, cx: -19, rx: 17, side: 'l', limb: true },
    },
  },
};

const PATHS = {};
for (const sex of ['m', 'f']) {
  const s = SHAPES[sex];
  const [hx, hy, hrx, hry] = s.head;
  PATHS[sex] = {
    parts: [
      mirrorBody(s.body), limb(s.arm, 1), limb(s.arm, -1),
      `M${hx - hrx},${hy}a${hrx},${hry} 0 1 0 ${hrx * 2},0a${hrx},${hry} 0 1 0 ${-hrx * 2},0Z`,
    ],
    hair: s.hair ? smoothPath(s.hair) : '',
  };
}

const DOT_R = 2.6;
const DOT_ON = 3.6;

function tapeSvg(k, t, has, on) {
  const cx = 100 + t.cx;
  const ry = t.limb ? 2.6 : 3.6;
  const x1 = f1(cx - t.rx);
  const x2 = f1(cx + t.rx);
  const end = t.side === 'r' ? x2 : x1;
  const edge = t.side === 'r' ? 200 : 0;
  // Радиус точки — атрибутом: CSS-свойство r для SVG поддерживают не все WebView
  return `<g class="tape ${has ? '' : 'off'} ${on ? 'on' : ''}" data-k="${k}">
    <path class="ext" d="M${end},${t.y}H${edge}"/>
    <path class="tb" d="M${x1},${t.y}A${t.rx},${ry} 0 0 1 ${x2},${t.y}"/>
    <path class="tf" d="M${x1},${t.y}A${t.rx},${ry} 0 0 0 ${x2},${t.y}"/>
    <circle class="dot" cx="${end}" cy="${t.y}" r="${on ? DOT_ON : DOT_R}"/>
  </g>`;
}

// Карточка-фигура: значения последних замеров по местам
function figure(vals, sex, active) {
  const s = SHAPES[sex];
  const P = PATHS[sex];
  const edge = P.parts.map((d) => `<path d="${d}"/>`).join('');
  const svg = `<svg class="ms-body" viewBox="0 0 200 400" aria-hidden="true">
    <ellipse class="floor" cx="100" cy="388" rx="46" ry="6"/>
    <g class="sil-edge">${P.hair ? `<path d="${P.hair}"/>` : ''}${edge}</g>
    ${P.hair ? `<path class="hair" d="${P.hair}"/>` : ''}
    <g class="sil">${edge}</g>
    ${FIELDS.map((f) => tapeSvg(f.k, s.tapes[f.k], vals[f.k] !== null, active === f.k)).join('')}
  </svg>`;
  const col = (side) => FIELDS.filter((f) => s.tapes[f.k].side === side).map((f) => {
    const v = vals[f.k];
    const t = s.tapes[f.k];
    // Линия-выноска на уровне значения; подпись над ним (или под ним — для соседних замеров)
    return `<button class="ms-lbl ${t.down ? 'down' : 'up'} ${active === f.k ? 'on' : ''} ${v === null ? 'off' : ''}" style="top:${(t.y / 400) * 100}%" data-act="msMetric" data-k="${f.k}" aria-label="${f.t}: ${v === null ? 'нет данных' : `${n1(v)} см`}">
      <span class="t">${f.t}</span><span class="vr"><span class="v num">${v === null ? '—' : n1(v)}</span><span class="ln"></span></span></button>`;
  }).join('');
  return `<div class="ms-fig"><div class="ms-col l">${col('l')}</div>${svg}<div class="ms-col r">${col('r')}</div></div>`;
}

// ── Шкалы и плашки ──────────────────────────────────────────────────────────

const pill = (tone, text) => `<span class="ms-pill ${tone}">${text}</span>`;

function scale(lo, hi, cuts, value, colors, activeIdx, ticksFmt) {
  const edges = [lo, ...cuts, hi];
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const segs = colors.map((c, i) => `<i class="${i === activeIdx ? 'on' : ''}" style="flex:${f1(((edges[i + 1] - edges[i]) / (hi - lo)) * 100)} 1 0;background:${c}"></i>`).join('');
  const ticks = cuts.map((c) => `<span style="left:${pos(c)}%">${ticksFmt(c)}</span>`).join('');
  return `<div class="ms-scale"><div class="bar">${segs}</div><div class="mk" style="left:${pos(value)}%"></div><div class="ticks">${ticks}</div></div>`;
}

const BF_COLORS = ['var(--carbs)', 'var(--ok)', 'var(--fat)', 'var(--warn)', 'var(--danger)'];
const WHTR_COLORS = ['var(--carbs)', 'var(--ok)', 'var(--warn)', 'var(--danger)'];

function bodyFatCard(entries) {
  const p = ctx.profile() || {};
  const sex = sexOf();
  const bf = lastBodyFat(entries);
  const need = sex === 'f' ? 'шея, талия и бёдра' : 'шея и талия';
  if (!bf) {
    const last = entries[entries.length - 1];
    const hasAll = last && pick(last, 'neck') && pick(last, 'waist') && (sex !== 'f' || pick(last, 'hips'));
    return `<div class="card ms-card"><div class="row"><div class="icon-box">${ctx.icon('flame')}</div><div class="grow">
      <div class="h3">% жира</div><div class="sub small">${hasAll
        ? 'Формула даёт нереальный результат — проверь шею и талию в последнем замере.'
        : `Для оценки нужны ${need}. Добавь их в следующий замер.`}</div></div></div></div>`;
  }
  const cat = bfCategory(sex, bf.value);
  const { lo, hi, cuts } = BF_CATS[sex];
  const w = +p.weight || 0;
  const fatKg = (w * bf.value) / 100;
  const latest = entries[entries.length - 1][0];
  return `<div class="card ms-card">
    <div class="row between top">
      <div><div class="sub small">% жира · оценка</div><div class="ms-big num">${ctx.fmt(bf.value, 1)}<small>%</small></div></div>
      ${pill(cat.tone, cat.title)}
    </div>
    ${scale(lo, hi, cuts, bf.value, BF_COLORS, cat.index, (c) => c)}
    <div class="sub small">${cat.note}</div>
    ${w ? `<div class="ms-mass">
      <div><span class="dot" style="background:var(--warn)"></span><div><div class="tiny muted">Жировая масса</div><b class="num">${ctx.fmt(fatKg, 1)} кг</b></div></div>
      <div><span class="dot" style="background:var(--accent-text)"></span><div><div class="tiny muted">Безжировая масса</div><b class="num">${ctx.fmt(w - fatKg, 1)} кг</b></div></div>
    </div>` : ''}
    <div class="ms-note">${ctx.icon('info', 'sm')}<span>Формула ВМС США по ${need === 'шея и талия' ? 'шее, талии' : 'шее, талии, бёдрам'} и росту${w ? ` при весе ${n1(w)} кг` : ''}. Это оценка, погрешность ±3–4%.${bf.date !== latest ? ` По замеру ${sd(bf.date)}.` : ''}</span></div>
  </div>`;
}

function whtrCard(waistStat) {
  const p = ctx.profile() || {};
  if (!waistStat) return '';
  const v = whtr(waistStat.value, p.height);
  if (v === null) return '';
  const cat = whtrCategory(v);
  const norm = whtrNormRange(p.height);
  return `<div class="card ms-card">
    <div class="row between top">
      <div><div class="sub small">Талия / рост</div><div class="ms-big num">${ctx.fmt(whtrShown(v), 2)}</div></div>
      ${pill(cat.tone, cat.title)}
    </div>
    ${scale(0.3, 0.7, WHTR_CUTS, v, WHTR_COLORS, cat.index, (c) => ctx.fmt(c, 1))}
    <div class="sub small">${cat.note}. При росте ${n1(num(p.height))} см норма — талия от ${n1(norm.lo)} до ${n1(norm.hi)} см.</div>
  </div>`;
}

function deltaHtml(goal, k, delta, unit = 'см') {
  if (delta === null || delta === undefined) return '';
  if (!delta) return `<span class="ms-delta">без изменений</span>`;
  const tone = deltaTone(goal, k, delta);
  return `<span class="ms-delta ${tone}">${ctx.icon(delta > 0 ? 'up' : 'down')}${signed(delta)} ${unit}</span>`;
}

// ── Экраны ──────────────────────────────────────────────────────────────────

const HOW_TO = `<ul class="ms-how">
  ${FIELDS.map((f) => `<li><b>${f.t}</b> — ${f.hint.toLowerCase()}</li>`).join('')}
</ul>
<div class="sub small" style="margin-top:10px">Мерь утром натощак, до тренировки, мягкой сантиметровой лентой. Лента идёт горизонтально и плотно прилегает, но не врезается. Раз в 2 недели достаточно.</div>`;

// Подпись и содержимое карточки графика (обновляются на месте при переключении показателя)
function chartParts(entries, m) {
  const pts = series(entries, m);
  const unit = m === 'bf' ? '%' : 'см';
  const u = (v) => `${v}${unit === '%' ? '%' : ` ${unit}`}`;
  let sub = '';
  if (pts.length > 1) {
    const d = r1(pts[pts.length - 1].value - pts[0].value);
    sub = `с ${sd(pts[0].date)}: ${d ? u(signed(d)) : 'без изменений'}`;
  }
  let body;
  if (pts.length > 1) body = '<div class="chart" data-ms-chart></div>';
  else if (pts.length === 1) body = `<div class="ms-chart-empty">${ctx.icon('chart')}<div><b>${u(n1(pts[0].value))}</b> — пока одна точка. Добавь следующий замер через 1–2 недели, и здесь появится график.</div></div>`;
  else {
    const acc = CHART_METRICS.find(([k]) => k === m)[2];
    body = `<div class="ms-chart-empty">${ctx.icon('chart')}<div>${m === 'bf' ? `Для % жира нужны ${sexOf() === 'f' ? 'шея, талия и бёдра' : 'шея и талия'} в одном замере.` : `${acc} ещё не измеряли — добавь в следующий замер.`}</div></div>`;
  }
  return { sub, body };
}

function drawChart(root) {
  const el = root.querySelector('[data-ms-chart]');
  if (!el) return;
  const pts = series(list(), metric);
  if (pts.length < 2) return;
  const name = CHART_METRICS.find(([k]) => k === metric)[1];
  ctx.lineChart(el, pts, { unit: metric === 'bf' ? '%' : 'см', decimals: 1, label: `Динамика: ${name.toLowerCase()}` });
}

// История: строки и кнопка «Показать все / Свернуть»
function histParts(entries) {
  const rev = [...entries].reverse();
  const shown = showAll ? rev : rev.slice(0, HISTORY_SHORT);
  const items = shown.map((e) => {
    const d = ctx.parseKey(e[0]);
    const parts = FIELDS.filter((f) => e[f.i] !== null).map((f) => `${f.t.toLowerCase()} ${n1(e[f.i])}`);
    return `<button class="list-item" data-act="msOpen" data-date="${e[0]}">
      <div class="ms-day"><b>${d.getDate()}</b><span>${MON[d.getMonth()]}</span></div>
      <div class="grow"><div class="h3">${dateLong(e[0])}</div><div class="sub small ellipsis">${parts.join(' · ')}</div></div>
      <span class="muted">${ctx.icon('right')}</span></button>`;
  }).join('');
  const more = rev.length > HISTORY_SHORT
    ? `<button class="btn ghost sm block" style="margin-top:10px" data-act="msMore">${showAll ? 'Свернуть' : `Показать все · ${rev.length}`}</button>`
    : '';
  return { items, more };
}

function screenHome() {
  const entries = list();
  const p = ctx.profile() || {};
  const sex = sexOf();
  const last = entries[entries.length - 1];
  const bar = `<div class="bottom-bar"><div class="inner"><button class="btn block" data-act="msAdd">${ctx.icon('plus')} Добавить замер</button></div></div>`;

  if (!last) {
    const empty = Object.fromEntries(FIELDS.map((f) => [f.k, null]));
    return `<div class="page no-tabs ms-page">
      ${ctx.backHeader('Замеры тела', 'Сантиметр честнее весов')}
      <div class="card ms-card">
        <div class="h3">Добавь первый замер</div>
        <div class="sub small" style="margin-top:4px">Вес может стоять, а талия — уходить, руки — расти. Шесть обхватов за пару минут покажут настоящий прогресс и % жира.</div>
        ${figure(empty, sex, null)}
      </div>
      <div class="section-title"><div class="h3">Как мерить</div></div>
      <div class="card">${HOW_TO}</div>
      ${bar}
    </div>`;
  }

  const stats = Object.fromEntries(FIELDS.map((f) => [f.k, fieldStats(entries, f.k)]));
  const vals = Object.fromEntries(FIELDS.map((f) => [f.k, stats[f.k]?.value ?? null]));
  const today = ctx.dkey();
  const age = daysBetween(last[0], today);
  const stale = age > STALE_DAYS
    ? `<div class="notice ms-stale">${ctx.icon('alert', 'sm')}<div class="grow"><b>Пора обновить замеры: раз в 2 недели, утром</b><div>Последний был ${agoText(age)}.</div></div></div>`
    : '';
  // Сетка показателей. Изменение плитки — от первого замера этого места; общая дата в заголовке —
  // та, от которой считается большинство плиток, у остальных своя дата прямо в плитке
  const base = changesBase(FIELDS.map((f) => stats[f.k]));
  const grid = FIELDS.map((f) => {
    const st = stats[f.k];
    const delta = st && st.count > 1 ? st.delta : null;
    const own = delta !== null && st.firstDate !== base ? `<span class="ms-from">с ${sd(st.firstDate)}</span>` : '';
    return `<button class="stat ms-stat ${metric === f.k ? 'on' : ''}" data-act="msMetric" data-k="${f.k}">
      <div class="lbl">${f.t}${own}</div>
      <div class="v num">${st ? n1(st.value) : '—'}${st ? '<small> см</small>' : ''}</div>
      ${delta !== null ? deltaHtml(p.goal, f.k, delta) : `<span class="ms-delta">${st ? 'один замер' : 'нет данных'}</span>`}
    </button>`;
  }).join('');

  const chips = CHART_METRICS.map(([k, t]) => `<button class="chip ${metric === k ? 'on' : ''}" data-act="msMetric" data-k="${k}">${t}</button>`).join('');
  const chart = chartParts(entries, metric);
  const hist = histParts(entries);

  return `<div class="page no-tabs ms-page">
    ${ctx.backHeader('Замеры тела', `Последний — ${dateLong(last[0])}`)}
    ${stale}
    <div class="card ms-card">
      <div class="row between"><div class="sub small">Последние значения, см</div><span class="badge">${entries.length} ${ctx.plural(entries.length, 'замер', 'замера', 'замеров')}</span></div>
      ${figure(vals, sex, metric)}
    </div>
    ${bodyFatCard(entries)}
    ${whtrCard(stats.waist)}
    <div class="section-title"><div class="h3">Изменения</div><span class="sub small">${base ? `с ${sd(base)}` : ''}</span></div>
    <div class="ms-grid">${grid}</div>
    <div class="section-title" data-ms-dyn><div class="h3">Динамика</div><span class="sub small" data-ms-chart-sub>${chart.sub}</span></div>
    <div class="chips ms-chips">${chips}</div>
    <div class="card ms-chart-card" data-ms-chart-card>${chart.body}</div>
    <div class="section-title"><div class="h3">История</div></div>
    <div class="card list ms-hist">${hist.items}</div>
    <div data-ms-more>${hist.more}</div>
    <details class="card ms-details">
      <summary class="row between"><span class="h3">Как правильно мерить</span><span class="muted">${ctx.icon('right')}</span></summary>
      <div style="margin-top:12px">${HOW_TO}</div>
    </details>
    ${bar}
  </div>`;
}

// ── Шторки ──────────────────────────────────────────────────────────────────

// Число в поле ввода — с запятой, как во всём интерфейсе
const cmText = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

// Плашка разницы с прошлым значением поля: текст и класс (пусто, если разницы нет)
function changeBadge(k, v, was) {
  const d = v !== null && was !== null && Number.isFinite(v) ? r1(v - was) : 0;
  return { text: d ? signed(d) : '', cls: `ms-chg ${d ? deltaTone(ctx.profile()?.goal, k, d) : ''}`.trim() };
}

// Дата формы: из параметров шторки, иначе из черновика (полночь не меняет её на лету), иначе сегодня
function formDate(date) {
  if (validDate(date)) return date;
  if (draft && validDate(draft.date)) return draft.date;
  return ctx.dkey();
}

function sheetAdd({ date, fresh } = {}) {
  const today = ctx.dkey();
  const d = formDate(date);
  const { own, prevDate, fields: fv } = formValues(list(), d);
  // Черновик — то, что человек уже ввёл: переживает перерисовку ядра
  const dr = draft && draft.date === d ? draft : null;
  let prefilled = false;
  const fields = FIELDS.map((f, j) => {
    const x = fv[f.k];
    if (x.value !== null) prefilled = true;
    const raw = dr && Object.prototype.hasOwnProperty.call(dr.vals, f.k) ? dr.vals[f.k] : cmText(x.value);
    // type=number не понимает запятую (Chromium выбрасывает её: «84,5» → 845, WebKit отдаёт ''),
    // поэтому поле текстовое с цифровой клавиатурой; разбор — parseCm.
    // Клавиша действия: «Далее» на всех полях, кроме последнего, на нём — «Готово» (см. onKey)
    const step = ctx.stepper(`ms.${f.k}`, raw, 'см', 0.5)
      .replaceAll('data-act="step"', 'data-act="msStep"')
      .replace('<input type="number" ', '<input type="text" ')
      .replace('<input ', `<input placeholder="—" autocomplete="off" spellcheck="false" enterkeyhint="${j < FIELDS.length - 1 ? 'next' : 'done'}" maxlength="6" aria-label="${f.t}, см" `);
    const v = parseCm(raw);
    const b = changeBadge(f.k, v, x.was);
    const bad = Number.isNaN(v) || !!dr?.bad?.includes(f.k);
    // Это место в прошлый замер не мерили — подписываем дату значения, с которым сравниваем
    const since = x.was !== null && x.wasDate !== prevDate ? ` <span class="ms-since">· прошлый ${sd(x.wasDate)}</span>` : '';
    return `<div class="ms-field${bad ? ' bad' : ''}" data-ms-field="${f.k}" data-was="${x.was ?? ''}">
      <div class="txt"><div class="nm">${f.t}<span class="${b.cls}" data-ms-chg="${f.k}">${b.text}</span></div><div class="hint">${f.hint}${since}</div></div>
      ${step}
    </div>`;
  }).join('');
  const sub = d === today ? `Сегодня, ${dateLong(d)}` : dateLong(d);
  const hint = own
    ? 'В полях — значения этого замера, поправь, что нужно.'
    : prefilled ? 'Подставлены последние значения — поправь те, что изменились.' : 'Заполни, что можешь, — пустые поля не сохранятся.';
  return `<div class="h2" data-ms-sheet="msAdd:${d}">${own ? 'Изменить замер' : 'Новый замер'}</div>
    <div class="sub small" style="margin-top:4px">${sub} · мерь утром, до еды, мягкой лентой</div>
    ${own && fresh ? `<div class="notice" style="margin-top:12px">${ctx.icon('info', 'sm')}<div>Замер за ${d === today ? 'сегодня' : dateLong(d)} уже есть — сохранение обновит его.</div></div>` : ''}
    <div class="ms-form" data-date="${d}">${fields}</div>
    <div class="ms-tip">${hint} Пропускаешь какое-то место — очисти его поле.</div>
    <div class="err" id="ms-err">${dr?.err ? ctx.esc(dr.err) : ''}</div>
    <button class="btn block" data-act="msSave" data-date="${d}">${ctx.icon('check')} Сохранить</button>`;
}

function sheetEntry({ date } = {}) {
  const entries = list();
  const idx = entries.findIndex((e) => e[0] === date);
  if (idx < 0) return `<div class="empty" data-ms-sheet="msEntry:">Замер не найден</div><button class="btn block ghost" data-act="closeSheet">Закрыть</button>`;
  const e = entries[idx];
  const prevDate = idx > 0 ? entries[idx - 1][0] : null;
  const ds = entryDeltas(entries, idx);
  const p = ctx.profile() || {};
  const age = daysBetween(e[0], ctx.dkey());
  let vsPrev = false;
  const rows = FIELDS.map((f) => {
    const x = ds[f.k];
    // Изменение — к последнему известному значению этого места; если его мерили не в прошлый
    // замер, а раньше, под названием — дата, с которой сравниваем
    let since = '';
    if (x.delta !== null) {
      if (x.prevDate === prevDate) vsPrev = true;
      else since = `<small class="ms-since">с ${sd(x.prevDate)}</small>`;
    }
    return `<div class="kv ms-kv"><span>${f.t}${since}</span><span class="row" style="gap:10px">${x.delta !== null ? deltaHtml(p.goal, f.k, x.delta, '') : ''}<b class="num">${x.value === null ? '<span class="muted">—</span>' : `${n1(x.value)} см`}</b></span></div>`;
  }).join('');
  const bf = bodyFat(p.sex, p.height, e);
  const wr = whtr(e[3], p.height);
  return `<div class="h2" data-ms-sheet="msEntry:${e[0]}">${dateLong(e[0])}</div>
    <div class="sub small" style="margin-top:4px">${idx + 1}-й замер · ${agoText(age)}${vsPrev ? ` · сравнение с ${sd(prevDate)}` : ''}</div>
    <div style="margin-top:10px">${rows}
      ${bf !== null ? `<div class="kv ms-kv"><span>% жира (оценка)</span><span class="row" style="gap:10px">${pill(bfCategory(p.sex, bf).tone, bfCategory(p.sex, bf).title)}<b class="num">${ctx.fmt(bf, 1)}%</b></span></div>` : ''}
      ${wr !== null ? `<div class="kv ms-kv"><span>Талия / рост</span><span class="row" style="gap:10px">${pill(whtrCategory(wr).tone, whtrCategory(wr).title)}<b class="num">${ctx.fmt(whtrShown(wr), 2)}</b></span></div>` : ''}
    </div>
    <div class="row" style="margin-top:16px;gap:10px">
      <button class="btn ghost grow" data-act="msEdit" data-date="${e[0]}">${ctx.icon('edit', 'sm')} Изменить</button>
      <button class="btn danger grow" data-act="msDel" data-date="${e[0]}">${ctx.icon('trash', 'sm')} Удалить</button>
    </div>`;
}

// ── Действия ────────────────────────────────────────────────────────────────

function sheetEl() {
  return document.querySelector('.sheet') || document;
}

const formEl = () => document.querySelector('.sheet .ms-form');

// Черновик открытой формы (заводится при первом вводе или перед перерисовкой)
function ensureDraft() {
  const date = formEl()?.dataset.date;
  if (!validDate(date)) return null;
  if (!draft || draft.date !== date) draft = { date, vals: {}, focus: null, scroll: 0, err: '', bad: [] };
  return draft;
}

// Перед перерисовкой ядра: запомнить из DOM всё, что человек успел сделать в форме
function captureDraft(form) {
  const dr = ensureDraft();
  if (!dr) return;
  for (const input of form.querySelectorAll('input[data-bind^="ms."]')) dr.vals[input.dataset.bind.slice(3)] = input.value;
  const a = document.activeElement;
  dr.focus = a && form.contains(a) && a.matches('input[data-bind^="ms."]')
    ? { k: a.dataset.bind.slice(3), s: a.selectionStart, e: a.selectionEnd }
    : null;
  dr.err = document.querySelector('#ms-err')?.textContent || '';
  dr.bad = [...form.querySelectorAll('.ms-field.bad')].map((el) => el.dataset.msField);
}

function updateChange(k) {
  const root = sheetEl();
  const field = root.querySelector(`[data-ms-field="${k}"]`);
  if (!field) return;
  const input = field.querySelector(`input[data-bind="ms.${k}"]`);
  const chg = field.querySelector(`[data-ms-chg="${k}"]`);
  const was = field.dataset.was === '' ? null : +field.dataset.was;
  const v = readField(input);
  // Неразборчивый ввод («87-», «8e») подсвечиваем сразу; диапазон — только при сохранении
  field.classList.toggle('bad', Number.isNaN(v));
  if (chg) {
    const b = changeBadge(k, v, was);
    chg.textContent = b.text;
    chg.className = b.cls;
  }
  const err = root.querySelector('#ms-err');
  if (err) err.textContent = '';
}

// Ввод в поле формы: в черновик (состояние модуля) и плашку разницы, без перерисовки
function onInput(k, value) {
  const dr = ensureDraft();
  if (dr) {
    dr.vals[k] = String(value ?? '');
    dr.err = '';
  }
  updateChange(k);
}

// Значение поля: null — пусто, NaN — не число (в т. ч. badInput у старого type=number)
function readField(input) {
  if (!input) return null;
  if (input.validity?.badInput) return NaN;
  return parseCm(input.value);
}

function stepField({ bind, d }, el) {
  const k = String(bind || '').replace('ms.', '');
  const f = BY_KEY[k];
  const input = el.parentElement?.querySelector('input');
  if (!f || !input) return;
  ctx.haptic.tap();
  const cur = readField(input);
  let v;
  if (cur === null || Number.isNaN(cur)) {
    // Пусто или мусор — последнее известное значение места до даты формы (или типичное)
    const date = formEl()?.dataset.date || ctx.dkey();
    v = lastKnown(list().filter((e) => e[0] < date), k)?.value ?? f.typ[sexOf()];
  } else v = cur + +d;
  v = Math.max(f.min, Math.min(f.max, r1(v)));
  input.value = cmText(v);
  onInput(k, input.value);
}

function saveForm({ date }, el, ev) {
  // Второй тап двойного нажатия по «Добавить замер» попадает сюда: кнопки на одном месте
  if (justOpened(ev)) return;
  const root = sheetEl();
  const err = root.querySelector('#ms-err');
  if (!validDate(date)) return;
  const vals = [];
  for (const f of FIELDS) {
    const input = root.querySelector(`input[data-bind="ms.${f.k}"]`);
    const r = input?.validity?.badInput ? checkField(f, 'x', sexOf()) : checkField(f, input ? input.value : '', sexOf());
    if (r.error) {
      root.querySelector(`[data-ms-field="${f.k}"]`)?.classList.add('bad');
      if (err) err.textContent = r.error;
      ctx.haptic.warn();
      return;
    }
    vals.push(r.value);
  }
  if (vals.every((v) => v === null)) {
    if (err) err.textContent = 'Заполни хотя бы одно поле';
    ctx.haptic.warn();
    return;
  }
  const before = list();
  const existed = before.some((e) => e[0] === date);
  const next = upsertMeasure(before, [date, ...vals]);
  draft = null;
  ctx.save(KEY, next);
  ctx.haptic.ok();
  ctx.toast(existed ? 'Замер обновлён' : 'Замер сохранён');
  // Как в ядре (saveWeight): событие до перерисовки, чтобы подписчики попали в неё
  ctx.emit('measure', { count: next.length });
  ctx.closeSheet();
}

function removeEntry({ date }) {
  ctx.confirm(`Удалить замер за ${dateLong(date)}?`).then((ok) => {
    if (!ok) return;
    const next = trimMeasures(list().filter((e) => e[0] !== date));
    ctx.save(KEY, next);
    ctx.closeSheet();
    ctx.haptic.impact();
    ctx.toast('Замер удалён');
  });
}

// ── Переключение графика и истории на месте ─────────────────────────────────
// Полная перерисовка заново проигрывает анимацию .page (с transform): страница моргает,
// а нижняя панель на время анимации уезжает за экран. Поэтому меняем только нужные узлы.

function applyMetric(page) {
  for (const b of page.querySelectorAll('[data-act="msMetric"]')) {
    const on = b.dataset.k === metric;
    b.classList.toggle('on', on);
    if (b.classList.contains('chip')) b.setAttribute('aria-pressed', String(on));
  }
  for (const g of page.querySelectorAll('.ms-body .tape')) {
    const on = g.dataset.k === metric;
    g.classList.toggle('on', on);
    g.querySelector('.dot')?.setAttribute('r', String(on ? DOT_ON : DOT_R));
  }
  const { sub, body } = chartParts(list(), metric);
  const subEl = page.querySelector('[data-ms-chart-sub]');
  if (subEl) subEl.textContent = sub;
  page.querySelector('[data-ms-chart-card]').innerHTML = body;
  drawChart(page);
}

// Тап по подписи на фигуре или плитке: график может быть далеко внизу — прокручиваем к нему
function revealChart() {
  const title = document.querySelector('[data-ms-dyn]');
  const card = document.querySelector('[data-ms-chart-card]');
  if (!title || !card) return;
  const bar = document.querySelector('.ms-page .bottom-bar .inner');
  const bottom = bar ? bar.getBoundingClientRect().top : window.innerHeight;
  const top = title.getBoundingClientRect().top;
  if (top >= 0 && card.getBoundingClientRect().bottom <= bottom) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: Math.max(0, window.scrollY + top - 8), behavior: reduce ? 'auto' : 'smooth' });
}

function pickMetric({ k }, el) {
  if (!CHART_METRICS.some(([m]) => m === k)) return;
  const page = document.querySelector('.ms-page');
  // Пустой экран (замеров ещё нет): графика нет, переключать нечего
  if (!page?.querySelector('[data-ms-chart-card]')) return;
  if (k !== metric) {
    ctx.haptic.tap();
    metric = k;
    applyMetric(page);
  }
  if (el?.closest?.('.ms-fig, .ms-grid')) revealChart();
}

function toggleHistory() {
  ctx.haptic.tap();
  showAll = !showAll;
  const page = document.querySelector('.ms-page');
  const box = page?.querySelector('.ms-hist');
  const more = page?.querySelector('[data-ms-more]');
  if (!box || !more) { ctx.render(); return; }
  const h = histParts(list());
  box.innerHTML = h.items;
  more.innerHTML = h.more;
  // Свернули длинный список — кнопка могла уехать вверх за экран
  if (!showAll) more.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
}

// ── Клавиатура ──────────────────────────────────────────────────────────────
// enterkeyhint="next" / "done" — только подпись клавиши; действие делаем сами:
// «Далее» — фокус в следующее поле, «Готово» на последнем — убрать клавиатуру

function onKey(e) {
  if (e.key !== 'Enter' || e.isComposing) return;
  const input = e.target?.closest?.('.ms-form input[data-bind^="ms."]');
  if (!input) return;
  e.preventDefault();
  const all = [...input.closest('.ms-form').querySelectorAll('input[data-bind^="ms."]')];
  const next = all[all.indexOf(input) + 1];
  if (next) {
    next.focus();
    next.select?.();
  } else input.blur();
}

let installed = false;
function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', (e) => { lastTap = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
}

// ── Профиль ─────────────────────────────────────────────────────────────────

function profileLink() {
  const entries = list();
  const last = entries[entries.length - 1];
  let sub = 'Добавь первый замер';
  if (last) {
    const w = fieldStats(entries, 'waist');
    sub = `Последний: ${sd(last[0])}`;
    if (w && w.count > 1) sub += ` · талия ${w.delta ? `${signed(w.delta)} см` : 'без изменений'}`;
    else if (w) sub += ` · талия ${n1(w.value)} см`;
  }
  return `<button class="list-item" data-act="push" data-name="msHome"><div class="icon-box">${ctx.icon('ruler')}</div><div class="grow"><div class="h3">Замеры тела</div><div class="sub small">${sub}</div></div><span class="muted">${ctx.icon('right')}</span></button>`;
}

export default {
  id: 'measures',
  keys: [KEY],
  screens: { msHome: screenHome },
  sheets: { msAdd: sheetAdd, msEntry: sheetEntry },
  actions: {
    // Дата фиксируется при открытии: в полночь форма не перескочит на другой день
    msAdd: (ds, el, ev) => {
      if (justClosed(ev)) return;
      draft = null;
      ctx.openSheet('msAdd', { date: ctx.dkey(), fresh: 1 });
    },
    msEdit: ({ date }) => { draft = null; ctx.openSheet('msAdd', { date }); },
    msOpen: ({ date }, el, ev) => { if (!justClosed(ev)) ctx.openSheet('msEntry', { date }); },
    msMetric: pickMetric,
    msMore: toggleHistory,
    msStep: stepField,
    msSave: saveForm,
    msDel: removeEntry,
  },
  binds: Object.fromEntries(FIELDS.map((f) => [`ms.${f.k}`, (v) => onInput(f.k, v)])),
  slots: { 'profile.links': profileLink },
  on: {
    reset: () => { metric = 'waist'; showAll = false; draft = null; },
  },
  unmount() {
    if (typeof document === 'undefined') return;
    hadPage = !!document.querySelector('.ms-page');
    const ms = document.querySelector('.sheet [data-ms-sheet]');
    hadSheet = ms ? ms.dataset.msSheet : null;
    sheetScroll = ms ? document.querySelector('.sheet')?.scrollTop || 0 : 0;
    const form = formEl();
    if (form) captureDraft(form);
  },
  mount(root) {
    install();
    const page = root.querySelector('.ms-page');
    // Тот же экран перерисован (сохранение, смена темы) — без повторной анимации появления
    if (page && hadPage) page.style.animation = 'none';
    const nowSheet = root.querySelector('.sheet [data-ms-sheet]')?.dataset.msSheet || null;
    if (hadSheet && !nowSheet) closed = tapMark();
    if (nowSheet && nowSheet !== hadSheet) opened = tapMark();
    const form = root.querySelector('.sheet .ms-form');
    if (!form) draft = null;
    if (nowSheet && nowSheet === hadSheet) {
      // Та же шторка после перерисовки ядра: не выезжает заново, прокрутка и фокус на месте
      const sh = root.querySelector('.sheet');
      for (const el of [sh, root.querySelector('.sheet-bg')]) if (el) el.style.animation = 'none';
      if (sh) sh.scrollTop = sheetScroll;
      const fo = form && draft?.focus;
      const input = fo && form.querySelector(`input[data-bind="ms.${fo.k}"]`);
      if (input) {
        input.focus({ preventScroll: true });
        try { input.setSelectionRange(fo.s, fo.e); } catch { /* поле без выделения */ }
      }
    }
    if (page) drawChart(page);
    hadPage = false;
    hadSheet = null;
  },
};
