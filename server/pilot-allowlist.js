/* ===================================================================
   Pilot allow-list: let a background job act on chosen campaigns only.
   FAIL CLOSED: a job that is switched on with no list refuses to run.

   Used by the applicants job (NOTION_APPLICANTS_ONLY) and the date
   write-back job (DATE_WRITEBACK_ONLY). Not used by auto-create.

   The value is a comma-separated list. Each entry is EITHER a dashboard
   campaign id OR a Notion page id of the campaign (with or without dashes,
   upper or lower case; a Notion page URL also works). A Notion id must be
   the WHOLE entry (or the end of a page URL's last path segment): it is
   never picked out of the middle of a longer string. Examples (placeholders):

     NOTION_APPLICANTS_ONLY=cmpXXXXXXXX
     DATE_WRITEBACK_ONLY=cmpXXXXXXXX,0123456789abcdef0123456789abcdef

   Modes:
     unset or blank      -> "unset" : the job REFUSES to run live (dry-run
                                      previews only). Nothing is acted on.
     ALL (any case)      -> "all"   : every campaign (must be written out)
     NONE (any case)     -> "none"  : process nothing (a safe parking value)
     a list              -> "list"  : only those campaigns
   Fail safe: a value that is set but holds no usable id (for example ",,"
   or a typo with spaces and symbols) is "none", never "all".
   ALL or NONE written inside a list is ignored (the rest of the list applies).

   The list comes from the server environment ONLY. No request body, query
   or "force" option reaches this file, so none can widen it.

   Privacy: only ids are kept. An entry that is not a plain id or a Notion
   id is dropped and only counted (so free text can never be echoed). The
   status shows only values shaped like a campaign id or a Notion id; any
   other kept entry is shown as a count ("unrecognised").
   =================================================================== */
"use strict";

const ID_DASHED_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PLAIN_ONLY = /^[0-9a-f]{32}$/i;
/* in a page URL the id ends the last path segment, after the title and a dash */
const ID_AT_END = /(?:^|-)([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/* Whole-token match only: a 32-hex id must BE the entry (dashes or none), or end a Notion page URL.
   A longer hex string (a typo) is not an id, so it can never select a different page. */
function notionId(raw) {
  let s = String(raw == null ? "" : raw).trim();
  let h = null;
  if (ID_DASHED_ONLY.test(s)) h = s.replace(/-/g, "");
  else if (ID_PLAIN_ONLY.test(s)) h = s;
  else if (/^(https?:\/\/|www\.)|[/?#]/i.test(s)) {
    s = s.split(/[?#]/)[0].replace(/\/+$/, "");
    let seg = s.slice(s.lastIndexOf("/") + 1);
    try { seg = decodeURIComponent(seg); } catch (e) { /* keep as is */ }
    const m = seg.match(ID_AT_END);
    if (m) h = m[1].replace(/-/g, "");
  }
  if (!h) return null;
  h = h.toLowerCase();
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

const PLAIN_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const SHOW_LIMIT = 50;
/* shapes that may be shown in the status: a dashboard campaign id (cp or cmp, then letters and at least one digit)
   or a Notion page id. Anything else a founder pasted (a name, a handle) is never echoed. */
const CAMPAIGN_ID_SHAPE = /^cm?p(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{1,60}$/;
const isShowable = (id) => CAMPAIGN_ID_SHAPE.test(id) || ID_DASHED_ONLY.test(id);

const refusal = (envVar) => "refusing: set " + (envVar || "the allow-list variable") + " to a campaign list, or to ALL to act on every campaign";

/* -> { envVar, mode, ids, exact:Set, pages:Set, invalid } */
function parsePilot(raw, envVar) {
  const out = { envVar: envVar || "", mode: "unset", ids: [], entries: [], exact: new Set(), pages: new Set(), invalid: 0 };
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return out;
  if (/^all$/i.test(text)) { out.mode = "all"; return out; }
  if (/^none$/i.test(text)) { out.mode = "none"; return out; }
  out.mode = "list";
  const seen = new Set();
  text.split(",").map((t) => t.trim()).filter(Boolean).forEach((tok) => {
    if (/^(none|all)$/i.test(tok)) return;                 // NONE or ALL inside a list matches nothing; the rest applies
    const page = notionId(tok);
    const plain = PLAIN_ID.test(tok);
    if (!plain && !page) { out.invalid++; return; }
    if (plain) out.exact.add(tok);
    if (page) out.pages.add(page);
    const shown = page ? page : tok;
    if (!seen.has(shown)) { seen.add(shown); out.ids.push(shown); out.entries.push({ exact: plain ? tok : null, page }); }
  });
  if (!out.exact.size && !out.pages.size) out.mode = "none";   // set but unusable: park, never widen
  return out;
}

/* is this campaign allowed? */
function inPilot(pilot, c) {
  if (!pilot || pilot.mode === "unset") return false;     // fail closed: no list, nothing
  if (pilot.mode === "all") return true;
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

/* A live run is refused when the job is on and the list is unset. A dry run may still preview (read only). */
function mustRefuse(pilot, dryRun) { return !!pilot && pilot.mode === "unset" && !dryRun; }

/* the list a dry-run preview looks through when none is set: every campaign, read only; the caller labels the run */
function previewPilot(pilot) { return pilot && pilot.mode === "unset" ? Object.assign({}, pilot, { mode: "all", preview: true }) : pilot; }

/* what the staff status shows: ids only, no personal data */
function pilotStatus(pilot, o) {
  const p = pilot || parsePilot("", "");
  const x = o || {};
  let warning = null;
  const refusing = !!x.enabled && p.mode === "unset" && !x.dryRun;
  const previewOnly = !!x.enabled && p.mode === "unset" && !!x.dryRun;
  if (refusing) warning = refusal(p.envVar);
  else if (previewOnly) warning = "Preview only (dry run, nothing is written): " + (p.envVar || "the allow-list") +
    " is not set, so this looks at every campaign. A live run is refused until it is set to a campaign list or to ALL.";
  else if (x.enabled && p.mode === "all") {
    warning = "Acting on ALL campaigns: " + (p.envVar ? p.envVar + " is set to ALL" : "the allow-list is set to ALL") +
      (x.dryRun ? ". This is a dry run, so nothing is written." : ".");
  }
  const shown = p.ids.filter(isShowable);
  return {
    envVar: p.envVar, mode: p.mode, refusing, previewOnly, idCount: p.ids.length,
    ids: shown.slice(0, SHOW_LIMIT), idsTruncated: shown.length > SHOW_LIMIT,
    unrecognisedEntries: p.ids.length - shown.length,   // kept but not shaped like an id: a count only, never the text
    ignoredEntries: p.invalid, warning
  };
}

module.exports = { parsePilot, inPilot, unmatchedCount, pilotStatus, notionId, mustRefuse, previewPilot, refusal };
