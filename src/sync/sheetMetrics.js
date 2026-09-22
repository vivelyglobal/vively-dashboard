import { findCreatorByHandle, recomputeCreatorStats } from '../model/creators.js';
import { DB, attachContent, byCampaign, platformOfUrl, platformPostIdOf, socialContentDefaults } from '../model/db.js';
import { avColor, newId } from '../model/vocab.js';

/* ============================================================
   SYNC — SHEET METRICS  (read-only)

   A second Google Sheet, and nothing like the first one.

   sync/sheets.js mirrors the whole workspace: it pushes every
   campaign, creator and roster row out, and pulling REPLACES all
   three collections with whatever the Sheet holds. This is the
   opposite: it reads a master Sheet somebody else maintains and
   updates numbers on records that already exist. The two share no
   state, no storage key and no code.

   The master Sheet has one tab per campaign, named after it — KOWORK
   and so on — and every row on a tab belongs to that campaign. So the
   campaign is decided ONCE, in Setup, by mapping each tab to a Vively
   campaign. It is never read from a cell, and nothing here ever moves
   a creator onto or off a roster.

   Identity is the post URL. The shortcode in it becomes platformPostId
   exactly as everywhere else in the app. ci_id and deliverable_id are
   the Sheet's own bookkeeping and are never treated as a post id.

   What it may change:
     socialContent  views, likes, comments, shares, saves, publishedAt,
                    format, the secondary analytics (reposts, post ER,
                    CPE/CPV, notes), dataSource, lastScrapedAt
     creators       profile figures, ONLY from a creator-profile tab —
                    never from post_er or any per-post number

   What it may create: one socialContent record, and only when the post
   URL is a real post, the creator is already in the database, the tab
   is mapped to a campaign, and that creator is already on that
   campaign's roster. Never a creator, never a roster row.
   ============================================================ */

export const SHEET_METRICS_KEY = 'vively-sheet-metrics-v1';

/* Its own object and its own storage key — nothing here reads or
   writes SYNC in sync/sheets.js. */
export const SM = {
  base: '',                 /* the master Sheet's link */
  erUnit: 'percent',        /* how post_er (and a profile ER) is written */
  skipZero: true,           /* a zero from a scraper is usually "did not read" */
  allowCreate: true,        /* may a post new to the library be added? see planSheetContent */
  /* one entry per campaign tab: { name, gid, campaignId, on } — the
     campaignId is the whole of the campaign logic */
  contentTabs: [],
  /* a creator-profile tab is optional and off until one exists; per-post
     numbers never stand in for it */
  creatorTab: { name: '', gid: '', on: false },
  contentMap: {},
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
      base: SM.base, erUnit: SM.erUnit, skipZero: SM.skipZero, allowCreate: SM.allowCreate,
      contentTabs: SM.contentTabs, creatorTab: SM.creatorTab,
      contentMap: SM.contentMap, creatorMap: SM.creatorMap, discovered: SM.discovered || null,
      at: SM.at ? SM.at.toISOString() : null
    }));
  } catch (e) { /* storage blocked */ }
}

/* ---- reading a sheet (unchanged) ---- */

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

/* ---- the campaign tab's columns --------------------------------------

   The master Sheet's own headers, so a tab reads with no mapping at all.
   Every entry stays editable in Setup in case a tab is laid out
   differently. ci_id is absent on purpose: it is not a post id, and
   listing it here would invite exactly that mistake. */
export const SM_CONTENT_DEFAULT_MAP = {
  postUrl: 'post_url',
  influencer: 'influencer_id',
  type: 'type',
  publishedAt: 'posted_date',
  scrapedAt: 'last_scraped_at',
  views: 'views', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves',
  reposts: 'reposts', postEr: 'post_er',
  cpeExpected: 'cpe_expected', cpeActual: 'cpe_actual',
  cpvExpected: 'cpv_expected', cpvActual: 'cpv_actual',
  notes: 'notes', deliverableId: 'deliverable_id'
};
export const SM_CONTENT_FIELDS = Object.keys(SM_CONTENT_DEFAULT_MAP);

/* reads a mapping against a tab's header row, tolerating case and stray
   spaces in the Sheet's headers */
export function smHeaderIndex(header, map) {
  const norm = (h) => String(h || '').trim().toLowerCase();
  const idx = {};
  Object.entries(map || {}).forEach(([field, col]) => {
    const i = (header || []).findIndex((h) => norm(h) === norm(col));
    if (i >= 0) idx[field] = i;
  });
  return idx;
}

/* Money values keep their decimals — smMetric rounds, which is right for
   a view count and wrong for a cost per engagement of 0.37. */
export function smNumber(v) {
  if (v === '' || v == null) return null;
  const s = String(v).trim().replace(/[,\s₩$]/g, '');
  if (!s || s === '-' || /^n\/?a$/i.test(s)) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/* A post URL is valid when it yields a real post id. platformPostIdOf
   falls back to returning the URL itself for anything it does not
   recognise, which is a fine identity for matching and no proof at all
   that the link is a post — so creation insists on the prefixed form. */
export function smPostId(url) {
  const pid = platformPostIdOf(String(url || '').trim());
  return /^(ig_|tt_)/.test(pid) ? pid : '';
}

/* ---- is influencer_id a handle? --------------------------------------

   Only the data can say. A column of @names and profile links is a
   perfectly good way to find a creator; a column of INF-0042 or 18-digit
   numbers is not, and treating it as one would attach posts to whoever
   happened to have a matching string. So the column is inspected on
   every read, and used only when most of what it holds resolves to a
   creator already in the database. */
export function smInfluencerKind(values) {
  const vals = values.map((v) => String(v || '').trim()).filter(Boolean);
  if (!vals.length) return { kind: 'empty', resolved: 0, total: 0, sample: [] };
  const numeric = vals.filter((v) => /^\d+$/.test(v)).length;
  const resolved = vals.filter((v) => findCreatorByHandle(v)).length;
  const share = resolved / vals.length;
  const kind = numeric > vals.length / 2 ? 'opaque'
    : share >= 0.5 ? 'handle'
    : 'opaque';
  return { kind, resolved, total: vals.length, sample: vals.slice(0, 3) };
}

/* ---- matching an existing post ---------------------------------------- */
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

export function smFindContent(idx, url) {
  const u = String(url || '').trim();
  if (!u) return { rec: null, by: null };
  const pid = platformPostIdOf(u);
  if (pid && idx.byPostId.has(pid)) return { rec: idx.byPostId.get(pid), by: 'post id' };
  const k = u.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  if (idx.byUrl.has(k)) return { rec: idx.byUrl.get(k), by: 'URL' };
  return { rec: null, by: null };
}


/* ---- profile columns and value readers (unchanged) ---- */

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

/* ---- planning a campaign tab ------------------------------------------

   Nothing is written here. The plan names every record a row would
   touch, every field that would move, and every post it would add, so
   the preview can show all of it and the operator can refuse it.

   opts.campaignId is the tab's mapping. It is the ONLY source of the
   campaign: there is no campaign column to read, and a campaign name on
   a record is never changed by this. */
export const SM_POST_METRICS = ['views', 'likes', 'comments', 'shares', 'saves'];

export function smRowValues(r, idx, opts) {
  const cell = (f) => (idx[f] == null ? '' : r[idx[f]]);
  const v = { metrics: {}, extra: {} };
  SM_POST_METRICS.forEach((k) => { const n = smMetric(cell(k), opts.skipZero); if (n != null) v.metrics[k] = n; });
  const pub = smDate(cell('publishedAt'));      if (pub) v.publishedAt = pub;
  v.scrapedAt = smDate(cell('scrapedAt'));      /* null leaves the stamp alone */
  const type = String(cell('type') || '').trim();
  if (type) v.format = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  /* the secondary analytics: kept, never shown as headline numbers */
  const reposts = smMetric(cell('reposts'), opts.skipZero); if (reposts != null) v.extra.reposts = reposts;
  /* post_er is a property of this post. It is stored on the post and is
     never read into a creator's profile engagement rate. */
  const per = smEngagement(cell('postEr'), opts.erUnit);    if (per != null) v.extra.postEr = per;
  [['cpeExpected'], ['cpeActual'], ['cpvExpected'], ['cpvActual']].forEach(([k]) => {
    const n = smNumber(cell(k)); if (n != null) v.extra[k] = n;
  });
  const notes = String(cell('notes') || '').trim();          if (notes) v.extra.sheetNotes = notes;
  const did = String(cell('deliverableId') || '').trim();    if (did) v.extra.deliverableId = did;
  v.postUrl = String(cell('postUrl') || '').trim();
  v.influencer = String(cell('influencer') || '').trim();
  return v;
}

export function planSheetContent(rows, map, opts) {
  const o = opts || {};
  const out = {
    tab: o.tab || '', campaignId: o.campaignId || '', campaignName: '',
    updates: [], creates: [], unmatched: [], skipped: [], conflicts: [], rowsRead: 0,
    influencer: { kind: 'empty', resolved: 0, total: 0, sample: [] }
  };
  const header = rows[0] || [];
  const idx = smHeaderIndex(header, map);
  const cp = o.campaignId ? byCampaign[o.campaignId] : null;
  out.campaignName = cp ? (cp.brand + (cp.name ? ' — ' + cp.name : '')) : '';

  const body = rows.slice(1);
  if (idx.influencer != null) out.influencer = smInfluencerKind(body.map((r) => r[idx.influencer]));
  const influencerUsable = out.influencer.kind === 'handle';

  const lib = smContentIndex();
  const seenNew = new Set();       /* the same new post twice on one tab */
  /* a roster row that has been handed its one linked post in THIS plan.
     Without it, two new posts for one creator would both plan as linked,
     and attachContent — which returns the existing record when there is
     one — would pour the second post's numbers onto the first. */
  const linkedInPlan = new Set(o.linkedInPlan || []);

  body.forEach((r, n) => {
    out.rowsRead++;
    const rowNo = n + 2;
    const v = smRowValues(r, idx, o);
    if (!v.postUrl) { out.skipped.push({ rowNo, why: 'no post_url' }); return; }

    const { rec, by } = smFindContent(lib, v.postUrl);

    /* ---- a post already in the library: update its numbers ---- */
    if (rec) {
      if (cp && rec.campaignId && rec.campaignId !== cp.id) {
        /* The post is filed under a different campaign than this tab.
           Its numbers are its own either way, so they still update — but
           it is never moved, and the preview says so. */
        out.conflicts.push({ rowNo, url: v.postUrl, filed: rec.campaignId, tab: cp.id });
      }
      const changes = [];
      Object.entries(v.metrics).forEach(([k, val]) => {
        if (rec[k] !== val) changes.push({ field: k, from: rec[k] || 0, to: val });
      });
      if (v.publishedAt && rec.publishedAt !== v.publishedAt) changes.push({ field: 'publishedAt', from: rec.publishedAt || '', to: v.publishedAt });
      if (v.format && rec.format !== v.format) changes.push({ field: 'format', from: rec.format || '', to: v.format });
      Object.entries(v.extra).forEach(([k, val]) => {
        if (rec[k] !== val) changes.push({ field: k, from: rec[k] == null ? '' : rec[k], to: val, secondary: true });
      });
      if (!changes.length && !v.scrapedAt) { out.skipped.push({ rowNo, why: 'nothing new' }); return; }
      out.updates.push({ rowNo, rec, by, changes, scrapedAt: v.scrapedAt });
      return;
    }

    /* ---- a post the library has never seen ----

       Every one of these conditions has to hold, and the first that does
       not is reported by name so the fix is obvious. */
    const refuse = (why) => out.unmatched.push({ rowNo, url: v.postUrl, handle: v.influencer, why });
    if (!o.allowCreate) return refuse('new post — adding posts is switched off');
    const postId = smPostId(v.postUrl);
    if (!postId) return refuse('post_url is not an Instagram or TikTok post link');
    if (seenNew.has(postId)) { out.skipped.push({ rowNo, why: 'same post earlier on this tab' }); return; }
    if (!cp) return refuse('this tab is not mapped to a campaign');
    if (!v.influencer) return refuse('no influencer_id on the row');
    if (!influencerUsable) return refuse('influencer_id does not hold Instagram handles');
    const cr = findCreatorByHandle(v.influencer);
    if (!cr) return refuse('creator not in the database');
    const p = DB.participants.find((x) => x.campaignId === cp.id && x.creatorId === cr.id);
    if (!p) return refuse(cr.handle + ' is not on the ' + cp.brand + ' roster');

    seenNew.add(postId);
    const linked = !p.content && !linkedInPlan.has(p.id);
    if (linked) linkedInPlan.add(p.id);
    out.creates.push({
      rowNo, postId, url: v.postUrl, cp, cr, p,
      /* One roster row carries one linked post: linkSocialContent rebuilds
         p.content from the library on every load and the last row with a
         given participantId wins. A second linked row would quietly swap
         which post the roster shows. So a creator who already has a post
         on this campaign gets the new one in the library, attributed to
         the campaign, and the roster card is left alone. */
      linked,
      values: v
    });
  });
  out.linkedInPlan = [...linkedInPlan];
  return out;
}


/* ---- the optional creator-profile tab (unchanged) ---- */

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

/* ---- applying --------------------------------------------------------- */

export function smWriteValues(rec, v) {
  Object.entries(v.metrics || {}).forEach(([k, val]) => { rec[k] = val; });
  if (v.publishedAt) { rec.publishedAt = v.publishedAt; rec.postedAt = v.publishedAt; }
  if (v.format) rec.format = v.format;
  Object.entries(v.extra || {}).forEach(([k, val]) => { rec[k] = val; });
}

export function applySheetContent(plan) {
  const now = new Date().toISOString();
  let updated = 0, created = 0;

  (plan.updates || []).forEach((u) => {
    u.changes.forEach((c) => {
      u.rec[c.field] = c.to;
      if (c.field === 'publishedAt') u.rec.postedAt = c.to;
    });
    u.rec.dataSource = 'google_sheet';
    if (u.scrapedAt) u.rec.lastScrapedAt = u.scrapedAt;   /* unreadable date: stamp left alone */
    u.rec.updatedAt = now;
    if (u.rec.views && !u.rec.paidViews && !u.rec.organicViews) u.rec.organicViews = u.rec.views;
    updated++;
  });

  (plan.creates || []).forEach((c) => {
    /* The guard is re-checked here and not only at planning: the plan may
       have sat in a preview while something else changed. A post that has
       appeared in the library since is skipped rather than duplicated. */
    if (smFindContent(smContentIndex(), c.url).rec) return;
    if (!DB.participants.includes(c.p) || c.p.campaignId !== c.cp.id) return;

    const seed = {
      url: c.url, platform: platformOfUrl(c.url, c.cr.platform),
      dataSource: 'google_sheet', matchMethod: 'sheet_tab',
      matchConfidence: 100, matchStatus: 'confirmed'
    };
    let rec;
    if (c.linked && !c.p.content) {
      rec = attachContent(c.p, c.cr, seed);
    } else {
      /* in the library, attributed to the campaign and the creator, and
         deliberately not linked to the roster row — see planSheetContent */
      rec = Object.assign(socialContentDefaults(), {
        id: newId('sc'), participantId: '', campaignId: c.cp.id, creatorId: c.cr.id,
        username: c.cr.handle || '', thumbTint: avColor(c.cr.handle || ''),
        createdAt: now
      }, seed);
      rec.postUrl = c.url; rec.url = c.url;
      rec.platformPostId = c.postId;
      DB.socialContent.push(rec);
    }
    smWriteValues(rec, c.values);
    rec.lastScrapedAt = c.values.scrapedAt || now.slice(0, 10);
    rec.updatedAt = now;
    if (rec.views && !rec.paidViews && !rec.organicViews) rec.organicViews = rec.views;
    created++;
  });

  return { updated, created };
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

   Through the server, always. docs.google.com sends no CORS headers, so
   a page on this origin cannot read a Sheet directly — the request dies
   in the browser before a byte arrives, and the old direct fetch failed
   that way against every real Sheet. server/sheet-proxy.js makes the two
   reads (tab list, one tab's CSV) server-side, read-only, against
   docs.google.com and nothing else. The Sheet needs "Anyone with the
   link can view"; no key or token lives in this browser. */
export async function smProxyGet(path, params) {
  const q = new URLSearchParams(Object.assign({ sheet: SM.base }, params || {}));
  let res;
  try {
    res = await fetch('/api/sheet-metrics/' + path + '?' + q.toString(), { credentials: 'same-origin' });
  } catch (err) {
    throw new Error('Could not reach the dashboard server to read the Sheet.');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Your session has ended — sign in again, then read the Sheet.');
  if (!res.ok || !body.ok) throw new Error(body.error || ('The server answered ' + res.status + '.'));
  return body;
}

/* Every tab in the master Sheet, as { gid, name }. */
export async function fetchSheetTabList() {
  if (!SM.base) throw new Error('No Sheet link set.');
  const body = await smProxyGet('tabs');
  return { tabs: body.tabs || [], gidHint: body.gidHint || '' };
}

/* Merges the Sheet's tab list into the saved tabs. Keyed on gid, which
   survives a rename; a tab added by hand before discovery is matched on
   its name and given its gid. What the operator chose — which tabs are
   on, which campaign each maps to — is never overwritten. A new tab is
   switched on only when its name already names a campaign. */
export async function discoverSheetTabs() {
  const { tabs } = await fetchSheetTabList();
  const list = SM.contentTabs = SM.contentTabs || [];
  const found = new Set();
  let added = 0;
  tabs.forEach((g) => {
    found.add(g.gid);
    let t = list.find((x) => x.gid && String(x.gid) === String(g.gid));
    if (!t) t = list.find((x) => !x.gid && String(x.name || '').trim().toLowerCase() === g.name.trim().toLowerCase());
    if (t) { t.gid = g.gid; t.name = g.name; t.found = true; t.missing = false; return; }
    const campaignId = smSuggestCampaign(g.name);
    list.push({ name: g.name, gid: g.gid, campaignId, on: !!campaignId, found: true, missing: false });
    added++;
  });
  list.forEach((t) => { if (t.found && t.gid && !found.has(String(t.gid))) t.missing = true; });
  SM.discovered = { at: new Date().toISOString(), count: tabs.length };
  saveSheetMetricsConfig();
  return { count: tabs.length, added };
}

/* One tab's rows. Takes a saved tab ({ gid, name }) or a bare gid. */
export async function fetchSheetTab(tab) {
  const t = (tab && typeof tab === 'object') ? tab : { gid: tab };
  const gid = String(t.gid == null ? '' : t.gid).trim();
  const name = String(t.name || '').trim();
  if (!SM.base) throw new Error('No Sheet link set.');
  if (!gid && !name) throw new Error('This tab has neither a gid nor a name — use Find tabs.');
  const body = await smProxyGet('csv', gid ? { gid } : { name });
  const rows = parseCsvLoose(body.csv || '');
  if (!rows.length) throw new Error('That tab is empty.');
  return rows;
}

/* ---- a read of the whole Sheet ----------------------------------------

   Every enabled campaign tab, each under its own mapping, into one
   preview. A tab with no campaign mapped is still read — its existing
   posts update normally — but it cannot add a post, because a new post
   needs a campaign and this is the only place one comes from. */
export async function dryRunSheetMetrics() {
  const result = { tabs: [], creators: null, errors: [] };
  const tabs = (SM.contentTabs || []).filter((t) => t.on);
  const map = Object.assign({}, SM_CONTENT_DEFAULT_MAP, SM.contentMap || {});
  let linkedInPlan = [];
  const claimed = new Set();        /* one post named on two tabs */
  /* nothing switched on is a setup state, not a result — say so rather
     than show a preview of zeroes */
  if (!tabs.length) {
    result.errors.push((SM.contentTabs || []).length
      ? 'No campaign tab is switched on — tick the tabs to read under Campaign tabs.'
      : 'No campaign tabs yet — use Find tabs to list the tabs in your Sheet.');
  }

  for (const t of tabs) {
    try {
      const rows = await fetchSheetTab(t);
      const plan = planSheetContent(rows, map, {
        tab: t.name, campaignId: t.campaignId, skipZero: SM.skipZero,
        erUnit: SM.erUnit, allowCreate: SM.allowCreate, linkedInPlan
      });
      linkedInPlan = plan.linkedInPlan;
      /* the same post on an earlier tab wins; this one is reported */
      plan.updates = plan.updates.filter((u) => {
        const key = u.rec.platformPostId || u.rec.postUrl;
        if (claimed.has(key)) { plan.skipped.push({ rowNo: u.rowNo, why: 'same post on an earlier tab' }); return false; }
        claimed.add(key); return true;
      });
      plan.creates = plan.creates.filter((c) => {
        if (claimed.has(c.postId)) { plan.skipped.push({ rowNo: c.rowNo, why: 'same post on an earlier tab' }); return false; }
        claimed.add(c.postId); return true;
      });
      result.tabs.push(plan);
    } catch (err) {
      result.errors.push((t.name || 'a campaign tab') + ': ' + err.message);
    }
  }

  if (SM.creatorTab && SM.creatorTab.on && (SM.creatorTab.gid || SM.creatorTab.name)) {
    try {
      const rows = await fetchSheetTab(SM.creatorTab);
      const cmap = Object.keys(SM.creatorMap || {}).length
        ? SM.creatorMap : guessSheetColumns(rows[0] || [], SM_CREATOR_ALIASES);
      result.creators = planSheetCreators(rows, cmap, { skipZero: SM.skipZero, erUnit: SM.erUnit });
    } catch (err) {
      result.errors.push('creator tab: ' + err.message);
    }
  }
  return result;
}

export function commitSheetMetrics(dry) {
  let updated = 0, created = 0;
  (dry.tabs || []).forEach((plan) => {
    const r = applySheetContent(plan);
    updated += r.updated; created += r.created;
  });
  const creators = dry.creators ? applySheetCreators(dry.creators) : 0;
  /* A linked post is new content on a roster row, and the Vively side of
     every creator is derived from exactly that — so the derivation runs
     again. It is pure and reads only participants and content; nothing
     here writes to it directly. */
  if (created) recomputeCreatorStats();
  SM.at = new Date(); SM.error = null; SM.status = 'idle';
  saveSheetMetricsConfig();
  return { updated, created, creators };
}

/* The Setup screen's first guess at which campaign a tab is: a tab named
   KOWORK finds the campaign whose brand or name is KOWORK. Only a guess —
   the operator confirms it once and it is stored. */
export function smSuggestCampaign(tabName) {
  const n = String(tabName || '').trim().toLowerCase();
  if (!n) return '';
  const hit = DB.campaigns.find((c) => String(c.brand || '').trim().toLowerCase() === n)
    || DB.campaigns.find((c) => String(c.name || '').trim().toLowerCase() === n)
    || DB.campaigns.find((c) => String(c.brand || '').toLowerCase().includes(n));
  return hit ? hit.id : '';
}
