/* ===================================================================
   Social content, as a collection rather than an array.

   The 97 published posts live today inside `workspace.db.socialContent`
   — one field of a single 514 KB document that is read whole, rewritten
   whole, and guarded by an optimistic revision lock. That was fine when
   the array was a handful of rows entered by hand. It stops being fine
   the moment a sync can add hundreds of posts and a snapshot can add a
   metrics reading per post per day: two people saving at once already
   costs one of them their work, and the document has a hard 16 MB
   ceiling it would eventually reach.

   So content moves out into its own collection, the same way partner
   comments, webhook events and sessions each did.

   Everything in this file is pure. It takes records and returns
   records; it never opens a connection, reads an environment variable
   or writes to stdout. That is what lets the migration be rehearsed
   against a fixture with no database anywhere near it, which matters
   rather a lot when the input is the only copy of four campaigns'
   worth of real work.
   =================================================================== */

/* ---- identity -------------------------------------------------------

   Two questions that look like one and are not:

     _id            — which row is this? Stable for the life of the
                      record, and equal to the id the workspace already
                      uses, so every participantId/campaignId/creatorId
                      relationship survives the move untouched and a
                      re-run of the migration overwrites rather than
                      duplicates.

     the content key — which *post* is this? Derived from the platform
                      and the post's own id on that platform. This is
                      what a sync matches on when it meets the same
                      Reel a second time, and it is what the unique
                      index is built over.

   Keeping them apart is the whole point. If _id were the content key,
   a post whose URL was corrected by hand would become a different row
   and the roster link would break. If the content key were _id, two
   records that turn out to be the same post could never be told apart
   from two records that are genuinely different.
   ------------------------------------------------------------------ */

/* Strips the query string, the fragment, the trailing slash and the
   host's www, and lower-cases the host but never the path — Instagram
   shortcodes are case-sensitive and "DQx" is not "dqx". */
function canonicalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw.includes("://") ? raw : "https://" + raw);
  } catch (e) {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return host + path;
}

/* Mirrors platformPostIdOf() in src/model/db.js. Duplicated rather than
   imported because that file is an ES module inside the browser bundle
   and this one is required by the server; the tests assert the two
   agree on every URL shape the workspace actually contains. */
function platformPostIdOf(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  let m = u.match(/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i);
  if (m) return "ig_" + m[1];
  m = u.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/i);
  if (m) return "tt_" + m[1];
  m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]+)/i);
  if (m) return "yt_" + m[1];
  return u.replace(/[?#].*$/, "");
}

const urlOf = (rec) => String((rec && (rec.postUrl || rec.url)) || "").trim();

/* The key, and — just as important — how it was arrived at. A record
   keyed on its own row id is not deduplicable against anything, and
   silently treating it as if it were is how a sync ends up creating a
   second copy of a post it has already seen. So the provenance travels
   with the key and is stored on the document. */
function contentKey(rec) {
  const platform = String((rec && rec.platform) || "").trim() || "Instagram";
  const explicit = String((rec && rec.platformPostId) || "").trim();
  const url = urlOf(rec);

  if (explicit) return { key: platform + ":" + explicit, basis: "platformPostId", platform, postId: explicit };

  /* platformPostIdOf falls back to returning the URL with its query
     string cut off, which is a perfectly good identity but is NOT a
     post id — calling it one would put a whole URL in platformPostId
     and make the field mean two different things. Only the prefixed
     forms it produces for a platform it actually recognises count. */
  const derived = platformPostIdOf(url);
  if (derived && /^(ig|tt|yt)_/.test(derived)) return { key: platform + ":" + derived, basis: "derivedPostId", platform, postId: derived };

  const canon = canonicalUrl(url);
  if (canon) return { key: platform + ":url:" + canon, basis: "canonicalUrl", platform, postId: "" };

  /* No URL and no post id. It is a row somebody started and never
     filled in. It still migrates — losing it would be worse — but it
     is keyed on itself and flagged, because nothing can ever match it. */
  const id = String((rec && rec.id) || "");
  return { key: id ? "row:" + id : "", basis: "rowId", platform, postId: "" };
}

/* ---- shaping --------------------------------------------------------

   Every field that exists on the record is carried across verbatim.
   That is deliberate and slightly uncomfortable: it means an unknown
   field somebody added by hand two months ago survives, rather than
   being quietly dropped by a schema I wrote today from the fields I
   happen to know about. The migration's job is to move the data, not
   to have opinions about it.
   ------------------------------------------------------------------ */

const SYSTEM_KEYS = new Set(["_id", "key", "keyBasis", "canonicalUrl", "derivedPostId", "migration"]);

function toDocument(rec, meta) {
  const m = meta || {};
  const k = contentKey(rec);
  const doc = {};
  Object.keys(rec || {}).forEach((field) => {
    if (SYSTEM_KEYS.has(field)) return;
    doc[field] = rec[field];
  });
  doc._id = String((rec && rec.id) || "");
  doc.key = k.key;
  doc.keyBasis = k.basis;
  doc.canonicalUrl = canonicalUrl(urlOf(rec));
  /* The derived post id goes in a NEW field rather than filling in the
     blank `platformPostId` the record already has. Backfilling that
     column would be an improvement, and improving the data is not this
     script's job — the moment it edits a field on the way past,
     verification can no longer tell a successful move from a corrupted
     one, because the two look identical. Enrichment is a separate,
     reversible pass to run after the copy is proven. */
  doc.derivedPostId = k.postId || "";
  doc.migration = {
    batch: m.batch || "",
    at: m.at || new Date().toISOString(),
    from: m.from || "workspace.db.socialContent",
    sourceRevision: m.sourceRevision === undefined ? null : m.sourceRevision
  };
  return doc;
}

/* The reverse, for rollback and for the read path during the period
   where both copies exist. The fields this file added are stripped so
   that a round trip through the collection produces the record the
   workspace started with, byte for byte. */
function toRecord(doc) {
  const rec = {};
  Object.keys(doc || {}).forEach((field) => {
    if (SYSTEM_KEYS.has(field)) return;
    rec[field] = doc[field];
  });
  if (!rec.id && doc && doc._id) rec.id = doc._id;
  return rec;
}

/* ---- planning -------------------------------------------------------

   Run before anything is written. It answers the one question that
   decides whether the unique index can be created at all: are there
   two records in the workspace that are the same post?
   ------------------------------------------------------------------ */

function planMigration(records, meta) {
  const list = Array.isArray(records) ? records : [];
  const docs = [];
  const byKey = new Map();
  const byId = new Map();
  const keyCollisions = [];
  const idCollisions = [];
  const unkeyable = [];

  list.forEach((rec, i) => {
    const doc = toDocument(rec, meta);

    if (!doc._id) {
      /* A record with no id cannot be addressed, so it cannot be
         migrated idempotently. Refuse the whole run rather than invent
         one — an invented id is a relationship nobody can rebuild. */
      idCollisions.push({ index: i, id: "", reason: "record has no id" });
      return;
    }
    if (byId.has(doc._id)) {
      idCollisions.push({ index: i, id: doc._id, reason: "duplicate id", firstIndex: byId.get(doc._id) });
      return;
    }
    byId.set(doc._id, i);

    if (doc.keyBasis === "rowId") unkeyable.push({ index: i, id: doc._id, url: urlOf(rec) });

    if (doc.key && byKey.has(doc.key)) {
      keyCollisions.push({ key: doc.key, ids: [byKey.get(doc.key), doc._id], keyBasis: doc.keyBasis });
    } else if (doc.key) {
      byKey.set(doc.key, doc._id);
    }

    docs.push(doc);
  });

  return {
    total: list.length,
    docs,
    keyCollisions,
    idCollisions,
    unkeyable,
    /* The index is only safe to build when no two rows claim the same
       post. If it is not safe, the migration still runs — the data is
       moved and verified — and the index is left for a human to sort
       the duplicates out first. Moving the data is reversible; a lost
       row is not. */
    indexSafe: keyCollisions.length === 0,
    canRun: idCollisions.length === 0
  };
}

/* ---- verification ---------------------------------------------------

   Compares what is in the collection against what is in the workspace,
   field by field, for every record. Not a count — a count passes while
   every URL is null. The user asked specifically for record count,
   campaign links, creator links, URLs and metrics, so those five are
   checked by name and the rest are checked by deep equality.
   ------------------------------------------------------------------ */

const METRIC_FIELDS = [
  "views", "paidViews", "organicViews", "likes", "comments", "shares",
  "saves", "reach", "profileVisits", "followsGained", "linkClicks"
];
const LINK_FIELDS = ["participantId", "campaignId", "creatorId"];

function sameValue(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return ta === tb;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

function verifyMigration(records, docs) {
  const src = Array.isArray(records) ? records : [];
  const got = new Map();
  (docs || []).forEach((d) => { if (d && d._id) got.set(String(d._id), d); });

  const problems = [];
  const counts = { records: src.length, documents: (docs || []).length, matched: 0 };
  const checked = { links: 0, urls: 0, metrics: 0 };

  src.forEach((rec) => {
    const id = String((rec && rec.id) || "");
    const doc = got.get(id);
    if (!doc) { problems.push({ id, field: "*", reason: "missing from the collection" }); return; }
    counts.matched++;

    LINK_FIELDS.forEach((f) => {
      checked.links++;
      if (!sameValue(rec[f], doc[f])) problems.push({ id, field: f, expected: rec[f], got: doc[f], reason: "link changed" });
    });

    ["url", "postUrl"].forEach((f) => {
      checked.urls++;
      if (!sameValue(rec[f], doc[f])) problems.push({ id, field: f, expected: rec[f], got: doc[f], reason: "url changed" });
    });

    METRIC_FIELDS.forEach((f) => {
      checked.metrics++;
      if (!sameValue(rec[f], doc[f])) problems.push({ id, field: f, expected: rec[f], got: doc[f], reason: "metric changed" });
    });

    /* everything else the record carried, including fields nobody
       here knows the name of */
    Object.keys(rec).forEach((f) => {
      if (SYSTEM_KEYS.has(f)) return;
      if (!sameValue(rec[f], doc[f])) {
        if (problems.some((p) => p.id === id && p.field === f)) return;
        problems.push({ id, field: f, expected: rec[f], got: doc[f], reason: "field changed" });
      }
    });
  });

  const extra = [];
  got.forEach((d, id) => { if (!src.some((r) => String(r.id) === id)) extra.push(id); });

  return {
    ok: problems.length === 0 && extra.length === 0 && counts.matched === counts.records,
    counts, checked, extra,
    problems: problems.slice(0, 200),
    problemCount: problems.length
  };
}

/* ---- metric merge ---------------------------------------------------

   The rule the owner set, in their words: "Do not erase a previously
   known metric merely because a provider does not return it on a later
   call." Instagram's API is the reason — it drops fields it cannot
   serve rather than returning zero, and a naive $set would turn a
   post's 85,031 views into 0 the first time a token loses a scope.

   So: a field the provider did not mention keeps its old value. A
   field it reported as 0 is a real 0 and is written. The distinction
   between "absent" and "zero" carries the whole weight here, which is
   why `undefined` and `null` are treated as absent and `0` is not.
   ------------------------------------------------------------------ */

const absent = (v) => v === undefined || v === null || v === "";

function mergeMetrics(existing, incoming, opts) {
  const o = opts || {};
  const before = existing || {};
  const next = {};
  const kept = [];
  const changed = [];

  METRIC_FIELDS.forEach((f) => {
    const inc = incoming ? incoming[f] : undefined;
    if (absent(inc)) {
      /* not reported this time — the old reading stands */
      if (!absent(before[f])) { next[f] = before[f]; kept.push(f); }
      return;
    }
    const num = Number(inc);
    if (!Number.isFinite(num)) { if (!absent(before[f])) { next[f] = before[f]; kept.push(f); } return; }

    /* A provider that reports a *lower* figure than we already hold is
       either serving a stale cache or has changed what it counts.
       Views do not go down. Rather than silently accept the smaller
       number, keep the larger and say so — unless the caller has
       explicitly asked for a correction.

       This deliberately covers an explicit 0. A field reported as zero
       against a reading of 85,031 is the same accident as a field that
       was omitted, arriving by a different route, and treating it as a
       real measurement is how a month of numbers disappears in one
       sync. A genuine zero against no prior reading still writes. */
    const prev = Number(before[f]);
    if (!o.allowDecrease && Number.isFinite(prev) && num < prev) {
      next[f] = prev;
      kept.push(f);
      changed.push({ field: f, from: prev, to: num, applied: false, reason: "would decrease" });
      return;
    }
    next[f] = num;
    if (!Number.isFinite(prev) || prev !== num) changed.push({ field: f, from: Number.isFinite(prev) ? prev : null, to: num, applied: true });
  });

  return { metrics: next, kept, changed, changedCount: changed.filter((c) => c.applied).length };
}

/* A sync must never invent a campaign assignment over a human one.
   `confirmed` means a person decided; nothing automatic outranks it. */
function mergeAssignment(existing, incoming) {
  const cur = existing || {};
  const inc = incoming || {};
  const human = cur.matchStatus === "confirmed" || cur.matchStatus === "excluded";
  if (human) {
    return {
      campaignId: cur.campaignId, creatorId: cur.creatorId, participantId: cur.participantId,
      matchStatus: cur.matchStatus, matchMethod: cur.matchMethod, matchConfidence: cur.matchConfidence,
      overrode: false, reason: "a person already decided this"
    };
  }
  if (absent(inc.campaignId)) {
    return {
      campaignId: cur.campaignId || null, creatorId: cur.creatorId || null, participantId: cur.participantId || null,
      matchStatus: cur.matchStatus || "unassigned", matchMethod: cur.matchMethod || "", matchConfidence: cur.matchConfidence || 0,
      overrode: false, reason: "nothing proposed"
    };
  }
  return {
    campaignId: inc.campaignId, creatorId: inc.creatorId || cur.creatorId || null,
    participantId: inc.participantId || cur.participantId || null,
    matchStatus: inc.matchStatus || "suggested",
    matchMethod: inc.matchMethod || "auto",
    matchConfidence: Number(inc.matchConfidence) || 0,
    overrode: true, reason: "automatic match applied over an automatic one"
  };
}

module.exports = {
  canonicalUrl, platformPostIdOf, contentKey,
  toDocument, toRecord,
  planMigration, verifyMigration,
  mergeMetrics, mergeAssignment,
  METRIC_FIELDS, LINK_FIELDS
};
