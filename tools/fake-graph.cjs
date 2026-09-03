/* A stand-in for graph.instagram.com, just enough to exercise
   tools/ig-collab-probe.mjs before it is pointed at Meta with a live
   token. Two scenarios, chosen with SCENARIO=collab|nocollab.

   Deliberately imitates the awkward parts of the real thing: only one
   API version answers, the `owner` field is rejected, paging is
   absolute-URL based, and insights succeed for some metrics and fail
   for others with Meta-shaped errors. */
const http = require("http");
const { URL } = require("url");

const SCENARIO = process.env.SCENARIO || "collab";
const PORT = Number(process.env.PORT || 3477);
const ME = { id: "17841400000000000", username: "vively.global", account_type: "BUSINESS", media_count: 41 };

/* only v23.0 answers — the probe should negotiate down to it */
const GOOD_VERSION = "v23.0";

const post = (id, owner, type, code, likes, comments) => ({
  id, username: owner, media_type: "VIDEO", media_product_type: type,
  permalink: "https://www.instagram.com/reel/" + code + "/",
  timestamp: "2026-08-25T09:12:00+0000",
  like_count: likes, comments_count: comments,
  caption: "sample"
});

/* page 1 mixes our own posts with two collabs whose shortcodes are in
   tmp/known-content.json, so the overlap report has something to find */
const PAGE1 = SCENARIO === "collab" ? [
  post("m_own_1", "vively.global", "REELS", "OWNPOST1", 12, 1),
  post("m_collab_1", "julia.glowwy", "REELS", "Db0ntMnilDr", 3800, 210),
  post("m_collab_2", "shaily.dev", "REELS", "Dbv9lRZBkjV", 2600, 190),
  post("m_own_2", "vively.global", "FEED", "OWNPOST2", 4, 0)
] : [
  post("m_own_1", "vively.global", "REELS", "OWNPOST1", 12, 1),
  post("m_own_2", "vively.global", "FEED", "OWNPOST2", 4, 0)
];

const PAGE2 = SCENARIO === "collab"
  ? [post("m_collab_3", "mansi_in_korea", "REELS", "Db2nqelTIhK", 1800, 88)]
  : [];

/* what a collab post will and will not give us, per metric */
const INSIGHT_VALUES = {
  views: 85031, reach: 71204, likes: 3800, comments: 210, shares: 56,
  saved: 402, total_interactions: 4468, ig_reels_avg_watch_time: 8123
};
const UNSUPPORTED = {
  plays: { message: "(#100) plays metric is no longer supported", code: 100, error_subcode: 2108006, type: "OAuthException" },
  impressions: { message: "(#100) impressions is deprecated for v22.0 and higher", code: 100, error_subcode: 2108006, type: "OAuthException" },
  video_views: { message: "(#100) video_views metric is no longer supported", code: 100, error_subcode: 2108006, type: "OAuthException" },
  profile_activity: { message: "(#100) profile_activity is not supported for this media product type", code: 100, type: "OAuthException" },
  clips_replays_count: { message: "(#100) clips_replays_count is no longer supported", code: 100, error_subcode: 2108006, type: "OAuthException" },
  ig_reels_video_view_total_time: { message: "(#100) metric not available for this media", code: 100, type: "OAuthException" },
  profile_visits: { message: "(#100) profile_visits is not available for a media you do not own", code: 100, type: "OAuthException" },
  follows: { message: "(#100) follows is not available for a media you do not own", code: 100, type: "OAuthException" }
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:" + PORT);
  const parts = u.pathname.split("/").filter(Boolean);
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const oauth = (message, extra) =>
    send(400, { error: Object.assign({ message: message, type: "OAuthException", code: 100 }, extra || {}) });

  if (!u.searchParams.get("access_token")) return oauth("An access token is required");

  let version = null;
  if (/^v\d+\.\d+$/.test(parts[0] || "")) { version = parts.shift(); }
  if (version && version !== GOOD_VERSION) {
    return send(400, { error: { message: "(#2635) The version " + version + " does not exist", type: "OAuthException", code: 2635 } });
  }
  if (!version) {
    return send(400, { error: { message: "Unsupported get request — unversioned calls are not accepted", type: "GraphMethodException", code: 100 } });
  }

  const node = parts[0], edge = parts[1];
  const fields = (u.searchParams.get("fields") || "").split(",").filter(Boolean);

  if (node === "me" && !edge) {
    const out = {};
    (fields.length ? fields : Object.keys(ME)).forEach((f) => { if (f in ME) out[f] = ME[f]; });
    return send(200, out);
  }

  if (node === "me" && edge === "media") {
    /* the real API rejects `owner` here, which is exactly the case the
       probe has to survive */
    if (fields.indexOf("owner") !== -1) {
      return oauth("(#100) Tried accessing nonexisting field (owner) on node type (Media)");
    }
    const page = u.searchParams.get("after") === "PAGE2" ? PAGE2 : PAGE1;
    const body = { data: page };
    if (u.searchParams.get("after") !== "PAGE2" && PAGE2.length) {
      body.paging = {
        cursors: { after: "PAGE2" },
        next: "https://graph.instagram.com/" + GOOD_VERSION + "/me/media?fields=" +
          encodeURIComponent(fields.join(",")) + "&limit=50&after=PAGE2&access_token=" +
          u.searchParams.get("access_token")
      };
    }
    return send(200, body);
  }

  if (edge === "insights") {
    const all = PAGE1.concat(PAGE2);
    if (!all.some((m) => m.id === node)) {
      return oauth("(#100) Unsupported get request. Object with ID '" + node + "' does not exist");
    }
    const asked = (u.searchParams.get("metric") || "").split(",").filter(Boolean);
    /* a batch containing any unsupported metric fails as a whole — the
       behaviour that makes per-metric probing necessary */
    const bad = asked.find((m) => UNSUPPORTED[m]);
    if (bad) return send(400, { error: UNSUPPORTED[bad] });
    const rows = asked
      .filter((m) => m in INSIGHT_VALUES)
      .map((m) => ({ name: m, period: "lifetime", title: m, total_value: { value: INSIGHT_VALUES[m] } }));
    if (!rows.length) return oauth("(#100) " + asked.join(",") + " is not valid for this media");
    return send(200, { data: rows });
  }

  if (node && !edge) {
    const m = PAGE1.concat(PAGE2).find((x) => x.id === node);
    if (!m) return oauth("(#100) Object with ID '" + node + "' does not exist");
    const out = {};
    (fields.length ? fields : ["id"]).forEach((f) => { if (f in m) out[f] = m[f]; });
    return send(200, out);
  }

  return oauth("Unsupported get request");
}).listen(PORT, () => console.log("fake graph on :" + PORT + " scenario=" + SCENARIO));
