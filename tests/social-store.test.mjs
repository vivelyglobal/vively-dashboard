/* The migration moves the only copy of four campaigns' worth of real
   work. Everything here is about the two ways that goes wrong: losing
   something, or quietly changing it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../server/social-store.js");

/* A record shaped like the ones actually in production: every field
   socialContentDefaults() produces, plus the ones the workspace adds. */
const rec = (over) => Object.assign({
  id: "sc_1", participantId: "pt_1", campaignId: "cp8356", creatorId: "cr_1",
  platform: "Instagram", platformPostId: "", username: "someone",
  postUrl: "https://www.instagram.com/reel/ABC123/", url: "https://www.instagram.com/reel/ABC123/",
  thumbnailUrl: "", caption: "hello #kowork", hashtags: ["#kowork"], mentions: [],
  format: "Reel", publishedAt: "2026-08-01", postedAt: "2026-08-01", submittedAt: "",
  metricsAt: "2026-08-12",
  views: 85031, paidViews: 0, organicViews: 0, likes: 900, comments: 40, shares: 12,
  saves: 0, reach: 0, profileVisits: 0, followsGained: 0, linkClicks: 0,
  matchMethod: "roster", matchConfidence: 100, matchStatus: "confirmed",
  dataSource: "manual", lastScrapedAt: null,
  curve: [], boosted: false, viral: false, topCountries: [], thumbTint: "#c33",
  createdAt: "2026-09-03T04:00:00.000Z", updatedAt: ""
}, over || {});

/* ---- identity ----------------------------------------------------- */

test("the content key survives the noise Instagram puts on a URL", () => {
  const bare  = S.contentKey(rec({ postUrl: "https://www.instagram.com/reel/ABC123/" }));
  const tracked = S.contentKey(rec({ postUrl: "https://instagram.com/reel/ABC123/?igsh=MTk&utm_source=ig_web" }));
  const noSlash = S.contentKey(rec({ postUrl: "http://www.instagram.com/reel/ABC123" }));
  assert.equal(bare.key, tracked.key);
  assert.equal(bare.key, noSlash.key);
  assert.equal(bare.basis, "derivedPostId");
});

test("shortcodes are case sensitive and must not be folded", () => {
  assert.notEqual(S.contentKey(rec({ postUrl: "https://www.instagram.com/reel/AbC/" })).key,
                  S.contentKey(rec({ postUrl: "https://www.instagram.com/reel/abc/" })).key);
});

test("two different posts never share a key", () => {
  assert.notEqual(S.contentKey(rec({ postUrl: "https://www.instagram.com/reel/AAA/" })).key,
                  S.contentKey(rec({ postUrl: "https://www.instagram.com/reel/BBB/" })).key);
});

test("the same shortcode on two platforms is two posts", () => {
  const ig = S.contentKey({ platform: "Instagram", platformPostId: "x1" });
  const tt = S.contentKey({ platform: "TikTok", platformPostId: "x1" });
  assert.notEqual(ig.key, tt.key);
});

test("an explicit platformPostId wins over one derived from the url", () => {
  const k = S.contentKey(rec({ platformPostId: "ig_REAL", postUrl: "https://www.instagram.com/reel/WRONG/" }));
  assert.equal(k.basis, "platformPostId");
  assert.ok(k.key.endsWith("ig_REAL"));
});

test("a post on a platform with no known url shape falls back to the canonical url", () => {
  const k = S.contentKey({ id: "sc_x", platform: "Other", postUrl: "https://vt.example.com/Watch?v=9#t=1" });
  assert.equal(k.basis, "canonicalUrl");
  assert.ok(!k.key.includes("#"), "the fragment is not part of the identity");
  assert.ok(!k.key.includes("?"), "the query string is not part of the identity");
});

test("a record with no url and no post id is keyed on itself and flagged, not dropped", () => {
  const k = S.contentKey({ id: "sc_empty", platform: "Instagram", postUrl: "" });
  assert.equal(k.basis, "rowId");
  assert.equal(k.key, "row:sc_empty");
});

test("this file and the browser's platformPostIdOf agree", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync("src/model/db.js", "utf8"));
  const body = src.slice(src.indexOf("export function platformPostIdOf"));
  const fn = new Function("return " + body.slice(body.indexOf("function"), body.indexOf("\n}\n") + 2))();
  ["https://www.instagram.com/reel/ABC123/",
   "https://www.instagram.com/p/XYZ/",
   "https://www.tiktok.com/@who.is/video/7412345678901234567",
   "https://example.com/thing",
   ""].forEach((u) => assert.equal(S.platformPostIdOf(u), fn(u), u || "(empty)"));
});

/* ---- shaping ------------------------------------------------------- */

test("the document keeps its id, so every relationship survives the move", () => {
  const d = S.toDocument(rec(), { batch: "b1" });
  assert.equal(d._id, "sc_1");
  assert.equal(d.participantId, "pt_1");
  assert.equal(d.campaignId, "cp8356");
  assert.equal(d.creatorId, "cr_1");
});

test("a field nobody here knows the name of is still carried across", () => {
  const d = S.toDocument(rec({ someoneAddedThis: { deep: [1, 2] } }), {});
  assert.deepEqual(d.someoneAddedThis, { deep: [1, 2] });
});

test("a round trip returns the record it started as", () => {
  const before = rec({ oddField: "kept" });
  const after = S.toRecord(S.toDocument(before, { batch: "b1" }));
  assert.deepEqual(after, before);
});

test("an empty metric of 0 is preserved as 0, not dropped as falsy", () => {
  const d = S.toDocument(rec({ views: 0, saves: 0, reach: 0 }), {});
  assert.equal(d.views, 0);
  assert.equal(d.saves, 0);
  assert.equal(d.reach, 0);
  assert.ok("reach" in d);
});

/* ---- planning ------------------------------------------------------ */

test("planning is idempotent: the same input gives byte-identical documents", () => {
  const rows = [rec({ id: "a" }), rec({ id: "b", postUrl: "https://www.instagram.com/reel/BBB/" })];
  const meta = { batch: "fixed", at: "2026-09-06T00:00:00.000Z" };
  assert.equal(JSON.stringify(S.planMigration(rows, meta).docs),
               JSON.stringify(S.planMigration(rows, meta).docs));
});

test("two rows pointing at the same post are reported, and neither is dropped", () => {
  const rows = [rec({ id: "a" }), rec({ id: "b" })];
  const p = S.planMigration(rows, {});
  assert.equal(p.docs.length, 2, "both rows migrate");
  assert.equal(p.keyCollisions.length, 1);
  assert.equal(p.indexSafe, false, "the unique index must not be built over a duplicate");
  assert.equal(p.canRun, true, "but the data still moves");
});

test("a duplicate id stops the whole run", () => {
  const p = S.planMigration([rec({ id: "same" }), rec({ id: "same", postUrl: "https://www.instagram.com/reel/Z/" })], {});
  assert.equal(p.canRun, false);
  assert.equal(p.idCollisions.length, 1);
});

test("a record with no id stops the run rather than getting one invented", () => {
  const p = S.planMigration([rec({ id: "" })], {});
  assert.equal(p.canRun, false);
  assert.equal(p.docs.length, 0);
});

test("an empty workspace plans cleanly rather than throwing", () => {
  const p = S.planMigration([], {});
  assert.deepEqual(p.docs, []);
  assert.equal(p.canRun, true);
  assert.equal(p.indexSafe, true);
});

/* ---- verification -------------------------------------------------- */

test("verification passes on a faithful copy", () => {
  const rows = [rec({ id: "a" }), rec({ id: "b", postUrl: "https://www.instagram.com/reel/B/", views: 0 })];
  const r = S.verifyMigration(rows, S.planMigration(rows, {}).docs);
  assert.equal(r.ok, true);
  assert.equal(r.counts.matched, 2);
});

test("verification catches a lost record", () => {
  const rows = [rec({ id: "a" }), rec({ id: "b", postUrl: "https://www.instagram.com/reel/B/" })];
  const docs = S.planMigration(rows, {}).docs.slice(0, 1);
  const r = S.verifyMigration(rows, docs);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.id === "b" && p.reason === "missing from the collection"));
});

test("verification catches a changed view count, a changed url and a broken link", () => {
  const rows = [rec()];
  for (const [field, bad] of [["views", 1], ["url", "https://x/"], ["campaignId", "cp_other"]]) {
    const docs = S.planMigration(rows, {}).docs;
    docs[0][field] = bad;
    const r = S.verifyMigration(rows, docs);
    assert.equal(r.ok, false, field + " went unnoticed");
    assert.ok(r.problems.some((p) => p.field === field), field);
  }
});

test("verification catches a metric turned from 0 into nothing", () => {
  const rows = [rec({ saves: 0 })];
  const docs = S.planMigration(rows, {}).docs;
  delete docs[0].saves;
  assert.equal(S.verifyMigration(rows, docs).ok, false);
});

test("verification catches a document nothing in the workspace claims", () => {
  const rows = [rec({ id: "a" })];
  const docs = S.planMigration(rows, {}).docs.concat([{ _id: "ghost" }]);
  const r = S.verifyMigration(rows, docs);
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ["ghost"]);
});

test("verification compares nested arrays rather than object identity", () => {
  const rows = [rec({ hashtags: ["#a", "#b"], curve: [{ d: "2026-08-01", v: 3 }] })];
  const docs = S.planMigration(rows, {}).docs;
  assert.equal(S.verifyMigration(rows, docs).ok, true);
  docs[0].curve = [{ d: "2026-08-01", v: 4 }];
  assert.equal(S.verifyMigration(rows, docs).ok, false);
});

/* ---- metric merge --------------------------------------------------
   "Do not erase a previously known metric merely because a provider
   does not return it on a later call."
   ------------------------------------------------------------------ */

test("a metric the provider did not mention keeps the reading we already had", () => {
  const r = S.mergeMetrics({ views: 85031, likes: 900, saves: 12 }, { views: 90000 });
  assert.equal(r.metrics.views, 90000);
  assert.equal(r.metrics.likes, 900, "likes were not reported and must not become 0");
  assert.equal(r.metrics.saves, 12);
  assert.ok(r.kept.includes("likes"));
});

test("a genuine zero is written when there is no earlier reading to lose", () => {
  assert.equal(S.mergeMetrics({}, { likes: 0 }).metrics.likes, 0);
  assert.equal(S.mergeMetrics({ likes: 0 }, { likes: 0 }).metrics.likes, 0);
});

test("a zero reported against a reading we already hold is refused, not written", () => {
  /* the same accident as an omitted field, arriving by a different
     route — a token that lost a scope, or a cached empty response */
  const r = S.mergeMetrics({ likes: 900 }, { likes: 0 });
  assert.equal(r.metrics.likes, 900);
  assert.equal(r.changed.find((c) => c.field === "likes").applied, false);
});

test("null and empty string are absence, not zero", () => {
  const r = S.mergeMetrics({ views: 500 }, { views: null, likes: "" });
  assert.equal(r.metrics.views, 500);
  assert.ok(!("likes" in r.metrics));
});

test("a smaller figure than we already hold is refused and reported", () => {
  const r = S.mergeMetrics({ views: 85031 }, { views: 12 });
  assert.equal(r.metrics.views, 85031);
  const note = r.changed.find((c) => c.field === "views");
  assert.equal(note.applied, false);
  assert.equal(note.reason, "would decrease");
});

test("a decrease is accepted when a person asks for a correction", () => {
  assert.equal(S.mergeMetrics({ views: 85031 }, { views: 12 }, { allowDecrease: true }).metrics.views, 12);
});

test("garbage from a provider does not overwrite a real reading", () => {
  const r = S.mergeMetrics({ views: 500 }, { views: "many" });
  assert.equal(r.metrics.views, 500);
});

test("merging the same payload twice changes nothing the second time", () => {
  const first = S.mergeMetrics({ views: 100 }, { views: 200 });
  const second = S.mergeMetrics(first.metrics, { views: 200 });
  assert.equal(second.changedCount, 0);
});

/* ---- assignment merge ----------------------------------------------
   "Never overwrite a manually confirmed campaign assignment with an
   automatic match."
   ------------------------------------------------------------------ */

test("an automatic match never overrides a person's decision", () => {
  const r = S.mergeAssignment(
    { campaignId: "cp8356", matchStatus: "confirmed", matchMethod: "roster", matchConfidence: 100 },
    { campaignId: "cp_guess", matchStatus: "auto_matched", matchConfidence: 99 });
  assert.equal(r.campaignId, "cp8356");
  assert.equal(r.overrode, false);
});

test("content a person ruled out stays ruled out", () => {
  const r = S.mergeAssignment({ matchStatus: "excluded" }, { campaignId: "cp_x", matchStatus: "auto_matched" });
  assert.equal(r.matchStatus, "excluded");
  assert.equal(r.overrode, false);
});

test("an unmatched post can be proposed a campaign, and lands as needs-review", () => {
  const r = S.mergeAssignment({ matchStatus: "unassigned" }, { campaignId: "cp_x", creatorId: "cr_2" });
  assert.equal(r.campaignId, "cp_x");
  assert.equal(r.matchStatus, "suggested");
});

test("proposing nothing leaves an unmatched post unmatched rather than blanking it", () => {
  const r = S.mergeAssignment({ campaignId: "cp_a", matchStatus: "auto_matched", matchConfidence: 60 }, {});
  assert.equal(r.campaignId, "cp_a");
  assert.equal(r.matchStatus, "auto_matched");
});

test("the migration does not improve the data on its way past", () => {
  /* platformPostId is blank on the record and derivable from the url.
     Filling it in here would be an improvement, and an improvement is
     indistinguishable from a corruption once verification runs. */
  const before = rec({ platformPostId: "" });
  const d = S.toDocument(before, {});
  assert.equal(d.platformPostId, "", "the existing field is untouched");
  assert.equal(d.derivedPostId, "ig_ABC123", "the derivation lives beside it");
  assert.equal(S.verifyMigration([before], [d]).ok, true);
});
