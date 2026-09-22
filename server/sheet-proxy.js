/* Read-only access to the master performance Sheet, for Setup → Sheet
   metrics.

   The browser cannot read a Google Sheet itself: docs.google.com does not
   send the CORS headers a page on another origin needs, so a fetch from
   the dashboard fails before any data arrives. This relays exactly two
   reads, server to Google:

     GET /api/sheet-metrics/tabs?sheet=<link or id>
         every tab in the Sheet: [{ gid, name }]
     GET /api/sheet-metrics/csv?sheet=<link or id>&gid=<gid>[&name=<tab>]
         one tab as CSV text

   What it will not do, on purpose:
     - fetch anything but docs.google.com — the Sheet id and gid are
       validated and the URL is built here, never taken from the caller,
       so this is not an open proxy;
     - write anything, anywhere;
     - hold credentials. It reads Sheets shared as "Anyone with the link
       can view" (or published to the web), which is what the export URL
       has always needed.

   Staff only, like the workspace itself. */

"use strict";

const GOOGLE = "https://docs.google.com";
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20000;

/* ---- what the caller sent ------------------------------------------- */

/* A normal /spreadsheets/d/<id>/edit link, a published /d/e/<id>/pubhtml
   link, or a bare id. Returns { id, published, gidHint } or null. The
   gid in "#gid=123" is the tab that was open when the link was copied —
   a useful hint, never a substitute for discovery. */
function parseSheetRef(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  let id = "", published = false;
  let m = raw.match(/\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)/);
  if (m) { id = m[1]; published = true; }
  else if ((m = raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/))) id = m[1];
  else if (/^[A-Za-z0-9_-]+$/.test(raw)) { id = raw; published = /^2PACX-/.test(raw); }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(id)) return null;
  const g = raw.match(/[#&?]gid=(\d{1,12})/);
  return { id, published, gidHint: g ? g[1] : "" };
}

const validGid = (g) => /^\d{1,12}$/.test(String(g == null ? "" : g));

/* ---- reading the tab list out of Google's viewer page ----------------

   There is no key-free API for a Sheet's tab names. The read-only viewer
   (htmlview, or pubhtml for a published Sheet) lists every tab twice —
   once in a script that builds the tab bar and once as the tab bar's own
   markup — and both carry the gid. Either is enough; both are read so a
   change to one does not blind the import. */
function unescapeJs(s) {
  return String(s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
function unescapeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function parseSheetTabs(html) {
  const text = String(html || "");
  const tabs = [];
  const seen = new Set();
  const add = (gid, name) => {
    gid = String(gid); name = String(name || "").trim();
    if (!validGid(gid) || !name || seen.has(gid)) return;
    seen.add(gid); tabs.push({ gid, name });
  };
  /* items.push({name: "KOWORK", pageUrl: "…", gid: "123", … }) */
  const reItems = /items\.push\(\{\s*name:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?gid:\s*"(\d+)"/g;
  let m;
  while ((m = reItems.exec(text))) add(m[2], unescapeJs(m[1]));
  /* <li id="sheet-button-123"><a …>KOWORK</a></li> */
  const reButtons = /id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = reButtons.exec(text))) add(m[1], unescapeHtml(m[2].replace(/<[^>]+>/g, "")));
  return tabs;
}

/* ---- talking to Google ------------------------------------------------ */

function looksLikeSignIn(res, body) {
  const where = String((res && res.url) || "");
  return /accounts\.google\.com|ServiceLogin/i.test(where) ||
    /<title>[^<]*(Sign in|로그인)[^<]*<\/title>/i.test(String(body || "").slice(0, 4000));
}

class SheetError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const NOT_SHARED = "Google asked for a sign-in, so the Sheet is not readable without one. " +
  "In the Sheet: Share → General access → \"Anyone with the link\" → Viewer.";

async function googleGet(fetchImpl, url) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new SheetError(502, "The server could not reach Google Sheets (" + (err.name === "TimeoutError" ? "timed out" : err.message) + ").");
  }
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new SheetError(413, "That tab is larger than 8 MB.");
  if (res.status === 401 || res.status === 403 || looksLikeSignIn(res, body)) throw new SheetError(403, NOT_SHARED);
  if (res.status === 404) throw new SheetError(404, "Google has no Sheet at that link — check it was copied whole.");
  if (!res.ok) throw new SheetError(502, "Google Sheets answered " + res.status + ".");
  return { res, body };
}

function viewerUrl(ref) {
  return ref.published
    ? `${GOOGLE}/spreadsheets/d/e/${ref.id}/pubhtml`
    : `${GOOGLE}/spreadsheets/d/${ref.id}/htmlview`;
}

function csvUrl(ref, gid, name) {
  if (ref.published) {
    return `${GOOGLE}/spreadsheets/d/e/${ref.id}/pub?output=csv&single=true&gid=${gid}`;
  }
  if (validGid(gid)) return `${GOOGLE}/spreadsheets/d/${ref.id}/export?format=csv&gid=${gid}`;
  /* no gid: the visualisation endpoint takes a tab name instead */
  return `${GOOGLE}/spreadsheets/d/${ref.id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(name)}`;
}

async function listTabs(fetchImpl, ref) {
  const { body } = await googleGet(fetchImpl, viewerUrl(ref));
  const tabs = parseSheetTabs(body);
  if (!tabs.length) {
    throw new SheetError(502, "The Sheet opened, but its tab list could not be read. " +
      "Add the tab by hand below — its name and the number after gid= in the address bar.");
  }
  return tabs;
}

async function readTab(fetchImpl, ref, gid, name) {
  const { res, body } = await googleGet(fetchImpl, csvUrl(ref, gid, name));
  const type = String(res.headers && res.headers.get ? res.headers.get("content-type") || "" : "");
  if (/text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
    throw new SheetError(502, "Google returned a web page instead of the tab's data. " + NOT_SHARED);
  }
  return body;
}

/* ---- routes ------------------------------------------------------------ */

function mountSheetProxy(app, deps) {
  const requireStaff = deps.requireStaff;
  const fetchImpl = deps.fetchImpl || fetch;
  const send = (res, err) => {
    const status = err instanceof SheetError ? err.status : 500;
    if (!(err instanceof SheetError)) console.error("Sheet proxy failed:", err.message);
    res.status(status).json({ ok: false, error: err.message || "Could not read the Sheet." });
  };

  app.get("/api/sheet-metrics/tabs", requireStaff(async (req, res) => {
    const ref = parseSheetRef(req.query.sheet);
    if (!ref) return res.status(400).json({ ok: false, error: "That does not look like a Google Sheets link." });
    try {
      const tabs = await listTabs(fetchImpl, ref);
      res.json({ ok: true, sheetId: ref.id, gidHint: ref.gidHint, tabs });
    } catch (err) { send(res, err); }
  }));

  app.get("/api/sheet-metrics/csv", requireStaff(async (req, res) => {
    const ref = parseSheetRef(req.query.sheet);
    if (!ref) return res.status(400).json({ ok: false, error: "That does not look like a Google Sheets link." });
    const gid = String(req.query.gid || "").trim();
    const name = String(req.query.name || "").trim().slice(0, 200);
    if (gid && !validGid(gid)) return res.status(400).json({ ok: false, error: "A tab's gid is a number." });
    if (!gid && (!name || ref.published)) {
      return res.status(400).json({ ok: false, error: "Say which tab to read — its gid, or its name." });
    }
    try {
      const csv = await readTab(fetchImpl, ref, gid, name);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, gid, name, csv });
    } catch (err) { send(res, err); }
  }));
}

module.exports = { mountSheetProxy, parseSheetRef, parseSheetTabs, csvUrl, viewerUrl, SheetError };
