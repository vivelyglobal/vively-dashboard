/* ===================================================================
   Does Meta treat an accepted Instagram collab as media we own?

   One question, answered with evidence rather than documentation: when
   a creator invites @vively.global as a collaborator and we accept,
   does that Reel appear on OUR media edge, and will Meta serve us
   insights for it? If yes, creator OAuth and Business Discovery are
   both unnecessary for the posts we already collaborate on.

   This module is the whole implementation. server.js mounts it behind
   a key, and tools/ig-collab-probe.mjs runs the same code from a
   terminal — one copy, so the two cannot drift.

   Rules it holds itself to:
     · every Meta call is a GET; nothing is posted, published or deleted
     · it never touches MongoDB — the caller passes in the URLs it
       cross-references, and nothing is written back
     · the access token is never returned, logged, or embedded in the
       report; redact() is applied to everything on the way out,
       because Meta echoes the request inside some error payloads
   =================================================================== */

const HOST = "graph.instagram.com";

/* Versions are tried newest-first and the first one that answers /me is
   the one the run uses. Asking beats assuming — the current version
   moves, and a wrong guess looks identical to a dead token. */
const VERSIONS = ["v24.0", "v23.0", "v22.0", "v21.0", "v20.0", ""];

/* Probed one at a time. A batch containing a single unsupported metric
   fails as a whole and tells us nothing about the other fifteen, which
   is exactly the answer we are here for. */
const METRICS = [
  "views", "reach", "likes", "comments", "shares", "saved",
  "total_interactions", "profile_visits", "profile_activity", "follows",
  "ig_reels_avg_watch_time", "ig_reels_video_view_total_time",
  "clips_replays_count", "plays", "impressions", "video_views"
];

const MEDIA_FIELDS_FULL =
  "id,username,media_type,media_product_type,permalink,timestamp,like_count,comments_count,caption,owner";
/* `owner` is rejected on some surfaces; this is what we fall back to
   rather than reporting "no media" for what is really a bad field */
const MEDIA_FIELDS_SAFE =
  "id,username,media_type,media_product_type,permalink,timestamp,like_count,comments_count";

/* ---- small pure helpers -------------------------------------------- */

/* /p/, /reel/, /reels/ and /tv/ all address the same object, and stored
   URLs carry ?hl=en and ?img_index=1 tails, so both sides reduce to the
   shortcode before comparing. */
function shortcodeOf(url) {
  const m = String(url || "").match(/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i);
  return m ? m[1] : null;
}

/* Only substitute something long enough to actually be a token. A short
   value would otherwise be replaced inside ordinary words and the
   output would read as corrupted rather than redacted. */
function redactor(token) {
  const t = String(token || "");
  if (t.length < 12) return (s) => String(s);
  return (s) => String(s).split(t).join("‹token›");
}

function errLine(e) {
  if (!e) return "unknown error";
  const bits = [];
  if (e.code != null) bits.push("code " + e.code);
  if (e.error_subcode != null) bits.push("subcode " + e.error_subcode);
  if (e.type) bits.push(e.type);
  return (e.message || "no message") + (bits.length ? "  [" + bits.join(" · ") + "]" : "");
}

const ownerOf = (m) =>
  String((m && (m.username || (m.owner && m.owner.username))) || "").toLowerCase() || null;

/* Who owns each object on our own media edge. An item owned by someone
   else IS an accepted collab surfacing as ours — that is the finding. */
function classifyOwnership(media, myUsername) {
  const mine = String(myUsername || "").toLowerCase();
  const list = Array.isArray(media) ? media : [];
  const withOwner = list.filter((m) => ownerOf(m));
  const ours = list.filter((m) => ownerOf(m) === mine);
  const foreign = list.filter((m) => ownerOf(m) && ownerOf(m) !== mine);
  return {
    total: list.length,
    ownerFieldPresent: withOwner.length,
    ownerFieldMissing: list.length - withOwner.length,
    ownedByUs: ours.length,
    ownedByOthers: foreign.length,
    otherOwners: [...new Set(foreign.map(ownerOf))],
    ours,
    foreign
  };
}

/* How many of the posts we already track came back on this edge. */
function overlapWithTracked(media, knownUrls) {
  const known = new Map();
  (knownUrls || []).forEach((row) => {
    const url = typeof row === "string" ? row : (row && row.url);
    const code = shortcodeOf(url);
    if (code) known.set(code, row);
  });
  const matches = [];
  (media || []).forEach((m) => {
    const code = shortcodeOf(m && m.permalink);
    if (code && known.has(code)) {
      const row = known.get(code);
      matches.push({
        shortcode: code,
        mediaId: m.id,
        owner: ownerOf(m),
        handle: typeof row === "object" ? row.handle || null : null
      });
    }
  });
  return { trackedWithShortcode: known.size, reachable: matches.length, matches };
}

/* Meta returns a value under total_value on some metrics and values[0]
   on others; both shapes mean the same thing here. */
function readInsightValue(row) {
  if (!row) return null;
  if (row.total_value && row.total_value.value != null) return row.total_value.value;
  if (Array.isArray(row.values) && row.values.length && row.values[0].value != null) return row.values[0].value;
  return null;
}

/* Reels first — a collab is nearly always a Reel, and watch-time
   metrics only exist there. */
const reelFirst = (list) =>
  [...list].sort((a, b) => (b.media_product_type === "REELS") - (a.media_product_type === "REELS"));

/* ---- the run -------------------------------------------------------- */

/* fetchImpl and now() are injected so the whole thing runs against a
   stub in tests without any network. */
async function runProbe(options) {
  const opts = options || {};
  const token = String(opts.token || "");
  const base = String(opts.base || "").replace(/\/$/, "") || ("https://" + HOST);
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || (() => Date.now());
  const knownUrls = opts.knownUrls || [];
  const maxPages = Number(opts.maxPages) || 4;
  const deadlineMs = Number(opts.deadlineMs) || 45000;
  const spacingMs = opts.spacingMs == null ? 200 : Number(opts.spacingMs);
  const allInsights = !!opts.allInsights;

  const started = now();
  const redact = redactor(token);
  const report = {
    startedAt: new Date(started).toISOString(),
    host: HOST,
    calls: 0,
    truncated: false
  };

  if (!token) {
    report.fatal = "No access token configured.";
    return report;
  }

  const outOfTime = () => now() - started > deadlineMs;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  async function graph(version, pathname, params) {
    if (outOfTime()) { report.truncated = true; return { ok: false, error: { message: "local deadline reached" } }; }
    const url = new URL(base + "/" + (version ? version + "/" : "") + pathname);
    Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)); });
    url.searchParams.set("access_token", token);
    report.calls += 1;
    /* polite spacing — insights and Business Discovery share an hourly
       budget and a diagnostic is not worth burning it */
    await sleep(spacingMs);
    let res, body;
    try {
      res = await doFetch(url.toString(), { method: "GET", headers: { Accept: "application/json" } });
      body = await res.json();
    } catch (err) {
      return { ok: false, error: { message: "network: " + (err && err.message) } };
    }
    if (!res.ok || (body && body.error)) {
      return { ok: false, status: res.status, error: (body && body.error) || { message: "HTTP " + res.status } };
    }
    return { ok: true, data: body };
  }

  /* --- 0 · version negotiation + identity --- */
  report.versionsTried = [];
  let V = null, me = null;
  for (const v of VERSIONS) {
    const r = await graph(v, "me", { fields: "id,username" });
    report.versionsTried.push({ version: v || "(unversioned)", ok: r.ok, error: r.ok ? null : redact(errLine(r.error)) });
    if (r.ok) { V = v; me = r.data; break; }
  }
  if (!me) {
    report.fatal = "The token did not work against any API version. It has most likely expired " +
      "(Instagram long-lived tokens last 60 days and must be refreshed) or belongs to a different app.";
    report.finishedAt = new Date(now()).toISOString();
    return report;
  }
  report.apiVersion = V || "(unversioned)";

  const meFull = await graph(V, "me", { fields: "id,username,account_type,media_count" });
  report.account = meFull.ok ? meFull.data : me;

  /* --- 1 · the media edge --- */
  let fieldsUsed = MEDIA_FIELDS_FULL;
  let first = await graph(V, "me/media", { fields: fieldsUsed, limit: 50 });
  if (!first.ok) {
    report.fullFieldListRefused = redact(errLine(first.error));
    fieldsUsed = MEDIA_FIELDS_SAFE;
    first = await graph(V, "me/media", { fields: fieldsUsed, limit: 50 });
  }
  report.fieldsUsed = fieldsUsed;

  let media = [];
  if (!first.ok) {
    report.mediaError = redact(errLine(first.error));
  } else {
    media = Array.isArray(first.data.data) ? first.data.data.slice() : [];
    let after = first.data.paging && first.data.paging.cursors && first.data.paging.cursors.after;
    let pages = 1;
    /* page with the cursor rather than following paging.next verbatim —
       the absolute URL carries the token, and rebuilding the request
       keeps it out of anything we might later print */
    while (after && pages < maxPages && !outOfTime()) {
      const r = await graph(V, "me/media", { fields: fieldsUsed, limit: 50, after });
      if (!r.ok || !Array.isArray(r.data.data)) break;
      media = media.concat(r.data.data);
      after = r.data.paging && r.data.paging.cursors && r.data.paging.cursors.after;
      pages += 1;
    }
    report.pagesWalked = pages;
  }
  report.mediaReturned = media.length;

  /* --- 2 · ownership, the actual question --- */
  const own = classifyOwnership(media, report.account && report.account.username);
  report.ownership = {
    total: own.total,
    ownerFieldPresent: own.ownerFieldPresent,
    ownerFieldMissing: own.ownerFieldMissing,
    ownedByUs: own.ownedByUs,
    ownedByOthers: own.ownedByOthers,
    otherOwners: own.otherOwners
  };
  report.verdict = own.ownerFieldPresent === 0 && own.total > 0
    ? "inconclusive: Meta returned no owner on any media object"
    : own.ownedByOthers > 0
      ? "collabs ARE on our media edge"
      : "no media owned by anyone else came back";

  report.trackedOverlap = overlapWithTracked(media, knownUrls);

  /* --- 3 · insights --- */
  let targets = [];
  if (opts.mediaId) {
    targets = [{ id: opts.mediaId, label: "media id supplied by the caller" }];
  } else if (own.foreign.length) {
    targets = reelFirst(own.foreign).map((m) => ({
      id: m.id, label: "collab · @" + ownerOf(m) + " · " + (m.media_product_type || m.media_type)
    }));
    if (!allInsights) targets = targets.slice(0, 1);
  } else if (own.ours.length) {
    targets = reelFirst(own.ours).slice(0, 1).map((m) => ({
      id: m.id,
      label: "our own post · " + (m.media_product_type || m.media_type) + " (no collab available to test)"
    }));
  }

  report.insights = [];
  for (const t of targets) {
    if (outOfTime()) { report.truncated = true; break; }
    const batch = await graph(V, t.id + "/insights", { metric: METRICS.join(",") });
    const supported = [], refused = [];
    for (const metric of METRICS) {
      if (outOfTime()) { report.truncated = true; break; }
      const r = await graph(V, t.id + "/insights", { metric });
      if (r.ok && Array.isArray(r.data.data) && r.data.data.length) {
        supported.push({ metric, value: readInsightValue(r.data.data[0]) });
      } else if (r.ok) {
        refused.push({ metric, reason: "returned an empty data array" });
      } else {
        refused.push({
          metric,
          reason: redact(errLine(r.error)),
          code: r.error && r.error.code,
          subcode: r.error && r.error.error_subcode
        });
      }
    }
    report.insights.push({
      mediaId: t.id,
      label: t.label,
      batchOfAllMetrics: batch.ok ? "accepted" : "refused: " + redact(errLine(batch.error)),
      supported,
      refused
    });
  }

  report.finishedAt = new Date(now()).toISOString();
  report.elapsedMs = now() - started;

  /* belt and braces: the token must not survive anywhere in the object,
     whatever shape an error arrived in */
  return JSON.parse(redact(JSON.stringify(report)));
}

module.exports = {
  HOST, VERSIONS, METRICS, MEDIA_FIELDS_FULL, MEDIA_FIELDS_SAFE,
  shortcodeOf, redactor, errLine, ownerOf,
  classifyOwnership, overlapWithTracked, readInsightValue,
  runProbe
};
