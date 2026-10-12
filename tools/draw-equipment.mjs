// Рисует иллюстрации тренажёров в img/equipment/<id>.svg
//   node tools/draw-equipment.mjs
// Все тренажёры собраны из общих деталей (трубы рамы, подушки, весовые стеки,
// блины, тросы), поэтому выглядят в одном стиле. Холст 240×180, пол — y = 160.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'img', 'equipment');

const C = {
  line: '#262c35',
  steel: '#aeb8c6',
  steelDark: '#7f8a9a',
  steelLight: '#eef2f7',
  iron: '#353c48',
  ironLight: '#65707f',
  ironDark: '#1f242b',
  pad: '#c6f432',
  padDark: '#8fb51a',
  padLine: '#4a6106',
  rubber: '#1d2127',
  cable: '#e4e9ef',
  orange: '#ff7a45',
  screen: '#10161c',
  glow: '#c6f432',
};

const r1 = (n) => Math.round(n * 10) / 10;

const DEFS = `<defs>
  <linearGradient id="pad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3ff7a"/><stop offset=".55" stop-color="${C.pad}"/><stop offset="1" stop-color="#a6cf1f"/></linearGradient>
  <linearGradient id="iron" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5260"/><stop offset="1" stop-color="#262b33"/></linearGradient>
  <linearGradient id="ironH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#262b33"/><stop offset=".45" stop-color="#4f5866"/><stop offset="1" stop-color="#262b33"/></linearGradient>
  <linearGradient id="steelBox" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dbe2ea"/><stop offset="1" stop-color="#8d98a8"/></linearGradient>
  <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8f9aa8"/><stop offset=".4" stop-color="#ffffff"/><stop offset="1" stop-color="#8f9aa8"/></linearGradient>
  <radialGradient id="plate" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#5a6372"/><stop offset=".7" stop-color="#2c323b"/><stop offset="1" stop-color="#1c2026"/></radialGradient>
  <radialGradient id="padR" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ecff9e"/><stop offset=".6" stop-color="${C.pad}"/><stop offset="1" stop-color="#93b81c"/></radialGradient>
  <linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e2a33"/><stop offset="1" stop-color="#0b1015"/></linearGradient>
</defs>`;

// ── Рама из труб: сначала все контуры, потом заливка, потом блики — стыки чистые
class Frame {
  constructor() { this.items = []; }
  tube(x1, y1, x2, y2, w = 7, color = C.steel) { this.items.push({ pts: [[x1, y1], [x2, y2]], w, color }); return this; }
  path(pts, w = 7, color = C.steel) { this.items.push({ pts, w, color }); return this; }
  render() {
    const d = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)},${r1(y)}`).join('');
    const outline = this.items.map((t) => `<path d="${d(t.pts)}" fill="none" stroke="${C.line}" stroke-width="${t.w + 3}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    const fill = this.items.map((t) => `<path d="${d(t.pts)}" fill="none" stroke="${t.color}" stroke-width="${t.w}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    const shine = this.items.map((t) => {
      if (t.w < 4) return '';
      return t.pts.slice(1).map(([x2, y2], i) => {
        const [x1, y1] = t.pts[i];
        const L = Math.hypot(x2 - x1, y2 - y1) || 1;
        let nx = -(y2 - y1) / L;
        let ny = (x2 - x1) / L;
        if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
        const o = t.w * 0.2;
        const k = Math.min(0.12, (t.w * 0.6) / L);
        const ax = x1 + (x2 - x1) * k + nx * o;
        const ay = y1 + (y2 - y1) * k + ny * o;
        const bx = x2 - (x2 - x1) * k + nx * o;
        const by = y2 - (y2 - y1) * k + ny * o;
        return `<path d="M${r1(ax)},${r1(ay)}L${r1(bx)},${r1(by)}" stroke="${C.steelLight}" stroke-width="${r1(t.w * 0.28)}" stroke-linecap="round" opacity=".75"/>`;
      }).join('');
    }).join('');
    return outline + fill + shine;
  }
}

// ── Детали
const shadow = (cx, rx, ry = 6) => `<ellipse cx="${cx}" cy="161" rx="${rx}" ry="${ry}" fill="#000" opacity=".28"/>`;

function pad(x, y, w, h, { angle = 0, cx, cy, r } = {}) {
  const rad = r ?? Math.min(h / 2, 7);
  const ox = cx ?? x + w / 2;
  const oy = cy ?? y + h / 2;
  const t = angle ? ` transform="rotate(${angle} ${r1(ox)} ${r1(oy)})"` : '';
  return `<g${t}>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rad}" fill="url(#pad)" stroke="${C.padLine}" stroke-width="1.6"/>
    <rect x="${x + 2.5}" y="${y + 2.5}" width="${Math.max(0, w - 5)}" height="${Math.max(0, h - 5)}" rx="${Math.max(0, rad - 2)}" fill="none" stroke="${C.padLine}" stroke-width=".7" stroke-dasharray="2 2" opacity=".55"/>
    <rect x="${x + 4}" y="${y + 2}" width="${Math.max(0, w - 8)}" height="${Math.min(3, h / 4)}" rx="1.5" fill="#fff" opacity=".45"/>
  </g>`;
}

// Валик (поролоновый ролик) в торец
const roller = (cx, cy, r = 9) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#padR)" stroke="${C.padLine}" stroke-width="1.6"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.38}" fill="${C.steel}" stroke="${C.line}" stroke-width="1.2"/>`;

// Валик сбоку (горизонтальный цилиндр)
function rollerSide(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="url(#pad)" stroke="${C.padLine}" stroke-width="1.6"/>
    <rect x="${x + 3}" y="${y + 2}" width="${w - 6}" height="${h * 0.25}" rx="${h * 0.12}" fill="#fff" opacity=".45"/>`;
}

// Блин в анфас
function plate(cx, cy, r, { ring = true } = {}) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#plate)" stroke="${C.line}" stroke-width="1.6"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.86}" fill="none" stroke="${C.ironLight}" stroke-width="1" opacity=".8"/>
    ${ring ? `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="none" stroke="${C.ironDark}" stroke-width="2"/>` : ''}
    <circle cx="${cx}" cy="${cy}" r="${Math.max(3, r * 0.2)}" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>
    <circle cx="${cx}" cy="${cy}" r="${Math.max(1.4, r * 0.08)}" fill="${C.ironDark}"/>
    <path d="M${r1(cx - r * 0.62)},${r1(cy - r * 0.45)} A${r * 0.78},${r * 0.78} 0 0 1 ${r1(cx + r * 0.1)},${r1(cy - r * 0.77)}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".28"/>`;
}

// Блин в торец (вертикальная плашка)
function plateEdge(x, cy, w, h, { stripe = false } = {}) {
  return `<rect x="${x}" y="${r1(cy - h / 2)}" width="${w}" height="${h}" rx="${Math.min(w / 2, 3.5)}" fill="url(#ironH)" stroke="${C.line}" stroke-width="1.6"/>
    ${stripe ? `<rect x="${x + w / 2 - 1}" y="${r1(cy - h / 2 + 4)}" width="2" height="${h - 8}" rx="1" fill="${C.pad}" opacity=".9"/>` : ''}
    <rect x="${x + 1.5}" y="${r1(cy - h / 2 + 3)}" width="1.4" height="${h - 6}" rx=".7" fill="#fff" opacity=".22"/>`;
}

// Весовой стек: направляющие, плиты, штырь
function stack(x, y, w, h, n = 10) {
  const top = y + h - n * 7.2;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#20252c" stroke="${C.line}" stroke-width="1.4"/>`;
  s += `<rect x="${x + w * 0.3 - 1}" y="${y + 3}" width="2" height="${h - 6}" fill="url(#chrome)"/><rect x="${x + w * 0.7 - 1}" y="${y + 3}" width="2" height="${h - 6}" fill="url(#chrome)"/>`;
  for (let i = 0; i < n; i++) {
    const py = top + i * 7.2;
    s += `<rect x="${x + 2.5}" y="${r1(py)}" width="${w - 5}" height="6" rx="1.2" fill="url(#iron)" stroke="${C.ironDark}" stroke-width=".8"/>`;
    s += `<rect x="${x + 4}" y="${r1(py + 1)}" width="${w - 8}" height="1" fill="#fff" opacity=".18"/>`;
  }
  const pinY = top + 4 * 7.2 + 3;
  s += `<rect x="${x + w - 3}" y="${r1(pinY - 1.5)}" width="9" height="3" rx="1.5" fill="${C.orange}" stroke="${C.line}" stroke-width=".8"/>`;
  s += `<rect x="${x + 3}" y="${r1(top - 9)}" width="${w - 6}" height="7" rx="2" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1"/>`;
  return s;
}

const pulley = (cx, cy, r = 6) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="${cx}" cy="${cy}" r="${r * 0.35}" fill="${C.ironDark}"/>`;
const cable = (d) => `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${C.cable}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`;
const grip = (x1, y1, x2, y2, w = 5) => `<path d="M${x1},${y1}L${x2},${y2}" stroke="${C.line}" stroke-width="${w + 2.4}" stroke-linecap="round"/><path d="M${x1},${y1}L${x2},${y2}" stroke="${C.rubber}" stroke-width="${w}" stroke-linecap="round"/><path d="M${x1},${y1}L${x2},${y2}" stroke="#fff" stroke-width="${w * 0.2}" stroke-linecap="round" opacity=".18" transform="translate(-0.8 -0.8)"/>`;
const foot = (x, y, w = 14) => `<rect x="${x - w / 2}" y="${y - 3}" width="${w}" height="6" rx="3" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.2"/>`;
const box = (x, y, w, h, r = 4, fill = 'url(#steelBox)') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${C.line}" stroke-width="1.6"/>`;

function screenBox(x, y, w, h, angle = 0) {
  const t = angle ? ` transform="rotate(${angle} ${x + w / 2} ${y + h / 2})"` : '';
  return `<g${t}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${C.iron}" stroke="${C.line}" stroke-width="1.6"/>
    <rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" rx="1.5" fill="url(#screen)"/>
    <rect x="${x + 6}" y="${y + 6}" width="${(w - 12) * 0.6}" height="2.4" rx="1.2" fill="${C.glow}"/>
    <rect x="${x + 6}" y="${y + 11}" width="${(w - 12) * 0.35}" height="2" rx="1" fill="${C.glow}" opacity=".55"/></g>`;
}

// Гриф штанги
function bar(x1, x2, y, { sleeveL = 30, sleeveR = 30, knurl = true, h = 4.5 } = {}) {
  let s = `<rect x="${x1 + sleeveL}" y="${r1(y - h / 2)}" width="${x2 - x1 - sleeveL - sleeveR}" height="${h}" rx="${h / 2}" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>`;
  if (knurl) {
    const a = x1 + sleeveL + 12;
    const b = x2 - sleeveR - 12;
    const mid = (a + b) / 2;
    for (let x = a; x < b; x += 3) {
      if (Math.abs(x - mid) < 14) continue;
      s += `<path d="M${r1(x)},${r1(y - h / 2 + 0.8)}l1.5,${h - 1.6}" stroke="${C.steelDark}" stroke-width=".7"/>`;
    }
  }
  s += `<rect x="${x1}" y="${r1(y - 4.5)}" width="${sleeveL}" height="9" rx="2.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`;
  s += `<rect x="${x2 - sleeveR}" y="${r1(y - 4.5)}" width="${sleeveR}" height="9" rx="2.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`;
  s += `<rect x="${x1 + sleeveL - 3}" y="${r1(y - 7)}" width="5" height="14" rx="1.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>`;
  s += `<rect x="${x2 - sleeveR - 2}" y="${r1(y - 7)}" width="5" height="14" rx="1.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>`;
  return s;
}

const collar = (x, y) => `<rect x="${x}" y="${y - 6.5}" width="5" height="13" rx="1.5" fill="${C.orange}" stroke="${C.line}" stroke-width="1.2"/>`;

// ── Тренажёры
const ART = {};

ART.barbell = () => {
  const y = 102;
  return [
    shadow(120, 104),
    bar(14, 226, y, { sleeveL: 44, sleeveR: 44 }),
    plateEdge(46, y, 13, 112, { stripe: true }), plateEdge(33, y, 11, 86), collar(26, y),
    plateEdge(181, y, 13, 112, { stripe: true }), plateEdge(196, y, 11, 86), collar(209, y),
  ];
};

ART.ezbar = () => {
  const y = 124;
  const f = new Frame().path([[66, y], [86, y], [96, y - 11], [108, y + 9], [120, y - 4], [132, y + 9], [144, y - 11], [154, y], [174, y]], 4.5, C.steel);
  return [
    shadow(120, 92),
    `<rect x="34" y="${y - 4.5}" width="34" height="9" rx="2.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`,
    `<rect x="172" y="${y - 4.5}" width="34" height="9" rx="2.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`,
    f.render(),
    `<rect x="64" y="${y - 7}" width="5" height="14" rx="1.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/><rect x="171" y="${y - 7}" width="5" height="14" rx="1.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>`,
    plateEdge(52, y, 11, 66, { stripe: true }), plateEdge(42, y, 9, 50), collar(36, y),
    plateEdge(177, y, 11, 66, { stripe: true }), plateEdge(189, y, 9, 50), collar(199, y),
  ];
};

function dumbbell(cx, cy, s = 1, dim = false) {
  const hw = 32 * s;
  const h = 54 * s;
  const w = 25 * s;
  const hx = 7 * s;
  const side = dim ? '#2a3039' : 'url(#ironH)';
  const face = dim ? '#353c47' : '#4b5462';
  // корпус головы + шестигранный торец снаружи
  const head = (x0, x1, outer) => {
    const hex = [[outer, cy - h / 2], [outer - hx, cy - h / 4], [outer - hx, cy + h / 4], [outer, cy + h / 2], [outer + hx, cy + h / 4], [outer + hx, cy - h / 4]]
      .map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
    return `<rect x="${r1(Math.min(x0, x1))}" y="${r1(cy - h / 2)}" width="${r1(Math.abs(x1 - x0))}" height="${r1(h)}" rx="${r1(2 * s)}" fill="${side}" stroke="${C.line}" stroke-width="1.6"/>
      <path d="M${r1(Math.min(x0, x1))},${r1(cy - h / 4)}H${r1(Math.max(x0, x1))}M${r1(Math.min(x0, x1))},${r1(cy + h / 4)}H${r1(Math.max(x0, x1))}" stroke="#fff" stroke-width="1" opacity="${dim ? 0.07 : 0.16}"/>
      <polygon points="${hex}" fill="${face}" stroke="${C.line}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M${r1(outer - hx + 1.5)},${r1(cy - h / 4 + 1)}V${r1(cy + h / 4 - 1)}" stroke="#fff" stroke-width="1" opacity="${dim ? 0.1 : 0.25}"/>`;
  };
  let out = `<rect x="${r1(cx - hw)}" y="${r1(cy - 4.5 * s)}" width="${r1(hw * 2)}" height="${r1(9 * s)}" rx="${r1(4 * s)}" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`;
  for (let x = cx - hw + 6 * s; x < cx + hw - 6 * s; x += 3 * s) out += `<path d="M${r1(x)},${r1(cy - 3.5 * s)}l${r1(1.6 * s)},${r1(7 * s)}" stroke="${C.steelDark}" stroke-width=".7"/>`;
  return out + head(cx - hw, cx - hw - w, cx - hw - w) + head(cx + hw, cx + hw + w, cx + hw + w);
}

ART.dumbbells = () => [shadow(124, 100), dumbbell(140, 98, 0.78, true), dumbbell(110, 128, 1)];

function kettlebell(cx, by, r, fill, dark = false) {
  const cy = by - r * 0.86;
  const dy = by - cy;
  const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
  const line = dark ? C.line : C.padLine;
  return `<path d="M${r1(cx - r * 0.55)},${r1(cy - r * 0.55)} C${r1(cx - r * 0.75)},${r1(cy - r * 1.75)} ${r1(cx + r * 0.75)},${r1(cy - r * 1.75)} ${r1(cx + r * 0.55)},${r1(cy - r * 0.55)}" fill="none" stroke="${C.line}" stroke-width="${r1(r * 0.36)}" stroke-linecap="round"/>
    <path d="M${r1(cx - r * 0.55)},${r1(cy - r * 0.55)} C${r1(cx - r * 0.75)},${r1(cy - r * 1.75)} ${r1(cx + r * 0.75)},${r1(cy - r * 1.75)} ${r1(cx + r * 0.55)},${r1(cy - r * 0.55)}" fill="none" stroke="${dark ? '#3a414c' : C.pad}" stroke-width="${r1(r * 0.28)}" stroke-linecap="round"/>
    <path d="M${r1(cx - r * 0.5)},${r1(cy - r * 0.9)} C${r1(cx - r * 0.55)},${r1(cy - r * 1.45)} ${r1(cx)},${r1(cy - r * 1.52)} ${r1(cx + r * 0.2)},${r1(cy - r * 1.5)}" fill="none" stroke="#fff" stroke-width="${r1(r * 0.06)}" stroke-linecap="round" opacity=".3"/>
    <path d="M${r1(cx - dx)},${r1(by)} A${r},${r} 0 1 1 ${r1(cx + dx)},${r1(by)} Z" fill="${fill}" stroke="${line}" stroke-width="1.8"/>
    <rect x="${r1(cx - dx - 2)}" y="${r1(by - 2)}" width="${r1(dx * 2 + 4)}" height="4" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1"/>
    <path d="M${r1(cx - r * 0.62)},${r1(cy - r * 0.2)} A${r * 0.7},${r * 0.7} 0 0 1 ${r1(cx - r * 0.05)},${r1(cy - r * 0.7)}" fill="none" stroke="#fff" stroke-width="${r1(r * 0.08)}" stroke-linecap="round" opacity=".35"/>`;
}

ART.kettlebell = () => [shadow(124, 92), kettlebell(98, 156, 46, 'url(#plate)', true), kettlebell(178, 156, 27, 'url(#padR)')];

ART.bench = () => {
  const f = new Frame()
    .tube(30, 156, 92, 156, 7).tube(46, 156, 46, 54, 8)
    .tube(46, 98, 70, 98, 6)
    .tube(80, 156, 96, 116, 7).tube(178, 156, 166, 116, 7)
    .tube(150, 156, 196, 156, 7).tube(92, 116, 170, 116, 7);
  return [
    shadow(118, 98),
    f.render(),
    `<path d="M40,70 h16 v6 h-10 v-12" fill="none" stroke="${C.line}" stroke-width="5" stroke-linejoin="round"/><path d="M40,70 h16 v6 h-10 v-12" fill="none" stroke="${C.steel}" stroke-width="2.5" stroke-linejoin="round"/>`,
    pad(66, 103, 120, 13, { r: 5 }),
    plate(48, 66, 34), foot(30, 157), foot(92, 157), foot(150, 157), foot(196, 157),
  ];
};

ART.adjbench = () => {
  const f = new Frame()
    .tube(36, 152, 202, 152, 8)
    .tube(130, 152, 130, 118, 8).tube(178, 152, 170, 118, 7)
    .tube(70, 152, 104, 96, 6).tube(96, 152, 114, 126, 5)
    .tube(124, 118, 186, 118, 7);
  let ladder = '';
  for (let i = 0; i < 5; i++) ladder += `<rect x="${r1(76 + i * 6.5)}" y="${r1(142 - i * 10.5)}" width="5" height="4" rx="1" fill="${C.steelDark}" stroke="${C.line}" stroke-width=".8"/>`;
  return [
    shadow(120, 96),
    f.render(), ladder,
    pad(108, 104, 84, 14, { r: 6 }),
    pad(52, 72, 74, 15, { angle: -42, cx: 114, cy: 104, r: 6 }),
    `<circle cx="206" cy="152" r="7" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.4"/><circle cx="206" cy="152" r="2.4" fill="${C.steel}"/>`,
    `<path d="M196,108 q10,0 12,10" fill="none" stroke="${C.line}" stroke-width="7" stroke-linecap="round"/><path d="M196,108 q10,0 12,10" fill="none" stroke="${C.rubber}" stroke-width="4.5" stroke-linecap="round"/>`,
    foot(40, 153, 12),
  ];
};

ART.rack = () => {
  const f = new Frame()
    .tube(44, 22, 44, 156, 9).tube(196, 22, 196, 156, 9)
    .tube(44, 24, 196, 24, 8)
    .tube(28, 156, 212, 156, 8)
    .tube(30, 36, 210, 36, 5);
  let holes = '';
  for (let y = 46; y < 148; y += 8) holes += `<circle cx="44" cy="${y}" r="1.4" fill="${C.ironDark}"/><circle cx="196" cy="${y}" r="1.4" fill="${C.ironDark}"/>`;
  const hook = (x, dir) => `<path d="M${x},74 h${dir * 9} v-7" fill="none" stroke="${C.line}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/><path d="M${x},74 h${dir * 9} v-7" fill="none" stroke="${C.orange}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  const safety = (x) => `<rect x="${x - 7}" y="116" width="14" height="7" rx="2" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`;
  return [
    shadow(120, 104),
    f.render(), holes,
    grip(30, 36, 50, 36, 4.5), grip(190, 36, 210, 36, 4.5),
    safety(44), safety(196),
    bar(6, 234, 70, { sleeveL: 34, sleeveR: 34 }),
    hook(44, 1), hook(196, -1),
    plateEdge(22, 70, 12, 92, { stripe: true }), plateEdge(12, 70, 9, 70),
    plateEdge(206, 70, 12, 92, { stripe: true }), plateEdge(219, 70, 9, 70),
    foot(28, 157), foot(212, 157),
  ];
};

ART.smith = () => {
  const f = new Frame()
    .tube(34, 20, 34, 156, 8).tube(206, 20, 206, 156, 8)
    .tube(34, 20, 206, 20, 8).tube(24, 156, 216, 156, 8);
  const rod = (x) => `<rect x="${x - 2}" y="24" width="4" height="130" rx="2" fill="url(#chrome)" stroke="${C.line}" stroke-width=".8"/>`;
  const carriage = (x) => `<rect x="${x - 7}" y="80" width="14" height="22" rx="3" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>
    <path d="M${x},102 v6 q0,4 4,4" fill="none" stroke="${C.line}" stroke-width="5" stroke-linecap="round"/><path d="M${x},102 v6 q0,4 4,4" fill="none" stroke="${C.orange}" stroke-width="2.6" stroke-linecap="round"/>`;
  const stop = (x) => `<rect x="${x - 6}" y="128" width="12" height="6" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.2"/>`;
  return [
    shadow(120, 104),
    f.render(), rod(62), rod(178),
    stop(62), stop(178),
    bar(8, 232, 92, { sleeveL: 32, sleeveR: 32 }),
    carriage(62), carriage(178),
    plateEdge(22, 92, 11, 84, { stripe: true }), plateEdge(207, 92, 11, 84, { stripe: true }),
    foot(24, 157), foot(216, 157),
  ];
};

ART.legpress = () => {
  const ux = 0.738;
  const uy = -0.675;
  const at = (t) => [92 + ux * 150 * t, 150 + uy * 150 * t];
  const [sx, sy] = at(0.5);
  const f = new Frame()
    .tube(24, 154, 214, 154, 8)
    .tube(92, 150, 92 + ux * 150, 150 + uy * 150, 9)
    .tube(204, 154, 204, 52, 8).tube(160, 154, 196, 64, 6)
    .tube(52, 154, 60, 128, 6).tube(96, 154, 92, 132, 6);
  const plateX = sx + 16;
  const plateY = sy - 26;
  return [
    shadow(120, 104),
    f.render(),
    `<g transform="rotate(${r1((Math.atan2(uy, ux) * 180) / Math.PI)} ${r1(sx)} ${r1(sy)})">
      <rect x="${r1(sx - 22)}" y="${r1(sy - 9)}" width="44" height="18" rx="4" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.6"/>
    </g>`,
    plate(plateX, plateY, 22),
    `<g transform="rotate(${r1((Math.atan2(uy, ux) * 180) / Math.PI + 90)} ${r1(sx - 14)} ${r1(sy + 12)})">
      <rect x="${r1(sx - 14 - 36)}" y="${r1(sy + 12 - 6)}" width="72" height="12" rx="3" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<path d="M${r1(sx - 44 + i * 11)},${r1(sy + 8)}v8" stroke="#fff" stroke-width="1" opacity=".18"/>`).join('')}
    </g>`,
    pad(46, 124, 54, 12, { r: 5 }),
    pad(24, 96, 58, 13, { angle: 52, cx: 52, cy: 104, r: 6 }),
    grip(96, 128, 108, 128, 4.5),
    foot(24, 155), foot(214, 155),
  ];
};

ART.hack = () => {
  const ux = 0.42;
  const uy = -0.907;
  const P = (t, n = 0) => [72 + ux * 140 * t + -uy * n, 150 + uy * 140 * t + ux * n];
  const [ax, ay] = P(0);
  const [bx, by] = P(1);
  const ang = (Math.atan2(uy, ux) * 180) / Math.PI;
  const f = new Frame()
    .tube(22, 154, 208, 154, 8)
    .tube(ax, ay, bx, by, 9)
    .tube(184, 154, 184, 28, 8)
    .tube(bx, by, 184, 30, 7)
    .tube(184, 96, ...P(0.42, 4).map(r1), 6);
  const [cx, cy] = P(0.55, -12);
  const [px, py] = P(0.55, 16);
  const [shx, shy] = P(0.78, -16);
  return [
    shadow(118, 102),
    f.render(),
    plate(px + 6, py, 20),
    pad(cx - 34, cy - 7, 68, 14, { angle: ang, cx, cy, r: 6 }),
    `<g transform="rotate(${r1(ang)} ${r1(shx)} ${r1(shy)})">${pad(shx - 9, shy - 16, 18, 14, { r: 5 })}</g>`,
    grip(...P(0.86, -8).map(r1), ...P(0.86, -24).map(r1), 4.5),
    `<g transform="rotate(-14 56 140)"><rect x="26" y="134" width="60" height="9" rx="2.5" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/><path d="M30,137h52" stroke="#fff" stroke-width="1" opacity=".2"/></g>`,
    foot(22, 155), foot(208, 155),
  ];
};

ART.legext = () => {
  const f = new Frame()
    .tube(40, 154, 206, 154, 8)
    .tube(122, 154, 122, 112, 8)
    .tube(160, 112, 168, 56, 7)
    .tube(86, 104, 86, 112, 6)
    .path([[88, 102], [78, 120], [74, 138]], 6, C.steel)
    .tube(176, 154, 176, 34, 7).tube(214, 154, 214, 34, 7).tube(176, 34, 214, 34, 7);
  return [
    shadow(124, 98),
    stack(180, 40, 30, 112, 9),
    f.render(),
    pulley(176, 132, 6),
    cable('M176,126 L176,40 L195,40 M176,132 L96,132 L84,112'),
    pad(88, 100, 74, 14, { r: 6 }),
    pad(150, 52, 14, 54, { r: 6 }),
    roller(74, 140, 10), roller(96, 88, 8),
    `<circle cx="88" cy="104" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="88" cy="104" r="2" fill="${C.orange}"/>`,
    grip(120, 120, 136, 120, 5),
    foot(40, 155), foot(206, 155),
  ];
};

ART.legcurl = () => {
  const f = new Frame()
    .tube(30, 154, 210, 154, 8)
    .tube(76, 154, 84, 110, 7).tube(150, 154, 150, 108, 7)
    .tube(30, 154, 30, 40, 7).tube(62, 154, 62, 40, 7).tube(30, 40, 62, 40, 7)
    .path([[182, 100], [196, 86], [204, 70]], 6, C.steel);
  return [
    shadow(120, 100),
    stack(34, 46, 26, 106, 9),
    f.render(),
    cable('M62,60 L66,60 L180,100'),
    pad(66, 96, 120, 14, { angle: -6, cx: 126, cy: 103, r: 6 }),
    `<path d="M110,94 q14,-12 30,-4" fill="none" stroke="${C.padLine}" stroke-width="1.4" opacity=".5"/>`,
    roller(206, 70, 10), roller(196, 112, 8),
    `<circle cx="182" cy="100" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="182" cy="100" r="2" fill="${C.orange}"/>`,
    grip(76, 118, 76, 132, 5),
    foot(30, 155), foot(210, 155),
  ];
};

ART.calf = () => {
  const f = new Frame()
    .tube(26, 154, 210, 154, 8)
    .tube(70, 154, 70, 120, 8)
    .tube(182, 154, 182, 104, 8)
    .path([[182, 104], [150, 92], [118, 92]], 7, C.steel)
    .tube(150, 92, 150, 70, 6);
  return [
    shadow(118, 100),
    f.render(),
    plate(150, 62, 18),
    pad(44, 112, 54, 13, { r: 6 }),
    rollerSide(96, 90, 52, 14),
    `<circle cx="182" cy="104" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="182" cy="104" r="2" fill="${C.orange}"/>`,
    `<g transform="rotate(-16 132 140)"><rect x="112" y="135" width="42" height="11" rx="2.5" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/><path d="M116,139h34" stroke="#fff" stroke-width="1" opacity=".2"/></g>`,
    grip(118, 86, 118, 74, 5),
    foot(26, 155), foot(210, 155),
  ];
};

ART.abductor = () => {
  const f = new Frame()
    .tube(46, 154, 194, 154, 8)
    .tube(120, 154, 120, 126, 9)
    .tube(108, 40, 108, 120, 7).tube(132, 40, 132, 120, 7)
    .path([[110, 132], [86, 132], [74, 120]], 6, C.steel)
    .path([[130, 132], [154, 132], [166, 120]], 6, C.steel);
  return [
    shadow(120, 84),
    `<rect x="104" y="14" width="32" height="30" rx="3" fill="#20252c" stroke="${C.line}" stroke-width="1.4"/>`,
    ...[0, 1, 2].map((i) => `<rect x="107" y="${22 + i * 7}" width="26" height="6" rx="1.2" fill="url(#iron)" stroke="${C.ironDark}" stroke-width=".8"/>`),
    f.render(),
    pad(96, 44, 48, 76, { r: 9 }),
    pad(88, 116, 64, 14, { r: 6 }),
    pad(60, 96, 15, 42, { angle: -14, r: 6 }),
    pad(165, 96, 15, 42, { angle: 14, r: 6 }),
    grip(80, 116, 92, 116, 5), grip(148, 116, 160, 116, 5),
    `<rect x="98" y="146" width="16" height="5" rx="2" fill="${C.rubber}"/><rect x="126" y="146" width="16" height="5" rx="2" fill="${C.rubber}"/>`,
    foot(46, 155), foot(194, 155),
  ];
};

ART.hyperext = () => {
  const f = new Frame()
    .tube(34, 154, 206, 154, 8)
    .tube(62, 150, 172, 64, 9)
    .tube(190, 154, 178, 70, 8)
    .tube(84, 154, 98, 128, 6)
    .path([[172, 64], [190, 46]], 6, C.steel);
  return [
    shadow(118, 100),
    f.render(),
    pad(150, 42, 46, 18, { angle: -38, cx: 172, cy: 56, r: 8 }),
    `<g transform="rotate(-38 82 136)"><rect x="62" y="132" width="40" height="9" rx="2.5" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/></g>`,
    roller(96, 116, 8), roller(108, 106, 8),
    grip(190, 46, 198, 38, 5),
    foot(34, 155), foot(206, 155),
  ];
};

ART.latpull = () => {
  const f = new Frame()
    .tube(100, 18, 100, 156, 8).tube(140, 18, 140, 156, 8)
    .tube(88, 18, 152, 18, 8)
    .tube(60, 156, 180, 156, 8)
    .tube(120, 156, 120, 126, 8)
    .tube(100, 110, 140, 110, 6);
  const barPath = 'M34,64 L46,52 L194,52 L206,64';
  return [
    shadow(120, 90),
    stack(104, 66, 32, 86, 9),
    f.render(),
    pulley(120, 26, 7),
    cable('M120,33 L120,50 M114,52 L120,44 L126,52'),
    `<path d="${barPath}" fill="none" stroke="${C.line}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="${barPath}" fill="none" stroke="${C.steel}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="M50,50.5 L190,50.5" stroke="${C.steelLight}" stroke-width="1.4" opacity=".8"/>`,
    grip(34, 64, 44, 54, 5.5), grip(196, 54, 206, 64, 5.5),
    rollerSide(76, 100, 34, 13), rollerSide(130, 100, 34, 13),
    pad(90, 120, 60, 13, { r: 6 }),
    foot(60, 157), foot(180, 157),
  ];
};

ART.cablerow = () => {
  const f = new Frame()
    .tube(26, 154, 214, 154, 8)
    .tube(30, 134, 150, 134, 8)
    .tube(30, 154, 30, 134, 7).tube(86, 154, 86, 134, 7)
    .tube(176, 154, 176, 34, 8).tube(212, 154, 212, 34, 8).tube(176, 34, 212, 34, 8)
    .tube(150, 154, 150, 106, 6);
  return [
    shadow(120, 104),
    stack(180, 42, 28, 110, 10),
    f.render(),
    pulley(170, 128, 6),
    cable('M176,40 L194,40 M170,128 L106,121'),
    pad(48, 121, 44, 13, { r: 6 }),
    `<g transform="rotate(-22 150 122)"><rect x="143" y="100" width="12" height="42" rx="3" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/><path d="M146,104v34" stroke="#fff" stroke-width="1" opacity=".2"/></g>`,
    `<path d="M106,121 L96,112 L96,130 Z" fill="none" stroke="${C.line}" stroke-width="5" stroke-linejoin="round"/><path d="M106,121 L96,112 L96,130 Z" fill="none" stroke="${C.steel}" stroke-width="2.6" stroke-linejoin="round"/>`,
    grip(96, 110, 96, 132, 5),
    foot(26, 155), foot(214, 155),
  ];
};

ART.tbar = () => {
  const ang = -19;
  return [
    shadow(118, 100),
    `<rect x="16" y="142" width="34" height="14" rx="3" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/>`,
    `<circle cx="38" cy="140" r="8" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.6"/><circle cx="38" cy="140" r="3" fill="${C.ironDark}"/>`,
    `<g transform="rotate(${ang} 38 140)">
      <rect x="38" y="137.5" width="128" height="5" rx="2.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>
      <rect x="166" y="135.5" width="38" height="9" rx="2.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>
      <rect x="163" y="133" width="5" height="14" rx="1.5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>
      ${plateEdge(168, 140, 13, 96, { stripe: true })}${plateEdge(182, 140, 11, 74)}${collar(194, 140)}
    </g>`,
    `<path d="M150,104 L144,124 L160,124 Z" fill="none" stroke="${C.line}" stroke-width="5" stroke-linejoin="round"/><path d="M150,104 L144,124 L160,124 Z" fill="none" stroke="${C.steel}" stroke-width="2.6" stroke-linejoin="round"/>`,
    grip(140, 124, 164, 124, 5),
    `<rect x="70" y="150" width="34" height="7" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.2"/><rect x="108" y="150" width="34" height="7" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.2"/>`,
  ];
};

ART.gravitron = () => {
  const f = new Frame()
    .tube(58, 16, 58, 156, 8).tube(182, 16, 182, 156, 8)
    .tube(58, 18, 182, 18, 8)
    .tube(38, 156, 202, 156, 8)
    .path([[58, 30], [40, 30], [34, 40]], 6, C.steel).path([[182, 30], [200, 30], [206, 40]], 6, C.steel)
    .tube(58, 88, 88, 88, 6).tube(182, 88, 152, 88, 6)
    .tube(120, 156, 120, 116, 7);
  const step = (x, y) => `<rect x="${x}" y="${y}" width="22" height="7" rx="2" fill="url(#iron)" stroke="${C.line}" stroke-width="1.4"/>`;
  return [
    shadow(120, 96),
    stack(104, 26, 32, 78, 8),
    f.render(),
    grip(34, 40, 30, 50, 5.5), grip(206, 40, 210, 50, 5.5),
    grip(74, 88, 90, 88, 5.5), grip(150, 88, 166, 88, 5.5),
    pad(90, 106, 60, 14, { r: 6 }),
    step(62, 124), step(156, 124), step(62, 142), step(156, 142),
    foot(38, 157), foot(202, 157),
  ];
};

ART.pullupbar = () => {
  const f = new Frame()
    .tube(62, 30, 62, 156, 9).tube(178, 30, 178, 156, 9)
    .tube(40, 156, 84, 156, 8).tube(156, 156, 200, 156, 8)
    .tube(62, 112, 84, 156, 5).tube(178, 112, 156, 156, 5)
    .path([[30, 46], [42, 32], [198, 32], [210, 46]], 7, C.steel);
  let knurl = '';
  for (let x = 96; x < 146; x += 3) knurl += `<path d="M${x},29.5 l1.6,5" stroke="${C.steelDark}" stroke-width=".8"/>`;
  return [
    shadow(120, 92),
    f.render(), knurl,
    grip(30, 46, 38, 36, 6), grip(202, 36, 210, 46, 6),
    grip(70, 32, 86, 32, 6), grip(154, 32, 170, 32, 6),
    foot(40, 157), foot(84, 157), foot(156, 157), foot(200, 157),
  ];
};

ART.chestpress = () => {
  const f = new Frame()
    .tube(30, 154, 214, 154, 8)
    .tube(136, 154, 136, 122, 8)
    .tube(158, 116, 162, 34, 7)
    .path([[164, 30], [118, 40], [96, 72]], 7, C.steel)
    .tube(184, 154, 184, 30, 7).tube(214, 154, 214, 30, 7).tube(162, 30, 214, 30, 7);
  return [
    shadow(122, 100),
    stack(187, 38, 24, 114, 9),
    f.render(),
    `<circle cx="162" cy="32" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="162" cy="32" r="2" fill="${C.orange}"/>`,
    grip(96, 64, 96, 86, 6),
    pad(112, 112, 52, 13, { r: 6 }),
    pad(150, 46, 15, 66, { r: 7 }),
    `<rect x="104" y="146" width="22" height="6" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.2"/>`,
    foot(30, 155), foot(214, 155),
  ];
};

ART.pecdeck = () => {
  const f = new Frame()
    .tube(46, 154, 194, 154, 8)
    .tube(120, 154, 120, 126, 9)
    .tube(106, 30, 106, 124, 7).tube(134, 30, 134, 124, 7)
    .path([[106, 32], [72, 34], [66, 50]], 6, C.steel)
    .path([[134, 32], [168, 34], [174, 50]], 6, C.steel);
  return [
    shadow(120, 84),
    `<rect x="102" y="8" width="36" height="26" rx="3" fill="#20252c" stroke="${C.line}" stroke-width="1.4"/>`,
    ...[0, 1].map((i) => `<rect x="105" y="${16 + i * 7}" width="30" height="6" rx="1.2" fill="url(#iron)" stroke="${C.ironDark}" stroke-width=".8"/>`),
    f.render(),
    `<circle cx="106" cy="32" r="5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="134" cy="32" r="5" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`,
    pad(96, 40, 48, 82, { r: 9 }),
    pad(88, 118, 64, 14, { r: 6 }),
    pad(56, 50, 18, 58, { r: 8 }),
    pad(166, 50, 18, 58, { r: 8 }),
    grip(78, 98, 78, 110, 5), grip(162, 98, 162, 110, 5),
    foot(46, 155), foot(194, 155),
  ];
};

ART.shoulderpress = () => {
  const f = new Frame()
    .tube(30, 154, 214, 154, 8)
    .tube(130, 154, 130, 126, 8)
    .tube(150, 118, 154, 40, 7)
    .path([[176, 92], [152, 46], [118, 34]], 7, C.steel)
    .tube(184, 154, 184, 34, 7).tube(214, 154, 214, 34, 7).tube(184, 34, 214, 34, 7)
    .tube(176, 92, 184, 92, 6);
  return [
    shadow(122, 100),
    stack(187, 42, 24, 110, 9),
    f.render(),
    `<circle cx="176" cy="92" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="176" cy="92" r="2" fill="${C.orange}"/>`,
    grip(116, 22, 116, 42, 6),
    pad(104, 116, 52, 13, { r: 6 }),
    pad(142, 48, 15, 68, { r: 7 }),
    `<rect x="96" y="146" width="22" height="6" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.2"/>`,
    foot(30, 155), foot(214, 155),
  ];
};

ART.crossover = () => {
  const f = new Frame()
    .tube(20, 14, 20, 156, 7).tube(52, 14, 52, 156, 7)
    .tube(188, 14, 188, 156, 7).tube(220, 14, 220, 156, 7)
    .tube(20, 14, 220, 14, 7)
    .tube(14, 156, 226, 156, 8)
    .tube(52, 26, 188, 26, 5);
  return [
    shadow(120, 106),
    stack(23, 84, 26, 70, 7), stack(191, 84, 26, 70, 7),
    f.render(),
    grip(100, 26, 140, 26, 5),
    pulley(58, 44, 6), pulley(182, 44, 6),
    cable('M58,50 L100,96 M182,50 L140,96'),
    `<path d="M100,96 l-6,6 l12,0 z" fill="none" stroke="${C.line}" stroke-width="4.4" stroke-linejoin="round"/><path d="M100,96 l-6,6 l12,0 z" fill="none" stroke="${C.steel}" stroke-width="2.2" stroke-linejoin="round"/>`,
    `<path d="M140,96 l-6,6 l12,0 z" fill="none" stroke="${C.line}" stroke-width="4.4" stroke-linejoin="round"/><path d="M140,96 l-6,6 l12,0 z" fill="none" stroke="${C.steel}" stroke-width="2.2" stroke-linejoin="round"/>`,
    grip(93, 104, 107, 104, 5), grip(133, 104, 147, 104, 5),
    foot(14, 157), foot(226, 157),
  ];
};

ART.dips = () => {
  // Изометрия: две параллельные жерди уходят вглубь, стойки — к полу
  const d = [0.86, -0.5];
  const e = [0.86, 0.5];
  const H = 56;
  const L = 112;
  const W = 48;
  const o = [42, 84];
  const P = (l, w, h = 0) => [r1(o[0] + d[0] * l + e[0] * w), r1(o[1] + d[1] * l + e[1] * w + h)];
  const back = new Frame()
    .tube(...P(0, 0), ...P(L, 0), 7, C.steelDark)
    .tube(...P(16, 0), ...P(16, 0, H), 7, C.steelDark).tube(...P(L - 16, 0), ...P(L - 16, 0, H), 7, C.steelDark)
    .tube(...P(16, -6, H), ...P(16, W + 6, H), 7, C.steelDark).tube(...P(L - 16, -6, H), ...P(L - 16, W + 6, H), 7, C.steelDark);
  const front = new Frame()
    .tube(...P(0, W), ...P(L, W), 8)
    .tube(...P(16, W), ...P(16, W, H), 8).tube(...P(L - 16, W), ...P(L - 16, W, H), 8);
  return [
    shadow(124, 104, 9),
    back.render(),
    grip(...P(0, 0), ...P(20, 0), 6), grip(...P(L - 20, 0), ...P(L, 0), 6),
    front.render(),
    grip(...P(0, W), ...P(22, W), 7), grip(...P(L - 22, W), ...P(L, W), 7),
    foot(...P(16, W + 6, H), 12), foot(...P(L - 16, W + 6, H), 12), foot(...P(16, -6, H), 10), foot(...P(L - 16, -6, H), 10),
  ];
};

ART.preacher = () => {
  const f = new Frame()
    .tube(26, 154, 196, 154, 8)
    .tube(54, 154, 54, 124, 8)
    .tube(130, 154, 124, 84, 8)
    .tube(124, 84, 150, 62, 6);
  return [
    shadow(112, 92),
    f.render(),
    pad(28, 114, 52, 13, { r: 6 }),
    pad(84, 74, 64, 18, { angle: -38, cx: 116, cy: 83, r: 7 }),
    plate(156, 56, 24),
    `<path d="M150,62 l4,-8" stroke="${C.line}" stroke-width="5" stroke-linecap="round"/><path d="M150,62 l4,-8" stroke="${C.orange}" stroke-width="2.6" stroke-linecap="round"/>`,
    foot(26, 155), foot(196, 155),
  ];
};

ART.captain = () => {
  const f = new Frame()
    .tube(150, 18, 150, 156, 9)
    .tube(186, 156, 186, 18, 7).tube(150, 20, 186, 20, 7)
    .tube(40, 156, 210, 156, 8)
    .tube(150, 64, 102, 64, 7)
    .tube(150, 118, 110, 156, 6)
    .path([[150, 30], [118, 30], [108, 38]], 6, C.steel);
  return [
    shadow(124, 96),
    f.render(),
    grip(104, 40, 100, 50, 5.5),
    pad(140, 70, 16, 64, { r: 7 }),
    pad(104, 54, 48, 13, { r: 6 }),
    grip(102, 66, 102, 82, 6),
    `<rect x="128" y="132" width="20" height="7" rx="2" fill="url(#iron)" stroke="${C.line}" stroke-width="1.4"/>`,
    foot(40, 157), foot(210, 157),
  ];
};

ART.treadmill = () => {
  const f = new Frame()
    .path([[60, 126], [48, 56]], 7, C.steel)
    .path([[48, 72], [118, 80]], 6, C.steel);
  let ribs = '';
  for (let x = 84; x < 200; x += 8) ribs += `<path d="M${x},128.5 v3" stroke="#fff" stroke-width="1" opacity=".12"/>`;
  return [
    shadow(124, 100),
    `<rect x="44" y="124" width="170" height="20" rx="8" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.6"/>`,
    `<rect x="70" y="126" width="140" height="8" rx="4" fill="${C.rubber}" stroke="${C.line}" stroke-width="1"/>`, ribs,
    `<rect x="70" y="138" width="138" height="3" rx="1.5" fill="${C.pad}" opacity=".85"/>`,
    `<path d="M30,144 L30,118 Q30,108 42,108 L84,108 Q92,108 92,118 L92,144 Z" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/>`,
    `<path d="M38,114 h44" stroke="#fff" stroke-width="1.2" opacity=".2"/>`,
    f.render(),
    grip(84, 79, 118, 82, 5),
    screenBox(22, 34, 48, 28, -16),
    `<circle cx="206" cy="134" r="7" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`,
    foot(40, 153, 16), foot(206, 153, 16),
  ];
};

ART.bike = () => {
  const f = new Frame()
    .tube(48, 154, 96, 154, 8).tube(150, 154, 200, 154, 8)
    .tube(72, 154, 84, 126, 7).tube(176, 154, 160, 120, 7)
    .path([[118, 124], [150, 120], [158, 72]], 8, C.steel)
    .path([[84, 100], [80, 52]], 7, C.steel)
    .path([[80, 52], [100, 46], [112, 54]], 6, C.steel);
  return [
    shadow(122, 96),
    `<path d="M62,134 Q54,92 92,86 Q128,82 132,112 Q134,138 104,144 L70,144 Q62,142 62,134 Z" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/>`,
    `<circle cx="96" cy="116" r="17" fill="none" stroke="${C.ironLight}" stroke-width="1.4" opacity=".7"/><path d="M76,112 q4,-18 22,-20" fill="none" stroke="#fff" stroke-width="1.4" opacity=".2"/>`,
    `<path d="M70,104 q10,-12 30,-12" fill="none" stroke="${C.pad}" stroke-width="2.4" stroke-linecap="round"/>`,
    f.render(),
    `<path d="M140,66 Q158,58 176,66 Q176,74 158,74 Q146,74 140,66 Z" fill="${C.rubber}" stroke="${C.line}" stroke-width="1.6"/><path d="M146,66 q12,-4 24,0" stroke="${C.pad}" stroke-width="1.6" fill="none"/>`,
    grip(108, 54, 116, 64, 5.5),
    screenBox(66, 28, 34, 20, -10),
    `<circle cx="118" cy="124" r="7" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/>`,
    `<path d="M118,124 L128,140" stroke="${C.line}" stroke-width="6" stroke-linecap="round"/><path d="M118,124 L128,140" stroke="${C.steel}" stroke-width="3.5" stroke-linecap="round"/>`,
    `<rect x="122" y="139" width="16" height="5" rx="2" fill="${C.rubber}" stroke="${C.line}" stroke-width="1"/>`,
    foot(48, 155), foot(96, 155), foot(150, 155), foot(200, 155),
  ];
};

ART.elliptical = () => {
  const f = new Frame()
    .tube(28, 154, 214, 154, 8)
    .tube(186, 154, 178, 90, 8)
    .path([[178, 92], [150, 30], [140, 26]], 6, C.steel)
    .path([[172, 96], [96, 130], [60, 136]], 6, C.steel)
    .tube(184, 118, 186, 154, 6)
    .tube(186, 96, 196, 54, 6);
  return [
    shadow(120, 104),
    `<path d="M166,148 Q160,112 190,104 Q216,100 220,126 Q222,148 200,150 Z" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/>`,
    `<circle cx="192" cy="128" r="12" fill="none" stroke="${C.ironLight}" stroke-width="1.4" opacity=".7"/>`,
    f.render(),
    `<rect x="40" y="132" width="40" height="9" rx="3" fill="url(#pad)" stroke="${C.padLine}" stroke-width="1.6"/>`,
    `<g transform="rotate(-8 106 128)"><rect x="86" y="124" width="40" height="9" rx="3" fill="url(#pad)" stroke="${C.padLine}" stroke-width="1.6"/></g>`,
    grip(140, 26, 134, 42, 6),
    screenBox(186, 34, 30, 20, 12),
    `<circle cx="178" cy="92" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.4"/><circle cx="178" cy="92" r="2" fill="${C.orange}"/>`,
    foot(28, 155), foot(214, 155),
  ];
};

ART.rower = () => {
  const f = new Frame()
    .tube(66, 134, 222, 126, 8)
    .tube(222, 126, 222, 154, 7).tube(210, 154, 230, 154, 7)
    .tube(70, 136, 76, 154, 7).tube(60, 154, 92, 154, 7)
    .path([[44, 92], [56, 66], [72, 54]], 5, C.steel);
  let vents = '';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    vents += `<path d="M${r1(42 + Math.cos(a) * 8)},${r1(112 + Math.sin(a) * 8)} L${r1(42 + Math.cos(a + 0.5) * 22)},${r1(112 + Math.sin(a + 0.5) * 22)}" stroke="${C.ironLight}" stroke-width="2" stroke-linecap="round"/>`;
  }
  return [
    shadow(124, 106),
    f.render(),
    `<circle cx="42" cy="112" r="30" fill="url(#plate)" stroke="${C.line}" stroke-width="1.8"/>`, vents,
    `<circle cx="42" cy="112" r="6" fill="url(#steelBox)" stroke="${C.line}" stroke-width="1.2"/>`,
    `<circle cx="42" cy="112" r="24" fill="none" stroke="${C.pad}" stroke-width="2" opacity=".85"/>`,
    cable('M70,106 L112,104'),
    grip(112, 96, 112, 112, 6),
    `<g transform="rotate(-24 92 118)"><rect x="84" y="102" width="12" height="32" rx="3" fill="url(#iron)" stroke="${C.line}" stroke-width="1.6"/><rect x="82" y="112" width="16" height="4" rx="2" fill="${C.pad}"/></g>`,
    pad(150, 116, 34, 12, { r: 5 }),
    `<rect x="156" y="128" width="22" height="5" rx="2" fill="${C.steelDark}" stroke="${C.line}" stroke-width="1"/>`,
    screenBox(64, 40, 30, 20, 10),
    foot(60, 155), foot(92, 155), foot(210, 155), foot(230, 155),
  ];
};

const IDS = Object.keys(ART);
mkdirSync(OUT_DIR, { recursive: true });
for (const id of IDS) {
  const body = ART[id]().join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180" width="240" height="180">${DEFS}\n${body}\n</svg>\n`;
  writeFileSync(join(OUT_DIR, `${id}.svg`), svg);
}
console.log(`${IDS.length} illustrations → ${OUT_DIR}`);
