// Модуль «Сканер штрих-кодов»: живая камера (BarcodeDetector или ZXing), фото, ручной ввод,
// поиск КБЖУ в Open Food Facts и свои продукты по коду (ключ myFoods).
//
// Жизненный цикл камеры: ядро пересобирает DOM на каждый render(), поэтому поток и цикл
// распознавания живут здесь, а mount() только привязывает их к новому <video>.
// Ушли с экрана bcScan, вкладка скрыта, страница закрывается — поток останавливается.
import { ctx } from '../core.js';

export const MY_KEY = 'myFoods';
export const MY_MAX = 20;
export const MAX_JSON = 4096;
const NAME_MAX = 40;
const OFF_API = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = 'code,product_name,product_name_ru,generic_name,brands,quantity,serving_quantity,serving_size,image_front_small_url,nutriments';
// Два зеркала одного и того же файла: хэш (SRI) у них совпадает, второе — если первое недоступно
const ZXING_URLS = [
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
  'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
];
const ZXING_SRI = 'sha384-BzBxP10ZE72aitqj5UMmUsbKFliP/DZqA8Wq+BNNhlIJDGoEd1tpkMYXOg9+n6sB';
const ZXING_TIMEOUT = 15000; // на одно зеркало
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const LOOKUP_TIMEOUT = 10000;
const REPEAT_MS = 3000; // тот же код подряд не обрабатываем, пока он не пропадёт из кадра на 3 с
const HINT_MS = 12000; // через сколько подсказать «поднеси ближе»

// ── Чистые функции (покрыты тестами) ─────────────────

const digits = (s) => String(s ?? '').replace(/\D/g, '');
const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, max) => Math.max(0, Math.min(max, x));
const text = (v, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');

function numOr(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(x) && x >= 0 ? x : null;
}

// Контрольная цифра GTIN (EAN-8, UPC-A, EAN-13, GTIN-14): веса 3,1,3… справа налево
function gtinOk(s) {
  let sum = 0;
  for (let i = s.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += (s.charCodeAt(i) - 48) * w;
  return (10 - (sum % 10)) % 10 === s.charCodeAt(s.length - 1) - 48;
}

// UPC-E (8 цифр) → UPC-A (12 цифр); '' если это не UPC-E
export function upcEtoA(code) {
  const s = digits(code);
  if (s.length !== 8 || (s[0] !== '0' && s[0] !== '1')) return '';
  const [n, x1, x2, x3, x4, x5, x6, c] = s;
  let body;
  if (x6 <= '2') body = `${x1}${x2}${x6}0000${x3}${x4}${x5}`;
  else if (x6 === '3') body = `${x1}${x2}${x3}00000${x4}${x5}`;
  else if (x6 === '4') body = `${x1}${x2}${x3}${x4}00000${x5}`;
  else body = `${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  const a = n + body + c;
  return gtinOk(a) ? a : '';
}

// 8–14 цифр с верной контрольной суммой (EAN-13, EAN-8, UPC-A, GTIN-14, UPC-E)
export function validBarcode(code) {
  const s = String(code ?? '').trim();
  if (!/^\d{8,14}$/.test(s) || /^0+$/.test(s)) return false;
  if ([8, 12, 13, 14].includes(s.length) && gtinOk(s)) return true;
  return s.length === 8 && !!upcEtoA(s);
}

// Внутренний код магазина (GS1 «ограниченного обращения»): EAN-13 на «2» и UPC-A на «2».
// Такие коды печатают весы на весовом товаре — вес или цена зашиты в код, и у каждой упаковки
// он свой. Сам код не гарантирует, что в следующий раз попадётся тот же продукт.
export function isStoreCode(code) {
  const s = String(code ?? '');
  return (s.length === 13 || s.length === 12) && s[0] === '2';
}

// Привести распознанный код к виду для поиска (UPC-E разворачиваем в UPC-A)
export function normBarcode(raw, format = '') {
  const s = digits(raw);
  if (s.length === 8 && (format === 'upc_e' || !gtinOk(s))) return upcEtoA(s) || s;
  return s;
}

// '330 ml' → 330, '1,5 л' → 1500, '0.5 kg' → 500; мультипаки и непонятное → 0
export function parseQty(s) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(g|gr|гр?|ml|мл|cl|kg|кг|l|л)\.?\s*$/i.exec(String(s ?? ''));
  if (!m) return 0;
  const mult = { kg: 1000, 'кг': 1000, l: 1000, 'л': 1000, cl: 10 }[m[2].toLowerCase()] || 1;
  const g = Math.round(parseFloat(m[1].replace(',', '.')) * mult);
  return g >= 1 && g <= 5000 ? g : 0;
}

function parseServing(p) {
  let g = numOr(p.serving_quantity);
  if (!g) {
    const m = /(\d+(?:[.,]\d+)?)\s*(?:g|gr|гр?|ml|мл)(?![a-zа-я])/i.exec(String(p.serving_size ?? ''));
    g = m ? parseFloat(m[1].replace(',', '.')) : 0;
  }
  g = Math.round(g || 0);
  return g >= 1 && g <= 2000 ? g : 0;
}

// Ответ Open Food Facts v2 → продукт (КБЖУ на 100 г) или null, если не найден
export function parseOff(json) {
  if (!json || typeof json !== 'object' || json.status === 0 || json.status === '0') return null;
  const p = json.product;
  if (!p || typeof p !== 'object') return null;
  const n = p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {};
  let k = numOr(n['energy-kcal_100g']);
  if (k === null) {
    const kj = numOr(n.energy_100g) ?? numOr(n['energy-kj_100g']);
    if (kj !== null) k = kj / 4.184;
  }
  const pr = numOr(n.proteins_100g);
  const fa = numOr(n.fat_100g);
  const ca = numOr(n.carbohydrates_100g);
  // Энергии нет, а БЖУ есть — оценим по Этуотеру (4/9/4)
  if (k === null && (pr !== null || fa !== null || ca !== null)) k = 4 * (pr || 0) + 9 * (fa || 0) + 4 * (ca || 0);
  const code = digits(p.code ?? json.code);
  const brand = text(String(typeof p.brands === 'string' ? p.brands : '').split(',')[0], 60);
  const name = text(p.product_name_ru) || text(p.product_name) || text(p.generic_name);
  const img = typeof p.image_front_small_url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(p.image_front_small_url) ? p.image_front_small_url : '';
  return {
    code,
    name: name || brand || (code ? `Продукт ${code}` : 'Продукт'),
    brand,
    qty: text(p.quantity, 40),
    img,
    k: Math.round(clamp(k ?? 0, 1000)),
    p: r1(clamp(pr ?? 0, 100)),
    f: r1(clamp(fa ?? 0, 100)),
    c: r1(clamp(ca ?? 0, 100)),
    serving: parseServing(p),
    pack: parseQty(p.quantity),
    incomplete: k === null,
  };
}

// myFoods: [[code, name, k, p, f, c, servingG|0], …] — новые сверху, ≤ 20, JSON ≤ 4096
export function unpackMyFoods(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!Array.isArray(r)) continue;
    const code = digits(r[0]);
    const name = text(r[1], NAME_MAX);
    if (code.length < 8 || code.length > 14 || seen.has(code) || !name) continue;
    seen.add(code);
    const v = (x, max) => clamp(numOr(x) ?? 0, max);
    out.push({ code, name, k: Math.round(v(r[2], 1000)), p: r1(v(r[3], 100)), f: r1(v(r[4], 100)), c: r1(v(r[5], 100)), serving: Math.round(v(r[6], 2000)) });
    if (out.length >= MY_MAX) break;
  }
  return out;
}

export function packMyFoods(list, limit = MAX_JSON) {
  const rows = [];
  const seen = new Set();
  for (const x of list || []) {
    const code = digits(x?.code);
    const name = text(x?.name, NAME_MAX);
    if (code.length < 8 || code.length > 14 || seen.has(code) || !name) continue;
    seen.add(code);
    const v = (y, max) => clamp(numOr(y) ?? 0, max);
    rows.push([code, name, Math.round(v(x.k, 1000)), r1(v(x.p, 100)), r1(v(x.f, 100)), r1(v(x.c, 100)), Math.round(v(x.serving, 2000))]);
    if (rows.length >= MY_MAX) break;
  }
  while (rows.length && JSON.stringify(rows).length > limit) rows.pop();
  return rows;
}

// Добавить/поднять продукт наверх (дубль по коду заменяется)
export function addMyFood(raw, food, limit = MAX_JSON) {
  const code = digits(food?.code);
  return packMyFoods([food, ...unpackMyFoods(raw).filter((x) => x.code !== code)], limit);
}

// ── Состояние модуля ─────────────────────────────────

const st = {
  cam: 'idle', // idle | starting | live | paused | denied | nocam | unsupported | error | noengine
  torchOk: false,
  torch: false,
  hint: false,
  code: '',
  codeErr: '',
  photo: 'idle', // idle | busy | fail | noengine
};

// Состояние экрана сканера — с чистого листа (при уходе с экрана, входе и сбросе данных)
function resetScreen() {
  if (!stream && st.cam !== 'starting') st.cam = 'idle';
  st.photo = 'idle';
  st.code = '';
  st.codeErr = '';
  st.hint = false;
}
const cache = new Map(); // code → {status: 'loading'|'ok'|'notfound'|'error', food}
const drafts = {}; // code → {name, k, p, f, c} — форма «вручную»
const mode = {}; // code → 'form' (принудительно показать форму)
const gramsBy = {}; // code → граммовка в шторке
let sheetCode = '';
let stream = null;
let videoEl = null;
let camToken = 0;
let photoToken = 0; // растёт при каждом новом фото и при входе/уходе с экрана — старый результат отбрасываем
let looping = false;
let loopId = 0;
let liveSince = 0;
let onScreen = false;
let sheetWasOpen = false;
let installed = false;
let seen = { code: '', at: 0 };
let engine = null; // 'native' | 'zxing'
let nativeState = null; // null — не проверяли, true/false
let detector = null;
let zxSrcPromise = null; // исходник ZXing (текст), проверенный по хэшу
let zxPromise = null;
let zx = null; // {Z, fast, hard} — два ридера ZXing в главном потоке (кадры камеры)
let worker = null; // {w, ready, jobs, seq, abort} — распознавание фото в фоновом потоке
let workerBroken = false; // воркер не завёлся — фото распознаём в главном потоке
let canvas = null;
let epoch = 0; // растёт при «Сбросить данные»: поздние ответы OFF уже ничего не пишут
const inflight = new Set(); // AbortController текущих запросов к OFF

const esc = (s) => ctx.esc(s);
const icon = (n, c) => ctx.icon(n, c);
const fmt1 = (x) => ctx.fmt(x, Number.isInteger(r1(+x || 0)) ? 0 : 1);
const myList = () => unpackMyFoods(ctx.S?.()?.[MY_KEY]);
const findMy = (code) => myList().find((x) => x.code === code) || null;

function saveMy(food) {
  ctx.save(MY_KEY, addMyFood(ctx.S()[MY_KEY], food));
}

// ── Камера ───────────────────────────────────────────

const sheetOpen = () => !!ctx.sheet?.();

// Мини-апп свёрнут или во вкладке Telegram, которая сейчас не активна (Bot API 8.0+: события
// activated/deactivated). WebView при этом может оставаться «видимым» для document.hidden.
// У старых клиентов isActive нет — считаем активным.
const tgActive = () => ctx.tg?.isActive !== false;
const canRun = () => !document.hidden && tgActive();

// Камеру сейчас включать нельзя (вкладка скрыта / мини-апп свёрнут) — пауза до возвращения
function pauseCam() {
  if (stream || st.cam === 'starting') stopCam();
  setCam('paused');
}

async function startCam() {
  if (stream || st.cam === 'starting') return;
  if (!navigator.mediaDevices?.getUserMedia) { setCam('unsupported'); return; }
  if (!canRun()) { pauseCam(); return; }
  const token = ++camToken;
  setCam('starting');
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    // Пока ждали разрешения, ушли с экрана или свернули приложение — сразу гасим
    if (token !== camToken || !onScreen || !canRun()) {
      s.getTracks().forEach((t) => t.stop());
      if (token === camToken) {
        stopCam(); // 'starting' → 'idle'
        if (onScreen) setCam('paused'); // включим, когда приложение снова станет активным
      }
      return;
    }
    stream = s;
    const track = s.getVideoTracks()[0];
    let caps = {};
    try { caps = track?.getCapabilities?.() || {}; } catch { /* нет getCapabilities */ }
    st.torchOk = !!caps.torch;
    st.torch = false;
    track?.addEventListener('ended', () => {
      if (stream !== s) return;
      stopCam();
      setCam('error');
    });
    liveSince = Date.now();
    st.hint = false;
    setCam('live');
    startLoop();
  } catch (e) {
    if (token !== camToken) return;
    const n = e?.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') setCam('denied');
    else if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') setCam('nocam');
    else if (n === 'TypeError') setCam('unsupported');
    else setCam('error');
  }
}

function stopCam() {
  camToken++;
  stopLoop();
  if (stream) stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* уже остановлен */ } });
  stream = null;
  if (videoEl) { try { videoEl.srcObject = null; } catch { /* ignore */ } }
  videoEl = null;
  st.torch = false;
  st.torchOk = false;
  if (['starting', 'live'].includes(st.cam)) st.cam = 'idle';
}

function setCam(state) {
  st.cam = state;
  paintCam();
}

// Привязать поток к <video> после перерисовки. Старый элемент (если он ещё играет)
// переносим на место нового в той же задаче — так картинка не мигает.
function attachVideo(root) {
  const fresh = root.querySelector('video[data-bc-video]');
  if (!fresh) { videoEl = null; return; }
  if (!stream) { videoEl = fresh; return; }
  if (videoEl && videoEl !== fresh && !videoEl.isConnected && videoEl.srcObject === stream) {
    fresh.replaceWith(videoEl);
  } else {
    fresh.muted = true;
    if (fresh.srcObject !== stream) fresh.srcObject = stream;
    videoEl = fresh;
  }
  videoEl.play?.()?.catch?.(() => {});
}

async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !st.torch }] });
    st.torch = !st.torch;
    ctx.haptic.tap();
    document.querySelector('[data-act="bcTorch"]')?.classList.toggle('on', st.torch);
  } catch {
    ctx.toast('Фонарик не включается на этом устройстве');
  }
}

// ── Распознавание ────────────────────────────────────

async function nativeOk() {
  if (nativeState !== null) return nativeState;
  try {
    if (typeof window.BarcodeDetector !== 'function') return (nativeState = false);
    const supported = await window.BarcodeDetector.getSupportedFormats();
    if (!supported.includes('ean_13')) return (nativeState = false);
    detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
    return (nativeState = true);
  } catch {
    return (nativeState = false);
  }
}

// Текст ZXing: зеркала по очереди, каждое — с проверкой хэша (fetch integrity) и своим таймаутом.
// Один и тот же текст идёт и в главный поток (камера), и в воркер (фото) — качаем один раз.
function zxSource() {
  if (zxSrcPromise) return zxSrcPromise;
  zxSrcPromise = (async () => {
    for (const url of ZXING_URLS) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl?.abort(), ZXING_TIMEOUT);
      try {
        const res = await fetch(url, { integrity: ZXING_SRI, mode: 'cors', credentials: 'omit', signal: ctrl?.signal });
        if (res.ok) {
          const src = await res.text();
          if (src.length > 1000) return src;
        }
      } catch { /* недоступно или не тот файл — следующее зеркало */ } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('zxing load');
  })();
  zxSrcPromise.catch(() => { zxSrcPromise = null; }); // в следующий раз попробуем снова
  return zxSrcPromise;
}

// Фоновая загрузка, пока человек целится камерой или делает снимок: первое фото не ждёт сеть
function preloadEngine() {
  nativeOk().then((ok) => { if (!ok && onScreen) zxSource().catch(() => {}); });
}

function zxReaders(Z) {
  const formats = [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E];
  const reader = (tryHard) => {
    const r = new Z.MultiFormatReader();
    const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, formats]]);
    if (tryHard) hints.set(Z.DecodeHintType.TRY_HARDER, true);
    r.setHints(hints);
    return r;
  };
  // fast — для кадров с камеры, hard — тщательнее (и с поворотом), но заметно дольше
  return { Z, fast: reader(false), hard: reader(true) };
}

// ZXing в главном потоке — для кадров с камеры (и для фото, если воркер не завёлся)
function loadZXing() {
  if (zx) return Promise.resolve(zx);
  if (zxPromise) return zxPromise;
  zxPromise = (async () => {
    if (!window.ZXing?.MultiFormatReader) {
      const src = await zxSource();
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = url;
          s.onload = resolve;
          s.onerror = () => { s.remove(); reject(new Error('zxing load')); };
          document.head.appendChild(s);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      if (!window.ZXing?.MultiFormatReader) throw new Error('zxing missing');
    }
    zx = zxReaders(window.ZXing);
    return zx;
  })();
  zxPromise.catch(() => { zxPromise = null; });
  return zxPromise;
}

// Воркер для фото: тщательный поиск по 12-Мп снимку занимает секунды на среднем телефоне —
// в главном потоке это замораживало интерфейс и кнопку «Назад» Telegram.
// Код воркера приклеивается к тексту ZXing в одном Blob (хэш ZXing уже проверен).
const WORKER_SRC = `
;(function () {
  var Z = self.ZXing, F = Z.BarcodeFormat;
  function reader(hard) {
    var r = new Z.MultiFormatReader();
    var h = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E]]]);
    if (hard) h.set(Z.DecodeHintType.TRY_HARDER, true);
    r.setHints(h);
    return r;
  }
  var fast = reader(false), hard = reader(true);
  function decode(lum, w, h, r) {
    try {
      var res = r.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, w, h))));
      return { text: res.getText(), format: String(F[res.getBarcodeFormat()] || '').toLowerCase() };
    } catch (e) { return null; }
  }
  self.onmessage = function (e) {
    var d = e.data, w = d.w, h = d.h, n = w * h, px = new Uint8ClampedArray(d.buf), lum = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; j < n; i += 4, j++) lum[j] = px[i + 3] === 0 ? 255 : (px[i] * 306 + px[i + 1] * 601 + px[i + 2] * 117 + 512) >> 10;
    var out = decode(lum, w, h, d.hard ? hard : fast);
    if (!out && d.hard) {
      // RGBLuminanceSource не умеет поворот (у канваса в главном потоке он есть) — повернём сами:
      // код могли снять боком
      var rot = new Uint8ClampedArray(n);
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) rot[(w - 1 - x) * h + y] = lum[y * w + x];
      out = decode(rot, h, w, hard);
    }
    self.postMessage({ id: d.id, res: out });
  };
  self.postMessage({ ready: true });
})();`;

function getWorker() {
  if (worker) return worker.ready;
  if (workerBroken || typeof Worker !== 'function' || typeof Blob !== 'function') return Promise.resolve(null);
  const wk = { w: null, jobs: new Map(), seq: 0, abort: null };
  worker = wk;
  const ready = zxSource().then((src) => new Promise((resolve, reject) => {
    if (worker !== wk) { resolve(null); return; } // пока качали, ушли с экрана
    wk.abort = () => resolve(null);
    let url = '';
    const fail = () => {
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
      killWorker(wk);
      workerBroken = true;
      reject(new Error('worker'));
    };
    const timer = setTimeout(fail, 10000);
    try {
      url = URL.createObjectURL(new Blob([src, WORKER_SRC], { type: 'text/javascript' }));
      wk.w = new Worker(url);
    } catch { fail(); return; }
    wk.w.onmessage = (e) => {
      const d = e.data || {};
      if (d.ready) { clearTimeout(timer); URL.revokeObjectURL(url); url = ''; resolve(wk); return; }
      const job = wk.jobs.get(d.id);
      if (job) { wk.jobs.delete(d.id); job(d.res || null); }
    };
    // Ошибка до «ready» — воркер не завёлся; после — упал на снимке. В обоих случаях дальше без него
    wk.w.onerror = (e) => { e.preventDefault?.(); fail(); };
  }));
  // Сеть: ошибку отдаём наверх («не загрузилось распознавание»); воркер: молча в главный поток.
  // null — воркера нет (не завёлся или его уже остановили)
  wk.ready = ready.catch((e) => {
    if (worker === wk) worker = null;
    if (e?.message === 'worker') return null;
    throw e;
  });
  return wk.ready;
}

// Остановить воркер (ушли со сканера): текущее распознавание прерывается сразу
function killWorker(wk = worker) {
  if (!wk) return;
  if (worker === wk) worker = null;
  try { wk.w?.terminate(); } catch { /* уже остановлен */ }
  for (const job of wk.jobs.values()) job(null);
  wk.jobs.clear();
  wk.abort?.();
}

function workerDecode(wk, w, h, buf, hard) {
  return new Promise((resolve) => {
    if (!wk.w || worker !== wk) { resolve(null); return; }
    const id = ++wk.seq;
    wk.jobs.set(id, resolve);
    wk.w.postMessage({ id, w, h, buf, hard }, [buf]);
  });
}

async function prepareEngine() {
  if (engine) return engine;
  if (await nativeOk()) engine = 'native';
  else { await loadZXing(); engine = 'zxing'; }
  return engine;
}

function zxDecode(cv, tryHard) {
  if (!zx) return null;
  const { Z } = zx;
  try {
    const src = new Z.HTMLCanvasElementLuminanceSource(cv);
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
    const res = (tryHard ? zx.hard : zx.fast).decodeWithState(bmp);
    const fmtName = String(Z.BarcodeFormat[res.getBarcodeFormat()] || '').toLowerCase();
    const code = normBarcode(res.getText(), fmtName);
    return validBarcode(code) ? code : null;
  } catch {
    return null; // NotFound / Checksum / Format — в кадре нет кода
  }
}

function getCanvas() {
  if (!canvas) canvas = document.createElement('canvas');
  return canvas;
}

// Кадр с видео: вырезаем область рамки (с запасом), чтобы ZXing работал быстрее
function zxFrame(v) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return null;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  const frame = document.querySelector('[data-bc-frame]');
  const vr = v.getBoundingClientRect();
  if (frame && vr.width && vr.height) {
    const fr = frame.getBoundingClientRect();
    const scale = Math.max(vr.width / vw, vr.height / vh); // object-fit: cover
    const ox = (vr.width - vw * scale) / 2;
    const oy = (vr.height - vh * scale) / 2;
    const padX = fr.width * 0.12;
    const padY = fr.height * 0.25;
    sx = Math.max(0, (fr.left - vr.left - ox - padX) / scale);
    sy = Math.max(0, (fr.top - vr.top - oy - padY) / scale);
    sw = Math.min(vw - sx, (fr.width + padX * 2) / scale);
    sh = Math.min(vh - sy, (fr.height + padY * 2) / scale);
    if (sw < 40 || sh < 40) { sx = 0; sy = 0; sw = vw; sh = vh; }
  }
  const k = Math.min(1, 800 / sw);
  const cv = getCanvas();
  cv.width = Math.round(sw * k);
  cv.height = Math.round(sh * k);
  cv.getContext('2d', { willReadFrequently: true }).drawImage(v, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  return zxDecode(cv, false);
}

async function detectFrame(v) {
  if (engine === 'native') {
    const found = await detector.detect(v);
    for (const b of found || []) {
      const code = normBarcode(b.rawValue, b.format);
      if (validBarcode(code)) return code;
    }
    return null;
  }
  return zxFrame(v);
}

// Кадр стоит распознавать: видео на экране хотя бы наполовину, человек не печатает в поле,
// шторка закрыта и фото сейчас не распознаётся (иначе зря грузим главный поток)
function frameWanted(v) {
  if (!v || !v.isConnected || v.readyState < 2 || document.hidden || sheetOpen() || st.photo === 'busy') return false;
  const a = document.activeElement;
  if (a && a.matches?.('input:not([type="file"]), textarea, [contenteditable="true"]')) return false;
  const r = v.getBoundingClientRect();
  const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  return r.height > 0 && visible >= r.height / 2;
}

function startLoop() {
  if (looping) return;
  looping = true;
  const id = ++loopId;
  (async () => {
    try {
      await prepareEngine();
    } catch {
      if (id !== loopId) return;
      stopCam();
      setCam('noengine');
      return;
    }
    if (id === loopId) paintStatus();
    while (looping && id === loopId) {
      const v = videoEl;
      if (frameWanted(v)) {
        let code = null;
        try { code = await detectFrame(v); } catch { code = null; }
        if (id !== loopId) return;
        if (code) onDetected(code);
        else if (!st.hint && Date.now() - liveSince > HINT_MS) { st.hint = true; paintStatus(); }
      }
      await new Promise((r) => setTimeout(r, engine === 'native' ? 125 : 180));
    }
  })();
}

function stopLoop() {
  looping = false;
  loopId++;
}

function onDetected(code) {
  const now = Date.now();
  const repeat = code === seen.code && now - seen.at < REPEAT_MS;
  seen = { code, at: now };
  if (repeat) return;
  ctx.haptic.ok();
  openProduct(code);
}

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* попробуем через <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// Проходы по фото: сначала быстрые (без TRY_HARDER, дёшево — чёткий код находится сразу),
// потом тщательные (все строки + поворот). Повтор того же размера и режима пропускаем.
const PHOTO_PASSES = [[800, false], [1280, false], [800, true], [1280, true], [1800, true]];

// Распознать код на фото: BarcodeDetector по ImageBitmap или ZXing (в воркере; если его нет —
// в главном потоке) по канвасу в нескольких масштабах.
// alive() → false — результат уже не нужен (ушли с экрана, выбрали другое фото): бросаем работу.
async function decodeFile(file, alive = () => true) {
  if (await nativeOk()) {
    try {
      const bmp = await createImageBitmap(file);
      const found = await detector.detect(bmp);
      bmp.close?.();
      for (const b of found || []) {
        const code = normBarcode(b.rawValue, b.format);
        if (validBarcode(code)) return code;
      }
      return null;
    } catch { /* упадём на ZXing */ }
  }
  let wk = await getWorker(); // сеть недоступна → исключение «zxing load»
  if (!alive()) return null;
  if (!wk) await loadZXing();
  if (!alive()) return null;
  const img = await loadImage(file);
  try {
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    if (!w || !h) return null;
    const cv = document.createElement('canvas'); // свой канвас: цикл камеры может работать параллельно
    const g = cv.getContext('2d', { willReadFrequently: true });
    const done = new Set();
    for (const [max, hard] of PHOTO_PASSES) {
      const k = Math.min(1, max / Math.max(w, h));
      const cw = Math.round(w * k);
      const ch = Math.round(h * k);
      const key = `${cw}x${ch}:${hard}`;
      if (done.has(key)) continue;
      done.add(key);
      // Между проходами отдаём управление: интерфейс отвечает, «Назад» срабатывает сразу
      await yieldUI();
      if (!alive()) return null;
      if (wk && worker !== wk) {
        // Воркер упал на снимке — доделаем в главном потоке
        wk = null;
        await loadZXing();
        if (!alive()) return null;
      }
      cv.width = cw;
      cv.height = ch;
      g.drawImage(img, 0, 0, cw, ch);
      let code = null;
      if (wk) {
        const res = await workerDecode(wk, cw, ch, g.getImageData(0, 0, cw, ch).data.buffer, hard);
        if (!alive()) return null;
        code = res ? normBarcode(res.text, res.format) : null;
        if (!validBarcode(code)) code = null;
      } else {
        code = zxDecode(cv, hard);
      }
      if (code) return code;
    }
    return null;
  } finally {
    img.close?.();
  }
}

async function onPhoto(files, el) {
  const file = files?.[0];
  if (el) el.value = ''; // чтобы то же фото можно было выбрать снова
  if (!file || st.photo === 'busy' || !onScreen) return;
  const token = ++photoToken;
  const alive = () => token === photoToken && onScreen;
  st.photo = 'busy';
  paintPhoto();
  let code = null;
  let noEngine = false;
  try { code = await decodeFile(file, alive); } catch (e) { noEngine = /^zxing/.test(e?.message || ''); }
  // Пока распознавали, ушли со сканера (или зашли заново) — молча отбрасываем результат
  if (!alive()) return;
  if (code) {
    st.photo = 'idle';
    paintPhoto();
    // Пока распознавали, открыли другой продукт (из недавних, вручную, с камеры) — не перебиваем его
    if (sheetOpen()) return;
    seen = { code, at: Date.now() };
    ctx.haptic.ok();
    openProduct(code);
  } else {
    st.photo = noEngine ? 'noengine' : 'fail';
    ctx.haptic.warn();
    paintPhoto();
  }
}

// ── Поиск в Open Food Facts ──────────────────────────

async function lookup(code) {
  const cur = cache.get(code);
  if (cur && cur.status !== 'error') return;
  cache.set(code, { status: 'loading' });
  const ep = epoch;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  if (ctrl) inflight.add(ctrl);
  const timer = setTimeout(() => ctrl?.abort(), LOOKUP_TIMEOUT);
  let entry;
  try {
    const res = await fetch(`${OFF_API}${code}.json?fields=${OFF_FIELDS}`, { signal: ctrl?.signal, headers: { Accept: 'application/json' } });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if ((json && (json.status === 0 || json.status === '0')) || res.status === 404) entry = { status: 'notfound' };
    else if (!res.ok || !json) entry = { status: 'error' };
    else {
      const food = parseOff(json);
      entry = food ? { status: 'ok', food: { ...food, code, src: 'off' } } : { status: 'notfound' };
    }
  } catch {
    entry = { status: 'error' };
  } finally {
    clearTimeout(timer);
    if (ctrl) inflight.delete(ctrl);
  }
  // Пока ждали ответ, человек сбросил все данные — ничего не записываем
  if (ep !== epoch) return;
  cache.set(code, entry);
  if (entry.status === 'ok' && !entry.food.incomplete) saveMy(entry.food);
  if (entry.status === 'ok' && entry.food.incomplete) {
    drafts[code] = { name: entry.food.name, k: '', p: '', f: '', c: '' };
  }
  paintSheet(code);
}

function openProduct(code) {
  delete mode[code];
  const cur = cache.get(code);
  if (!cur || cur.status === 'error') {
    const mine = findMy(code);
    if (mine) cache.set(code, { status: 'ok', food: { ...mine, src: 'my' } });
    else lookup(code);
  }
  ctx.openSheet('bcProduct', { code });
}

// ── Разметка: экран сканера ──────────────────────────

const CAM_OFF = {
  denied: ['Нет доступа к камере', () => `Разреши доступ к камере${ctx.inTelegram ? ' для Telegram' : ''} в настройках — или сфотографируй код, или введи цифры ниже.`, true],
  nocam: ['Камера не найдена', 'На этом устройстве нет доступной камеры. Введи цифры со штрих-кода — это быстро.', false],
  unsupported: ['Камера здесь не запускается', 'В этом окне живая камера недоступна. Сфотографируй штрих-код или введи цифры — результат тот же.', false],
  error: ['Камера не запустилась', 'Возможно, она занята другим приложением. Попробуй ещё раз или воспользуйся способами ниже.', true],
  noengine: ['Не удалось загрузить распознавание', 'Проверь интернет и попробуй снова. А пока можно ввести цифры вручную.', true],
};

function statusText() {
  if (st.cam === 'paused') return 'Камера на паузе';
  if (st.cam === 'starting') return 'Включаем камеру…';
  if (st.cam === 'live' && !engine) return 'Готовим распознавание…';
  if (st.hint) return st.torchOk ? 'Поднеси ближе или включи фонарик' : 'Поднеси ближе и держи ровно';
  return 'Держи штрих-код в рамке';
}

function camInner() {
  const off = CAM_OFF[st.cam];
  if (off) {
    const [t, sub, retry] = off;
    const s = typeof sub === 'function' ? sub() : sub;
    return `<div class="card bc-off">
      <div class="icon-box bc-off-ico">${icon(st.cam === 'noengine' ? 'alert' : 'camera')}</div>
      <div class="grow"><div class="h3">${t}</div><div class="sub small">${s}</div>
      ${retry ? `<button class="btn ghost sm bc-retry" data-act="bcCamRetry">${icon('refresh', 'sm')} Попробовать снова</button>` : ''}</div>
    </div>`;
  }
  const live = st.cam === 'live';
  return `<div class="bc-view ${live ? 'live' : 'wait'}">
    <video data-bc-video playsinline muted autoplay></video>
    <div class="bc-frame" data-bc-frame><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>${live ? '<div class="bc-scan"><div></div></div>' : ''}</div>
    ${live || st.cam === 'paused' ? '' : '<div class="bc-spin light"></div>'}
    ${live && st.torchOk ? `<button class="bc-torch ${st.torch ? 'on' : ''}" data-act="bcTorch" aria-label="Фонарик">${icon('bolt')}</button>` : ''}
    <div class="bc-status" data-bc-status>${statusText()}</div>
  </div>`;
}

// Две кнопки: с capture телефон сразу открывает камеру (галереи там нет), без capture — выбор
// готового снимка. Обе ведут в один обработчик bcPhoto.
function photoInner() {
  const busy = st.photo === 'busy';
  const dis = busy ? 'disabled' : '';
  return `<div class="card bc-alt ${busy ? 'busy' : ''}">
      <div class="row"><div class="icon-box accent">${busy ? '<span class="bc-spin sm"></span>' : icon('camera')}</div>
        <div class="grow"><div class="h3">Сфотографировать <span class="bc-nw">штрих-код</span></div>
          <div class="sub small">${busy ? 'Распознаём фото…' : 'Камерой или из галереи'}</div></div></div>
      <div class="bc-pick-row">
        <label class="btn bc-pick" ${busy ? 'aria-disabled="true"' : ''}>
          <input class="bc-file" type="file" accept="image/*" capture="environment" data-file="bcPhoto" ${dis}>${icon('camera', 'sm')} Снять фото</label>
        <label class="btn ghost bc-pick" ${busy ? 'aria-disabled="true"' : ''}>
          <input class="bc-file" type="file" accept="image/*" data-file="bcPhoto" ${dis}>${icon('image', 'sm')} Из галереи</label>
      </div>
    </div>
    ${st.photo === 'fail' ? `<div class="notice bc-msg">${icon('alert', 'sm')}<div>На фото не нашли штрих-код. Сними ближе и ровно, чтобы полоски были чёткими, — или введи цифры.</div></div>` : ''}
    ${st.photo === 'noengine' ? `<div class="notice bc-msg">${icon('alert', 'sm')}<div>Не получилось загрузить распознавание — проверь интернет или введи цифры.</div></div>` : ''}`;
}

function recentHtml() {
  const list = myList().slice(0, 5);
  if (!list.length) return '';
  // «на 100 г» — один раз в заголовке; пары «Б 7,5» не разрываются переносом; имя — в две строки
  const pair = (l, v) => `<span class="bc-nw">${l} ${fmt1(v)}</span>`;
  return `<div class="section-title"><div class="h3">Недавно сканировал</div><span class="tiny muted bc-per100">на 100 г</span></div>
    <div class="card list bc-recent">${list.map((x) => `<button class="list-item" data-act="bcOpenCode" data-code="${esc(x.code)}">
      <div class="icon-box bc-ico">${icon('barcode', 'sm')}</div>
      <div class="grow"><div class="h3 bc-rname">${esc(x.name)}</div><div class="sub small num bc-rmac">${pair('Б', x.p)} · ${pair('Ж', x.f)} · ${pair('У', x.c)}</div></div>
      <span class="bc-rk"><b class="num">${ctx.fmt(x.k)}</b><span class="muted small">ккал</span></span></button>`).join('')}</div>`;
}

function scanScreen() {
  return `<div class="page no-tabs bc-page">
    ${ctx.backHeader('Штрих-код', 'Найдём КБЖУ по коду на упаковке')}
    <div data-bc-cam>${camInner()}</div>
    <div class="section-title"><div class="h3">Другие способы</div></div>
    <div data-bc-photo>${photoInner()}</div>
    <div class="card bc-manual">
      <div class="row"><div class="icon-box">${icon('keyboard')}</div>
        <div class="grow"><div class="h3">Ввести цифры вручную</div><div class="sub small">8–14 цифр под полосками</div></div></div>
      <div class="bc-code-row">
        <input class="input bc-code num" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="24" autocomplete="off" enterkeyhint="search"
          placeholder="4600000000000" value="${esc(st.code)}" data-bind="bcCode" aria-label="Цифры штрих-кода">
        <button class="btn" data-act="bcFind">Найти</button>
      </div>
      <div class="err" data-bc-code-err>${esc(st.codeErr)}</div>
    </div>
    ${recentHtml()}
  </div>`;
}

// Точечные обновления (без render — чтобы не терять фокус и не мигать видео)
function paintCam() {
  const box = typeof document !== 'undefined' && document.querySelector('[data-bc-cam]');
  if (!box) return;
  const old = box.querySelector('video[data-bc-video]');
  box.innerHTML = camInner();
  const fresh = box.querySelector('video[data-bc-video]');
  if (fresh && old) {
    fresh.replaceWith(old);
    videoEl = old;
  }
  attachVideo(box);
}

function paintStatus() {
  const el = document.querySelector('[data-bc-status]');
  if (el) el.textContent = statusText();
}

function paintPhoto() {
  const box = document.querySelector('[data-bc-photo]');
  if (box) box.innerHTML = photoInner();
}

function setCodeErr(msg) {
  st.codeErr = msg;
  const el = document.querySelector('[data-bc-code-err]');
  if (el) el.textContent = msg;
}

function findManual() {
  const code = digits(st.code);
  if (code.length < 8 || code.length > 14) { setCodeErr('Введи 8–14 цифр со штрих-кода'); ctx.haptic.warn(); return; }
  const norm = normBarcode(code);
  if (!validBarcode(norm)) { setCodeErr('Проверь цифры — похоже, в коде опечатка'); ctx.haptic.warn(); return; }
  setCodeErr('');
  document.activeElement?.blur?.();
  seen = { code: norm, at: Date.now() };
  openProduct(norm);
}

// ── Разметка: шторка продукта ────────────────────────

function calc(food, g) {
  const k = (+g || 0) / 100;
  return { k: food.k * k, p: food.p * k, f: food.f * k, c: food.c * k };
}

function totalHtml(food, g) {
  const t = calc(food, g);
  return `<div class="bc-total-k"><span class="tiny muted">${g > 0 ? `За ${ctx.fmt(g)} г` : 'Укажи граммы'}</span><b class="num">${ctx.fmt(t.k)}</b><span class="small muted">ккал</span></div>
    <div class="bc-total-m num">
      <div><span class="dot" style="background:var(--protein)"></span>Б <b>${fmt1(t.p)}</b></div>
      <div><span class="dot" style="background:var(--fat)"></span>Ж <b>${fmt1(t.f)}</b></div>
      <div><span class="dot" style="background:var(--carbs)"></span>У <b>${fmt1(t.c)}</b></div>
    </div>`;
}

function chipsHtml(food, g) {
  const opts = [];
  if (food.serving) opts.push([food.serving, `1 порция = ${ctx.fmt(food.serving)} г`]);
  if (food.serving !== 100) opts.push([100, '100 г']);
  if (food.pack && food.pack !== food.serving && food.pack !== 100 && food.pack <= 3000) opts.push([food.pack, `Упаковка = ${ctx.fmt(food.pack)} г`]);
  return opts.map(([v, t]) => `<button class="chip ${+g === v ? 'on' : ''}" data-act="bcG" data-g="${v}">${t}</button>`).join('');
}

function productView(code, food) {
  const g = gramsBy[code] ?? (food.serving || 100);
  const meta = [food.brand, food.qty].filter(Boolean).map(esc).join(' · ');
  const macro = (v, label, color) => `<div><b class="num">${fmt1(v)}</b><span>${color ? `<i class="dot" style="background:${color}"></i>` : ''}${label}</span></div>`;
  return `<div class="bc-prod">
      <div class="bc-thumb">${icon('food', 'lg')}${food.img ? `<img src="${esc(food.img)}" alt="" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}</div>
      <div class="grow">
        <div class="h2 bc-name">${esc(food.name)}</div>
        ${meta ? `<div class="sub small bc-meta">${meta}</div>` : ''}
        <div class="tiny muted num bc-codeline">${icon('barcode', 'xs')}${esc(code)}</div>
      </div>
    </div>
    <div class="bc-per">
      <div class="bc-per-h">На 100 г</div>
      <div class="bc-macros">${macro(food.k, 'ккал')}${macro(food.p, 'белки', 'var(--protein)')}${macro(food.f, 'жиры', 'var(--fat)')}${macro(food.c, 'углев.', 'var(--carbs)')}</div>
    </div>
    <div class="field bc-grams"><label>Сколько грамм</label>${ctx.stepper('bcGrams', g, 'г', 10)}</div>
    <div class="chips bc-chips" data-bc-chips>${chipsHtml(food, g)}</div>
    <div class="bc-total" data-bc-total>${totalHtml(food, +g)}</div>
    <div class="bc-foot tiny muted">${{ off: 'Данные: Open Food Facts', store: 'КБЖУ введены вручную' }[food.src] || 'Из твоих продуктов'} · <button class="bc-link" data-act="bcEdit" data-code="${esc(code)}">Исправить КБЖУ</button></div>
    <div class="bc-add-bar"><button class="btn block bc-add" data-act="bcAdd" data-code="${esc(code)}">${icon('plus')} Добавить в дневник</button></div>`;
}

function formView(code, title, sub) {
  const d = drafts[code] || (drafts[code] = { name: '', k: '', p: '', f: '', c: '' });
  const num = (key, label, ph) => `<label class="bc-f"><span>${label}</span>
    <input class="input num" type="text" inputmode="decimal" autocomplete="off" placeholder="${ph}" value="${esc(d[key])}" data-bind="bcm.${key}" data-code="${esc(code)}"></label>`;
  return `<div class="row top bc-form-head">
      <div class="icon-box accent">${icon('edit')}</div>
      <div class="grow"><div class="h2">${title}</div><div class="sub small" style="margin-top:4px">${sub}</div></div>
    </div>
    <label class="bc-f" style="margin-top:14px"><span>Название</span>
      <input class="input" maxlength="${NAME_MAX}" placeholder="Например, йогурт греческий" value="${esc(d.name)}" data-bind="bcm.name" data-code="${esc(code)}"></label>
    <div class="bc-per-h" style="margin-top:14px">На 100 г — как на упаковке</div>
    <div class="grid-2 bc-form-grid">${num('k', 'Калории', 'ккал')}${num('p', 'Белки', 'г')}${num('f', 'Жиры', 'г')}${num('c', 'Углеводы', 'г')}</div>
    <div class="err" data-bc-m-err></div>
    <button class="btn block" data-act="bcSave" data-code="${esc(code)}">${icon('check')} Сохранить продукт</button>`;
}

function sheetBody(code) {
  const mine = cache.has(code) ? null : findMy(code);
  const e = cache.get(code) || (mine ? { status: 'ok', food: { ...mine, src: 'my' } } : null);
  const codeLine = `<span class="num">${esc(code)}</span>`;
  const store = isStoreCode(code);
  const later = store
    ? 'Такие коды магазин печатает на весовых товарах — у каждой упаковки свой. Перепиши КБЖУ с этикетки.'
    : 'Перепиши КБЖУ с упаковки — сохраним, и в следующий раз найдём сразу.';
  const form = mode[code] === 'form';
  if (!e || e.status === 'loading') {
    return `<div class="bc-wait-box"><span class="bc-spin"></span><div class="h3">Ищем продукт…</div>
      <div class="sub small">Код ${codeLine} · база Open Food Facts</div></div>`;
  }
  if (e.status === 'error' && !form) {
    return `<div class="bc-wait-box"><div class="icon-box bc-err-ico">${icon('alert')}</div>
      <div class="h3">Нет связи с базой продуктов</div>
      <div class="sub small">Проверь интернет и попробуй ещё раз — или впиши КБЖУ с упаковки сам.</div></div>
      <div class="row bc-btns"><button class="btn ghost grow" data-act="bcManual" data-code="${esc(code)}">${icon('edit', 'sm')} Вручную</button>
      <button class="btn grow" data-act="bcRetry" data-code="${esc(code)}">${icon('refresh', 'sm')} Повторить</button></div>`;
  }
  if (e.status === 'error') return formView(code, 'Добавить продукт вручную', `Код ${codeLine}. ${later}`);
  if (e.status === 'notfound') return formView(code, store ? 'Этого кода нет в общей базе' : 'Такого продукта нет в базе', `Код ${codeLine}. ${later}`);
  if (e.food.incomplete) return formView(code, 'Нашли продукт, но без КБЖУ', `Код ${codeLine}. Перепиши значения на 100 г с упаковки.`);
  if (form) return formView(code, 'Исправить КБЖУ', `Код ${codeLine}. ${store ? 'Поправь значения на 100 г.' : 'Поправь значения — сохраним как твой продукт.'}`);
  return productView(code, e.food);
}

function productSheet({ code }) {
  code = digits(code);
  sheetCode = code;
  return `<div class="bc-sheet" data-bc-sheet="${esc(code)}">${sheetBody(code)}</div>`;
}

function paintSheet(code) {
  const el = document.querySelector('[data-bc-sheet]');
  if (el && el.dataset.bcSheet === code) el.innerHTML = sheetBody(code);
}

function currentFood() {
  const e = cache.get(sheetCode);
  if (e?.status === 'ok' && !e.food.incomplete) return e.food;
  return findMy(sheetCode);
}

function gramsInput() {
  return document.querySelector('input[data-bind="bcGrams"]');
}

function recalc(v) {
  const food = currentFood();
  if (!food) return;
  const g = Math.max(0, +(v ?? gramsInput()?.value) || 0);
  gramsBy[sheetCode] = g;
  const tot = document.querySelector('[data-bc-total]');
  if (tot) tot.innerHTML = totalHtml(food, g);
  document.querySelectorAll('[data-bc-chips] .chip').forEach((c) => c.classList.toggle('on', +c.dataset.g === g));
}

function saveManual(code) {
  const d = drafts[code] || {};
  const errEl = document.querySelector('[data-bc-m-err]');
  const fail = (msg) => { if (errEl) errEl.textContent = msg; ctx.haptic.warn(); };
  const name = text(d.name, NAME_MAX);
  if (!name) return fail('Введи название');
  const filled = (x) => x !== undefined && x !== null && String(x).trim() !== '';
  const strict = (x) => (/^\d{1,4}(?:[.,]\d{1,2})?$/.test(String(x).trim()) ? parseFloat(String(x).trim().replace(',', '.')) : null);
  if (['k', 'p', 'f', 'c'].some((key) => filled(d[key]) && strict(d[key]) === null)) {
    return fail('Только числа от 0, например 12,5');
  }
  const n = (x) => (filled(x) ? strict(x) : null);
  const k = n(d.k);
  const p = n(d.p) ?? 0;
  const f = n(d.f) ?? 0;
  const c = n(d.c) ?? 0;
  if (k === null || k > 900) return fail('Калории на 100 г — от 0 до 900');
  if (p > 100 || f > 100 || c > 100) return fail('Белки, жиры и углеводы — от 0 до 100 г');
  if (p + f + c > 101) return fail('Б + Ж + У на 100 г не может быть больше 100 г');
  const prev = cache.get(code)?.food;
  // Код магазина, которого нет в общей базе, в «Мои продукты» не пишем: в следующий раз
  // код будет другим, а запись лишь вытеснит полезные (их всего 20). Хватит памяти до перезагрузки.
  const remember = !isStoreCode(code) || (!!prev && prev.src !== 'store');
  const food = {
    code, name, k: Math.round(k), p: r1(p), f: r1(f), c: r1(c),
    serving: prev?.serving || findMy(code)?.serving || 0,
    pack: prev?.pack || 0, img: prev?.img || '', brand: prev?.brand || '', qty: prev?.qty || '',
    src: remember ? 'my' : 'store', incomplete: false,
  };
  cache.set(code, { status: 'ok', food });
  delete mode[code];
  delete drafts[code];
  delete gramsBy[code];
  if (remember) saveMy(food);
  ctx.haptic.ok();
  ctx.toast(remember ? 'Продукт сохранён' : 'Готово — укажи граммы');
  ctx.render();
}

// ── Подписки на документ (один раз) ──────────────────

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // Вкладку скрыли или мини-апп свернули / увели в неактивную вкладку Telegram — камеру гасим;
  // вернулись на сканер — включаем снова
  const away = () => { if (stream || st.cam === 'starting') pauseCam(); };
  const back = () => {
    if (onScreen && st.cam === 'paused' && canRun()) {
      st.cam = 'idle';
      startCam();
    }
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? away() : back()));
  try {
    ctx.tg?.onEvent?.('deactivated', away);
    ctx.tg?.onEvent?.('activated', back);
  } catch { /* старый клиент Telegram */ }
  window.addEventListener('pagehide', () => stopCam());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest?.('input[data-bind="bcCode"]')) {
      e.preventDefault();
      findManual();
    }
  });
}

// ── Модуль ───────────────────────────────────────────

export default {
  id: 'barcode',
  keys: [MY_KEY],

  slots: {
    'food.addTop': () => `<button class="card card-link bc-entry" style="margin-top:12px" data-act="bcOpen">
      <div class="icon-box accent">${icon('barcode')}</div>
      <div class="grow"><div class="h3">Сканировать штрих-код</div><div class="sub small">Найдём КБЖУ по упаковке</div></div>
      <span class="chev">${icon('right')}</span></button>`,
  },

  screens: {
    bcScan: () => scanScreen(),
  },

  sheets: {
    bcProduct: (params) => productSheet(params || {}),
  },

  foods: () => myList().map((x) => ({
    id: `bc_${x.code}`, name: x.name, k: x.k, p: x.p, f: x.f, c: x.c,
    unit: x.serving || undefined, unitName: 'порция',
  })),

  actions: {
    bcOpen: () => ctx.push('bcScan'),
    bcCamRetry: () => {
      ctx.haptic.tap();
      stopCam();
      st.cam = 'idle';
      startCam();
    },
    bcTorch: () => toggleTorch(),
    bcFind: () => findManual(),
    bcOpenCode: ({ code }) => { seen = { code, at: Date.now() }; openProduct(digits(code)); },
    bcRetry: ({ code }) => {
      ctx.haptic.tap();
      cache.delete(code);
      lookup(code);
      paintSheet(code);
    },
    bcManual: ({ code }) => {
      ctx.haptic.tap();
      mode[code] = 'form';
      paintSheet(code);
    },
    bcEdit: ({ code }) => {
      ctx.haptic.tap();
      const food = currentFood();
      if (food) drafts[code] = { name: food.name, k: String(food.k), p: String(food.p), f: String(food.f), c: String(food.c) };
      mode[code] = 'form';
      paintSheet(code);
    },
    bcSave: ({ code }) => saveManual(code),
    bcG: ({ g }) => {
      ctx.haptic.tap();
      const input = gramsInput();
      if (input) input.value = g;
      recalc(g);
    },
    bcAdd: ({ code }) => {
      const food = currentFood();
      if (!food || food.code !== code) return;
      const g = +(gramsInput()?.value) || 0;
      if (!(g > 0 && g <= 3000)) { ctx.toast('Укажи вес от 1 до 3000 г'); ctx.haptic.warn(); return; }
      const t = calc(food, g);
      if (food.src !== 'store') saveMy(food); // поднять наверх «недавних»
      delete gramsBy[code];
      ctx.addFoodItem({ name: food.name, grams: g, k: t.k, p: t.p, f: t.f, c: t.c });
    },
  },

  binds: {
    bcCode: (v, _d, el) => {
      const clean = digits(v).slice(0, 14); // вставка «4 600000 000008» → только цифры
      if (el && el.value !== clean) el.value = clean;
      st.code = clean;
      if (st.codeErr) setCodeErr('');
    },
    bcPhoto: (files, _d, el) => onPhoto(files, el),
    bcGrams: (v) => recalc(v),
    'bcm.name': (v, d) => { (drafts[d.code] ||= {}).name = v; },
    'bcm.k': (v, d) => { (drafts[d.code] ||= {}).k = v; },
    'bcm.p': (v, d) => { (drafts[d.code] ||= {}).p = v; },
    'bcm.f': (v, d) => { (drafts[d.code] ||= {}).f = v; },
    'bcm.c': (v, d) => { (drafts[d.code] ||= {}).c = v; },
  },

  on: {
    reset: () => {
      // Запросы, которые ещё идут, отменяем, а их поздние ответы отбрасываем (epoch)
      epoch++;
      for (const c of inflight) { try { c.abort(); } catch { /* уже завершён */ } }
      inflight.clear();
      cache.clear();
      for (const o of [drafts, mode, gramsBy]) for (const k of Object.keys(o)) delete o[k];
      resetScreen();
    },
  },

  mount(root) {
    install();
    const on = ctx.current?.()?.name === 'bcScan';
    if (!on && (onScreen || stream || st.cam === 'starting')) {
      // Ушли со сканера: камеру и распознавание фото останавливаем, состояние экрана сбрасываем
      // сразу — следующий render() при входе соберёт чистую разметку
      stopCam();
      killWorker();
      resetScreen();
    }
    // Вошли или ушли — фото, которое ещё распознаётся, больше не открывает шторку
    if (on !== onScreen) photoToken++;
    const entered = on && !onScreen;
    onScreen = on;
    if (!on) { sheetWasOpen = false; return; }
    if (entered) {
      // Вошли: всё с чистого листа. Если что-то поменялось, пока экрана не было, — поправим DOM
      resetScreen();
      paintPhoto();
      const input = root.querySelector('input[data-bind="bcCode"]');
      if (input) input.value = '';
      setCodeErr('');
      preloadEngine();
    }
    const open = sheetOpen();
    // Шторку закрыли — код, который всё ещё в кадре, не открываем заново сразу же
    if (sheetWasOpen && !open && seen.code) seen.at = Date.now();
    sheetWasOpen = open;
    attachVideo(root);
    if (st.cam === 'idle') startCam(); // вкладка скрыта или мини-апп свёрнут — startCam поставит паузу
    else if (st.cam === 'live' && stream) startLoop();
  },
};
