/* ===================================================================
   The last thing standing between a bad afternoon and a lost roster.

   POST /api/workspace replaces the entire workspace document. That is
   the design — the client holds the whole thing and writes it back —
   and it is fine right up until the client's copy is empty for a
   reason nobody intended.

   The way that happened:

     1. The dashboard is opened somewhere with no localStorage — a
        phone, a new browser, a private window, or after site data was
        cleared. DB starts as { campaigns: [], creators: [], … }.
     2. serverLoad() fails or is refused. A 401 from an expired
        session, a cold start, a flaky connection: any of them leave
        DB exactly as it started, because nothing overwrote it.
     3. The tab is closed. beforeunload fires a sendBeacon POST with
        `force: true`, which skips the revision check.
     4. Array.isArray([]) is true, so the payload validated, and an
        empty workspace replaced fifteen campaigns, three hundred
        creators and four hundred roster rows.

   Silent, no error to see, and it happens on close — which is why it
   looked random and why it looked like a Notion problem.

   The client is fixed too, in two places. This exists because the
   client is not the only thing that can call this endpoint, and a
   guard that lives only in the caller is not a guard.
   =================================================================== */

const COLLECTIONS = ["campaigns", "creators", "participants"];

/* The intent a caller must state to be allowed to empty a workspace on
   purpose. Deliberately a sentence rather than `reset: true` — a stray
   truthy value cannot produce it by accident, and it reads clearly in
   a log or a network tab. */
const RESET_INTENT = "replace-with-empty";

function countsOf(db) {
  const d = db || {};
  const out = {};
  COLLECTIONS.forEach((k) => { out[k] = Array.isArray(d[k]) ? d[k].length : 0; });
  return out;
}

/* Empty means the three collections a workspace is actually made of.
   appointments, partnerLinks and socialContent are deliberately not
   counted: a workspace can legitimately have none of them, and one
   stray appointment must not be enough to wave a wipe through. */
function isEmptyWorkspace(db) {
  const c = countsOf(db);
  return COLLECTIONS.every((k) => c[k] === 0);
}

/* `existing` is the counts of what is already stored — not the document
   itself, so the caller can read them with a $size projection rather
   than pulling half a megabyte back to answer a yes/no question. */
function guardEmptyReplace(opts) {
  const o = opts || {};
  const incoming = countsOf(o.incoming);
  const existing = countsOf(o.existing);

  const incomingEmpty = COLLECTIONS.every((k) => incoming[k] === 0);
  const existingHas = COLLECTIONS.reduce((a, k) => a + existing[k], 0);

  if (!incomingEmpty) return { ok: true };
  if (!existingHas) return { ok: true, note: "both empty — nothing to protect" };

  if (o.intent === RESET_INTENT) {
    return { ok: true, reset: true, note: "explicit destructive reset" };
  }

  /* Refused on purpose even when force is set. `force` exists to settle
     a revision conflict — "yes, overwrite their version with mine" —
     and was never meant to authorise discarding the entire workspace.
     Two different questions that happened to share one flag. */
  return {
    ok: false,
    code: "empty-workspace",
    existing,
    message:
      "Refused: this would replace a workspace holding " +
      COLLECTIONS.map((k) => existing[k] + " " + k).join(", ") +
      " with an empty one. If the dashboard is showing nothing, it failed to load — " +
      "reload the page rather than saving over it."
  };
}

module.exports = { COLLECTIONS, RESET_INTENT, countsOf, isEmptyWorkspace, guardEmptyReplace };
