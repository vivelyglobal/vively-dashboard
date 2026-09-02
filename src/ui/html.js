import { DAY, TODAY } from '../lib/dates.js';
import { kmb } from '../lib/format.js';
import { DB } from '../model/db.js';
import { CAMPAIGN_STATUS, avColor, initials, stageOf } from '../model/vocab.js';
import { esc } from './dom.js';
import { toast } from './overlay.js';

export function avatarHtml(handle, big) {
  return `<div class="av${big ? ' lg' : ''}" style="background:${avColor(handle)}">${initials(handle)}</div>`;
}
export function whoHtml(cr, sub) {
  return `<div class="who">${avatarHtml(cr.handle)}<div style="min-width:0"><div class="h">${esc(cr.handle)}</div><div class="s">${esc(sub || (kmb(cr.followers) + ' · ' + cr.platform))}</div></div></div>`;
}
export function stagePill(stageId) {
  const s = stageOf(stageId);
  const cls = { sourced: 'grey', contacted: 'blue', replied: 'purple', shortlisted: 'yellow', confirmed: 'green',
                shipped: 'orange', submitted: 'purple', review: 'yellow', live: 'green', dropped: 'red' }[stageId];
  return `<span class="pill ${cls}"><i class="dot"></i>${s.label}</span>`;
}
export function statusPill(status) {
  const s = CAMPAIGN_STATUS[status];
  return `<span class="pill ${s.cls}"><i class="dot"></i>${s.label}</span>`;
}
export function tierPill(t) {
  const map = { nano: 'grey', micro: 'blue', mid: 'purple', macro: 'yellow' };
  return `<span class="pill ${map[t]}">${t[0].toUpperCase() + t.slice(1)}</span>`;
}
export const FLAGS = {
  preferred: { label: 'Preferred', cls: 'green',  icon: '★', desc: 'Push to the top of suggestions' },
  caution:   { label: 'Caution',   cls: 'yellow', icon: '!', desc: 'Still selectable, but flagged' },
  blocked:   { label: 'Blacklisted', cls: 'red',  icon: '⊘', desc: 'Hidden from suggestions and search' }
};
export function flagPill(flag) {
  const f = FLAGS[flag];
  return f ? `<span class="pill ${f.cls}">${f.icon} ${f.label}</span>` : '';
}

export function deltaHtml(v, invert) {
  if (v == null || !isFinite(v)) return '';
  const good = invert ? v < 0 : v > 0;
  const cls = Math.abs(v) < 0.002 ? 'flat' : (good ? 'up' : 'down');
  const arrow = Math.abs(v) < 0.002 ? '–' : (v > 0 ? '▲' : '▼');
  return `<span class="delta ${cls}">${arrow} ${Math.abs(v * 100).toFixed(1)}%</span>`;
}
export function statCard(label, value, opts) {
  opts = opts || {};
  return `<div class="card stat">
    <div class="label">${esc(label)}${opts.hint ? ` <span title="${esc(opts.hint)}" style="cursor:help;color:var(--text-3)">ⓘ</span>` : ''}</div>
    <div class="value">${value}</div>
    ${opts.delta != null ? deltaHtml(opts.delta, opts.invert) : ''}
    ${opts.foot ? `<div class="foot">${opts.foot}</div>` : ''}
    ${opts.spark ? opts.spark : ''}
  </div>`;
}
/* one consistent empty state, with the two ways to get data in */
export function emptyState(title, body, opts) {
  opts = opts || {};
  const acts = opts.actions !== false;
  return `<div class="card" style="max-width:640px;margin:6vh auto 0;text-align:center;padding:36px 28px">
    <div style="font-size:34px;line-height:1;margin-bottom:14px;opacity:.5">${opts.icon || '◫'}</div>
    <div style="font-size:17px;font-weight:400;margin-bottom:8px">${esc(title)}</div>
    <p style="font-size:13.5px;color:var(--text-3);line-height:1.65;margin:0 0 20px">${body}</p>
    ${acts ? `<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn primary sm" onclick="openImportWizard()">Import from Excel</button>
      <button class="btn sm" onclick="openNotionImportWizard()">Import from Notion</button>
      <button class="btn sm" onclick="openNewCampaign()">New campaign</button>
      <a class="btn sm" href="#/settings/templates">Get the templates</a>
    </div>` : ''}
  </div>`;
}
export const NO_DATA = () => !DB.campaigns.length && !DB.creators.length;

export function copyText(text, what) {
  navigator.clipboard.writeText(text).then(() => toast((what || 'Copied') + ' copied to clipboard'))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast((what || 'Copied') + ' copied'); } catch (e) { toast('Copy failed'); }
      ta.remove();
    });
}
export function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  toast('Downloaded ' + filename);
}
export function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(headers, rows) {
  return [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}
export function daysAgo(d) {
  if (!d) return '—';
  const n = Math.round((TODAY - new Date(d + 'T00:00:00Z')) / DAY);
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 0) return 'in ' + (-n) + 'd';
  if (n < 30) return n + 'd ago';
  if (n < 365) return Math.round(n / 30) + 'mo ago';
  return Math.round(n / 365) + 'y ago';
}
export function sortTable(rows, key, dir) {
  return rows.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * ((x || 0) - (y || 0));
  });
}
