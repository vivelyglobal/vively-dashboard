/* Live performance sync: the founder's link-shared KOL Google Sheet ->
   one server-side snapshot the dashboard can read.

   OFF unless PERF_SHEET_ID is set. Everything else is in this file; server.js
   only wires it (the same pattern as the Notion jobs).

   What it does, in order, every PERF_SYNC_INTERVAL_MIN minutes:
     1. For each tab it needs, asks Google for the COLUMN LIST only
        (`select * limit 0`: zero rows) and works out which column letter
        carries each whitelisted label.
     2. Asks for exactly those columns (`select C,D,F limit N`). A column it
        has not whitelisted is never named in any query, so contact, rate,
        amount, budget and note cells never reach this server.
     3. Rebuilds the snapshot whole and swaps it in with ONE write. A run that
        fails changes nothing: the last good snapshot stays.

   What it will not do:
     - read any host but docs.google.com; follow a redirect off that host;
     - take a sheet id, tab name or query from a request (the id is read once
       from the environment and never leaves this module: not in a response,
       a log line, a run log entry or an error message);
     - write the Sheet, or write the dashboard workspace (it only READS it, to
       match campaigns);
     - store a field that is not on the whitelist below.

   Whitelist (label in the Sheet -> what is kept):
     Campaign Map      A, B (no header labels: the header row is data)
     Campaigns         campaign_id, name, start_date, end_date, campaign_status
     CampaignInfluencers  ci_id, campaign_id, influencer_id
     Influencers       influencer_id, platform, username, followers
     Deliverables      deliverable_id, ci_id, type, post_url, posted_date, likes,
                       comments, views, last_scraped_at, shares, saves, reposts
     <campaign> tabs   post_er, deliverable_id, post_url (only for tabs whose
                       name equals a Campaigns.name; at most 40 tabs) */

"use strict";

const crypto = require("crypto");

const GOOGLE_HOST = "docs.google.com";
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const RUN_BUDGET_MS = 150000;
const MAX_REDIRECTS = 3;
const MAX_ER_TABS = 40;
const MANUAL_MIN_MS = 5 * 60 * 1000;
const LOG_KEEP = 30;
const DAY_MS = 86400000;
const STALE_POST_DAYS = 7;
const GREEN_READING_HOURS = 48;
const RED_DAYS = 7;

/* ---- the whitelist -------------------------------------------------------- */

const TABS = {
  campaigns: { tab: "Campaigns", labels: ["campaign_id", "name", "start_date", "end_date", "campaign_status"] },
  campaignInfluencers: { tab: "CampaignInfluencers", labels: ["ci_id", "campaign_id", "influencer_id"] },
  influencers: { tab: "Influencers", labels: ["influencer_id", "platform", "username", "followers"] },
  deliverables: {
    tab: "Deliverables",
    labels: ["deliverable_id", "ci_id", "type", "post_url", "posted_date", "likes", "comments", "views",
      "last_scraped_at", "shares", "saves", "reposts"]
  }
};
const CAMPAIGN_MAP_TAB = "Campaign Map";

/* ---- config ---------------------------------------------------------------- */

const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,200}$/;

function parseConfig(env) {
  const e = env || {};
  const raw = String(e.PERF_SHEET_ID == null ? "" : e.PERF_SHEET_ID).trim();
  const num = (v) => (String(v == null ? "" : v).trim() === "" ? NaN : Number(v));
  const mins = num(e.PERF_SYNC_INTERVAL_MIN);
  const intervalMin = Number.isFinite(mins) ? Math.min(Math.max(mins, 5), 1440) : 30;
  const rows = num(e.PERF_SYNC_MAX_ROWS);
  const maxRows = Number.isFinite(rows) && rows >= 10 ? Math.min(Math.floor(rows), 50000) : 5000;
  return {
    requested: !!raw,
    sheetId: SHEET_ID_RE.test(raw) ? raw : "",
    invalid: !!raw && !SHEET_ID_RE.test(raw),
    intervalMin, intervalMs: Math.round(intervalMin * 60000),
    maxRows,
    dryRun: /^(1|true|yes)$/i.test(String(e.PERF_SYNC_DRY_RUN || "").trim())
  };
}

/* ---- errors: plain words, never the sheet id --------------------------------- */

class PerfError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const NOT_SHARED = "Google asked for a sign-in, so the sheet cannot be read. Set sharing to Anyone with the link, Viewer.";
const OFF_TEXT = "Live performance is switched off. Ask the admin to set the sheet.";

/* belt and braces: whatever text a library hands back, the id and any URL are
   removed before it can be logged, stored or returned */
function makeScrub(sheetId) {
  return (s) => {
    let t = String(s == null ? "" : s);
    if (sheetId) t = t.split(sheetId).join("[sheet]");
    return t.replace(/https?:\/\/\S+/gi, "[url]").replace(/[A-Za-z0-9_-]{40,}/g, "[id]").slice(0, 300);
  };
}

/* ---- talking to Google --------------------------------------------------------- */

async function readCapped(res) {
  const len = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new PerfError("too-big", "A tab is larger than the safety limit. Nothing was updated.");
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new PerfError("too-big", "A tab is larger than the safety limit. Nothing was updated."); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new PerfError("too-big", "A tab is larger than the safety limit. Nothing was updated.");
  return body;
}

/* GET with manual redirects: only https://docs.google.com is ever followed.
   A hop to accounts.google.com means "not shared"; anything else is refused. */
async function googleGet(fetchImpl, url0) {
  let url = url0;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/plain,application/json,*/*" } });
    } catch (err) {
      if (err instanceof PerfError) throw err;
      throw new PerfError("google-down", "Google did not answer.");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers && res.headers.get ? res.headers.get("location") : "";
      let next;
      try { next = new URL(loc, url); } catch (e) { throw new PerfError("bad-response", "Google sent an answer this server does not understand. Nothing was updated."); }
      if (next.hostname === "accounts.google.com" || /ServiceLogin/i.test(next.href)) throw new PerfError("not-shared", NOT_SHARED);
      if (next.protocol !== "https:" || next.hostname !== GOOGLE_HOST) {
        throw new PerfError("bad-response", "Google redirected the read to another address, so it was refused. Nothing was updated.");
      }
      url = next.href;
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new PerfError("not-shared", NOT_SHARED);
    if (res.status === 404) throw new PerfError("sheet-missing", "Google has no sheet at the configured address. Nothing was updated.");
    if (res.status === 429 || res.status >= 500) throw new PerfError("google-down", "Google did not answer.");
    if (!res.ok) throw new PerfError("bad-response", "Google answered " + res.status + ". Nothing was updated.");
    return readCapped(res);
  }
  throw new PerfError("bad-response", "Google redirected too many times. Nothing was updated.");
}

/* "/*O_o*\/ google.visualization.Query.setResponse({...});" -> object */
function parseGviz(body) {
  const s = String(body || "");
  if (/^\s*<(!doctype|html)/i.test(s) || /<title>[^<]*(Sign in|로그인)/i.test(s.slice(0, 4000))) throw new PerfError("not-shared", NOT_SHARED);
  const m = s.match(/setResponse\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) throw new PerfError("bad-response", "Google sent an answer this server does not understand. Nothing was updated.");
  try { return JSON.parse(m[1]); } catch (e) {
    throw new PerfError("bad-response", "Google sent an answer this server does not understand. Nothing was updated.");
  }
}

const COL_ID_RE = /^[A-Z]{1,3}$/;
const gvizUrl = (sheetId, tab, query) =>
  "https://" + GOOGLE_HOST + "/spreadsheets/d/" + sheetId + "/gviz/tq?tqx=out:json&sheet=" +
  encodeURIComponent(tab) + "&tq=" + encodeURIComponent(query);

async function gvizQuery(ctx, tab, query, kind) {
  ctx.queries.push({ tab, query });               // for the tests: proves what was asked
  const obj = parseGviz(await googleGet(ctx.fetchImpl, gvizUrl(ctx.sheetId, tab, query)));
  if (obj.status === "error" || !obj.table) {
    const reason = String(((obj.errors || [])[0] || {}).reason || "");
    if (kind === "discover" || /invalid|not_found|sheet|range/i.test(reason)) {
      throw new PerfError("tab-missing", "The tab '" + tab + "' was not found. Nothing was updated.");
    }
    throw new PerfError("query-error", "Google could not read the tab '" + tab + "'. Nothing was updated.");
  }
  if (!Array.isArray(obj.table.cols) || !Array.isArray(obj.table.rows || [])) {
    throw new PerfError("bad-response", "Google sent an answer this server does not understand. Nothing was updated.");
  }
  return { cols: obj.table.cols, rows: obj.table.rows || [] };
}

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

/* columns by label, from a `select * limit 0` answer. Returns Map label -> id */
async function discover(ctx, tab) {
  const t = await gvizQuery(ctx, tab, "select * limit 0", "discover");
  const byLabel = new Map(); const dup = new Set();
  t.cols.forEach((c) => {
    const l = norm(c && c.label);
    if (!l) return;
    if (byLabel.has(l)) dup.add(l); else if (COL_ID_RE.test(String((c && c.id) || ""))) byLabel.set(l, c.id);
  });
  return { byLabel, dup };
}

/* the requested labels must all be there exactly once, or the run refuses */
function pickColumns(found, tab, labels) {
  const ids = labels.map((l) => {
    if (found.dup.has(l)) throw new PerfError("column-ambiguous", "Column '" + l + "' appears more than once in '" + tab + "'. Nothing was updated.");
    const id = found.byLabel.get(l);
    if (!id) throw new PerfError("column-missing", "Column '" + l + "' is missing from '" + tab + "'. Nothing was updated.");
    return id;
  });
  return ids;
}

/* fetch exactly `ids` (never more); returns rows as arrays of cells in `ids` order.
   Over the row cap = refuse, so old data is kept. */
async function fetchColumns(ctx, tab, ids, maxRows) {
  ids.forEach((id) => { if (!COL_ID_RE.test(id)) throw new PerfError("bad-response", "Unexpected column id. Nothing was updated."); });
  const t = await gvizQuery(ctx, tab, "select " + ids.join(",") + " limit " + (maxRows + 1), "data");
  if (t.rows.length > maxRows) throw new PerfError("too-big", "A tab is larger than the safety limit. Nothing was updated.");
  /* map by the id Google reports; fall back to position only when the shape is exactly what was asked */
  const pos = ids.map((id, i) => {
    const k = t.cols.findIndex((c) => c && c.id === id);
    return k >= 0 ? k : (t.cols.length === ids.length ? i : -1);
  });
  if (pos.some((p) => p < 0)) throw new PerfError("bad-response", "Google sent an answer this server does not understand. Nothing was updated.");
  return t.rows.map((r) => pos.map((p) => ((r && r.c && r.c[p]) || null)));
}

/* ---- cell values ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, "0");
const DATE_CELL = /^Date\((\d{1,4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2}),(\d{1,2})(?:,\d+)?)?\)$/;

/* date cells are {v:'Date(2026,10,24)'} with a ZERO-based month and optional
   time parts. The Sheet's own time zone is not in the answer, so the time is
   read as UTC (ASSUMED; it can be off by the Sheet's UTC offset). Returns a
   Date or null. */
function cellDate(cell) {
  if (!cell || cell.v == null || cell.v === "") return null;
  const v = cell.v;
  if (typeof v === "string") {
    const m = v.match(DATE_CELL);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
      return Number.isFinite(d.getTime()) ? d : null;
    }
    if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v.trim())) {
      const d = new Date(v.trim().length === 10 ? v.trim() + "T00:00:00Z" : v.trim().replace(" ", "T") + (/Z$/.test(v) ? "" : "Z"));
      return Number.isFinite(d.getTime()) ? d : null;
    }
  }
  return null;
}
const isoDay = (d) => (d ? d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) : null);
const isoTime = (d) => (d ? d.toISOString() : null);

function cellText(cell, max) {
  if (!cell || cell.v == null) return "";
  const v = cell.v;
  if (typeof v === "object") return "";
  return String(v).trim().slice(0, max || 200);
}

/* a number, or null for blank/garbage. "1,234" is allowed. NOT the unread rule. */
function cellNumber(cell) {
  if (!cell || cell.v == null || cell.v === "") return null;
  if (typeof cell.v === "number") return Number.isFinite(cell.v) ? cell.v : null;
  if (typeof cell.v !== "string") return null;
  const s = cell.v.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/* the dashboard's rule (src/sync/sheetMetrics.js smMetric): blank, 0, or junk is
   "the collector did not read", never a measured zero. Returns {value, unread}. */
function readCount(cell) {
  const n = cellNumber(cell);
  if (n == null || Math.round(n) === 0 || n < 0) return { value: null, unread: true };
  return { value: Math.round(n), unread: false };
}
const plainCount = (cell) => { const n = cellNumber(cell); return n == null || n < 0 ? null : Math.round(n); };

/* post_er is a percent. A percent-formatted cell holds 0.042 and shows "4.2%":
   when the formatted text has a % sign and the value is <= 1 it is scaled.
   0, negative and > 100 are invalid (excluded from the mean). */
function cellEr(cell) {
  if (!cell || cell.v == null || cell.v === "") return null;
  let n = cellNumber(cell);
  if (n == null && typeof cell.v === "string") {
    const s = cell.v.trim().replace(/[%\s,]/g, "");
    if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  }
  if (n == null) return null;
  if (/%\s*$/.test(String(cell.f || "")) && n <= 1) n = n * 100;
  if (!(n > 0) || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/* ---- post identity: a copy of platformPostIdOf in src/model/db.js (a test keeps them equal) --- */
function platformPostIdOf(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  let m = u.match(/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i);
  if (m) return "ig_" + m[1];
  m = u.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/i);
  if (m) return "tt_" + m[1];
  return u.replace(/[?#].*$/, "");
}
function platformOfUrl(url) {
  const u = String(url || "");
  if (/tiktok\.com/i.test(u)) return "TikTok";
  if (/instagram\.com/i.test(u)) return "Instagram";
  if (/youtube\.com|youtu\.be/i.test(u)) return "YouTube";
  return "";
}
const cleanUrl = (s) => (/^https?:\/\//i.test(s) ? s.slice(0, 500) : "");
const hex32 = (s) => {
  const h = String(s == null ? "" : s).replace(/-/g, "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(h) ? h : "";
};

/* ---- campaign matching (pure) ----------------------------------------------------------------- */

/* sheetCampaigns: [{id, name, notionDatabaseId}]; dash: [{id, name, notionDatabaseId}];
   manual: [{sheetCampaignId, dashboardCampaignId ("" = sheet only)}].
   Order: staff choice, then Notion database id, then exact trimmed lowercase name when
   exactly one dashboard campaign matches, else "needs-match". Never guesses; two sheet
   campaigns that land on one dashboard campaign are both put on the list. */
function computeMatches(sheetCampaigns, dash, manual) {
  const dashList = (dash || []).filter((c) => c && c.id).map((c) => ({
    id: String(c.id), name: String(c.name || ""), db: hex32(c.notionDatabaseId)
  }));
  const dashById = new Map(dashList.map((c) => [c.id, c]));
  const man = new Map((manual || []).map((m) => [m.sheetCampaignId, m.dashboardCampaignId]));
  const brief = (c) => ({ id: c.id, name: c.name });
  const out = new Map();

  sheetCampaigns.forEach((sc) => {
    if (man.has(sc.id)) {
      const t = man.get(sc.id);
      if (t === "") { out.set(sc.id, { state: "sheet-only", by: "manual", dashboardCampaignId: null, candidates: [], reason: "" }); return; }
      if (dashById.has(t)) { out.set(sc.id, { state: "matched", by: "manual", dashboardCampaignId: t, candidates: [], reason: "" }); return; }
      /* the chosen campaign no longer exists: fall through to the automatic steps */
    }
    let cands = sc.notionDatabaseId ? dashList.filter((c) => c.db && c.db === sc.notionDatabaseId) : [];
    let by = "notion-db";
    if (!cands.length) {
      const n = norm(sc.name);
      cands = n ? dashList.filter((c) => norm(c.name) === n) : [];
      by = "name";
    }
    if (cands.length === 1) out.set(sc.id, { state: "matched", by, dashboardCampaignId: cands[0].id, candidates: [], reason: "" });
    else if (cands.length > 1) out.set(sc.id, { state: "needs-match", by: null, dashboardCampaignId: null, candidates: cands.map(brief), reason: "ambiguous" });
    else out.set(sc.id, { state: "needs-match", by: null, dashboardCampaignId: null, candidates: [], reason: "no-match" });
  });

  /* two sheet campaigns on one dashboard campaign: the automatic ones go to the list */
  const byTarget = new Map();
  out.forEach((m, id) => { if (m.state === "matched") { (byTarget.get(m.dashboardCampaignId) || byTarget.set(m.dashboardCampaignId, []).get(m.dashboardCampaignId)).push(id); } });
  byTarget.forEach((ids, target) => {
    if (ids.length < 2) return;
    ids.forEach((id) => {
      const m = out.get(id);
      if (m.by === "manual") return;
      out.set(id, { state: "needs-match", by: null, dashboardCampaignId: null, candidates: [brief(dashById.get(target))], reason: "shared" });
    });
  });
  return out;
}

/* ---- the snapshot --------------------------------------------------------------------------------- */

const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

/* raw: the whitelisted rows, already parsed.
   Returns the snapshot document (no _id) and the run counts. */
function buildSnapshot(raw, dash, manual, nowDate, intervalMin) {
  const checkedAt = nowDate.toISOString();

  /* Campaign Map: sheet campaign name -> Notion database id (only when the name is unique) */
  const mapByName = new Map(); const mapDup = new Set();
  raw.campaignMap.forEach((r) => {
    const k = norm(r.name);
    if (!k) return;
    if (mapByName.has(k)) mapDup.add(k); else mapByName.set(k, r.db);
  });
  mapDup.forEach((k) => mapByName.delete(k));

  const campaigns = []; const seenCp = new Set(); let dupCampaigns = 0;
  raw.campaigns.forEach((c) => {
    if (!c.id) return;
    if (seenCp.has(c.id)) { dupCampaigns++; return; }
    seenCp.add(c.id);
    campaigns.push({
      sheetCampaignId: c.id, name: c.name, startDate: c.startDate, endDate: c.endDate, status: c.status,
      notionDatabaseId: mapByName.get(norm(c.name)) || ""
    });
  });
  const cpById = new Map(campaigns.map((c) => [c.sheetCampaignId, c]));

  const ciMap = new Map();
  raw.campaignInfluencers.forEach((r) => { if (r.ciId && !ciMap.has(r.ciId)) ciMap.set(r.ciId, r); });
  const infMap = new Map();
  raw.influencers.forEach((r) => { if (r.id && !infMap.has(r.id)) infMap.set(r.id, r); });

  /* deliverables: one row per deliverable id, then one per post; newest last_scraped_at wins */
  const newer = (a, b) => (b.scrapedMs || -1) >= (a.scrapedMs || -1);
  let dupById = 0, dupByPost = 0;
  const byId = new Map(); const noId = [];
  raw.deliverables.forEach((d) => {
    if (!d.deliverableId) { noId.push(d); return; }
    const cur = byId.get(d.deliverableId);
    if (!cur) byId.set(d.deliverableId, d); else { dupById++; if (newer(cur, d)) byId.set(d.deliverableId, d); }
  });
  const byPost = new Map(); const anon = [];
  [...byId.values(), ...noId].forEach((d) => {
    const k = platformPostIdOf(d.postUrl);
    if (!k) { anon.push(d); return; }
    const cur = byPost.get(k);
    if (!cur) byPost.set(k, d); else { dupByPost++; if (newer(cur, d)) byPost.set(k, d); }
  });
  const deduped = [...byPost.values(), ...anon];

  /* per-campaign-tab engagement rate, looked up by post key then deliverable id */
  const erByKey = new Map(); const erById = new Map();
  raw.erRows.forEach((r) => {
    if (r.er == null) return;
    const k = platformPostIdOf(r.postUrl);
    if (k && !erByKey.has(k)) erByKey.set(k, r.er);
    if (r.deliverableId && !erById.has(r.deliverableId)) erById.set(r.deliverableId, r.er);
  });

  const posts = deduped.map((d) => {
    const ci = ciMap.get(d.ciId) || null;
    const inf = ci ? infMap.get(ci.influencerId) || null : null;
    const cp = ci ? cpById.get(ci.campaignId) || null : null;
    const key = platformPostIdOf(d.postUrl);
    let er = key && erByKey.has(key) ? erByKey.get(key) : null;
    if (er == null && d.deliverableId && erById.has(d.deliverableId)) er = erById.get(d.deliverableId);
    const lastScrapedAt = d.scrapedMs ? new Date(d.scrapedMs).toISOString() : null;
    const ageDays = d.scrapedMs ? Math.floor((nowDate.getTime() - d.scrapedMs) / DAY_MS) : null;
    return {
      deliverableId: d.deliverableId,
      sheetCampaignId: cp ? cp.sheetCampaignId : null,
      platformPostId: key,
      postUrl: d.postUrl,
      platform: (inf && inf.platform) || platformOfUrl(d.postUrl) || "",
      creator: inf ? { handle: inf.username, platform: inf.platform, followers: inf.followers } : null,
      type: d.type,
      postedDate: d.postedDate,
      views: d.views.value, likes: d.likes.value,
      comments: d.comments, shares: d.shares, saves: d.saves, reposts: d.reposts,
      er,
      lastScrapedAt,
      flags: {
        viewsUnread: d.views.unread, likesUnread: d.likes.unread,
        hasReading: d.views.value != null || d.likes.value != null,
        noCampaign: !cp, noCreator: !inf, noEr: er == null,
        readingAgeDays: ageDays, readingOld: ageDays != null && ageDays >= STALE_POST_DAYS, neverRead: !d.scrapedMs
      }
    };
  });
  posts.sort((a, b) => String(b.postedDate || "").localeCompare(String(a.postedDate || "")) || String(a.deliverableId).localeCompare(String(b.deliverableId)));

  const matches = computeMatches(campaigns.map((c) => ({ id: c.sheetCampaignId, name: c.name, notionDatabaseId: c.notionDatabaseId })), dash, manual);

  const statsOf = (list) => {
    const withReading = list.filter((p) => p.flags.hasReading);
    const ers = list.map((p) => p.er).filter((x) => x != null);
    const scraped = list.map((p) => p.lastScrapedAt).filter(Boolean).sort();
    return {
      posts: list.length, withReading: withReading.length,
      creators: new Set(list.map((p) => p.creator && (p.creator.platform + "|" + p.creator.handle)).filter(Boolean)).size,
      views: list.reduce((a, p) => a + (p.views || 0), 0),
      likes: list.reduce((a, p) => a + (p.likes || 0), 0),
      avgEr: mean(ers), erCount: ers.length,
      newestReadingAt: scraped.length ? scraped[scraped.length - 1] : null
    };
  };
  campaigns.forEach((c) => {
    c.match = matches.get(c.sheetCampaignId);
    c.stats = statsOf(posts.filter((p) => p.sheetCampaignId === c.sheetCampaignId));
  });

  const allScraped = posts.map((p) => p.lastScrapedAt).filter(Boolean).sort();
  const needsMatch = campaigns.filter((c) => c.match.state === "needs-match")
    .map((c) => ({ sheetCampaignId: c.sheetCampaignId, name: c.name, reason: c.match.reason, candidates: c.match.candidates }));
  const doc = {
    version: 1,
    checkedAt,
    newestReadingAt: allScraped.length ? allScraped[allScraped.length - 1] : null,
    intervalMin,
    timeZoneNote: "Dates from the sheet are read as UTC.",
    counts: {
      campaignMap: raw.campaignMap.length, campaigns: raw.campaigns.length, campaignInfluencers: raw.campaignInfluencers.length,
      influencers: raw.influencers.length, deliverables: raw.deliverables.length,
      erTabsRead: raw.erTabs.read, erTabsSkipped: raw.erTabs.skipped.length,
      posts: posts.length, creators: new Set(posts.map((p) => p.creator && (p.creator.platform + "|" + p.creator.handle)).filter(Boolean)).size,
      campaignsMatched: campaigns.filter((c) => c.match.state === "matched").length,
      campaignsNeedMatch: needsMatch.length,
      campaignsSheetOnly: campaigns.filter((c) => c.match.state === "sheet-only").length,
      postsWithoutCampaign: posts.filter((p) => p.flags.noCampaign).length,
      duplicateCampaignIds: dupCampaigns
    },
    duplicates: { byDeliverableId: dupById, byPost: dupByPost },
    erTabs: { read: raw.erTabs.read, skipped: raw.erTabs.skipped },
    totals: statsOf(posts),
    needsMatch,
    campaigns,
    posts
  };
  return doc;
}

/* ---- freshness, state and banner ---------------------------------------------------------------------- */

function hhmm(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC" : "";
}

/* green: checked within 2 intervals and newest reading within 48 h.
   red: the last run failed, or 7 days (checked or newest reading), or no data.
   amber: everything between. Thresholds are ASSUMED (PM plan 08, section 3). */
function freshness(snapshot, lastRun, intervalMin, nowMs) {
  if (!snapshot) return { level: "red", reason: "no-data", checkedAgeMin: null, newestReadingAgeHours: null };
  const checkedMs = Date.parse(snapshot.checkedAt);
  const newestMs = snapshot.newestReadingAt ? Date.parse(snapshot.newestReadingAt) : NaN;
  const checkedAgeMin = Math.max(0, Math.round((nowMs - checkedMs) / 60000));
  const newestReadingAgeHours = Number.isFinite(newestMs) ? Math.max(0, Math.round((nowMs - newestMs) / 3600000)) : null;
  const failed = !!(lastRun && lastRun.ok === false && !lastRun.dryRun);
  let level = "green", reason = "";
  if (checkedAgeMin > intervalMin * 2) { level = "amber"; reason = "check-late"; }
  if (newestReadingAgeHours == null || newestReadingAgeHours > GREEN_READING_HOURS) { level = "amber"; reason = reason || (newestReadingAgeHours == null ? "no-readings" : "readings-old"); }
  if (failed) { level = "red"; reason = "last-run-failed"; }
  else if (checkedAgeMin >= RED_DAYS * 1440) { level = "red"; reason = "check-very-late"; }
  else if (newestReadingAgeHours != null && newestReadingAgeHours >= RED_DAYS * 24) { level = "red"; reason = "readings-very-old"; }
  return { level, reason, checkedAgeMin, newestReadingAgeHours };
}

function describeState(o) {
  /* o: { enabled, offReason, dryRunCfg, snapshot, lastRun, lastDry } */
  if (!o.enabled) return { state: "off", banner: { kind: "off", text: OFF_TEXT }, showingDataFrom: null };
  const from = o.snapshot ? o.snapshot.checkedAt : null;
  const lr = o.lastRun;
  if (lr && lr.ok === false) {
    let text = lr.message || "The last read did not work. Nothing was updated.";
    if (lr.errorCode === "google-down") text = from ? "Google did not answer. Showing data from " + hhmm(from) + "." : "Google did not answer. There is no earlier data yet.";
    return { state: lr.errorCode || "failed", banner: { kind: lr.errorCode || "failed", text }, showingDataFrom: from };
  }
  if (!o.snapshot) {
    if (o.dryRunCfg) return { state: "dry-run", banner: { kind: "dry-run", text: "Live performance is in preview mode: it reads the sheet and stores nothing yet." }, showingDataFrom: null };
    return { state: "waiting", banner: { kind: "waiting", text: "Live performance is on. The first read has not finished yet." }, showingDataFrom: null };
  }
  return { state: "ok", banner: { kind: "ok", text: "" }, showingDataFrom: from };
}

/* ---- the job ------------------------------------------------------------------------------------------------ */

function createPerfSync(deps) {
  const d = deps;
  const now = d.now || (() => new Date());
  const logger = d.logger || console;
  const maxRows = d.maxRows || 5000;
  const scrub = makeScrub(d.sheetId);
  let running = false;
  let last = null;            // last LIVE run (memory; the store has the durable copy)
  let lastDry = null;         // last dry run: never stored
  let lastManualAt = 0;
  const lastManualBy = new Map();   // staff user -> time, when the route can name the user
  let matching = false;       // a staff match is being written: no run may start, and no second match

  function parseRows(rows, fields) {
    return rows.map((cells) => { const o = {}; fields.forEach((f, i) => { o[f.name] = f.read(cells[i]); }); return o; });
  }
  const T = (n) => (c) => cellText(c, n);

  async function readTab(ctx, spec, fields) {
    const found = await discover(ctx, spec.tab);
    const ids = pickColumns(found, spec.tab, spec.labels);
    const rows = await fetchColumns(ctx, spec.tab, ids, maxRows);
    return parseRows(rows, fields);
  }

  async function readCampaignMap(ctx) {
    /* no header labels: the first row is the header, the rest are data. Columns A and B by letter. */
    let rows;
    try { rows = await fetchColumns(ctx, CAMPAIGN_MAP_TAB, ["A", "B"], maxRows); } catch (err) {
      if (err instanceof PerfError && err.code === "query-error") throw new PerfError("tab-missing", "The tab '" + CAMPAIGN_MAP_TAB + "' was not found. Nothing was updated.");
      throw err;
    }
    const out = [];
    rows.forEach((cells) => {
      const name = cellText(cells[0], 200);
      const idText = cellText(cells[1], 80);
      if (!name || norm(name) === "campaign name") return;
      out.push({ name, db: hex32(idText) });
    });
    return out;
  }

  /* post_er from per-campaign tabs; optional: a tab that cannot be used is skipped and said so */
  async function readErTabs(ctx, campaignNames, startedMs) {
    const res = { rows: [], read: 0, skipped: [] };
    const seen = new Set(); const names = [];
    campaignNames.forEach((n) => { const k = norm(n); if (k && !seen.has(k)) { seen.add(k); names.push(n.trim()); } });
    if (names.length > MAX_ER_TABS) res.skipped.push({ tab: "(more than " + MAX_ER_TABS + " campaigns)", why: "tab-cap" });
    for (const tab of names.slice(0, MAX_ER_TABS)) {
      if (now().getTime() - startedMs > RUN_BUDGET_MS) { res.skipped.push({ tab, why: "time-budget" }); continue; }
      try {
        const found = await discover(ctx, tab);
        const erId = found.byLabel.get("post_er");
        if (!erId || found.dup.has("post_er")) { res.skipped.push({ tab, why: "no-post_er" }); continue; }
        const ids = [erId]; const fields = [{ name: "er", read: cellEr }];
        ["deliverable_id", "post_url"].forEach((l) => {
          const id = found.byLabel.get(l);
          if (id && !found.dup.has(l)) { ids.push(id); fields.push({ name: l === "post_url" ? "postUrl" : "deliverableId", read: l === "post_url" ? (c) => cleanUrl(cellText(c, 500)) : T(80) }); }
        });
        if (ids.length < 2) { res.skipped.push({ tab, why: "no-post-key" }); continue; }
        const rows = await fetchColumns(ctx, tab, ids, maxRows);
        res.rows.push(...parseRows(rows, fields));
        res.read++;
      } catch (err) {
        if (err instanceof PerfError && (err.code === "google-down" || err.code === "not-shared")) throw err;   // the sheet itself is unreachable: not a per-tab matter
        res.skipped.push({ tab, why: err instanceof PerfError ? err.code : "failed" });
      }
    }
    return res;
  }

  function entryBase(o) {
    return { at: now().toISOString(), trigger: o.trigger || "poll", dryRun: !!o.dryRun, ok: false };
  }

  async function run(opts) {
    const o = opts || {};
    if (running || matching) return Object.assign({}, last || {}, { busy: true });
    running = true;
    const startedMs = now().getTime();
    const dryRun = o.dryRun != null ? !!o.dryRun : !!d.dryRun;
    const entry = entryBase({ trigger: o.trigger, dryRun });
    try {
      const ctx = { fetchImpl: d.fetchImpl || fetch, sheetId: d.sheetId, queries: [] };
      const ws = await d.loadWorkspace();
      if (!ws || !ws.db) throw new PerfError("workspace", "The dashboard workspace could not be read, so campaigns cannot be matched. Nothing was updated.");
      const dash = Array.isArray(ws.db.campaigns) ? ws.db.campaigns.map((c) => ({ id: c && c.id, name: c && c.name, notionDatabaseId: c && c.notionDatabaseId })) : [];
      const manual = (await d.store.readMatches()) || [];

      const raw = {};
      raw.campaignMap = await readCampaignMap(ctx);
      raw.campaigns = await readTab(ctx, TABS.campaigns, [
        { name: "id", read: T(80) }, { name: "name", read: T(200) },
        { name: "startDate", read: (c) => isoDay(cellDate(c)) || cellText(c, 10) },
        { name: "endDate", read: (c) => isoDay(cellDate(c)) || cellText(c, 10) },
        { name: "status", read: T(40) }]);
      raw.campaignInfluencers = await readTab(ctx, TABS.campaignInfluencers, [
        { name: "ciId", read: T(80) }, { name: "campaignId", read: T(80) }, { name: "influencerId", read: T(80) }]);
      raw.influencers = await readTab(ctx, TABS.influencers, [
        { name: "id", read: T(80) }, { name: "platform", read: T(30) }, { name: "username", read: T(100) },
        { name: "followers", read: plainCount }]);
      raw.deliverables = await readTab(ctx, TABS.deliverables, [
        { name: "deliverableId", read: T(80) }, { name: "ciId", read: T(80) }, { name: "type", read: T(40) },
        { name: "postUrl", read: (c) => cleanUrl(cellText(c, 500)) },
        { name: "postedDate", read: (c) => isoDay(cellDate(c)) },
        { name: "likes", read: readCount }, { name: "comments", read: plainCount }, { name: "views", read: readCount },
        { name: "scrapedMs", read: (c) => { const x = cellDate(c); return x ? x.getTime() : 0; } },
        { name: "shares", read: plainCount }, { name: "saves", read: plainCount }, { name: "reposts", read: plainCount }]);
      const er = await readErTabs(ctx, raw.campaigns.map((c) => c.name), startedMs);
      raw.erRows = er.rows; raw.erTabs = { read: er.read, skipped: er.skipped };

      const snap = buildSnapshot(raw, dash, manual, now(), d.intervalMin || 30);
      entry.ok = true;
      entry.counts = snap.counts; entry.duplicates = snap.duplicates;
      entry.newestReadingAt = snap.newestReadingAt; entry.checkedAt = snap.checkedAt;
      entry.queries = ctx.queries.length;
      snap.rev = crypto.randomBytes(8).toString("hex");   // lets a later match prove it is editing THIS snapshot
      if (dryRun) {
        entry.needsMatch = snap.needsMatch;      // phase 0: counts and the unmatched list, nothing stored
      } else {
        await d.store.writeSnapshot(snap);       // one write swaps the whole snapshot in
      }
      return await finish(entry, dryRun);
    } catch (err) {
      const code = err instanceof PerfError ? err.code : "failed";
      entry.ok = false; entry.errorCode = code;
      entry.message = err instanceof PerfError ? scrub(err.message) : "The read failed unexpectedly. Nothing was updated.";
      logger.error("Performance sync failed (" + code + ").");
      return await finish(entry, dryRun);
    }
  }

  async function finish(entry, dryRun) {
    entry.durationMs = Math.max(0, now().getTime() - Date.parse(entry.at));
    if (dryRun) lastDry = entry;
    else {
      last = entry;
      try { await d.store.appendLog(entry); } catch (e) { logger.error("Performance sync: could not save the run log."); }
    }
    running = false;
    return entry;
  }

  /* a manual refresh: at most one per 5 minutes (dry runs included) */
  async function refresh(opts) {
    const t = now().getTime();
    if (running || matching) return { throttled: true, busy: true, retryAfterSec: 30 };
    const actor = opts && typeof opts.actor === "string" ? opts.actor.slice(0, 120) : "";
    const prev = actor && lastManualBy.has(actor) ? lastManualBy.get(actor) : 0;
    /* the global spacing stays; a named staff user is also held to it on their own */
    const gate = Math.max(lastManualAt, prev);
    if (gate && t - gate < MANUAL_MIN_MS) return { throttled: true, retryAfterSec: Math.ceil((MANUAL_MIN_MS - (t - gate)) / 1000) };
    lastManualAt = t;
    if (actor) { if (lastManualBy.size > 200) lastManualBy.clear(); lastManualBy.set(actor, t); }
    return run({ trigger: "manual", dryRun: opts && opts.dryRun ? true : undefined });
  }

  /* what the screens need, in one place */
  async function view() {
    let snapshot = null, log = null;
    try { snapshot = await d.store.readSnapshot(); } catch (e) { logger.error("Performance sync: could not read the snapshot."); }
    try { log = await d.store.readLog(); } catch (e) { logger.error("Performance sync: could not read the run log."); }
    const lastRun = last || (log && log.last) || null;
    const st = describeState({ enabled: true, dryRunCfg: !!d.dryRun, snapshot, lastRun });
    return { snapshot, lastRun, runs: (log && log.runs) || [], state: st, freshness: freshness(snapshot, lastRun, d.intervalMin || 30, now().getTime()) };
  }

  /* staff choice for one sheet campaign. dashboardCampaignId: a dashboard campaign id, or "" for "sheet only". */
  async function setMatch(sheetCampaignId, dashboardCampaignId) {
    /* never while a read runs, never while another match is being written, never in preview mode */
    if (d.dryRun) return { ok: false, status: 409, error: "Preview mode is on, so nothing is saved." };
    if (running) return { ok: false, status: 409, error: "A refresh is running, try again in a minute." };
    if (matching) return { ok: false, status: 409, error: "Another match is being saved, try again in a moment." };
    matching = true;                    // set before the first await: a run that starts now is told it is busy
    try {
      const snap = await d.store.readSnapshot();
      if (!snap) return { ok: false, status: 409, error: "There is no snapshot yet; wait for the first read." };
      const sc = snap.campaigns.find((c) => c.sheetCampaignId === sheetCampaignId);
      if (!sc) return { ok: false, status: 404, error: "That sheet campaign is not in the snapshot." };
      const ws = await d.loadWorkspace();
      const dash = ws && ws.db && Array.isArray(ws.db.campaigns) ? ws.db.campaigns : [];
      if (dashboardCampaignId !== "" && !dash.some((c) => c && c.id === dashboardCampaignId)) {
        return { ok: false, status: 400, error: "That dashboard campaign does not exist." };
      }
      const cur = (await d.store.readMatches()) || [];
      const list = cur.filter((m) => m.sheetCampaignId !== sheetCampaignId).concat([{ sheetCampaignId, dashboardCampaignId }]).slice(-2000);
      /* re-apply the joins to the stored snapshot without reading Google again */
      const matches = computeMatches(snap.campaigns.map((c) => ({ id: c.sheetCampaignId, name: c.name, notionDatabaseId: c.notionDatabaseId })),
        dash.map((c) => ({ id: c && c.id, name: c && c.name, notionDatabaseId: c && c.notionDatabaseId })), list);
      const oldRev = snap.rev;
      snap.campaigns.forEach((c) => { c.match = matches.get(c.sheetCampaignId); });
      snap.needsMatch = snap.campaigns.filter((c) => c.match.state === "needs-match")
        .map((c) => ({ sheetCampaignId: c.sheetCampaignId, name: c.name, reason: c.match.reason, candidates: c.match.candidates }));
      snap.counts.campaignsMatched = snap.campaigns.filter((c) => c.match.state === "matched").length;
      snap.counts.campaignsNeedMatch = snap.needsMatch.length;
      snap.counts.campaignsSheetOnly = snap.campaigns.filter((c) => c.match.state === "sheet-only").length;
      snap.rev = crypto.randomBytes(8).toString("hex");
      /* one conditional swap: if the stored snapshot is no longer the one read above, nothing is written */
      let swapped = true;
      if (typeof d.store.writeSnapshotIf === "function") swapped = await d.store.writeSnapshotIf(oldRev, snap);
      else await d.store.writeSnapshot(snap);
      if (!swapped) return { ok: false, status: 409, error: "A refresh is running, try again in a minute." };
      await d.store.writeMatches(list);
      return { ok: true, match: snap.campaigns.find((c) => c.sheetCampaignId === sheetCampaignId).match };
    } finally { matching = false; }
  }

  return { run, refresh, view, setMatch, lastRun: () => last, lastDryRun: () => lastDry, isRunning: () => running };
}

/* ---- storage: its own collections, nothing shared with the workspace ---------------------------------------------- */

function makeMongoStore(getClient, dbName) {
  const col = async (n) => {
    const c = await getClient();
    if (!c) throw new Error("no database connection");
    return c.db(dbName).collection(n);
  };
  const strip = (row) => { if (!row) return null; const { _id, ...rest } = row; return rest; };
  return {
    async readSnapshot() { return strip(await (await col("perf_snapshot")).findOne({ _id: "snapshot" })); },
    /* swap only if the stored snapshot still has the revision the caller read; true when it did */
    async writeSnapshotIf(expectedRev, doc) {
      const filter = expectedRev ? { _id: "snapshot", rev: expectedRev } : { _id: "snapshot", rev: { $exists: false } };
      const r = await (await col("perf_snapshot")).replaceOne(filter, Object.assign({ _id: "snapshot" }, doc));
      return !!(r && r.matchedCount > 0);
    },
    async writeSnapshot(doc) { await (await col("perf_snapshot")).replaceOne({ _id: "snapshot" }, Object.assign({ _id: "snapshot" }, doc), { upsert: true }); },
    async readLog() { return strip(await (await col("perf_sync_log")).findOne({ _id: "log" })); },
    async appendLog(entry) {
      await (await col("perf_sync_log")).updateOne({ _id: "log" }, { $set: { last: entry }, $push: { runs: { $each: [entry], $slice: -LOG_KEEP } } }, { upsert: true });
    },
    async readMatches() { const r = await (await col("perf_match")).findOne({ _id: "manual" }); return (r && r.matches) || []; },
    async writeMatches(list) { await (await col("perf_match")).updateOne({ _id: "manual" }, { $set: { matches: list } }, { upsert: true }); }
  };
}

/* ---- routes (all staff only) ------------------------------------------------------------------------------------------- */

/* get() -> { perf, off, cfg }. When the job is off every route answers 503 with
   the reason (an env var NAME, never a value). requireStaff answers 401/403 first. */
function registerRoutes(app, requireStaff, get) {
  const offReply = (res, g) => res.status(503).json({ error: OFF_TEXT, reason: g.off, state: "off" });
  /* every handler: an error becomes one plain, staff-safe answer. Nothing from the error
     (message, stack, url, sheet id) is returned or logged. */
  const safe = (fn) => requireStaff(async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error("Performance route failed.");
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong on the server. Try again in a minute." });
    }
  });
  const strId = (v) => typeof v === "string" && v.length > 0 && v.length <= 80;

  app.get("/api/perf/status", safe(async (req, res) => {
    const g = get();
    if (!g.perf) return offReply(res, g);
    const v = await g.perf.view();
    const s = v.snapshot;
    const dry = g.perf.lastDryRun();
    return res.json({
      ok: true, enabled: true, dryRun: !!g.cfg.dryRun, intervalMin: g.cfg.intervalMin, maxRows: g.cfg.maxRows,
      state: v.state.state, banner: v.state.banner, showingDataFrom: v.state.showingDataFrom,
      freshness: v.freshness,
      checkedAt: s ? s.checkedAt : null, newestReadingAt: s ? s.newestReadingAt : null,
      counts: s ? s.counts : null, duplicates: s ? s.duplicates : null, erTabs: s ? s.erTabs : null,
      unmatched: s ? s.needsMatch : [],
      lastRun: v.lastRun, runs: v.runs.slice(-10),
      lastDryRun: dry
    });
  }));

  app.get("/api/perf/snapshot", safe(async (req, res) => {
    const g = get();
    if (!g.perf) return offReply(res, g);
    const v = await g.perf.view();
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, state: v.state.state, banner: v.state.banner, showingDataFrom: v.state.showingDataFrom, freshness: v.freshness, snapshot: v.snapshot });
  }));

  app.post("/api/perf/refresh", safe(async (req, res) => {
    const g = get();
    if (!g.perf) return offReply(res, g);
    const b = req.body || {};
    const out = await g.perf.refresh({ dryRun: b.dryRun === true, actor: typeof req.staffEmail === "string" ? req.staffEmail : "" });   // a request can only make a run MORE careful
    if (out && out.throttled) {
      return res.status(429).json({ error: out.busy ? "A read is already running." : "A refresh was started a moment ago. Try again in a few minutes.", retryAfterSec: out.retryAfterSec });
    }
    return res.json({ ok: out.ok === true, run: out });
  }));

  app.post("/api/perf/match", safe(async (req, res) => {
    const g = get();
    if (!g.perf) return offReply(res, g);
    const b = req.body || {};
    if (!strId(b.sheetCampaignId)) return res.status(400).json({ error: "sheetCampaignId is needed." });
    let target;
    if (b.sheetOnly === true) target = "";
    else if (strId(b.dashboardCampaignId)) target = b.dashboardCampaignId;
    else return res.status(400).json({ error: "dashboardCampaignId or sheetOnly:true is needed." });
    const out = await g.perf.setMatch(b.sheetCampaignId, target);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    return res.json({ ok: true, match: out.match });
  }));
}

module.exports = {
  parseConfig, createPerfSync, makeMongoStore, registerRoutes, computeMatches, buildSnapshot, freshness, describeState,
  parseGviz, cellDate, cellEr, readCount, platformPostIdOf, makeScrub, hex32, gvizUrl, googleGet,
  PerfError, TABS, MAX_BYTES, TIMEOUT_MS, MANUAL_MIN_MS, OFF_TEXT
};
