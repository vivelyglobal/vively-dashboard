"use strict";

/* ===================================================================
   Notion -> dashboard: creator applications arrive by themselves.

   Each campaign has a Notion form database (its "Responses" data source;
   server/notion-autocreate.js stores its id in campaign.notionDatabaseId,
   and the manual "Sync from Notion" stores the same thing). This job reads
   the rows of that data source that were EDITED since a stored cursor and
   puts them on the right campaign's roster, so nobody has to press the
   manual import for new rows.

   It is deliberately more careful than the manual button:

   - OFF unless NOTION_APPLICANTS_SYNC=1. A dry run reads Notion and writes
     NOTHING: no workspace save, no job state, no log.
   - FIRST run for a campaign (the baseline): rows the manual import already
     created (same Notion page id) are left exactly as they are. A roster row
     with no page id that matches by normalised handle is LINKED (only the
     page id is set), never duplicated. Several possible matches are
     reported, not written.
   - Intake fields (name, answers, nationality, contact, shipping address,
     requested visit date, headcount, remark) are FILL-ONLY after the row is
     created, or follow Notion only while the dashboard still holds the value
     this job last imported (a per-field fingerprint is kept in the job
     state, never the text itself). A value staff changed in the dashboard is
     kept and reported as "edited in dashboard". So Notion edits that are not
     about these fields (for example the Confirmed Visit write-back) cannot
     overwrite anything.
     Fields the dashboard owns (stage, imported status, confirmed visit,
     shipping dates, internal note, fee, content) are set ONLY when a row is
     created. A later difference is reported as "Notion differs", never
     written. Nothing is ever deleted or archived because a row vanished.
   - Rows that are held (unknown status, no handle, ambiguous) are remembered
     by Notion page id (no personal data) and retried every run, bounded.
   - The creator's own "Visit Date" is the REQUESTED date (p.visitAt). It is
     never copied into confirmedVisitAt.
   - "Declined" (the creator declined; a real Notion status) is Dropped with
     reason "Declined", as src/sync/notionWriteback.js writes it back. Any
     other status the importer does not know is REPORTED (as "unknown"; the
     text is not stored) and the row is held; it is never guessed into a stage.
   - The workspace is written through the same guarded save as the Save
     button, never with force, one save per campaign batch, with retry on a
     409 (re-read, re-apply, no extra Notion calls). New rows are refused
     when the document is near the browser save limit.
   - The cursor moves forward only after that save succeeded.
   - Toward Notion it only READS: a data source query, a data source schema,
     and one page by id. Timeout, Retry-After, exponential backoff, a gap
     between calls; repeated 429s stop the whole run.
   - Logs and the run entry carry counts, campaign ids, roster ids and Notion
     page ids. Never a name, handle, address, phone or answer.

   The mapping code is the dashboard's own: src/import/excel.js (whole file,
   it is pure) and a few pure functions cut out of src/import/notion.js,
   src/model/{vocab,creators}.js and src/lib/dates.js by loadShared(). They
   are evaluated from the real files, not copied, so the manual import and
   this job cannot drift apart; if a file changes shape so that a piece
   cannot be found, the job stays off and says so.
   =================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { normalizeId } = require("./notion-autocreate.js");

/* ---------------------------- shared mapping code ---------------------------- */

/* One top-level declaration, as written in the browser module, by name.
   The codebase's style makes this exact: a declaration either fits on its
   first line (ends with ";") or runs to the first line that starts with a
   closing } ] or ) in column 0. */
function sliceDecl(text, name) {
  const lines = String(text).split(/\r?\n/);
  const re = new RegExp("^export (?:async )?(?:function|const|let|class) " + name + "\\b");
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error("shared logic not found: " + name);
  const first = lines[i].replace(/^export /, "");
  if (/;\s*$/.test(lines[i])) return first;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^[}\])]/.test(lines[j])) return [first].concat(lines.slice(i + 1, j + 1)).join("\n");
  }
  throw new Error("shared logic not closed: " + name);
}

const SHARED_NAMES = [
  "handleFromUrl", "parseFollowers", "parseDateCell", "countryOf", "STATUS_MAP",
  "notionRowToApplicant", "applyStageDates", "normHandle", "tierOf", "NOTION_FIELD_DEFS"
];

/* Reads the real source files once; returns bind(todayIso) which builds the
   functions with "today" fixed for one run (the browser fixes TODAY when the
   page loads; a server that stays up for days must not). */
function loadShared(srcDir) {
  const root = srcDir || path.join(__dirname, "..", "src");
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const excel = read("import/excel.js").replace(/^export /gm, "");
  const notion = read("import/notion.js");
  const vocab = read("model/vocab.js");
  const creators = read("model/creators.js");
  const dates = read("lib/dates.js");
  const body = [
    excel,
    sliceDecl(vocab, "STAGES"), sliceDecl(vocab, "STAGE_IDX"), sliceDecl(vocab, "tierOf"),
    sliceDecl(dates, "iso"),
    sliceDecl(creators, "normHandle"),
    sliceDecl(notion, "NOTION_METRIC_KEYS"), sliceDecl(notion, "NOTION_FIELD_DEFS"),
    sliceDecl(notion, "notionVisitValue"), sliceDecl(notion, "notionMetricValue"),
    sliceDecl(notion, "notionRowToApplicant"), sliceDecl(notion, "applyStageDates"),
    "return { " + SHARED_NAMES.join(", ") + " };"
  ].join("\n");
  const factory = new Function("TODAY", body); // repo files only, never request data
  const bind = (todayIso) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(todayIso || "")) ? todayIso : new Date().toISOString().slice(0, 10);
    const api = factory(new Date(day + "T00:00:00Z"));
    SHARED_NAMES.forEach((n) => { if (api[n] == null) throw new Error("shared logic missing: " + n); });
    return api;
  };
  bind(null); // fail now, not on the first run
  return { bind };
}

/* ---------------------------- config ---------------------------- */

const num = (v) => (String(v == null ? "" : v).trim() === "" ? NaN : Number(v));
const clampInt = (v, lo, hi, dflt) => {
  const n = num(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), lo), hi) : dflt;
};
const clampNum = (v, lo, hi, dflt) => {
  const n = num(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

/* the browser save limit: server.js reads request bodies with express.json({ limit: "10mb" }) (a test keeps the two in step) */
const BROWSER_SAVE_LIMIT_BYTES = 10 * 1024 * 1024;

function parseConfig(env) {
  const e = env || {};
  /* The Notion forms are near-live (founder, 2026-11-24): every 2 minutes by
     default, never faster than every minute. */
  const mins = num(e.NOTION_APPLICANTS_INTERVAL_MIN);
  const intervalMin = Number.isFinite(mins) && mins > 0 ? Math.min(Math.max(mins, 1), 1440) : 2;
  return {
    /* only the literal 1 switches a job that writes the workspace on */
    requested: String(e.NOTION_APPLICANTS_SYNC || "").trim() === "1",
    dryRun: /^(1|true|yes)$/i.test(String(e.NOTION_APPLICANTS_DRY_RUN || "").trim()),
    intervalMin, intervalMs: Math.round(intervalMin * 60000),
    maxCreate: clampInt(e.NOTION_APPLICANTS_MAX_CREATE, 0, 500, 10),   // roster rows created per run, all campaigns
    maxRows: clampInt(e.NOTION_APPLICANTS_MAX_ROWS, 1, 2000, 200),     // rows read per campaign per run
    pageSize: clampInt(e.NOTION_APPLICANTS_PAGE_SIZE, 1, 100, 50),     // rows per Notion request
    maxCampaigns: clampInt(e.NOTION_APPLICANTS_MAX_CAMPAIGNS, 1, 200, 25),
    includeWrapped: String(e.NOTION_APPLICANTS_INCLUDE_WRAPPED || "").trim() === "1",
    manualMinSec: clampInt(e.NOTION_APPLICANTS_MANUAL_MIN_SEC, 0, 3600, 30),            // between staff-triggered runs
    docLimitFraction: clampNum(e.NOTION_APPLICANTS_DOC_LIMIT_FRACTION, 0.1, 0.95, 0.8), // of the browser save limit
    docLimitBytes: BROWSER_SAVE_LIMIT_BYTES,
    timeoutMs: clampInt(e.NOTION_APPLICANTS_TIMEOUT_MS, 2000, 60000, 15000),            // per Notion request
    maxRetries: clampInt(e.NOTION_APPLICANTS_MAX_RETRIES, 0, 6, 3),                     // per Notion request
    minGapMs: clampInt(e.NOTION_APPLICANTS_MIN_GAP_MS, 0, 5000, 350),                   // between Notion requests
    logKeep: clampInt(e.NOTION_APPLICANTS_LOG_KEEP, 1, 100, 20),                        // run summaries kept
    maxHeldRetry: clampInt(e.NOTION_APPLICANTS_MAX_HELD_RETRY, 0, 200, 20)              // held rows re-read per run
  };
}

/* ---------------------------- the Notion read ---------------------------- */

/* One Notion page -> the row shape the manual import reads
   ({ pageId, createdTime, properties }) plus lastEdited. `extractValue` is
   server.js's own extractNotionValue, so a value is flattened exactly as the
   manual route does it. Archived / trashed rows are dropped (and never cause
   anything to be removed from the dashboard). */
function pageToRow(page, extractValue) {
  if (!page || page.archived || page.in_trash) return null;
  const properties = {};
  Object.entries(page.properties || {}).forEach(([name, prop]) => { properties[name] = extractValue(prop); });
  return { pageId: page.id, createdTime: page.created_time, lastEdited: page.last_edited_time || "", properties };
}

/* notionPost(path, body) -> parsed JSON or throws (err.status set). Only
   ever called for POST /data_sources/{id}/query. */
function makeQueryRows(notionPost, extractValue) {
  return async function queryRows(o) {
    const body = { page_size: o.pageSize, sorts: [{ timestamp: "last_edited_time", direction: "ascending" }] };
    /* on_or_after, not after: INFERRED (from Notion's public docs, not observed here) that a page's last-edited time is rounded
       to the minute, so a row edited in the cursor's own minute must be seen again. Re-reading it is harmless, every write is
       idempotent. */
    if (o.since) body.filter = { timestamp: "last_edited_time", last_edited_time: { on_or_after: o.since } };
    if (o.startCursor) body.start_cursor = o.startCursor;
    const out = await notionPost("/data_sources/" + o.dataSourceId + "/query", body);
    const rows = (out.results || []).map((pg) => pageToRow(pg, extractValue)).filter(Boolean);
    return { rows, hasMore: !!out.has_more, nextCursor: out.next_cursor || null };
  };
}

/* one page by id (a held row being retried) -> row, or null if it is trashed/archived */
function makeGetPage(notionGet, extractValue) {
  return async function getPage(pageId) {
    const id = normalizeId(pageId);
    if (!id) return null;
    return pageToRow(await notionGet("/pages/" + id), extractValue);
  };
}

/* The only three Notion requests this job may make, all reads. Anything else
   is refused here, before any network call. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ALLOWED_CALLS = [
  ["POST", new RegExp("^/data_sources/" + UUID + "/query$")],
  ["GET", new RegExp("^/data_sources/" + UUID + "$")],
  ["GET", new RegExp("^/pages/" + UUID + "$")]
];

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function callError(vcode, status, retryAfterSec) {
  const e = new Error("Notion request failed: " + vcode); // no response text: it could carry anything
  e.vcode = vcode; if (status) e.status = status;
  if (vcode === "rate-limited") { e.rateLimited = true; e.retryAfterSec = retryAfterSec || 0; }
  return e;
}

/* raw(path, { method, body?, signal }) -> parsed JSON or throws (err.status,
   err.retryAfter in seconds when Notion sent one). Returns
   call(method, path, body). Per request: a timeout; 429, 5xx, timeouts and
   network errors are retried up to maxRetries with exponential backoff
   (base 1 s, doubling, capped), a Retry-After is honoured, and one that is
   longer than the cap is not waited out (the run stops instead). A gap
   keeps the average under Notion's documented ~3 requests a second
   (INFERRED from Notion's public docs, not measured here). A permanent
   failure (400, 401, 403, 404) is not retried. The error that comes out has
   a code and a status only, never Notion's text. */
function makeNotionCaller(raw, o) {
  const opt = Object.assign({ timeoutMs: 15000, maxRetries: 3, minGapMs: 350, baseDelayMs: 1000, maxDelayMs: 60000, sleep: realSleep, now: Date.now }, o || {});
  let lastAt = 0;
  return async function call(method, p, body) {
    if (!ALLOWED_CALLS.some(([m, re]) => m === method && re.test(String(p)))) throw callError("not-allowed");
    let delay = opt.baseDelayMs;
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + opt.minGapMs - opt.now();
      if (opt.minGapMs > 0 && lastAt && wait > 0) await opt.sleep(wait);
      lastAt = opt.now();
      try {
        const init = { method, signal: AbortSignal.timeout(opt.timeoutMs) };
        if (body !== undefined) init.body = JSON.stringify(body);
        return await raw(p, init);
      } catch (e) {
        const st = e && Number(e.status);
        const timeout = !!e && (e.name === "TimeoutError" || e.name === "AbortError");
        const network = !!e && !st && !timeout && e.name === "TypeError";
        const limited = st === 429;
        if (!(limited || (st >= 500 && st <= 599) || timeout || network)) throw e;
        const code = limited ? "rate-limited" : timeout ? "timeout" : st ? "http-" + st : "network";
        const ra = Number(e && e.retryAfter);
        const hasRa = limited && Number.isFinite(ra) && ra >= 0;
        if (hasRa && ra * 1000 > opt.maxDelayMs) throw callError(code, st, ra);   // asked to wait longer than we will
        if (attempt >= opt.maxRetries) throw callError(code, st, hasRa ? ra : 0);
        const w = Math.min(opt.maxDelayMs, hasRa ? Math.max(delay, ra * 1000) : delay);
        await opt.sleep(w);
        delay = Math.min(opt.maxDelayMs, delay * 2);
      }
    }
  };
}

/* the three reads the job is wired to, behind the caller above */
function makeNotionApi(raw, extractValue, o) {
  const call = makeNotionCaller(raw, o);
  return {
    queryRows: makeQueryRows((p, body) => call("POST", p, body), extractValue),
    getPage: makeGetPage((p) => call("GET", p), extractValue),
    getSchema: (dataSourceId) => call("GET", "/data_sources/" + dataSourceId)
  };
}

/* ---------------------------- default mapping ---------------------------- */

/* The columns a form must have for the job to map it by itself. Names are
   compared lower-case with spaces collapsed; the type must be one of the
   listed ones. Nothing is guessed from a similar-looking column or an
   unexpected type. `key` is the dashboard field (NOTION_FIELD_DEFS); the
   submission-time column has no field (the job uses the page's own created
   time, as the manual import does) but must exist. */
const DEFAULT_COLUMNS = [
  { key: "fullName", label: "Full Name", names: ["full name"], types: ["title"] },
  { key: "nationality", label: "Nationality", names: ["nationality"], types: ["rich_text", "select"] },
  { key: "instagram", label: "Instagram Link", names: ["instagram link"], types: ["url"] },
  { key: "followers", label: "Followers", names: ["followers", "follower count", "instagram followers"], types: ["number"] },
  { key: "status", label: "Status", names: ["status"], types: ["status", "select"] },
  { key: null, label: "Submission time", names: ["submission time"], types: ["created_time", "date"] },
  { key: "visitAt", label: "Visit Date", names: ["visit date"], types: ["date"] }
];
const normName = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");

/* properties: the data source schema's `properties` object. Returns
   { mapping } (every dashboard field key present, null where unmapped, the
   same shape the manual mapping screen saves) or { missing: [{ property,
   expected, found }] } naming each column that is absent, of the wrong type,
   or ambiguous. */
function buildDefaultMapping(properties, fieldKeys) {
  const props = Object.entries(properties && typeof properties === "object" ? properties : {})
    .map(([name, def]) => ({ name, type: def && def.type ? String(def.type) : "" }));
  const mapping = {};
  (fieldKeys || []).forEach((k) => { mapping[k] = null; });
  const missing = [];
  DEFAULT_COLUMNS.forEach((col) => {
    const hits = props.filter((p) => col.names.includes(normName(p.name)));
    const expected = col.types.join(" or ");
    if (!hits.length) { missing.push({ property: col.label, expected, found: null }); return; }
    if (hits.length > 1) { missing.push({ property: col.label, expected, found: "several columns with that name" }); return; }
    if (!col.types.includes(hits[0].type)) { missing.push({ property: col.label, expected, found: hits[0].type || "unknown type" }); return; }
    if (col.key) mapping[col.key] = hits[0].name;
  });
  return missing.length ? { missing } : { mapping };
}

const hasAnyMapping = (cp) => !!cp && !!cp.notionMapping && typeof cp.notionMapping === "object" && Object.values(cp.notionMapping).some((v) => !!v && v !== "skip");

/* ---------------------------- applying rows (pure) ---------------------------- */

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v) => (v == null ? "" : String(v));
const LIST_CAP = 100;
const UNRESOLVED_CAP = 500;

/* What the job fills in from Notion on a roster row. After the row exists
   these are fill-only unless the dashboard still holds what was imported. */
const INTAKE_FIELDS = ["fullName", "address", "contact", "nationality", "otherSns", "formNotes", "remark", "headcount", "visitAt"];

/* A fingerprint of one imported value (first 10 hex characters of SHA-256 over
   field name + value). The job state keeps these, never the text, so staff
   corrections can be told from Notion's value without copying personal data
   into the state. It is a pseudonym, not anonymous: a guessable value (a
   country) could be tested against it. The state lives in the same database
   as the workspace, which holds the text itself. */
const fieldHash = (k, v) => crypto.createHash("sha256").update(k + "\u0000" + str(v)).digest("hex").slice(0, 10);

/* Notion statuses this job knows on top of the importer's STATUS_MAP.
   "Declined" is a real Notion status: the creator declined. Same meaning as
   notionValueForDrop() in src/sync/notionWriteback.js (a drop that is not
   "brand" or "cancel" is written back as "Declined"). STATUS_MAP in
   src/import/excel.js has no entry for it, and it is shared with the manual
   import and the browser bundle, so it is not edited here (see report 28). */
const EXTRA_STATUS = { declined: { stage: "dropped", reason: "Declined" } };

/* Put one campaign's rows onto the workspace `db` (mutated in place).
   ctx: { db, cp, rows, shared, newId, nowIso, baseline, createBudget, budgetReason, snap }
   rows may carry retry:true (a held row read again by page id).
   snap: { [pageId]: { field: fingerprint } } as last imported.
   Returns a report; `changed` says whether `db` was touched. Nothing here
   reads or writes anything outside `db`. */
function applyRows(ctx) {
  const { db, cp, rows, shared } = ctx;
  const mapping = (cp && cp.notionMapping) || {};
  const isMapped = (k) => !!mapping[k] && mapping[k] !== "skip";
  const baseline = !!ctx.baseline;
  let budget = Number.isFinite(ctx.createBudget) ? ctx.createBudget : Infinity;
  const budgetReason = ctx.budgetReason || "create-cap";
  const nowIso = ctx.nowIso || new Date().toISOString();
  const snap = ctx.snap && typeof ctx.snap === "object" ? ctx.snap : {};

  const rep = {
    created: [], linked: [], updated: [], already: 0, ambiguous: [], held: [], differs: [], elsewhere: [], edited: [],
    deferred: [], unknown: new Map(), newCreators: 0, changed: false, stopAt: null, processed: 0,
    unresolved: new Map(),   // pageId -> reason, for rows that stay held or ambiguous (uncapped list, for the job state)
    seen: new Set(),         // every page id looked at
    snapPatch: new Map()     // pageId -> { field: fingerprint } to store after a successful save
  };

  const key = (id) => normalizeId(id) || str(id);
  const byPage = new Map();
  db.participants.forEach((p) => { if (p && p.notionPageId) byPage.set(key(p.notionPageId), p); });
  const creatorsById = new Map(db.creators.map((c) => [c.id, c]));
  const creatorsByHandle = new Map();
  const indexCreator = (c) => {
    const k = shared.normHandle(c.handle);
    if (!k) return;
    if (!creatorsByHandle.has(k)) creatorsByHandle.set(k, []);
    creatorsByHandle.get(k).push(c);
  };
  db.creators.forEach(indexCreator);
  const roster = new Map(); // creatorId -> this campaign's roster rows
  const addRoster = (p) => { if (!roster.has(p.creatorId)) roster.set(p.creatorId, []); roster.get(p.creatorId).push(p); };
  db.participants.forEach((p) => { if (p && p.campaignId === cp.id) addRoster(p); });
  const usedIds = new Set(db.participants.map((p) => p && p.id));

  const note = (list, item) => { if (list.length < LIST_CAP) list.push(item); };
  const unresolve = (pageId, why) => { if (rep.unresolved.size < UNRESOLVED_CAP) rep.unresolved.set(key(pageId), why); };
  const hold = (pageId, why) => { note(rep.held, { pageId, why }); unresolve(pageId, why); };
  const setField = (obj, k, v) => {
    if (str(obj[k]) !== str(v)) { obj[k] = v; rep.changed = true; return 1; }
    return 0;
  };
  const patchSnap = (pageId, k, v) => {
    const id = key(pageId);
    if (!rep.snapPatch.has(id)) rep.snapPatch.set(id, {});
    rep.snapPatch.get(id)[k] = fieldHash(k, v);
  };

  rows.forEach((row) => {
    rep.processed++;
    const pageId = row.pageId;
    rep.seen.add(key(pageId));
    const edited = row.lastEdited || "";
    const ap = shared.notionRowToApplicant(row.properties || {}, mapping);
    const raw = str(ap.statusRaw).trim();
    const lc = raw.toLowerCase();
    const extra = own(EXTRA_STATUS, lc) ? EXTRA_STATUS[lc] : null;
    const known = own(shared.STATUS_MAP, lc) || !!extra;
    if (extra) { ap.stage = extra.stage; ap.dropReason = extra.reason; }
    if (!known) {
      /* The status TEXT is not stored or shown: it is an option name staff
         chose in Notion (INFERRED), but if the column is mapped to a free
         text field it could be anything a creator typed. Only the count is
         kept; the held row's page id says where to look. */
      rep.unknown.set("unknown", (rep.unknown.get("unknown") || 0) + 1);
    }

    const p = byPage.get(key(pageId));
    if (p) {
      /* already on a roster. Never moved between campaigns here (the manual
         import's "rehome" is a person's decision), never changed on a first
         pass. */
      if (p.campaignId !== cp.id) { note(rep.elsewhere, { pageId, participantId: p.id }); return; }
      const a = lc, b = str(p.importedStatus).trim().toLowerCase();
      if (a && a !== b && rep.differs.length < LIST_CAP) rep.differs.push({ participantId: p.id, field: "status" });
      if (baseline) { rep.already++; return; }

      let n = 0;
      /* FILL-ONLY, or follow Notion only while the dashboard still holds what
         this job last imported. A field with no mapped column is left alone.
         (Mapped means a column is chosen for that field. The manual import
         tests the property NAME against the field key here, which only works
         when they happen to be equal; see report 26.)
         - Notion value equals the dashboard value: nothing to do (the
           fingerprint is refreshed).
         - dashboard value empty: fill it in.
         - dashboard value still has the fingerprint of the last import: staff
           have not touched it, follow Notion (including a cleared answer).
         - otherwise staff changed it (or the row predates the fingerprints):
           keep it and report "edited in dashboard". */
      const base = snap[key(pageId)] || null;
      INTAKE_FIELDS.forEach((k) => {
        if (!isMapped(k)) return;
        const nv = str(ap[k]), cur = str(p[k]);
        if (nv === cur) { if (!base || base[k] !== fieldHash(k, nv)) patchSnap(pageId, k, nv); return; }
        if (cur === "" || (base && base[k] === fieldHash(k, cur))) { p[k] = nv; rep.changed = true; n++; patchSnap(pageId, k, nv); return; }
        if (base && base[k] === fieldHash(k, nv)) return;   // Notion still has what was imported (an edit about something else, e.g. the Confirmed Visit write-back): nothing to say
        note(rep.edited, { participantId: p.id, field: k, why: base ? "edited-in-dashboard" : "no-fingerprint" });
      });
      if (!p.appliedAt && row.createdTime) n += setField(p, "appliedAt", row.createdTime);
      const cr = creatorsById.get(p.creatorId);
      if (cr) {
        if (ap.gender && !cr.gender) n += setField(cr, "gender", ap.gender);
        if (ap.followers && !cr.followers) n += setField(cr, "followers", ap.followers);
        ["email", "contact", "address", "nationality"].forEach((k) => { if (ap[k] && !cr[k]) n += setField(cr, k, ap[k]); });
      }
      if (n) note(rep.updated, { pageId, participantId: p.id, fields: n });
      return;
    }

    /* not on any roster yet */
    if (!ap.handle) { hold(pageId, "no-handle"); return; }
    if (!known) { hold(pageId, "unknown-status"); return; }

    const crs = creatorsByHandle.get(shared.normHandle(ap.handle)) || [];
    if (crs.length > 1) { note(rep.ambiguous, { pageId, why: "duplicate-creators", matches: crs.length }); unresolve(pageId, "duplicate-creators"); return; }
    let cr = crs[0] || null;
    const cands = cr ? (roster.get(cr.id) || []) : [];
    if (cands.length > 1) { note(rep.ambiguous, { pageId, why: "several-roster-rows", matches: cands.length }); unresolve(pageId, "several-roster-rows"); return; }
    if (cands.length === 1) {
      const q = cands[0];
      if (q.notionPageId) { hold(pageId, "duplicate-submission"); return; } // same person applied twice; first submission owns the row
      q.notionPageId = pageId; byPage.set(key(pageId), q); rep.changed = true;  // link only; nothing else on the row changes
      note(rep.linked, { pageId, participantId: q.id });
      return;
    }

    /* a person with no roster row on this campaign: create one */
    if (budget <= 0) {
      if (row.retry) { hold(pageId, budgetReason); return; }   // a held row stays held; it does not move the cursor
      note(rep.deferred, { pageId, why: budgetReason });
      if (rep.stopAt == null) rep.stopAt = edited || null;
      return;
    }
    if (!cr) {
      const crId = ctx.newId("nt");
      cr = {
        id: crId, handle: ap.handle, name: ap.fullName || ap.handle,
        platform: ap.platform, followers: ap.followers,
        er: 0, avgViews: Math.round(ap.followers * 0.6),
        categories: cp.category ? [cp.category] : [], country: shared.countryOf(ap.nationality),
        nationality: ap.nationality, languages: ["EN"],
        tier: shared.tierOf(ap.followers).id, source: "Notion form",
        rate: 0, reliability: null, avgTurnaroundDays: null,
        campaignsDone: 0, lastWorked: null,
        email: ap.email, contact: ap.contact, address: ap.address,
        tags: [], notes: "", flag: null, flagReason: "", flagAt: null,
        campaignIds: [], contentCount: 0, totalViews: 0, bestViews: 0
      };
      if (ap.gender) cr.gender = ap.gender;
      db.creators.push(cr); creatorsById.set(crId, cr); indexCreator(cr); rep.newCreators++;
    } else {
      if (ap.followers && !cr.followers) cr.followers = ap.followers;
      ["email", "contact", "address", "nationality"].forEach((k) => { if (ap[k] && !cr[k]) cr[k] = ap[k]; });
      if (ap.gender && !cr.gender) cr.gender = ap.gender;
    }
    const id = cp.id + "-" + cr.id;
    if (usedIds.has(id)) { hold(pageId, "id-collision"); return; }
    /* the dashboard-owned fields are set here, once, from the row as it is now */
    const np = {
      id, campaignId: cp.id, creatorId: cr.id, stage: ap.stage,
      source: "Notion form", fee: 0, contactedAt: null, repliedAt: null, confirmedAt: null, shippedAt: null,
      dropReason: ap.dropReason, revisions: 0, note: ap.note,
      fullName: ap.fullName, address: ap.address, contact: ap.contact, nationality: ap.nationality,
      visitAt: ap.visitAt, arrivingDate: "", otherSns: ap.otherSns, importedStatus: ap.statusRaw,
      formNotes: ap.formNotes, remark: ap.remark || "", headcount: ap.headcount || "",
      appliedAt: row.createdTime || nowIso,
      notionPageId: pageId, content: null
    };
    shared.applyStageDates(np, ap.stage, cp);
    db.participants.push(np); usedIds.add(id); addRoster(np); byPage.set(key(pageId), np);
    INTAKE_FIELDS.forEach((k) => patchSnap(pageId, k, np[k]));   // what was imported, for the later fill-only rule
    budget--; rep.changed = true;
    note(rep.created, { pageId, participantId: np.id });
  });

  return rep;
}

/* ---------------------------- the job ---------------------------- */

const errCode = (e) => (e && e.vcode ? e.vcode : e && e.status ? "http-" + e.status : "error");

const SNAP_CAP = 5000;      // fingerprinted rows per campaign
const HELD_CAP = 200;       // held rows remembered per campaign
const HELD_EVERY_RUN = 10;  // a held row is retried on every run for this many tries, then at most once an hour
const HELD_SLOW_MS = 3600000;
const MAP_RECHECK_MS = 600000; // a form that failed the default mapping check is looked at again after 10 minutes

function emptyState() { return { campaigns: {} }; }
const isoOrNull = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
function normState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = emptyState();
  Object.entries(r.campaigns && typeof r.campaigns === "object" ? r.campaigns : {}).slice(-500).forEach(([id, c]) => {
    if (!c || typeof c !== "object") return;
    const snap = {};
    Object.entries(c.snap && typeof c.snap === "object" ? c.snap : {}).slice(-SNAP_CAP).forEach(([pg, f]) => {
      if (!f || typeof f !== "object") return;
      const o = {};
      Object.entries(f).forEach(([k, h]) => { if (INTAKE_FIELDS.includes(k) && /^[0-9a-f]{10}$/.test(String(h))) o[k] = String(h); });
      if (Object.keys(o).length) snap[pg] = o;
    });
    const held = {};
    Object.entries(c.held && typeof c.held === "object" ? c.held : {}).slice(0, HELD_CAP).forEach(([pg, h]) => {
      if (!h || typeof h !== "object") return;
      held[pg] = {
        why: String(h.why || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "held",
        since: isoOrNull(h.since) || "", lastTryAt: isoOrNull(h.lastTryAt) || "",
        tries: Number.isFinite(Number(h.tries)) ? Math.max(0, Math.floor(Number(h.tries))) : 0
      };
    });
    out.campaigns[id] = {
      ds: typeof c.ds === "string" ? c.ds : "",
      cursor: isoOrNull(c.cursor),
      baselineDone: !!c.baselineDone,
      lastRunAt: typeof c.lastRunAt === "string" ? c.lastRunAt : "",
      snap, held
    };
  });
  return out;
}

/* A short, personal-data-free picture of a run for the history list. */
function compactEntry(e) {
  const out = {
    at: e.at, trigger: e.trigger, dryRun: !!e.dryRun, ok: !!e.ok, counts: e.counts, unknownStatuses: e.unknownStatuses,
    remaining: e.remaining, errors: e.errors, warnings: e.warnings || [], aborted: e.aborted || null,
    campaigns: (e.campaigns || []).slice(0, 60).map((c) => ({ campaignId: c.campaignId, status: c.status, why: c.why || null, counts: c.counts || null, mapping: c.mapping || null }))
  };
  return out;
}

/* The run history in Mongo: the full last run under _id "last", and a
   capped list of compact summaries under _id "history" ($slice keeps the
   newest `keep`). col is a Mongo collection (or a stand-in). */
function makeLogStore(col, keep) {
  const n = Math.max(1, keep | 0 || 20);
  return {
    async save(entry) {
      await col.updateOne({ _id: "last" }, { $set: { entry } }, { upsert: true });
      await col.updateOne({ _id: "history" }, { $push: { entries: { $each: [compactEntry(entry)], $slice: -n } } }, { upsert: true });
    },
    async readHistory() {
      const row = await col.findOne({ _id: "history" });
      return Array.isArray(row && row.entries) ? row.entries : [];
    },
    async readLast() {
      const row = await col.findOne({ _id: "last" });
      return (row && row.entry) || null;
    }
  };
}

/* deps:
     shared                        loadShared() result
     loadWorkspace()               -> { db, settings, revision } | null
     saveWorkspace(w)              -> { ok } | { conflict:true }; throws otherwise (never force)
     queryRows({dataSourceId, since, startCursor, pageSize}) -> { rows, hasMore, nextCursor }
     getPage(pageId)               -> row | null            (optional: without it held rows are not retried)
     getSchema(dataSourceId)       -> data source object    (optional: without it no default mapping)
     loadState() / saveState(s) / saveLog(entry)
     newId(prefix), now(), logger
     maxCreate, maxRows, pageSize, maxCampaigns, includeWrapped, maxAttempts, dryRun,
     manualMinSec, docLimitFraction, docLimitBytes, maxHeldRetry, cooldownSec */
function createApplicants(deps) {
  const d = deps;
  const logger = d.logger || console;
  const maxAttempts = d.maxAttempts || 4;
  const cfg = {
    maxCreate: Number.isFinite(d.maxCreate) ? d.maxCreate : 10,
    maxRows: Number.isFinite(d.maxRows) ? d.maxRows : 200,
    pageSize: Number.isFinite(d.pageSize) ? d.pageSize : 50,
    maxCampaigns: Number.isFinite(d.maxCampaigns) ? d.maxCampaigns : 25,
    includeWrapped: !!d.includeWrapped,
    manualMinMs: (Number.isFinite(d.manualMinSec) ? d.manualMinSec : 30) * 1000,
    docLimitFraction: Number.isFinite(d.docLimitFraction) ? d.docLimitFraction : 0.8,
    docLimitBytes: Number.isFinite(d.docLimitBytes) ? d.docLimitBytes : BROWSER_SAVE_LIMIT_BYTES,
    maxHeldRetry: Number.isFinite(d.maxHeldRetry) ? d.maxHeldRetry : 20,
    cooldownMs: (Number.isFinite(d.cooldownSec) ? d.cooldownSec : 300) * 1000
  };
  const now = d.now || (() => new Date());
  let running = false;
  let last = null;
  let lastManualAt = 0;
  let coolUntil = 0;
  const mapFail = new Map(); // campaignId -> { at, ds, missing } (in memory: a restart simply looks again)

  let memState = null;
  const readState = async () => normState(d.loadState ? await d.loadState() : memState);
  const writeState = async (s) => { if (d.saveState) await d.saveState(s); else memState = s; };
  let chain = Promise.resolve();
  function mutateState(fn) {
    const p = chain.then(async () => { const s = await readState(); const r = fn(s); await writeState(s); return r; });
    chain = p.catch(() => {});
    return p;
  }

  async function stateSummary() {
    const s = await readState();
    const held = [];
    Object.entries(s.campaigns).forEach(([cid, c]) => Object.entries(c.held).forEach(([pageId, h]) => {
      if (held.length < 200) held.push({ campaignId: cid, pageId, why: h.why, since: h.since, tries: h.tries });
    }));
    return {
      campaignsTracked: Object.keys(s.campaigns).length,
      baselineDone: Object.values(s.campaigns).filter((c) => c.baselineDone).length,
      heldRows: held.length, held,
      maxCreatePerRun: cfg.maxCreate, maxRowsPerCampaign: cfg.maxRows, pageSize: cfg.pageSize, maxCampaignsPerRun: cfg.maxCampaigns
    };
  }

  /* rows of one data source since the cursor, bounded by maxRows */
  async function fetchRows(dsId, since) {
    const rows = [];
    let start = null, more = false, guard = 0;
    do {
      const size = Math.min(cfg.pageSize, cfg.maxRows - rows.length);
      const r = await d.queryRows({ dataSourceId: dsId, since: since || null, startCursor: start, pageSize: size });
      (r.rows || []).forEach((x) => rows.push(x));
      more = !!r.hasMore; start = r.nextCursor || null;
      guard++;
    } while (more && start && rows.length < cfg.maxRows && guard < 50);
    /* the Notion order is asked for, not trusted */
    let sorted = true;
    for (let i = 1; i < rows.length; i++) if ((rows[i].lastEdited || "") < (rows[i - 1].lastEdited || "")) { sorted = false; break; }
    if (!sorted) rows.sort((a, b) => (a.lastEdited || "").localeCompare(b.lastEdited || ""));
    return { rows, truncated: more, sorted };
  }

  const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

  /* the default mapping for a campaign that has none (hands-free flow).
     Returns { ok, mapping, saved? } or { skip, why, missing? } or { aborted } */
  async function ensureMapping(c, x) {
    const dsKey = normalizeId(c.notionDatabaseId);
    if (typeof d.getSchema !== "function") return { skip: true, why: "no-mapping" };
    const failed = mapFail.get(c.id);
    if (failed && failed.ds === dsKey && now().getTime() - failed.at < MAP_RECHECK_MS) return { skip: true, why: "mapping-incomplete", missing: failed.missing };
    let schema;
    try { schema = await d.getSchema(dsKey); }
    catch (err) {
      if (err && err.rateLimited) return { aborted: err };
      return { skip: true, why: "schema-failed:" + errCode(err) };
    }
    const built = buildDefaultMapping(schema && schema.properties, x.fieldKeys);
    if (built.missing) {
      mapFail.set(c.id, { at: now().getTime(), ds: dsKey, missing: built.missing });
      return { skip: true, why: "mapping-incomplete", missing: built.missing };
    }
    mapFail.delete(c.id);
    if (x.dryRun) { x.virtual[c.id] = built.mapping; return { ok: true, mapping: built.mapping, saved: false }; }
    /* save it through the same guarded save (never force); re-check on a conflict */
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const doc = await d.loadWorkspace();
      const cp = doc && doc.db && Array.isArray(doc.db.campaigns) && doc.db.campaigns.find((k) => k && k.id === c.id);
      if (!cp) return { skip: true, why: "campaign-gone" };
      if (normalizeId(cp.notionDatabaseId) !== dsKey) return { skip: true, why: "source-changed" };
      if (hasAnyMapping(cp)) return { ok: true, mapping: cp.notionMapping, saved: false };   // someone mapped it meanwhile: theirs wins
      cp.notionMapping = Object.assign({}, built.mapping);
      const res = await d.saveWorkspace({ db: doc.db, settings: doc.settings || {}, revision: doc.revision || 0 });
      if (res && res.ok) return { ok: true, mapping: built.mapping, saved: true };
      if (res && res.conflict) continue;
      throw new Error("save was refused");
    }
    return { skip: true, why: "workspace-kept-changing" };
  }

  async function run(opts) {
    const o = opts || {};
    if (running) return Object.assign({}, last || {}, { busy: true });
    const t0 = now().getTime();
    if (coolUntil > t0) return { ok: false, skipped: "cooling-down", retryAfterSec: Math.ceil((coolUntil - t0) / 1000), campaigns: [] };
    const manual = o.trigger === "manual";
    if (manual && lastManualAt && t0 - lastManualAt < cfg.manualMinMs) {
      return { ok: false, throttled: true, retryAfterSec: Math.max(1, Math.ceil((cfg.manualMinMs - (t0 - lastManualAt)) / 1000)), campaigns: [] };
    }
    if (manual) lastManualAt = t0;
    running = true;
    const startedAt = now().toISOString();
    const dryRun = o.dryRun != null ? !!o.dryRun : !!d.dryRun;
    const rescan = new Set(Array.isArray(o.rescan) ? o.rescan.map(String) : []);
    const entry = {
      at: startedAt, trigger: o.trigger || "poll", dryRun, ok: false, campaigns: [],
      unknownStatuses: new Map(), remaining: { creates: 0, campaignsNotVisited: 0, campaignsWithMoreRows: 0 }, errors: [], warnings: [], aborted: null
    };
    try {
      const first = await d.loadWorkspace();
      if (!first || !first.db || !Array.isArray(first.db.campaigns) || !Array.isArray(first.db.participants) || !Array.isArray(first.db.creators)) {
        entry.errors.push("no workspace document to write to yet; nothing done");
        return finish(entry);
      }
      const st = await readState();

      /* which campaigns: a data source id, not shared with another campaign */
      const all = first.db.campaigns.filter((c) => c && c.id);
      const keyOf = (c) => normalizeId(c.notionDatabaseId);
      const sourceUse = new Map();
      all.forEach((c) => { const k = keyOf(c); if (k) sourceUse.set(k, (sourceUse.get(k) || 0) + 1); });
      let eligible = [];
      const needMap = new Set();
      all.forEach((c) => {
        if (o.campaignId && c.id !== String(o.campaignId)) return;
        const k = keyOf(c);
        if (!k) return; // never connected to a Notion form: not this job's business, not even reported
        const skip = (why) => entry.campaigns.push({ campaignId: c.id, status: "skipped", why });
        if (sourceUse.get(k) > 1) { skip("shared-source"); return; }
        if (c.status === "wrapped" && !cfg.includeWrapped) { skip("wrapped"); return; }
        if (!hasAnyMapping(c) && typeof d.getSchema === "function") { needMap.add(c.id); eligible.push(c); return; }   // hands-free: map it from the schema, if it fits
        const m = c.notionMapping || {};
        if (!(m.instagram && m.instagram !== "skip") && !(m.tiktok && m.tiktok !== "skip")) { skip("no-mapping"); return; }
        eligible.push(c);
      });
      eligible.sort((a, b) => str((st.campaigns[a.id] || {}).lastRunAt).localeCompare(str((st.campaigns[b.id] || {}).lastRunAt)));
      entry.remaining.campaignsNotVisited = Math.max(0, eligible.length - cfg.maxCampaigns);
      eligible = eligible.slice(0, cfg.maxCampaigns);

      /* workspace size, measured once and kept up to date from what this run adds */
      const docBytes = { n: sizeOf({ db: first.db, settings: first.settings || {} }) };
      const limit = Math.floor(cfg.docLimitBytes * cfg.docLimitFraction);
      const x0 = { st, rescan, dryRun, entry, startedAt, docBytes, limit, virtual: {}, heldUsed: { n: 0 }, fieldKeys: d.shared.bind(startedAt.slice(0, 10)).NOTION_FIELD_DEFS.map((f) => f.key) };

      let createBudget = cfg.maxCreate;
      let visited = 0;
      for (const c of eligible) {
        if (needMap.has(c.id)) {
          let m;
          try { m = await ensureMapping(c, x0); }
          catch (err) { entry.campaigns.push({ campaignId: c.id, status: "error", why: "mapping-failed:" + errCode(err) }); logger.error("Notion applicants: default mapping failed for " + c.id + " (" + errCode(err) + ")"); visited++; continue; }
          if (m.aborted) { abortRun(entry, m.aborted, eligible.length - visited); break; }
          if (m.skip) { entry.campaigns.push({ campaignId: c.id, status: "skipped", why: m.why, missing: m.missing }); visited++; continue; }
          x0.mappingNote = x0.mappingNote || {};
          x0.mappingNote[c.id] = m.saved ? "saved" : (dryRun ? "would-save" : "existing");
        }
        const rep = await syncCampaign(c.id, Object.assign({ createBudget }, x0));
        visited++;
        createBudget = Math.max(0, createBudget - rep.created);
        entry.campaigns.push(rep.report);
        (rep.unknown || new Map()).forEach((n, v) => { entry.unknownStatuses.set(v, (entry.unknownStatuses.get(v) || 0) + n); });
        entry.remaining.creates += rep.deferred;
        if (rep.moreRows) entry.remaining.campaignsWithMoreRows++;
        if (rep.nearLimit && !entry.warnings.includes("workspace-near-limit")) entry.warnings.push("workspace-near-limit");
        if (rep.aborted) { abortRun(entry, rep.aborted, eligible.length - visited); break; }
      }
      entry.ok = !entry.errors.length && !entry.aborted && !entry.campaigns.some((x) => x.status === "error");
      return finish(entry);
    } catch (err) {
      entry.errors.push(errCode(err));
      logger.error("Notion applicants run failed: " + errCode(err));
      return finish(entry);
    }
  }

  /* repeated 429s: stop the whole run (the next campaign would only be refused too) and rest for a while */
  function abortRun(entry, err, notVisited) {
    entry.aborted = "rate-limited";
    entry.errors.push("rate-limited: the run was stopped");
    entry.remaining.campaignsNotVisited += Math.max(0, notVisited);
    const wait = Math.max(cfg.cooldownMs, (Number(err && err.retryAfterSec) || 0) * 1000);
    coolUntil = now().getTime() + wait;
    logger.error("Notion applicants: Notion kept answering 429 (too many requests); the run was stopped, resting " + Math.round(wait / 1000) + " s.");
  }

  async function syncCampaign(campaignId, x) {
    const out = { created: 0, deferred: 0, unknown: new Map(), moreRows: false, nearLimit: false, aborted: null, report: { campaignId, status: "error" } };
    const R = out.report;
    if (x.mappingNote && x.mappingNote[campaignId]) R.mapping = x.mappingNote[campaignId];
    try {
      /* the settings this run uses are read once, from the workspace as it is now */
      const doc0 = await d.loadWorkspace();
      const cp0 = doc0 && doc0.db && Array.isArray(doc0.db.campaigns) && doc0.db.campaigns.find((c) => c && c.id === campaignId);
      if (!cp0) { R.status = "skipped"; R.why = "campaign-gone"; return out; }
      const virtual = x.virtual[campaignId];
      if (virtual && !hasAnyMapping(cp0)) cp0.notionMapping = Object.assign({}, virtual);   // dry run: the mapping that WOULD be saved; the document is never saved
      const dsKey = normalizeId(cp0.notionDatabaseId);
      const stc = x.st.campaigns[campaignId];
      const same = !!(stc && stc.ds === dsKey);
      const rescan = x.rescan.has(campaignId);
      const since = rescan ? null : (same ? stc.cursor : null);
      const baseline = !rescan && !(same && stc.baselineDone);
      R.baseline = baseline;

      let fetched;
      try { fetched = await fetchRows(dsKey, since); }
      catch (err) {
        R.status = "error"; R.why = "query-failed:" + errCode(err);
        logger.error("Notion applicants: query failed for " + campaignId + " (" + errCode(err) + ")");
        if (err && err.rateLimited) out.aborted = err;
        return out;
      }
      const rows = fetched.rows;
      R.rows = rows.length;
      R.moreRows = fetched.truncated;
      out.moreRows = fetched.truncated;

      /* held rows from earlier runs, read again by page id (bounded) */
      const heldBefore = rescan ? {} : (same && stc ? stc.held : {});
      const retried = [];
      const inFetched = new Set(rows.map((r) => normalizeId(r.pageId) || str(r.pageId)));
      const gone = [];
      const failedTry = new Set();
      if (typeof d.getPage === "function" && cfg.maxHeldRetry > 0) {
        const t = now().getTime();
        const due = Object.entries(heldBefore)
          .filter(([pg, h]) => !inFetched.has(pg) && (h.tries < HELD_EVERY_RUN || !h.lastTryAt || t - Date.parse(h.lastTryAt) >= HELD_SLOW_MS))
          .sort((a, b) => str(a[1].lastTryAt).localeCompare(str(b[1].lastTryAt)))
          .slice(0, Math.max(0, cfg.maxHeldRetry - x.heldUsed.n));
        for (const [pg] of due) {
          x.heldUsed.n++;
          try {
            const r = await d.getPage(pg);
            if (r) { r.retry = true; retried.push(r); } else gone.push(pg);   // trashed or archived: nothing to import any more
          } catch (err) {
            if (err && err.rateLimited) { out.aborted = err; R.status = "error"; R.why = "rate-limited"; return out; }
            if (err && (err.status === 404 || err.status === 403)) gone.push(pg);   // no longer visible to the integration
            else failedTry.add(pg);                                                  // read failed: stays held, counts as a try
          }
        }
      }
      R.heldRetried = retried.length;
      const allRows = rows.concat(retried);

      let rep = null, attempts = 0, saved = false, lastDoc = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        const doc = attempt === 1 ? doc0 : await d.loadWorkspace();
        const cp = doc && doc.db && Array.isArray(doc.db.campaigns) && doc.db.campaigns.find((c) => c && c.id === campaignId);
        if (!cp) { R.status = "skipped"; R.why = "campaign-gone"; return out; }
        if (virtual && attempt > 1 && !hasAnyMapping(cp)) cp.notionMapping = Object.assign({}, virtual);
        /* the form or the mapping was changed by someone while we were reading: do not apply rows read for another form */
        if (normalizeId(cp.notionDatabaseId) !== dsKey) { R.status = "skipped"; R.why = "source-changed"; return out; }
        /* growth guard: past the set share of the browser save limit no row is added (links and edits still go through) */
        lastDoc = doc;
        const nearLimit = x.docBytes.n > x.limit;
        out.nearLimit = nearLimit;
        rep = applyRows({
          db: doc.db, cp, rows: allRows, shared: d.shared.bind(x.startedAt.slice(0, 10)), newId: d.newId,
          nowIso: x.startedAt, baseline, createBudget: nearLimit ? 0 : x.createBudget, budgetReason: nearLimit ? "workspace-near-limit" : "create-cap",
          snap: same && stc ? stc.snap : {}
        });
        if (!rep.changed || x.dryRun) { saved = true; break; }
        const res = await d.saveWorkspace({ db: doc.db, settings: doc.settings || {}, revision: doc.revision || 0 });
        if (res && res.ok) { saved = true; break; }
        if (res && res.conflict) { rep = null; continue; } // somebody saved first: re-read, re-apply, never force
        throw new Error("save was refused");
      }
      R.attempts = attempts;
      if (!saved || !rep) {
        R.status = "error"; R.why = "workspace-kept-changing";
        x.entry.errors.push("workspace kept changing for " + campaignId + "; nothing was written");
        return out;
      }
      if (out.nearLimit) R.workspace = "workspace-near-limit";
      if (!x.dryRun && (rep.created.length || rep.newCreators) && lastDoc) {
        /* keep the size current for the campaigns after this one (measured, not guessed; only when rows were added, which the create cap bounds) */
        x.docBytes.n = sizeOf({ db: lastDoc.db, settings: lastDoc.settings || {} });
      }

      R.status = x.dryRun ? "dry-run" : "ok";
      R.counts = {
        created: rep.created.length, linked: rep.linked.length, updated: rep.updated.length, already: rep.already,
        ambiguous: rep.ambiguous.length, held: rep.held.length, deferred: rep.deferred.length,
        differs: rep.differs.length, elsewhere: rep.elsewhere.length, newCreators: rep.newCreators, edited: rep.edited.length
      };
      R.created = rep.created; R.linked = rep.linked; R.updated = rep.updated; R.ambiguous = rep.ambiguous;
      R.held = rep.held; R.deferred = rep.deferred; R.differs = rep.differs; R.elsewhere = rep.elsewhere; R.edited = rep.edited;
      out.created = rep.created.length; out.deferred = rep.deferred.length; out.unknown = rep.unknown;

      /* where the next run starts. Only after the save above succeeded (or
         there was nothing to save), never in a dry run, and never past a row
         that was held back by the create cap. Held rows do not hold the
         cursor back: they are remembered by page id and read again. */
      const old = rescan ? null : (same ? stc.cursor : null);
      let cursor = old;
      const lastEdit = rows.length ? rows[rows.length - 1].lastEdited : "";
      if (rep.stopAt) cursor = rep.stopAt;
      else if (lastEdit) cursor = lastEdit;
      if (old && cursor && cursor < old) cursor = old; // never backwards
      if (fetched.truncated && !fetched.sorted) { cursor = old; R.cursorNote = "unsorted-truncated"; }
      else if (fetched.truncated && cursor === old && rows.length) R.cursorNote = "cursor-stalled";
      R.cursorMoved = cursor !== old;
      const complete = !fetched.truncated && !rep.stopAt;

      /* the held list after this run: rows still unresolved (new ones with try 0), minus rows that resolved or are gone */
      const t1 = now().toISOString();
      const heldNext = {};
      const retriedIds = new Set(retried.map((r) => normalizeId(r.pageId) || str(r.pageId)));
      Object.entries(heldBefore).forEach(([pg, h]) => {
        if (gone.includes(pg)) return;
        const ran = retriedIds.has(pg) || inFetched.has(pg);
        if (ran) return;                                   // looked at this run: only stays if unresolved (below)
        heldNext[pg] = failedTry.has(pg) ? Object.assign({}, h, { lastTryAt: t1, tries: h.tries + 1 }) : h;   // not due: unchanged
      });
      rep.unresolved.forEach((why, pg) => {
        const prev = heldBefore[pg];
        heldNext[pg] = { why, since: prev && prev.since ? prev.since : t1, lastTryAt: t1, tries: (prev ? prev.tries : 0) + (retriedIds.has(pg) ? 1 : 0) };
      });
      const heldKeys = Object.keys(heldNext);
      if (heldKeys.length > HELD_CAP) {
        heldKeys.sort((a, b) => str(heldNext[a].since).localeCompare(str(heldNext[b].since))).slice(HELD_CAP).forEach((k) => { delete heldNext[k]; });
        x.entry.warnings.push("held-list-full");
      }
      R.heldRemembered = Object.keys(heldNext).length;

      if (!x.dryRun) {
        try {
          const mk = (prev) => {
            const snap = Object.assign({}, same && prev ? prev.snap : {});
            rep.snapPatch.forEach((patch, pg) => { snap[pg] = Object.assign({}, snap[pg] || {}, patch); });
            const keys = Object.keys(snap);
            if (keys.length > SNAP_CAP) keys.slice(0, keys.length - SNAP_CAP).forEach((k) => { delete snap[k]; });   // oldest fingerprints go first; a row without one is simply fill-only
            return {
              ds: dsKey, cursor: cursor || null,
              baselineDone: complete ? true : (same && stc ? !!stc.baselineDone : false),
              lastRunAt: x.startedAt, snap, held: heldNext
            };
          };
          await mutateState((s) => {
            s.campaigns[campaignId] = mk(s.campaigns[campaignId]);
            const ids = new Set(((doc0.db && doc0.db.campaigns) || []).map((c) => c && c.id));
            Object.keys(s.campaigns).forEach((k) => { if (!ids.has(k)) delete s.campaigns[k]; });
          });
          x.st.campaigns[campaignId] = mk(x.st.campaigns[campaignId]);
        } catch (err) {
          R.status = "error"; R.why = "state-not-saved";
          x.entry.errors.push("could not save the job state for " + campaignId);
        }
      }
      return out;
    } catch (err) {
      R.status = "error"; R.why = "failed:" + errCode(err);
      logger.error("Notion applicants: campaign " + campaignId + " failed (" + errCode(err) + ")");
      if (err && err.rateLimited) out.aborted = err;
      return out;
    }
  }

  async function finish(entry) {
    /* a Map while counting, a list in the answer. Unknown status text is never kept: one bucket, "unknown". */
    entry.unknownStatuses = [...entry.unknownStatuses].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const sum = (k) => entry.campaigns.reduce((n, c) => n + ((c.counts && c.counts[k]) || 0), 0);
    entry.counts = {
      campaignsSynced: entry.campaigns.filter((c) => c.status === "ok" || c.status === "dry-run").length,
      campaignsSkipped: entry.campaigns.filter((c) => c.status === "skipped").length,
      campaignsFailed: entry.campaigns.filter((c) => c.status === "error").length,
      created: sum("created"), linked: sum("linked"), updated: sum("updated"), already: sum("already"),
      ambiguous: sum("ambiguous"), held: sum("held"), deferred: sum("deferred"), differs: sum("differs"), edited: sum("edited"),
      unknownStatusRows: entry.unknownStatuses.reduce((n, u) => n + u.count, 0), errors: entry.errors.length, warnings: entry.warnings.length
    };
    last = entry;       // in memory only, so a dry run can be read back from /status
    running = false;
    /* a dry run is not written anywhere */
    try { if (d.saveLog && !entry.dryRun) await d.saveLog(entry); } catch (e) { /* best effort */ }
    return entry;
  }

  return { run, stateSummary, lastRun: () => last, isRunning: () => running };
}

/* ---------------------------- staff routes ---------------------------- */

/* Registers the two staff-only routes on an express app. `requireStaff` is the
   server's own guard (401 without a session, 403 for a signed-in account that
   is not staff). `get()` returns the live pieces, so a server where the job is
   off can still answer with the reason. */
function registerRoutes(app, requireStaff, get) {
  app.post("/api/notion-applicants/run", requireStaff(async (req, res) => {
    const g = get();
    if (!g.applicants) return res.status(503).json({ error: "Applicant sync is not enabled on this server.", reason: g.off });
    const b = req.body || {};
    const rescan = Array.isArray(b.rescan) ? b.rescan.filter((x) => typeof x === "string" && x.length <= 80).slice(0, 20) : undefined;
    const campaignId = typeof b.campaignId === "string" && b.campaignId.length <= 80 ? b.campaignId : undefined;
    const entry = await g.applicants.run({ trigger: "manual", dryRun: b.dryRun ? true : undefined, campaignId, rescan });
    if (entry && entry.throttled) return res.status(429).json({ error: "A run was started a moment ago. Wait and try again.", retryAfterSec: entry.retryAfterSec });
    if (entry && entry.skipped === "cooling-down") return res.status(429).json({ error: "Notion asked us to slow down; the job is resting.", retryAfterSec: entry.retryAfterSec });
    return res.json({ ok: true, run: entry });
  }));

  app.get("/api/notion-applicants/status", requireStaff(async (req, res) => {
    const g = get();
    const base = { enabled: !!g.applicants, reason: g.applicants ? "" : g.off,
      intervalMin: g.applicants ? g.cfg.intervalMin : null, dryRun: g.applicants ? g.cfg.dryRun : null };
    if (!g.applicants) return res.json({ ok: true, ...base, last: null, history: [] });
    try { base.state = await g.applicants.stateSummary(); } catch (err) { console.error("Notion applicants state read failed."); }
    let last = g.applicants.lastRun();
    let history = [];
    try { if (g.logStore) history = await g.logStore.readHistory(); } catch (err) { console.error("Notion applicants history read failed."); }
    if (!last) { try { if (g.logStore) last = await g.logStore.readLast(); } catch (err) { console.error("Notion applicants status read failed."); } }
    return res.json({ ok: true, ...base, last, history });
  }));
}

module.exports = {
  loadShared, sliceDecl, parseConfig, makeQueryRows, makeGetPage, makeNotionCaller, makeNotionApi, pageToRow,
  buildDefaultMapping, applyRows, createApplicants, normState, makeLogStore, registerRoutes, fieldHash, EXTRA_STATUS, INTAKE_FIELDS,
  BROWSER_SAVE_LIMIT_BYTES
};
