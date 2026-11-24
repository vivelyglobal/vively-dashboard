"use strict";
/* ===================================================================
   Brand view: one private, view-only link per campaign.

   Why this is its own store and not "partner link, narrower":
     - The partner route loads the WHOLE workspace document (every creator's
       email, address and bank details) on every hit and filters it in code.
       One filter bug there leaks everything. The routes in this file never
       read the workspace. They read exactly two collections:

         client_links   one per campaign: sha256 of the token, expiry, revoked
         client_views   one per link: the allow-listed copy a brand may see

     - client_views is WRITTEN on the server after a staff save succeeds
       (afterSave), and when staff press Rebuild. Nothing else writes it.
       A failed write never fails the save; it is counted, kept in a status
       object staff can read, and retried by the next save.

   Fields a brand can ever receive are the lists below. Anything not named
   here is not in the stored copy, so it cannot be in a response.

   The link is a bearer token. It is shown ONCE, when staff create or
   regenerate it; only its sha256 is stored. Unknown, expired, revoked and
   replaced tokens all answer the same 404.

   EXTENSION POINT (passcode, not built in v1): resolveLink() is the one
   place that decides whether a token may read. A passcode or magic-link
   check belongs there, after the token matches and before the view loads.
   =================================================================== */

const crypto = require("crypto");

const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const LINK_ID_RE = /^lnk_[A-Za-z0-9_-]{6,40}$/;
const DAY = 86400000;

/* ---- what a brand may receive ------------------------------------- */
const CLIENT_ROW_FIELDS = ["handle", "igUrl", "bucket", "visitDate", "visitTime", "people", "contentUrl"];
const CLIENT_CAMPAIGN_FIELDS = ["name", "start", "end", "status", "headcount"];
const CLIENT_COUNT_FIELDS = ["confirmed", "waiting", "posted", "total"];
const CLIENT_TOP_FIELDS = ["ok", "updatedAt", "campaign", "counts", "rows"];

/* per-creator bucket, from the partner status label the server already uses.
   Anything else (contacted, waiting approval, rejected, declined) is not
   shown to a brand in v1. */
const BUCKET_BY_STATUS_EN = {
  "Confirmed": "confirmed",
  "Waiting For upload": "waiting",
  "Uploaded": "posted"
};

const CAMPAIGN_BUCKET = {
  planning:   { key: "preparing",   en: "Preparing",   ko: "준비 중" },
  outreach:   { key: "preparing",   en: "Preparing",   ko: "준비 중" },
  confirming: { key: "preparing",   en: "Preparing",   ko: "준비 중" },
  production: { key: "in_progress", en: "In progress", ko: "제작 중" },
  live:       { key: "live",        en: "Live",        ko: "진행 중" },
  wrapped:    { key: "completed",   en: "Completed",   ko: "종료" }
};

const sha256Hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function digestEq(aHex, bHex) {
  const a = Buffer.from(String(aHex), "hex"), b = Buffer.from(String(bHex), "hex");
  return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newToken = () => crypto.randomBytes(24).toString("base64url");
const newLinkId = () => "lnk_" + crypto.randomBytes(9).toString("base64url");

const clean = (v, max) => typeof v === "string"
  ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max) : "";
const isoDay = (v) => { const m = String(v || "").match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ""; };
const pick = (obj, fields) => { const o = {}; fields.forEach((k) => { if (obj[k] !== undefined) o[k] = obj[k]; }); return o; };
/* Free text a brand must not receive unchecked. Invisible and direction
   characters are removed as well as control characters. */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤﻿]/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/* A URL carrying credentials (scheme://user:pass@host/...) is removed whole.
   A phone-number-like run is 7 or more digits with optional spaces, dashes,
   dots, parentheses and a leading plus. Numbers under 7 digits ("Gangnam 12")
   stay, and so do plain dates (2026-11-24, 2026 11 24, 24.11.2026). */
const USERINFO_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@\S*/gi;
const PHONE_OR_DATE_RE = /(\b\d{4}[-./ ]\d{1,2}[-./ ]\d{1,2}\b|\b\d{1,2}[-./]\d{1,2}[-./]\d{4}\b)|([+(]?\d(?:[\s.\-()]*\d){6,})/g;
const EDGE_JUNK_RE = /^[\s\-–—:,;/|·]+|[\s\-–—:,;/|·]+$/g;
function plainText(v, max) {
  if (typeof v !== "string") return "";
  let s = v.slice(0, 2000).replace(INVISIBLE_RE, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, " ");
  s = s.replace(USERINFO_URL_RE, " ").replace(EMAIL_RE, " ").replace(/\s+/g, " ");
  const before = s;
  s = s.replace(PHONE_OR_DATE_RE, (m, date) => (date ? m : ""));
  if (s !== before) s = s.replace(/\s+/g, " ").replace(EDGE_JUNK_RE, "");
  return clean(s.trim(), max).trim();
}

/* Instagram handle: letters, digits, dots, underscores, 1 to 30. A leading @
   is stripped; an instagram.com profile link is reduced to its handle.
   Anything else (a name with a space, Hangul, an email, a post link) returns
   "" and the caller shows a neutral label instead. */
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "web"]);
function igHandle(raw) {
  let s = typeof raw === "string" ? raw.replace(INVISIBLE_RE, "").trim() : "";
  if (!s || s.length > 300) return "";
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/i);
  if (m) s = m[1];
  s = s.replace(/^@/, "");
  if (!HANDLE_RE.test(s) || !/[A-Za-z0-9]/.test(s) || IG_RESERVED.has(s.toLowerCase())) return "";
  return s;
}

/* A post link: https or http, one of three platforms, no credentials, port,
   fragment or query. The path must match that platform's post shape and is
   REBUILT from the matched id, never passed through, so text cannot ride
   along in the path (instagram.com/Kim%20Minji is dropped). Only YouTube's
   "v" id survives from the query. Anything else returns "". */
const IG_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const TT_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const IG_PATH_RE = /^\/(p|reel|tv)\/([A-Za-z0-9_-]{5,40})\/?$/;
const TT_PATH_RE = /^\/@([A-Za-z0-9._]{1,40})\/video\/(\d{5,25})\/?$/;
const YT_SHORTS_RE = /^\/shorts\/([A-Za-z0-9_-]{6,20})\/?$/;
const YT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const YTBE_PATH_RE = /^\/([A-Za-z0-9_-]{6,20})\/?$/;
function postUrl(u, safeUrl) {
  const s = safeUrl(u);
  if (!s) return "";
  try {
    const url = new URL(s);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password || url.port) return "";
    const host = url.hostname.toLowerCase(), path = url.pathname;
    const base = url.protocol + "//" + host;
    let m, out = "";
    if (IG_HOSTS.has(host)) { m = path.match(IG_PATH_RE); if (m) out = base + "/" + m[1] + "/" + m[2] + "/"; }
    else if (TT_HOSTS.has(host)) { m = path.match(TT_PATH_RE); if (m) out = base + "/@" + m[1] + "/video/" + m[2]; }
    else if (YT_HOSTS.has(host)) {
      if (path === "/watch") { const v = url.searchParams.get("v"); if (v && YT_ID_RE.test(v)) out = base + "/watch?v=" + v; }
      else if ((m = path.match(YT_SHORTS_RE))) out = base + "/shorts/" + m[1];
    } else if (host === "youtu.be") { m = path.match(YTBE_PATH_RE); if (m) out = base + "/" + m[1]; }
    return out && out.length <= 300 ? out : "";
  } catch (e) { return ""; }
}

/* ---- the projection (pure) ----------------------------------------
   Builds the brand copy of ONE campaign out of the workspace. Returns null
   when the campaign is missing or its id is claimed twice (fail closed:
   showing nothing is recoverable, showing the wrong campaign is not).
   `h` carries the server's own status / visit / content rules, so there is
   one copy of them. */
function buildClientView(db, campaignId, h) {
  const all = (db && Array.isArray(db.campaigns)) ? db.campaigns : [];
  const same = all.filter((c) => c && c.id === campaignId);
  if (same.length !== 1) return null;
  const cp = same[0];
  const byCreator = Object.fromEntries(((db && db.creators) || []).filter(Boolean).map((c) => [c.id, c]));

  const inCampaign = ((db && db.participants) || []).filter((p) => p && p.campaignId === campaignId);
  /* "Creator N": numbered ONLY among the creators this brand is shown, in a
     fixed order (by internal key), so a number never reveals how many rows
     were hidden or where they sit. A hidden row appearing or disappearing
     changes no number. A shown creator joining or leaving can shift others. */
  const keyOf = (p) => String(p.creatorId || p.id || "");
  const shownKeys = [...new Set(inCampaign.filter((p) => BUCKET_BY_STATUS_EN[(h.statusOf(p) || {}).en]).map(keyOf))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const labelOf = new Map(shownKeys.map((k, i) => [k, "Creator " + (i + 1)]));

  const rows = inCampaign.map((p) => {
    const bucket = BUCKET_BY_STATUS_EN[(h.statusOf(p) || {}).en];
    if (!bucket) return null;
    const cr = byCreator[p.creatorId] || {};
    const bare = igHandle(cr.handle);
    const handle = bare ? "@" + bare : labelOf.get(keyOf(p)) || "Creator";
    /* A TikTok link carries "@user" in its path. When the handle was refused
       (the brand sees "Creator N") that path could carry the very name we
       hid, so the link goes too. Instagram and YouTube post paths hold no handle. */
    let contentUrl = postUrl(h.contentUrl(db, p), h.safeUrl);
    if (!bare && contentUrl.indexOf("/@") !== -1) contentUrl = "";
    const m = String(h.visitSlot(p) || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/);
    const people = Math.floor(Number(p.headcount));
    return pick({
      handle,
      igUrl: bare ? "https://www.instagram.com/" + bare + "/" : "",
      bucket,
      visitDate: m ? m[1] : "",
      visitTime: m && m[2] ? m[2] : "",
      people: Number.isFinite(people) && people >= 1 && people <= 50 ? people : 0,
      contentUrl
    }, CLIENT_ROW_FIELDS);
  }).filter(Boolean);

  rows.sort((a, b) => (a.visitDate || "9999").localeCompare(b.visitDate || "9999") ||
    (a.visitTime || "").localeCompare(b.visitTime || "") || a.handle.localeCompare(b.handle));

  const counts = { confirmed: 0, waiting: 0, posted: 0, total: rows.length };
  rows.forEach((r) => { counts[r.bucket]++; });
  const target = Math.floor(Number(cp.targetCreators));
  const sb = CAMPAIGN_BUCKET[cp.status] || CAMPAIGN_BUCKET.planning;
  return {
    campaign: pick({
      name: plainText(cp.name, 100) || "Campaign",
      start: isoDay(cp.start),
      end: isoDay(cp.end),
      status: { key: sb.key, en: sb.en, ko: sb.ko },
      headcount: Number.isFinite(target) && target > 0 && target < 100000 ? target : 0
    }, CLIENT_CAMPAIGN_FIELDS),
    counts: pick(counts, CLIENT_COUNT_FIELDS),
    rows
  };
}

/* ---- link state ---------------------------------------------------- */
function linkStatus(link, nowMs) {
  if (!link) return "none";
  if (link.revokedAt) return "revoked";
  const t = Date.parse(link.expiresAt);
  if (!Number.isFinite(t) || t <= nowMs) return "expired";    /* unreadable date fails closed */
  return "active";
}

/* ---- factory -------------------------------------------------------
   deps: getMongoClient, MONGODB_DB, MONGODB_URI, loadWorkspaceDoc (staff
   routes and Rebuild only), getWorkspaceRevision (revision number only),
   requireStaff, rateLimiter, clientIp, helpers {statusOf, visitSlot,
   contentUrl, safeUrl}, pageFile, ttlDays, now, log. */
function createClientViews(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const ttlDays = Math.min(365, Math.max(1, Math.floor(Number(deps.ttlDays)) || 90));
  const h = deps.helpers;
  const writeTimeoutMs = deps.writeTimeoutMs || 4000;

  const state = {
    attempts: 0, failures: 0,
    lastAttemptAt: null, lastOkAt: null, lastRevision: null,
    lastError: null, lastCounts: { links: 0, written: 0, removed: 0, failed: 0, deferred: 0, skipped: 0 }
  };

  let indexed = false;
  async function cols() {
    if (!deps.MONGODB_URI) return null;
    const client = await deps.getMongoClient();
    if (!client) return null;
    const d = client.db(deps.MONGODB_DB);
    const links = d.collection("client_links"), views = d.collection("client_views");
    if (!indexed) {
      indexed = true;
      try {
        await links.createIndex({ tokenHash: 1 }, { unique: true });
        await links.createIndex({ campaignId: 1 }, { unique: true });
      } catch (e) { indexed = false; log.error("client_links index not ensured:", e && e.message); }
    }
    return { links, views };
  }

  /* One view write. The filter makes a slow older save unable to replace a
     newer view: when the stored builtRevision is higher, nothing matches and
     the upsert's insert hits the duplicate _id, which is ignored. Returns
     true when written, false when skipped because a newer view is there. */
  async function writeView(views, linkId, built, revision, savedAt, force, reset) {
    const doc = { campaignId: built.campaignId, builtRevision: revision, builtAt: new Date(now()).toISOString(),
      sourceSavedAt: savedAt || null, payload: { campaign: built.campaign, counts: built.counts, rows: built.rows } };
    try {
      /* force (staff Rebuild): may replace a view of the SAME revision, but
         never a newer one (a save may have landed since Rebuild read the
         workspace). One upsert, so a failure leaves the previous copy. */
      /* reset (staff, explicit): the stored revision is AHEAD of the workspace
         (backup restore), so the revision guard is dropped for this one write. */
      const filter = reset ? { _id: linkId } : { _id: linkId, builtRevision: force ? { $lte: revision } : { $lt: revision } };
      await views.updateOne(filter, { $set: doc }, { upsert: true });
      return true;
    } catch (err) {
      if (err && err.code === 11000) return false;         /* a newer view is already there */
      throw err;
    }
  }

  /* Rebuild every live link's view from `db` (the workspace as just saved,
     or as just read by Rebuild). Dead links lose their view. */
  async function rebuildFromDb(db, revision, savedAt, opts) {
    const c = await cols();
    if (!c) return { links: 0, written: 0, removed: 0, failed: 0, deferred: 0, skipped: 0, notConfigured: true };
    const reset = !!(opts && opts.reset), force = !!(opts && opts.force) || reset;
    const links = await c.links.find({}).toArray();
    const out = { links: links.length, written: 0, removed: 0, failed: 0, deferred: 0, skipped: 0, reset: 0 };
    const stale = [];
    /* pass 1: upsert every live view, one document at a time. Nothing is
       deleted here, so a failure midway cannot take a brand page down. */
    for (const l of links) {
      try {
        const live = linkStatus(l, now()) === "active";
        const built = live ? buildClientView(db, l.campaignId, h) : null;
        if (!built) { stale.push(l); continue; }
        built.campaignId = l.campaignId;
        let ahead = false;
        if (reset) { const old = await c.views.findOne({ _id: l._id }); ahead = !!(old && old.builtRevision > revision); }
        if (await writeView(c.views, l._id, built, revision, savedAt, force, reset)) { out.written++; if (ahead) out.reset++; }
        else out.skipped++;                                 /* a newer view is already stored */
      } catch (err) { out.failed++; }
    }
    /* pass 2: stale views go only after every upsert succeeded. (A revoked
       link is refused by resolveLink whether or not its copy is still here.) */
    /* A skip means this read of the workspace is older than a stored view, so
       "no longer buildable" may only be old news: keep every view then. */
    if (out.failed || out.skipped) { out.deferred = stale.length; return out; }
    for (const l of stale) {
      try { await c.views.deleteOne({ _id: l._id }); out.removed++; } catch (err) { out.failed++; }
    }
    return out;
  }

  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    if (t.unref) t.unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  /* Called by the save path AFTER the compare-and-set write succeeded.
     Never throws and never rejects: a projection problem must not cost
     anyone their save. */
  async function afterSave(db, revision, savedAt) {
    state.attempts++; state.lastAttemptAt = new Date(now()).toISOString();
    try {
      if (!db || !Array.isArray(db.campaigns)) return;
      const r = await withTimeout(rebuildFromDb(db, revision, savedAt), writeTimeoutMs);
      state.lastCounts = { links: r.links, written: r.written, removed: r.removed, failed: r.failed, deferred: r.deferred || 0, skipped: r.skipped || 0 };
      if (r.failed) {
        state.failures++; state.lastError = r.failed + " view write(s) failed";
        log.error("Client views: %d of %d view write(s) failed; will retry on the next save.", r.failed, r.links);
      } else {
        state.lastOkAt = state.lastAttemptAt; state.lastRevision = revision; state.lastError = null;
      }
    } catch (err) {
      state.failures++;
      state.lastError = "projection failed (" + String((err && (err.code || err.name)) || "error").slice(0, 40) + ")";
      log.error("Client views: projection skipped on this save (%s).", state.lastError);
    }
  }

  /* The single decision point for "may this token read". Same null for
     unknown, revoked, expired and replaced. A passcode check would go here. */
  async function resolveLink(c, token) {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const want = sha256Hex(token);
    const link = await c.links.findOne({ tokenHash: want });
    if (!link || !digestEq(want, link.tokenHash)) return null;
    if (linkStatus(link, now()) !== "active") return null;
    return link;
  }

  /* ---- headers: the token is in the URL, so nothing may cache, frame,
     index or leak it through Referer. Set before the route runs. */
  function clientHeaders(req, res, next) {
    res.set({
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow"
    });
    next();
  }

  const readIp = deps.rateLimiter({ windowMs: 60000, max: 60 });
  const readTok = deps.rateLimiter({ windowMs: 60000, max: 30 });
  function limited(req, res) {
    const ok = readIp("c|" + deps.clientIp(req)) &&
      (!TOKEN_RE.test(String(req.params.token || "")) || readTok("c|" + sha256Hex(req.params.token).slice(0, 24)));
    if (ok) return false;
    res.set("Retry-After", "60");
    res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
    return true;
  }
  const NOT_FOUND = { error: "This link is not valid, or has been turned off." };

  function publicLink(l, view, wsRevision) {
    return {
      id: l._id, campaignId: l.campaignId, status: linkStatus(l, now()),
      createdAt: l.createdAt || null, expiresAt: l.expiresAt || null, revokedAt: l.revokedAt || null,
      lastOpenedAt: l.lastOpenedAt || null,
      viewBuiltAt: view ? view.builtAt || null : null,
      viewRevision: view ? view.builtRevision : null,
      stale: linkStatus(l, now()) === "active" && Number.isFinite(wsRevision) &&
        (!view || !(view.builtRevision >= wsRevision))
    };
  }

  function mount(app) {
    /* ---------------- brand side (no staff session, no workspace) ---------------- */
    app.use("/api/client", clientHeaders);
    app.use("/c", clientHeaders);

    app.get("/api/client/:token", async (req, res) => {
      if (limited(req, res)) return;
      if (!deps.MONGODB_URI) return res.status(503).json({ error: "Not configured." });
      try {
        const c = await cols();
        const link = c && await resolveLink(c, req.params.token);
        if (!link) return res.status(404).json(NOT_FOUND);
        const view = await c.views.findOne({ _id: link._id });
        if (!view || !view.payload) return res.status(404).json(NOT_FOUND);
        const t = now();
        if (!link.lastOpenedAt || t - Date.parse(link.lastOpenedAt) > 60000) {
          c.links.updateOne({ _id: link._id }, { $set: { lastOpenedAt: new Date(t).toISOString() } })
            .catch(() => { /* a missed timestamp is not worth a failed page */ });
        }
        const p = view.payload;
        return res.json({ ok: true, updatedAt: view.builtAt || null,
          campaign: p.campaign, counts: p.counts, rows: p.rows });
      } catch (err) {
        log.error("GET /api/client failed:", err && err.message);
        return res.status(502).json({ error: "Could not reach the database." });
      }
    });

    app.get("/c/:token", (req, res) => { res.sendFile(deps.pageFile); });

    /* ---------------- staff side ---------------- */
    /* create and regenerate carry the raw token: nothing may cache them */
    app.use("/api/client-links", (req, res, next) => {
      res.set({ "Cache-Control": "no-store, max-age=0", "Pragma": "no-cache" });
      next();
    });
    const needDb = (res) => {
      if (deps.MONGODB_URI) return false;
      res.status(503).json({ error: "Database not configured on the server yet." });
      return true;
    };

    app.get("/api/client-links", deps.requireStaff(async (req, res) => {
      if (needDb(res)) return;
      try {
        const c = await cols();
        const links = await c.links.find({}).toArray();
        const wsRev = await deps.getWorkspaceRevision();
        const out = [];
        for (const l of links) out.push(publicLink(l, await c.views.findOne({ _id: l._id }), wsRev));
        return res.json({ ok: true, ttlDays, workspaceRevision: wsRev, projection: { ...state }, links: out });
      } catch (err) {
        log.error("GET /api/client-links failed:", err && err.message);
        return res.status(502).json({ error: "Could not reach the database." });
      }
    }));

    app.get("/api/client-links/status", deps.requireStaff(async (req, res) => {
      if (needDb(res)) return;
      try {
        const wsRev = await deps.getWorkspaceRevision();
        const c = await cols();
        const links = await c.links.find({}).toArray();
        const rows = [];
        for (const l of links) {
          if (linkStatus(l, now()) !== "active") continue;
          const v = await c.views.findOne({ _id: l._id });
          rows.push({ id: l._id, builtRevision: v ? v.builtRevision : null, builtAt: v ? v.builtAt : null,
            stale: !v || !(v.builtRevision >= wsRev) });
        }
        const ahead = rows.filter((r) => Number.isFinite(r.builtRevision) && Number.isFinite(wsRev) && r.builtRevision > wsRev).length;
        return res.json({ ok: true, workspaceRevision: wsRev, projection: { ...state },
          staleCount: rows.filter((r) => r.stale).length, aheadCount: ahead,
          note: ahead ? ahead + " view(s) are ahead of the workspace revision (usually after a backup restore). Plain Rebuild skips them. API only: POST /api/client-links/rebuild with {\"resetRevision\": true} rewrites them from the current workspace." : null,
          links: rows });
      } catch (err) {
        log.error("GET /api/client-links/status failed:", err && err.message);
        return res.status(502).json({ error: "Could not reach the database." });
      }
    }));

    /* mint (create, or re-issue for a campaign that already has a row) */
    async function issue(req, res, existing) {
      const c = await cols();
      const doc = await deps.loadWorkspaceDoc();
      const campaignId = existing ? existing.campaignId : clean(req.body && req.body.campaignId, 120);
      if (!campaignId) return res.status(400).json({ error: "Pick a campaign." });
      const built = buildClientView((doc && doc.db) || {}, campaignId, h);
      if (!built) return res.status(404).json({ error: "That campaign was not found, or its id is not unique." });
      built.campaignId = campaignId;
      const token = newToken();
      const nowIso = new Date(now()).toISOString();
      const expiresAt = new Date(now() + ttlDays * DAY).toISOString();
      let link;
      if (existing) {
        await c.links.updateOne({ _id: existing._id }, { $set: { tokenHash: sha256Hex(token), rotatedAt: nowIso,
          expiresAt, revokedAt: null, lastOpenedAt: null } });
        link = Object.assign({}, existing, { tokenHash: sha256Hex(token), rotatedAt: nowIso, expiresAt, revokedAt: null, lastOpenedAt: null });
      } else {
        link = { _id: newLinkId(), tokenHash: sha256Hex(token), campaignId, createdAt: nowIso, expiresAt,
          revokedAt: null, lastOpenedAt: null,
          createdBy: String((req.session && req.session.email) || "").slice(0, 120) };
        try { await c.links.insertOne(link); } catch (err) {
          if (err && err.code === 11000) return res.status(409).json({ error: "That campaign already has a link. Use Regenerate." });
          throw err;
        }
      }
      /* the copy is written now, so the first open is not empty. If this
         write fails the link exists and Rebuild now fills it in. */
      let viewReady = true;
      try {
        /* a view for a re-issued link must replace the old one whatever its revision */
        await c.views.deleteOne({ _id: link._id });
        await writeView(c.views, link._id, built, Number((doc && doc.revision) || 0), doc && doc.savedAt);
      } catch (err) { viewReady = false; log.error("Client views: first view write failed."); }
      return res.json({ ok: true, token, path: "/c/" + token, viewReady,
        link: publicLink(link, null, NaN) });
    }

    app.post("/api/client-links", deps.requireStaff(async (req, res) => {
      if (needDb(res)) return;
      try {
        const c = await cols();
        const cid = clean(req.body && req.body.campaignId, 120);
        if (cid && await c.links.findOne({ campaignId: cid })) {
          return res.status(409).json({ error: "That campaign already has a link. Use Regenerate." });
        }
        return await issue(req, res, null);
      } catch (err) {
        log.error("POST /api/client-links failed:", err && err.message);
        return res.status(502).json({ error: "Could not create the link." });
      }
    }));

    const byId = async (req, res) => {
      const id = String(req.params.id || "");
      if (!LINK_ID_RE.test(id)) { res.status(404).json({ error: "No such link." }); return null; }
      const c = await cols();
      const l = await c.links.findOne({ _id: id });
      if (!l) { res.status(404).json({ error: "No such link." }); return null; }
      return { c, l };
    };

    app.post("/api/client-links/:id/regenerate", deps.requireStaff(async (req, res) => {
      if (needDb(res)) return;
      try {
        const f = await byId(req, res);
        if (!f) return;
        return await issue(req, res, f.l);
      } catch (err) {
        log.error("POST /api/client-links regenerate failed:", err && err.message);
        return res.status(502).json({ error: "Could not regenerate the link." });
      }
    }));

    /* revoke: the link row says revoked (checked on every request) AND the
       brand copy is deleted, so neither path can serve it. */
    app.post("/api/client-links/:id/revoke", deps.requireStaff(async (req, res) => {
      if (needDb(res)) return;
      try {
        const f = await byId(req, res);
        if (!f) return;
        if (!f.l.revokedAt) await f.c.links.updateOne({ _id: f.l._id }, { $set: { revokedAt: new Date(now()).toISOString() } });
        await f.c.views.deleteOne({ _id: f.l._id });
        return res.json({ ok: true });
      } catch (err) {
        log.error("POST /api/client-links revoke failed:", err && err.message);
        return res.status(502).json({ error: "Could not revoke the link." });
      }
    }));

    /* staff-only backfill: read the workspace once and rebuild every view */
    app.post("/api/client-links/rebuild", deps.requireStaff(async (req, res) => {
      if (needDb(res)) return;
      try {
        const doc = await deps.loadWorkspaceDoc();
        if (!doc || !doc.db) return res.status(404).json({ error: "No workspace to read yet." });
        const rev = Number(doc.revision || 0);
        const t0 = new Date(now()).toISOString();
        const c = await cols();
        /* force: a rebuild may replace a same-revision view. Each view is one
           upsert and nothing is cleared first, so a failure keeps the old copy. */
        const reset = !!(req.body && req.body.resetRevision === true);   /* strict true; default unchanged */
        const r = await rebuildFromDb(doc.db, rev, doc.savedAt, { force: true, reset });
        state.attempts++; state.lastAttemptAt = t0;
        state.lastCounts = { links: r.links, written: r.written, removed: r.removed, failed: r.failed, deferred: r.deferred || 0, skipped: r.skipped || 0 };
        if (r.failed) { state.failures++; state.lastError = r.failed + " view write(s) failed"; }
        else {
          state.lastOkAt = t0; state.lastError = null;
          if (!r.skipped) state.lastRevision = rev;          /* skipped: newer views exist, keep the higher mark */
        }
        return res.json({ ok: !r.failed, ...state.lastCounts, error: state.lastError,
          ...(reset ? { resetRevision: true, reset: r.reset || 0 } : {}),
          note: r.skipped ? r.skipped + " view(s) left as they were: a newer save is already shown. Press Rebuild now again. If this repeats and the status shows views ahead of the workspace (after a backup restore), ask engineering to run Rebuild with resetRevision." : null });
      } catch (err) {
        log.error("POST /api/client-links/rebuild failed:", err && err.message);
        return res.status(502).json({ error: "Could not rebuild." });
      }
    }));
  }

  return { mount, afterSave, rebuildFromDb, resolveLink, state, clientHeaders };
}

module.exports = {
  createClientViews, buildClientView, linkStatus, sha256Hex,
  CLIENT_ROW_FIELDS, CLIENT_CAMPAIGN_FIELDS, CLIENT_COUNT_FIELDS, CLIENT_TOP_FIELDS,
  BUCKET_BY_STATUS_EN, CAMPAIGN_BUCKET, TOKEN_RE
};
