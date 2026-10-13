// Модуль «Челленджи с друзьями» — клиент API сервера бота (docs/ARCHITECTURE.md, «API сервера»).
// Данные живут только в памяти модуля (без CloudStorage): список и карточки челленджей
// кэшируются, повторный запрос — не чаще раза в 20 с (кроме «Обновить» и «Повторить»).
// Всё, что пришло с сервера (названия, имена, тексты ошибок), выводится только через ctx.esc.
import { ctx } from '../core.js';

const ADMIN_ID = 1411430230;
const TTL = 20000;
const TIMEOUT = 15000; // ctx.api — fetch без таймаута: зависший запрос не должен вешать экран
const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EXERCISES = [
  ['bb_bench', 'Жим лёжа'],
  ['bb_squat', 'Присед'],
  ['deadlift', 'Становая'],
  ['bb_ohp', 'Жим стоя'],
  ['db_bench', 'Жим гантелей'],
  ['leg_press', 'Жим ногами'],
];
const EX_FULL = {
  bb_bench: 'Жим штанги лёжа',
  bb_squat: 'Приседания со штангой',
  deadlift: 'Становая тяга',
  bb_ohp: 'Жим штанги стоя',
  db_bench: 'Жим гантелей лёжа',
  leg_press: 'Жим ногами',
};
const TYPES = {
  lift: {
    icon: 'dumbbell', title: 'Кто первый пожмёт', format: 'Кто первый возьмёт вес', hint: 'Гонка за весом в базовом упражнении',
    label: 'Кто первый', unit: 'кг', min: 10, max: 500, step: 2.5, days: [0, 30, 60, 90],
  },
  workouts: {
    icon: 'calendar', title: 'Больше тренировок', hint: 'Кто первым наберёт тренировки за срок',
    label: 'Тренировки', unit: 'шт', min: 4, max: 40, step: 1, days: [7, 14, 30, 60],
  },
  volume: {
    icon: 'chart', title: 'Тонны объёма', hint: 'Кто поднимет больше суммарного веса',
    label: 'Объём', unit: 'т', min: 1, max: 200, step: 1, days: [7, 14, 30],
  },
};
const UNKNOWN_TYPE = { icon: 'trophy', label: 'Челлендж', unit: '' };
const AVA_COLORS = ['var(--carbs)', 'var(--water)', 'var(--protein)', 'var(--fat)', 'var(--warn)'];

// ── Состояние (только память) ─────────────────────────
function freshState() {
  return {
    list: null, // Challenge[] | null — ещё не загружали
    listAt: 0, // время последней удачной загрузки
    listTry: 0, // время последней попытки
    listErr: null, // {msg, status}
    ch: {}, // code → Challenge
    at: {}, // code → время удачной загрузки
    tryAt: {}, // code → время попытки
    err: {}, // code → {msg, status}
    form: null, // форма создания
    creating: false,
    joining: '',
    leaving: '',
    confirming: false, // открыт системный диалог подтверждения (второй вызов в Telegram бросает исключение)
    pendingInvite: '', // код из ссылки, пока не пройдена анкета
  };
}
let st = freshState();
let gen = 0; // растёт при сбросе данных: ответы старых запросов игнорируются
let mutVer = 0; // растёт после создания/вступления/выхода: ответы GET, ушедших раньше, устарели
let listReq = null;
let detReq = {};
let workoutTimer = null;

// ── Мелкие хелперы ────────────────────────────────────
const hasApi = () => !!ctx.apiBase?.();
const num = (x) => (Number.isFinite(+x) ? +x : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toNum = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const fmtN = (x) => ctx.fmt(x, Math.abs(Math.round(num(x) * 10)) % 10 ? 1 : 0);
const dn = (n) => ctx.plural(n, 'день', 'дня', 'дней');
const typeOf = (c) => TYPES[c?.type] || UNKNOWN_TYPE;
const isActive = (c) => c?.status !== 'finished';

function onScreen(name, code) {
  const cur = ctx.current?.();
  if (!cur || cur.name !== name) return false;
  return code === undefined || String(cur.params?.code || '') === String(code);
}

// Сегодня по UTC — сервер считает даты челленджей (starts_on, ends_on, завершение) в UTC
const todayUtc = () => new Date().toISOString().slice(0, 10);

// Запрос к серверу с таймаутом: после TIMEOUT промис отклоняется, как при обрыве связи
function call(path, opts) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(''), { status: 0, timeout: true })), TIMEOUT);
  });
  return Promise.race([ctx.api(path, opts), timeout]).finally(() => clearTimeout(timer));
}

// Системное подтверждение; повторное нажатие, пока диалог открыт, игнорируется
async function ask(text) {
  if (st.confirming) return false;
  st.confirming = true;
  try {
    return !!(await ctx.confirm(text));
  } catch {
    return false;
  } finally {
    st.confirming = false;
  }
}

// Перерисовать, только если пользователь всё ещё видит это, ничего не вводит
// и поверх экрана нет шторки или модального окна (иначе их анимация проиграется заново)
function softRender(visible) {
  if (!visible()) return;
  if (document.querySelector('.sheet, .rest, [role="dialog"]')) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  ctx.render();
}

const listVisible = () => {
  if (!ctx.S().profile?.done) return false;
  const cur = ctx.current();
  if (cur) return cur.name === 'chHome';
  return ctx.tab() === 'home' || ctx.tab() === 'profile';
};

function errInfo(e, what = 'list') {
  const status = +e?.status || 0;
  const m = String(e?.message || '');
  const generic = !m || /^Ошибка \d+$/.test(m);
  if (e?.code === 'no-api') return { msg: 'Челленджи пока недоступны — сервер ещё не подключён.', status: 0 };
  if (e?.timeout || e?.code === 'timeout') return { msg: 'Сервер не отвечает. Проверь интернет и попробуй ещё раз.', status: 0, timeout: true };
  if (!status) return { msg: 'Нет связи с сервером. Проверь интернет и попробуй ещё раз.', status: 0 };
  if (status === 404 && what === 'detail') return { msg: 'Челлендж не найден — возможно, ссылка устарела или его удалили.', status };
  if (status >= 500) return { msg: 'Сервер временно недоступен. Попробуй чуть позже.', status };
  if ((status === 401 || status === 403) && generic) return { msg: 'Открой приложение через бота в Telegram, чтобы участвовать.', status };
  return { msg: generic ? 'Что-то пошло не так. Попробуй ещё раз.' : m.slice(0, 200), status };
}

// Нормализация ответа сервера: только объект с кодом, участники — массив объектов
function norm(c) {
  if (!c || typeof c !== 'object' || c.code == null) return null;
  const code = String(c.code);
  if (!CODE_RE.test(code)) return null;
  const participants = Array.isArray(c.participants) ? c.participants.filter((p) => p && typeof p === 'object') : [];
  return { ...c, code, participants };
}

function put(c, alias) {
  st.ch[c.code] = c;
  st.at[c.code] = Date.now();
  delete st.err[c.code];
  if (alias && alias !== c.code) {
    st.ch[alias] = c;
    st.at[alias] = st.at[c.code];
    delete st.err[alias];
  }
  if (st.list) {
    const i = st.list.findIndex((x) => x.code === c.code);
    if (i >= 0) st.list[i] = c;
  }
}

function forget(code) {
  const c = st.ch[code];
  for (const k of [code, c?.code]) {
    if (!k) continue;
    delete st.ch[k];
    delete st.at[k];
    delete st.tryAt[k];
    delete st.err[k];
  }
  if (st.list) st.list = st.list.filter((x) => x.code !== code && x.code !== c?.code);
}

// ── Загрузка ──────────────────────────────────────────
function loadList(force = false) {
  if (!hasApi()) return Promise.resolve(null);
  if (listReq) return listReq;
  if (!force && Date.now() - Math.max(st.listAt, st.listTry) < TTL) return Promise.resolve(st.list);
  st.listTry = Date.now();
  const g = gen;
  const v = mutVer;
  let stale = false;
  let changed = false;
  const req = call('/api/challenges')
    .then((r) => {
      if (g !== gen) return;
      // Пока шёл запрос, пользователь создал/вступил/вышел — ответ посчитан до этого, перезапросим
      if (v !== mutVer) { stale = true; return; }
      const arr = Array.isArray(r?.challenges) ? r.challenges.map(norm).filter(Boolean) : [];
      const before = JSON.stringify(activeSorted());
      const now = Date.now();
      for (const c of arr) {
        st.ch[c.code] = c;
        st.at[c.code] = now;
      }
      st.list = arr;
      st.listAt = now;
      st.listErr = null;
      changed = JSON.stringify(activeSorted()) !== before;
    })
    .catch((e) => {
      if (g === gen) st.listErr = errInfo(e, 'list');
    })
    .finally(() => {
      if (listReq === req) listReq = null;
      if (g !== gen) return;
      if (stale) { loadList(true); return; }
      // Главная и профиль показывают только активные челленджи: без изменений их не трогаем
      if (changed || onScreen('chHome')) softRender(listVisible);
    });
  listReq = req;
  return req;
}

function loadDetail(code, force = false, manual = false) {
  if (!hasApi() || !CODE_RE.test(code)) return Promise.resolve(null);
  if (detReq[code]) return detReq[code];
  if (!force && Date.now() - Math.max(st.at[code] || 0, st.tryAt[code] || 0) < TTL) return Promise.resolve(st.ch[code] || null);
  st.tryAt[code] = Date.now();
  const g = gen;
  const v = mutVer;
  let stale = false;
  const req = call(`/api/challenges/${encodeURIComponent(code)}`)
    .then((r) => {
      if (g !== gen) return null;
      if (v !== mutVer) { stale = true; return null; }
      const c = norm(r?.challenge);
      if (!c) throw Object.assign(new Error(''), { status: 500 });
      put(c, code);
      return c;
    })
    .catch((e) => {
      if (g !== gen) return null;
      st.err[code] = errInfo(e, 'detail');
      // Нажали «Обновить» внизу экрана — плашка ошибки вверху может быть не видна
      if (manual && st.ch[code]) ctx.toast(st.err[code].msg);
      return null;
    })
    .finally(() => {
      if (detReq[code] === req) delete detReq[code];
      if (g !== gen) return;
      if (stale) { loadDetail(code, true, manual); return; }
      softRender(() => onScreen('chDetail', code) || onScreen('chJoin', code));
    });
  detReq[code] = req;
  return req;
}

// ── Данные челленджа для отображения ──────────────────
function pname(p) {
  const n = String(p?.name || '').trim();
  if (n) return n.slice(0, 40);
  return p?.username ? `@${String(p.username).slice(0, 32)}` : 'Участник';
}

function initial(p) {
  const n = pname(p).replace(/^@/, '');
  return (Array.from(n)[0] || '?').toUpperCase();
}

function avaColor(p) {
  const s = String(p?.id ?? pname(p));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AVA_COLORS[Math.abs(h) % AVA_COLORS.length];
}

// Места: сначала достигшие цели (кто раньше), потом по прогрессу; победитель — первым
function ranked(c) {
  const ps = (c.participants || []).map((p, i) => ({
    ...p,
    _i: i,
    _prog: num(p.progress),
    _reached: p.reached_at ? Date.parse(p.reached_at) || 0 : 0,
  }));
  ps.sort((a, b) => {
    if (a._reached && b._reached) return a._reached - b._reached || a._i - b._i;
    if (a._reached) return -1;
    if (b._reached) return 1;
    return b._prog - a._prog || a._i - b._i;
  });
  const wid = c.winner?.id;
  if (wid != null) {
    const wi = ps.findIndex((p) => String(p.id) === String(wid));
    if (wi > 0) ps.unshift(ps.splice(wi, 1)[0]);
  }
  return ps;
}

function winnerOf(c, ps) {
  const w = c.winner;
  if (!w || typeof w !== 'object') return null;
  const p = ps.find((x) => String(x.id) === String(w.id));
  return p || { id: w.id, name: w.name, is_me: false };
}

function title(c) {
  const t = String(c.title || '').trim();
  if (t) return t.slice(0, 120);
  if (c.type === 'lift' || c.type === 'workouts' || c.type === 'volume') {
    return genTitle({
      type: c.type,
      exercise: EX_FULL[c.exercise] ? c.exercise : 'bb_bench',
      target: c.type === 'volume' ? num(c.target) / 1000 : num(c.target),
      days: num(c.days),
    });
  }
  return 'Челлендж';
}

function exName(c) {
  return String(c.exercise_name || '').trim() || EX_FULL[c.exercise] || 'упражнение';
}

// Значение в единицах челленджа: lift — кг, workouts — шт, volume — тонны (сервер шлёт кг)
function valText(c, v) {
  v = num(v);
  if (c.type === 'volume') return fmtN(v / 1000);
  if (c.type === 'workouts') return ctx.fmt(v);
  return fmtN(v);
}

function unitOf(c) {
  if (c.type === 'lift') return 'кг';
  if (c.type === 'workouts') return 'трен.';
  if (c.type === 'volume') return 'т';
  return '';
}

function pctOf(c, v) {
  const t = num(c.target);
  return t > 0 ? clamp((num(v) / t) * 100, 0, 100) : 0;
}

function goalText(c) {
  const t = num(c.target);
  if (c.type === 'lift') return `${fmtN(t)} кг · ${ctx.esc(exName(c))}`;
  if (c.type === 'workouts') return `${ctx.fmt(t)} ${ctx.plural(t, 'тренировка', 'тренировки', 'тренировок')}`;
  if (c.type === 'volume') return `${fmtN(t / 1000)} т объёма`;
  return ctx.fmt(t);
}

// Сколько дней осталось, включая сегодняшний. Считаем по UTC, как сервер:
// он завершает челлендж, когда UTC-дата становится больше ends_on.
function daysLeft(c) {
  if (!DATE_RE.test(String(c.ends_on || ''))) return null;
  return Math.round((ctx.parseKey(c.ends_on) - ctx.parseKey(todayUtc())) / 864e5) + 1;
}

// Когда челлендж фактически завершился: finished_at (досрочная победа) или срок, если он уже прошёл
function finishedOn(c) {
  if (isActive(c)) return null;
  const f = c.finished_at ? new Date(c.finished_at) : null;
  if (f && !Number.isNaN(f.getTime())) return f;
  const e = String(c.ends_on || '');
  return DATE_RE.test(e) && e <= todayUtc() ? ctx.parseKey(e) : null;
}

function termText(c) {
  if (!isActive(c)) return 'завершён';
  const n = daysLeft(c);
  if (n === null) return 'без срока';
  if (n <= 0) return 'подводим итоги';
  if (n === 1) return 'последний день';
  return `осталось ${n} дн.`;
}

function periodText(c) {
  const d = num(c.days);
  const len = d > 0 ? `${d} ${dn(d)}` : 'Без срока';
  if (!isActive(c)) {
    const f = finishedOn(c);
    return f ? `${len} · завершён ${ctx.dayMonth(f)}` : len;
  }
  const end = DATE_RE.test(String(c.ends_on || '')) ? ` · до ${ctx.dayMonth(ctx.parseKey(c.ends_on))}` : '';
  return d > 0 ? `${len}${end}` : len;
}

function isoShort(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : ctx.shortDate(ctx.dkey(d));
}

function remainText(c, me) {
  const t = num(c.target);
  const r = t - me._prog;
  if (me._reached || r <= 0) return 'Цель достигнута!';
  if (c.type === 'lift') return `До цели ${fmtN(r)} кг`;
  if (c.type === 'workouts') return `До цели ${ctx.fmt(r)} ${ctx.plural(r, 'тренировка', 'тренировки', 'тренировок')}`;
  if (c.type === 'volume') return `До цели ${fmtN(r / 1000)} т`;
  return '';
}

function rulesText(c) {
  const t = num(c.target);
  const end = DATE_RE.test(String(c.ends_on || '')) ? ` до ${ctx.dayMonth(ctx.parseKey(c.ends_on))}` : '';
  const late = 'Если к концу срока цель не возьмёт никто — побеждает лидер.';
  if (c.type === 'lift') {
    return `Побеждает тот, кто первым возьмёт ${fmtN(t)} кг в упражнении «${ctx.esc(exName(c))}»${end}. Засчитывается лучший рабочий вес из тренировок в приложении.${num(c.days) > 0 ? ` ${late}` : ''}`;
  }
  if (c.type === 'workouts') return `Побеждает тот, кто первым сделает ${ctx.fmt(t)} ${ctx.plural(t, 'тренировку', 'тренировки', 'тренировок')}${end}. Считаются тренировки, завершённые в приложении. ${late}`;
  if (c.type === 'volume') return `Объём — сумма «вес × повторы» во всех подходах. Побеждает тот, кто первым наберёт ${fmtN(t / 1000)} т${end}. ${late}`;
  return 'Прогресс считается по тренировкам в приложении.';
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'обновлено только что';
  if (s < 3600) return `обновлено ${Math.round(s / 60)} мин назад`;
  const d = new Date(ts);
  return `обновлено в ${ctx.pad2(d.getHours())}:${ctx.pad2(d.getMinutes())}`;
}

function inviteLink(c) {
  const l = String(c?.invite_link || '');
  if (/^https:\/\/t\.me\/[^\s"'<>]+$/.test(l)) return l;
  const bot = ctx.botUsername?.() || '';
  return bot && c?.code ? `https://t.me/${bot}?start=ch_${c.code}` : '';
}

function activeSorted() {
  const byLeft = (a, b) => {
    const la = daysLeft(a);
    const lb = daysLeft(b);
    if (la === null && lb === null) return 0;
    if (la === null) return 1;
    if (lb === null) return -1;
    return la - lb;
  };
  return (st.list || []).filter(isActive).sort(byLeft);
}

// ── Форма создания ────────────────────────────────────
const localBest = (ex) => {
  const l = ctx.S().lifts?.[ex];
  return num(l?.best || l?.w);
};
// Цель выше рекорда: округлить вверх до 5 и прибавить 10 (минимум 20, максимум 500)
const liftAbove = (best) => Math.min(500, Math.max(20, Math.ceil(best / 5) * 5 + 10));

function liftDefault(ex) {
  const best = localBest(ex);
  if (best > 0) return liftAbove(best);
  return ex === 'bb_bench' ? 100 : 20;
}

// Цель так, как она уйдёт на сервер: lift — шаг 0,5 кг, workouts — целое, volume — 0,1 т.
// Одна функция и для превью, и для тела запроса — чтобы друзья увидели то же число.
function normTarget(f) {
  const t = toNum(f.target);
  if (!(Number.isFinite(t) && t > 0)) return NaN;
  if (f.type === 'lift') return Math.round(t * 2) / 2;
  if (f.type === 'workouts') return Math.round(t);
  return Math.round(t * 10) / 10;
}

function newForm(type = 'lift') {
  if (type === 'workouts') return { type, exercise: 'bb_bench', target: 12, days: 30, err: '' };
  if (type === 'volume') return { type, exercise: 'bb_bench', target: 20, days: 30, err: '' };
  return { type: 'lift', exercise: 'bb_bench', target: liftDefault('bb_bench'), days: 0, err: '' };
}

// Название как у сервера (bot/api.py make_title): «Жим штанги лёжа — 100 кг»,
// «12 тренировок за 30 дней», «20 000 кг объёма за 30 дней». target формы: lift — кг, volume — тонны.
function genTitle(f) {
  const t = normTarget(f);
  const ok = Number.isFinite(t);
  const period = `за ${f.days} ${dn(f.days)}`;
  if (f.type === 'lift') return `${EX_FULL[f.exercise] || EX_FULL.bb_bench} — ${ok ? fmtN(t) : '…'} кг`;
  if (f.type === 'workouts') return `${ok ? ctx.fmt(t) : '…'} ${ctx.plural(ok ? t : 0, 'тренировка', 'тренировки', 'тренировок')} ${period}`;
  return `${ok ? ctx.fmt(Math.round(t * 1000)) : '…'} кг объёма ${period}`;
}

function formRules(f) {
  const t = normTarget(f);
  const ok = Number.isFinite(t);
  const tt = ok ? fmtN(t) : '…';
  const term = f.days ? ` за ${f.days} ${dn(f.days)}` : '';
  if (f.type === 'lift') {
    const w = f.exercise === 'db_bench' ? ' (вес одной гантели)' : '';
    return `Побеждает тот, кто первым возьмёт ${tt} кг${w} в упражнении «${EX_FULL[f.exercise]}»${term}.`;
  }
  if (f.type === 'workouts') return `Побеждает тот, кто первым сделает ${tt} ${ctx.plural(ok ? t : 0, 'тренировку', 'тренировки', 'тренировок')}${term}.`;
  return `Побеждает тот, кто первым поднимет ${tt} т суммарного веса${term}. Объём — «вес × повторы» во всех подходах.`;
}

// Ошибка создания показывается в нижней панели над кнопкой — её видно при любой прокрутке
function errBox(f) {
  return `<div class="ch-cerr" id="ch-err" role="alert" ${f.err ? '' : 'hidden'}>${ctx.icon('alert', 'sm')}<span>${ctx.esc(f.err || '')}</span></div>`;
}

function updatePreview() {
  const f = st.form;
  if (!f) return;
  const t = document.getElementById('ch-pv-title');
  if (t) t.textContent = genTitle(f);
  const r = document.getElementById('ch-pv-rules');
  if (r) r.textContent = formRules(f);
  const e = document.getElementById('ch-err');
  if (e) {
    e.hidden = !f.err;
    const s = e.querySelector('span');
    if (s) s.textContent = f.err || '';
    e.closest('.page')?.classList.toggle('ch-erring', !!f.err);
  }
}

// ── Действия с сервером ───────────────────────────────
async function create() {
  const f = st.form;
  if (!f || st.creating) return;
  if (!hasApi()) { ctx.toast('Челленджи скоро заработают'); return; }
  const T = TYPES[f.type];
  const t = normTarget(f);
  if (!(t >= T.min && t <= T.max)) {
    f.err = `Цель — от ${T.min} до ${T.max} ${T.unit}`;
    ctx.haptic.warn();
    updatePreview();
    return;
  }
  f.target = t; // поле после отрисовки покажет ровно то, что ушло на сервер
  const body = { type: f.type };
  if (f.type === 'lift') body.exercise = f.exercise;
  body.target = f.type === 'volume' ? Math.round(t * 1000) : t;
  body.days = T.days.includes(+f.days) ? +f.days : T.days[0];
  st.creating = true;
  f.err = '';
  if (onScreen('chCreate')) ctx.render();
  let created = null;
  try {
    const r = await call('/api/challenges', { method: 'POST', body });
    created = norm(r?.challenge);
    if (!created) throw Object.assign(new Error(''), { status: 500 });
  } catch (e) {
    st.creating = false;
    const info = errInfo(e, 'create');
    f.err = info.msg;
    if (info.timeout) {
      // Запрос мог дойти до сервера — подтянем список, чтобы не создать дубль
      f.err = 'Сервер не ответил вовремя. Загляни в список челленджей — возможно, он уже создан.';
      mutVer += 1;
      loadList(true);
    }
    ctx.haptic.warn();
    if (onScreen('chCreate')) ctx.render();
    else ctx.toast(f.err);
    return;
  }
  st.creating = false;
  mutVer += 1;
  put(created);
  st.list = [created, ...(st.list || []).filter((x) => x.code !== created.code)];
  st.listAt = 0;
  st.form = null;
  ctx.haptic.ok();
  if (onScreen('chCreate')) {
    ctx.back();
    ctx.push('chDetail', { code: created.code });
    share(created);
  } else {
    // Пользователь уже ушёл с формы — не выдёргиваем его окном «Поделиться»
    ctx.toast('Челлендж создан — позови друзей');
  }
}

// Рекорд уже не ниже цели: сервер берёт для lift лучший вес за всё время,
// поэтому вступление сразу сделает победителем и закончит челлендж для всех
function wouldWinAtOnce(c) {
  return c?.type === 'lift' && num(c.target) > 0 && localBest(c.exercise) >= num(c.target);
}

async function join(code) {
  if (st.joining || st.confirming || !hasApi()) return;
  const before = st.ch[code];
  if (wouldWinAtOnce(before)) {
    const ok = await ask(`Твой рекорд — ${fmtN(localBest(before.exercise))} кг, цель уже взята. Если примешь вызов, сразу станешь победителем и челлендж закончится для всех. Принять?`);
    if (!ok || st.joining) return;
  }
  st.joining = code;
  if (onScreen('chJoin', code) || onScreen('chDetail', code)) ctx.render();
  try {
    const r = await call(`/api/challenges/${encodeURIComponent(code)}/join`, { method: 'POST', body: {} });
    const c = norm(r?.challenge);
    st.joining = '';
    mutVer += 1;
    if (c) {
      put(c, code);
      if (st.list && !st.list.some((x) => x.code === c.code)) st.list = [c, ...st.list];
    } else {
      delete st.at[code];
      delete st.tryAt[code];
      loadDetail(code, true);
    }
    st.listAt = 0;
    ctx.haptic.ok();
    const wonNow = c && !isActive(c) && c.participants.some((p) => p.is_me && c.winner && String(p.id) === String(c.winner.id));
    ctx.toast(wonNow ? 'Цель уже взята — победа!' : 'Вызов принят — удачи!');
    if (onScreen('chJoin', code)) {
      ctx.back();
      ctx.push('chDetail', { code });
    } else if (onScreen('chDetail', code)) {
      ctx.render();
    }
  } catch (e) {
    st.joining = '';
    ctx.haptic.warn();
    ctx.toast(errInfo(e, 'join').msg);
    if (onScreen('chJoin', code) || onScreen('chDetail', code)) ctx.render();
  }
}

async function leave(code) {
  if (st.leaving || st.confirming || !hasApi()) return;
  const ok = await ask('Выйти из челленджа? Твой результат в нём пропадёт.');
  if (!ok || st.leaving) return;
  st.leaving = code;
  if (onScreen('chDetail', code)) ctx.render();
  try {
    await call(`/api/challenges/${encodeURIComponent(code)}/leave`, { method: 'POST', body: {} });
    st.leaving = '';
    mutVer += 1;
    forget(code);
    st.listAt = 0;
    ctx.haptic.ok();
    ctx.toast('Ты больше не участвуешь в челлендже');
    if (onScreen('chDetail', code)) ctx.back();
  } catch (e) {
    st.leaving = '';
    ctx.haptic.warn();
    ctx.toast(errInfo(e, 'leave').msg);
    if (onScreen('chDetail', code)) ctx.render();
  }
}

function share(c) {
  const link = inviteLink(c);
  if (!link) { ctx.toast('Ссылка ещё не готова — нажми «Обновить»'); return; }
  ctx.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Принимай вызов: ${title(c)}!`)}`);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* попробуем запасной способ */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyLink(code) {
  const link = inviteLink(st.ch[code]);
  if (!link) { ctx.toast('Ссылка ещё не готова — нажми «Обновить»'); return; }
  if (await copyText(link)) {
    ctx.haptic.ok();
    ctx.toast('Ссылка скопирована');
  } else {
    ctx.openSheet('chLink', { code });
  }
}

// Приглашение по ссылке: сразу экран вступления, участнику — сразу детали
function openInvite(code) {
  if (!CODE_RE.test(code)) return;
  if (onScreen('chJoin', code) || onScreen('chDetail', code)) return;
  const cached = st.ch[code];
  if (cached && cached.participants.some((p) => p.is_me)) {
    ctx.push('chDetail', { code });
    loadDetail(code);
    return;
  }
  ctx.push('chJoin', { code });
  if (!hasApi()) return;
  loadDetail(code, true).then((c) => {
    if (c && c.participants.some((p) => p.is_me) && onScreen('chJoin', code)) {
      ctx.back();
      ctx.push('chDetail', { code });
    }
  });
}

// ── Разметка: общие куски ─────────────────────────────
function bar(pct, cls = '') {
  return `<div class="ch-bar ${cls}"><div style="width:${pct.toFixed(1)}%"></div></div>`;
}

function ava(p, size = '') {
  return `<span class="ch-ava ${size}" style="--c:${avaColor(p)}">${ctx.esc(initial(p))}</span>`;
}

function avatars(ps) {
  const extra = ps.length > 4 ? `<span class="ch-ava xs more">+${ps.length - 4}</span>` : '';
  return `<div class="ch-avas">${ps.slice(0, 4).map((p) => ava(p, 'xs')).join('')}${extra}</div>`;
}

function placeBox(place, total) {
  return `<div class="ch-place ${place === 1 ? 'first' : ''}"><b class="num">${place}</b><span>из ${total}</span></div>`;
}

function leaderLine(ps) {
  const lead = ps[0];
  if (!lead) return '';
  if (ps.length > 1 && ps.every((p) => p._prog <= 0)) return 'Пока все на старте';
  if (lead.is_me) return ps.length > 1 ? '<span class="accent">Ты лидируешь</span>' : 'Ждём соперников';
  return `Лидер: <b>${ctx.esc(pname(lead))}</b>`;
}

function skel(w, h, extra = '') {
  return `<div class="ch-skel" style="width:${w};height:${h}px;${extra}"></div>`;
}

function skelList() {
  const card = `<div class="card ch-card">
    <div class="row">${skel('44px', 44, 'border-radius:14px')}<div class="grow">${skel('72%', 14)}${skel('46%', 11, 'margin-top:9px')}</div></div>
    ${skel('100%', 8, 'margin-top:18px')}</div>`;
  return `<div aria-busy="true" aria-label="Загрузка" style="margin-top:4px">${card}${card}${card}</div>`;
}

function skelDetail(invite = false) {
  const rows = [0, 1, 2].map(() => `<div class="ch-row">${skel('34px', 34, 'border-radius:50%')}<div class="grow">${skel('55%', 12)}${skel('100%', 7, 'margin-top:10px')}</div></div>`).join('');
  const head = invite
    ? `<div class="ch-invite">${skel('76px', 76, 'border-radius:24px;margin:4px auto 18px')}${skel('60%', 12, 'margin:0 auto')}${skel('85%', 22, 'margin:12px auto 0')}</div>`
    : '';
  return `<div aria-busy="true" aria-label="Загрузка">${head}
    <div class="card">${skel('40%', 22, 'border-radius:999px')}${skel('80%', 18, 'margin-top:14px')}${skel('100%', 12, 'margin-top:18px')}${skel('100%', 12, 'margin-top:12px')}</div>
    <div class="section-title">${skel('30%', 16)}</div>
    <div class="card list">${rows}</div></div>`;
}

function errPlaque(err, act, code = '') {
  return `<div class="ch-err">${ctx.icon('alert', 'sm')}<div class="grow">${ctx.esc(err.msg)}</div>
    <button class="btn sm ghost" data-act="${act}" ${code ? `data-code="${ctx.esc(code)}"` : ''}>${ctx.icon('refresh', 'sm')}Повторить</button></div>`;
}

function errFull(err, act, code = '') {
  const notFound = err.status === 404;
  return `<div class="card ch-empty">
    <div class="ch-empty-ic danger">${ctx.icon(notFound ? 'search' : 'alert', 'lg')}</div>
    <div class="h3">${notFound ? 'Челлендж не найден' : 'Не удалось загрузить'}</div>
    <div class="sub small" style="margin-top:6px">${ctx.esc(err.msg)}</div>
    ${notFound
      ? `<button class="btn sm ghost" style="margin-top:16px" data-act="chToList">${ctx.icon('users', 'sm')}К челленджам</button>`
      : `<button class="btn sm" style="margin-top:16px" data-act="${act}" ${code ? `data-code="${ctx.esc(code)}"` : ''}>${ctx.icon('refresh', 'sm')}Повторить</button>`}
  </div>`;
}

function boardRow(c, p, i, w) {
  const isW = w && String(w.id) === String(p.id);
  const reached = p.reached_at ? isoShort(p.reached_at) : '';
  const cls = p.is_me ? 'me' : p._reached ? 'done' : 'other';
  return `<div class="ch-row ${p.is_me ? 'me' : ''}">
    <div class="ch-rank ${i === 0 ? 'top' : ''}">${i + 1}</div>
    ${ava(p)}
    <div class="grow">
      <div class="ch-row-head">
        <div class="ch-name"><span class="n">${ctx.esc(pname(p))}</span>${p.is_me ? '<span class="ch-you">ты</span>' : ''}${isW ? `<span class="ch-crown" title="Победитель">${ctx.icon('crown', 'sm')}</span>` : ''}</div>
        <div class="num small ch-val"><b>${valText(c, p._prog)}</b> <span class="muted">${unitOf(c)}</span></div>
      </div>
      ${bar(pctOf(c, p._prog), cls)}
      ${reached ? `<div class="tiny ch-reached">${ctx.icon('check', 'sm')}цель взята ${reached}</div>` : ''}
    </div>
  </div>`;
}

const SAMPLE = [
  { id: 's1', name: 'Макс', _prog: 95 },
  { id: 's2', name: 'Ты', _prog: 85, is_me: true },
  { id: 's3', name: 'Аня', _prog: 62.5 },
];

function sampleCard() {
  const c = { type: 'lift', target: 100 };
  return `<div class="card ch-sample">
    <div class="row between"><span class="badge accent">${ctx.icon('dumbbell', 'sm')}Пример</span><span class="badge">${ctx.icon('clock', 'sm')}осталось 18 дн.</span></div>
    <div class="h2" style="margin-top:12px">Кто первый пожмёт 100 кг</div>
    <div class="list" style="margin-top:6px">${SAMPLE.map((p, i) => `<div class="ch-row ${p.is_me ? 'me' : ''}">
      <div class="ch-rank ${i === 0 ? 'top' : ''}">${i + 1}</div>${ava(p, 'sm')}
      <div class="grow"><div class="ch-row-head"><div class="ch-name"><span class="n">${p.name}</span></div><div class="num small ch-val"><b>${fmtN(p._prog)}</b> <span class="muted">кг</span></div></div>
      ${bar(pctOf(c, p._prog), p.is_me ? 'me' : 'other')}</div></div>`).join('')}</div>
  </div>`;
}

function stubPage(head, invite = false) {
  const admin = ctx.tgUser?.id === ADMIN_ID;
  const kinds = [
    ['dumbbell', 'Кто первый пожмёт 100 кг', 'Гонка за весом в жиме, приседе или становой'],
    ['calendar', '12 тренировок за 30 дней', 'Кто чаще и стабильнее ходит в зал'],
    ['chart', '20 тонн объёма за месяц', 'Кто поднимет больше суммарного веса'],
  ];
  return `<div class="page no-tabs">${ctx.backHeader(head)}
    <div class="ch-invite">
      <div class="ch-logo">${ctx.icon(invite ? 'crown' : 'users')}</div>
      <div class="h1">${invite ? 'Тебя позвали в челлендж' : 'Соревнуйся с друзьями'}</div>
      <div class="sub" style="margin-top:8px">Брось вызов друзьям и следи, кто первым дойдёт до цели. Прогресс считается сам — по твоим тренировкам.</div>
    </div>
    ${sampleCard()}
    <div class="section-title"><div class="h3">Какие бывают</div></div>
    <div class="card list">${kinds.map(([ic, t, s]) => `<div class="list-item"><div class="icon-box accent">${ctx.icon(ic)}</div>
      <div class="grow"><div class="h3">${t}</div><div class="sub small">${s}</div></div></div>`).join('')}</div>
    <div class="notice ch-soon" style="margin-top:14px">${ctx.icon('clock', 'sm')}<div><b>Челленджи скоро заработают — мы запускаем сервер.</b><br>Загляни чуть позже: всё будет готово.</div></div>
    ${admin ? `<div class="tiny muted ch-admin">Для запуска: bot/DEPLOY.md в репозитории</div>` : ''}
  </div>`;
}

// ── Экраны ────────────────────────────────────────────
function activeCard(c) {
  const ps = ranked(c);
  const i = ps.findIndex((p) => p.is_me);
  const me = ps[i];
  const T = typeOf(c);
  return `<button class="card ch-card" data-act="chOpen" data-code="${ctx.esc(c.code)}">
    <div class="row top">
      <div class="icon-box accent">${ctx.icon(T.icon)}</div>
      <div class="grow"><div class="h3 ch-title">${ctx.esc(title(c))}</div><div class="sub small">${T.label} · ${termText(c)}</div></div>
      ${me ? placeBox(i + 1, ps.length) : ''}
    </div>
    <div class="ch-prog">
      <div class="row between small"><span class="sub">Твой прогресс</span><span class="num"><b>${valText(c, me?._prog)}</b> <span class="muted">/ ${valText(c, c.target)} ${unitOf(c)}</span></span></div>
      ${bar(pctOf(c, me?._prog), 'me')}
    </div>
    <div class="ch-foot">${avatars(ps)}<span class="sub small ch-lead">${leaderLine(ps)}</span></div>
  </button>`;
}

function finishedItem(c) {
  const ps = ranked(c);
  const w = winnerOf(c, ps);
  const won = !!w?.is_me;
  const sub = won ? '<span class="accent">Ты победитель!</span>' : w ? `Победитель: ${ctx.esc(pname(w))}` : 'Без победителя';
  const f = finishedOn(c);
  const end = f ? ` · ${ctx.shortDate(ctx.dkey(f))}` : '';
  return `<button class="list-item" data-act="chOpen" data-code="${ctx.esc(c.code)}">
    <div class="icon-box ${won ? 'accent' : ''}">${ctx.icon(won ? 'crown' : 'flag')}</div>
    <div class="grow"><div class="h3 ch-clamp">${ctx.esc(title(c))}</div><div class="sub small ellipsis">${sub}${end}</div></div>
    <span class="muted">${ctx.icon('right', 'sm')}</span></button>`;
}

function emptyState() {
  const ideas = [
    ['lift', 'dumbbell', 'Кто первый пожмёт 100 кг'],
    ['workouts', 'calendar', '12 тренировок за месяц'],
    ['volume', 'chart', '20 тонн объёма'],
  ];
  return `<div class="card ch-empty">
    <div class="ch-empty-ic">${ctx.icon('users', 'lg')}</div>
    <div class="h3">Пока нет челленджей</div>
    <div class="sub small" style="margin-top:6px">Брось вызов друзьям — соревноваться веселее, чем тренироваться в одиночку. Выбери идею:</div>
    <div class="ch-ideas">${ideas.map(([t, ic, s]) => `<button class="chip" data-act="chNew" data-t="${t}">${ctx.icon(ic, 'sm')}${s}</button>`).join('')}</div>
  </div>`;
}

function screenHome() {
  if (!hasApi()) return stubPage('Челленджи');
  loadList();
  let body;
  if (!st.list) {
    body = st.listErr && !listReq ? errFull(st.listErr, 'chRetryList') : skelList();
  } else {
    const act = activeSorted();
    const fin = st.list.filter((c) => !isActive(c));
    body = (st.listErr ? errPlaque(st.listErr, 'chRetryList') : '')
      + (act.length || fin.length ? '' : emptyState())
      + (act.length ? `<div class="section-title" style="margin-top:6px"><div class="h3">Активные</div><span class="sub small">${act.length}</span></div>${act.map(activeCard).join('')}` : '')
      + (fin.length ? `<div class="section-title"><div class="h3">Завершённые</div></div><div class="card list">${fin.map(finishedItem).join('')}</div>` : '');
  }
  return `<div class="page no-tabs">${ctx.backHeader('Челленджи', 'Соревнуйся с друзьями')}${body}
    <div class="bottom-bar"><div class="inner"><button class="btn block" data-act="chNew">${ctx.icon('plus')} Создать челлендж</button></div></div>
  </div>`;
}

function stepperHtml(f) {
  const T = TYPES[f.type];
  return `<div class="stepper">
    <button class="icon-btn" data-act="chStep" data-d="${-T.step}" aria-label="Меньше">${ctx.icon('minus')}</button>
    <input type="number" inputmode="decimal" value="${ctx.esc(f.target)}" data-bind="chTarget" aria-label="Цель">
    <span class="unit">${T.unit}</span>
    <button class="icon-btn" data-act="chStep" data-d="${T.step}" aria-label="Больше">${ctx.icon('plus')}</button>
  </div>`;
}

function screenCreate() {
  if (!st.form) st.form = newForm('lift');
  const f = st.form;
  const T = TYPES[f.type];
  const types = Object.entries(TYPES).map(([k, t]) => `<button class="choice ${f.type === k ? 'on' : ''}" data-act="chType" data-v="${k}">
      <div class="icon-box ${f.type === k ? 'accent' : ''}">${ctx.icon(t.icon)}</div>
      <div class="grow"><div class="t">${t.title}</div><div class="sub small">${t.hint}</div></div>
      <div class="check">${ctx.icon('check', 'sm')}</div></button>`).join('');
  let hint = '';
  if (f.type === 'lift') {
    const best = localBest(f.exercise);
    const one = f.exercise === 'db_bench' ? 'Вес одной гантели. ' : '';
    hint = best > 0 ? `${one}Твой лучший рабочий вес: <b>${fmtN(best)} кг</b>` : `${one}В этом упражнении у тебя пока нет записей`;
  } else if (f.type === 'workouts') {
    hint = `От ${T.min} до ${T.max} тренировок`;
  } else {
    hint = 'Обычная силовая тренировка — 3–8 т объёма';
  }
  const daysChips = T.days.map((d) => `<button class="chip ${+f.days === d ? 'on' : ''}" data-act="chSet" data-k="days" data-v="${d}">${d ? `${d} ${dn(d)}` : 'Без срока'}</button>`).join('');
  const busy = st.creating;
  return `<div class="page no-tabs${f.err ? ' ch-erring' : ''}">${ctx.backHeader('Новый челлендж', 'Выбери формат и цель')}
    <div class="ch-types">${types}</div>
    <div class="section-title"><div class="h3">Условия</div></div>
    ${f.type === 'lift' ? `<div class="field"><label>Упражнение</label><div class="chips">${EXERCISES.map(([id, n]) => `<button class="chip ${f.exercise === id ? 'on' : ''}" data-act="chSet" data-k="exercise" data-v="${id}">${n}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Цель</label>${stepperHtml(f)}<div class="sub small ch-hint">${hint}</div></div>
    <div class="field"><label>Срок</label><div class="chips">${daysChips}</div></div>
    <div class="section-title"><div class="h3">Так увидят друзья</div></div>
    <div class="card ch-preview">
      <div class="row top"><div class="icon-box accent">${ctx.icon(T.icon)}</div>
      <div class="grow"><div class="h2" id="ch-pv-title">${ctx.esc(genTitle(f))}</div>
      <div class="sub small" id="ch-pv-rules" style="margin-top:6px">${ctx.esc(formRules(f))}</div></div></div>
    </div>
    <div class="bottom-bar"><div class="inner ch-col">${errBox(f)}<button class="btn block" data-act="chCreateGo" ${busy ? 'disabled' : ''}>${busy ? `${ctx.icon('refresh', 'ch-spin')} Создаём…` : `${ctx.icon('share')} Создать и позвать друзей`}</button></div></div>
  </div>`;
}

function screenDetail({ code } = {}) {
  code = String(code || '');
  if (!hasApi()) return stubPage('Челлендж');
  if (!CODE_RE.test(code)) return `<div class="page no-tabs">${ctx.backHeader('Челлендж')}${errFull({ msg: 'Неверная ссылка на челлендж.', status: 404 }, '')}</div>`;
  loadDetail(code);
  const c = st.ch[code];
  const e = st.err[code];
  if (!c) {
    return `<div class="page no-tabs">${ctx.backHeader('Челлендж')}${e && !detReq[code] ? errFull(e, 'chRetry', code) : skelDetail()}</div>`;
  }
  const ps = ranked(c);
  const meI = ps.findIndex((p) => p.is_me);
  const me = ps[meI];
  const active = isActive(c);
  const w = winnerOf(c, ps);
  const T = typeOf(c);
  const ec = ctx.esc(code);
  const loading = !!detReq[code];

  const mine = me ? `<div class="ch-mine">
      <div class="row between small"><span class="sub">Ты · ${meI + 1} место из ${ps.length}</span><span class="num"><b>${valText(c, me._prog)}</b> <span class="muted">/ ${valText(c, c.target)} ${unitOf(c)}</span></span></div>
      ${bar(pctOf(c, me._prog), 'me lg')}
      <div class="tiny muted" style="margin-top:6px">${remainText(c, me)}</div>
    </div>` : '';

  const winner = w ? `<div class="card ch-win">
      <div class="ch-win-ic">${ctx.icon('crown')}</div>
      <div class="grow"><div class="sub small">Победитель</div><div class="h3">${w.is_me ? 'Это ты! Поздравляем' : ctx.esc(pname(w))}</div></div>
    </div>` : '';

  const alone = active && me && ps.length === 1
    ? `<div class="notice ch-alone" style="margin-top:12px">${ctx.icon('users', 'sm')}<div>Пока здесь только ты. Отправь ссылку друзьям — они появятся в таблице, как только примут вызов.</div></div>`
    : '';
  const notMember = !me
    ? `<div class="notice" style="margin-top:12px">${ctx.icon('info', 'sm')}<div>${active ? 'Ты не участвуешь в этом челлендже. Прими вызов, чтобы попасть в таблицу.' : 'Ты не участвовал(а) в этом челлендже.'}</div></div>`
    : '';

  const items = [];
  if (active && me) {
    items.push(`<button class="list-item" data-act="chCopy" data-code="${ec}"><div class="icon-box">${ctx.icon('link')}</div><div class="grow"><div class="h3">Скопировать ссылку</div><div class="sub small ellipsis">${ctx.esc(inviteLink(c).replace(/^https:\/\//, ''))}</div></div></button>`);
  }
  const refreshSub = loading
    ? 'Загружаем…'
    : e ? '<span class="ch-fail">Не удалось обновить — нажми ещё раз</span>' : ago(st.at[code]);
  items.push(`<button class="list-item" data-act="chRefresh" data-code="${ec}" ${loading ? 'disabled' : ''}><div class="icon-box">${ctx.icon('refresh', loading ? 'ch-spin' : '')}</div><div class="grow"><div class="h3">Обновить</div><div class="sub small">${refreshSub}</div></div></button>`);
  if (active && me) {
    items.push(`<button class="list-item ch-leave" data-act="chLeave" data-code="${ec}" ${st.leaving === code ? 'disabled' : ''}><div class="icon-box">${ctx.icon('x')}</div><div class="grow"><div class="h3">Выйти из челленджа</div></div></button>`);
  }

  let cta;
  if (active && me) cta = `<button class="btn block" data-act="chShare" data-code="${ec}">${ctx.icon('share')} Позвать друзей</button>`;
  else if (active) cta = `<button class="btn block" data-act="chJoinGo" data-code="${ec}" ${st.joining ? 'disabled' : ''}>${st.joining === code ? `${ctx.icon('refresh', 'ch-spin')} Присоединяемся…` : `${ctx.icon('flag')} Принять вызов`}</button>`;
  else if (me) cta = `<button class="btn block" data-act="chRematch" data-code="${ec}">${ctx.icon('refresh')} Реванш</button>`;
  else cta = `<button class="btn block" data-act="chNew">${ctx.icon('plus')} Создать свой челлендж</button>`;

  return `<div class="page no-tabs">${ctx.backHeader('Челлендж')}
    ${e && e.status !== 404 ? errPlaque(e, 'chRetry', code) : ''}
    <div class="card ch-hero">
      <div class="row between ch-badges"><span class="badge accent">${ctx.icon(T.icon, 'sm')}${T.label}</span><span class="badge">${ctx.icon(active ? 'clock' : 'flag', 'sm')}${termText(c)}</span></div>
      <div class="h2" style="margin-top:12px">${ctx.esc(title(c))}</div>
      <div class="ch-kv">
        <div class="kv"><span class="sub">Цель</span><b>${goalText(c)}</b></div>
        <div class="kv"><span class="sub">Срок</span><b>${periodText(c)}</b></div>
      </div>
      ${mine}
    </div>
    ${winner}${alone}${notMember}
    <div class="section-title"><div class="h3">Таблица</div><span class="sub small">${ps.length} ${ctx.plural(ps.length, 'участник', 'участника', 'участников')}</span></div>
    <div class="card list ch-board">${ps.map((p, i) => boardRow(c, p, i, w)).join('') || '<div class="empty">Пока никого</div>'}</div>
    <div class="notice" style="margin-top:12px">${ctx.icon('info', 'sm')}<div><b>Прогресс обновляется после каждой тренировки.</b> ${rulesText(c)}</div></div>
    <div class="card list ch-actions" style="margin-top:12px">${items.join('')}</div>
    <div class="bottom-bar"><div class="inner">${cta}</div></div>
  </div>`;
}

function screenJoin({ code } = {}) {
  code = String(code || '');
  if (!hasApi()) return stubPage('Приглашение', true);
  if (!CODE_RE.test(code)) return `<div class="page no-tabs">${ctx.backHeader('Приглашение')}${errFull({ msg: 'Неверная ссылка на челлендж.', status: 404 }, '')}</div>`;
  loadDetail(code);
  const c = st.ch[code];
  const e = st.err[code];
  if (!c) {
    return `<div class="page no-tabs">${ctx.backHeader('Приглашение')}${e && !detReq[code] ? errFull(e, 'chRetry', code) : skelDetail(true)}</div>`;
  }
  const ps = ranked(c);
  const me = ps.find((p) => p.is_me);
  const active = isActive(c);
  const w = winnerOf(c, ps);
  const T = typeOf(c);
  const ec = ctx.esc(code);
  const inviter = ps.find((p) => c.created_by != null && String(p.id) === String(c.created_by));
  const full = ps.length >= 50;

  let now = '';
  if (c.type === 'lift') {
    const best = localBest(c.exercise);
    const t = num(c.target);
    if (!(best > 0)) now = 'В этом упражнении у тебя пока нет записей — самое время начать.';
    else if (best < t) now = `Твой лучший рабочий вес сейчас — <b>${fmtN(best)} кг</b>, до цели ${fmtN(t - best)} кг.`;
    else now = `Твой рекорд — <b>${fmtN(best)} кг</b>, цель уже взята. Если примешь вызов, сразу станешь победителем и челлендж закончится для всех.`;
  } else if (c.type === 'workouts' || c.type === 'volume') {
    const from = DATE_RE.test(String(c.starts_on || '')) ? ctx.dayMonth(ctx.parseKey(c.starts_on)) : '';
    now = from ? `Засчитываются тренировки с ${from}, завершённые в приложении.` : 'Засчитываются тренировки, завершённые в приложении.';
  }

  let cta;
  if (me) cta = `<button class="btn block" data-act="chOpen" data-code="${ec}">${ctx.icon('right')} Открыть челлендж</button>`;
  else if (!active) cta = `<button class="btn block" data-act="chNew">${ctx.icon('plus')} Создать свой челлендж</button>`;
  else if (full) cta = `<button class="btn block" disabled>Мест больше нет</button>`;
  else cta = `<button class="btn block" data-act="chJoinGo" data-code="${ec}" ${st.joining ? 'disabled' : ''}>${st.joining === code ? `${ctx.icon('refresh', 'ch-spin')} Присоединяемся…` : `${ctx.icon('flag')} Принять вызов`}</button>`;

  const top = ps.slice(0, 5);
  return `<div class="page no-tabs">${ctx.backHeader('Приглашение')}
    ${e && e.status !== 404 ? errPlaque(e, 'chRetry', code) : ''}
    <div class="ch-invite">
      <div class="ch-logo">${ctx.icon(active ? 'crown' : 'flag')}</div>
      <div class="sub">${inviter ? `<b>${ctx.esc(pname(inviter))}</b> бросает тебе вызов` : 'Тебя позвали в челлендж'}</div>
      <div class="h1 ch-invite-title">${ctx.esc(title(c))}</div>
    </div>
    ${!active ? `<div class="notice" style="margin-bottom:12px">${ctx.icon('flag', 'sm')}<div>Этот челлендж уже завершён${w ? ` — победитель: <b>${ctx.esc(pname(w))}</b>` : ''}. Создай свой и позови друзей!</div></div>` : ''}
    <div class="card ch-kv ch-terms">
      <div class="kv"><span class="sub">Формат</span><b>${T.format || T.title || T.label}</b></div>
      <div class="kv"><span class="sub">Цель</span><b>${goalText(c)}</b></div>
      <div class="kv"><span class="sub">Срок</span><b>${active ? periodText(c) : 'завершён'}</b></div>
      <div class="kv"><span class="sub">Участники</span><b>${ps.length}${full ? ' · мест нет' : ''}</b></div>
    </div>
    ${now && active ? `<div class="notice" style="margin-top:12px">${ctx.icon('target', 'sm')}<div>${now}</div></div>` : ''}
    <div class="section-title"><div class="h3">Участники</div><span class="sub small">${ps.length}</span></div>
    <div class="card list ch-board">${top.map((p, i) => boardRow(c, p, i, w)).join('') || '<div class="empty">Пока никого</div>'}</div>
    ${ps.length > top.length ? `<div class="sub small" style="text-align:center;margin-top:10px">и ещё ${ps.length - top.length}</div>` : ''}
    <div class="notice" style="margin-top:12px">${ctx.icon('info', 'sm')}<div>${rulesText(c)}</div></div>
    <div class="bottom-bar"><div class="inner">${cta}</div></div>
  </div>`;
}

function linkSheet({ code } = {}) {
  const link = inviteLink(st.ch[code]);
  return `<div class="h2">Ссылка-приглашение</div>
    <div class="sub small" style="margin-top:4px">Не получилось скопировать автоматически — выдели ссылку и скопируй вручную.</div>
    <input class="input ch-link-input" style="margin-top:14px" readonly value="${ctx.esc(link)}" id="ch-link-input">
    <button class="btn block" style="margin-top:14px" data-act="closeSheet">Готово</button>`;
}

// ── Слоты ─────────────────────────────────────────────
function homeCard() {
  if (!hasApi()) return '';
  if (st.list === null) loadList();
  const act = activeSorted();
  if (!act.length) return '';
  const c = act[0];
  const ps = ranked(c);
  const i = ps.findIndex((p) => p.is_me);
  const me = ps[i];
  const T = typeOf(c);
  return `<button class="card ch-card ch-mini" style="margin-top:12px" data-act="chOpen" data-code="${ctx.esc(c.code)}">
    <div class="row">
      <div class="icon-box accent">${ctx.icon(T.icon)}</div>
      <div class="grow"><div class="sub small ellipsis"><span class="ch-pre">Челлендж · </span>${termText(c)}</div><div class="h3 ch-clamp">${ctx.esc(title(c))}</div></div>
      ${me ? placeBox(i + 1, ps.length) : ''}
    </div>
    <div class="ch-prog">
      ${bar(pctOf(c, me?._prog), 'me')}
      <div class="ch-foot small"><span class="sub num">Ты: <b>${valText(c, me?._prog)}</b> / ${valText(c, c.target)} ${unitOf(c)}</span><span class="sub ch-lead">${leaderLine(ps)}</span></div>
    </div>
  </button>`;
}

function profileLink() {
  const n = hasApi() ? activeSorted().length : 0;
  if (hasApi() && st.list === null) loadList();
  const sub = n ? `${n} ${ctx.plural(n, 'активный', 'активных', 'активных')}` : 'Соревнуйся с друзьями';
  return `<button class="list-item" data-act="push" data-name="chHome"><div class="icon-box">${ctx.icon('users')}</div>
    <div class="grow"><div class="h3">Челленджи с друзьями</div><div class="sub small">${sub}</div></div><span class="muted">${ctx.icon('right')}</span></button>`;
}

// ── Модуль ────────────────────────────────────────────
export default {
  id: 'challenges',
  keys: [],
  screens: {
    chHome: screenHome,
    chCreate: screenCreate,
    chDetail: screenDetail,
    chJoin: screenJoin,
  },
  sheets: {
    chLink: linkSheet,
  },
  slots: {
    'home.afterWeek': homeCard,
    'profile.links': profileLink,
  },
  actions: {
    chOpen: ({ code }) => { if (code) ctx.push('chDetail', { code }); },
    chNew: ({ t }) => { st.form = newForm(TYPES[t] ? t : 'lift'); ctx.push('chCreate'); },
    chType: ({ v }) => {
      if (!TYPES[v] || st.form?.type === v || st.creating) return;
      ctx.haptic.tap();
      st.form = newForm(v);
      ctx.render();
    },
    chSet: ({ k, v }) => {
      const f = st.form;
      if (!f || st.creating) return;
      if (k === 'exercise' && EX_FULL[v] && f.exercise !== v) {
        f.exercise = v;
        f.target = liftDefault(v);
      } else if (k === 'days' && TYPES[f.type].days.includes(+v)) {
        f.days = +v;
      } else return;
      f.err = '';
      ctx.haptic.tap();
      ctx.render();
    },
    chStep: ({ d }, el) => {
      const f = st.form;
      if (!f || st.creating) return;
      const T = TYPES[f.type];
      const input = el.parentElement.querySelector('input');
      let v = toNum(input.value);
      if (!Number.isFinite(v)) v = T.min;
      v = clamp(Math.round((v + +d) * 10) / 10, T.min, T.max);
      input.value = v;
      f.target = v;
      f.err = '';
      ctx.haptic.tap();
      updatePreview();
    },
    chCreateGo: () => create(),
    chShare: ({ code }) => { ctx.haptic.tap(); share(st.ch[code]); },
    chCopy: ({ code }) => copyLink(code),
    chRefresh: ({ code }) => {
      if (!code || detReq[code]) return;
      ctx.haptic.tap();
      delete st.err[code];
      loadDetail(code, true, true);
      ctx.render();
    },
    chRetry: ({ code }) => {
      if (!code) return;
      ctx.haptic.tap();
      delete st.err[code];
      loadDetail(code, true, true);
      ctx.render();
    },
    chRetryList: () => {
      ctx.haptic.tap();
      st.listErr = null;
      loadList(true);
      ctx.render();
    },
    chLeave: ({ code }) => leave(code),
    chJoinGo: ({ code }) => join(code),
    chRematch: ({ code }) => {
      const c = st.ch[code];
      if (!c || !TYPES[c.type]) { st.form = newForm('lift'); ctx.push('chCreate'); return; }
      const T = TYPES[c.type];
      const exercise = EX_FULL[c.exercise] ? c.exercise : 'bb_bench';
      let target = clamp(c.type === 'volume' ? Math.round(num(c.target) / 100) / 10 : num(c.target), T.min, T.max);
      if (c.type === 'lift') {
        // Сервер не даст создать цель ниже своего рекорда — у победителя он уже ≥ цели
        const me = c.participants.find((p) => p.is_me);
        const best = Math.max(localBest(exercise), num(me?.progress));
        if (best >= target) target = liftAbove(best);
      }
      st.form = {
        type: c.type,
        exercise,
        target,
        days: T.days.includes(num(c.days)) ? num(c.days) : newForm(c.type).days,
        err: '',
      };
      ctx.push('chCreate');
    },
    chToList: () => {
      ctx.back();
      if (!onScreen('chHome')) ctx.push('chHome');
    },
  },
  binds: {
    chTarget: (v) => {
      if (!st.form) return;
      st.form.target = v;
      st.form.err = '';
      updatePreview();
    },
  },
  on: {
    boot: ({ startParam } = {}) => {
      if (hasApi() && ctx.S().profile?.done) loadList();
      const sp = String(startParam || '');
      if (!sp.startsWith('ch_')) return;
      const code = sp.slice(3);
      if (!CODE_RE.test(code)) return;
      if (ctx.S().profile?.done) openInvite(code);
      else st.pendingInvite = code; // откроем после анкеты (см. mount)
    },
    workout: () => {
      if (!hasApi()) return;
      clearTimeout(workoutTimer);
      // Ядро отправляет /api/sync через ~1,5 с — перезапрашиваем позже
      workoutTimer = setTimeout(() => {
        st.at = {};
        st.tryAt = {};
        loadList(true);
        const cur = ctx.current();
        if (cur && (cur.name === 'chDetail' || cur.name === 'chJoin') && cur.params?.code) loadDetail(String(cur.params.code), true);
      }, 3000);
    },
    reset: () => {
      clearTimeout(workoutTimer);
      gen += 1;
      st = freshState();
      listReq = null;
      detReq = {};
    },
  },
  mount: (root) => {
    if (st.pendingInvite && ctx.S().profile?.done) {
      const code = st.pendingInvite;
      st.pendingInvite = '';
      setTimeout(() => openInvite(code), 0);
    }
    const li = root.querySelector('#ch-link-input');
    if (li) { try { li.focus(); li.select(); } catch { /* ignore */ } }
  },
};
