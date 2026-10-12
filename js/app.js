import * as store from './storage.js';
import { CONFIG } from './config.js';
import { icon, esc, fmt, plural, ring, meter } from './ui.js';
import {
  bmi, bmiCategory, nutrition, waterNorm, levelFromExperience, LEVELS, GOALS, EXPERIENCE,
  weeksToTarget, mealSplit, referenceWeight,
} from './calc.js';
import { buildProgram, workoutForDate, candidatesFor, nextWeight } from './program.js';
import { EQUIPMENT, EQUIPMENT_GROUPS, EQUIPMENT_BY_ID, EQUIPMENT_PRESETS, equipmentImage } from './data/equipment.js';
import { FOODS, FOOD_BY_ID } from './data/foods.js';
import { waterChart, weightChart } from './charts.js';

const tg = window.Telegram?.WebApp;
const tgOk = (v) => !!tg?.isVersionAtLeast?.(v);
const tgUser = tg?.initDataUnsafe?.user;
// В обычном браузере SDK тоже создаёт объект WebApp, но с platform = 'unknown'
const inTelegram = !!tg && tg.platform !== 'unknown';
const nativeBack = inTelegram && tgOk('6.1');
const app = document.getElementById('app');

// ── Даты ─────────────────────────────────────────────
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WD_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad2 = (n) => String(n).padStart(2, '0');
const dkey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const isoWd = (d = new Date()) => ((d.getDay() + 6) % 7) + 1;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayMonth = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const shortDate = (k) => { const d = parseKey(k); return `${d.getDate()}.${pad2(d.getMonth() + 1)}`; };

// ── Состояние ────────────────────────────────────────
let S = {};
let program = null;
let nav = { tab: 'home', stack: [] };
let ob = null;
let sheet = null;
let edit = null;
let rest = null;
let ticker = null;
let lastViewKey = '';
let foodQuery = '';

const haptic = {
  tap: () => tgOk('6.1') && tg.HapticFeedback.selectionChanged(),
  impact: (s = 'light') => tgOk('6.1') && tg.HapticFeedback.impactOccurred(s),
  ok: () => tgOk('6.1') && tg.HapticFeedback.notificationOccurred('success'),
  warn: () => tgOk('6.1') && tg.HapticFeedback.notificationOccurred('warning'),
};

function save(key, value) {
  S[key] = value;
  store.set(key, value);
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function confirmDialog(msg) {
  return new Promise((resolve) => {
    if (tgOk('6.2')) tg.showConfirm(msg, (ok) => resolve(ok));
    else resolve(window.confirm(msg));
  });
}

function recompute() {
  program = S.profile?.done ? buildProgram(S.profile) : null;
}

// ── Данные дня ───────────────────────────────────────
function waterToday() {
  return (S.water?.[dkey()] || []).reduce((s, [ml]) => s + ml, 0);
}

function rollFood() {
  const today = dkey();
  if (S.food && S.food.d !== today) {
    const hist = { ...(S.foodHist || {}) };
    if (S.food.items.length) hist[S.food.d] = foodTotals(S.food.items);
    const keys = Object.keys(hist).sort().slice(-30);
    save('foodHist', Object.fromEntries(keys.map((k) => [k, hist[k]])));
    save('food', { d: today, items: [] });
  }
  if (!S.food) S.food = { d: today, items: [] };
}

function foodTotals(items = S.food?.items || []) {
  const t = items.reduce((a, it) => [a[0] + it[2], a[1] + it[3], a[2] + it[4], a[3] + it[5]], [0, 0, 0, 0]);
  return t.map((v) => Math.round(v));
}

function doneToday() {
  return (S.hist || []).some((h) => h[0] === dkey());
}

function isTrainingDay() {
  return !!(program && workoutForDate(program)) || doneToday();
}

function estMinutes(w) {
  let s = 8 * 60;
  for (const it of w.items) {
    if (it.unit === 'min') s += it.max * 60;
    else if (it.unit === 'sec') s += it.sets * (it.max + it.rest);
    else s += it.sets * (it.max * 3.5 + it.rest) + 60;
  }
  return Math.round(s / 300) * 5;
}

function exImageId(ex) {
  const owned = new Set(S.profile?.equipment || []);
  for (const req of ex.eq) {
    if (!Array.isArray(req)) return req;
    const hit = req.find((r) => owned.has(r));
    if (hit) return hit;
  }
  return null;
}

function exThumb(ex) {
  const id = exImageId(ex);
  const fallback = icon(ex.p.includes('cardio') ? 'heart' : 'body', 'lg');
  const img = id ? `<img src="${equipmentImage(id)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="ex-thumb">${fallback}${img}</div>`;
}

function schemeText(it) {
  if (it.unit === 'min') return `${it.min}–${it.max} мин`;
  if (it.unit === 'sec') return `${it.sets} × ${it.min}–${it.max} сек`;
  return `${it.sets} × ${it.min}–${it.max}`;
}

function restText(sec) {
  if (!sec) return '';
  return sec >= 120 ? `отдых ${fmt(sec / 60, sec % 60 ? 1 : 0)} мин` : `отдых ${sec} сек`;
}

function usesWeight(it) {
  return it.unit === 'reps' && it.ex.eq.length > 0;
}

function reco(it) {
  if (!usesWeight(it)) return null;
  const last = S.lifts?.[it.ex.id];
  const nw = nextWeight(it.ex, it, last);
  if (!nw) return { w: null, text: 'Первый раз — подбери рабочий вес', cls: 'muted' };
  if (nw.why === 'up') return { w: nw.w, text: `${fmt(nw.w, 1)} кг — пора прибавить!`, cls: 'accent' };
  if (nw.why === 'down') return { w: nw.w, text: `${fmt(nw.w, 1)} кг — сбавь и отработай технику`, cls: 'muted' };
  return { w: nw.w, text: `${fmt(nw.w, 1)} кг — как в прошлый раз`, cls: 'muted' };
}

// ── Рендер ───────────────────────────────────────────
function viewKey() {
  if (!S.profile?.done) return `ob:${ob?.step}`;
  const top = nav.stack[nav.stack.length - 1];
  return top ? `${top.name}:${JSON.stringify(top.params || {})}` : `tab:${nav.tab}`;
}

function render() {
  const key = viewKey();
  const y = window.scrollY;
  let html;
  if (!S.profile?.done) html = renderOnboarding();
  else if (nav.stack.length) html = renderScreen(nav.stack[nav.stack.length - 1]);
  else html = renderTab() + renderTabbar();
  if (sheet) html += renderSheet();
  if (rest) html += renderRest();
  app.innerHTML = html;
  mountCharts();
  syncBackButton();
  window.scrollTo(0, key === lastViewKey ? y : 0);
  lastViewKey = key;
  tickNow();
}

function syncBackButton() {
  if (!nativeBack) return;
  const need = !!sheet || nav.stack.length > 0 || (ob && ob.step > 0 && !S.profile?.done);
  if (need) tg.BackButton.show();
  else tg.BackButton.hide();
  if (tgOk('6.2')) {
    if (S.session) tg.enableClosingConfirmation();
    else tg.disableClosingConfirmation();
  }
}

function goBack() {
  haptic.tap();
  if (rest) { rest = null; render(); return; }
  if (sheet) { sheet = null; render(); return; }
  if (nav.stack.length) { nav.stack.pop(); edit = null; render(); return; }
  if (ob && ob.step > 0) { ob.step -= 1; ob.err = ''; render(); }
}

function push(name, params = {}) {
  haptic.tap();
  nav.stack.push({ name, params });
  render();
}

function openSheet(name, params = {}) {
  haptic.tap();
  sheet = { name, params };
  render();
}

function renderTabbar() {
  const tabs = [
    ['home', 'home', 'Главная'],
    ['train', 'dumbbell', 'Тренировки'],
    ['food', 'food', 'Питание'],
    ['water', 'drop', 'Вода'],
    ['profile', 'user', 'Профиль'],
  ];
  return `<nav class="tabbar"><div class="inner">${tabs
    .map(([k, ic, t]) => `<button class="tab ${nav.tab === k ? 'active' : ''}" data-act="tab" data-tab="${k}">
      <span class="pill">${icon(ic)}</span>${t}</button>`)
    .join('')}</div></nav>`;
}

function renderTab() {
  switch (nav.tab) {
    case 'train': return renderTrain();
    case 'food': return renderFood();
    case 'water': return renderWater();
    case 'profile': return renderProfile();
    default: return renderHome();
  }
}

function renderScreen(s) {
  switch (s.name) {
    case 'workout': return renderWorkout(s.params);
    case 'session': return renderSession();
    case 'addFood': return renderAddFood();
    case 'equipment': return renderEquipmentScreen();
    case 'editProfile': return renderEditProfile();
    case 'about': return renderAbout();
    default: return '';
  }
}

function backHeader(title, sub = '') {
  // В Telegram есть системная кнопка «Назад»; в браузере показываем свою
  const btn = nativeBack ? '' : `<button class="icon-btn" data-act="back">${icon('left')}</button>`;
  return `<div class="topbar">${btn}<div class="grow"><div class="h1">${esc(title)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
}

// ── Онбординг ────────────────────────────────────────
const OB_STEPS = ['welcome', 'sex', 'body', 'goal', 'exp', 'life', 'days', 'limits', 'equip', 'result'];

function obDefaults() {
  return {
    sex: null, age: 25, height: 175, weight: 75, goal: null, targetWeight: '',
    experience: null, lifestyle: null, days: [], limits: [], equipment: [],
  };
}

function obProfile(d = ob.d) {
  const level = levelFromExperience(d.experience);
  return {
    v: 1, done: true,
    name: tgUser?.first_name || '',
    sex: d.sex, age: +d.age, height: +d.height, weight: +d.weight,
    goal: d.goal, targetWeight: d.targetWeight ? +d.targetWeight : null,
    experience: d.experience, level, lifestyle: d.lifestyle,
    days: [...d.days].sort((a, b) => a - b), limits: d.limits, equipment: d.equipment,
    swaps: {}, created: dkey(),
  };
}

function choice(act, value, on, title, hint = '', ic = '', extra = '') {
  return `<button class="choice ${on ? 'on' : ''}" data-act="${act}" data-v="${value}" ${extra}>
    ${ic ? `<div class="icon-box ${on ? 'accent' : ''}">${icon(ic)}</div>` : ''}
    <div class="grow"><div class="t">${title}</div>${hint ? `<div class="sub small">${hint}</div>` : ''}</div>
    <div class="check">${icon('check', 'sm')}</div></button>`;
}

function stepper(bind, value, unit, step = 1) {
  return `<div class="stepper">
    <button class="icon-btn" data-act="step" data-bind="${bind}" data-d="${-step}">${icon('minus')}</button>
    <input type="number" inputmode="decimal" value="${esc(value)}" data-bind="${bind}">
    <span class="unit">${unit}</span>
    <button class="icon-btn" data-act="step" data-bind="${bind}" data-d="${step}">${icon('plus')}</button>
  </div>`;
}

const GOAL_UI = {
  lose: { ic: 'down', hint: 'Дефицит ~20%, белка больше, кардио после силовой' },
  maintain: { ic: 'balance', hint: 'Калории = расход, держим форму и силу' },
  gain: { ic: 'up', hint: 'Профицит 10–15%, растём в силе и мышцах' },
};
const LIFE_UI = {
  office: { t: 'Сидячая', hint: 'Офис, учёба, мало хожу', ic: 'sofa' },
  mixed: { t: 'Частично на ногах', hint: 'Много хожу, работа в движении', ic: 'walk' },
  physical: { t: 'Физический труд', hint: 'Стройка, склад, курьер', ic: 'hammer' },
};
const LIMIT_UI = {
  knees: 'Колени',
  back: 'Спина / поясница',
  shoulders: 'Плечи',
};

function daysHint(level) {
  return {
    beginner: 'Новичкам лучше всего 2–3 тренировки в неделю с днём отдыха между ними.',
    intermediate: 'Оптимально 3–4 тренировки в неделю.',
    advanced: 'Можно 4–6 тренировок в неделю.',
  }[level];
}

function renderEquipGrid(selected, act) {
  const set = new Set(selected);
  return `<div class="chips" style="margin-bottom:6px">
      ${EQUIPMENT_PRESETS.map((p) => `<button class="chip" data-act="${act}Preset" data-k="${p.key}">${esc(p.title)}</button>`).join('')}
    </div>
    ${EQUIPMENT_GROUPS.map((g) => `<div class="group-title">${g.title}</div>
      <div class="eq-grid">${EQUIPMENT.filter((e) => e.group === g.key).map((e) => `
        <button class="eq ${set.has(e.id) ? 'on' : ''}" data-act="${act}" data-id="${e.id}">
          <div class="ph"><img src="${equipmentImage(e.id)}" alt="${esc(e.name)}" loading="lazy"></div>
          <div class="tick">${icon('check', 'sm')}</div>
          <div class="meta"><div class="name">${esc(e.name)}</div>${e.hint ? `<div class="hint">${esc(e.hint)}</div>` : ''}</div>
        </button>`).join('')}</div>`).join('')}`;
}

function renderOnboarding() {
  if (!ob) ob = { step: 0, d: obDefaults(), err: '' };
  const d = ob.d;
  const step = OB_STEPS[ob.step];
  let head = '';
  let body = '';
  let canNext = true;
  let nextLabel = 'Далее';

  if (step === 'welcome') {
    return `<div class="ob"><div class="welcome">
      <div class="logo">${icon('dumbbell')}</div>
      <div class="h1">Твой личный тренер в Telegram</div>
      <p class="sub" style="margin-top:10px">Ответь на несколько вопросов — и я соберу программу тренировок под твой уровень и зал, посчитаю КБЖУ и норму воды.</p>
      <div class="feature-list">
        <div class="row"><div class="icon-box accent">${icon('dumbbell')}</div><div><b>Программа под тебя</b><div class="sub small">Новичок, средний или профи — с учётом твоего зала</div></div></div>
        <div class="row"><div class="icon-box accent">${icon('flame')}</div><div><b>КБЖУ под цель</b><div class="sub small">Похудеть, набрать или держать форму</div></div></div>
        <div class="row"><div class="icon-box water">${icon('drop')}</div><div><b>Трекер воды</b><div class="sub small">30 мл/кг, в день тренировки — 40 мл/кг</div></div></div>
        <div class="row"><div class="icon-box accent">${icon('chart')}</div><div><b>Прогресс</b><div class="sub small">Подскажу, когда прибавлять вес</div></div></div>
      </div>
    </div>
    <div class="bottom-bar"><div class="inner"><button class="btn block" data-act="obNext">Начать ${icon('right')}</button></div></div></div>`;
  }

  if (step === 'sex') {
    head = ['Твой пол', 'Нужен для точного расчёта обмена веществ'];
    body = `<div class="choice-grid">
      ${choice('obSet', 'm', d.sex === 'm', 'Мужской', '', 'male', 'data-k="sex"')}
      ${choice('obSet', 'f', d.sex === 'f', 'Женский', '', 'female', 'data-k="sex"')}
    </div>`;
    canNext = !!d.sex;
  }

  if (step === 'body') {
    head = ['Параметры тела', 'По ним считаю калории, белок и норму воды'];
    body = `<div class="field"><label>Возраст</label>${stepper('ob.age', d.age, 'лет')}</div>
      <div class="field"><label>Рост</label>${stepper('ob.height', d.height, 'см')}</div>
      <div class="field"><label>Вес</label>${stepper('ob.weight', d.weight, 'кг', 0.5)}</div>
      <div class="err">${esc(ob.err)}</div>`;
  }

  if (step === 'goal') {
    head = ['Какая цель?', 'От цели зависят калории и акценты в тренировках'];
    body = Object.entries(GOALS).map(([k, g]) => choice('obSet', k, d.goal === k, g.title, GOAL_UI[k].hint, GOAL_UI[k].ic, 'data-k="goal"')).join('');
    if (d.goal && d.goal !== 'maintain') {
      body += `<div class="field" style="margin-top:14px"><label>Желаемый вес (необязательно)</label>
        <input class="input" type="number" inputmode="decimal" placeholder="Например, ${d.goal === 'lose' ? Math.round(d.weight * 0.9) : Math.round(d.weight * 1.08)}" value="${esc(d.targetWeight)}" data-bind="ob.targetWeight">
        <div class="err">${esc(ob.err)}</div></div>`;
    }
    canNext = !!d.goal;
  }

  if (step === 'exp') {
    head = ['Опыт тренировок', 'Определю твой уровень: новичок, средний или профи'];
    body = Object.entries(EXPERIENCE).map(([k, e]) => choice('obSet', k, d.experience === k, e.title, e.hint, '', 'data-k="experience"')).join('');
    if (d.experience) {
      const lv = levelFromExperience(d.experience);
      body += `<div class="notice" style="margin-top:14px">${icon('zap', 'sm')}<div>Твой уровень: <b>${LEVELS[lv].title}</b>. Его можно поменять потом в профиле.</div></div>`;
    }
    canNext = !!d.experience;
  }

  if (step === 'life') {
    head = ['Образ жизни', 'Сколько двигаешься вне зала'];
    body = Object.entries(LIFE_UI).map(([k, l]) => choice('obSet', k, d.lifestyle === k, l.t, l.hint, l.ic, 'data-k="lifestyle"')).join('');
    canNext = !!d.lifestyle;
  }

  if (step === 'days') {
    const lv = levelFromExperience(d.experience);
    head = ['Дни тренировок', 'В какие дни сможешь ходить в зал?'];
    body = `<div class="week">${WD.map((w, i) => `<button class="chip ${d.days.includes(i + 1) ? 'on' : ''}" data-act="obDay" data-d="${i + 1}">${w}</button>`).join('')}</div>
      <div class="notice" style="margin-top:16px">${icon('info', 'sm')}<div>${daysHint(lv)} Выбрано: <b>${d.days.length}</b>.</div></div>`;
    canNext = d.days.length > 0;
  }

  if (step === 'limits') {
    head = ['Есть ограничения?', 'Исключу упражнения, которые нагружают проблемные зоны'];
    body = choice('obLimitNone', '', !d.limits.length, 'Нет, всё в порядке', '', 'shield')
      + Object.entries(LIMIT_UI).map(([k, t]) => choice('obLimit', k, d.limits.includes(k), t, 'Есть травма или боль', 'alert')).join('');
  }

  if (step === 'equip') {
    head = ['Что есть в твоём зале?', 'Отметь тренажёры — программа будет только из них'];
    body = renderEquipGrid(d.equipment, 'obEq');
    nextLabel = d.equipment.length ? `Далее · ${d.equipment.length}` : 'Без тренажёров';
  }

  if (step === 'result') {
    const p = obProfile();
    const n = nutrition(p);
    const prog = buildProgram(p);
    const wk = weeksToTarget(p);
    head = ['Всё готово!', 'Вот твой персональный план'];
    body = `
      <div class="card accent-card"><div class="row between"><div><div class="sub small">Твой уровень</div><div class="h2">${LEVELS[p.level].title}</div></div>${icon('trophy', 'lg')}</div></div>
      <div class="grid-2" style="margin-top:12px">
        <div class="stat"><div class="lbl">${icon('flame', 'sm')}Калории</div><div class="v">${fmt(n.kcal)} <small>ккал</small></div></div>
        <div class="stat"><div class="lbl">${icon('drop', 'sm')}Вода</div><div class="v">${fmt(waterNorm(p, false) / 1000, 1)}–${fmt(waterNorm(p, true) / 1000, 1)} <small>л</small></div></div>
      </div>
      <div class="card" style="margin-top:12px">${macroRows(n, [0, 0, 0, 0])}</div>
      ${wk ? `<div class="notice" style="margin-top:12px">${icon('target', 'sm')}<div>До цели ${p.targetWeight} кг примерно <b>${wk} ${plural(wk, 'неделя', 'недели', 'недель')}</b> при соблюдении плана.</div></div>` : ''}
      <div class="section-title"><div class="h3">Программа · ${esc(prog.name)}</div></div>
      <div class="card list">${prog.workouts.map((w) => `<div class="wk-card" style="padding:10px 0">
        <div class="wk-day"><b>${w.weekday ? WD[w.weekday - 1] : '—'}</b></div>
        <div class="grow"><div class="h3">${esc(w.title)}</div><div class="sub small">${w.items.length} ${plural(w.items.length, 'упражнение', 'упражнения', 'упражнений')} · ~${estMinutes(w)} мин</div></div></div>`).join('')}</div>`;
    nextLabel = 'Поехали!';
  }

  const pct = Math.round((ob.step / (OB_STEPS.length - 1)) * 100);
  return `<div class="ob">
    <div class="ob-progress"><div style="width:${pct}%"></div></div>
    <div class="ob-head"><div class="h1">${head[0]}</div><div class="sub">${head[1]}</div></div>
    ${body}
    <div class="bottom-bar"><div class="inner">
      ${ob.step > 1 && !nativeBack ? `<button class="btn ghost" data-act="back">${icon('left')}</button>` : ''}
      <button class="btn block" data-act="obNext" ${canNext ? '' : 'disabled'}>${nextLabel}</button>
    </div></div>
  </div>`;
}

function validBody(d) {
  const age = +d.age;
  const h = +d.height;
  const w = +d.weight;
  if (!(age >= 12 && age <= 90)) return 'Возраст — от 12 до 90 лет';
  if (!(h >= 120 && h <= 230)) return 'Рост — от 120 до 230 см';
  if (!(w >= 35 && w <= 250)) return 'Вес — от 35 до 250 кг';
  return '';
}

function validTarget(d) {
  if (!d.targetWeight || d.goal === 'maintain') return '';
  const t = +d.targetWeight;
  if (!(t >= 35 && t <= 250)) return 'Желаемый вес — от 35 до 250 кг';
  if (d.goal === 'lose' && t >= +d.weight) return 'Для похудения желаемый вес должен быть меньше текущего';
  if (d.goal === 'gain' && t <= +d.weight) return 'Для набора желаемый вес должен быть больше текущего';
  return '';
}

function obNext() {
  const step = OB_STEPS[ob.step];
  if (step === 'body') { ob.err = validBody(ob.d); if (ob.err) { haptic.warn(); render(); return; } }
  if (step === 'goal') { ob.err = validTarget(ob.d); if (ob.err) { haptic.warn(); render(); return; } }
  if (step === 'result') {
    const p = obProfile();
    save('profile', p);
    save('weights', [[dkey(), p.weight]]);
    recompute();
    ob = null;
    nav = { tab: 'home', stack: [] };
    haptic.ok();
    render();
    toast('Профиль сохранён — удачи на тренировках!');
    return;
  }
  ob.err = '';
  ob.step += 1;
  // Предзаполняем дни под уровень
  if (OB_STEPS[ob.step] === 'days' && !ob.d.days.length) {
    const lv = levelFromExperience(ob.d.experience);
    ob.d.days = lv === 'beginner' ? [1, 3, 5] : lv === 'intermediate' ? [1, 2, 4, 5] : [1, 2, 3, 4, 5];
  }
  haptic.impact();
  render();
}

// ── Главная ──────────────────────────────────────────
const TIPS = [
  'Сон 7–9 часов — лучший «спортпит»: мышцы растут во время восстановления.',
  'Записывай веса в тренировке — так видно прогресс и понятно, когда прибавлять.',
  'Белок раздели на 3–5 приёмов по 25–40 г — так он усваивается лучше.',
  'Техника важнее веса. Если последние повторы «ломают» движение — вес слишком большой.',
  'Пей 400–600 мл воды за 2 часа до тренировки и понемногу во время неё.',
  '8–10 тысяч шагов в день — простой способ тратить больше калорий без кардио.',
  'Разминка 5–10 минут снижает риск травм и помогает поднять больше.',
  'Взвешивайся утром натощак, после туалета — так цифры сравнимы.',
  'Прогресс не линейный: колебания веса в 0,5–1 кг за день — это вода, а не жир.',
  'Не тренируй одни и те же мышцы два дня подряд — им нужно 48 часов на восстановление.',
];

function renderHome() {
  const p = S.profile;
  const n = nutrition(p);
  const today = workoutForDate(program);
  const trainDay = isTrainingDay();
  const wNorm = waterNorm(p, trainDay);
  const water = waterToday();
  const [kcal, prot] = foodTotals();
  const now = new Date();
  const name = p.name || tgUser?.first_name || 'атлет';
  const photo = tgUser?.photo_url;

  let todayCard;
  if (S.session) {
    const w = program.workouts.find((x) => x.uid === S.session.uid);
    todayCard = `<div class="card accent-card"><div class="sub small">Тренировка идёт</div><div class="h2" style="margin:4px 0 12px">${esc(w?.title || 'Тренировка')}</div>
      <button class="btn block ghost" style="background:var(--accent-ink);color:var(--accent)" data-act="openSession">${icon('play')} Продолжить</button></div>`;
  } else if (doneToday()) {
    const h = S.hist.find((x) => x[0] === dkey());
    todayCard = `<div class="card accent-card"><div class="row"><div class="grow"><div class="sub small">Сегодня</div><div class="h2">Тренировка выполнена!</div>
      <div class="sub small" style="margin-top:4px">${esc(h[1])} · ${h[2]} мин · ${fmt(h[3])} кг объёма</div></div>${icon('trophy', 'lg')}</div></div>`;
  } else if (today) {
    const img = today.items.map((it) => exImageId(it.ex)).find(Boolean);
    todayCard = `<div class="card hero">
      ${img ? `<div class="hero-img"><img src="${equipmentImage(img)}" alt="" onerror="this.parentNode.remove()"></div>` : ''}
      <div class="row between"><span class="badge accent">${icon('calendar', 'sm')}Сегодня</span><span class="badge">${icon('clock', 'sm')}~${estMinutes(today)} мин</span></div>
      <div class="h2" style="margin-top:12px">${esc(today.title)}</div>
      <div class="sub">${esc(today.focus)} · ${today.items.length} ${plural(today.items.length, 'упражнение', 'упражнения', 'упражнений')}</div>
      <div class="row" style="margin-top:14px">
        <button class="btn grow" data-act="startWorkout" data-uid="${today.uid}">${icon('play')} Начать</button>
        <button class="btn ghost" data-act="openWorkout" data-uid="${today.uid}">${icon('list')}</button>
      </div></div>`;
  } else {
    const next = nextWorkout();
    todayCard = `<div class="card"><div class="row"><div class="icon-box">${icon('moon')}</div><div class="grow"><div class="h3">Сегодня день отдыха</div>
      <div class="sub small">Мышцы растут во время восстановления. Прогулка 8–10 тыс. шагов и растяжка — отличный выбор.</div></div></div>
      ${next ? `<button class="card-link" style="margin-top:14px" data-act="openWorkout" data-uid="${next.w.uid}">
        <div class="wk-day"><b>${WD[next.w.weekday - 1]}</b><span>${next.label}</span></div>
        <div class="grow"><div class="sub small">Следующая тренировка</div><div class="h3">${esc(next.w.title)}</div></div><span class="chev">${icon('right')}</span></button>` : ''}
    </div>`;
  }

  const tip = TIPS[Math.floor(now.getTime() / 864e5) % TIPS.length];

  return `<div class="page">
    <div class="topbar">
      <div class="avatar">${photo ? `<img src="${esc(photo)}" alt="">` : esc(name[0]?.toUpperCase() || 'G')}</div>
      <div class="grow"><div class="h2">Привет, ${esc(name)}!</div><div class="sub small">${WD_FULL[isoWd(now) - 1]}, ${dayMonth(now)}</div></div>
      <span class="badge accent">${LEVELS[p.level].short}</span>
    </div>
    ${todayCard}
    ${weekStrip()}
    <div class="grid-2" style="margin-top:12px">
      <button class="card" data-act="tab" data-tab="food" style="text-align:left">
        <div class="stat" style="padding:0"><div class="lbl">${icon('flame', 'sm')}Калории</div></div>
        <div style="margin-top:10px">${ring({ value: kcal, max: n.kcal, size: 104, stroke: 10, center: `<div><div class="val">${fmt(kcal)}</div><div class="muted tiny">из ${fmt(n.kcal)}</div></div>` })}</div>
        <div class="muted tiny" style="margin-top:8px">Белок: ${fmt(prot)} / ${n.protein} г</div>
      </button>
      <button class="card" data-act="tab" data-tab="water" style="text-align:left">
        <div class="stat" style="padding:0"><div class="lbl">${icon('drop', 'sm')}Вода</div></div>
        <div style="margin-top:10px">${ring({ value: water, max: wNorm, size: 104, stroke: 10, color: 'var(--water)', track: 'var(--water-soft)', center: `<div><div class="val">${fmt(water / 1000, 1)}</div><div class="muted tiny">из ${fmt(wNorm / 1000, 1)} л</div></div>` })}</div>
        <div class="muted tiny" style="margin-top:8px">${trainDay ? 'День тренировки' : 'День отдыха'}</div>
      </button>
    </div>
    <div class="water-quick" style="margin-top:12px;grid-template-columns:1fr 1fr">
      <button data-act="addWater" data-ml="250" style="flex-direction:row;height:52px">${icon('glass', 'sm')}+250 мл</button>
      <button data-act="addWater" data-ml="500" style="flex-direction:row;height:52px">${icon('bottle', 'sm')}+500 мл</button>
    </div>
    <div class="notice" style="margin-top:14px">${icon('spark', 'sm')}<div>${tip}</div></div>
  </div>`;
}

function nextWorkout() {
  if (!program) return null;
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = addDays(now, i);
    const w = workoutForDate(program, d);
    if (w) return { w, label: i === 1 ? 'завтра' : dayMonth(d).split(' ')[0] + ' ' + MONTHS[d.getMonth()].slice(0, 3) };
  }
  return null;
}

function weekStrip() {
  const now = new Date();
  const monday = addDays(now, -(isoWd(now) - 1));
  const doneDates = new Set((S.hist || []).map((h) => h[0]));
  const days = S.profile.days || [];
  let planned = 0;
  let done = 0;
  const cells = WD.map((w, i) => {
    const d = addDays(monday, i);
    const k = dkey(d);
    const isPlan = days.includes(i + 1);
    const isDone = doneDates.has(k);
    if (isPlan) planned += 1;
    if (isDone) done += 1;
    const cls = [isDone ? 'done' : isPlan ? 'plan' : '', k === dkey(now) ? 'today' : ''].join(' ');
    return `<div><div class="d">${w}</div><div class="b ${cls}">${isDone ? icon('check', 'sm') : isPlan ? `<span class="dot" style="background:var(--muted);width:6px;height:6px"></span>` : ''}</div></div>`;
  }).join('');
  return `<div class="card" style="margin-top:12px"><div class="row between"><div class="h3">Эта неделя</div><div class="sub small num">${done} из ${planned} тренировок</div></div>
    <div class="week-strip">${cells}</div></div>`;
}

// ── Тренировки ───────────────────────────────────────
function renderTrain() {
  const p = S.profile;
  const todayWd = isoWd();
  const hist = (S.hist || []).slice(-10).reverse();
  return `<div class="page">
    <div class="topbar"><div class="grow"><div class="h1">Тренировки</div><div class="sub">${esc(program.name)} · ${p.days.length} ${plural(p.days.length, 'раз', 'раза', 'раз')} в неделю</div></div>
      <span class="badge accent">${LEVELS[p.level].short}</span></div>
    <div class="card list">
      ${program.workouts.map((w) => `<button class="wk-card" style="padding:12px 0" data-act="openWorkout" data-uid="${w.uid}">
        <div class="wk-day ${w.weekday === todayWd ? 'today' : ''}"><b>${w.weekday ? WD[w.weekday - 1] : '—'}</b><span>${w.weekday === todayWd ? 'сегодня' : ''}</span></div>
        <div class="grow"><div class="h3">${esc(w.title)}</div><div class="sub small">${esc(w.focus)}</div>
        <div class="muted tiny" style="margin-top:2px">${w.items.length} ${plural(w.items.length, 'упражнение', 'упражнения', 'упражнений')} · ~${estMinutes(w)} мин</div></div>
        <span class="chev muted">${icon('right')}</span></button>`).join('')}
    </div>
    <details class="card" style="margin-top:12px"><summary class="row between"><div class="row">${icon('info')}<b>Правила программы</b></div><span class="muted">${icon('right', 'sm')}</span></summary>
      <ul class="tips sub small" style="margin-top:12px">${program.notes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>
    <button class="card card-link" style="margin-top:12px" data-act="push" data-name="equipment">
      <div class="icon-box">${icon('dumbbell')}</div><div class="grow"><div class="h3">Мой зал</div><div class="sub small">${p.equipment.length} ${plural(p.equipment.length, 'тренажёр', 'тренажёра', 'тренажёров')} · изменить</div></div><span class="chev">${icon('right')}</span></button>
    <div class="section-title"><div class="h3">История</div><span class="sub small">${(S.hist || []).length} всего</span></div>
    ${hist.length ? `<div class="card list">${hist.map((h) => `<div class="list-item">
        <div class="icon-box accent">${icon('check')}</div>
        <div class="grow"><div class="h3">${esc(h[1])}</div><div class="sub small">${shortDate(h[0])} · ${h[2]} мин · ${h[4]} ${plural(h[4], 'подход', 'подхода', 'подходов')}</div></div>
        <div class="num"><b>${fmt(h[3])}</b> <span class="muted small">кг</span></div></div>`).join('')}</div>`
      : `<div class="card empty">${icon('trophy', 'lg')}<div style="margin-top:8px">Здесь появятся твои тренировки</div></div>`}
  </div>`;
}

function findWorkout(uid) {
  return program.workouts.find((w) => w.uid === uid);
}

function renderWorkout({ uid }) {
  const w = findWorkout(uid);
  if (!w) return `<div class="page no-tabs">${backHeader('Тренировка')}<div class="empty">Тренировка не найдена</div></div>`;
  const img = w.items.map((it) => exImageId(it.ex)).find(Boolean);
  return `<div class="page no-tabs">
    ${backHeader(w.title, `${w.weekday ? WD_FULL[w.weekday - 1] : ''} · ~${estMinutes(w)} мин`)}
    <div class="card">
      ${img ? `<div class="hero-img"><img src="${equipmentImage(img)}" alt="" onerror="this.parentNode.remove()"></div>` : ''}
      <div class="sub">${esc(w.focus)}</div>
      <div class="notice" style="margin-top:12px">${icon('flame', 'sm')}<div>Разминка 5–10 мин: лёгкое кардио, суставы, 1–2 лёгких подхода первого упражнения.</div></div>
    </div>
    <div class="section-title"><div class="h3">Упражнения</div><span class="sub small">нажми, чтобы увидеть технику</span></div>
    <div class="card list">${w.items.map((it, i) => {
      const r = reco(it);
      return `<button class="ex" data-act="exSheet" data-uid="${w.uid}" data-slot="${it.slot}">
        ${exThumb(it.ex)}
        <div class="grow"><div class="ex-num">${it.role === 'finisher' ? 'ФИНИШ' : i + 1}</div><div class="name">${esc(it.ex.name)}</div>
        <div class="scheme">${schemeText(it)}${it.rest ? ` · ${restText(it.rest)}` : ''}</div>
        ${r ? `<div class="reco ${r.cls === 'accent' ? 'accent' : 'muted'}">${esc(r.text)}</div>` : ''}</div>
        <span class="muted">${icon('right', 'sm')}</span></button>`;
    }).join('')}</div>
    <div class="bottom-bar"><div class="inner"><button class="btn block" data-act="startWorkout" data-uid="${w.uid}">${icon('play')} ${S.session?.uid === w.uid ? 'Продолжить' : 'Начать тренировку'}</button></div></div>
  </div>`;
}

function exSheet({ uid, slot }) {
  const w = findWorkout(uid);
  const it = w?.items.find((x) => String(x.slot) === String(slot));
  if (!it) return '';
  const last = S.lifts?.[it.ex.id];
  const r = reco(it);
  const imgId = exImageId(it.ex);
  const alts = it.role === 'finisher' ? [] : candidatesFor(it.pattern, S.profile).filter((c) => c.id !== it.ex.id);
  const needs = it.ex.eq.map((req) => (Array.isArray(req) ? req.map((x) => EQUIPMENT_BY_ID[x]?.name).join(' / ') : EQUIPMENT_BY_ID[req]?.name)).join(', ');
  return `
    ${imgId ? `<div class="hero-img" style="margin:-10px -16px 14px;height:190px"><img src="${equipmentImage(imgId)}" alt="" onerror="this.parentNode.remove()"></div>` : ''}
    <div class="h2">${esc(it.ex.name)}</div>
    <div class="sub" style="margin-top:4px">${esc(it.ex.muscles)}</div>
    <div class="chips" style="margin-top:12px"><span class="badge accent">${schemeText(it)}</span>${it.rest ? `<span class="badge">${icon('timer', 'sm')}${restText(it.rest)}</span>` : ''}<span class="badge">${needs || 'Без оборудования'}</span></div>
    ${r ? `<div class="notice" style="margin-top:14px">${icon('zap', 'sm')}<div>${esc(r.text)}${last ? `<br><span class="muted">Прошлый раз (${shortDate(last.d)}): ${fmt(last.w, 1)} кг × ${last.r.join(', ')}</span>` : ''}</div></div>` : ''}
    <div class="section-title" style="margin-top:18px"><div class="h3">Техника</div></div>
    <ul class="tips">${it.ex.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    ${alts.length ? `<div class="section-title"><div class="h3">Заменить на</div><span class="sub small">если тренажёр занят</span></div>
      <div class="list">${alts.map((a) => `<button class="ex" data-act="swap" data-uid="${uid}" data-slot="${slot}" data-id="${a.id}">
        ${exThumb(a)}<div class="grow"><div class="name">${esc(a.name)}</div><div class="scheme">${esc(a.muscles)}</div></div><span class="muted">${icon('swap', 'sm')}</span></button>`).join('')}</div>` : ''}`;
}

// ── Активная тренировка ──────────────────────────────
async function startWorkout(uid) {
  const w = findWorkout(uid);
  if (!w) return;
  if (S.session && S.session.uid !== uid) {
    const ok = await confirmDialog('Уже идёт другая тренировка. Начать новую? Результаты текущей не сохранятся.');
    if (!ok) return;
    save('session', null);
  }
  if (!S.session) {
    const data = {};
    w.items.forEach((it) => {
      const r = reco(it);
      const sets = it.unit === 'min' ? 1 : it.sets;
      data[it.slot] = Array.from({ length: sets }, () => [r?.w ?? '', '', 0]);
    });
    save('session', { uid, title: w.title, start: Date.now(), data });
  }
  nav.stack = nav.stack.filter((s) => s.name !== 'session' && s.name !== 'workout');
  push('session');
}

function sessionWorkout() {
  return S.session && findWorkout(S.session.uid);
}

function renderSession() {
  const w = sessionWorkout();
  if (!w) {
    save('session', null);
    return `<div class="page no-tabs">${backHeader('Тренировка')}<div class="empty">Тренировка не найдена</div></div>`;
  }
  const data = S.session.data;
  let total = 0;
  let done = 0;
  Object.values(data).forEach((sets) => sets.forEach((s) => { total += 1; done += s[2] ? 1 : 0; }));
  return `<div class="page no-tabs">
    <div class="session-head">
      <div class="row between"><div><div class="sub small">${esc(w.title)}</div><div class="timer-big" id="elapsed">00:00</div></div>
      <div style="text-align:right"><div class="sub small">Подходы</div><div class="h2 num">${done}/${total}</div></div></div>
      <div style="margin-top:10px">${meter(done, total, 'var(--accent)')}</div>
    </div>
    ${w.items.map((it, i) => {
      const sets = data[it.slot] || [];
      const complete = sets.length && sets.every((s) => s[2]);
      const r = reco(it);
      const wt = usesWeight(it);
      const colA = wt ? (it.ex.assist ? 'Помощь, кг' : 'Вес, кг') : '';
      const colB = it.unit === 'reps' ? 'Повторы' : it.unit === 'sec' ? 'Секунды' : 'Минуты';
      return `<div class="card session-ex ${complete ? 'complete' : ''}" style="margin-top:12px">
        <button class="ex" style="padding:0" data-act="exSheet" data-uid="${w.uid}" data-slot="${it.slot}">${exThumb(it.ex)}
          <div class="grow"><div class="ex-num">${it.role === 'finisher' ? 'ФИНИШ' : i + 1}</div><div class="name">${esc(it.ex.name)}</div>
          <div class="scheme">${schemeText(it)}${it.rest ? ` · ${restText(it.rest)}` : ''}</div>
          ${r ? `<div class="reco ${r.cls}">${esc(r.text)}</div>` : ''}</div>${complete ? `<span class="accent">${icon('check')}</span>` : ''}</button>
        <div class="set-row head"><div>#</div><div>${colA}</div><div>${colB}</div><div></div></div>
        ${sets.map((s, si) => `<div class="set-row ${s[2] ? 'done' : ''}">
          <div class="n">${si + 1}</div>
          ${wt ? `<input type="number" inputmode="decimal" placeholder="кг" value="${esc(s[0])}" data-bind="set" data-slot="${it.slot}" data-si="${si}" data-col="0">` : '<div class="muted" style="text-align:center">—</div>'}
          <input type="number" inputmode="numeric" placeholder="${it.max}" value="${esc(s[1])}" data-bind="set" data-slot="${it.slot}" data-si="${si}" data-col="1">
          <button class="done-btn" data-act="setDone" data-slot="${it.slot}" data-si="${si}">${icon('check')}</button>
        </div>`).join('')}
      </div>`;
    }).join('')}
    <button class="btn block danger" style="margin-top:18px" data-act="cancelSession">${icon('x')} Отменить тренировку</button>
    <div class="bottom-bar"><div class="inner"><button class="btn block" data-act="finishSession">${icon('check')} Завершить</button></div></div>
  </div>`;
}

function setDone(slot, si) {
  const w = sessionWorkout();
  const it = w.items.find((x) => String(x.slot) === String(slot));
  const row = S.session.data[slot][si];
  row[2] = row[2] ? 0 : 1;
  if (row[2] && row[1] === '') row[1] = it.max;
  save('session', S.session);
  if (row[2]) {
    haptic.impact('medium');
    const allDone = Object.values(S.session.data).every((sets) => sets.every((s) => s[2]));
    if (allDone) {
      toast('Все подходы сделаны — жми «Завершить»!');
    } else if (it.rest) {
      rest = { end: Date.now() + it.rest * 1000, total: it.rest, name: it.ex.name };
    }
  } else haptic.tap();
  render();
}

function finishSession(force = false) {
  const w = sessionWorkout();
  const data = S.session.data;
  const anyDone = Object.values(data).some((sets) => sets.some((s) => s[2]));
  if (!anyDone && !force) {
    toast('Отметь хотя бы один подход галочкой');
    return;
  }
  const allDone = Object.values(data).every((sets) => sets.every((s) => s[2]));
  if (!allDone && !force) {
    confirmDialog('Не все подходы отмечены. Завершить тренировку?').then((ok) => ok && finishSession(true));
    return;
  }
  const lifts = { ...(S.lifts || {}) };
  let volume = 0;
  let setsDone = 0;
  const prs = [];
  w.items.forEach((it) => {
    const sets = (data[it.slot] || []).filter((s) => s[2]);
    if (!sets.length) return;
    setsDone += sets.length;
    if (it.unit !== 'reps') return;
    const reps = sets.map((s) => +s[1] || 0);
    const weights = sets.map((s) => +s[0] || 0);
    const wMax = Math.max(...weights);
    if (!it.ex.assist) volume += sets.reduce((a, s) => a + (+s[0] || 0) * (+s[1] || 0), 0);
    if (!usesWeight(it)) {
      lifts[it.ex.id] = { w: 0, r: reps, d: dkey() };
      return;
    }
    const prev = lifts[it.ex.id];
    const anyFail = reps.some((r) => r < it.min);
    const best = prev?.best || 0;
    if (wMax > 0 && !it.ex.assist && wMax > best && prev) prs.push(`${it.ex.name}: ${fmt(wMax, 1)} кг`);
    lifts[it.ex.id] = {
      w: wMax,
      r: reps,
      d: dkey(),
      fails: anyFail ? (prev?.fails || 0) + 1 : 0,
      best: it.ex.assist ? Math.min(best || wMax, wMax) : Math.max(best, wMax),
    };
  });
  const minutes = Math.max(1, Math.round((Date.now() - S.session.start) / 60000));
  const hist = [...(S.hist || []), [dkey(), w.title, minutes, Math.round(volume), setsDone]].slice(-60);
  save('lifts', lifts);
  save('hist', hist);
  save('session', null);
  rest = null;
  nav.stack = [];
  nav.tab = 'home';
  sheet = { name: 'done', params: { title: w.title, minutes, volume: Math.round(volume), setsDone, prs } };
  haptic.ok();
  render();
}

function renderRest() {
  return `<div class="rest">
    <div class="sub" style="color:#c9ccd3">Отдых · ${esc(rest.name)}</div>
    <div class="timer-big" id="rest-left">0:00</div>
    <div style="width:220px">${meter(0, 1, 'var(--accent)').replace('<div style', '<div id="rest-bar" style')}</div>
    <div class="row">
      <button class="btn ghost sm" data-act="restAdd" data-s="-15">−15 сек</button>
      <button class="btn ghost sm" data-act="restAdd" data-s="15">+15 сек</button>
    </div>
    <button class="btn" data-act="restSkip">Пропустить</button>
  </div>`;
}

function tickNow() {
  const el = document.getElementById('elapsed');
  if (el && S.session) {
    const s = Math.floor((Date.now() - S.session.start) / 1000);
    const h = Math.floor(s / 3600);
    el.textContent = `${h ? `${h}:` : ''}${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  }
  if (rest) {
    const left = Math.max(0, Math.ceil((rest.end - Date.now()) / 1000));
    const l = document.getElementById('rest-left');
    if (l) l.textContent = `${Math.floor(left / 60)}:${pad2(left % 60)}`;
    const bar = document.getElementById('rest-bar');
    if (bar) bar.style.width = `${100 - (left / rest.total) * 100}%`;
    if (left <= 0) {
      rest = null;
      haptic.ok();
      toast('Отдых окончен — следующий подход!');
      render();
    }
  }
}

// ── Питание ──────────────────────────────────────────
function macroRows(n, eaten) {
  const rows = [
    ['Белки', eaten[1], n.protein, 'var(--protein)'],
    ['Жиры', eaten[2], n.fat, 'var(--fat)'],
    ['Углеводы', eaten[3], n.carbs, 'var(--carbs)'],
  ];
  return rows.map(([t, v, max, c]) => `<div class="macro-row">
    <div class="row between"><div class="row" style="gap:8px"><span class="dot" style="background:${c}"></span><b>${t}</b></div>
    <span class="num small"><b>${fmt(v)}</b> <span class="muted">/ ${fmt(max)} г</span></span></div>
    ${meter(v, max, c)}</div>`).join('');
}

function renderFood() {
  const p = S.profile;
  const n = nutrition(p);
  const eaten = foodTotals();
  const left = n.kcal - eaten[0];
  const items = S.food?.items || [];
  return `<div class="page">
    <div class="topbar"><div class="grow"><div class="h1">Питание</div><div class="sub">Цель: ${GOALS[p.goal].title.toLowerCase()}</div></div></div>
    <div class="card">
      <div class="row" style="gap:18px">
        ${ring({ value: eaten[0], max: n.kcal, size: 128, stroke: 12, color: left < 0 ? 'var(--danger)' : 'var(--accent)', center: `<div><div class="val">${fmt(Math.abs(left))}</div><div class="muted tiny">${left < 0 ? 'перебор' : 'осталось'}</div></div>` })}
        <div class="grow">
          <div class="kv"><span class="sub">Норма</span><b>${fmt(n.kcal)} ккал</b></div>
          <div class="kv"><span class="sub">Съедено</span><b>${fmt(eaten[0])} ккал</b></div>
          <div class="kv"><span class="sub">Клетчатка</span><b>~${n.fiber} г</b></div>
        </div>
      </div>
      <div style="margin-top:16px">${macroRows(n, eaten)}</div>
    </div>
    <div class="section-title"><div class="h3">Сегодня</div><button class="btn sm" data-act="push" data-name="addFood">${icon('plus', 'sm')} Добавить</button></div>
    ${items.length ? `<div class="card list">${items.map((it, i) => `<div class="list-item">
        <div class="grow"><div class="h3 ellipsis">${esc(it[0])}</div><div class="sub small num">${it[1] ? `${fmt(it[1])} г · ` : ''}Б ${fmt(it[3])} · Ж ${fmt(it[4])} · У ${fmt(it[5])}</div></div>
        <b class="num">${fmt(it[2])}</b><span class="muted small">ккал</span>
        <button class="icon-btn" data-act="delFood" data-i="${i}" aria-label="Удалить">${icon('trash', 'sm')}</button></div>`).join('')}</div>`
      : `<button class="card empty" style="width:100%" data-act="push" data-name="addFood">${icon('food', 'lg')}<div style="margin-top:8px">Добавь первый приём пищи</div></button>`}
    <div class="section-title"><div class="h3">Как распределить</div></div>
    <div class="card">${mealSplit(n.kcal).map((m) => `<div class="kv"><span>${m.title}</span><b>${fmt(m.kcal)} ккал</b></div>`).join('')}
      <div class="sub small" style="margin-top:8px">Старайся добирать белок в каждом приёме: ~${Math.round(n.protein / 4)} г за раз.</div></div>
    <button class="card card-link" style="margin-top:12px" data-act="push" data-name="about">
      <div class="icon-box">${icon('info')}</div><div class="grow"><div class="h3">Как посчитана норма</div><div class="sub small">Формулы и источники</div></div><span class="chev">${icon('right')}</span></button>
  </div>`;
}

function renderAddFood() {
  return `<div class="page no-tabs">
    ${backHeader('Добавить еду')}
    <div class="row"><div class="grow" style="position:relative"><input class="input" placeholder="Поиск: гречка, курица…" value="${esc(foodQuery)}" data-bind="foodSearch" autocomplete="off"></div></div>
    <button class="card card-link" style="margin-top:12px" data-act="sheet" data-name="customFood">
      <div class="icon-box accent">${icon('edit')}</div><div class="grow"><div class="h3">Свой продукт или блюдо</div><div class="sub small">Ввести калории и БЖУ вручную</div></div><span class="chev">${icon('right')}</span></button>
    <div class="card list" style="margin-top:12px" id="food-list">${foodListHtml(foodQuery)}</div>
  </div>`;
}

function foodListHtml(q) {
  const s = q.trim().toLowerCase();
  const list = FOODS.filter((f) => !s || f.name.toLowerCase().includes(s));
  if (!list.length) return '<div class="empty">Ничего не нашлось — добавь как «Свой продукт»</div>';
  return list.map((f) => `<button class="list-item" data-act="sheet" data-name="food" data-id="${f.id}">
    <div class="grow"><div class="h3">${esc(f.name)}</div><div class="sub small num">на 100 г: Б ${fmt(f.p, 1)} · Ж ${fmt(f.f, 1)} · У ${fmt(f.c, 1)}</div></div>
    <b class="num">${fmt(f.k)}</b><span class="muted small">ккал</span></button>`).join('');
}

function foodCalc(f, g) {
  const k = g / 100;
  return [f.k * k, f.p * k, f.f * k, f.c * k];
}

function foodSheet({ id }) {
  const f = FOOD_BY_ID[id];
  const g = f.unit || 100;
  const [k, p, fa, c] = foodCalc(f, g);
  return `<div class="h2">${esc(f.name)}</div>
    <div class="sub small" style="margin-top:4px">на 100 г: ${fmt(f.k)} ккал · Б ${fmt(f.p, 1)} · Ж ${fmt(f.f, 1)} · У ${fmt(f.c, 1)}</div>
    <div class="field" style="background:var(--surface-2);margin-top:14px"><label>Сколько грамм</label>${stepper('foodGrams', g, 'г', 10)}</div>
    ${f.unit ? `<div class="chips" style="margin-top:10px">${[1, 2, 3].map((x) => `<button class="chip" data-act="foodUnit" data-g="${f.unit * x}">${x} ${f.unitName} · ${f.unit * x} г</button>`).join('')}</div>` : ''}
    <div class="card" style="background:var(--surface-2);margin-top:12px" id="food-calc">${foodCalcHtml(k, p, fa, c)}</div>
    <button class="btn block" style="margin-top:14px" data-act="addFood" data-id="${f.id}">${icon('plus')} Добавить</button>`;
}

function foodCalcHtml(k, p, f, c) {
  return `<div class="grid-3 num" style="text-align:center">
    <div><div class="h2">${fmt(k)}</div><div class="muted tiny">ккал</div></div>
    <div><div class="h2">${fmt(p, 1)}</div><div class="muted tiny"><span class="dot" style="display:inline-block;width:7px;height:7px;background:var(--protein)"></span> белки</div></div>
    <div><div class="h2">${fmt(f, 1)} / ${fmt(c, 1)}</div><div class="muted tiny">жиры / угл.</div></div></div>`;
}

function customFoodSheet() {
  const field = (bind, label, ph) => `<div><label class="sub small" style="font-weight:700">${label}</label><input class="input" type="number" inputmode="decimal" placeholder="${ph}" data-bind="cf.${bind}"></div>`;
  return `<div class="h2">Свой продукт</div><div class="sub small" style="margin-top:4px">Укажи значения на всю порцию</div>
    <div style="margin-top:14px"><label class="sub small" style="font-weight:700">Название</label><input class="input" placeholder="Например, шаурма" data-bind="cf.name"></div>
    <div class="grid-2" style="margin-top:10px">${field('k', 'Калории', 'ккал')}${field('p', 'Белки', 'г')}${field('f', 'Жиры', 'г')}${field('c', 'Углеводы', 'г')}</div>
    <div class="err" id="cf-err"></div>
    <button class="btn block" style="margin-top:6px" data-act="addCustomFood">${icon('plus')} Добавить</button>`;
}

// ── Вода ─────────────────────────────────────────────
function renderWater() {
  const p = S.profile;
  const trainDay = isTrainingDay();
  const norm = waterNorm(p, trainDay);
  const drank = waterToday();
  const log = (S.water?.[dkey()] || []).slice().reverse();
  const pct = Math.round((drank / norm) * 100);
  return `<div class="page">
    <div class="topbar"><div class="grow"><div class="h1">Вода</div><div class="sub">${trainDay ? 'День тренировки · 40 мл на кг' : 'День отдыха · 30 мл на кг'}</div></div>
      <span class="badge water">${icon('drop', 'sm')}${fmt(norm / 1000, 1)} л</span></div>
    <div class="card"><div class="glass-wrap">
      ${ring({ value: drank, max: norm, size: 210, stroke: 16, color: 'var(--water)', track: 'var(--water-soft)', center: `<div>${icon('drop', 'lg')}<div class="val" style="font-size:34px;margin-top:6px">${fmt(drank)}</div><div class="muted small">из ${fmt(norm)} мл · ${pct}%</div></div>` })}
    </div>
    ${drank >= norm ? `<div class="notice" style="margin-top:12px">${icon('trophy', 'sm')}<div>Норма на сегодня выполнена — отлично!</div></div>` : `<div class="sub small" style="text-align:center;margin-top:10px">Осталось ${fmt(norm - drank)} мл — примерно ${Math.ceil((norm - drank) / 250)} ${plural(Math.ceil((norm - drank) / 250), 'стакан', 'стакана', 'стаканов')}</div>`}
    </div>
    <div class="water-quick" style="margin-top:12px">
      ${[[150, 'glass'], [250, 'glass'], [330, 'bottle'], [500, 'bottle']].map(([ml, ic]) => `<button data-act="addWater" data-ml="${ml}">${icon(ic)}+${ml}</button>`).join('')}
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn ghost grow sm" data-act="sheet" data-name="customWater">${icon('plus', 'sm')} Своё количество</button>
      <button class="btn ghost sm" data-act="undoWater" ${log.length ? '' : 'disabled'}>${icon('undo', 'sm')} Отменить</button>
    </div>
    <div class="section-title"><div class="h3">Последние 7 дней</div></div>
    <div class="card"><div class="chart" data-chart="water"></div></div>
    ${log.length ? `<div class="section-title"><div class="h3">Сегодня</div><span class="sub small">${log.length} ${plural(log.length, 'запись', 'записи', 'записей')}</span></div>
      <div class="card list">${log.slice(0, 8).map(([ml, m]) => `<div class="list-item"><div class="icon-box water">${icon('drop', 'sm')}</div><div class="grow"><b>${fmt(ml)} мл</b></div><span class="muted num">${pad2(Math.floor(m / 60))}:${pad2(m % 60)}</span></div>`).join('')}</div>` : ''}
    <button class="card card-link" style="margin-top:14px" data-act="reminders">
      <div class="icon-box water">${icon('bell')}</div><div class="grow"><div class="h3">Напоминать пить воду</div><div class="sub small">Бот напишет в течение дня и в дни тренировок</div></div><span class="chev">${icon('right')}</span></button>
    <div class="notice" style="margin-top:12px">${icon('info', 'sm')}<div>Перед тренировкой — 400–600 мл за 2 часа, во время — по 150–250 мл каждые 15–20 минут. Чай, кофе и супы тоже считаются, но основа — вода.</div></div>
  </div>`;
}

function addWater(ml) {
  ml = Math.round(+ml);
  if (!(ml > 0 && ml <= 3000)) return;
  const now = new Date();
  const water = { ...(S.water || {}) };
  const k = dkey(now);
  water[k] = [...(water[k] || []), [ml, now.getHours() * 60 + now.getMinutes()]];
  const keep = Object.keys(water).sort().slice(-14);
  save('water', Object.fromEntries(keep.map((x) => [x, water[x]])));
  const norm = waterNorm(S.profile, isTrainingDay());
  const total = waterToday();
  if (total >= norm && total - ml < norm) { haptic.ok(); toast('Норма воды выполнена!'); } else { haptic.impact(); toast(`+${ml} мл`); }
  render();
}

// ── Профиль ──────────────────────────────────────────
function renderProfile() {
  const p = S.profile;
  const b = bmi(p);
  const cat = bmiCategory(b);
  const name = p.name || tgUser?.first_name || 'Атлет';
  const photo = tgUser?.photo_url;
  const ws = S.weights || [];
  const first = ws[0]?.[1];
  const diff = first ? p.weight - first : 0;
  const bmiPos = Math.max(0, Math.min(100, ((b - 15) / (40 - 15)) * 100));
  return `<div class="page">
    <div class="row" style="flex-direction:column;text-align:center;gap:8px;margin:6px 0 18px">
      <div class="avatar lg">${photo ? `<img src="${esc(photo)}" alt="">` : esc(name[0]?.toUpperCase() || 'G')}</div>
      <div class="h2">${esc(name)}</div>
      <div class="chips" style="justify-content:center"><span class="badge accent">${LEVELS[p.level].title}</span><span class="badge">${GOALS[p.goal].title}</span></div>
    </div>
    <div class="grid-3">
      <div class="stat"><div class="lbl">Вес</div><div class="v num">${fmt(p.weight, p.weight % 1 ? 1 : 0)}<small> кг</small></div></div>
      <div class="stat"><div class="lbl">Рост</div><div class="v num">${p.height}<small> см</small></div></div>
      <div class="stat"><div class="lbl">Возраст</div><div class="v num">${p.age}</div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row between"><div><div class="sub small">Индекс массы тела</div><div class="h2 num">${fmt(b, 1)}</div></div><span class="badge">${cat.title}</span></div>
      <div style="position:relative;margin-top:14px;height:10px;border-radius:999px;display:flex;gap:2px;overflow:hidden">
        <div style="flex:3.5;background:var(--carbs);opacity:.55"></div><div style="flex:6.5;background:var(--fat)"></div><div style="flex:5;background:var(--warn);opacity:.8"></div><div style="flex:10;background:var(--danger);opacity:.7"></div>
      </div>
      <div style="position:relative;height:14px"><div style="position:absolute;left:${bmiPos}%;top:-14px;width:4px;height:18px;border-radius:2px;background:var(--text);transform:translateX(-50%);box-shadow:0 0 0 2px var(--surface)"></div></div>
      <div class="row between muted tiny"><span>15</span><span>18,5</span><span>25</span><span>30</span><span>40</span></div>
      <div class="sub small" style="margin-top:8px">ИМТ не учитывает мышцы: у тренированных людей он бывает завышен.</div>
    </div>
    <div class="section-title"><div class="h3">Вес</div><button class="btn sm" data-act="sheet" data-name="weight">${icon('plus', 'sm')} Записать</button></div>
    <div class="card">
      ${ws.length > 1 ? `<div class="row between" style="margin-bottom:8px"><span class="sub small">С ${shortDate(ws[0][0])}</span><b class="num">${diff > 0 ? '+' : ''}${fmt(diff, 1)} кг</b></div>` : ''}
      <div class="chart" data-chart="weight"></div>
      ${ws.length < 2 ? '<div class="sub small" style="margin-top:8px">Записывай вес раз в неделю утром натощак — здесь появится график.</div>' : ''}
    </div>
    <div class="section-title"><div class="h3">Настройки</div></div>
    <div class="card list">
      ${[
        ['editProfile', 'edit', 'Мои данные и цели', 'Параметры, уровень, дни, ограничения'],
        ['equipment', 'dumbbell', 'Мой зал', `${p.equipment.length} ${plural(p.equipment.length, 'тренажёр', 'тренажёра', 'тренажёров')}`],
        ['about', 'info', 'Как всё считается', 'Формулы и источники'],
      ].map(([n, ic, t, s]) => `<button class="list-item" data-act="push" data-name="${n}"><div class="icon-box">${icon(ic)}</div><div class="grow"><div class="h3">${t}</div><div class="sub small">${s}</div></div><span class="muted">${icon('right')}</span></button>`).join('')}
      <button class="list-item" data-act="reminders"><div class="icon-box water">${icon('bell')}</div><div class="grow"><div class="h3">Напоминания в боте</div><div class="sub small">Вода и дни тренировок</div></div><span class="muted">${icon('right')}</span></button>
    </div>
    <div class="sub small" style="text-align:center;margin-top:18px">${store.isCloud() ? 'Данные хранятся в облаке Telegram и доступны на всех устройствах' : 'Данные хранятся на этом устройстве'}</div>
    <button class="btn block danger" style="margin-top:12px" data-act="reset">${icon('trash')} Сбросить все данные</button>
  </div>`;
}

function weightSheet() {
  return `<div class="h2">Записать вес</div><div class="sub small" style="margin-top:4px">Лучше утром натощак. Норма КБЖУ и воды пересчитается.</div>
    <div class="field" style="background:var(--surface-2);margin-top:14px">${stepper('weightNew', S.profile.weight, 'кг', 0.1)}</div>
    <div class="err" id="w-err"></div>
    <button class="btn block" data-act="saveWeight">${icon('check')} Сохранить</button>`;
}

function renderEditProfile() {
  if (!edit) edit = { ...S.profile, targetWeight: S.profile.targetWeight || '', days: [...S.profile.days], limits: [...S.profile.limits] };
  const d = edit;
  const lifeChips = Object.entries(LIFE_UI).map(([k, l]) => `<button class="chip ${d.lifestyle === k ? 'on' : ''}" data-act="edSet" data-k="lifestyle" data-v="${k}">${l.t}</button>`).join('');
  return `<div class="page no-tabs">
    ${backHeader('Мои данные')}
    <div class="field"><label>Пол</label><div class="chips">
      <button class="chip ${d.sex === 'm' ? 'on' : ''}" data-act="edSet" data-k="sex" data-v="m">Мужской</button>
      <button class="chip ${d.sex === 'f' ? 'on' : ''}" data-act="edSet" data-k="sex" data-v="f">Женский</button></div></div>
    <div class="field"><label>Возраст</label>${stepper('ed.age', d.age, 'лет')}</div>
    <div class="field"><label>Рост</label>${stepper('ed.height', d.height, 'см')}</div>
    <div class="field"><label>Вес</label>${stepper('ed.weight', d.weight, 'кг', 0.5)}</div>
    <div class="field"><label>Цель</label><div class="chips">${Object.entries(GOALS).map(([k, g]) => `<button class="chip ${d.goal === k ? 'on' : ''}" data-act="edSet" data-k="goal" data-v="${k}">${g.title}</button>`).join('')}</div>
      ${d.goal !== 'maintain' ? `<label style="margin-top:12px">Желаемый вес, кг (необязательно)</label><input class="input" type="number" inputmode="decimal" placeholder="Например, ${d.goal === 'lose' ? Math.round(d.weight * 0.9) : Math.round(d.weight * 1.08)}" value="${esc(d.targetWeight)}" data-bind="ed.targetWeight">` : ''}</div>
    <div class="field"><label>Уровень подготовки</label><div class="chips">${Object.entries(LEVELS).map(([k, l]) => `<button class="chip ${d.level === k ? 'on' : ''}" data-act="edSet" data-k="level" data-v="${k}">${l.title}</button>`).join('')}</div>
      <div class="sub small" style="margin-top:8px">Программа перестроится под выбранный уровень.</div></div>
    <div class="field"><label>Образ жизни</label><div class="chips">${lifeChips}</div></div>
    <div class="field"><label>Дни тренировок</label><div class="week">${WD.map((w, i) => `<button class="chip ${d.days.includes(i + 1) ? 'on' : ''}" data-act="edDay" data-d="${i + 1}">${w}</button>`).join('')}</div>
      <div class="sub small" style="margin-top:8px">${daysHint(d.level)}</div></div>
    <div class="field"><label>Ограничения</label><div class="chips">${Object.entries(LIMIT_UI).map(([k, t]) => `<button class="chip ${d.limits.includes(k) ? 'on' : ''}" data-act="edLimit" data-v="${k}">${t}</button>`).join('')}</div></div>
    <div class="err" id="ed-err">${esc(d.err || '')}</div>
    <div class="bottom-bar"><div class="inner"><button class="btn block" data-act="saveProfile">${icon('check')} Сохранить</button></div></div>
  </div>`;
}

function renderEquipmentScreen() {
  if (!edit) edit = { equipment: [...S.profile.equipment] };
  return `<div class="page no-tabs">
    ${backHeader('Мой зал', 'Отметь, что есть в твоём зале')}
    ${renderEquipGrid(edit.equipment, 'edEq')}
    <div class="bottom-bar"><div class="inner"><button class="btn block" data-act="saveEquipment">${icon('check')} Сохранить · ${edit.equipment.length}</button></div></div>
  </div>`;
}

function renderAbout() {
  const p = S.profile;
  const n = nutrition(p);
  const g = GOALS[p.goal];
  const ref = referenceWeight(p);
  return `<div class="page no-tabs">
    ${backHeader('Как всё считается')}
    <div class="card">
      <div class="h3">1. Базовый обмен (BMR)</div>
      <div class="sub small" style="margin-top:4px">Формула Миффлина — Сан Жеора (1990): 10 × вес + 6,25 × рост − 5 × возраст ${p.sex === 'f' ? '− 161' : '+ 5'}</div>
      <div class="kv"><span>Твой BMR</span><b>${fmt(n.bmr)} ккал</b></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="h3">2. Расход за день (TDEE)</div>
      <div class="sub small" style="margin-top:4px">BMR × коэффициент активности. Он зависит от числа тренировок (1,2–1,725) и образа жизни (+0–0,15).</div>
      <div class="kv"><span>Коэффициент</span><b>× ${fmt(n.factor, 3)}</b></div>
      <div class="kv"><span>TDEE</span><b>${fmt(n.tdee)} ккал</b></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="h3">3. Калории под цель</div>
      <div class="sub small" style="margin-top:4px">Похудение: −20% (не ниже BMR). Поддержание: 0%. Набор: +10%, новичкам +15%.</div>
      <div class="kv"><span>${g.title}</span><b>${n.deltaPct > 0 ? '+' : ''}${n.deltaPct}% → ${fmt(n.kcal)} ккал</b></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="h3">4. БЖУ</div>
      <div class="sub small" style="margin-top:4px">Белок ${fmt(g.proteinPerKg, 1)} г/кг (ISSN: 1,4–2,0 г/кг, при дефиците — выше), жиры ${fmt(g.fatPerKg, 1)} г/кг (20–35% калорий), углеводы — остаток.${ref < p.weight ? ` Для расчёта взят вес ${fmt(ref, 1)} кг (при ИМТ 27), чтобы не завышать граммовки.` : ''}</div>
      <div class="kv"><span>Белки</span><b>${n.protein} г</b></div>
      <div class="kv"><span>Жиры</span><b>${n.fat} г</b></div>
      <div class="kv"><span>Углеводы</span><b>${n.carbs} г</b></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="h3">5. Вода</div>
      <div class="sub small" style="margin-top:4px">30 мл на кг веса в обычный день и 40 мл на кг в день тренировки (в пределах 1,5–5 л).</div>
      <div class="kv"><span>Обычный день</span><b>${fmt(waterNorm(p, false))} мл</b></div>
      <div class="kv"><span>День тренировки</span><b>${fmt(waterNorm(p, true))} мл</b></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="h3">6. Тренировки</div>
      <div class="sub small" style="margin-top:4px">Схемы по рекомендациям ACSM: новичкам — 8–12 повторов, 2–3 тренировки всего тела в неделю; дальше — сплиты и больше объёма. Вес прибавляем на 2–10%, когда выполнен верх диапазона повторов.</div>
    </div>
    <div class="section-title"><div class="h3">Источники</div></div>
    <div class="card list small">
      ${[
        ['Mifflin M.D. et al., 1990 — уравнение BMR', 'https://pubmed.ncbi.nlm.nih.gov/2305711/'],
        ['ISSN Position Stand: protein and exercise (2017)', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5477153/'],
        ['ACSM: Progression Models in Resistance Training (2009)', 'https://pubmed.ncbi.nlm.nih.gov/19204579/'],
        ['ВОЗ: классификация ИМТ', 'https://www.who.int/europe/news-room/fact-sheets/item/a-healthy-lifestyle---who-recommendations'],
      ].map(([t, u]) => `<a class="list-item" href="${u}" data-act="link" data-url="${u}">${icon('link', 'sm')}<span class="grow">${t}</span></a>`).join('')}
    </div>
    <div class="notice" style="margin-top:14px">${icon('alert', 'sm')}<div>Приложение не заменяет врача и тренера. При болях, хронических болезнях и беременности — сначала консультация специалиста.</div></div>
  </div>`;
}

// ── Шиты ─────────────────────────────────────────────
function renderSheet() {
  let body = '';
  switch (sheet.name) {
    case 'exercise': body = exSheet(sheet.params); break;
    case 'food': body = foodSheet(sheet.params); break;
    case 'customFood': body = customFoodSheet(); break;
    case 'weight': body = weightSheet(); break;
    case 'customWater': body = `<div class="h2">Сколько выпил(а)?</div>
      <div class="field" style="background:var(--surface-2);margin-top:14px">${stepper('waterCustom', 200, 'мл', 50)}</div>
      <button class="btn block water" style="margin-top:14px" data-act="addWaterCustom">${icon('plus')} Добавить</button>`; break;
    case 'done': {
      const d = sheet.params;
      body = `<div style="text-align:center"><div class="logo" style="margin:6px auto 18px">${icon('trophy')}</div>
        <div class="h1">Тренировка завершена!</div><div class="sub" style="margin-top:6px">${esc(d.title)}</div></div>
        <div class="grid-3" style="margin-top:18px">
          <div class="stat" style="background:var(--surface-2)"><div class="lbl">Время</div><div class="v num">${d.minutes}<small> мин</small></div></div>
          <div class="stat" style="background:var(--surface-2)"><div class="lbl">Подходы</div><div class="v num">${d.setsDone}</div></div>
          <div class="stat" style="background:var(--surface-2)"><div class="lbl">Объём</div><div class="v num">${fmt(d.volume)}<small> кг</small></div></div>
        </div>
        ${d.prs.length ? `<div class="notice" style="margin-top:14px">${icon('zap', 'sm')}<div><b>Новые рекорды:</b><br>${d.prs.map(esc).join('<br>')}</div></div>` : ''}
        <div class="sub small" style="text-align:center;margin-top:14px">Не забудь воду и белок — сегодня норма воды ${fmt(waterNorm(S.profile, true))} мл.</div>
        <button class="btn block" style="margin-top:16px" data-act="closeSheet">Отлично!</button>`;
      break;
    }
    default: body = '';
  }
  return `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet"><div class="inner"><div class="grab"></div>${body}</div></div>`;
}

// ── Графики ──────────────────────────────────────────
function mountCharts() {
  const wEl = app.querySelector('[data-chart="water"]');
  if (wEl) {
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = addDays(now, -i);
      const k = dkey(d);
      days.push({
        label: WD[isoWd(d) - 1],
        full: `${WD[isoWd(d) - 1]}, ${dayMonth(d)}`,
        value: (S.water?.[k] || []).reduce((s, [ml]) => s + ml, 0),
        today: i === 0,
      });
    }
    waterChart(wEl, days, waterNorm(S.profile, isTrainingDay()));
  }
  const gEl = app.querySelector('[data-chart="weight"]');
  if (gEl) {
    const pts = (S.weights || []).map(([k, v]) => ({ label: shortDate(k), value: v }));
    if (pts.length) weightChart(gEl, pts);
  }
}

// ── Действия ─────────────────────────────────────────
function toggle(arr, v) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function botUsername() {
  return (CONFIG.BOT_USERNAME || '').replace(/^@/, '');
}

const ACTIONS = {
  back: () => goBack(),
  tab: ({ tab }) => { haptic.tap(); nav.tab = tab; nav.stack = []; render(); },
  push: ({ name }) => { edit = null; foodQuery = ''; push(name); },
  sheet: ({ name, id }) => openSheet(name, { id }),
  closeSheet: () => { sheet = null; render(); },
  link: (_, el, e) => {
    e.preventDefault();
    if (tg?.openLink) tg.openLink(el.dataset.url);
    else window.open(el.dataset.url, '_blank');
  },

  // Онбординг
  obNext: () => obNext(),
  obSet: ({ k, v }) => { haptic.tap(); ob.d[k] = v; ob.err = ''; render(); },
  obDay: ({ d }) => { haptic.tap(); ob.d.days = toggle(ob.d.days, +d); render(); },
  obLimit: ({ v }) => { haptic.tap(); ob.d.limits = toggle(ob.d.limits, v); render(); },
  obLimitNone: () => { haptic.tap(); ob.d.limits = []; render(); },
  obEq: ({ id }) => { haptic.tap(); ob.d.equipment = toggle(ob.d.equipment, id); render(); },
  obEqPreset: ({ k }) => { haptic.impact(); ob.d.equipment = [...EQUIPMENT_PRESETS.find((p) => p.key === k).ids]; render(); },
  step: ({ bind, d }, el) => {
    haptic.tap();
    const input = el.parentElement.querySelector('input');
    const step = +d;
    const decimals = String(step).includes('.') ? 1 : 0;
    const v = Math.max(0, +((+input.value || 0) + step).toFixed(decimals));
    input.value = v;
    BINDS[bind]?.(String(v), {}, input);
  },

  // Тренировки
  openWorkout: ({ uid }) => push('workout', { uid }),
  startWorkout: ({ uid }) => startWorkout(uid),
  openSession: () => push('session'),
  exSheet: ({ uid, slot }) => openSheet('exercise', { uid, slot }),
  swap: ({ uid, slot, id }) => {
    const swaps = { ...(S.profile.swaps || {}), [`${uid}:${slot}`]: id };
    save('profile', { ...S.profile, swaps });
    recompute();
    if (S.session?.uid === uid && S.session.data[slot]) {
      const it = findWorkout(uid).items.find((x) => String(x.slot) === String(slot));
      const r = reco(it);
      S.session.data[slot] = Array.from({ length: it.unit === 'min' ? 1 : it.sets }, () => [r?.w ?? '', '', 0]);
      save('session', S.session);
    }
    sheet = null;
    haptic.ok();
    toast('Упражнение заменено');
    render();
  },
  setDone: ({ slot, si }) => setDone(slot, +si),
  finishSession: () => finishSession(),
  cancelSession: () => confirmDialog('Отменить тренировку? Результаты не сохранятся.').then((ok) => {
    if (!ok) return;
    save('session', null);
    rest = null;
    nav.stack = [];
    render();
  }),
  restAdd: ({ s }) => { rest.end += +s * 1000; rest.total = Math.max(rest.total, Math.ceil((rest.end - Date.now()) / 1000)); tickNow(); },
  restSkip: () => { rest = null; render(); },

  // Питание
  foodUnit: ({ g }) => {
    const input = app.querySelector('input[data-bind="foodGrams"]');
    input.value = g;
    BINDS.foodGrams(g);
  },
  addFood: ({ id }) => {
    const f = FOOD_BY_ID[id];
    const g = +app.querySelector('input[data-bind="foodGrams"]').value;
    if (!(g > 0 && g <= 3000)) { toast('Укажи вес от 1 до 3000 г'); return; }
    const [k, p, fa, c] = foodCalc(f, g);
    const r1 = (x) => Math.round(x * 10) / 10;
    rollFood();
    save('food', { d: dkey(), items: [...S.food.items, [f.name, g, Math.round(k), r1(p), r1(fa), r1(c)]] });
    sheet = null;
    nav.stack = [];
    nav.tab = 'food';
    haptic.ok();
    toast(`${f.name}: +${Math.round(k)} ккал`);
    render();
  },
  addCustomFood: () => {
    const cf = window.__cf || {};
    const err = app.querySelector('#cf-err');
    if (!cf.name?.trim()) { err.textContent = 'Введи название'; return; }
    const k = +cf.k;
    if (!(k >= 0 && k <= 5000) || cf.k === undefined || cf.k === '') { err.textContent = 'Калории — от 0 до 5000'; return; }
    const num = (x) => Math.max(0, Math.min(500, +x || 0));
    rollFood();
    save('food', { d: dkey(), items: [...S.food.items, [cf.name.trim().slice(0, 40), 0, Math.round(k), num(cf.p), num(cf.f), num(cf.c)]] });
    window.__cf = {};
    sheet = null;
    nav.stack = [];
    nav.tab = 'food';
    haptic.ok();
    render();
  },
  delFood: ({ i }) => {
    const items = S.food.items.filter((_, j) => j !== +i);
    save('food', { ...S.food, items });
    haptic.impact();
    render();
  },

  // Вода
  addWater: ({ ml }) => addWater(ml),
  addWaterCustom: () => { const v = +app.querySelector('input[data-bind="waterCustom"]').value; sheet = null; addWater(v); },
  undoWater: () => {
    const k = dkey();
    const list = (S.water?.[k] || []).slice(0, -1);
    save('water', { ...S.water, [k]: list });
    haptic.impact();
    render();
  },

  // Профиль
  saveWeight: () => {
    const v = +(+app.querySelector('input[data-bind="weightNew"]').value).toFixed(1);
    if (!(v >= 35 && v <= 250)) { app.querySelector('#w-err').textContent = 'Вес — от 35 до 250 кг'; return; }
    const ws = (S.weights || []).filter((w) => w[0] !== dkey());
    save('weights', [...ws, [dkey(), v]].slice(-120));
    save('profile', { ...S.profile, weight: v });
    recompute();
    sheet = null;
    haptic.ok();
    toast('Вес записан — нормы пересчитаны');
    render();
  },
  edSet: ({ k, v }) => { haptic.tap(); edit[k] = v; if (k === 'experience') edit.level = levelFromExperience(v); render(); },
  edDay: ({ d }) => { haptic.tap(); edit.days = toggle(edit.days, +d); render(); },
  edLimit: ({ v }) => { haptic.tap(); edit.limits = toggle(edit.limits, v); render(); },
  saveProfile: () => {
    const errEl = app.querySelector('#ed-err');
    const err = validBody(edit) || validTarget(edit) || (!edit.days.length ? 'Выбери хотя бы один день тренировок' : '');
    if (err) { errEl.textContent = err; haptic.warn(); return; }
    const p = {
      ...S.profile, ...edit,
      age: +edit.age, height: +edit.height, weight: +(+edit.weight).toFixed(1),
      targetWeight: edit.goal !== 'maintain' && edit.targetWeight ? +edit.targetWeight : null,
      days: [...edit.days].sort((a, b) => a - b),
    };
    delete p.err;
    if (p.weight !== S.profile.weight) {
      const ws = (S.weights || []).filter((w) => w[0] !== dkey());
      save('weights', [...ws, [dkey(), p.weight]].slice(-120));
    }
    if (p.level !== S.profile.level || p.days.length !== S.profile.days.length) p.swaps = {};
    save('profile', p);
    recompute();
    edit = null;
    nav.stack.pop();
    haptic.ok();
    toast('Сохранено — программа обновлена');
    render();
  },
  edEq: ({ id }) => { haptic.tap(); edit.equipment = toggle(edit.equipment, id); render(); },
  edEqPreset: ({ k }) => { haptic.impact(); edit.equipment = [...EQUIPMENT_PRESETS.find((p) => p.key === k).ids]; render(); },
  saveEquipment: () => {
    save('profile', { ...S.profile, equipment: edit.equipment });
    recompute();
    edit = null;
    nav.stack.pop();
    haptic.ok();
    toast('Зал обновлён — программа перестроена');
    render();
  },
  reminders: () => {
    const bot = botUsername();
    if (!bot) { toast('Бот ещё не подключён (BOT_USERNAME в js/config.js)'); return; }
    const p = S.profile;
    const tz = -new Date().getTimezoneOffset();
    const goal = { lose: 'l', maintain: 'm', gain: 'g' }[p.goal] || 'm';
    const level = { beginner: 'b', intermediate: 'i', advanced: 'a' }[p.level] || 'b';
    const payload = `r_${p.days.join('')}_${tz < 0 ? `m${-tz}` : tz}_${Math.round(p.weight)}_${goal}${level}${p.sex === 'f' ? 'f' : 'm'}`;
    const url = `https://t.me/${bot}?start=${payload}`;
    if (tgOk('6.1')) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  },
  reset: () => confirmDialog('Удалить все данные и пройти анкету заново?').then((ok) => {
    if (!ok) return;
    store.clearAll();
    S = {};
    program = null;
    ob = null;
    nav = { tab: 'home', stack: [] };
    render();
  }),
};

// Поля ввода: обновляем состояние без перерисовки, чтобы не терять фокус
const BINDS = {
  'ob.age': (v) => { ob.d.age = v; },
  'ob.height': (v) => { ob.d.height = v; },
  'ob.weight': (v) => { ob.d.weight = v; },
  'ob.targetWeight': (v) => { ob.d.targetWeight = v; },
  'ed.age': (v) => { edit.age = v; },
  'ed.height': (v) => { edit.height = v; },
  'ed.weight': (v) => { edit.weight = v; },
  'ed.targetWeight': (v) => { edit.targetWeight = v; },
  set: (v, { slot, si, col }) => {
    S.session.data[slot][+si][+col] = v === '' ? '' : +v;
    save('session', S.session);
  },
  foodSearch: (v) => { foodQuery = v; app.querySelector('#food-list').innerHTML = foodListHtml(v); },
  foodGrams: (v) => {
    const f = FOOD_BY_ID[sheet?.params?.id];
    if (!f) return;
    app.querySelector('#food-calc').innerHTML = foodCalcHtml(...foodCalc(f, +v || 0));
  },
  'cf.name': (v) => { (window.__cf ||= {}).name = v; },
  'cf.k': (v) => { (window.__cf ||= {}).k = v; },
  'cf.p': (v) => { (window.__cf ||= {}).p = v; },
  'cf.f': (v) => { (window.__cf ||= {}).f = v; },
  'cf.c': (v) => { (window.__cf ||= {}).c = v; },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset, el, e);
});

app.addEventListener('input', (e) => {
  const el = e.target.closest('input[data-bind]');
  if (el) BINDS[el.dataset.bind]?.(el.value, el.dataset, el);
});

// ── Тема и запуск ────────────────────────────────────
function applyTheme() {
  const scheme = inTelegram ? tg.colorScheme : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = scheme;
  const bg = scheme === 'light' ? '#f2f3f6' : '#0b0c0f';
  if (tgOk('6.9')) {
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
  }
  if (tgOk('7.10')) tg.setBottomBarColor(bg);
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    if (tgOk('7.7')) tg.disableVerticalSwipes();
    tg.onEvent('themeChanged', () => { applyTheme(); render(); });
    if (nativeBack) tg.BackButton.onClick(goBack);
  }
  applyTheme();
  S = await store.load();
  if (S.profile?.done) {
    rollFood();
    recompute();
    if (S.session) nav.stack = [{ name: 'session', params: {} }];
  }
  render();
  clearInterval(ticker);
  ticker = setInterval(tickNow, 250);
  // Перевалили за полночь — обновим «сегодня»
  let day = dkey();
  setInterval(() => {
    if (dkey() !== day) { day = dkey(); rollFood(); render(); }
  }, 60000);
}

boot();
