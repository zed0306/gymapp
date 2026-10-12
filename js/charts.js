// Небольшие SVG-графики. Рисуются после вставки разметки, чтобы знать ширину.
import { fmt } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function niceTicks(min, max, count = 3) {
  const span = max - min || 1;
  const raw = span / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(2));
  return ticks;
}

// Столбик: скругление 4px сверху, плоский у базовой линии
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function attachTip(el, points, render) {
  const tip = el.querySelector('.tip');
  const svg = el.querySelector('svg');
  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const x = (evt.touches ? evt.touches[0].clientX : evt.clientX) - box.left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.x - x) < Math.abs(points[best].x - x)) best = i;
    });
    const p = points[best];
    tip.innerHTML = render(p);
    tip.style.left = `${p.x}px`;
    tip.style.top = `${p.y}px`;
    tip.classList.add('show');
    el.querySelectorAll('[data-i]').forEach((n) => n.classList.toggle('hl', +n.dataset.i === best));
  };
  const hide = () => tip.classList.remove('show');
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointermove', (e) => e.buttons || e.pointerType === 'mouse' ? show(e) : null);
  svg.addEventListener('pointerleave', hide);
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Вода за 7 дней: [{ label, full, value }], norm — линия нормы
export function waterChart(el, days, norm) {
  const W = el.clientWidth || 320;
  const H = 150;
  const pad = { t: 22, b: 22, l: 4, r: 4 };
  const max = Math.max(norm, ...days.map((d) => d.value)) * 1.08;
  const slot = (W - pad.l - pad.r) / days.length;
  const bw = Math.min(24, slot * 0.55);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Вода за 7 дней' });
  svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: H - pad.b, y2: H - pad.b, stroke: 'var(--line)', 'stroke-width': 1 }));
  const ny = y(norm);
  svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: ny, y2: ny, stroke: 'var(--text-2)', 'stroke-width': 1, opacity: 0.5 }));
  const nt = svgEl('text', { x: W - 2, y: ny - 5, 'text-anchor': 'end' });
  nt.textContent = `норма ${fmt(norm)}`;
  svg.appendChild(nt);
  const points = [];
  days.forEach((d, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const top = y(d.value);
    const h = H - pad.b - top;
    if (d.value > 0) {
      svg.appendChild(svgEl('path', {
        d: barPath(cx - bw / 2, top, bw, h),
        fill: 'var(--water)',
        opacity: d.today ? 1 : 0.55,
        'data-i': i,
      }));
    }
    const lbl = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle' });
    lbl.textContent = d.label;
    if (d.today) lbl.setAttribute('style', 'fill:var(--text);font-weight:800');
    svg.appendChild(lbl);
    if (d.today && d.value > 0) {
      const v = svgEl('text', { x: cx, y: top - 6, 'text-anchor': 'middle', style: 'fill:var(--text);font-weight:800' });
      v.textContent = fmt(d.value);
      svg.appendChild(v);
    }
    points.push({ x: cx, y: Math.min(top, ny) - 4, d });
  });
  el.innerHTML = '<div class="tip"></div>';
  el.prepend(svg);
  attachTip(el, points, (p) => `${p.d.full}: ${fmt(p.d.value)} мл`);
}

// Вес: [{ label, value }]
export function weightChart(el, pts) {
  const W = el.clientWidth || 320;
  const H = 170;
  const pad = { t: 18, b: 22, l: 34, r: 40 };
  const vals = pts.map((p) => p.value);
  const ticks = niceTicks(Math.min(...vals) - 0.5, Math.max(...vals) + 0.5, 3);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const x = (i) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : ((W - pad.l - pad.r) * i) / (pts.length - 1));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo || 1));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Динамика веса' });
  ticks.forEach((t) => {
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r + 30, y1: y(t), y2: y(t), stroke: 'var(--line)', 'stroke-width': 1 }));
    const tx = svgEl('text', { x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end' });
    tx.textContent = fmt(t, t % 1 ? 1 : 0);
    svg.appendChild(tx);
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  if (pts.length > 1) {
    svg.appendChild(svgEl('path', { d: `${line}L${x(pts.length - 1)},${H - pad.b}L${x(0)},${H - pad.b}Z`, fill: 'var(--accent-text)', opacity: 0.1 }));
    svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: 'var(--accent-text)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  const last = pts.length - 1;
  svg.appendChild(svgEl('circle', { cx: x(last), cy: y(pts[last].value), r: 5, fill: 'var(--accent-text)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  const end = svgEl('text', { x: x(last) + 10, y: y(pts[last].value) + 4, style: 'fill:var(--text);font-weight:800;font-size:12px' });
  end.textContent = fmt(pts[last].value, 1);
  svg.appendChild(end);
  [[0, 'start'], [last, 'end']].forEach(([i, anchor]) => {
    if (i === 0 && last === 0 && anchor === 'end') return;
    const t = svgEl('text', { x: x(i), y: H - 5, 'text-anchor': last === 0 ? 'middle' : anchor });
    t.textContent = pts[i].label;
    svg.appendChild(t);
  });
  el.innerHTML = '<div class="tip"></div>';
  el.prepend(svg);
  const points = pts.map((p, i) => ({ x: x(i), y: y(p.value) - 6, p }));
  attachTip(el, points, (q) => `${q.p.label}: ${fmt(q.p.value, 1)} кг`);
}
