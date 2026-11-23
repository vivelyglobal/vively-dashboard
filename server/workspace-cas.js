"use strict";
/* The final write of a workspace save, as a compare-and-set.

   saveWorkspaceDoc reads the revision, does some work (booking projection,
   partner-link stamping), then writes. Without a revision in the write's
   filter, another save landing in between was silently overwritten. Here
   the write only matches the revision that was read.

   Returns { ok: true } or { conflict: true, revision, savedAt }.
   Throws on any other database error (the caller turns that into a 502). */

const DUP_KEY = 11000;

async function writeWorkspaceCas(col, id, o) {
  const doc = { db: o.db, settings: o.settings, savedAt: o.savedAt, revision: o.nextRevision };

  /* force: unchanged from before. No revision filter, upsert. */
  if (o.force) {
    await col.updateOne({ _id: id }, { $set: doc }, { upsert: true });
    return { ok: true };
  }

  /* No document at read time: only an insert may create it. If somebody
     else created it meanwhile, the duplicate key is a conflict, not a
     reason to overwrite their document. */
  if (!o.existed) {
    try {
      await col.insertOne(Object.assign({ _id: id }, doc));
      return { ok: true };
    } catch (err) {
      if (err && err.code === DUP_KEY) return conflict(col, id);
      throw err;
    }
  }

  /* A document saved before revisions existed has no revision field, and
     the reader treats that as 0. $in:[0,null] matches 0, null and missing. */
  const filter = { _id: id, revision: o.currentRevision ? o.currentRevision : { $in: [0, null] } };
  const r = await col.updateOne(filter, { $set: doc });
  if (r && r.matchedCount === 0) return conflict(col, id);
  return { ok: true };
}

async function conflict(col, id) {
  const cur = await col.findOne({ _id: id }, { projection: { revision: 1, savedAt: 1 } });
  return { conflict: true, revision: (cur && cur.revision) || 0, savedAt: cur ? cur.savedAt : undefined };
}

module.exports = { writeWorkspaceCas };
