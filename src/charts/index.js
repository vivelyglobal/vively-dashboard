import { $ } from '../ui/dom.js';
import { dLabel } from '../lib/dates.js';
import { num, kmb, pct } from '../lib/format.js';

/* ============================================================
   CHARTS — hand-rolled SVG. Rules from the dataviz skill:
   one axis only, thin marks, recessive grid, legend for >=2
   series, direct end-labels for <=4 series, hover crosshair +
   tooltip everywhere, and a table view behind every chart.
   ============================================================ */
export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)'];
/* both lists are CSS variables, so a theme switch repaints every chart
   without re-rendering anything */
export const SERIES_HEX    = SERIES_COLORS;

export function hexOf(series, i) { return series.color || SERIES_COLORS[i % 7]; }

/* fill the space that's actually left below the KPI row */
export function fitHeight(offset, min) {
  return Math.max(min || 200, Math.min(560, window.innerHeight - (offset || 400)));
}

export function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

export function el(tag, attrs, kids) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in (attrs || {})) n.setAttribute(k, attrs[k]);
  (kids || []).forEach((c) => n.appendChild(c));
  return n;
}

export function tableFallback(headers, rows) {
  const d = document.createElement('details');
  d.style.marginTop = '10px';
  const s = document.createElement('summary');
  s.textContent = 'View as table';
  s.style.cssText = 'font-size:12px;color:var(--text-3);cursor:pointer;list-style:none;';
  d.appendChild(s);
  const w = document.createElement('div');
  w.className = 'tbl-wrap';
  w.style.marginTop = '10px';
  w.innerHTML = `<table class="tbl"><thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  d.appendChild(w);
  return d;
}

/* ------------------------------ line chart ------------------------------ */
export function lineChart(mount, opt) {
  const { labels, series } = opt;
  const H = opt.height || 220, padL = opt.padL || 46, padR = opt.padR || (series.length <= 4 ? 56 : 12), padT = 12, padB = 26;
  const W = 900; // viewBox width; svg is width:100%
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const fmt = opt.format || kmb;

  const maxV = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(maxV, 4);
  const top = ticks[ticks.length - 1];
  const x = (i) => padL + (labels.length === 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
  const y = (v) => padT + innerH - (v / top) * innerH;

  const wrap = document.createElement('div');
  wrap.className = 'viz';
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': opt.title || 'line chart' });
  svg.style.height = H + 'px';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  ticks.forEach((t) => {
    svg.appendChild(el('line', { class: 'gridline', x1: padL, x2: padL + innerW, y1: y(t), y2: y(t) }));
    const tx = el('text', { class: 'tick', x: padL - 8, y: y(t) + 3.5, 'text-anchor': 'end' });
    tx.textContent = fmt(t);
    svg.appendChild(tx);
  });
  svg.appendChild(el('line', { class: 'axisline', x1: padL, x2: padL + innerW, y1: y(0), y2: y(0) }));

  const step = Math.max(1, Math.ceil(labels.length / 7));
  const last = labels.length - 1;
  labels.forEach((lb, i) => {
    if (i !== last && (i % step !== 0 || last - i < step * 0.7)) return;
    const tx = el('text', { class: 'tick', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : (i === labels.length - 1 ? 'end' : 'middle') });
    tx.textContent = opt.labelFormat ? opt.labelFormat(lb) : dLabel(lb);
    svg.appendChild(tx);
  });

  series.forEach((s, si) => {
    const color = s.color || SERIES_COLORS[si % 7];
    if (s.area) {
      const d = `M${x(0)},${y(0)} ` + s.values.map((v, i) => `L${x(i)},${y(v)}`).join(' ') + ` L${x(s.values.length - 1)},${y(0)} Z`;
      const g = el('path', { d, fill: hexOf(s, si), opacity: 0.12 });
      svg.appendChild(g);
    }
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
    svg.appendChild(el('path', { class: 'serieline', d, stroke: color }));
    if (series.length <= 4 && s.values.length) {
      const lastV = s.values[s.values.length - 1];
      const t = el('text', { class: 'dlabel', x: x(s.values.length - 1) + 8, y: y(lastV) + 4 });
      t.textContent = fmt(lastV);
      svg.appendChild(t);
    }
  });

  // hover layer
  const ch = el('line', { class: 'crosshair', y1: padT, y2: padT + innerH, x1: -99, x2: -99 });
  svg.appendChild(ch);
  const dots = series.map((s, si) => {
    const c = el('circle', { class: 'hoverdot', r: 4.5, fill: s.color || SERIES_COLORS[si % 7], cx: -99, cy: -99, opacity: 0 });
    svg.appendChild(c); return c;
  });
  const hit = el('rect', { class: 'hit', x: padL, y: padT, width: innerW, height: innerH });
  svg.appendChild(hit);

  wrap.appendChild(svg);
  const tip = document.createElement('div');
  tip.className = 'tip';
  wrap.appendChild(tip);

  function move(ev) {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    let i = Math.round((px - padL) / (innerW || 1) * (labels.length - 1));
    i = Math.max(0, Math.min(labels.length - 1, i));
    ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i));
    dots.forEach((c, si) => {
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(series[si].values[i])); c.setAttribute('opacity', 1);
    });
    tip.innerHTML = `<div class="t-h">${opt.labelFormat ? opt.labelFormat(labels[i]) : dLabel(labels[i])}</div>` +
      series.map((s, si) => `<div class="t-r"><span class="sw" style="background:${hexOf(s, si)}"></span><span>${s.name}</span><span class="n">${fmt(s.values[i])}</span></div>`).join('');
    tip.classList.add('on');
    const left = Math.min(r.width - 160, Math.max(0, (x(i) / W) * r.width - 70));
    tip.style.left = left + 'px';
    tip.style.top = '4px';
  }
  hit.addEventListener('mousemove', move);
  hit.addEventListener('mouseleave', () => {
    tip.classList.remove('on'); ch.setAttribute('x1', -99); ch.setAttribute('x2', -99);
    dots.forEach((c) => c.setAttribute('opacity', 0));
  });

  if (series.length >= 2) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    lg.innerHTML = series.map((s, si) => `<span class="li"><span class="sw" style="background:${hexOf(s, si)}"></span>${s.name}</span>`).join('');
    wrap.appendChild(lg);
  }
  wrap.appendChild(tableFallback(['Date', ...series.map((s) => s.name)],
    labels.map((lb, i) => [opt.labelFormat ? opt.labelFormat(lb) : dLabel(lb), ...series.map((s) => num(s.values[i]))])));

  mount.appendChild(wrap);
  return wrap;
}

/* --------------------------- horizontal bars --------------------------- */
export function barsH(mount, rows, opt) {
  opt = opt || {};
  const fmt = opt.format || kmb;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const wrap = document.createElement('div');
  wrap.className = 'viz';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:' + (opt.labelWidth || '150px') + ' 1fr auto;gap:12px;align-items:center;';
    row.innerHTML =
      `<div style="font-size:12.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${r.label}">${r.sub ? `<span style="color:var(--text)">${r.label}</span>` : r.label}</div>
       <div style="background:var(--surface-2);border-radius:4px;height:${opt.barH || 18}px;position:relative;">
         <div style="height:100%;width:${(r.value / max * 100).toFixed(2)}%;background:${r.color || 'var(--s1)'};border-radius:4px;min-width:2px;"></div>
       </div>
       <div style="font-size:12.5px;font-variant-numeric:tabular-nums;min-width:${opt.valueWidth || '58px'};text-align:right;">${fmt(r.value)}</div>`;
    row.title = `${r.label} — ${fmt(r.value)}${r.sub ? ' · ' + r.sub : ''}`;
    list.appendChild(row);
  });
  wrap.appendChild(list);
  wrap.appendChild(tableFallback([opt.labelHead || 'Item', opt.valueHead || 'Value'], rows.map((r) => [r.label, num(r.value)])));
  mount.appendChild(wrap);
  return wrap;
}

/* --------------------------- stacked split bar -------------------------- */
export function splitBar(mount, parts, opt) {
  opt = opt || {};
  parts = parts.filter((p) => p.value > 0);
  if (!parts.length) { mount.innerHTML = '<div class="empty" style="padding:18px">No data yet.</div>'; return; }
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const wrap = document.createElement('div');
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:2px;height:26px;border-radius:5px;overflow:hidden;';
  parts.forEach((p) => {
    const s = document.createElement('div');
    s.style.cssText = `flex:${p.value};background:${p.color};min-width:2px;`;
    s.title = `${p.label}: ${num(p.value)} (${pct(p.value / total)})`;
    bar.appendChild(s);
  });
  wrap.appendChild(bar);
  const lg = document.createElement('div');
  lg.className = 'legend';
  lg.innerHTML = parts.map((p) => `<span class="li"><span class="sw" style="background:${p.color}"></span>${p.label} <b style="color:var(--text);font-weight:500;margin-left:2px;">${pct(p.value / total, 0)}</b></span>`).join('');
  wrap.appendChild(lg);
  wrap.appendChild(tableFallback([opt.labelHead || 'Segment', 'Value', 'Share'], parts.map((p) => [p.label, num(p.value), pct(p.value / total)])));
  mount.appendChild(wrap);
  return wrap;
}

/* ------------------------------- sparkline ------------------------------ */
export function sparkSvg(values, color) {
  if (!values || values.length < 2) return '';
  const W = 160, H = 34, max = Math.max(...values), min = Math.min(...values);
  const rng = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1) * W).toFixed(1)},${(H - 3 - ((v - min) / rng) * (H - 8)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline fill="none" stroke="${color || 'var(--s1)'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/></svg>`;
}

/* -------------------------------- funnel -------------------------------- */
export function funnelView(mount, counts, total) {
  const max = Math.max(1, ...counts.map((c) => c.n));
  const wrap = document.createElement('div');
  wrap.className = 'funnel';
  counts.forEach((c, i) => {
    const prev = i ? counts[i - 1].n : c.n;
    const conv = prev ? c.n / prev : 0;
    const row = document.createElement('div');
    row.className = 'fn-row';
    row.innerHTML =
      `<div class="fl">${c.stage.label}</div>
       <div class="fn-track"><div class="fn-fill" style="width:${(c.n / max * 100).toFixed(1)}%;background:${c.stage.color};opacity:${0.55 + 0.05 * i};"></div></div>
       <div class="fv">${num(c.n)}${i ? `<em>${(conv * 100).toFixed(0)}%</em>` : ''}</div>`;
    row.title = `${c.stage.label}: ${c.n} — ${c.stage.desc}`;
    wrap.appendChild(row);
  });
  mount.appendChild(wrap);
  mount.appendChild(tableFallback(['Stage', 'Creators', 'Step conv.'],
    counts.map((c, i) => [c.stage.label, num(c.n), i ? pct(c.n / (counts[i - 1].n || 1), 0) : '—'])));
}
