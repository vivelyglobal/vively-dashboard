/* ===================================================================
   Confirmed visit date: dashboard -> Notion row and campaign Sheet row.

   The dashboard is the master for booking dates (founder decision
   2026-11-23). This job copies a participant's confirmedVisitAt, and
   nothing else, to two mirrors so nobody types it twice:

     Notion  one DATE property on the creator's Responses row, by default
             "Confirmed Visit". It is never the creator's own "Visit Date"
             request, and it is never created: if the property is missing
             or is not a date, that is reported and the row is skipped.
     Sheet   one cell: the "Visiting Date" column of the matching row, in
             the template's own text format ("Seongsu store: Oct 17 17.30").
             The columns are found by HEADER TEXT ("Instagram", "Visiting
             Date"); if either header is not found the tab is refused. The
             row is found by the creator's Instagram handle, with the creator
             name only as a tie-break. Zero or several matches are reported
             and nothing is written. Right before each write the row's
             Instagram cell and target cell are read again (one batched
             read); if the handle moved, nothing is written ("row-moved").

   Hand-typed values: a Confirmed Visit value (Notion) or a Visiting Date
   cell (Sheet) that is not what this system last wrote is never
   overwritten; it is reported as "edited-by-hand". Staff can force ONE
   overwrite by creator id on a manual live run (opts.force).

   Both are OFF unless their env flag is set, and each has a dry run that
   writes nothing. The job reads the workspace, never writes it, so it
   cannot collide with a save. It runs server-side (after a save, on a
   timer, or on a staff call), so it does not need an open browser tab,
   and a failure here can never block or fail a dashboard save.

   What is remembered (Mongo, collection date_writeback_log): per
   participant and channel, the text last written (the "ledger"), plus a
   retry record for anything that failed. The ledger is what makes a
   second run a no-op without a single call. When the ledger is missing
   or differs, the job still reads the target first and skips the write
   if it already holds the value.

   Privacy: the entry, the log lines and the status carry counts, ids,
   outcome words and sheet row numbers. Never a name, handle, address,
   phone or the date text itself.
   =================================================================== */
"use strict";

const { normHandle, wallClockToInstant } = require("./booking-store.js");
const { normaliseTitle, normalizeId } = require("./notion-autocreate.js");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");

/* ---------------------------- slots and text ---------------------------- */

/* "2026-09-04 19:00" or "2026-09-04" (the dashboard's own slot format) */
function parseSlot(v) {
  const m = String(v == null ? "" : v).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  let time = "";
  if (m[4] !== undefined) {
    const h = +m[4], mi = +m[5];
    if (h > 23 || mi > 59) return null;
    time = pad2(h) + ":" + pad2(mi);
  }
  const date = m[1] + "-" + m[2] + "-" + m[3];
  return { date, time, month: mo, day: d, canonical: time ? date + " " + time : date };
}

/* Store name for the sheet text. Control characters and a leading = + - @
   are removed so a venue name can never read as a formula, and a trailing
   word "store" is dropped because the format adds it. */
function storeLabel(v) {
  let s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[=+\-@\s]+/, "").replace(/\s+store$/i, "").trim();
  return s.slice(0, 60);
}

/* '<Store> store: <Mon D> <HH.MM>' ; without a store: '<Mon D> <HH.MM>' ;
   without a time: no time part. */
function sheetText(slot, store) {
  const s = typeof slot === "string" ? parseSlot(slot) : slot;
  if (!s) return "";
  const when = MONTHS[s.month - 1] + " " + s.day + (s.time ? " " + s.time.replace(":", ".") : "");
  const label = storeLabel(store);
  return label ? label + " store: " + when : when;
}

/* the Notion date object for a slot. A time is wall-clock at the venue, so
   the zone travels with it; a date alone has no time and no zone. */
function notionDateValue(slot, tz) {
  const s = typeof slot === "string" ? parseSlot(slot) : slot;
  if (!s) return null;
  return s.time ? { start: s.date + "T" + s.time + ":00", time_zone: tz } : { start: s.date };
}

/* does a Notion date value (as read back) already say this slot? */
function notionDateEquals(cur, slot, tz) {
  const s = typeof slot === "string" ? parseSlot(slot) : slot;
  if (!s || !cur || typeof cur.start !== "string" || cur.end) return false;
  const start = cur.start;
  if (!s.time) return start === s.date;
  if (start.length <= 10) return false;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(start)) {
    const want = wallClockToInstant(s.date, s.time, tz);
    return !!want && Date.parse(start) === want.getTime();
  }
  return start.slice(0, 16) === s.date + "T" + s.time && (!cur.time_zone || cur.time_zone === tz);
}

/* ---------------------------- matching ---------------------------- */

const normName = (v) => String(v == null ? "" : v).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/* Rows are 0-based indexes into the columns; `from` skips the header.
   Primary key: the normalised Instagram handle. Name only breaks a tie.
   Returns { kind: "match", index } | { kind: "none" } | { kind: "multiple", indexes } */
function matchRow(handleCol, handle, from, nameOf, name) {
  const h = normHandle(handle);
  if (!h) return { kind: "none", why: "no-handle" };
  const hits = [];
  for (let i = from; i < handleCol.length; i++) if (normHandle(handleCol[i]) === h) hits.push(i);
  if (!hits.length) return { kind: "none", why: "no-match" };
  if (hits.length === 1) return { kind: "match", index: hits[0] };
  const n = normName(name);
  const byName = n ? hits.filter((i) => normName(nameOf(i)) === n) : [];
  if (byName.length === 1) return { kind: "match", index: byName[0] };
  return { kind: "multiple", indexes: hits };
}

/* tab for a campaign: an explicit mapping first, then an exact normalised
   title match against the campaign's name, "brand name" or Notion title.
   The brand alone is deliberately not used: two campaigns share a brand. */
function resolveTab(cp, titles, tabMap) {
  const exact = (want) => (want && titles.includes(want) ? want : null);
  const mapped = exact(tabMap && tabMap[cp.id]) || exact(cp.sheetTab);
  if (mapped) return { tab: mapped };
  const keys = new Set();
  [cp.name, cp.brand && cp.name ? cp.brand + " " + cp.name : "", cp.notionTitle]
    .forEach((v) => { const k = normaliseTitle(v); if (k) keys.add(k); });
  const hits = titles.filter((t) => keys.has(normaliseTitle(t)));
  if (hits.length === 1) return { tab: hits[0] };
  return { why: hits.length ? "tab-ambiguous" : "no-tab" };
}

/* ---------------------------- config ---------------------------- */

const headerNorm = (v) => String(v == null ? "" : v).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const listOf = (raw) => String(raw == null ? "" : raw).split(",").map(headerNorm).filter(Boolean);
const uniq = (a) => [...new Set(a)];

/* properties the creator's own form fills in (or the system owns): never a
   target. Compared case-insensitively, trimmed, spaces collapsed. */
const NOTION_DENY = ["visit date", "submission time", "full name", "instagram link", "status"];
function notionPropertyProblem(name, extraDeny) {
  const n = headerNorm(name);
  if (!n) return "NOTION_DATE_PROPERTY is empty";
  if (NOTION_DENY.concat(listOf(extraDeny)).includes(n)) return "NOTION_DATE_PROPERTY is a property the form or the system fills in";
  return null;
}

const colIndex = (L) => String(L).split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/* Find a column by its header text. An explicit letter from the environment
   is trusted ONLY if that column's header text matches. */
function findColumn(header, aliases, explicit) {
  const hits = [];
  (header || []).forEach((c, i) => { if (aliases.includes(headerNorm(c))) hits.push(i); });
  if (explicit) return hits.includes(colIndex(explicit)) ? { col: explicit } : { why: "mismatch" };
  if (hits.length === 1) return { col: colName(hits[0]) };
  return { why: hits.length ? "ambiguous" : "missing" };
}

/* -> { ig, visit, name } letters, or { why } (nothing may be written) */
function locateColumns(header, sheetCfg) {
  const h = sheetCfg.headers, c = sheetCfg.cols;
  const ig = findColumn(header, h.instagram, c.instagram);
  if (!ig.col) return { why: "instagram-header-" + ig.why };
  const visit = findColumn(header, h.visit, c.visit);
  if (!visit.col) return { why: "visit-header-" + visit.why };
  if (ig.col === visit.col) return { why: "header-ambiguous" };
  const name = findColumn(header, h.name, c.name);
  return { ig: ig.col, visit: visit.col, name: name.col && name.col !== ig.col && name.col !== visit.col ? name.col : null };
}

const truthy = (v) => /^(1|true|yes)$/i.test(String(v == null ? "" : v).trim());
const num = (v) => (String(v == null ? "" : v).trim() === "" ? NaN : Number(v));
const colLetter = (v, dflt) => { const s = String(v || "").trim().toUpperCase(); return /^[A-Z]{1,3}$/.test(s) ? s : dflt; };

function parseConfig(env) {
  const e = env || {};
  const mins = num(e.DATE_WRITEBACK_INTERVAL_MIN);
  const intervalMin = Number.isFinite(mins) && mins > 0 ? Math.min(Math.max(mins, 1), 1440) : 10;
  const cap = num(e.DATE_WRITEBACK_MAX_PER_RUN);
  const past = num(e.DATE_WRITEBACK_PAST_DAYS);
  let tz = String(e.DATE_WRITEBACK_TZ || "").trim() || "Asia/Seoul";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch (err) { tz = "Asia/Seoul"; }
  let tabMap = {};
  try {
    const raw = String(e.SHEET_WRITEBACK_TAB_MAP || "").trim();
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach((k) => { if (typeof parsed[k] === "string" && parsed[k]) tabMap[k] = parsed[k]; });
    }
  } catch (err) { tabMap = {}; }
  const property = String(e.NOTION_DATE_PROPERTY || "").trim() || "Confirmed Visit";
  const hdrRow = num(e.SHEET_HEADER_ROW);
  return {
    intervalMin, intervalMs: Math.round(intervalMin * 60000),
    maxPerRun: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 25,
    pastDays: Number.isFinite(past) && past >= 0 ? Math.floor(past) : 7,
    tz,
    notion: { requested: truthy(e.NOTION_DATE_WRITEBACK), dryRun: truthy(e.NOTION_DATE_WRITEBACK_DRY_RUN), property, denyExtra: e.NOTION_DATE_PROPERTY_DENY, propertyError: notionPropertyProblem(property, e.NOTION_DATE_PROPERTY_DENY) },
    sheet: {
      requested: truthy(e.SHEET_DATE_WRITEBACK), dryRun: truthy(e.SHEET_DATE_WRITEBACK_DRY_RUN),
      spreadsheetRaw: String(e.SHEET_WRITEBACK_SPREADSHEET_ID || "").trim(),
      /* the header row holds the column titles; data starts below it */
      headerRow: Number.isInteger(hdrRow) && hdrRow >= 1 && hdrRow <= 10 ? hdrRow : 1,
      /* optional letters: used only if the header text at that letter matches */
      cols: { instagram: colLetter(e.SHEET_COL_INSTAGRAM, null), name: colLetter(e.SHEET_COL_NAME, null), visit: colLetter(e.SHEET_COL_VISIT, null) },
      headers: {
        instagram: uniq(["instagram"].concat(listOf(e.SHEET_HEADER_INSTAGRAM))),
        visit: uniq(["visiting date"].concat(listOf(e.SHEET_HEADER_VISIT))),
        name: uniq(["name", "creator name", "full name"].concat(listOf(e.SHEET_HEADER_NAME)))
      },
      tabMap
    }
  };
}

/* ---------------------------- the job ---------------------------- */

const ITEM_LIMIT = 200;
const WAIT_MIN = 60;           // a "needs a person" outcome is looked at again after this long
const BREAKER = 3;             // consecutive failed calls that stop one channel for the rest of a run

const emptyRec = () => ({ done: null, want: null, tries: 0, nextAt: 0, why: null, gaveUp: false });
function normState(raw) {
  const items = {};
  const src = raw && typeof raw === "object" && raw.items && typeof raw.items === "object" ? raw.items : {};
  Object.keys(src).forEach((k) => {
    const it = src[k] || {};
    items[k] = { n: Object.assign(emptyRec(), it.n || {}), s: Object.assign(emptyRec(), it.s || {}) };
  });
  return { items };
}

const errCode = (e) => (e && e.status ? "http-" + e.status : "network");
const isTransient = (e) => !e || !e.status || e.status === 429 || e.status >= 500;

/* deps:
     config            parseConfig() result (each channel needs `enabled`
                       decided by the caller: notion.enabled / sheet.enabled)
     loadWorkspace()   -> { db } | null            (read only)
     loadState() / saveState(s), saveLog(entry)    (Mongo; memory if absent)
     notion(method, path, body)  -> parsed JSON or throws {status}
     sheets            makeSheetsClient() result or null
     venueNames(targets) -> Map(participantId -> venue name)
     now(), sleep(ms), logger, retryDelayMs */
function createDateWriteback(deps) {
  const d = deps;
  const cfg = d.config;
  const logger = d.logger || console;
  const nowMs = () => (d.now ? d.now() : new Date()).getTime();
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryDelay = Number.isFinite(d.retryDelayMs) ? d.retryDelayMs : 500;
  const attempts = d.attempts || 3;
  const maxTries = d.maxTries || 8;
  const debounceMs = Number.isFinite(d.debounceMs) ? d.debounceMs : 5000;
  const notionOn = !!(cfg.notion.enabled && d.notion && !notionPropertyProblem(cfg.notion.property, cfg.notion.denyExtra));
  const sheetOn = !!(cfg.sheet.enabled && d.sheets);
  let running = false;
  let last = null;
  let memState = null;
  let timer = null;
  let rerun = false;

  const readState = async () => normState(d.loadState ? await d.loadState() : memState);
  const writeState = async (s) => { if (d.saveState) await d.saveState(s); else memState = structuredClone(s); };

  async function withRetry(fn) {
    let err;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); } catch (e) {
        err = e;
        if (!isTransient(e) || i === attempts - 1) break;
        await sleep(retryDelay * Math.pow(2, i));
      }
    }
    throw err;
  }

  /* ---- ledger records ---- */
  const markDone = (r, want) => { r.done = want; r.want = null; r.tries = 0; r.nextAt = 0; r.why = null; r.gaveUp = false; };
  /* needs a person (property missing, no match, ...): looked at again later, not counted as a failure */
  const markWait = (r, want, why) => { r.want = want; r.why = why; r.nextAt = nowMs() + WAIT_MIN * 60000; r.tries = 0; r.gaveUp = false; };
  const markFail = (r, want, why) => {
    r.tries = r.want === want ? r.tries + 1 : 1;
    r.want = want; r.why = why;
    r.gaveUp = r.tries >= maxTries;
    r.nextAt = nowMs() + Math.min(Math.pow(2, r.tries), 60) * 60000;
  };
  function gate(r, want, manual) {
    if (r.done === want) return "unchanged";
    if (manual || r.want !== want) return null;
    if (r.gaveUp) return "gave-up";
    if (r.nextAt && r.nextAt > nowMs()) return "waiting";
    return null;
  }

  /* ---- what to consider ---- */
  function collectTargets(ws, stats) {
    const db = (ws && ws.db) || {};
    const cps = new Map((db.campaigns || []).map((c) => [c.id, c]));
    const crs = new Map((db.creators || []).map((c) => [c.id, c]));
    const cutoff = nowMs() - cfg.pastDays * 86400000;
    const out = [];
    (db.participants || []).forEach((p) => {
      if (!p || !p.confirmedVisitAt) return;
      const slot = parseSlot(p.confirmedVisitAt);
      if (!slot) { stats.badDate++; return; }
      if (p.stage === "dropped") { stats.dropped++; return; }
      if (Date.parse(slot.date + "T00:00:00Z") < cutoff) { stats.tooOld++; return; }
      const cp = cps.get(p.campaignId);
      if (!cp) { stats.noCampaign++; return; }
      out.push({ id: p.id, campaignId: cp.id, cp, p, cr: crs.get(p.creatorId) || {}, slot });
    });
    return out;
  }

  function newChannel(on, dry) { return { enabled: on, dryRun: dry, counts: {}, error: null, flags: {} }; }

  /* ---- Notion ---- */
  async function runNotion(targets, ctx) {
    const ch = ctx.entry.channels.notion;
    const prop = cfg.notion.property;
    const dry = ctx.dry || cfg.notion.dryRun;
    let writes = 0, strikes = 0;
    const missing = new Map();          // campaignId -> why, learned in this run
    for (const t of targets) {
      const r = ctx.state.items[t.id].n;
      const want = t.slot.canonical;
      const note = (outcome, extra) => ctx.note(ch, "notion", t, outcome, extra);
      const g = gate(r, want, ctx.manual);
      if (g) { note(g, r.why && g !== "unchanged" ? { why: r.why } : null); continue; }
      const pageId = normalizeId(t.p.notionPageId);
      if (!pageId) { note("no-page-id"); continue; }
      if (missing.has(t.campaignId) && !ctx.manual) { note("waiting", { why: missing.get(t.campaignId) }); markWait(r, want, missing.get(t.campaignId)); continue; }
      if (strikes >= BREAKER) { note("channel-stopped"); continue; }
      if (writes >= cfg.maxPerRun) { note("deferred"); continue; }
      try {
        const page = await withRetry(() => d.notion("GET", "/pages/" + pageId));
        strikes = 0;
        if (page && (page.archived || page.in_trash)) { markWait(r, want, "page-archived"); note("waiting", { why: "page-archived" }); continue; }
        const cur = page && page.properties && page.properties[prop];
        if (!cur || cur.type !== "date") {
          const why = !cur ? "property-missing" : "property-not-date";
          missing.set(t.campaignId, why);
          markWait(r, want, why); note("waiting", { why }); continue;
        }
        if (notionDateEquals(cur.date, t.slot, cfg.tz)) { markDone(r, want); note("unchanged-remote"); continue; }
        /* a value is there and it is not what this system last wrote: a person
           typed it. Never overwritten, except by a staff force for this creator. */
        if (cur.date && cur.date.start) {
          const lastWrote = r.done ? parseSlot(r.done) : null;
          const ours = !!lastWrote && notionDateEquals(cur.date, lastWrote, cfg.tz);
          if (!ours && !(ctx.force && ctx.force.has(String(t.p.creatorId)))) {
            const why = r.done ? "edited-by-hand" : "has-other-value";
            markWait(r, want, why); note("edited-by-hand", { why }); continue;
          }
        }
        writes++;
        if (dry) { note("would-write"); continue; }
        await withRetry(() => d.notion("PATCH", "/pages/" + pageId, { properties: { [prop]: { date: notionDateValue(t.slot, cfg.tz) } } }));
        markDone(r, want); note("written");
      } catch (e) {
        const why = errCode(e);
        if (isTransient(e)) { strikes++; markFail(r, want, why); note(r.gaveUp ? "gave-up" : "failed", { why }); }
        else { strikes++; markWait(r, want, why); note("waiting", { why }); }
      }
    }
  }

  /* ---- Sheet ---- */
  async function runSheet(targets, ctx) {
    const ch = ctx.entry.channels.sheet;
    const sc = d.sheets;
    const dry = ctx.dry || cfg.sheet.dryRun;
    const cols = cfg.sheet.cols;
    let venues;
    try { venues = d.venueNames ? await d.venueNames(targets) : new Map(); } catch (e) {
      ch.error = "venue-lookup-failed";
      targets.forEach((t) => ctx.note(ch, "sheet", t, "skipped-run", { why: "venue-lookup-failed" }));
      return;
    }
    const pending = [];
    for (const t of targets) {
      const store = storeLabel(venues.get(t.id));
      t.text = sheetText(t.slot, store);
      t.noStore = !store;
      const r = ctx.state.items[t.id].s;
      const g = gate(r, t.text, ctx.manual);
      if (g) ctx.note(ch, "sheet", t, g, r.why && g !== "unchanged" ? { why: r.why } : null);
      else pending.push(t);
    }
    if (!pending.length) return;

    const failAll = (list, e) => list.forEach((t) => {
      const r = ctx.state.items[t.id].s; markFail(r, t.text, errCode(e));
      ctx.note(ch, "sheet", t, r.gaveUp ? "gave-up" : "failed", { why: errCode(e) });
    });
    let titles;
    try { titles = await withRetry(() => sc.listTabs()); } catch (e) { ch.error = errCode(e); failAll(pending, e); return; }

    const groups = new Map();
    pending.forEach((t) => { if (!groups.has(t.campaignId)) groups.set(t.campaignId, []); groups.get(t.campaignId).push(t); });
    let writes = 0, strikes = 0;
    const claimed = new Set();
    for (const [, list] of groups) {
      const rt = resolveTab(list[0].cp, titles, cfg.sheet.tabMap);
      const wait = (t, why) => { markWait(ctx.state.items[t.id].s, t.text, why); ctx.note(ch, "sheet", t, "waiting", { why }); };
      if (!rt.tab) { list.forEach((t) => wait(t, rt.why)); continue; }
      /* 1. the columns are found by their header text, or nothing is written */
      let header;
      try { header = await withRetry(() => sc.readHeaderRow(rt.tab, cfg.sheet.headerRow)); strikes = 0; } catch (e) {
        strikes++; ch.error = errCode(e); failAll(list, e); continue;
      }
      const loc = locateColumns(header, cfg.sheet);
      if (loc.why) { list.forEach((t) => wait(t, loc.why)); continue; }
      let data;
      try { data = await withRetry(() => sc.readColumns(rt.tab, [loc.ig, loc.visit])); strikes = 0; } catch (e) {
        strikes++; ch.error = errCode(e); failAll(list, e); continue;
      }
      const ig = data[loc.ig] || [], visit = data[loc.visit] || [];
      const from = cfg.sheet.headerRow;      // 0-based index of the first row under the header
      let names = null;
      for (const t of list) {
        const r = ctx.state.items[t.id].s;
        if (strikes >= BREAKER) { ctx.note(ch, "sheet", t, "channel-stopped"); continue; }
        let m = matchRow(ig, t.cr.handle, from, () => "", "");
        if (m.kind === "multiple" && loc.name) {
          try {
            if (!names) names = (await withRetry(() => sc.readColumns(rt.tab, [loc.name])))[loc.name] || [];
          } catch (e) { strikes++; ch.error = errCode(e); failAll([t], e); continue; }
          m = matchRow(ig, t.cr.handle, from, (i) => names[i] || "", t.cr.name || t.p.fullName);
        }
        if (m.kind === "none") { wait(t, m.why); continue; }
        if (m.kind === "multiple") { wait(t, "multiple-matches"); continue; }
        const row = m.index + 1;
        const key = rt.tab + "\u0000" + row;
        if (claimed.has(key)) { wait(t, "row-shared"); continue; }
        claimed.add(key);
        if (visit[m.index] === t.text) { markDone(r, t.text); ctx.note(ch, "sheet", t, "unchanged-remote", { row }); continue; }
        /* 2. the row number came from an earlier read: look again, in one
           batched read, immediately before the write. A sorted sheet or an
           inserted row means the handle is no longer there: do not write,
           and match again on the next run. */
        let cur;
        try { cur = await withRetry(() => sc.readCells(rt.tab, [{ col: loc.ig, row }, { col: loc.visit, row }])); strikes = 0; } catch (e) {
          strikes++; ch.error = errCode(e); failAll([t], e); continue;
        }
        if (!normHandle(cur[0]) || normHandle(cur[0]) !== normHandle(t.cr.handle)) { ctx.note(ch, "sheet", t, "row-moved", { row }); continue; }
        const existing = cur[1];
        if (existing === t.text) { markDone(r, t.text); ctx.note(ch, "sheet", t, "unchanged-remote", { row }); continue; }
        /* 3. a cell that is not empty and is not what this system last wrote
           was typed by a person: reported, not overwritten (unless forced) */
        if (existing && existing !== r.done && !(ctx.force && ctx.force.has(String(t.p.creatorId)))) {
          const why = r.done ? "edited-by-hand" : "cell-has-other-text";
          markWait(r, t.text, why); ctx.note(ch, "sheet", t, "edited-by-hand", { row, why }); continue;
        }
        if (t.noStore) ch.flags["no-store-name"] = (ch.flags["no-store-name"] || 0) + 1;
        if (writes >= cfg.maxPerRun) { ctx.note(ch, "sheet", t, "deferred", { row }); continue; }
        writes++;
        if (dry) { ctx.note(ch, "sheet", t, "would-write", { row }); continue; }
        try {
          await withRetry(() => sc.writeVisitCell(rt.tab, row, t.text, loc.visit));
          strikes = 0; visit[m.index] = t.text;
          markDone(r, t.text); ctx.note(ch, "sheet", t, "written", { row });
        } catch (e) {
          strikes++; ch.error = errCode(e);
          if (isTransient(e)) { markFail(r, t.text, errCode(e)); ctx.note(ch, "sheet", t, r.gaveUp ? "gave-up" : "failed", { row, why: errCode(e) }); }
          else wait(t, errCode(e));
        }
      }
    }
  }

  /* ---- one run ---- */
  async function run(o) {
    const opts = o || {};
    if (running) return Object.assign({ busy: true }, last ? { last } : {});
    if (!notionOn && !sheetOn) return { off: true };
    running = true;
    const dry = !!opts.dryRun;
    const manual = opts.trigger === "manual";
    const anyLive = () => [entryRef.channels.notion, entryRef.channels.sheet].some((c) => c.enabled && !c.dryRun);
    const only = opts.channel === "notion" || opts.channel === "sheet" ? opts.channel : null;
    const entry = {
      at: new Date(nowMs()).toISOString(), trigger: opts.trigger || "poll", dryRun: dry,
      considered: 0, skipped: { badDate: 0, dropped: 0, tooOld: 0, noCampaign: 0 },
      channels: {
        notion: newChannel(notionOn && only !== "sheet", dry || cfg.notion.dryRun),
        sheet: newChannel(sheetOn && only !== "notion", dry || cfg.sheet.dryRun)
      },
      items: [], truncated: false, error: null
    };
    const entryRef = entry;
    try {
      const ws = await d.loadWorkspace();
      if (!ws) { entry.error = "no-workspace"; return entry; }
      const targets = collectTargets(ws, entry.skipped);
      entry.considered = targets.length;
      const stored = await readState();
      const state = stored;
      targets.forEach((t) => { if (!state.items[t.id]) state.items[t.id] = { n: emptyRec(), s: emptyRec() }; });
      const ctx = {
        state, dry, manual, entry,
        force: manual && !dry && Array.isArray(opts.force) ? new Set(opts.force.map(String)) : null,
        note(ch, channel, t, outcome, extra) {
          ch.counts[outcome] = (ch.counts[outcome] || 0) + 1;
          if (entry.items.length >= ITEM_LIMIT) { entry.truncated = true; return; }
          if (outcome === "unchanged") return;   // the quiet steady state: counted, not listed
          entry.items.push(Object.assign({ id: t.id, campaignId: t.campaignId, channel, outcome }, extra || {}));
        }
      };
      /* a dry channel (request or env flag) must leave no trace in the ledger:
         its records are put back exactly as they were */
      const isolated = async (chan, key, fn) => {
        if (!chan.dryRun) return fn();
        const snap = new Map(Object.keys(state.items).map((k) => [k, structuredClone(state.items[k][key])]));
        try { await fn(); } finally {
          Object.keys(state.items).forEach((k) => { state.items[k][key] = snap.has(k) ? snap.get(k) : emptyRec(); });
        }
      };
      if (entry.channels.notion.enabled) {
        try { await isolated(entry.channels.notion, "n", () => runNotion(targets, ctx)); } catch (e) { entry.channels.notion.error = errCode(e); }
      }
      if (entry.channels.sheet.enabled) {
        try { await isolated(entry.channels.sheet, "s", () => runSheet(targets, ctx)); } catch (e) { entry.channels.sheet.error = errCode(e); }
      }
      if (anyLive()) {
        const live = new Set((ws.db.participants || []).map((p) => p && p.id));
        Object.keys(state.items).forEach((k) => { if (!live.has(k)) delete state.items[k]; });
        try { await writeState(state); } catch (e) { entry.error = "state-not-saved"; }
      }
    } catch (e) {
      entry.error = errCode(e);
    } finally {
      running = false;
    }
    last = entry;
    const fmt = (c) => Object.keys(c).sort().map((k) => k + "=" + c[k]).join(" ") || "none";
    logger.log("Date write-back run (%s%s): considered %d | notion: %s | sheet: %s%s", entry.trigger, dry ? ", dry run" : "",
      entry.considered, entry.channels.notion.enabled ? fmt(entry.channels.notion.counts) : "off",
      entry.channels.sheet.enabled ? fmt(entry.channels.sheet.counts) : "off", entry.error ? " | error " + entry.error : "");
    if (anyLive() && d.saveLog) { try { await d.saveLog(entry); } catch (e) { /* best effort */ } }
    return entry;
  }

  /* After a dashboard save: look again in a few seconds. Never awaited by the
     save, never throws into it. Saves that arrive meanwhile share one run. */
  function notifySaved() {
    if (!notionOn && !sheetOn) return;
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        const r = await run({ trigger: "save" });
        if (r && r.busy) { rerun = true; }
      } catch (e) { /* run() already contains its own failures */ }
      if (rerun && !running) { rerun = false; notifySaved(); }
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  async function stateSummary() {
    const s = await readState();
    const out = { notion: { pending: 0, gaveUp: 0, why: {} }, sheet: { pending: 0, gaveUp: 0, why: {} } };
    Object.keys(s.items).forEach((k) => {
      [["n", "notion"], ["s", "sheet"]].forEach(([c, name]) => {
        const r = s.items[k][c];
        if (r && r.want && r.want !== r.done) {
          out[name].pending++;
          if (r.gaveUp) out[name].gaveUp++;
          if (r.why) out[name].why[r.why] = (out[name].why[r.why] || 0) + 1;
        }
      });
    });
    return out;
  }

  return { run, notifySaved, stateSummary, lastRun: () => last, isRunning: () => running,
    channels: () => ({ notion: notionOn, sheet: sheetOn }) };
}

module.exports = {
  parseSlot, storeLabel, sheetText, notionDateValue, notionDateEquals, matchRow, resolveTab,
  normName, parseConfig, createDateWriteback, normState, locateColumns, findColumn, notionPropertyProblem, NOTION_DENY
};
