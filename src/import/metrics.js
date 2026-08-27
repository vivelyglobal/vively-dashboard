import { iso } from '../lib/dates.js';
import { parseCsvText } from '../lib/csv.js';
import { num } from '../lib/format.js';
import { readXlsx } from '../lib/xlsx.js';
import { byCreator, SERVER, serverSave, notify } from '../model/db.js';
import { partsOf } from '../model/stats.js';
import { $, $$, esc } from '../ui/dom.js';
import { toast, openDrawer, closeDrawer } from '../ui/overlay.js';
import { statCard } from '../ui/html.js';
import { normHeader, handleFromUrl } from './excel.js';
import { notionVisitValue, notionMetricValue, applyNotionContent } from './notion.js';

/* ============================================================
   METRICS FROM A SPREADSHEET
   The other way performance numbers arrive: a sheet of post
   metrics exported or collected by hand. Matches each row to a
   creator already on this campaign's roster and updates the same
   fields a Notion sync would, so both routes agree.
   ============================================================ */
export const METRIC_COL_ALIASES = {
  handle:   ['profile handle', 'handle', 'profile', 'username', 'instagram', 'creator', 'account'],
  url:      ['post url', 'url', 'link', 'post link', 'content link', 'reel', 'permalink'],
  views:    ['views plays', 'views', 'plays', 'view count', 'play count', '조회수'],
  likes:    ['likes', 'like count', '좋아요'],
  comments: ['comments', 'comment count', '댓글'],
  shares:   ['reposts shares', 'shares', 'reposts', 'repost', 'share count', '공유'],
  date:     ['date posted', 'posted date', 'date', 'collected on']
};

export function guessMetricColumn(header) {
  const h = normHeader(header);
  if (!h) return null;
  for (const [key, aliases] of Object.entries(METRIC_COL_ALIASES)) {
    if (aliases.some((a) => h === a)) return key;
  }
  for (const [key, aliases] of Object.entries(METRIC_COL_ALIASES)) {
    if (aliases.some((a) => h.includes(a))) return key;
  }
  return null;
}

/* pull "@name" out of a handle cell or an instagram profile/post URL */
export function handleFromCell(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^@?[\w.]{2,40}$/.test(s)) return '@' + s.replace(/^@/, '').toLowerCase();
  const id = handleFromUrl(s, 'Instagram');
  return id ? id.handle.toLowerCase() : null;
}

export let metricsImport = null;

export function openMetricsImport(cp) {
  metricsImport = { cp, rows: [], matched: [], unmatched: [] };
  openDrawer('Update metrics from a sheet — ' + esc(cp.brand), `
    <div class="note" style="margin-bottom:16px;">
      A sheet with one row per post. Columns are matched by name, so a header row like
      <strong>Profile (handle) · Post URL · Views · Likes · Comments · Reposts (shares) · Date Posted</strong>
      works as-is. Rows are matched to this campaign's roster by handle, or by the post URL if
      it's already recorded.
    </div>
    <div class="dz" id="mxDrop">
      <div><strong>Click or drop an .xlsx / .csv file</strong></div>
      <div style="margin-top:4px;font-size:12px;color:var(--text-3)">e.g. "instagram_post_metrics.xlsx"</div>
      <input type="file" id="mxFile" accept=".xlsx,.csv" style="display:none"/>
    </div>
    <div id="mxResult" style="margin-top:18px"></div>`, true);

  const dz = $('#mxDrop'), input = $('#mxFile');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) loadMetricsFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) loadMetricsFile(input.files[0]); });
}

export async function loadMetricsFile(file) {
  const res = $('#mxResult');
  res.innerHTML = `<div class="empty">Reading ${esc(file.name)}…</div>`;
  try {
    let sheetRows;
    if (/\.csv$/i.test(file.name)) sheetRows = parseCsvText(await file.text());
    else {
      const wb = await readXlsx(file);
      const sheets = wb.sheets.filter((sh) => sh.rows.length > 1);
      if (!sheets.length) throw new Error('No rows found in that workbook.');
      /* the metrics sheet is the one with the most rows — not the notes tab */
      sheetRows = sheets.reduce((best, sh) => (sh.rows.length > best.rows.length ? sh : best)).rows;
    }
    parseMetricsRows(sheetRows, file.name);
  } catch (err) {
    res.innerHTML = `<div class="note warn"><strong>Could not read that file.</strong> ${esc(err.message)}</div>`;
  }
}

export function parseMetricsRows(rows, fileName) {
  const st = metricsImport, cp = st.cp;
  const headers = rows[0] || [];
  const col = {};
  headers.forEach((h, i) => { const k = guessMetricColumn(h); if (k && col[k] == null) col[k] = i; });
  if (col.handle == null && col.url == null) {
    $('#mxResult').innerHTML = `<div class="note warn"><strong>No creator column found.</strong>
      The sheet needs a handle column (or a post URL to read the handle from). Headers seen:
      ${esc(headers.filter(Boolean).join(', '))}</div>`;
    return;
  }

  const ps = partsOf(cp.id);
  st.matched = []; st.unmatched = [];
  rows.slice(1).forEach((row, i) => {
    if (!row || row.every((c) => c == null || c === '')) return;
    const handle = handleFromCell(col.handle != null ? row[col.handle] : null)
                || handleFromCell(col.url != null ? row[col.url] : null);
    const url = col.url != null && row[col.url] ? String(row[col.url]).trim() : '';
    /* a totals row has no creator and no post — skip it silently */
    if (!handle && !url) return;

    const metrics = {};
    ['views', 'likes', 'comments', 'shares'].forEach((k) => {
      if (col[k] == null) return;
      const n = notionMetricValue(row[col[k]]);   /* "Hidden" / blank -> null, left alone */
      if (n != null) metrics[k] = n;
    });
    const rawDate = col.date != null ? row[col.date] : null;
    const at = rawDate ? notionVisitValue(rawDate instanceof Date ? iso(rawDate) : rawDate) : '';

    /* match within this campaign only: by handle, else by a post URL already recorded */
    let p = null;
    if (handle) p = ps.find((x) => { const cr = byCreator[x.creatorId]; return cr && cr.handle.toLowerCase() === handle; });
    if (!p && url) p = ps.find((x) => x.content && x.content.url && x.content.url.split('?')[0] === url.split('?')[0]);

    const entry = { rowNo: i + 2, handle: handle || '(from URL)', url, metrics, at, p };
    if (p) st.matched.push(entry); else st.unmatched.push(entry);
  });

  /* A creator usually has more than one post in a campaign, and the roster
     holds one set of numbers per creator — so posts are added together
     rather than the last row read quietly replacing the ones before it.
     The link kept is the best-performing post; the date is the most recent. */
  const byPart = new Map();
  st.matched.forEach((m) => {
    const key = m.p.id;
    const acc = byPart.get(key);
    if (!acc) { byPart.set(key, { p: m.p, posts: 1, metrics: Object.assign({}, m.metrics), url: m.url, at: m.at, topViews: m.metrics.views || 0 }); return; }
    acc.posts++;
    Object.entries(m.metrics).forEach(([k, v]) => { acc.metrics[k] = (acc.metrics[k] || 0) + v; });
    if ((m.metrics.views || 0) > acc.topViews) { acc.topViews = m.metrics.views || 0; acc.url = m.url || acc.url; }
    if (m.at && (!acc.at || m.at > acc.at)) acc.at = m.at;
  });
  st.rowsRead = st.matched.length + st.unmatched.length;
  st.matched = Array.from(byPart.values());

  renderMetricsPreview(fileName);
}

export function renderMetricsPreview(fileName) {
  const st = metricsImport;
  const total = st.rowsRead;
  const multi = st.matched.filter((m) => m.posts > 1).length;
  $('#mxResult').innerHTML = `
    <div class="grid g4" style="gap:10px;margin-bottom:16px">
      ${statCard('Rows read', total, { foot: esc(fileName) })}
      ${statCard('Creators matched', st.matched.length, { foot: st.unmatched.length ? st.unmatched.length + ' rows unmatched' : 'all rows matched' })}
      ${multi ? statCard('Multi-post creators', multi, { foot: 'posts added together' }) : ''}
    </div>
    ${st.unmatched.length ? `<div class="note warn" style="margin-bottom:12px">
      <strong>${st.unmatched.length} row${st.unmatched.length === 1 ? '' : 's'} not on this campaign's roster</strong> — skipped.
      ${esc(st.unmatched.slice(0, 12).map((u) => u.handle).join(', '))}${st.unmatched.length > 12 ? '…' : ''}
      <div style="margin-top:6px">These usually belong to a different campaign.</div>
    </div>` : ''}
    <div class="tbl-wrap" style="max-height:320px;overflow-y:auto"><table class="tbl">
      <thead><tr><th>Creator</th><th class="num">Posts</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th><th>As of</th></tr></thead>
      <tbody>${st.matched.slice(0, 200).map((m) => {
        const cr = byCreator[m.p.creatorId];
        return `<tr><td class="strong">${esc(cr.handle)}</td>
          <td class="num">${m.posts}</td>
          <td class="num">${m.metrics.views != null ? num(m.metrics.views) : '—'}</td>
          <td class="num">${m.metrics.likes != null ? num(m.metrics.likes) : '—'}</td>
          <td class="num">${m.metrics.comments != null ? num(m.metrics.comments) : '—'}</td>
          <td class="num">${m.metrics.shares != null ? num(m.metrics.shares) : '—'}</td>
          <td style="color:var(--text-3)">${esc(m.at || 'today')}</td></tr>`;
      }).join('')}</tbody></table></div>
    <div class="divider"></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary" id="mxGo" ${st.matched.length ? '' : 'disabled'}>Update ${st.matched.length} creator${st.matched.length === 1 ? '' : 's'}</button>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
    </div>`;
  if (st.matched.length) $('#mxGo').addEventListener('click', commitMetricsImport);
}

export function commitMetricsImport() {
  const st = metricsImport, cp = st.cp;
  let updated = 0;
  st.matched.forEach((m) => {
    const cr = byCreator[m.p.creatorId];
    /* same shape a Notion sync produces, so both routes write identically */
    const ap = { contentUrl: m.url, metrics: m.metrics, metricsAt: m.at, platform: cr.platform };
    if (applyNotionContent(m.p, ap, cr)) updated++;
  });
  closeDrawer();
  notify();
  const posts = st.matched.reduce((n, m) => n + m.posts, 0);
  const summary = `Updated ${updated} creator${updated === 1 ? '' : 's'} from ${posts} post${posts === 1 ? '' : 's'}` +
    (st.unmatched.length ? ` — ${st.unmatched.length} row${st.unmatched.length === 1 ? '' : 's'} skipped (not on this roster)` : '');
  toast(summary);
  serverSave({ force: true, silent: true }).then(() =>
    toast(SERVER.status === 'idle' ? summary + ' — saved' : summary + ' — click Save to store it on the server'));
}
