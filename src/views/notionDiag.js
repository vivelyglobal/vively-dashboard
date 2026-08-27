import { NOTION_FIELD_DEFS, healNotionMapping, notionRowToApplicant, openNotionLinkDrawer, openNotionMappingDrawer, runNotionSync } from '../import/notion.js';
import { findCreatorByHandle } from '../model/creators.js';
import { DB } from '../model/db.js';
import { $, esc } from '../ui/dom.js';
import { copyText } from '../ui/html.js';
import { openDrawer, toast } from '../ui/overlay.js';

/* ============================================================
   NOTION DIAGNOSTIC
   Shows exactly what Notion returns for this campaign and exactly
   what the sync makes of it, side by side, so a sync that "does
   nothing" can be read rather than guessed at.
   ============================================================ */
export async function openNotionDiagnostic(cp) {
  openDrawer('Notion diagnostic — ' + esc(cp.brand), '<div class="empty">Reading Notion…</div>');
  const lines = [];
  const add = (s) => lines.push(s);

  add('CAMPAIGN: ' + cp.brand + ' — ' + cp.name);
  add('id: ' + cp.id);
  add('notionDatabaseId: ' + (cp.notionDatabaseId || '(none)'));
  add('notionSyncedAt: ' + (cp.notionSyncedAt || '(never)'));
  add('');
  add('SAVED FIELD MAPPING');
  NOTION_FIELD_DEFS.forEach((f) => {
    const v = cp.notionMapping ? cp.notionMapping[f.key] : undefined;
    add(`  ${f.key.padEnd(12)} -> ${v === undefined ? '(key absent)' : v === null ? '(none)' : '"' + v + '"'}`);
  });

  const ps = DB.participants.filter((p) => p.campaignId === cp.id);
  add('');
  add('ROSTER IN THIS DASHBOARD');
  add(`  participants: ${ps.length}`);
  add(`  with notionPageId: ${ps.filter((p) => p.notionPageId).length}`);
  add(`  with visitAt: ${ps.filter((p) => p.visitAt).length}`);
  add(`  stages: ${Object.entries(ps.reduce((m, p) => { m[p.stage] = (m[p.stage] || 0) + 1; return m; }, {})).map(([k, v]) => k + '=' + v).join(', ') || '(none)'}`);

  let schema = null, data = null, err = null;
  try {
    const r1 = await fetch('/api/notion/database?id=' + encodeURIComponent(cp.notionDatabaseId));
    schema = await r1.json();
    if (!r1.ok) throw new Error('schema: ' + (schema.error || r1.status));
    const r2 = await fetch('/api/notion/query?id=' + encodeURIComponent(cp.notionDatabaseId));
    data = await r2.json();
    if (!r2.ok) throw new Error('query: ' + (data.error || r2.status));
  } catch (e) { err = e.message; }

  if (err) {
    add('');
    add('!! NOTION CALL FAILED: ' + err);
  } else {
    add('');
    add('LIVE NOTION DATA');
    add(`  resolved data source: ${schema.id}`);
    add(`  title: ${schema.title}`);
    add(`  rows returned: ${data.rows.length}`);
    add('');
    add('  PROPERTIES (name | type | first non-empty value)');
    (schema.properties || []).forEach((p) => {
      const hit = data.rows.find((r) => r.properties[p.name] !== '' && r.properties[p.name] != null);
      add(`    ${p.name} | ${p.type} | ${hit ? String(hit.properties[p.name]).slice(0, 50) : '(empty in every row)'}`);
    });

    add('');
    add('  WHAT THE SYNC MAKES OF THE FIRST 5 ROWS');
    data.rows.slice(0, 5).forEach((row, i) => {
      const ap = notionRowToApplicant(row.properties, cp.notionMapping || {});
      const known = DB.participants.find((x) => x.notionPageId === row.pageId);
      const byCr = ap.handle ? findCreatorByHandle(ap.handle) : null;
      const orphan = byCr && DB.participants.find((x) => x.campaignId === cp.id && x.creatorId === byCr.id && !x.notionPageId);
      add(`    row ${i + 1}: pageId=${row.pageId.slice(0, 8)}… handle=${ap.handle || '(NONE - row will be skipped)'} ` +
          `visitAt="${ap.visitAt}" status="${ap.statusRaw}" -> stage=${ap.stage}`);
      add(`            matches existing row by pageId: ${known ? 'yes' : 'no'}; unclaimed roster row to adopt: ${orphan ? 'yes' : 'no'}`);
    });

    const withHandle = data.rows.filter((r) => notionRowToApplicant(r.properties, cp.notionMapping || {}).handle).length;
    const withVisit = data.rows.filter((r) => notionRowToApplicant(r.properties, cp.notionMapping || {}).visitAt).length;
    add('');
    add('  TOTALS ACROSS ALL ROWS');
    add(`    rows that resolve to a creator handle: ${withHandle} / ${data.rows.length}`);
    add(`    rows that produce a visit date:        ${withVisit} / ${data.rows.length}`);
  }

  const text = lines.join('\n');
  $('#drawerBody').innerHTML = `
    <div class="note" style="margin-bottom:12px">
      This is exactly what Notion returned and what the sync made of it. Copy it and send it over if the
      numbers don't look right.
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn primary" id="ndCopy">Copy diagnostic</button>
      <button class="btn" id="ndMap">Open field mapping</button>
    </div>
    <pre style="font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:color-mix(in srgb, var(--text-3) 8%, transparent);padding:12px;border-radius:8px;max-height:60vh;overflow:auto">${esc(text)}</pre>`;
  $('#ndCopy').addEventListener('click', () => copyText(text, 'Diagnostic'));
  $('#ndMap').addEventListener('click', () => openNotionMappingDrawer(cp));
}

export async function openNotionSync(cp) {
  if (!cp.notionDatabaseId) return openNotionLinkDrawer(cp);
  if (!cp.notionMapping) return openNotionMappingDrawer(cp);
  const added = await healNotionMapping(cp);
  if (added.length) toast('Mapped new field' + (added.length === 1 ? '' : 's') + ': ' + added.join(', '));
  runNotionSync(cp);
}
