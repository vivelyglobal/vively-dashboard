import { STATUS_MAP } from '../import/excel.js';
import { byCampaign, byCreator, notify, serverSave } from '../model/db.js';
import { stageOf } from '../model/vocab.js';
import { toast } from '../ui/overlay.js';

/* ------------------------------------------------------------------
   Writing a stage change back to Notion.

   Until now this was one-way: Notion in, dashboard out. Moving a card
   on the board now sets the same row's Status in Notion, so the team
   working in Notion and the team working here stop diverging.

   The two vocabularies do not line up one-to-one, and pretending they
   do is how you corrupt a roster:

     · Notion has no "Contacted", "Replied" or "Sourced". Moving a card
       into one of those has nothing to write, and says so rather than
       writing something approximate.
     · Content in, In review and Shipped all mean "Waiting Upload" in
       Notion. That is safe to write because the sync back is
       forward-only — reading Waiting Upload will not drag a creator
       who is already at In review back to Shipped.
     · "Brand Accepted" and "Confirmed" both read as Confirmed here, so
       a row already on Brand Accepted is left alone rather than being
       flattened to the vaguer word.
   ------------------------------------------------------------------ */
export const STAGE_TO_NOTION = {
  shortlisted: 'Waiting Approval',
  confirmed:   'Confirmed',
  shipped:     'Waiting Upload',
  submitted:   'Waiting Upload',
  review:      'Waiting Upload',
  live:        'Uploaded'
  /* sourced, contacted and replied have no Notion equivalent */
};

/* a drop can mean three different things over there */
export function notionValueForDrop(p) {
  const why = String(p.dropReason || '').toLowerCase();
  if (/brand/.test(why)) return 'Brand Rejected';
  if (/cancel/.test(why)) return 'Cancelled';
  return 'Declined';
}

export function notionValueForStage(p, stage) {
  return stage === 'dropped' ? notionValueForDrop(p) : (STAGE_TO_NOTION[stage] || null);
}

/* which Notion property holds the status for this campaign */
export function notionStatusProperty(cp) {
  const entry = Object.entries(cp.notionMapping || {}).find(([, key]) => key === 'status');
  return entry ? entry[0] : null;
}

export const WRITEBACK_KEY = 'vively-notion-writeback-v1';
export const WRITEBACK = { on: true };
export function loadWriteback() {
  try { const v = localStorage.getItem(WRITEBACK_KEY); if (v !== null) WRITEBACK.on = v === '1'; }
  catch (e) { /* storage blocked — leave it on */ }
}
export function saveWriteback() {
  try { localStorage.setItem(WRITEBACK_KEY, WRITEBACK.on ? '1' : '0'); } catch (e) { /* nothing to do */ }
}

/* Returns why nothing was written, or null when a write was made. Kept
   separate from moveStage so the reason can be shown without the caller
   having to know any of the rules above. */
export async function pushStageToNotion(p, stage) {
  if (!WRITEBACK.on) return 'off';
  const cp = byCampaign[p.campaignId];
  if (!cp || !p.notionPageId) return 'not-from-notion';
  const property = notionStatusProperty(cp);
  if (!property) return 'no-status-column';

  const value = notionValueForStage(p, stage);
  if (!value) return 'no-notion-equivalent';

  /* Already saying the same thing over there — including the case where
     Notion's word is the more specific of the two. */
  const current = String(p.importedStatus || '').trim();
  if (current && (STATUS_MAP[current.toLowerCase()] || {}).stage === stage) return 'already';

  try {
    const res = await fetch('/api/notion/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: p.notionPageId, property, value })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
    p.importedStatus = value;
    p.notionStatusAt = new Date().toISOString();
    return null;
  } catch (err) {
    p.notionStatusError = err.message;
    throw err;
  }
}

/* the user-facing half: says what happened, good or bad */
export async function syncStageToNotion(p, stage) {
  const cr = byCreator[p.creatorId] || {};
  let why;
  try {
    why = await pushStageToNotion(p, stage);
  } catch (err) {
    toast(`Notion did not accept the change for ${cr.handle} — ${err.message}`);
    notify();
    return;
  }
  if (why === null) {
    p.notionStatusError = null;
    toast(`${cr.handle} → ${stageOf(stage).label} · Notion updated`);
    serverSave({ silent: true });
  } else if (why === 'no-notion-equivalent') {
    toast(`${cr.handle} → ${stageOf(stage).label}. Notion has no status for that, so it was left as it was.`);
  } else if (why === 'no-status-column') {
    toast(`${cr.handle} → ${stageOf(stage).label}. This campaign has no Status column mapped, so nothing was sent.`);
  }
  notify();
}
