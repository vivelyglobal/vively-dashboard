import { STAGE_IDX, tierOf } from './vocab.js';
import { DB, byCreator } from './db.js';

/* ------------------------------------------------------------------
   One creator, one row. Handles arrive from spreadsheets in every
   shape — trailing dots, query strings, mixed case — so matching is
   done on a normalised form. Campaigns may of course repeat the same
   creator; the database may not.
   ------------------------------------------------------------------ */
/* One creator, one row. Handles arrive in every shape a person can type them \u2014
   @name, NAME, name/, instagram.com/name/?hl=ko, a full https URL pasted out of
   the browser bar \u2014 and all of those are the same creator. */
export function normHandle(h) {
  let s = String(h || '').trim().toLowerCase()
    .replace(/[\s\u200b]/g, '')
    .replace(/[?#].*$/, '');
  /* pull the handle out of a profile URL, whatever platform */
  const m = s.match(/^(?:https?:)?\/\/?(?:www\.)?(?:instagram|tiktok|youtube)\.com\/(?:@)?([^/]+)/);
  if (m) s = m[1];
  return s.replace(/^@+/, '').replace(/\/+$/, '').replace(/\.+$/, '');
}
export function findCreatorByHandle(handle) {
  const k = normHandle(handle);
  return k ? DB.creators.find((c) => normHandle(c.handle) === k) : null;
}

/* group the database by normalised handle and report anything doubled up */
export function duplicateCreatorGroups() {
  const groups = {};
  DB.creators.forEach((c) => {
    const k = normHandle(c.handle);
    if (!k) return;
    (groups[k] = groups[k] || []).push(c);
  });
  return Object.entries(groups).filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, list }));
}

export const richness = (c) => (c.campaignIds || []).length * 100 + (c.followers ? 10 : 0) +
  (c.email ? 2 : 0) + (c.contact ? 2 : 0) + (c.address ? 2 : 0) + (c.flag ? 5 : 0) + (c.notes ? 1 : 0);

export function mergeDuplicateCreators() {
  const groups = duplicateCreatorGroups();
  let mergedCreators = 0, mergedParticipants = 0;

  groups.forEach(({ list }) => {
    const ordered = list.slice().sort((a, b) => richness(b) - richness(a));
    const keep = ordered[0];
    const drop = ordered.slice(1);

    drop.forEach((d) => {
      /* fill anything blank on the survivor from the duplicate */
      ['name', 'platform', 'country', 'nationality', 'email', 'contact', 'address', 'source', 'lastWorked'].forEach((k) => {
        if (!keep[k] && d[k]) keep[k] = d[k];
      });
      ['followers', 'er', 'avgViews', 'rate', 'reliability', 'avgTurnaroundDays'].forEach((k) => {
        if (!keep[k] && d[k]) keep[k] = d[k];
      });
      keep.categories = [...new Set([...(keep.categories || []), ...(d.categories || [])])];
      keep.languages = [...new Set([...(keep.languages || []), ...(d.languages || [])])];
      keep.tags = [...new Set([...(keep.tags || []), ...(d.tags || [])])];
      if (d.notes && !String(keep.notes || '').includes(d.notes)) keep.notes = [keep.notes, d.notes].filter(Boolean).join('\n');
      /* a blacklist flag always wins over no flag */
      const rank = { blocked: 3, caution: 2, preferred: 1 };
      if (d.flag && (rank[d.flag] || 0) > (rank[keep.flag] || 0)) {
        keep.flag = d.flag; keep.flagReason = d.flagReason; keep.flagAt = d.flagAt;
      }
      keep.tier = tierOf(keep.followers || 0).id;

      /* move every campaign row across to the survivor */
      DB.participants.forEach((p) => { if (p.creatorId === d.id) p.creatorId = keep.id; });
      delete byCreator[d.id];
      mergedCreators++;
    });
  });

  /* one row per creator per campaign — keep whichever got furthest */
  const seen = {};
  const keptRows = [];
  DB.participants.forEach((p) => {
    const k = p.campaignId + '::' + p.creatorId;
    const prev = seen[k];
    if (!prev) { seen[k] = p; keptRows.push(p); return; }
    const better = (STAGE_IDX[p.stage] > STAGE_IDX[prev.stage]) || (p.content && !prev.content);
    if (better) {
      Object.keys(prev).forEach((key) => { if (!prev[key] && p[key]) prev[key] = p[key]; });
      Object.assign(prev, p);
    } else {
      Object.keys(p).forEach((key) => { if (!prev[key] && p[key]) prev[key] = p[key]; });
    }
    mergedParticipants++;
  });
  DB.participants = keptRows;
  DB.participants.forEach((p) => { p.id = p.campaignId + '-' + p.creatorId; });

  const keepIds = new Set(Object.keys(byCreator));
  DB.creators = DB.creators.filter((c) => keepIds.has(c.id));
  recomputeCreatorStats();
  return { mergedCreators, mergedParticipants, groups: groups.length };
}

/* derived creator stats — recomputed whenever the roster changes */
export function recomputeCreatorStats() {
  const byId = {};
  DB.participants.forEach((p) => (byId[p.creatorId] = byId[p.creatorId] || []).push(p));
  DB.creators.forEach((cr) => {
    const ps = byId[cr.id] || [];
    const live = ps.filter((p) => p.content && p.stage === 'live');
    cr.campaignIds = [...new Set(ps.map((p) => p.campaignId))];
    cr.contentCount = live.length;
    cr.campaignsDone = live.length;
    cr.totalViews = live.reduce((a, p) => a + (p.content.views || 0), 0);
    cr.bestViews = live.reduce((a, p) => Math.max(a, p.content.views || 0), 0);
    const confirmed = ps.filter((p) => p.stage !== 'dropped' && STAGE_IDX[p.stage] >= 4).length;
    cr.deliveredRate = confirmed ? live.length / confirmed : 0;
    const posted = live.map((p) => p.content.postedAt).filter(Boolean).sort().pop();
    if (posted) cr.lastWorked = posted;
  });
}
