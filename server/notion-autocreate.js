"use strict";

/* ===================================================================
   Notion -> dashboard: create a campaign when a new campaign page
   appears under the "PAID COLLABORATION" parent page.

   Read-only on the Notion side. The only thing written is the dashboard
   workspace, and only through the same revision-checked save the
   Save button uses (never `force`).

   What it reads, per run:
     - the parent's direct children (child_page blocks): title, id,
       created time. Plain-text blocks and anything that is not a page
       are ignored.
     - for a page the dashboard has not seen yet: the page's own children,
       only to find its Responses database / data source id, so it can be
       matched to a campaign that was imported by hand and, if it is new,
       stored for the existing "Sync from Notion" to use.
   It never reads a creator row, and it never stores the Notion page url.

   Idempotent by construction. A page is skipped if any campaign already
   carries its notionPageId. Otherwise it is first matched to a campaign
   that was imported by hand (no notionPageId yet) and LINKED to it,
   never duplicated. Only a page that matches nothing is created, and
   a page that matches more than one campaign, or whose only match is
   wanted by another page, is reported and left alone.

   Everything that touches the outside world is passed in, so tests run
   it against a fake Notion and an in-memory workspace.
   =================================================================== */

const ID_DASHED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ID_PLAIN = /[0-9a-f]{32}/i;

/* same rule as server.js normalizeNotionId, kept here so this file has no
   dependency on server.js */
function normalizeId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  let m = s.match(ID_DASHED);
  if (m) return m[0].toLowerCase();
  m = s.match(ID_PLAIN);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------------------------- titles ---------------------------- */

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}︎️‍⃣]/gu;
const WORD_EDGE = "(?:^|[^\\p{L}\\p{N}])";
const WORD_END = "(?:$|[^\\p{L}\\p{N}])";
const SKIP_RE = new RegExp(WORD_EDGE + "(template|test)" + WORD_END, "iu");
const POSTPONED_RE = new RegExp(WORD_EDGE + "postponed" + WORD_END, "iu");

/* Whole-word, case-insensitive, so "TEST FORM" and "TEMPLATE (MAIN)" are
   skipped and a brand called "Latest" or "Contest" is not. */
function isSkippedTitle(title) { return SKIP_RE.test(String(title || "")); }
function isPostponedTitle(title) { return POSTPONED_RE.test(String(title || "")); }

/* What a person would read: emoji gone, the "(postponed)" tag gone,
   whitespace collapsed. Language tags such as (jp) are kept on purpose:
   each copy is its own campaign. */
function cleanTitle(title) {
  return String(title || "")
    .replace(EMOJI, " ")
    .replace(/\(\s*postponed\s*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/* The comparison form: case, width, punctuation and emoji do not matter;
   the words do, including a language tag. */
function normaliseTitle(title) {
  return cleanTitle(title)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function brandOf(title) {
  const m = cleanTitle(title).match(/^(.*?)\s+x\s+vively\b/i);
  return (m && m[1].trim()) || "";
}

/* ---------------------------- planning (pure) ---------------------------- */

function campaignTitleKeys(c) {
  const keys = new Set();
  const add = (v) => { const k = normaliseTitle(v); if (k) keys.add(k); };
  add(c.notionTitle);
  add(c.name);
  if (c.brand && c.name) add(c.brand + " " + c.name);
  return keys;
}

function campaignDbKey(c) { return normalizeId(c && c.notionDatabaseId); }

function campaignMentionsPage(c, pageId) {
  return ["notionPageUrl", "notionUrl", "notionLink"].some((f) =>
    typeof c[f] === "string" && normalizeId(c[f]) === pageId);
}

/* pages: [{ id, title, createdTime, dbIds:Set<string>, dataSourceId:string|null, lookupFailed:boolean }]
   campaigns: the workspace's campaigns array (read only here). */
function planActions(pages, campaigns, opts) {
  const o = opts || {};
  const maxCreate = Number.isFinite(o.maxCreate) ? o.maxCreate : 10;
  const capWhy = o.capWhy || "create-cap";
  /* o.blockCreate(page) -> a reason string when this page may be LINKED to
     a hand-made campaign but must never be CREATED (e.g. it existed before
     the baseline). o.dismissed: Set of page ids staff do not want back. */
  const blockCreate = typeof o.blockCreate === "function" ? o.blockCreate : () => null;
  const dismissed = o.dismissed instanceof Set ? o.dismissed : new Set();
  const list = Array.isArray(campaigns) ? campaigns : [];
  const linkedIds = new Set(list.map((c) => normalizeId(c && c.notionPageId)).filter(Boolean));
  const unlinked = list.filter((c) => c && !normalizeId(c.notionPageId));

  const out = { create: [], link: [], skip: [], ambiguous: [], deferred: [], seen: [], dismissed: [], already: 0 };
  const open = [];
  (pages || []).forEach((p) => {
    if (linkedIds.has(p.id)) { out.already++; return; }
    if (dismissed.has(p.id)) { out.dismissed.push({ page: p, why: "dismissed" }); return; }
    if (!cleanTitle(p.title)) { out.skip.push({ page: p, why: "no-title" }); return; }
    if (isSkippedTitle(p.title)) { out.skip.push({ page: p, why: "template-or-test" }); return; }
    if (p.lookupFailed) { out.deferred.push({ page: p, why: "lookup-failed" }); return; }
    open.push(p);
  });

  /* candidates per page, strongest evidence first; the first tier that
     finds anything decides */
  const cands = open.map((p) => {
    const dbSet = new Set([...(p.dbIds || []), p.dataSourceId].filter(Boolean));
    const byDb = unlinked.filter((c) => { const k = campaignDbKey(c); return k && dbSet.has(k); });
    if (byDb.length) return { page: p, tier: "database", list: byDb };
    const compatible = (c) => {
      /* a campaign already tied to a different form is not this page's */
      const k = campaignDbKey(c);
      return !(k && dbSet.size && !dbSet.has(k));
    };
    const byUrl = unlinked.filter((c) => compatible(c) && campaignMentionsPage(c, p.id));
    if (byUrl.length) return { page: p, tier: "url", list: byUrl };
    const key = normaliseTitle(p.title);
    const byTitle = unlinked.filter((c) => compatible(c) && campaignTitleKeys(c).has(key));
    return { page: p, tier: byTitle.length ? "title" : null, list: byTitle };
  });

  /* a campaign wanted by two pages is wanted by neither */
  const claims = new Map();
  cands.forEach((c) => c.list.forEach((cp) => claims.set(cp, (claims.get(cp) || 0) + 1)));

  cands.forEach((c) => {
    if (!c.list.length) {
      const blocked = blockCreate(c.page);
      if (blocked) { out.seen.push({ page: c.page, why: blocked }); return; }
      if (out.create.length >= maxCreate) out.deferred.push({ page: c.page, why: capWhy });
      else out.create.push({ page: c.page });
      return;
    }
    if (c.list.length === 1 && claims.get(c.list[0]) === 1) {
      out.link.push({ page: c.page, campaign: c.list[0], tier: c.tier });
      return;
    }
    out.ambiguous.push({
      page: c.page, tier: c.tier, matches: c.list.length,
      sharedWithOtherPage: c.list.some((cp) => claims.get(cp) > 1)
    });
  });
  return out;
}

/* ---------------------------- campaign shape ---------------------------- */

function dayOf(iso, fallback) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ""));
  return m ? m[1] : fallback;
}
function addDaysIso(day, n) {
  const d = new Date(day + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Mirrors what the dashboard's own "New campaign" builds, with the
   earliest campaign status ('planning'). Nothing here comes from a
   creator; the only input is the page title and created date.
   A postponed page has no status of its own in the dashboard's
   vocabulary, so it is flagged `postponed: true` and noted. */
function buildCampaign(page, ctx) {
  const today = dayOf(ctx.nowIso, "1970-01-01");
  const start = dayOf(page.createdTime, today);
  const postponed = isPostponedTitle(page.title);
  const cp = {
    id: ctx.newId(),
    brand: brandOf(page.title) || "Untitled brand",
    name: cleanTitle(page.title) || "Notion campaign",
    kind: "Paid collab", category: "Lifestyle", market: "Korea",
    status: "planning",
    start, end: addDaysIso(start, 35),
    targetCreators: 0, minFollowers: 0,
    platforms: ["Instagram"], deliverables: "",
    budget: 0, productCostPer: 0, adSpend: 0,
    hashtags: ["#vively"], owner: "",
    note: postponed ? "Postponed (per the Notion page title)." : "",
    createdAt: today,
    fulfilment: "delivery",
    source: "notion-auto",
    notionPageId: page.id
  };
  if (postponed) cp.postponed = true;
  if (page.dataSourceId && !ctx.dbKeyInUse(page.dataSourceId)) cp.notionDatabaseId = page.dataSourceId;
  return cp;
}

/* ---------------------------- the job ---------------------------- */

function scrub(msg) {
  return String(msg == null ? "" : msg)
    .replace(/(secret_|ntn_)[A-Za-z0-9_]+/g, "$1***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .slice(0, 200);
}

function parseConfig(env) {
  const e = env || {};
  const rawParent = String(e.NOTION_AUTOCREATE_PARENT_ID || "").trim();
  const parentId = rawParent ? normalizeId(rawParent) : null;
  const mins = Number(e.NOTION_AUTOCREATE_INTERVAL_MIN);
  const intervalMin = Number.isFinite(mins) && mins > 0 ? Math.min(Math.max(mins, 1), 1440) : 5;
  /* a blank value is Number("") === 0, which would silently mean "never":
     treat blank as unset */
  const num = (v) => (String(v == null ? "" : v).trim() === "" ? NaN : Number(v));
  const cap = num(e.NOTION_AUTOCREATE_MAX_CREATE);
  const perDay = num(e.NOTION_AUTOCREATE_MAX_PER_DAY);
  return {
    requested: !!rawParent,
    parentId,
    invalid: !!rawParent && !parentId,
    intervalMs: Math.round(intervalMin * 60000),
    intervalMin,
    maxCreate: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 10,
    maxPerDay: Number.isFinite(perDay) && perDay >= 0 ? Math.floor(perDay) : 5,
    dryRun: /^(1|true|yes)$/i.test(String(e.NOTION_AUTOCREATE_DRY_RUN || "").trim())
  };
}

/* deps:
     parentId                     allow-listed parent page id (dashed)
     notionGet(path)              GET only, returns parsed JSON or throws
     loadWorkspace()              -> { db, settings, revision } | null
     saveWorkspace({db,settings,revision}) -> { ok, revision } | { conflict:true } ; throws otherwise
     saveLog(entry)               best effort
     loadState() / saveState(s)   the job's own small state document (baseline,
                                  dismissed pages, today's create count);
                                  kept in memory if not supplied (tests)
     newId(), now()               injectable for tests
     maxCreate (per run), maxPerDay, maxAttempts, dryRun, logger

   Safety rails, in the order they apply to a page that matches no campaign:
     1. dismissed by staff (or auto-detected as deleted by staff) -> skipped
     2. existed when the job first ran live (the baseline), or was created
        before it -> "seen", never created (it may still be LINKED to a
        hand-made campaign if exactly one matches)
     3. per-run cap, then per-day cap -> deferred
   A dry run changes nothing: not the workspace, not the state, not the log. */

const STATE_LIMIT = 2000;

function emptyState() {
  return { baselineAt: null, baselineSeen: [], dismissed: [], createdIds: [], day: "", dayCreated: 0 };
}
function idList(v) {
  return Array.isArray(v) ? Array.from(new Set(v.map(normalizeId).filter(Boolean))).slice(-STATE_LIMIT) : [];
}
function normState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const t = Date.parse(r.baselineAt);
  return {
    baselineAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
    baselineSeen: idList(r.baselineSeen),
    dismissed: idList(r.dismissed),
    createdIds: idList(r.createdIds),
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(r.day || "")) ? r.day : "",
    dayCreated: Number.isFinite(r.dayCreated) && r.dayCreated > 0 ? Math.floor(r.dayCreated) : 0
  };
}

/* The workspace save as the job sees it. `saveDoc` is server.js's
   saveWorkspaceDoc. The job NEVER sends force: a stale revision comes back
   as a conflict, and the job re-reads and plans again. */
function makeSaveWorkspace(saveDoc) {
  return async function saveWorkspace(w) {
    const out = await saveDoc({ db: w.db, settings: w.settings, revision: w.revision, force: false });
    if (out.status === 409) return { conflict: true };
    if (out.status === 200 && out.json && out.json.ok) return { ok: true, revision: out.json.revision };
    throw new Error((out.json && out.json.error) || "workspace save refused (" + out.status + ")");
  };
}

function createAutocreate(deps) {
  const d = deps;
  const logger = d.logger || console;
  const maxAttempts = d.maxAttempts || 4;
  const maxCreate = Number.isFinite(d.maxCreate) ? d.maxCreate : 10;
  const maxPerDay = Number.isFinite(d.maxPerDay) ? d.maxPerDay : 5;
  const now = d.now || (() => new Date());
  let running = false;
  let last = null;

  /* ---- state: read freely, change only through mutateState, which
     re-reads first and runs one change at a time, so a staff "dismiss"
     arriving during a poll is never overwritten by the poll's save ---- */
  let memState = null;
  const readState = async () => normState(d.loadState ? await d.loadState() : memState);
  const writeState = async (s) => { if (d.saveState) await d.saveState(s); else memState = s; };
  let chain = Promise.resolve();
  function mutateState(fn) {
    const p = chain.then(async () => { const s = await readState(); const r = fn(s); await writeState(s); return r; });
    chain = p.catch(() => {});
    return p;
  }
  const dayKey = () => now().toISOString().slice(0, 10);
  const createdToday = (s) => (s.day === dayKey() ? s.dayCreated : 0);

  async function dismiss(rawId) {
    const id = normalizeId(rawId);
    if (!id) return { ok: false, error: "not a Notion page id" };
    const n = await mutateState((s) => { if (!s.dismissed.includes(id)) s.dismissed.push(id); s.dismissed = s.dismissed.slice(-STATE_LIMIT); return s.dismissed.length; });
    return { ok: true, pageId: id, dismissedCount: n };
  }
  async function undismiss(rawId) {
    const id = normalizeId(rawId);
    if (!id) return { ok: false, error: "not a Notion page id" };
    const n = await mutateState((s) => { s.dismissed = s.dismissed.filter((x) => x !== id); return s.dismissed.length; });
    return { ok: true, pageId: id, dismissedCount: n };
  }
  async function stateSummary() {
    const s = await readState();
    return {
      baselineAt: s.baselineAt, baselineSeenCount: s.baselineSeen.length,
      dismissed: s.dismissed, createdTodayCount: createdToday(s),
      maxCreatePerRun: maxCreate, maxCreatePerDay: maxPerDay
    };
  }

  async function listParentPages() {
    const pages = [];
    let ignored = 0, cursor = null, guard = 0;
    do {
      const q = "/blocks/" + d.parentId + "/children?page_size=100" + (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : "");
      const body = await d.notionGet(q);
      (body.results || []).forEach((b) => {
        if (!b || b.type !== "child_page" || b.archived || b.in_trash) { ignored++; return; }
        const id = normalizeId(b.id);
        if (!id) { ignored++; return; }
        pages.push({ id, title: String((b.child_page || {}).title || ""), createdTime: b.created_time || "" });
      });
      cursor = body.has_more ? body.next_cursor : null;
      guard++;
    } while (cursor && guard < 20);
    return { pages, ignored };
  }

  /* the Responses database(s) inside one page. Failure is reported to
     the caller, which then defers the page rather than guess. */
  async function lookupForms(page) {
    const dbBlocks = [];
    let cursor = null, guard = 0;
    do {
      const body = await d.notionGet("/blocks/" + page.id + "/children?page_size=100" + (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""));
      (body.results || []).forEach((b) => {
        if (b && b.type === "child_database") dbBlocks.push({ id: normalizeId(b.id), title: String((b.child_database || {}).title || "") });
      });
      cursor = body.has_more ? body.next_cursor : null;
      guard++;
    } while (cursor && guard < 5);
    const dbIds = new Set();
    const sources = [];
    for (const blk of dbBlocks) {
      if (!blk.id) continue;
      dbIds.add(blk.id);
      const db = await d.notionGet("/databases/" + blk.id);
      const ds = ((db.data_sources || [])[0] || {}).id;
      const dsId = normalizeId(ds);
      if (dsId) { dbIds.add(dsId); sources.push({ id: dsId, title: blk.title }); }
    }
    /* a data source id is stored only when it is unambiguous */
    let chosen = null;
    if (sources.length === 1) chosen = sources[0].id;
    else if (sources.length > 1) {
      const resp = sources.filter((s) => /^responses$/i.test(s.title.trim()));
      if (resp.length === 1) chosen = resp[0].id;
    }
    return { dbIds, dataSourceId: chosen };
  }

  async function run(opts) {
    const o = opts || {};
    if (running) return Object.assign({}, last || {}, { busy: true });
    running = true;
    const startedAt = now().toISOString();
    const dryRun = o.dryRun != null ? !!o.dryRun : !!d.dryRun;
    const onlyId = o.onlyPageId ? normalizeId(o.onlyPageId) : null;
    const entry = {
      at: startedAt, trigger: o.trigger || "poll", dryRun, ok: false,
      children: 0, ignoredBlocks: 0, pagesSeen: 0, alreadyLinked: 0, olderPages: 0,
      baseline: null,
      created: [], linked: [], skipped: [], ambiguous: [], deferred: [], seen: [], dismissed: [],
      attempts: 0, errors: []
    };
    try {
      if (o.onlyPageId && !onlyId) { entry.errors.push("not a Notion page id"); return finish(entry); }

      /* 1. what is under the parent */
      const listed = await listParentPages();
      entry.ignoredBlocks = listed.ignored;
      entry.pagesSeen = listed.pages.length;
      entry.children = listed.pages.length + listed.ignored;
      const allIds = listed.pages.map((p) => p.id);
      if (onlyId && !allIds.includes(onlyId)) {
        entry.errors.push("that page is not a direct child page of the parent; nothing done");
        return finish(entry);
      }

      /* 2. which pages this run may look at. The first live run is the
         BASELINE: everything already there is "seen" and only linked, never
         created. After it, only pages that appeared after the baseline are
         candidates; older pages are not even opened. A deliberate
         create-by-id looks at that one page. */
      const first = await d.loadWorkspace();
      if (!first || !first.db || !Array.isArray(first.db.campaigns)) {
        entry.errors.push("no workspace document to write to yet; nothing done");
        return finish(entry);
      }
      const st0 = await readState();
      const baselineRun = !onlyId && !st0.baselineAt;
      const baseMs = st0.baselineAt ? Date.parse(st0.baselineAt) : NaN;
      const wasThere = new Set(st0.baselineSeen);
      const isNew = (p) => {
        if (wasThere.has(p.id)) return false;
        const t = Date.parse(p.createdTime);
        return Number.isFinite(baseMs) && Number.isFinite(t) && t >= baseMs;
      };
      const candidates = onlyId ? listed.pages.filter((p) => p.id === onlyId)
        : baselineRun ? listed.pages : listed.pages.filter(isNew);
      entry.olderPages = listed.pages.length - candidates.length;
      if (baselineRun) entry.baseline = { recorded: false, wouldRecord: true, at: startedAt, pages: listed.pages.length };

      const linkedNow = new Set(first.db.campaigns.map((c) => normalizeId(c && c.notionPageId)).filter(Boolean));
      const blockedNow = new Set(st0.dismissed);
      st0.createdIds.forEach((id) => { if (!linkedNow.has(id)) blockedNow.add(id); });
      for (const p of candidates) {
        if (linkedNow.has(p.id) || (!onlyId && blockedNow.has(p.id)) || !cleanTitle(p.title) || isSkippedTitle(p.title)) continue;
        try {
          const f = await lookupForms(p);
          p.dbIds = f.dbIds; p.dataSourceId = f.dataSourceId;
        } catch (err) {
          p.lookupFailed = true;
          entry.errors.push("could not read the form of page " + p.id + ": " + scrub(err.message));
        }
      }

      /* 3. plan against the freshest workspace; on a revision conflict,
         re-read and plan again. Never force. */
      let plan = null, saved = false, stUsed = st0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        entry.attempts = attempt;
        const doc = attempt === 1 ? first : await d.loadWorkspace();
        if (!doc || !doc.db || !Array.isArray(doc.db.campaigns)) { entry.errors.push("workspace vanished mid-run"); break; }
        stUsed = attempt === 1 ? st0 : await readState();   // a dismissal made meanwhile counts
        const linkedIds = new Set(doc.db.campaigns.map((c) => normalizeId(c && c.notionPageId)).filter(Boolean));
        const dismissedSet = new Set(onlyId ? [] : stUsed.dismissed);
        if (!onlyId) stUsed.createdIds.forEach((id) => { if (!linkedIds.has(id)) dismissedSet.add(id); });
        /* the cap: per run, and per UTC day (a deliberate create-by-id is
           one page and is not held back by the day cap, but is counted) */
        const left = Math.max(0, maxPerDay - createdToday(stUsed));
        const cap = onlyId ? 1 : (left <= maxCreate ? left : maxCreate);
        const capWhy = !onlyId && left <= maxCreate ? "day-cap" : "create-cap";
        plan = planActions(candidates, doc.db.campaigns, {
          maxCreate: cap, capWhy, dismissed: dismissedSet,
          blockCreate: baselineRun ? () => "baseline-seen" : null
        });
        const changes = plan.create.length + plan.link.length;
        if (!changes || dryRun) { saved = true; break; }

        const campaigns = doc.db.campaigns;
        const nowIso = now().toISOString();
        const usedDb = new Set(campaigns.map(campaignDbKey).filter(Boolean));
        plan.link.forEach((l) => {
          l.campaign.notionPageId = l.page.id;
          l.campaign.notionAutoLinked = true;
          if (l.page.dataSourceId && !campaignDbKey(l.campaign) && !usedDb.has(l.page.dataSourceId)) {
            l.campaign.notionDatabaseId = l.page.dataSourceId;
            usedDb.add(l.page.dataSourceId);
          }
        });
        plan.create.forEach((c) => {
          const cp = buildCampaign(c.page, { nowIso, newId: d.newId, dbKeyInUse: (k) => usedDb.has(k) });
          if (cp.notionDatabaseId) usedDb.add(cp.notionDatabaseId);
          campaigns.push(cp);
          c.campaignId = cp.id;
        });
        const res = await d.saveWorkspace({ db: doc.db, settings: doc.settings || {}, revision: doc.revision || 0 });
        if (res && res.ok) { saved = true; break; }
        if (res && res.conflict) { plan = null; continue; } // somebody saved first: start over from a fresh read
        throw new Error("save was refused");
      }
      if (!saved) {
        entry.errors.push("workspace kept changing; gave up after " + entry.attempts + " tries, nothing was written");
        return finish(entry);
      }
      if (!plan) return finish(entry);

      const brief = (x) => ({ pageId: x.page.id, title: cleanTitle(x.page.title) });
      entry.alreadyLinked = plan.already;
      entry.created = plan.create.map((x) => Object.assign(brief(x), { postponed: isPostponedTitle(x.page.title) }));
      entry.linked = plan.link.map((x) => Object.assign(brief(x), { by: x.tier, campaignId: x.campaign.id }));
      entry.skipped = plan.skip.map((x) => Object.assign(brief(x), { why: x.why }));
      entry.ambiguous = plan.ambiguous.map((x) => Object.assign(brief(x), { matches: x.matches, by: x.tier, sharedWithOtherPage: x.sharedWithOtherPage }));
      entry.deferred = plan.deferred.map((x) => Object.assign(brief(x), { why: x.why }));
      entry.seen = plan.seen.map((x) => Object.assign(brief(x), { why: x.why }));
      entry.dismissed = plan.dismissed.map((x) => Object.assign(brief(x), { why: x.why }));

      /* 4. remember what happened. Never in a dry run. If this write fails
         the run is reported as failed; the workspace is already correct and
         the next run converges (dedupe is by notionPageId). */
      if (!dryRun) {
        const createdIds = plan.create.map((x) => x.page.id);
        const autoDismissed = stUsed.createdIds.filter((id) => !onlyId && plan.dismissed.some((x) => x.page.id === id));
        try {
          await mutateState((s) => {
            if (baselineRun && !s.baselineAt) { s.baselineAt = startedAt; s.baselineSeen = idList(allIds); }
            if (s.day !== dayKey()) { s.day = dayKey(); s.dayCreated = 0; }
            s.dayCreated += createdIds.length;
            s.createdIds = idList(s.createdIds.concat(createdIds)).filter((id) => !autoDismissed.includes(id));
            autoDismissed.forEach((id) => { if (!s.dismissed.includes(id)) s.dismissed.push(id); });
            if (onlyId) s.dismissed = s.dismissed.filter((id) => id !== onlyId);
            s.dismissed = s.dismissed.slice(-STATE_LIMIT);
          });
          if (baselineRun) entry.baseline = { recorded: true, wouldRecord: false, at: startedAt, pages: listed.pages.length };
        } catch (err) {
          entry.errors.push("could not save the job state: " + scrub(err && err.message));
        }
      }
      entry.ok = !entry.errors.length;
      return finish(entry);
    } catch (err) {
      entry.errors.push(scrub(err && err.message));
      logger.error("Notion autocreate run failed: " + scrub(err && err.message));
      return finish(entry);
    }
  }

  async function finish(entry) {
    entry.counts = {
      created: entry.created.length, linked: entry.linked.length, skipped: entry.skipped.length,
      ambiguous: entry.ambiguous.length, deferred: entry.deferred.length, seen: entry.seen.length,
      dismissed: entry.dismissed.length, errors: entry.errors.length
    };
    last = entry;       // in memory only, so a dry run can be read back from /status
    running = false;
    /* a dry run is not written anywhere: its result is the return value */
    try { if (d.saveLog && !entry.dryRun) await d.saveLog(entry); } catch (e) { /* the log is best effort */ }
    return entry;
  }

  /* deliberate create (or link) of ONE page by id, past the baseline, the
     dismissed list and the day cap; still only a direct child of the parent,
     still never a TEMPLATE/TEST title */
  const createPage = (rawId, o) => run({ trigger: "staff-create", onlyPageId: rawId, dryRun: o && o.dryRun ? true : undefined });

  return { run, createPage, dismiss, undismiss, stateSummary, lastRun: () => last, isRunning: () => running };
}

module.exports = {
  normalizeId, cleanTitle, normaliseTitle, isSkippedTitle, isPostponedTitle, brandOf,
  planActions, buildCampaign, parseConfig, createAutocreate, makeSaveWorkspace, normState, scrub
};
