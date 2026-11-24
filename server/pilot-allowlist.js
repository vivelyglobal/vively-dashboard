/* ===================================================================
   Pilot allow-list: let a background job act on chosen campaigns only.

   Used by the applicants job (NOTION_APPLICANTS_ONLY) and the date
   write-back job (DATE_WRITEBACK_ONLY). Not used by auto-create.

   The value is a comma-separated list. Each entry is EITHER a dashboard
   campaign id OR a Notion page id of the campaign (with or without dashes,
   upper or lower case; a Notion page URL also works). Examples (placeholders):

     NOTION_APPLICANTS_ONLY=cmpXXXXXXXX
     DATE_WRITEBACK_ONLY=cmpXXXXXXXX,0123456789abcdef0123456789abcdef

   Modes:
     unset or blank      -> "all"   : unchanged behaviour, every campaign
     NONE (any case)     -> "none"  : process nothing (a safe parking value)
     a list              -> "list"  : only those campaigns
   Fail safe: a value that is set but holds no usable id (for example ",,"
   or a typo with spaces and symbols) is "none", never "all".

   The list comes from the server environment ONLY. No request body, query
   or "force" option reaches this file, so none can widen it.

   Privacy: only ids are kept. An entry that is not a plain id or a Notion
   id is dropped and only counted (so free text can never be echoed).
   =================================================================== */
"use strict";

const ID_DASHED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ID_PLAIN = /[0-9a-f]{32}/i;

/* same rule as notion-autocreate.js normalizeId (kept here: no dependency, autocreate untouched) */
function notionId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  let m = s.match(ID_DASHED);
  if (m) return m[0].toLowerCase();
  m = s.match(ID_PLAIN);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

const PLAIN_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const SHOW_LIMIT = 50;

/* -> { envVar, mode, ids, exact:Set, pages:Set, invalid } */
function parsePilot(raw, envVar) {
  const out = { envVar: envVar || "", mode: "all", ids: [], entries: [], exact: new Set(), pages: new Set(), invalid: 0 };
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return out;
  if (/^none$/i.test(text)) { out.mode = "none"; return out; }
  out.mode = "list";
  const seen = new Set();
  text.split(",").map((t) => t.trim()).filter(Boolean).forEach((tok) => {
    if (/^none$/i.test(tok)) return;                       // NONE inside a list matches nothing
    const page = notionId(tok);
    const plain = PLAIN_ID.test(tok);
    if (!plain && !page) { out.invalid++; return; }
    if (plain) out.exact.add(tok);
    if (page) out.pages.add(page);
    const shown = page && !plain ? page : (page ? page : tok);
    if (!seen.has(shown)) { seen.add(shown); out.ids.push(shown); out.entries.push({ exact: plain ? tok : null, page }); }
  });
  if (!out.exact.size && !out.pages.size) out.mode = "none";   // set but unusable: park, never widen
  return out;
}

/* is this campaign allowed? */
function inPilot(pilot, c) {
  if (!pilot || pilot.mode === "all") return true;
  if (pilot.mode === "none" || !c) return false;
  if (c.id != null && pilot.exact.has(String(c.id))) return true;
  const pg = notionId(c.notionPageId);
  return !!pg && pilot.pages.has(pg);
}

/* how many allow-list entries match no campaign at all (typo check; a number only) */
function unmatchedCount(pilot, campaigns) {
  if (!pilot || pilot.mode !== "list") return 0;
  const ids = new Set(), pages = new Set();
  (campaigns || []).forEach((c) => {
    if (!c) return;
    if (c.id != null) ids.add(String(c.id));
    const pg = notionId(c.notionPageId); if (pg) pages.add(pg);
  });
  return pilot.entries.filter((e) => !((e.exact && ids.has(e.exact)) || (e.page && pages.has(e.page)))).length;
}

/* what the staff status shows: ids only, no personal data */
function pilotStatus(pilot, o) {
  const p = pilot || parsePilot("", "");
  const x = o || {};
  let warning = null;
  if (x.enabled && p.mode === "all") {
    warning = "Acting on ALL campaigns: no allow-list is set" + (p.envVar ? " (" + p.envVar + ")" : "") +
      (x.dryRun ? ". This is a dry run, so nothing is written." : ".");
  }
  return {
    envVar: p.envVar, mode: p.mode, idCount: p.ids.length,
    ids: p.ids.slice(0, SHOW_LIMIT), idsTruncated: p.ids.length > SHOW_LIMIT,
    ignoredEntries: p.invalid, warning
  };
}

module.exports = { parsePilot, inPilot, unmatchedCount, pilotStatus, notionId };
