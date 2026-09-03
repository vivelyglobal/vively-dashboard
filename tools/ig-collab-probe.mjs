/* ===================================================================
   ONE-OFF DIAGNOSTIC — does Meta treat an accepted Instagram collab
   as media we own?

   The question this answers, and nothing else: when a creator invites
   @vively.global as a collaborator and we accept, does that Reel show
   up on OUR media edge, and will Meta serve us insights for it? If the
   answer is yes, creator OAuth and Business Discovery are both
   unnecessary for the posts we are already collaborating on.

   WHAT THIS SCRIPT DOES NOT DO
     · it does not connect to MongoDB — the driver is never imported
     · it does not write to the workspace, or to anything but its own
       report file under tmp/
     · it does not print the access token, and redacts it from every
       line of output including Meta's own error messages
     · it does not post, publish, comment, reply or delete — every
       call is a GET

   NORMALLY YOU DO NOT NEED THIS FILE. The same probe runs on the
   server, using the token already in Render, so it never has to be
   copied anywhere:

     curl -H "X-Diagnostic-Key: <DIAGNOSTIC_KEY>" \
       https://vively-dashboard.onrender.com/api/diagnostics/instagram-collab

   This CLI exists for running the identical code against a stub, or
   against a token that is not the one deployed. Both call into
   server/instagram-collab-probe.js, so they cannot drift.

   RUNNING IT (from the repo root, on a machine with internet access —
   the cloud container and the desktop VM are both walled off from
   graph.instagram.com):

     macOS / Linux
       INSTAGRAM_ACCESS_TOKEN='paste-the-token' node tools/ig-collab-probe.mjs

     Windows PowerShell
       $env:INSTAGRAM_ACCESS_TOKEN='paste-the-token'
       node tools/ig-collab-probe.mjs
       Remove-Item Env:\INSTAGRAM_ACCESS_TOKEN

   The token is read from the environment, never from a command-line
   argument, so it does not end up in shell history.

   Optional flags
     --token-file <path>   read the token from a file instead of the env
     --media <id>          probe insights on this media id specifically
     --pages <n>           how many pages of media to walk (default 4)
     --all-insights        probe insights on every collab post found,
                           not just one (slower, more rate limit)
   =================================================================== */

import fs from "node:fs";
import path from "node:path";

/* ---- arguments ---------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(name);

const TOKEN = (() => {
  const file = flag("--token-file");
  if (file) return fs.readFileSync(file, "utf8").trim();
  return String(process.env.INSTAGRAM_ACCESS_TOKEN || "").trim();
})();

if (!TOKEN) {
  console.error(`
No token. Set INSTAGRAM_ACCESS_TOKEN in the environment, or pass
--token-file <path>. It is deliberately not accepted as a plain
argument so it cannot end up in your shell history.

  PowerShell:  $env:INSTAGRAM_ACCESS_TOKEN='...'; node tools/ig-collab-probe.mjs
  bash/zsh:    INSTAGRAM_ACCESS_TOKEN='...' node tools/ig-collab-probe.mjs
`);
  process.exit(2);
}

const MAX_PAGES = Number(flag("--pages", 4)) || 4;
const TARGET_MEDIA = flag("--media");
const ALL_INSIGHTS = has("--all-insights");

/* ---- run it, through the same module the server uses ---------------
   The implementation lives in server/instagram-collab-probe.js so the
   terminal run and the /api/diagnostics/instagram-collab route cannot
   drift apart. This file is the CLI around it. */

import { createRequire } from "node:module";
const probe = createRequire(import.meta.url)("../server/instagram-collab-probe.js");

const redact = probe.redactor(TOKEN);
const say = (...a) => console.log(redact(a.join(" ")));

/* the tracked-post list the server reads from Mongo; from a terminal it
   comes off disk, and it is optional either way */
let knownUrls = [];
const knownPath = path.join("tmp", "known-content.json");
if (fs.existsSync(knownPath)) {
  try { knownUrls = JSON.parse(fs.readFileSync(knownPath, "utf8")).posts || []; } catch (e) { /* optional */ }
}

say("\n" + "=".repeat(72));
say("  Instagram collaborator probe — read-only, no database access");
say("=".repeat(72));

const report = await probe.runProbe({
  token: TOKEN,
  base: process.env.IG_PROBE_BASE || undefined,
  knownUrls,
  maxPages: MAX_PAGES,
  allInsights: ALL_INSIGHTS,
  mediaId: TARGET_MEDIA
});

if (report.fatal) {
  say("\n" + report.fatal + "\n");
  (report.versionsTried || []).forEach((t) => say(`  ${String(t.version).padEnd(16)} ${t.error || "ok"}`));
  process.exit(1);
}

const acct = report.account || {};
say(`\nAPI version in use: ${report.apiVersion}`);
say(`Account:            @${acct.username || "?"}  ·  id ${acct.id || "?"}  ·  ${acct.account_type || "type unknown"}`);
say(`media_count:        ${acct.media_count ?? "not returned"}`);

say("\n" + "-".repeat(72));
say("  1 · Vively's media edge");
say("-".repeat(72));
if (report.fullFieldListRefused) say(`  full field list refused — ${report.fullFieldListRefused}`);
say(`  fields:  ${report.fieldsUsed}`);
say(`  walked ${report.pagesWalked || 0} page(s) · ${report.mediaReturned} media object(s)`);
if (report.mediaError) say(`  ERROR: ${report.mediaError}`);

say("\n" + "-".repeat(72));
say("  2 · Are collab posts by other creators in there?");
say("-".repeat(72));
const o = report.ownership || {};
say(`  owned by @${acct.username || "us"}:   ${o.ownedByUs}`);
say(`  owned by someone else:   ${o.ownedByOthers}   <-- collab posts, if any`);
if (o.otherOwners && o.otherOwners.length) {
  say("\n  the other owners:");
  o.otherOwners.forEach((u) => say(`    @${u}`));
}
say(`\n  ==> ${report.verdict}`);

const ov = report.trackedOverlap || {};
say(`\n  of the ${ov.trackedWithShortcode || 0} posts we already track, ${ov.reachable || 0} came back on this edge`);
(ov.matches || []).slice(0, 12).forEach((m) => say(`    ${m.shortcode}  ${m.handle || ""}  → media ${m.mediaId}`));

say("\n" + "-".repeat(72));
say("  3 · Insights");
say("-".repeat(72));
(report.insights || []).forEach((ins) => {
  say(`\n  ${ins.label}  (media ${ins.mediaId})`);
  say("  " + "-".repeat(64));
  say(`  all ${probe.METRICS.length} at once: ${ins.batchOfAllMetrics}`);
  ins.supported.forEach((s) => say(`  \u2713 ${s.metric.padEnd(30)} ${s.value == null ? "(no value)" : s.value}`));
  ins.refused.forEach((r) => say(`  \u2717 ${r.metric.padEnd(30)} ${r.reason}`));
});
if (!report.insights || !report.insights.length) say("  No media to probe.");

fs.mkdirSync("tmp", { recursive: true });
const out = path.join("tmp", `ig-probe-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));

say("\n" + "=".repeat(72));
say(`  ${report.calls} API calls${report.truncated ? " (hit the time limit)" : ""} · report written to ${out}`);
say("  Nothing was written to the database.");
say("=".repeat(72) + "\n");
