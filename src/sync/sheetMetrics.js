import { findCreatorByHandle } from '../model/creators.js';
import { DB, platformPostIdOf } from '../model/db.js';

/* ============================================================
   SYNC — SHEET METRICS  (read-only)

   A second Google Sheet, and nothing like the first one.

   sync/sheets.js mirrors the whole workspace: it pushes every
   campaign, creator and roster row out, and pulling REPLACES all
   three collections with whatever the Sheet holds. That is the right
   shape for a shared copy of the workspace and entirely the wrong
   shape for this.

   This reads a Sheet somebody else fills in — content links arriving
   campaign-wise from Notion, performance numbers written by a paid
   scraper — and updates metrics on records that already exist. It
   never writes to a Sheet, never creates a creator, never touches
   campaign membership, and never replaces a collection. The two must
   not be confused, so they share no state, no storage key and no code.

   What it may change:
     socialContent  views, likes, comments, shares, saves, reach,
                    publishedAt, dataSource, lastScrapedAt
     creators       followers, er, avgViews, avgLikes, avgComments,
                    country and category ONLY when blank,
                    metricsSource, metricsSyncedAt

   Everything else is read.
   ============================================================ */

export const SHEET_METRICS_KEY = 'vively-sheet-metrics-v1';

/* Deliberately its own object and its own storage key — nothing here
   reads or writes SYNC in sync/sheets.js. */
export const SM = {
  base: '',                 /* the Sheet's published-to-web URL, or its id */
  erUnit: 'percent',        /* 'percent': 4.2 -> 4.2%   'decimal': 0.042 -> 4.2% */
  skipZero: true,           /* a zero from a scraper is usually "did not read" */
  contentTabs: [],          /* [{ name, gid, on }] — one or many, all feed one importer */
  creatorTab: { name: '', gid: '', on: true },
  contentMap: {},           /* field -> the Sheet's own column header */
  creatorMap: {},
  at: null, status: 'off', error: null, busy: false
};

export function loadSheetMetricsConfig() {
  try {
    const raw = localStorage.getItem(SHEET_METRICS_KEY);
    if (!raw) return;
    Object.assign(SM, JSON.parse(raw), { busy: false, error: null });
    if (SM.at) SM.at = new Date(SM.at);
    SM.status = SM.base ? 'idle' : 'off';
  } catch (e) { /* nothing saved yet */ }
}
export function saveSheetMetricsConfig() {
  try {
    localStorage.setItem(SHEET_METRICS_KEY, JSON.stringify({
      base: SM.base, erUnit: SM.erUnit, skipZero: SM.skipZero,
      contentTabs: SM.contentTabs, creatorTab: SM.creatorTab,
      contentMap: SM.contentMap, creatorMap: SM.creatorMap,
      at: SM.at ? SM.at.toISOString() : null
    }));
  } catch (e) { /* storage blocked */ }
}

/* ---- reading a sheet ------------------------------------------------

   lib/csv.js splits on newlines before it looks at quotes, so a caption
   containing a line break turns one row into two and every column after
   it lands in the wrong place. That parser is used by the Excel and
   metrics importers and is not this feature's to change, so this one
   scans character by character instead and quoted newlines survive. */
export function parseCsvLoose(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* Accepts the whole published URL, a /spreadsheets/d/<id>/ link, or a
   bare id, and builds the CSV endpoint for one tab. gid identifies the
   tab; a blank gid reads the first one. */
export function sheetCsvUrl(base, gid) {
  const raw = String(base || '').trim();
  if (!raw) return '';
  const m = raw.match(/\/spreadsheets\/d\/(?:e\/)?([\w-]+)/);
  const id = m ? m[1] : raw.replace(/^.*\//, '');
  if (!id) return '';
  const pub = /\/spreadsheets\/d\/e\//.test(raw);
  const stem = pub
    ? 'https://docs.google.com/spreadsheets/d/e/' + id + '/pub'
    : 'https://docs.google.com/spreadsheets/d/' + id + '/export';
  const q = pub ? '?output=csv' : '?format=csv';
  return stem + q + (gid ? '&gid=' + encodeURIComponent(gid) : '');
}

/* ---- column mapping -------------------------------------------------

   The mapping is stored as field -> the Sheet's own header text, so the
   Sheet can be renamed or reordered without this breaking. These aliases
   only seed the first guess; every one is editable in Setup. */
export const SM_CONTENT_ALIASES = {
  postUrl:   ['post url', 'url', 'link', 'post link', 'content link', 'permalink', 'reel', 'reel link'],
  postId:    ['post id', 'shortcode', 'media id', 'id'],
  handle:    ['handle', 'username', 'profile', 'creator', 'account', 'instagram'],
  views:     ['views', 'plays', 'view count', 'play count', 'video views', '조회수'],
  likes:     ['likes', 'like count', '좋아요'],
  comments:  ['comments', 'comment count', '댓글'],
  shares:    ['shares', 'reposts', 'share count', '공유'],
  saves:     ['saves', 'saved', 'bookmarks', '저장'],
  reach:     ['reach', 'accounts reached', 'unique views'],
  publishedAt: ['posted', 'posted date', 'post date', 'published', 'date posted', 'upload date'],
  scrapedAt: ['scraped', 'scraped at', 'last updated', 'updated', 'collected on', 'last synced'],
  campaign:  ['campaign', 'brand', 'project']
};

export const SM_CREATOR_ALIASES = {
  handle:      ['handle', 'username', 'profile', 'instagram', 'account', 'creator'],
  followers:   ['followers', 'follower count', 'follower', '팔로워'],
  er:          ['engagement rate', 'er', 'engagement', 'eng rate'],
  avgViews:    ['avg views', 'average views', 'mean views', 'avg plays'],
  avgLikes:    ['avg likes', 'average likes', 'mean likes'],
  avgComments: ['avg comments', 'average comments', 'mean comments'],
  country:     ['country', 'location', 'region'],
  category:    ['category', 'niche', 'vertical'],
  scrapedAt:   ['scraped', 'scraped at', 'last updated', 'updated', 'last synced']
};

export function guessSheetColumns(headers, aliases) {
  const out = {};
  const norm = (h) => String(h || '').trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');
  const taken = new Set();
  /* exact matches win before loose ones, so "views" does not claim the
     column called "avg views" simply by being read first */
  [true, false].forEach((exact) => {
    Object.entries(aliases).forEach(([field, list]) => {
      if (out[field]) return;
      const hit = headers.find((h) => {
        if (taken.has(h)) return false;
        const n = norm(h);
        return exact ? list.some((a) => n === a) : list.some((a) => n.includes(a));
      });
      if (hit) { out[field] = hit; taken.add(hit); }
    });
  });
  return out;
}

/* ---- values ---------------------------------------------------------- */

/* Blank means "the scraper had nothing", never "zero". A literal 0 is
   treated the same way unless the operator turns that off, because a
   scraper that failed writes 0 far more often than a post genuinely has
   none. Either way the stored figure survives. */
export function smMetric(v, skipZero) {
  if (v === '' || v == null) return null;
  const s = String(v).trim().replace(/[, ]/g, '').toLowerCase();
  if (!s || s === '-' || s === 'n/a' || s === 'null') return null;
  let m = s.match(/^([\d.]+)만$/); if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = s.match(/^([\d.]+)k$/);      if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = s.match(/^([\d.]+)m$/);      if (m) return Math.round(parseFloat(m[1]) * 1e6);
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  const r = Math.round(n);
  return (skipZero !== false && r === 0) ? null : r;
}

/* The dashboard stores er as a percent and prints it with a % sign, so
   a Sheet holding 0.042 has to be multiplied and one holding 4.2 must
   not be. The operator says which; nothing is guessed from the value. */
export function smEngagement(v, unit) {
  if (v === '' || v == null) return null;
  const s = String(v).trim().replace(/[%\s,]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  if (isNaN(n) || n === 0) return null;
  const pct = unit === 'decimal' ? n * 100 : n;
  if (pct < 0 || pct > 100) return null;          /* not an engagement rate */
  return Math.round(pct * 100) / 100;
}

/* Tolerant on purpose: a Sheet column can arrive as an ISO string, a
   Google serial number, an epoch in seconds or milliseconds, or whatever
   the scraper's locale produced. Anything unreadable returns null, and
   the caller then leaves the stored timestamp alone rather than losing
   the row over a date it did not need. */
export function smDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0');

  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    /* a Google Sheets serial: days since 1899-12-30 */
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      return isNaN(d) ? null : d.toISOString().slice(0, 10);
    }
    if (n > 1e12) { const d = new Date(n); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
    if (n > 1e9)  { const d = new Date(n * 1000); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
    return null;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

/* ---- matching -------------------------------------------------------

   Post id first, URL second. platformPostIdOf turns any Reel, /p/ or
   TikTok link into the same key, so the Sheet's spelling of a URL does
   not have to match the one already recorded. */
export function smContentIndex() {
  const byPostId = new Map(), byUrl = new Map();
  DB.socialContent.forEach((c) => {
    const pid = c.platformPostId || platformPostIdOf(c.postUrl || c.url);
    if (pid && !byPostId.has(pid)) byPostId.set(pid, c);
    const u = String(c.postUrl || c.url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (u && !byUrl.has(u)) byUrl.set(u, c);
  });
  return { byPostId, byUrl };
}

export function smFindContent(idx, row) {
  const explicit = String(row.postId || '').trim();
  if (explicit) {
    const key = /^(ig_|tt_)/.test(explicit) ? explicit : 'ig_' + explicit;
    if (idx.byPostId.has(key)) return { rec: idx.byPostId.get(key), by: 'post id' };
  }
  const url = String(row.postUrl || '').trim();
  if (url) {
    const pid = platformPostIdOf(url);
    if (pid && idx.byPostId.has(pid)) return { rec: idx.byPostId.get(pid), by: 'post id from URL' };
    const u = url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (idx.byUrl.has(u)) return { rec: idx.byUrl.get(u), by: 'URL' };
  }
  return { rec: null, by: null };
}

/* ---- planning -------------------------------------------------------

   Nothing is written here. A plan says exactly which record each row
   would touch and which fields would move, so the preview can show it
   and the operator can refuse it. Applying a plan is a separate step. */
export const SM_CONTENT_METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'reach'];

export function planSheetContent(rows, map, opts) {
  const o = opts || {};
  const idx = smContentIndex();
  const out = { updates: [], unmatched: [], skipped: [], rowsRead: 0, tab: o.tab || '' };
  const headerIdx = {};
  const header = rows[0] || [];
  Object.entries(map || {}).forEach(([field, col]) => {
    const i = header.findIndex((h) => String(h).trim() === String(col).trim());
    if (i >= 0) headerIdx[field] = i;
  });
  const cell = (r, f) => (headerIdx[f] == null ? '' : r[headerIdx[f]]);

  rows.slice(1).forEach((r, n) => {
    out.rowsRead++;
    const row = {
      postUrl: cell(r, 'postUrl'), postId: cell(r, 'postId'), handle: cell(r, 'handle'),
      campaign: cell(r, 'campaign')
    };
    if (!String(row.postUrl).trim() && !String(row.postId).trim()) {
      out.skipped.push({ rowNo: n + 2, why: 'no post URL or id' });
      return;
    }
    const { rec, by } = smFindContent(idx, row);
    if (!rec) {
      out.unmatched.push({ rowNo: n + 2, url: row.postUrl || row.postId, handle: row.handle });
      return;
    }
    const changes = [];
    SM_CONTENT_METRICS.forEach((k) => {
      const v = smMetric(cell(r, k), o.skipZero);
      if (v == null) return;                       /* blank or zero: keep what we have */
      if (rec[k] !== v) changes.push({ field: k, from: rec[k] || 0, to: v });
    });
    const pub = smDate(cell(r, 'publishedAt'));
    if (pub && rec.publishedAt !== pub) changes.push({ field: 'publishedAt', from: rec.publishedAt || '', to: pub });
    const scraped = smDate(cell(r, 'scrapedAt'));

    if (!changes.length && !scraped) { out.skipped.push({ rowNo: n + 2, why: 'nothing new' }); return; }
    out.updates.push({ rowNo: n + 2, rec, by, changes, scrapedAt: scraped,
                       campaign: String(row.campaign || '').trim() });
  });
  return out;
}

export function planSheetCreators(rows, map, opts) {
  const o = opts || {};
  const out = { updates: [], unmatched: [], skipped: [], rowsRead: 0 };
  const header = rows[0] || [];
  const headerIdx = {};
  Object.entries(map || {}).forEach(([field, col]) => {
    const i = header.findIndex((h) => String(h).trim() === String(col).trim());
    if (i >= 0) headerIdx[field] = i;
  });
  const cell = (r, f) => (headerIdx[f] == null ? '' : r[headerIdx[f]]);

  rows.slice(1).forEach((r, n) => {
    out.rowsRead++;
    const handle = String(cell(r, 'handle') || '').trim();
    if (!handle) { out.skipped.push({ rowNo: n + 2, why: 'no handle' }); return; }
    /* findCreatorByHandle normalises both sides, so a profile URL, an
       @ and a capital all land on the same creator */
    const cr = findCreatorByHandle(handle);
    if (!cr) { out.unmatched.push({ rowNo: n + 2, handle }); return; }

    const changes = [];
    [['followers', 'followers'], ['avgViews', 'avgViews'],
     ['avgLikes', 'avgLikes'], ['avgComments', 'avgComments']].forEach(([field, key]) => {
      const v = smMetric(cell(r, field), o.skipZero);
      if (v == null) return;
      if (cr[key] !== v) changes.push({ field: key, from: cr[key] || 0, to: v });
    });
    const er = smEngagement(cell(r, 'er'), o.erUnit);
    if (er != null && cr.er !== er) changes.push({ field: 'er', from: cr.er || 0, to: er });

    /* country and category fill a blank and never overwrite a value
       somebody chose here */
    const country = String(cell(r, 'country') || '').trim();
    if (country && !cr.country) changes.push({ field: 'country', from: '', to: country, fillOnly: true });
    const category = String(cell(r, 'category') || '').trim();
    if (category && !(cr.categories || []).length) {
      changes.push({ field: 'categories', from: '', to: category, fillOnly: true });
    }

    const scraped = smDate(cell(r, 'scrapedAt'));
    if (!changes.length && !scraped) { out.skipped.push({ rowNo: n + 2, why: 'nothing new' }); return; }
    out.updates.push({ rowNo: n + 2, cr, changes, scrapedAt: scraped });
  });
  return out;
}

/* ---- applying -------------------------------------------------------

   The only writes in this file. Campaign membership, participants and
   the creator list itself are never touched: an unmatched row is
   reported, never created. */
export function applySheetContent(plan) {
  const now = new Date().toISOString();
  let recs = 0;
  (plan.updates || []).forEach((u) => {
    u.changes.forEach((c) => { u.rec[c.field] = c.to; });
    u.rec.dataSource = 'google_sheet';
    u.rec.lastScrapedAt = u.scrapedAt || now.slice(0, 10);
    u.rec.updatedAt = now;
    /* views recorded with no split keeps the paid/organic maths honest,
       the same rule the Notion path applies */
    if (u.rec.views && !u.rec.paidViews && !u.rec.organicViews) u.rec.organicViews = u.rec.views;
    recs++;
  });
  return recs;
}

export function applySheetCreators(plan) {
  const now = new Date().toISOString();
  let recs = 0;
  (plan.updates || []).forEach((u) => {
    u.changes.forEach((c) => {
      if (c.field === 'categories') u.cr.categories = [...new Set([...(u.cr.categories || []), c.to])];
      else u.cr[c.field] = c.to;
    });
    u.cr.metricsSource = 'google_sheet';
    u.cr.metricsSyncedAt = u.scrapedAt || now.slice(0, 10);
    recs++;
  });
  return recs;
}

/* ---- reading the Sheet ----------------------------------------------

   A published-to-web CSV needs no key and no token, which is why it is
   the transport: nothing secret ends up in this browser, and the Sheet
   stays readable by the people who already maintain it. If Google
   refuses the request the message says so plainly rather than leaving a
   blank panel — the usual cause is a Sheet that has not been published,
   which is a two-click fix rather than a bug here. */
export async function fetchSheetTab(gid) {
  const url = sheetCsvUrl(SM.base, gid);
  if (!url) throw new Error('No Sheet URL set.');
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error('Could not reach the Sheet. If it is not published to the web, ' +
      'open it and use File → Share → Publish to web.');
  }
  if (!res.ok) {
    throw new Error(res.status === 404
      ? 'That Sheet or tab was not found — check the link and the tab id.'
      : 'The Sheet refused the request (' + res.status + '). It may not be published to the web.');
  }
  const text = await res.text();
  if (/^\s*</.test(text)) {
    throw new Error('Google returned a web page rather than CSV — the Sheet is probably not published.');
  }
  const rows = parseCsvLoose(text);
  if (!rows.length) throw new Error('That tab is empty.');
  return rows;
}

/* Every selected content tab feeds one importer. The campaign column or
   tab name is carried into the preview so an operator can see where a
   row came from, and is used for nothing else — membership is decided on
   the roster and nowhere near here. */
export async function dryRunSheetMetrics() {
  const result = { content: null, creators: null, tabs: [], errors: [] };
  const tabs = (SM.contentTabs || []).filter((t) => t.on);

  for (const t of tabs) {
    try {
      const rows = await fetchSheetTab(t.gid);
      const map = Object.keys(SM.contentMap || {}).length
        ? SM.contentMap
        : guessSheetColumns(rows[0] || [], SM_CONTENT_ALIASES);
      const plan = planSheetContent(rows, map, { skipZero: SM.skipZero, tab: t.name });
      result.tabs.push({ tab: t.name, plan });
    } catch (err) {
      result.errors.push((t.name || 'content tab') + ': ' + err.message);
    }
  }
  if (result.tabs.length) {
    result.content = result.tabs.reduce((a, x) => ({
      updates: a.updates.concat(x.plan.updates),
      unmatched: a.unmatched.concat(x.plan.unmatched),
      skipped: a.skipped.concat(x.plan.skipped),
      rowsRead: a.rowsRead + x.plan.rowsRead
    }), { updates: [], unmatched: [], skipped: [], rowsRead: 0 });

    /* the same post listed on two tabs would otherwise be applied twice;
       the later row wins and the earlier is reported as a duplicate */
    const seen = new Map();
    const deduped = [];
    result.content.updates.forEach((u) => {
      const key = u.rec.platformPostId || u.rec.postUrl || u.rec.url;
      if (seen.has(key)) { result.content.skipped.push({ rowNo: u.rowNo, why: 'same post on an earlier tab' }); }
      seen.set(key, u);
    });
    seen.forEach((u) => deduped.push(u));
    result.content.updates = deduped;
  }

  if (SM.creatorTab && SM.creatorTab.on && (SM.creatorTab.gid || SM.creatorTab.name)) {
    try {
      const rows = await fetchSheetTab(SM.creatorTab.gid);
      const map = Object.keys(SM.creatorMap || {}).length
        ? SM.creatorMap
        : guessSheetColumns(rows[0] || [], SM_CREATOR_ALIASES);
      result.creators = planSheetCreators(rows, map, { skipZero: SM.skipZero, erUnit: SM.erUnit });
    } catch (err) {
      result.errors.push('creator tab: ' + err.message);
    }
  }
  return result;
}

/* Applies a plan that has already been shown. Returns what it did so the
   caller can say so; recomputeCreatorStats is deliberately NOT called
   here — it derives the Vively side from participants and content, and
   nothing in this file changes either. */
export function commitSheetMetrics(dry) {
  const content = dry.content ? applySheetContent(dry.content) : 0;
  const creators = dry.creators ? applySheetCreators(dry.creators) : 0;
  SM.at = new Date(); SM.error = null; SM.status = 'idle';
  saveSheetMetricsConfig();
  return { content, creators };
}
