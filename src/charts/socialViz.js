import { kmb, num, pct } from '../lib/format.js';
import { esc } from '../ui/dom.js';
import { tableFallback } from './index.js';

/* ============================================================
   TWO CHART SHAPES THE LIBRARY DID NOT HAVE

   Everything else on the Overview reuses lineChart, barsH and
   splitBar. Only these two are new, and they are kept small and
   dependency-free for the same reason as the rest: one visual
   language, no second charting stack.
   ============================================================ */

/* A ring with the count in the middle. Falls back to a table like the
   other charts do, so the numbers survive when the shape does not. */
export function donutChart(mount, parts, opt) {
  opt = opt || {};
  const live = parts.filter((p) => p.value > 0);
  const total = live.reduce((a, p) => a + p.value, 0);
  const wrap = document.createElement('div');
  wrap.className = 'viz';

  if (!total) {
    wrap.innerHTML = '<div class="empty" style="padding:18px">Nothing to show yet.</div>';
    mount.appendChild(wrap);
    return wrap;
  }

  const R = 45, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = live.map((p) => {
    const len = (p.value / total) * C;
    const seg = `<circle cx="59" cy="59" r="${R}" fill="none" stroke="${p.color}" stroke-width="17"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 59 59)"><title>${esc(p.label)}: ${num(p.value)}</title></circle>`;
    offset += len;
    return seg;
  }).join('');

  wrap.innerHTML = `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <svg viewBox="0 0 118 118" style="width:118px;height:118px;flex:0 0 118px" role="img"
         aria-label="${esc(opt.aria || 'breakdown')}">
      <circle cx="59" cy="59" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="17"></circle>
      ${arcs}
      <text x="59" y="55" text-anchor="middle" style="font:500 21px 'Roboto Mono',monospace;fill:var(--text)">${kmb(total)}</text>
      <text x="59" y="70" text-anchor="middle" style="font:400 9px 'Roboto Mono',monospace;fill:var(--text-3)">${esc(opt.centreLabel || 'TOTAL')}</text>
    </svg>
    <div style="flex:1;min-width:150px;display:flex;flex-direction:column;gap:7px">
      ${parts.map((p) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;${p.value ? '' : 'opacity:.5'}">
        <span style="display:flex;align-items:center;gap:7px;min-width:0">
          <i style="width:8px;height:8px;border-radius:2px;background:${p.value ? p.color : 'var(--surface-3)'};flex:0 0 8px"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.label)}</span>
        </span>
        <span style="font-variant-numeric:tabular-nums;color:var(--text-2);white-space:nowrap">${p.value ? num(p.value) + ' · ' + pct(p.value / total, 1) : '—'}</span>
      </div>`).join('')}
    </div>
  </div>`;

  wrap.appendChild(tableFallback([opt.labelHead || 'Segment', 'Count', 'Share'],
    live.map((p) => [p.label, num(p.value), pct(p.value / total)])));
  mount.appendChild(wrap);
  return wrap;
}

/* Vertical columns, for a distribution where the buckets have a
   natural order that a horizontal list would obscure. */
export function columnChart(mount, rows, opt) {
  opt = opt || {};
  const H = 190, padL = 34, padB = 34, padT = 18;
  const W = 340;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const innerH = H - padT - padB;
  const bw = Math.max(10, (W - padL - 10) / rows.length - 14);
  const step = (W - padL - 10) / rows.length;

  const bars = rows.map((r, i) => {
    const h = (r.value / max) * innerH;
    const x = padL + i * step + (step - bw) / 2;
    const y = padT + innerH - h;
    return `<rect x="${x.toFixed(1)}" y="${(r.value ? y : padT + innerH - 2).toFixed(1)}" width="${bw.toFixed(1)}"
       height="${(r.value ? Math.max(h, 2) : 2).toFixed(1)}" rx="2"
       fill="${r.value ? (r.color || 'var(--s1)') : 'var(--surface-3)'}"><title>${esc(r.label)}: ${num(r.value)}</title></rect>
      <text x="${(x + bw / 2).toFixed(1)}" y="${(r.value ? y - 5 : padT + innerH - 7).toFixed(1)}" text-anchor="middle"
        style="font:500 10px 'Roboto Mono',monospace;fill:${r.value ? 'var(--text-2)' : 'var(--text-3)'}">${r.value}</text>
      <text x="${(x + bw / 2).toFixed(1)}" y="${H - 14}" text-anchor="middle"
        style="font:400 10px 'Roboto Mono',monospace;fill:var(--text-3)">${esc(r.label)}</text>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'viz';
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(opt.aria || 'distribution')}">
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - 4}" y2="${padT + innerH}" stroke="var(--axis)"></line>
    <line x1="${padL}" y1="${padT}" x2="${W - 4}" y2="${padT}" stroke="var(--grid)"></line>
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" style="font:400 10px 'Roboto Mono',monospace;fill:var(--text-3)">${max}</text>
    <text x="${padL - 6}" y="${padT + innerH + 4}" text-anchor="end" style="font:400 10px 'Roboto Mono',monospace;fill:var(--text-3)">0</text>
    ${bars}
  </svg>${opt.foot ? `<div style="font:400 11px/1.4 'Roboto Mono',monospace;color:var(--warning);margin-top:2px">${esc(opt.foot)}</div>` : ''}`;
  wrap.appendChild(tableFallback([opt.labelHead || 'Bucket', 'Posts'], rows.map((r) => [r.label, num(r.value)])));
  mount.appendChild(wrap);
  return wrap;
}
