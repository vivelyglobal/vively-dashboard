#!/usr/bin/env node
/* ===================================================================
   Move the published posts out of the workspace document and into a
   collection of their own.

   The single most important property of this script: **it never
   modifies the workspace document.** Not on a dry run, not on a
   migrate, not on a rollback. It reads `workspace.db.socialContent`
   and writes a copy into `social_content`. The original array stays
   exactly where it is, still the thing the app reads, until a separate
   and later decision is taken to switch the read path over and — later
   still, and only once the new pages have been used in anger — to
   remove it.

   That is why rollback is trivial and why it can be trusted: undoing
   this migration means deleting rows that nothing depends on yet.
   There is no state to restore, because none was disturbed.

     node tools/migrate-social-content.mjs                  # dry run
     node tools/migrate-social-content.mjs --backup
     node tools/migrate-social-content.mjs --migrate
     node tools/migrate-social-content.mjs --verify
     node tools/migrate-social-content.mjs --rollback
     node tools/migrate-social-content.mjs --restore-workspace <file>

   MONGODB_URI comes from the environment — the same variable the
   server already uses. It is never printed, and the connection string
   is redacted out of any error this script reports.
   =================================================================== */

import { MongoClient } from "mongodb";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const store = require("../server/social-store.js");

/* ---- arguments ---------------------------------------------------- */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const MODE =
  has("--restore-workspace") ? "restore" :
  has("--rollback") ? "rollback" :
  has("--verify")   ? "verify"   :
  has("--migrate")  ? "migrate"  :
  has("--backup")   ? "backup"   : "dry-run";

const DB_NAME     = valueOf("--db", process.env.MONGODB_DB || "vively");
const WORKSPACE   = valueOf("--workspace-collection", "workspace");
const WORKSPACE_ID = valueOf("--workspace-id", "shared");
const TARGET      = valueOf("--collection", "social_content");
const SNAPSHOTS   = valueOf("--snapshots-collection", "social_metrics_snapshots");
const BACKUP_COLL = valueOf("--backup-collection", "workspace_backups");
const BACKUP_DIR  = valueOf("--backup-dir", "backups");
const SKIP_BACKUP = has("--skip-backup");
const FORCE_INDEX = has("--force-index");

/* ---- output ------------------------------------------------------- */

const URI = process.env.MONGODB_URI || "";
/* the connection string carries the database password; it must not
   reach the terminal even inside a stack trace */
const redact = (s) => {
  let out = String(s == null ? "" : s);
  if (URI) out = out.split(URI).join("‹MONGODB_URI›");
  return out.replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "‹connection string›");
};
const say  = (...a) => console.log(...a.map((x) => (typeof x === "string" ? redact(x) : x)));
const warn = (...a) => console.error(...a.map((x) => (typeof x === "string" ? redact(x) : x)));
const die = (msg) => { warn("\n✗ " + redact(msg)); process.exit(1); };

const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));

/* ---- the work ----------------------------------------------------- */

if (!URI) {
  die("MONGODB_URI is not set.\n" +
      "  Run this where the server runs, or export it for one command:\n" +
      "    MONGODB_URI='…' node tools/migrate-social-content.mjs\n" +
      "  Do not paste the value into a chat window or a commit.");
}

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 20000 });
let exitCode = 0;

try {
  await client.connect();
  const db = client.db(DB_NAME);
  const workspaceCol = db.collection(WORKSPACE);
  const targetCol = db.collection(TARGET);

  say("database   : " + DB_NAME);
  say("workspace  : " + WORKSPACE + " / _id=" + WORKSPACE_ID);
  say("target     : " + TARGET);
  say("mode       : " + MODE);
  say("");

  if (MODE === "restore") {
    await restoreWorkspace(workspaceCol);
  } else if (MODE === "rollback") {
    await rollback(targetCol);
  } else {
    const doc = await workspaceCol.findOne({ _id: WORKSPACE_ID });
    if (!doc) die("No workspace document with _id=" + WORKSPACE_ID + " in " + DB_NAME + "." + WORKSPACE);

    const records = (doc.db && doc.db.socialContent) || [];
    const revision = doc.revision || 0;
    say("revision   : " + revision + "   savedAt: " + (doc.savedAt || "—"));
    say("records    : " + plural(records.length, "social content record"));
    say("");

    if (MODE === "verify") {
      await verify(targetCol, records);
    } else {
      const batch = "mig-" + new Date().toISOString().replace(/[:.]/g, "-");
      const plan = store.planMigration(records, { batch, sourceRevision: revision });
      report(plan);

      if (MODE === "dry-run") {
        say("\nNothing was written. Re-run with --backup, then --migrate.");
      } else if (MODE === "backup") {
        await backup(db, doc, batch);
      } else if (MODE === "migrate") {
        if (!plan.canRun) die("The plan is not safe to run — fix the ids above first.");
        if (!SKIP_BACKUP) await backup(db, doc, batch);
        else say("! --skip-backup: no backup was taken for this run.");
        await migrate(db, targetCol, plan, revision);
        say("\n--- verifying against the workspace it came from ---\n");
        await verify(targetCol, records);
        await ensureIndexes(db, targetCol, plan);
      }
    }
  }
} catch (e) {
  warn("\n✗ " + redact(e && e.message ? e.message : String(e)));
  if (e && e.stack) warn(redact(e.stack.split("\n").slice(1, 4).join("\n")));
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit(exitCode);

/* ---- steps -------------------------------------------------------- */

function report(plan) {
  say("--- plan ---");
  say("  " + plural(plan.docs.length, "record") + " would be written");

  const bases = {};
  plan.docs.forEach((d) => { bases[d.keyBasis] = (bases[d.keyBasis] || 0) + 1; });
  Object.keys(bases).sort().forEach((b) => say("  keyed by " + b + ": " + bases[b]));

  if (plan.idCollisions.length) {
    warn("\n  ✗ " + plural(plan.idCollisions.length, "record") + " cannot be addressed:");
    plan.idCollisions.slice(0, 10).forEach((c) => warn("      [" + c.index + "] " + (c.id || "(no id)") + " — " + c.reason));
    warn("    Nothing will be written while these exist: a record with no id, or a");
    warn("    repeated id, cannot be migrated twice without the second run either");
    warn("    duplicating it or silently overwriting a different row.");
  }

  if (plan.keyCollisions.length) {
    warn("\n  ! " + plural(plan.keyCollisions.length, "pair") + " of records point at the same post:");
    plan.keyCollisions.slice(0, 10).forEach((c) => warn("      " + c.key + "  ←  " + c.ids.join(" and ")));
    warn("    The data still migrates — both rows are kept, nothing is merged or");
    warn("    dropped — but the uniqueness constraint on platform+post id cannot");
    warn("    be created until a person decides which of each pair is real.");
  }

  if (plan.unkeyable.length) {
    say("\n  ! " + plural(plan.unkeyable.length, "record") + " has no URL and no post id,");
    say("    so it is keyed on its own row id and no sync can ever match it:");
    plan.unkeyable.slice(0, 10).forEach((u) => say("      " + u.id));
  }

  say("\n  ids safe to write   : " + (plan.canRun ? "yes" : "NO"));
  say("  unique index safe   : " + (plan.indexSafe ? "yes" : "no — duplicates above"));
}

async function backup(db, doc, batch) {
  say("--- backup ---");

  /* Two copies, because they fail differently. The file survives the
     cluster being unreachable; the collection survives the laptop. */
  const dir = path.resolve(BACKUP_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "workspace-" + batch + ".json");
  const json = JSON.stringify(doc, null, 2);
  writeFileSync(file, json);
  say("  file       : " + file + "  (" + json.length.toLocaleString() + " bytes)");

  const check = readFileSync(file, "utf8");
  const back = JSON.parse(check);
  const n = ((back.db || {}).socialContent || []).length;
  if (n !== ((doc.db || {}).socialContent || []).length) die("the backup file did not read back with the same number of records");
  say("  read back  : " + plural(n, "record") + " ✓");

  await db.collection(BACKUP_COLL).replaceOne(
    { _id: batch },
    { _id: batch, takenAt: new Date().toISOString(), reason: "social_content migration",
      sourceRevision: doc.revision || 0, savedAt: doc.savedAt || null, doc },
    { upsert: true }
  );
  say("  collection : " + BACKUP_COLL + " / _id=" + batch + " ✓");
  say("");
  return { file, batch };
}

async function migrate(db, col, plan, revision) {
  say("\n--- writing ---");

  /* replaceOne with upsert, keyed on the record's own id. Running this
     twice writes the same documents a second time; it cannot produce a
     97th-and-a-98th copy of anything, which is the whole requirement. */
  const ops = plan.docs.map((d) => ({
    replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true }
  }));

  let written = 0;
  const CHUNK = 200;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const r = await col.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    written += (r.upsertedCount || 0) + (r.modifiedCount || 0) + (r.matchedCount || 0);
  }
  const count = await col.countDocuments({});
  say("  written    : " + written);
  say("  collection : " + plural(count, "document"));
  if (count !== plan.docs.length) {
    say("  ! the collection holds " + count + " documents but the workspace has " +
        plan.docs.length + " — either a previous run wrote something else, or");
    say("    records have been deleted from the workspace since. Check before cutting over.");
  }

  /* the snapshots collection is created empty and indexed now, so the
     sync has somewhere to write on its first run rather than creating
     an unindexed collection under load */
  const names = await db.listCollections({ name: SNAPSHOTS }).toArray();
  if (!names.length) { await db.createCollection(SNAPSHOTS); say("  created    : " + SNAPSHOTS + " (empty)"); }
  await db.collection(SNAPSHOTS).createIndex({ contentId: 1, at: 1 }, { unique: true, name: "content_at" });
  await db.collection(SNAPSHOTS).createIndex({ at: -1 }, { name: "at_desc" });
  say("  indexed    : " + SNAPSHOTS + " on (contentId, at) unique");
}

async function ensureIndexes(db, col, plan) {
  say("\n--- indexes ---");
  await col.createIndex({ campaignId: 1 }, { name: "campaign" });
  await col.createIndex({ creatorId: 1 }, { name: "creator" });
  await col.createIndex({ participantId: 1 }, { name: "participant" });
  await col.createIndex({ matchStatus: 1 }, { name: "match_status" });
  say("  campaign / creator / participant / matchStatus ✓");

  if (!plan.indexSafe && !FORCE_INDEX) {
    warn("  ! uniqueness on (platform, platformPostId) NOT created — " +
         plural(plan.keyCollisions.length, "duplicate") + " above.");
    warn("    Resolve them, then re-run with --migrate to create it.");
    return;
  }
  try {
    await col.createIndex({ key: 1 }, { unique: true, name: "content_key" });
    say("  unique on the content key (platform + post id, url fallback) ✓");
  } catch (e) {
    warn("  ! the unique index was refused: " + redact(e.message));
    warn("    The data is migrated and verified; only the constraint is missing.");
  }
}

async function verify(col, records) {
  const docs = await col.find({}).toArray();
  const r = store.verifyMigration(records, docs);

  say("--- verification ---");
  say("  records in the workspace : " + r.counts.records);
  say("  documents in " + TARGET.padEnd(15) + ": " + r.counts.documents);
  say("  matched by id            : " + r.counts.matched);
  say("  link fields checked      : " + r.checked.links + "   (participantId, campaignId, creatorId)");
  say("  url fields checked       : " + r.checked.urls);
  say("  metric fields checked    : " + r.checked.metrics);

  /* the totals a person can recognise — a field-by-field pass is
     convincing to a machine, but "550,118 views on both sides" is what
     actually persuades somebody it worked */
  const sum = (rows, f) => rows.reduce((a, x) => a + (Number(x[f]) || 0), 0);
  const withUrl = (rows) => rows.filter((x) => String(x.url || x.postUrl || "").trim()).length;
  say("");
  say("                              workspace        collection");
  ["views", "likes", "comments", "shares"].forEach((f) => {
    const a = sum(records, f), b = sum(docs, f);
    say("  total " + f.padEnd(22) + String(a).padStart(9) + String(b).padStart(18) + (a === b ? "  ✓" : "  ✗"));
  });
  const ca = new Set(records.map((x) => x.campaignId).filter(Boolean)).size;
  const cb = new Set(docs.map((x) => x.campaignId).filter(Boolean)).size;
  say("  distinct campaigns          " + String(ca).padStart(9) + String(cb).padStart(18) + (ca === cb ? "  ✓" : "  ✗"));
  const ra = new Set(records.map((x) => x.creatorId).filter(Boolean)).size;
  const rb = new Set(docs.map((x) => x.creatorId).filter(Boolean)).size;
  say("  distinct creators           " + String(ra).padStart(9) + String(rb).padStart(18) + (ra === rb ? "  ✓" : "  ✗"));
  say("  records with a url          " + String(withUrl(records)).padStart(9) + String(withUrl(docs)).padStart(18) +
      (withUrl(records) === withUrl(docs) ? "  ✓" : "  ✗"));

  if (r.extra.length) {
    warn("\n  ! " + plural(r.extra.length, "document") + " in the collection is not in the workspace:");
    r.extra.slice(0, 10).forEach((id) => warn("      " + id));
  }
  if (r.problemCount) {
    warn("\n  ✗ " + plural(r.problemCount, "difference") + ":");
    r.problems.slice(0, 20).forEach((p) =>
      warn("      " + p.id + " . " + p.field + " — " + p.reason +
           "  expected " + JSON.stringify(p.expected) + ", got " + JSON.stringify(p.got)));
    exitCode = 1;
  }

  say("\n  " + (r.ok ? "✓ every record matches, field for field." :
                       "✗ NOT VERIFIED — do not cut the app over."));
  if (r.ok) {
    say("\n  The workspace array is untouched and still the live source.");
    say("  Rollback stays available: node tools/migrate-social-content.mjs --rollback");
  }
  return r.ok;
}

async function rollback(col) {
  /* Deleting the new collection's contents is the entire rollback,
     because the migration never took anything away. */
  const n = await col.countDocuments({});
  say("--- rollback ---");
  say("  " + plural(n, "document") + " in " + TARGET);
  if (!n) { say("  nothing to undo."); return; }

  const r = await col.deleteMany({});
  say("  deleted    : " + r.deletedCount);
  const left = await col.countDocuments({});
  say("  remaining  : " + left + (left ? "  ✗" : "  ✓"));
  say("");
  say("  The workspace document was never modified by the migration, so");
  say("  the app is exactly where it was. If you also need to put the");
  say("  workspace back to a saved state, that is a separate command:");
  say("    node tools/migrate-social-content.mjs --restore-workspace backups/workspace-….json");
  if (left) exitCode = 1;
}

async function restoreWorkspace(col) {
  const file = valueOf("--restore-workspace", "");
  if (!file) die("--restore-workspace needs the path to a backup file.");
  if (!existsSync(file)) die("no such file: " + file);

  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!doc || !doc.db) die("that file does not look like a workspace backup (no .db)");
  const n = (doc.db.socialContent || []).length;

  const current = await col.findOne({ _id: WORKSPACE_ID }, { projection: { revision: 1, savedAt: 1 } });
  say("--- restore workspace ---");
  say("  from file  : " + file);
  say("  backup rev : " + (doc.revision || 0) + "   savedAt " + (doc.savedAt || "—") + "   " + plural(n, "record"));
  say("  live rev   : " + ((current && current.revision) || 0) + "   savedAt " + ((current && current.savedAt) || "—"));

  if (!has("--yes")) {
    warn("\n  This overwrites the live workspace with the backup, discarding every");
    warn("  change saved since it was taken. Add --yes if that is what you want.");
    exitCode = 1;
    return;
  }

  /* the restored document takes a revision above whatever is live, or
     every open browser would fail its next save against a stale lock */
  const nextRevision = Math.max((current && current.revision) || 0, doc.revision || 0) + 1;
  await col.replaceOne({ _id: WORKSPACE_ID },
    Object.assign({}, doc, { _id: WORKSPACE_ID, revision: nextRevision, savedAt: new Date().toISOString() }),
    { upsert: true });
  say("  restored   : revision " + nextRevision + " ✓");
  say("  Reload every open dashboard tab — they hold a stale revision.");
}
