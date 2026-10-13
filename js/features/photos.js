// Модуль «Фото до/после».
//
// Фото лежат только на этом устройстве — в IndexedDB:
//   база 'gymapp-photos-<tgUser.id|guest>', store 'photos': {id, date, pose, weight, blob, thumb}
// В хранилище приложения (ключ 'photos', уходит в облако Telegram) — только метаданные
// без картинок: [[id, date, pose 'f'|'s'|'b', weight], …] — чтобы на другом устройстве
// показать «N фото на другом устройстве». Сами картинки никуда не отправляются.
import { ctx } from '../core.js';

const POSES = { f: 'Спереди', s: 'Сбоку', b: 'Сзади' };
const POSE_IDS = Object.keys(POSES);
const LIMIT = 60; // фото на устройстве
const LIMIT_WARN = 50;
const META_MAX = 100; // записей в метаданных
const MAX_VALUE = 4096; // лимит CloudStorage на значение
const FULL_SIDE = 1280; // длинная сторона фото
const THUMB_SIDE = 360; // короткая сторона миниатюры
const STORE = 'photos';
const SCREENS = new Set(['phHome', 'phView', 'phCompare']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9]{4,20}$/;
const FONT = "Manrope, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONT_DISPLAY = `Unbounded, ${FONT}`;

// ── Чистые помощники (экспортируются для тестов) ──────
const byDate = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

// Метаданные из хранилища → только корректные записи
export function parseMeta(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!Array.isArray(m)) continue;
    const [id, date, pose, w] = m;
    if (typeof id !== 'string' || !ID_RE.test(id)) continue;
    if (typeof date !== 'string' || !DATE_RE.test(date) || !POSES[pose]) continue;
    out.push([id, date, pose, typeof w === 'number' && w > 0 && w < 1000 ? w : null]);
  }
  return out;
}

// Без повторов, по дате, не больше max записей и не длиннее limit символов JSON (старые — долой)
export function trimMeta(list, max = META_MAX, limit = MAX_VALUE) {
  const seen = new Set();
  let arr = list.filter((m) => !seen.has(m[0]) && seen.add(m[0]));
  arr.sort((x, y) => byDate({ id: x[0], date: x[1] }, { id: y[0], date: y[1] }));
  arr = arr.slice(-max);
  while (arr.length && JSON.stringify(arr).length > limit) arr = arr.slice(1);
  return arr;
}

// Размер фото: длинная сторона ≤ side
export function fitFull(w, h, side = FULL_SIDE) {
  const k = Math.min(1, side / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

// Размер миниатюры: короткая сторона ≤ side, длинная ≤ 2 × side
export function fitThumb(w, h, side = THUMB_SIDE) {
  const k = Math.min(1, side / Math.min(w, h), (side * 2) / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

// ── Состояние ─────────────────────────────────────────
const st = {
  status: 'idle', // idle | loading | ready | error
  error: '',
  gen: 0,
  dropP: null,
  items: [], // [{id, date, pose, weight, thumb: Blob}] по возрастанию даты — без больших blob
  filter: 'all',
  tips: false,
  busy: '', // process | save | collage
  pending: null, // новое фото до сохранения: {blob, thumb, url, pose, date, weight, autoWeight}
  cmp: { a: null, b: null, mode: 'curtain', v: 50 },
  pickPose: 'all',
  collage: null, // {url, file, canShare}
};
let lastPose = 'f';
let persistAsked = false;
const urls = new Map(); // 't:<id>' | 'f:<id>' → object URL
const fullLoads = new Map(); // id → Promise<Blob>
const fullFailed = new Set(); // id, чьё большое фото не открылось (до ухода с экранов фото)

const appEl = () => document.getElementById('app');
const later = (fn) => setTimeout(fn, 0);
const wText = (w) => `${ctx.fmt(w, w % 1 ? 1 : 0)} кг`;
const daysBetween = (a, b) => Math.round((ctx.parseKey(b) - ctx.parseKey(a)) / 864e5);
const findItem = (id) => st.items.find((x) => x.id === id) || null;
const ofPose = (p) => (p === 'all' ? st.items : st.items.filter((x) => x.pose === p));

function longDate(k, withYear = false) {
  const d = ctx.parseKey(k);
  const y = d.getFullYear();
  return `${ctx.dayMonth(d)}${withYear || y !== new Date().getFullYear() ? ` ${y}` : ''}`;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5).padEnd(3, '0');
}

// ── IndexedDB ─────────────────────────────────────────
const dbName = () => `gymapp-photos-${ctx.tgUser?.id || 'guest'}`;
let db = null;
let dbPromise = null;
let useBuffers = false; // старые WebKit не умеют класть Blob в IndexedDB — тогда храним ArrayBuffer

function openDb() {
  if (db) return Promise.resolve(db);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let idb = null;
    try { idb = window.indexedDB; } catch { idb = null; }
    if (!idb) { reject(new Error('no-idb')); return; }
    let req;
    try { req = idb.open(dbName(), 1); } catch (e) { reject(e); return; }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, 6000);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const d = req.result;
      if (timedOut) { d.close(); return; }
      const forget = () => { if (db === d) { db = null; dbPromise = null; } };
      d.onversionchange = () => { d.close(); forget(); };
      d.onclose = forget;
      db = d;
      resolve(d);
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('idb-error')); };
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(d, mode) {
  const t = d.transaction(STORE, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('abort'));
  });
  done.catch(() => {});
  return { os: t.objectStore(STORE), done };
}

// Соединение умерло (WebKit после сворачивания: «Connection to Indexed Database server lost»,
// close при этом не приходит) — забываем его, следующий openDb() откроет новое
function forgetDb(d) {
  if (d && db !== d) return; // уже переоткрыли
  try { db?.close(); } catch { /* уже закрыто */ }
  db = null;
  dbPromise = null;
}

const isBlobErr = (e) => e?.name === 'DataCloneError' || /blob/i.test(e?.message || '');
const canRetry = (e) => !isQuota(e) && !isBlobErr(e) && e?.message !== 'no-idb' && e?.message !== 'timeout';

// Операция с базой: при сбое соединения — переоткрываем и пробуем ещё раз (один)
async function withDb(op) {
  let d = await openDb();
  try {
    return await op(d);
  } catch (e) {
    if (!canRetry(e)) throw e;
    console.warn('photos: переподключаюсь к IndexedDB', e);
    forgetDb(d);
    d = await openDb();
    return op(d);
  }
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const asBlob = (v) => (!v ? null : v instanceof Blob ? v : new Blob([v], { type: 'image/jpeg' }));

function blobToBuffer(blob) {
  if (blob.arrayBuffer) return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

const putIn = (d, rec) => {
  const { os, done } = tx(d, 'readwrite');
  os.put(rec);
  return done;
};

async function putRecord(rec) {
  if (!useBuffers) {
    try {
      await withDb((d) => putIn(d, rec));
      return;
    } catch (e) {
      // ArrayBuffer — только если база не принимает именно Blob (старые WebKit)
      if (!isBlobErr(e)) throw e;
      useBuffers = true;
    }
  }
  const copy = { ...rec, blob: await blobToBuffer(rec.blob), thumb: await blobToBuffer(rec.thumb) };
  await withDb((d) => putIn(d, copy));
}

// Курсором, чтобы не держать все большие картинки разом: в памяти остаются только миниатюры
const loadAll = () => withDb(async (d) => {
  const { os, done } = tx(d, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const req = os.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      const r = c.value;
      if (r && typeof r.id === 'string' && ID_RE.test(r.id) && DATE_RE.test(r.date) && POSES[r.pose]) {
        out.push({ id: r.id, date: r.date, pose: r.pose, weight: typeof r.weight === 'number' ? r.weight : null, thumb: asBlob(r.thumb) });
      }
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await done;
  return out.sort(byDate);
});

const getFull = (id) => withDb(async (d) => {
  const r = await reqP(tx(d, 'readonly').os.get(id));
  return r ? asBlob(r.blob) : null;
});

const deleteRecord = (id) => withDb((d) => {
  const { os, done } = tx(d, 'readwrite');
  os.delete(id);
  return done;
});

function dropDb() {
  return new Promise((resolve) => {
    try { db?.close(); } catch { /* уже закрыта */ }
    db = null;
    dbPromise = null;
    let req = null;
    try { req = window.indexedDB?.deleteDatabase(dbName()); } catch { req = null; }
    if (!req) { resolve(); return; }
    const timer = setTimeout(resolve, 3000);
    req.onsuccess = req.onerror = req.onblocked = () => { clearTimeout(timer); resolve(); };
  });
}

function isQuota(e) {
  return e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');
}

function errText(e, op) {
  if (isQuota(e)) return 'На телефоне не хватает места. Освободи память или удали старые фото.';
  if (op === 'open') return 'Не получилось открыть хранилище фото на этом устройстве. Так бывает в приватном режиме браузера или когда память почти заполнена.';
  // Переподключение уже не помогло — поможет перезапуск мини-аппа
  if (e?.name === 'UnknownError' || e?.name === 'InvalidStateError') return 'Хранилище фото не отвечает. Закрой приложение и открой снова — сохранённые фото не пропадут.';
  return 'Не получилось сохранить фото. Попробуй ещё раз.';
}

// ── Загрузка и метаданные ─────────────────────────────
function ensureLoaded() {
  if (st.status !== 'idle') return;
  st.status = 'loading';
  const gen = st.gen;
  (async () => {
    try {
      if (st.dropP) await st.dropP;
      const items = await loadAll();
      if (gen !== st.gen) return;
      st.items = items;
      st.status = 'ready';
      st.error = '';
      syncMeta();
    } catch (e) {
      if (gen !== st.gen) return;
      console.warn('photos: IndexedDB недоступна', e);
      st.status = 'error';
      st.error = errText(e, 'open');
    }
    refreshIfVisible();
  })();
}

// Перерисовать, если на экране что-то зависит от фото (и пользователь ничего не печатает)
function refreshIfVisible() {
  if (!ctx.profile()?.done) return;
  const cur = ctx.current();
  const visible = cur ? SCREENS.has(cur.name) : ctx.tab() === 'profile';
  if (!visible) return;
  const a = document.activeElement;
  if (a && a.matches?.('input:not([type=file]), textarea, select')) return;
  ctx.render();
}

// Записи с других устройств: есть в метаданных, но нет в локальной базе
function others() {
  if (st.status !== 'ready') return [];
  const local = new Set(st.items.map((x) => x.id));
  return parseMeta(ctx.S().photos).filter((m) => !local.has(m[0]));
}

function saveMeta(list) {
  const arr = trimMeta(list);
  const next = arr.length ? arr : null;
  if (JSON.stringify(ctx.S().photos ?? null) !== JSON.stringify(next)) ctx.save('photos', next);
}

// rest — записи с других устройств (по умолчанию — всё, чего нет в локальной базе)
function syncMeta(rest = others()) {
  saveMeta([...rest, ...st.items.map((x) => [x.id, x.date, x.pose, x.weight ?? null])]);
}

function linkSub() {
  if (st.status === 'ready') {
    const n = st.items.length;
    if (n) return `${n} фото · последнее ${ctx.shortDate(st.items[n - 1].date)}`;
    const o = others().length;
    return o ? `${o} фото на другом устройстве` : 'Сделай фото «до»';
  }
  if (st.status === 'error') return 'Недоступно на этом устройстве';
  const meta = parseMeta(ctx.S().photos);
  if (meta.length) return `${meta.length} фото · последнее ${ctx.shortDate(meta.map((m) => m[1]).sort().pop())}`;
  return 'Сделай фото «до»';
}

// ── Object URL ────────────────────────────────────────
function objUrl(key, blob) {
  let u = urls.get(key);
  if (!u && blob) {
    u = URL.createObjectURL(blob);
    urls.set(key, u);
  }
  return u || '';
}

function revoke(key) {
  const u = urls.get(key);
  if (u) { URL.revokeObjectURL(u); urls.delete(key); }
}

function revokeAll() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  fullFailed.clear();
}

const thumbUrl = (it) => objUrl(`t:${it.id}`, it.thumb);
// Пока большое фото грузится — показываем миниатюру
const bestUrl = (it) => urls.get(`f:${it.id}`) || thumbUrl(it);

function loadFull(id) {
  let p = fullLoads.get(id);
  if (!p) {
    p = getFull(id).finally(() => fullLoads.delete(id));
    fullLoads.set(id, p);
  }
  return p;
}

function dropPending() {
  if (st.pending?.url) URL.revokeObjectURL(st.pending.url);
  st.pending = null;
}

// ── Обработка картинок ────────────────────────────────
async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
    } catch { /* нет опций или формата — пробуем через <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode'));
      im.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function drawScaled(src, w, h, bg) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return c;
}

function dataUrlToBlob(d) {
  const [head, b64] = d.split(',');
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: head.match(/data:([^;]+)/)?.[1] || 'image/jpeg' });
}

function canvasBlob(c, q) {
  return new Promise((resolve, reject) => {
    if (c.toBlob) c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', q);
    else {
      try { resolve(dataUrlToBlob(c.toDataURL('image/jpeg', q))); } catch (e) { reject(e); }
    }
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function processImage(file) {
  const img = await decodeImage(file);
  try {
    if (!img.w || !img.h) throw new Error('empty');
    const [fw, fh] = fitFull(img.w, img.h);
    const full = drawScaled(img.src, fw, fh, '#fff');
    const [tw, th] = fitThumb(fw, fh);
    const small = drawScaled(full, tw, th);
    const [blob, thumb] = await Promise.all([canvasBlob(full, 0.82), canvasBlob(small, 0.78)]);
    full.width = full.height = small.width = small.height = 0; // отдать память (iOS)
    return { blob, thumb };
  } finally {
    img.done();
  }
}

// ── Добавление ────────────────────────────────────────
function guessPose() {
  const today = ctx.dkey();
  const taken = new Set(st.items.filter((x) => x.date === today).map((x) => x.pose));
  if (!taken.size) return lastPose;
  return POSE_IDS.find((p) => !taken.has(p)) || lastPose;
}

async function onFile(files) {
  const file = files && files[0];
  if (!file || st.busy) return;
  if (st.status !== 'ready') { ctx.toast('Хранилище фото недоступно на этом устройстве'); return; }
  if (st.items.length >= LIMIT) { ctx.toast(`Уже ${LIMIT} фото — удали старые, чтобы добавить новые`); return; }
  if (file.type && !/^image\//.test(file.type)) { ctx.toast('Это не картинка — выбери фото'); ctx.haptic.warn(); return; }
  if (file.size > 40 * 1024 * 1024) { ctx.toast('Файл больше 40 МБ — выбери другое фото'); ctx.haptic.warn(); return; }
  st.busy = 'process';
  ctx.render();
  let res = null;
  try {
    res = await processImage(file);
  } catch (e) {
    console.warn('photos: не удалось обработать', e);
  }
  st.busy = '';
  if (ctx.current()?.name !== 'phHome') return; // пока обрабатывали, ушли с экрана
  if (!res) {
    ctx.toast('Не получилось открыть фото — попробуй другое (JPEG или PNG)');
    ctx.haptic.warn();
    ctx.render();
    return;
  }
  dropPending();
  const weight = ctx.profile()?.weight || '';
  st.pending = { ...res, url: URL.createObjectURL(res.blob), pose: guessPose(), date: ctx.dkey(), weight, autoWeight: weight };
  ctx.openSheet('phMeta');
}

function weightOn(date) {
  const ws = (ctx.S().weights || []).filter((x) => Array.isArray(x) && x[0] <= date).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return ws.length ? ws[ws.length - 1][1] : null;
}

async function savePending() {
  const p = st.pending;
  if (!p || st.busy) return;
  const root = appEl();
  const errEl = root.querySelector('#ph-err');
  const fail = (msg) => { if (errEl) errEl.textContent = msg; ctx.haptic.warn(); };
  const dateEl = root.querySelector('input[data-bind="phDate"]');
  const date = dateEl ? dateEl.value : p.date;
  if (!DATE_RE.test(date || '')) { fail('Укажи дату съёмки'); return; }
  if (date > ctx.dkey()) { fail('Дата не может быть в будущем'); return; }
  if (date < '2000-01-01') { fail('Проверь год — дата слишком старая'); return; }
  const wRaw = String(root.querySelector('input[data-bind="phWeight"]')?.value ?? p.weight ?? '').trim().replace(',', '.');
  let weight = null;
  if (wRaw !== '' && +wRaw !== 0) {
    const w = +(+wRaw).toFixed(1);
    if (!(w >= 30 && w <= 300)) { fail('Вес — от 30 до 300 кг (или оставь 0, если не знаешь)'); return; }
    weight = w;
  }
  if (st.items.length >= LIMIT) { fail(`Уже ${LIMIT} фото — удали старые, чтобы добавить новые`); return; }
  st.busy = 'save';
  const btn = root.querySelector('[data-act="phSave"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ph-spin"></span> Сохраняю…'; }
  const rec = { id: newId(), date, pose: p.pose, weight, blob: p.blob, thumb: p.thumb };
  try {
    await putRecord(rec);
  } catch (e) {
    console.warn('photos: не удалось сохранить', e);
    st.busy = '';
    if (btn) { btn.disabled = false; btn.innerHTML = `${ctx.icon('check')} Сохранить`; }
    fail(errText(e, 'put'));
    return;
  }
  st.busy = '';
  st.items = [...st.items, { id: rec.id, date, pose: rec.pose, weight, thumb: rec.thumb }].sort(byDate);
  lastPose = rec.pose;
  if (st.filter !== 'all' && st.filter !== rec.pose) st.filter = 'all';
  dropPending();
  syncMeta();
  if (!persistAsked && navigator.storage?.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  const n = st.items.length;
  ctx.haptic.ok();
  ctx.toast(n >= LIMIT ? `Фото сохранено. Это ${LIMIT}-е — больше не поместится` : 'Фото сохранено на телефоне');
  ctx.emit('photo', { count: n });
  ctx.closeSheet();
}

async function removePhoto(id) {
  if (!findItem(id)) return;
  const ok = await ctx.confirm('Удалить это фото? Восстановить его не получится.');
  if (!ok) return;
  try {
    await deleteRecord(id);
  } catch (e) {
    console.warn('photos: не удалось удалить', e);
    ctx.toast('Не получилось удалить фото');
    return;
  }
  const rest = others(); // пока фото ещё в списке — иначе оно сочтётся «с другого устройства»
  st.items = st.items.filter((x) => x.id !== id);
  if (st.cmp.a === id) st.cmp.a = null;
  if (st.cmp.b === id) st.cmp.b = null;
  syncMeta(rest);
  ctx.haptic.ok();
  ctx.toast('Фото удалено');
  ctx.emit('photo', { count: st.items.length });
  if (ctx.current()?.name === 'phView') ctx.back();
  else ctx.render();
  revoke(`t:${id}`);
  revoke(`f:${id}`);
}

function resetAll() {
  st.gen += 1;
  revokeAll();
  dropPending();
  Object.assign(st, {
    status: 'idle', error: '', items: [], filter: 'all', tips: false, busy: '',
    cmp: { a: null, b: null, mode: 'curtain', v: 50 }, pickPose: 'all', collage: null,
  });
  lastPose = 'f';
  st.dropP = dropDb();
}

// ── Сравнение ─────────────────────────────────────────
function setPair(anchor) {
  const items = st.items;
  if (anchor) {
    const same = ofPose(anchor.pose);
    let other = null;
    if (same.length >= 2) other = same[0].id === anchor.id ? same[same.length - 1] : same[0];
    else {
      const rest = items.filter((x) => x.id !== anchor.id);
      other = rest.length ? (rest[0].date <= anchor.date ? rest[0] : rest[rest.length - 1]) : null;
    }
    if (other) { st.cmp.a = other.id; st.cmp.b = anchor.id; return; }
  }
  const prefs = [st.filter !== 'all' ? st.filter : null, items[items.length - 1]?.pose, ...POSE_IDS].filter(Boolean);
  const p = prefs.find((x) => ofPose(x).length >= 2);
  const list = p ? ofPose(p) : items;
  st.cmp.a = list[0]?.id || null;
  st.cmp.b = list[list.length - 1]?.id || null;
}

// Пара для сравнения: раньше снятое — всегда «до». Состояние тоже приводим к этому порядку,
// чтобы слот «a» всегда был показанным «До» (выбор другого фото меняет нужный слот)
function cmpPair() {
  if (st.items.length < 2) return null;
  let a = findItem(st.cmp.a);
  let b = findItem(st.cmp.b);
  if (!a || !b || a === b) {
    setPair();
    a = findItem(st.cmp.a);
    b = findItem(st.cmp.b);
  }
  if (!a || !b || a === b) return null;
  if (byDate(a, b) > 0) [a, b] = [b, a];
  st.cmp.a = a.id;
  st.cmp.b = b.id;
  return [a, b];
}

function delta(a, b) {
  const days = daysBetween(a.date, b.date);
  const daysText = `${days} ${ctx.plural(days, 'день', 'дня', 'дней')}`;
  // «за 45 дней» / «в тот же день»
  const span = days > 0 ? `за ${daysText}` : 'в тот же день';
  let kg = null;
  if (a.weight && b.weight) {
    const d = +(b.weight - a.weight).toFixed(1);
    const goal = ctx.profile()?.goal;
    kg = {
      text: `${d > 0 ? '+' : d < 0 ? '−' : '±'}${ctx.fmt(Math.abs(d), d % 1 ? 1 : 0)} кг`,
      good: (goal === 'lose' && d < 0) || (goal === 'gain' && d > 0),
      d,
    };
  }
  return { days, daysText, span, kg };
}

// ── Коллаж ────────────────────────────────────────────
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawCover(g, img, x, y, w, h) {
  const s = Math.max(w / img.w, h / img.h);
  const sw = w / s;
  const sh = h / s;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img.src, (img.w - sw) / 2, (img.h - sh) * 0.4, sw, sh, x, y, w, h);
}

function fitFont(g, text, maxW, weight, size, family) {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  while (s > 14 && g.measureText(text).width > maxW) {
    s -= 2;
    g.font = `${weight} ${s}px ${family}`;
  }
}

function drawLogoMark(g, x, y, s) {
  g.fillStyle = '#c6f432';
  rr(g, x, y, s, s, s * 0.28);
  g.fill();
  const k = (s * 0.62) / 24;
  g.save();
  g.translate(x + s * 0.19, y + s * 0.19);
  g.scale(k, k);
  g.strokeStyle = '#0b0c0f';
  g.lineWidth = 2.2;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const [rx, ry, rw, rh] of [[2, 9, 3, 6], [5, 6, 3.5, 12], [15.5, 6, 3.5, 12], [19, 9, 3, 6]]) {
    rr(g, rx, ry, rw, rh, 1);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(8.5, 12);
  g.lineTo(15.5, 12);
  g.stroke();
  g.restore();
}

async function fontsReady() {
  if (!document.fonts?.load) return;
  const t = 'ДОПСЛЕ GymApp 0123456789 кг дней октября';
  await Promise.race([
    Promise.all([document.fonts.load(`800 30px Manrope`, t), document.fonts.load(`700 44px Unbounded`, t)]).catch(() => {}),
    new Promise((r) => setTimeout(r, 500)),
  ]);
}

async function buildCollage(a, b) {
  const [fa, fb] = await Promise.all([getFull(a.id), getFull(b.id)]);
  if (!fa || !fb) throw new Error('missing');
  const [ia, ib] = await Promise.all([decodeImage(fa), decodeImage(fb)]);
  try {
    await fontsReady();
    const W = 1440;
    const P = 48;
    const G = 24;
    const pw = (W - 2 * P - G) / 2;
    const ph = Math.round((pw * 4) / 3);
    const capH = 156;
    const footH = 128;
    const H = P + ph + capH + footH;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#0b0c0f';
    g.fillRect(0, 0, W, H);
    const panels = [[ia, a, 'ДО', P], [ib, b, 'ПОСЛЕ', P + pw + G]];
    for (const [img, it, label, x] of panels) {
      g.save();
      rr(g, x, P, pw, ph, 30);
      g.clip();
      g.fillStyle = '#1d2027';
      g.fillRect(x, P, pw, ph);
      drawCover(g, img, x, P, pw, ph);
      g.restore();
      g.font = `800 28px ${FONT}`;
      const tw = g.measureText(label).width;
      g.fillStyle = 'rgba(11, 12, 15, 0.74)';
      rr(g, x + 22, P + 22, tw + 40, 54, 27);
      g.fill();
      g.fillStyle = '#c6f432';
      g.textBaseline = 'middle';
      g.fillText(label, x + 42, P + 50);
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#f3f4f6';
      fitFont(g, longDate(it.date, true), pw - 8, 700, 44, FONT_DISPLAY);
      g.fillText(longDate(it.date, true), x + 4, P + ph + 72);
      g.fillStyle = '#a3a9b5';
      g.font = `700 32px ${FONT}`;
      g.fillText([POSES[it.pose], it.weight ? wText(it.weight) : ''].filter(Boolean).join(' · '), x + 4, P + ph + 122);
    }
    const fy = P + ph + capH;
    g.fillStyle = '#2a2e37';
    g.fillRect(P, fy, W - 2 * P, 2);
    const cy = fy + footH / 2 + 4;
    g.textBaseline = 'middle';
    g.font = `700 36px ${FONT_DISPLAY}`;
    const lw = g.measureText('GymApp').width;
    const lx = W - P - lw;
    g.fillStyle = '#f3f4f6';
    g.fillText('GymApp', lx, cy);
    const s = 56;
    drawLogoMark(g, lx - s - 16, cy - s / 2, s);
    const dl = delta(a, b);
    const summary = dl.kg ? `${dl.kg.text} ${dl.span}` : dl.days > 0 ? `${dl.daysText} между фото` : 'Фото одного дня';
    g.fillStyle = '#c6f432';
    fitFont(g, summary, lx - s - 48 - P, 800, 42, FONT);
    g.fillText(summary, P + 4, cy);
    const blob = await canvasBlob(c, 0.9);
    c.width = c.height = 0;
    return blob;
  } finally {
    ia.done();
    ib.done();
  }
}

function canShareFile(file) {
  try {
    return !!(file && navigator.share && navigator.canShare?.({ files: [file] }));
  } catch {
    return false;
  }
}

async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: 'Мой прогресс — GymApp' });
    ctx.haptic.ok();
    return 'ok';
  } catch (e) {
    return e?.name === 'AbortError' ? 'cancel' : 'fail';
  }
}

async function makeCollage() {
  const pair = cmpPair();
  if (!pair || st.busy) return;
  st.busy = 'collage';
  ctx.render();
  let blob = null;
  try {
    blob = await buildCollage(pair[0], pair[1]);
  } catch (e) {
    console.warn('photos: коллаж', e);
  }
  st.busy = '';
  if (ctx.current()?.name !== 'phCompare') return; // пока собирали, ушли с экрана
  if (!blob) {
    ctx.toast('Не получилось собрать коллаж');
    ctx.haptic.warn();
    ctx.render();
    return;
  }
  const name = `gymapp-${pair[0].date}_${pair[1].date}.jpg`;
  let file = null;
  try { file = new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }); } catch { file = null; }
  const canShare = canShareFile(file);
  if (canShare) {
    const r = await shareFile(file);
    if (r !== 'fail') { ctx.render(); return; }
  }
  // В Telegram ссылка с download обычно не работает — там сразу показываем картинку
  if (!ctx.inTelegram && 'download' in HTMLAnchorElement.prototype) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ctx.haptic.ok();
    ctx.toast('Коллаж сохранён в загрузки');
    ctx.render();
    return;
  }
  // Шторка, а не слой поверх всего: системная «Назад» сначала закрывает шторку,
  // и пользователь остаётся на сравнении со своей парой фото
  try {
    st.collage = { url: await blobToDataUrl(blob), file, canShare };
  } catch {
    st.collage = null;
    ctx.toast('Не получилось показать коллаж');
    ctx.render();
    return;
  }
  ctx.openSheet('phCollage');
}

// Палец — «зажми», мышь — правая кнопка (Telegram Desktop / macOS / веб на компьютере)
function touchFirst() {
  if (['tdesktop', 'macos'].includes(ctx.tg?.platform)) return false;
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return true; }
}

// ── Разметка ──────────────────────────────────────────
const TIPS = [
  ['spark', 'Одинаковый свет', 'У того же окна днём или под той же лампой. Без вспышки.'],
  ['camera', 'Тот же ракурс', 'Телефон на уровне груди, в полный рост, с того же места. Удобно с таймером.'],
  ['clock', 'Утром', 'Натощак и до тренировки — после еды и «пампа» фигура выглядит иначе.'],
  ['body', 'Та же одежда', 'Одни и те же шорты, купальник или бельё — так честнее видно форму.'],
  ['calendar', 'Раз в 2–4 недели', 'Чаще разницу не видно. Снимай спереди, сбоку и сзади.'],
];

function tipsHtml(always) {
  const open = always || st.tips;
  const head = `<button class="ph-tips-h" ${always ? '' : 'data-act="phTips"'}>
    <div class="icon-box accent">${ctx.icon('info')}</div>
    <div class="grow"><div class="h3">Как снимать</div><div class="sub small">Чтобы фото было честно сравнивать</div></div>
    ${always ? '' : `<span class="ph-chev ${open ? 'open' : ''}">${ctx.icon('right', 'sm')}</span>`}</button>`;
  const body = open ? `<div class="ph-tips">${TIPS.map(([ic, t, s]) => `<div class="ph-tip">
    <div class="icon-box">${ctx.icon(ic, 'sm')}</div><div class="grow"><b>${t}</b><div class="sub small">${s}</div></div></div>`).join('')}</div>` : '';
  return `<div class="card ph-tips-card">${head}${body}</div>`;
}

// Ракурсы без фото не показываем (кроме выбранного)
function poseChips(act, cur) {
  const all = [['all', 'Все', st.items.length], ...POSE_IDS.map((k) => [k, POSES[k], ofPose(k).length])].filter(([k, , n]) => n || k === cur);
  return all.map(([k, t, n]) => `<button class="chip ${cur === k ? 'on' : ''}" data-act="${act}" data-pose="${k}">${t}<span class="ph-n num">${n}</span></button>`).join('');
}

function cellHtml(it, { act = 'phOpen', extra = '', cls = '', tag = POSES[it.pose] } = {}) {
  const id = ctx.esc(it.id);
  return `<button class="ph-cell ${cls}" data-act="${act}" data-id="${id}" ${extra} aria-label="${ctx.esc(`${POSES[it.pose]}, ${longDate(it.date)}`)}">
    <img src="${thumbUrl(it)}" alt="" draggable="false"><span class="ph-tag">${tag}</span></button>`;
}

function groupsHtml(list) {
  const groups = new Map();
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    if (!groups.has(it.date)) groups.set(it.date, []);
    groups.get(it.date).push(it);
  }
  return [...groups].map(([date, arr]) => {
    const w = arr.find((x) => x.weight)?.weight;
    return `<div class="ph-group">
      <div class="ph-gh"><span class="h3">${ctx.esc(longDate(date))}</span>${w ? `<span class="sub small num">${wText(w)}</span>` : ''}</div>
      <div class="ph-grid">${arr.map((it) => cellHtml(it)).join('')}</div></div>`;
  }).join('');
}

function emptyHtml() {
  return `<div class="card ph-empty">
    <div class="ph-art">
      <div class="ph-frame">${ctx.icon('body', 'lg')}<span>До</span></div>
      <div class="ph-arrow">${ctx.icon('right')}</div>
      <div class="ph-frame on">${ctx.icon('body', 'lg')}<span>После</span></div>
    </div>
    <div class="h2">Сделай фото «до»</div>
    <div class="sub small ph-empty-t">Весы и сантиметр показывают не всё. Через месяц-два сравнишь фото и увидишь то, что не заметно в зеркале каждый день.</div>
  </div>`;
}

function homeScreen() {
  if (st.status === 'idle') later(ensureLoaded);
  const ready = st.status === 'ready';
  const n = st.items.length;
  const sub = ready ? (n ? `${n} фото на телефоне` : 'Пока ни одного фото') : '';
  let body = '';
  if (st.status === 'error') {
    body += `<div class="card ph-errcard">
      <div class="row top"><div class="icon-box ph-danger">${ctx.icon('alert')}</div>
      <div class="grow"><div class="h3">Фото здесь не сохранить</div><div class="sub small">${ctx.esc(st.error)}</div></div></div>
      <button class="btn ghost sm block" data-act="phRetry">${ctx.icon('refresh', 'sm')} Попробовать снова</button></div>`;
  } else if (!ready) {
    body += '<div class="card ph-loading"><span class="ph-spin"></span><span class="sub">Загружаю фото…</span></div>';
  } else {
    const o = others().length;
    if (o) {
      body += `<div class="notice ph-note">${ctx.icon('info', 'sm')}<div class="grow">${n ? 'Ещё ' : ''}${o} фото — на другом устройстве: они хранятся только там.
        <button class="ph-link" data-act="phForget">Скрыть</button></div></div>`;
    }
    if (!n) body += emptyHtml();
    else {
      const list = ofPose(st.filter);
      const poses = new Set(st.items.map((x) => x.pose)).size;
      if (poses > 1 || st.filter !== 'all') body += `<div class="chips ph-filter">${poseChips('phFilter', st.filter)}</div>`;
      body += list.length ? groupsHtml(list) : `<div class="empty">Фото «${POSES[st.filter]?.toLowerCase() || ''}» пока нет</div>`;
      if (n >= LIMIT) {
        body += `<div class="notice ph-limit">${ctx.icon('alert', 'sm')}<div>Это лимит — ${LIMIT} фото. Удали старые или лишние, чтобы добавить новые: фото занимают память телефона.</div></div>`;
      } else if (n >= LIMIT_WARN) {
        body += `<div class="notice ph-limit">${ctx.icon('alert', 'sm')}<div>Осталось мест: ${LIMIT - n} из ${LIMIT}. Удаляй лишние фото — они занимают память телефона.</div></div>`;
      }
    }
  }
  const canAdd = ready && n < LIMIT;
  let add;
  if (st.busy === 'process') add = '<div class="btn grow ph-busy"><span class="ph-spin"></span> Обрабатываю…</div>';
  else if (canAdd) add = `<label class="btn grow ph-add">${ctx.icon('camera')} Добавить фото<input class="ph-file" type="file" accept="image/*" data-file="phFile"></label>`;
  else add = `<button class="btn grow" disabled>${ctx.icon('camera')} Добавить фото</button>`;
  const cmpBtn = ready && n >= 2 ? `<button class="btn ghost ph-cmp-btn" data-act="phCompareOpen" aria-label="Сравнить">${ctx.icon('compare')}<span>Сравнить</span></button>` : '';
  return `<div class="page no-tabs ph">
    ${ctx.backHeader('Фото до/после', sub)}
    <div class="notice ph-private">${ctx.icon('lock', 'sm')}<div><b>Фото хранятся только на этом телефоне.</b> Они никуда не отправляются — ни на сервер, ни в облако Telegram.</div></div>
    ${body}
    ${tipsHtml(ready && !n)}
    <div class="sub small ph-foot">Удалишь Telegram или очистишь его данные — фото пропадут. Важные сравнения сохраняй коллажем в галерею.</div>
    <div class="bottom-bar"><div class="inner">${add}${cmpBtn}</div></div>
  </div>`;
}

function viewScreen({ id }) {
  const i = st.items.findIndex((x) => x.id === id);
  const it = st.items[i];
  if (!it) {
    if (st.status === 'idle') later(ensureLoaded);
    return `<div class="page no-tabs">${ctx.backHeader('Фото')}<div class="empty">${st.status === 'ready' ? 'Фото не найдено' : 'Загружаю…'}</div></div>`;
  }
  const n = st.items.length;
  const prev = st.items[i - 1];
  const next = st.items[i + 1];
  const first = ofPose(it.pose)[0];
  let facts;
  if (first.id === it.id) {
    facts = `<span class="badge accent">${ctx.icon('flag', 'sm')} Точка отсчёта</span><span class="sub small">Первое фото этого ракурса</span>`;
  } else {
    const dl = delta(first, it);
    facts = `<span class="badge">${ctx.icon('calendar', 'sm')} ${dl.days ? `+${dl.daysText}` : 'тот же день'}</span>
      ${dl.kg ? `<span class="badge ${dl.kg.good ? 'accent' : ''}">${ctx.icon(dl.kg.d <= 0 ? 'down' : 'up', 'sm')} ${dl.kg.text}</span>` : ''}
      <span class="sub small">от первого фото «${POSES[it.pose].toLowerCase()}»</span>`;
  }
  const sub = [POSES[it.pose], it.weight ? wText(it.weight) : ''].filter(Boolean).join(' · ');
  const nav = (x, side, label) => (x ? `<button class="ph-nav ${side}" data-act="phGo" data-id="${ctx.esc(x.id)}" aria-label="${label}">${ctx.icon(side === 'l' ? 'left' : 'right')}</button>` : '');
  return `<div class="page no-tabs ph">
    ${ctx.backHeader(longDate(it.date), sub)}
    <div class="ph-stage">
      <img data-ph-full="${ctx.esc(it.id)}" src="${bestUrl(it)}" alt="Фото: ${ctx.esc(sub)}" draggable="false">
      ${nav(prev, 'l', 'Предыдущее фото')}${nav(next, 'r', 'Следующее фото')}
      <span class="ph-count num">${i + 1} / ${n}</span>
    </div>
    <div class="ph-facts">${facts}</div>
    <div class="bottom-bar"><div class="inner">
      <button class="btn danger ph-del" data-act="phDelete" data-id="${ctx.esc(it.id)}" aria-label="Удалить">${ctx.icon('trash')}<span>Удалить</span></button>
      <button class="btn grow" data-act="phCompareWith" data-id="${ctx.esc(it.id)}" ${n < 2 ? 'disabled' : ''}>${ctx.icon('compare')} Сравнить</button>
    </div></div>
  </div>`;
}

function compareScreen() {
  const pair = cmpPair();
  if (!pair) {
    if (st.status === 'idle') later(ensureLoaded);
    return `<div class="page no-tabs">${ctx.backHeader('Сравнение')}<div class="empty">${st.status === 'ready' ? 'Для сравнения нужно хотя бы два фото' : 'Загружаю…'}</div></div>`;
  }
  const [a, b] = pair;
  const same = a.pose === b.pose;
  const sub = same ? POSES[a.pose] : `${POSES[a.pose]} и ${POSES[b.pose].toLowerCase()}`;
  const curtain = st.cmp.mode === 'curtain';
  const img = (it, cls = '') => `<img class="${cls}" data-ph-full="${ctx.esc(it.id)}" src="${bestUrl(it)}" alt="" draggable="false">`;
  const stage = curtain
    ? `<div class="ph-cmp" style="--ph-v:${st.cmp.v / 100}">
        ${img(b)}${img(a, 'ph-top')}
        <span class="ph-lbl l">До · ${ctx.shortDate(a.date)}</span><span class="ph-lbl r">После · ${ctx.shortDate(b.date)}</span>
        <input class="ph-range" type="range" min="0" max="100" step="0.5" value="${st.cmp.v}" data-bind="phSlide" aria-label="Шторка: до и после">
        <div class="ph-handle"><span class="ph-knob">${ctx.icon('left', 'sm')}${ctx.icon('right', 'sm')}</span></div>
      </div>`
    : `<div class="ph-side">
        <div class="ph-sbox">${img(a)}<span class="ph-lbl l">До</span></div>
        <div class="ph-sbox">${img(b)}<span class="ph-lbl l">После</span></div>
      </div>`;
  const dl = delta(a, b);
  const sum = dl.kg
    ? `<b class="num ${dl.kg.good ? 'good' : ''}">${dl.kg.text}</b><span>${dl.span}</span>`
    : dl.days > 0 ? `<b class="num">${dl.daysText}</b><span>между фото</span>` : '<span>Фото сняты в один день</span>';
  const cap = (it, slot, label) => `<button class="ph-cap" data-act="phPick" data-slot="${slot}">
    <span class="ph-cap-k">${label}</span><b>${ctx.esc(longDate(it.date))}</b>
    <span class="sub small">${POSES[it.pose]}${it.weight ? ` · ${wText(it.weight)}` : ''}</span>
    <span class="ph-cap-chg">${ctx.icon('swap', 'sm')} Другое фото</span></button>`;
  const busy = st.busy === 'collage';
  return `<div class="page no-tabs ph">
    ${ctx.backHeader('Сравнение', sub)}
    <div class="ph-seg">
      <button class="${curtain ? 'on' : ''}" data-act="phMode" data-mode="curtain">${ctx.icon('compare', 'sm')} Шторка</button>
      <button class="${curtain ? '' : 'on'}" data-act="phMode" data-mode="side">${ctx.icon('image', 'sm')} Рядом</button>
    </div>
    ${stage}
    ${curtain ? '<div class="tiny muted ph-hint">Тяни за ручку влево-вправо</div>' : ''}
    <div class="ph-sum">${sum}</div>
    ${same ? '' : `<div class="notice ph-note">${ctx.icon('alert', 'sm')}<div>Ракурсы разные — честнее сравнивать фото с одного ракурса.</div></div>`}
    <div class="ph-caps">${cap(a, 'a', 'До')}${cap(b, 'b', 'После')}</div>
    <div class="bottom-bar"><div class="inner">
      ${busy ? '<div class="btn block ph-busy"><span class="ph-spin"></span> Собираю коллаж…</div>'
        : `<button class="btn block" data-act="phCollage">${ctx.icon('share')} Сохранить коллаж</button>`}
    </div></div>
  </div>`;
}

function metaSheet() {
  const p = st.pending;
  if (!p) return '<div class="empty">Фото не выбрано</div>';
  return `<div data-ph-meta>
    <div class="h2">Новое фото</div>
    <div class="ph-prev"><img src="${p.url}" alt="Превью"></div>
    <div class="ph-lock">${ctx.icon('lock', 'sm')} Фото хранятся только на этом телефоне</div>
    <div class="ph-flabel">Ракурс</div>
    <div class="ph-pose">${POSE_IDS.map((k) => `<button class="chip ${p.pose === k ? 'on' : ''}" data-act="phPose" data-pose="${k}">${POSES[k]}</button>`).join('')}</div>
    <div class="field ph-field"><label>Дата</label>
      <input class="ph-date" type="date" value="${ctx.esc(p.date)}" max="${ctx.dkey()}" min="2000-01-01" data-bind="phDate"></div>
    <div class="field ph-field"><label>Вес в этот день</label>${ctx.stepper('phWeight', p.weight, 'кг', 0.1)}</div>
    <div class="err" id="ph-err"></div>
    <button class="btn block" data-act="phSave">${ctx.icon('check')} Сохранить</button>
  </div>`;
}

function pickSheet({ slot }) {
  cmpPair();
  const cur = slot === 'a' ? st.cmp.a : st.cmp.b;
  const other = slot === 'a' ? st.cmp.b : st.cmp.a;
  const list = ofPose(st.pickPose).slice().reverse();
  return `<div class="h2">Фото «${slot === 'a' ? 'до' : 'после'}»</div>
    <div class="sub small ph-pick-sub">Порядок — по дате: раньше снятое всегда слева, «до»</div>
    <div class="chips ph-filter">${poseChips('phPickPose', st.pickPose)}</div>
    ${list.length ? `<div class="ph-grid ph-pick">${list.map((it) => cellHtml(it, {
      act: 'phPickSet',
      extra: `data-slot="${slot}" ${it.id === other ? 'disabled' : ''}`,
      cls: it.id === cur ? 'on' : '',
      tag: ctx.shortDate(it.date),
    })).join('')}</div>` : '<div class="empty">Здесь пока пусто</div>'}`;
}

function collageSheet() {
  const c = st.collage;
  if (!c) return '<div class="empty">Коллаж не найден — собери его заново</div>';
  const hint = touchFirst()
    ? 'Зажми картинку, чтобы сохранить её'
    : 'Нажми на картинку правой кнопкой мыши → «Сохранить изображение как…»';
  return `<div data-ph-collage>
    <div class="h2">Коллаж готов</div>
    <div class="sub small ph-col-hint">${hint}</div>
    <div class="ph-col-img"><img src="${c.url}" alt="Коллаж до и после"></div>
    ${c.canShare ? `<button class="btn block ph-col-btn" data-act="phCollageShare">${ctx.icon('share')} Поделиться</button>` : ''}
    <button class="btn ${c.canShare ? 'ghost' : ''} block ph-col-btn" data-act="closeSheet">${ctx.icon('check')} Готово</button>
  </div>`;
}

// ── Модуль ────────────────────────────────────────────
export default {
  id: 'photos',
  keys: ['photos'],

  screens: {
    phHome: homeScreen,
    phView: viewScreen,
    phCompare: compareScreen,
  },

  sheets: {
    phMeta: metaSheet,
    phPick: pickSheet,
    phCollage: collageSheet,
  },

  actions: {
    phOpen: ({ id }) => { if (findItem(id)) ctx.push('phView', { id }); },
    phGo: ({ id }) => {
      const cur = ctx.current();
      if (cur?.name !== 'phView' || !findItem(id)) return;
      ctx.haptic.tap();
      cur.params = { id };
      ctx.render();
    },
    phFilter: ({ pose }) => { ctx.haptic.tap(); st.filter = pose; ctx.render(); },
    phTips: () => { ctx.haptic.tap(); st.tips = !st.tips; ctx.render(); },
    phRetry: () => { st.status = 'idle'; ensureLoaded(); ctx.render(); },
    phForget: async () => {
      const ok = await ctx.confirm('Убрать из списка фото с других устройств? Сами фото там останутся.');
      if (!ok) return;
      syncMeta([]);
      ctx.render();
    },
    phPose: ({ pose }, el) => {
      if (!st.pending || !POSES[pose]) return;
      ctx.haptic.tap();
      st.pending.pose = pose;
      el.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === el));
    },
    phSave: () => savePending(),
    phDelete: ({ id }) => removePhoto(id),
    phCompareOpen: () => {
      if (st.items.length < 2) return;
      setPair();
      ctx.push('phCompare');
    },
    phCompareWith: ({ id }) => {
      const it = findItem(id);
      if (!it || st.items.length < 2) return;
      setPair(it);
      ctx.push('phCompare');
    },
    phMode: ({ mode }) => {
      if (st.cmp.mode === mode) return;
      ctx.haptic.tap();
      st.cmp.mode = mode === 'side' ? 'side' : 'curtain';
      ctx.render();
    },
    phPick: ({ slot }) => {
      cmpPair(); // st.cmp.a — «До», st.cmp.b — «После»
      const it = findItem(slot === 'a' ? st.cmp.a : st.cmp.b);
      st.pickPose = it?.pose || 'all';
      ctx.openSheet('phPick', { slot: slot === 'a' ? 'a' : 'b' });
    },
    phPickPose: ({ pose }) => { ctx.haptic.tap(); st.pickPose = pose; ctx.render(); },
    phPickSet: ({ slot, id }) => {
      if (!findItem(id)) return;
      ctx.haptic.tap();
      if (slot === 'a') st.cmp.a = id;
      else st.cmp.b = id;
      ctx.closeSheet();
    },
    phCollage: () => makeCollage(),
    phCollageShare: async () => {
      const file = st.collage?.file;
      if (!file) return;
      const r = await shareFile(file);
      if (r === 'fail') ctx.toast(touchFirst() ? 'Не получилось — зажми картинку, чтобы сохранить' : 'Не получилось — сохрани картинку правой кнопкой мыши');
    },
  },

  binds: {
    phFile: (files) => { onFile(files); },
    phSlide: (v, _, el) => {
      st.cmp.v = Math.max(0, Math.min(100, +v || 0));
      el.closest('.ph-cmp')?.style.setProperty('--ph-v', String(st.cmp.v / 100));
    },
    phDate: (v) => {
      const p = st.pending;
      if (!p) return;
      p.date = v;
      if (!DATE_RE.test(v)) return;
      // Вес подставляем из журнала веса, если его ещё не правили руками
      const wEl = appEl()?.querySelector('input[data-bind="phWeight"]');
      if (!wEl || String(+wEl.value) !== String(+p.autoWeight)) return;
      const w = weightOn(v) || ctx.profile()?.weight;
      if (w) { wEl.value = w; p.weight = w; p.autoWeight = w; }
    },
    phWeight: (v) => { if (st.pending) st.pending.weight = v; },
  },

  slots: {
    'profile.links': () => {
      if (st.status === 'idle') later(ensureLoaded);
      return `<button class="list-item" data-act="push" data-name="phHome">
        <div class="icon-box">${ctx.icon('image')}</div>
        <div class="grow"><div class="h3">Фото до/после</div><div class="sub small">${ctx.esc(linkSub())}</div></div>
        <span class="muted">${ctx.icon('right')}</span></button>`;
    },
  },

  on: {
    boot: () => { if (ctx.profile()?.done) ensureLoaded(); },
    reset: () => resetAll(),
  },

  mount(root) {
    // Шторку закрыли (фон, «Назад», другая шторка) — освобождаем её данные
    if (st.pending && !root.querySelector('[data-ph-meta]')) dropPending();
    if (st.collage && !root.querySelector('[data-ph-collage]')) st.collage = null;
    const fulls = [...root.querySelectorAll('img[data-ph-full]')];
    const need = new Set(fulls.map((im) => im.dataset.phFull));
    for (const key of [...urls.keys()]) if (key.startsWith('f:') && !need.has(key.slice(2))) revoke(key);
    for (const im of fulls) {
      const id = im.dataset.phFull;
      if (urls.has(`f:${id}`) || fullFailed.has(id)) continue;
      loadFull(id).then((blob) => {
        if (blob && im.isConnected) im.src = objUrl(`f:${id}`, blob);
      }).catch((e) => {
        console.warn('photos: не удалось открыть фото', e);
        if (fullFailed.has(id)) return;
        fullFailed.add(id); // не повторяем и не шумим на каждой перерисовке
        if (im.isConnected) ctx.toast('Не получилось открыть фото целиком — показываю уменьшенное');
      });
    }
    const cmp = root.querySelector('.ph-cmp');
    if (cmp) cmp.style.setProperty('--ph-h', `${cmp.clientHeight}px`);
  },

  unmount() {
    // Вес, изменённый кнопками +/- степпера (ядро не зовёт binds модулей), — в состояние,
    // иначе перерисовка (смена темы, полночь) вернёт старое значение
    const w = st.pending && appEl()?.querySelector('input[data-bind="phWeight"]');
    if (w) st.pending.weight = w.value;
    // Ушли с экранов фото — отзываем все object URL
    const cur = ctx.current();
    if (cur && SCREENS.has(cur.name)) return;
    revokeAll();
  },
};
