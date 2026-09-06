#!/usr/bin/env node
/* ===================================================================
   The migration, rehearsed end to end against a workspace shaped like
   the real one, with a collection made of a Map.

   There is no MongoDB in this container and there is exactly one copy
   of the production data, so the first time the real script runs it
   must already be known to work. This stands in a fake collection that
   implements the four calls the script makes — bulkWrite with upsert,
   countDocuments, find, deleteMany — with the same semantics Mongo
   gives them, and drives the whole sequence: plan, write, verify, run
   it again, verify again, roll back, verify the workspace never moved.

   The fixture reproduces what was measured in production rather than
   what would be convenient: 97 records, 43 of them with any views at
   all, saves and reach flat zero on every one, empty curve, empty
   thumbnail, 96 Instagram and 1 TikTok, and the four campaigns with
   their real post counts. Two of those campaigns have 54 posts between
   them and not one measured view, which is the case a fixture invented
   for a happy path would never contain and the one most likely to be
   mishandled.

     node tools/rehearse-migration.mjs
   =================================================================== */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../server/social-store.js");

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n       " + e.message); failures++; }
};
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ": expected " + b + ", got " + a); };

/* ---- a workspace shaped like the real one -------------------------- */

const CAMPAIGNS = [
  { id: "cp8356",  name: "KOWORK",              posts: 17, views: 445356 },
  { id: "cp11345", name: "NAAP Middle East",    posts: 26, views: 104762 },
  { id: "cp12895", name: "Myeongdong K-Galbi",  posts: 30, views: 0 },
  { id: "cp2907",  name: "압구정닭한마리",        posts: 24, views: 0 }
];
/* the three distinct postedAt values production actually has */
const POSTED = ["2026-07-14", "2026-08-01", "2026-08-11"];

function buildWorkspace() {
  const socialContent = [];
  let n = 0;
  CAMPAIGNS.forEach((cp, ci) => {
    /* the campaign's views spread over its posts, so the totals match
       the real ones exactly and verification has something to compare */
    const measured = cp.views ? (ci === 0 ? 17 : 26) : 0;
    let left = cp.views;
    for (let i = 0; i < cp.posts; i++) {
      n++;
      const isLast = i === measured - 1;
      const views = i < measured ? (isLast ? left : Math.floor(cp.views / measured)) : 0;
      if (i < measured) left -= views;
      const platform = n === 42 ? "TikTok" : "Instagram";
      const url = platform === "TikTok"
        ? "https://www.tiktok.com/@creator" + n + "/video/74123456789012345" + (n % 10)
        : "https://www.instagram.com/reel/SC" + String(n).padStart(4, "0") + "/";
      socialContent.push({
        id: "sc_" + String(n).padStart(4, "0"),
        participantId: "pt_" + String(n).padStart(4, "0"),
        campaignId: cp.id,
        creatorId: "cr_" + String((n % 61) + 1).padStart(4, "0"),
        platform, platformPostId: "", username: "creator" + n,
        postUrl: url, url,
        thumbnailUrl: "", caption: "post " + n + " #" + cp.name.replace(/\s/g, "").toLowerCase(),
        hashtags: ["#" + cp.name.replace(/\s/g, "").toLowerCase()], mentions: [],
        format: "Reel",
        publishedAt: POSTED[n % 3], postedAt: POSTED[n % 3],
        /* 27 distinct measurement dates across August, as measured */
        metricsAt: views ? "2026-08-" + String((n % 27) + 2).padStart(2, "0") : "",
        submittedAt: "",
        views,
        paidViews: 0, organicViews: 0,
        likes: views ? Math.floor(views * 0.04) : 0,
        comments: views ? Math.floor(views * 0.002) : 0,
        shares: views ? Math.floor(views * 0.001) : 0,
        saves: 0, reach: 0, profileVisits: 0, followsGained: 0, linkClicks: 0,
        matchMethod: "roster", matchConfidence: 100, matchStatus: "confirmed",
        dataSource: "manual", lastScrapedAt: null,
        curve: [], boosted: false, viral: false, topCountries: [], thumbTint: "#8a4",
        createdAt: "2026-09-03T04:12:00.000Z", updatedAt: ""
      });
    }
  });
  return { _id: "shared", revision: 221, savedAt: "2026-09-05T08:31:33.000Z",
           db: { creators: [], campaigns: [], participants: [], appointments: [],
                 partnerLinks: [], socialContent } };
}

/* ---- a collection made of a Map ------------------------------------ */

function fakeCollection() {
  const rows = new Map();
  return {
    _rows: rows,
    async bulkWrite(ops) {
      let upserted = 0, matched = 0;
      ops.forEach((op) => {
        const { filter, replacement, upsert } = op.replaceOne;
        const id = filter._id;
        if (rows.has(id)) { matched++; rows.set(id, JSON.parse(JSON.stringify(replacement))); }
        else if (upsert) { upserted++; rows.set(id, JSON.parse(JSON.stringify(replacement))); }
      });
      return { upsertedCount: upserted, matchedCount: matched, modifiedCount: 0 };
    },
    async countDocuments() { return rows.size; },
    find() { return { async toArray() { return Array.from(rows.values()); } }; },
    async deleteMany() { const n = rows.size; rows.clear(); return { deletedCount: n }; }
  };
}

async function runMigration(col, records, batch, revision) {
  const plan = S.planMigration(records, { batch, at: "2026-09-06T00:00:00.000Z", sourceRevision: revision });
  if (!plan.canRun) throw new Error("plan refused");
  const ops = plan.docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
  for (let i = 0; i < ops.length; i += 200) await col.bulkWrite(ops.slice(i, i + 200));
  return plan;
}

/* ---- the rehearsal -------------------------------------------------- */

const ws = buildWorkspace();
const records = ws.db.socialContent;
/* the exact bytes of the workspace before anything runs; every check
   below re-compares against this string, because the one guarantee
   this script makes is that it never touches the original */
const FROZEN = JSON.stringify(ws);

console.log("fixture: " + records.length + " records, " +
            records.filter((r) => r.views > 0).length + " measured, " +
            records.reduce((a, r) => a + r.views, 0).toLocaleString() + " views\n");

check("the fixture matches what production actually holds", () => {
  eq(records.length, 97, "record count");
  eq(records.filter((r) => r.views > 0).length, 43, "measured");
  eq(records.reduce((a, r) => a + r.views, 0), 550118, "total views");
  eq(records.filter((r) => r.saves !== 0).length, 0, "saves are zero everywhere");
  eq(records.filter((r) => r.reach !== 0).length, 0, "reach is zero everywhere");
  eq(records.filter((r) => r.curve.length).length, 0, "curve is empty everywhere");
  eq(records.filter((r) => r.thumbnailUrl).length, 0, "no thumbnails");
  eq(records.filter((r) => r.platform === "Instagram").length, 96, "instagram");
  eq(records.filter((r) => r.platform === "TikTok").length, 1, "tiktok");
  eq(new Set(records.map((r) => r.postedAt)).size, 3, "distinct postedAt");
  eq(new Set(records.filter((r) => r.metricsAt).map((r) => r.metricsAt)).size, 27, "distinct metricsAt");
});

const col = fakeCollection();
let plan;

plan = S.planMigration(records, { batch: "b1" });
check("the plan is safe to run and safe to index", () => {
  eq(plan.canRun, true, "canRun");
  eq(plan.indexSafe, true, "indexSafe — no two rows are the same post");
  eq(plan.docs.length, 97, "documents planned");
  eq(plan.unkeyable.length, 0, "every record has something to key on");
});

await runMigration(col, records, "b1", 221);

check("all 97 records arrive", async () => { eq(col._rows.size, 97, "documents"); });

check("verification passes, field for field", () => {
  const docs = Array.from(col._rows.values());
  const r = S.verifyMigration(records, docs);
  if (!r.ok) throw new Error(r.problemCount + " differences, first: " + JSON.stringify(r.problems[0]));
  eq(r.counts.matched, 97, "matched");
  eq(r.extra.length, 0, "no stray documents");
});

check("the totals a person would recognise survive", () => {
  const docs = Array.from(col._rows.values());
  const sum = (rows, f) => rows.reduce((a, x) => a + (Number(x[f]) || 0), 0);
  eq(sum(docs, "views"), 550118, "views");
  eq(sum(docs, "likes"), sum(records, "likes"), "likes");
  eq(new Set(docs.map((d) => d.campaignId)).size, 4, "campaigns");
  eq(new Set(docs.map((d) => d.creatorId)).size, new Set(records.map((r) => r.creatorId)).size, "creators");
  eq(docs.filter((d) => d.url).length, 97, "urls");
});

check("the two campaigns with no measurements survive as themselves", () => {
  const docs = Array.from(col._rows.values());
  const quiet = docs.filter((d) => d.campaignId === "cp12895" || d.campaignId === "cp2907");
  eq(quiet.length, 54, "records");
  eq(quiet.filter((d) => d.views === 0).length, 54, "still zero, not missing");
  eq(quiet.filter((d) => "views" in d).length, 54, "the field is present, not dropped as falsy");
});

await runMigration(col, records, "b2", 221);
check("running it a second time does not duplicate anything", () => {
  eq(col._rows.size, 97, "still 97 documents");
  const r = S.verifyMigration(records, Array.from(col._rows.values()));
  eq(r.ok, true, "still verifies");
});

const grown = records.concat([Object.assign({}, records[0], {
  id: "sc_0098", participantId: "pt_0098",
  postUrl: "https://www.instagram.com/reel/SC0098/", url: "https://www.instagram.com/reel/SC0098/", views: 10
})]);
await runMigration(col, grown, "b3", 222);
check("a third run against a workspace with one new record adds one", () => {
  eq(col._rows.size, 98, "documents");
  eq(S.verifyMigration(grown, Array.from(col._rows.values())).ok, true, "verifies against the grown workspace");
});

await col.deleteMany({});
check("rollback empties the collection", () => { eq(col._rows.size, 0, "documents"); });

check("the workspace document was never touched, byte for byte", () => {
  if (JSON.stringify(ws) !== FROZEN) throw new Error("the workspace changed during the rehearsal");
  eq(ws.db.socialContent.length, 97, "records");
  eq(ws.revision, 221, "revision");
});

check("after a rollback the app still has everything it had before", () => {
  /* the point of the whole design: the legacy array is the live source
     throughout, so undoing the migration costs nothing */
  eq(ws.db.socialContent.reduce((a, r) => a + r.views, 0), 550118, "views");
});

await runMigration(col, records, "b4", 221);
check("and it can be migrated again from scratch", () => {
  eq(col._rows.size, 97, "documents");
  eq(S.verifyMigration(records, Array.from(col._rows.values())).ok, true, "verifies");
});

console.log("\n" + (failures ? "FAILURES: " + failures : "rehearsal clean — " + records.length +
  " records migrated, re-migrated, rolled back and migrated again with the workspace untouched throughout"));
process.exit(failures ? 1 : 0);
