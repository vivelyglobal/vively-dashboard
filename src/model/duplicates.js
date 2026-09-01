import { $, esc } from '../ui/dom.js';
import { toast } from '../ui/overlay.js';
import { recomputeCreatorStats } from './creators.js';
import { DB, byCampaign, byCreator, notify, serverSave } from './db.js';
import { newId } from './vocab.js';

/* ------------------------------------------------------------------
   Duplicate record ids.

   Two campaigns sharing an id is not a cosmetic problem: the route
   #/campaigns/<id> matches both, the menu highlights both, and an edit
   lands on whichever one the lookup happened to keep — so neither can
   be changed independently. Their participants pool under the one id
   too, which is why a roster shows other people's creators.

   Nothing generates a colliding id any more, but workspaces created
   before that fix can still contain one, so it is checked on load and
   repairable from Setup.
   ------------------------------------------------------------------ */
export function duplicateIdGroups() {
  const groups = [];
  [['campaigns', 'campaign'], ['creators', 'creator'], ['participants', 'roster row']].forEach(([key, label]) => {
    const seen = {};
    (DB[key] || []).forEach((r) => { (seen[r.id] = seen[r.id] || []).push(r); });
    Object.entries(seen).forEach(([id, list]) => {
      if (list.length > 1) groups.push({ kind: key, label, id, list });
    });
  });
  return groups;
}

/* Renumbering keeps the FIRST record on the shared id and moves the later
   ones, so whichever was there first stays where every existing link,
   bookmark and calendar event already points. */
export function repairDuplicateIds() {
  const groups = duplicateIdGroups();
  if (!groups.length) return { fixed: 0 };
  let fixed = 0, movedRows = 0;

  groups.forEach((g) => {
    g.list.slice(1).forEach((rec) => {
      const oldId = rec.id;
      const prefix = g.kind === 'campaigns' ? 'cp' : g.kind === 'creators' ? 'cr' : 'p';
      rec.id = newId(prefix);
      fixed++;

      if (g.kind === 'campaigns') {
        byCampaign[rec.id] = rec;
        /* Participants stay on the original id on purpose. There is no way
           to tell here which of the two campaigns each belongs to — but the
           next "Sync from Notion" on this campaign knows, because Notion
           says which rows are its own, and moves them across. */
      } else if (g.kind === 'creators') {
        byCreator[rec.id] = rec;
      } else {
        /* Two roster rows genuinely sharing an id is the one case where the
           id has to change. Anything already keyed on the old one — a
           calendar event, a partner's comments — stays with the row that
           kept it; the renumbered row starts clean rather than pointing at
           an event that is not its own. The calendar's orphan check then
           surfaces the leftover event with a button to remove it. */
        rec.id = newId('p');
        delete rec.googleEventId;
        delete rec.googleLink;
        delete rec.googleSyncedAt;
        movedRows++;
      }
    });
  });

  recomputeCreatorStats();
  return { fixed, movedRows, groups };
}

export function duplicateIdBanner() {
  const groups = duplicateIdGroups();
  if (!groups.length) return '';
  const campaignDupes = groups.filter((g) => g.kind === 'campaigns');
  return `<div class="note bad" style="margin-bottom:14px">
    <strong>${groups.length} record${groups.length === 1 ? '' : 's'} share an id with another.</strong>
    ${campaignDupes.length ? campaignDupes.map((g) =>
      `<br>${esc(g.list.map((c) => c.brand || c.name).join('  ·  '))} all answer to <code>${esc(g.id)}</code>,
       so selecting one selects them all and an edit cannot tell them apart.` ).join('') : ''}
    <div style="margin-top:8px"><button class="btn xs" id="dupFix">Give each one its own id</button>
      <span style="margin-left:8px;color:var(--text-3)">Then run <em>Sync from Notion</em> on each to pull its own creators back.</span></div>
  </div>`;
}

export function wireDuplicateIdBanner() {
  const btn = $('#dupFix');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const groups = duplicateIdGroups();
    const names = groups.filter((g) => g.kind === 'campaigns')
      .flatMap((g) => g.list.slice(1).map((c) => c.brand || c.name));
    if (!confirm(`Give a fresh id to: ${names.join(', ') || groups.length + ' records'}?\n\n` +
      `The first of each pair keeps the old id, so existing links still work. ` +
      `Creators stay put until you sync each campaign from Notion, which is what knows who belongs where.`)) return;
    const out = repairDuplicateIds();
    notify();
    serverSave({ silent: true });
    toast(`${out.fixed} record${out.fixed === 1 ? '' : 's'} renumbered — now sync each campaign from Notion`);
  });
}
