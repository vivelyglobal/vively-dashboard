import { TODAY, iso } from '../lib/dates.js';
import { findCreatorByHandle, mergeDuplicateCreators } from '../model/creators.js';
import { DB, SERVER, byCreator, notify, serverSave } from '../model/db.js';
import { STAGE_IDX, avColor, newId, tierOf } from '../model/vocab.js';
import { $, esc } from '../ui/dom.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';
import { STATUS_MAP, countryOf, guessField, handleFromUrl, normHeader, parseDateCell, parseFollowers } from './excel.js';

/* ============================================================
   NOTION SYNC
   Each campaign can point at the Notion database behind its
   duplicated form. "Sync from Notion" reads it through the
   server (the integration secret never reaches the browser) and
   feeds it through the same field vocabulary as the Excel
   importer above — handleFromUrl, parseFollowers, STATUS_MAP,
   countryOf — so a Notion submission and a spreadsheet row end
   up shaped the same way.
   ============================================================ */
export const NOTION_FIELD_DEFS = [
  { key: 'instagram',   label: 'Instagram (link or handle)' },
  { key: 'tiktok',      label: 'TikTok (link or handle)' },
  { key: 'fullName',    label: 'Full name' },
  { key: 'email',       label: 'Email' },
  { key: 'contact',     label: 'Contact (phone / KakaoTalk)' },
  { key: 'address',     label: 'Shipping address' },
  { key: 'nationality', label: 'Nationality / country' },
  { key: 'followers',   label: 'Follower count' },
  { key: 'otherSns',    label: 'Other SNS' },
  { key: 'contentUrl',  label: 'Content link (video URL)' },
  { key: 'views',       label: 'Views' },
  { key: 'likes',       label: 'Likes' },
  { key: 'comments',    label: 'Comments' },
  { key: 'shares',      label: 'Shares' },
  { key: 'metricsAt',   label: 'Metrics updated (date the numbers were read)' },
  { key: 'gender',      label: '성별 · Gender' },
  { key: 'formNotes',   label: 'Notes (what the creator wrote)' },
  { key: 'remark',      label: '참고 · Remark (shown to the partner)' },
  { key: 'headcount',   label: '인원수 · Number of people visiting' },
  { key: 'visitAt',     label: 'Visit date & time (restaurant / salon booking)' },
  { key: 'status',      label: 'Status (maps to pipeline stage)' },
  { key: 'note',        label: 'Note / message' }
];

/* the performance columns, kept together so the sync and the mapping UI
   cannot drift apart as more get added */
export const NOTION_METRIC_KEYS = ['views', 'likes', 'comments', 'shares'];

export function guessNotionField(propName, propType) {
  const h = normHeader(propName);
  /* Settled before the generic alias table, which mis-reads both of these:
     "Email Address" contains "address" so it gets claimed as the shipping
     address, and "Instagram Follower" contains "instagram" so it gets
     claimed as the profile link. */
  if (propType === 'email' || /email|이메일/.test(h)) return 'email';
  if (/follower|팔로워/.test(h)) return 'followers';
  /* Settled before the alias table too. It matches on substrings, and "no"
     is the alias for the row-number column, so "Notes" and "Number of people
     visiting" both come back as a row number. Notes is a column the partner
     reads, so getting it wrong is not cosmetic. */
  if (/^notes?$|^비고$/.test(h)) return 'formNotes';
  if (/^remarks?$|^참고$|^특이사항$/.test(h)) return 'remark';
  /* The forms carry a formula column that composes the accept/reject wording
     from Status. Nothing here uses it, and without an explicit rule it falls
     into the note/message catch-all below and lands in the internal note. */
  if (/accepted.*rejected|rejected.*accepted|승인.*메시지/.test(h)) return 'skip';
  /* likewise the reminder formulas, which are Notion-side workflow prompts */
  if (/^reminder/.test(h)) return 'skip';
  if (/number of people|people visiting|인원/.test(h)) return 'headcount';
  /* Deliberately never mapped. A form that collects bank details is holding
     the most sensitive thing in this whole system in plain text, and pulling
     it into the workspace would spread it to local storage, the Sheet, every
     export and — one mistake later — a partner link. Payout details are
     entered in the dashboard, where stripPayout keeps them from travelling. */
  if (/bank|account number|계좌|은행/.test(h)) return 'skip';
  if (/^성별$|^gender$|^sex$/.test(h)) return 'gender';

  const g = guessField(propName, 0, []);
  if (g !== 'skip') return g;
  /* Performance columns first: "Comments" is a metric here, and the
     note/message test further down would otherwise swallow it. */
  if (/^views?$|view count|play count|^plays?$|조회/.test(h)) return 'views';
  if (/^likes?$|like count|좋아요/.test(h)) return 'likes';
  if (/^comments?$|comment count|댓글/.test(h)) return 'comments';
  if (/^shares?$|share count|공유/.test(h)) return 'shares';
  if (/metrics updated|metric date|stats updated|측정일/.test(h)) return 'metricsAt';
  /* A form's date question is nearly always the booking slot — but Notion
     adds its own bookkeeping timestamps to every database, and those must
     not be mistaken for the slot the creator picked. */
  const bookkeeping = /created|submitted|submission|last edited|last_edited|updated|timestamp|생성|수정/.test(h);
  /* when the content went up is not when the creator is coming in */
  if (/^posted|posting date|upload date|게시일/.test(h)) return 'skip';
  if (!bookkeeping && (propType === 'date' || /when|date|time|schedule|slot|booking|visit|avail|예약|일정|방문/.test(h))) return 'visitAt';
  if (/note|message|comment|비고|메모/.test(h)) return 'note';
  return 'skip';
}

/* Notion hands dates back as ISO ("2026-09-04T19:00:00.000+09:00") or as
   free text a creator typed into a form. Keep whatever we can read as the
   dashboard's own "YYYY-MM-DD HH:MM", and keep unparseable text as-is so
   nothing the creator wrote is silently dropped. */
export function notionVisitValue(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  /* A booking is a wall-clock time at the venue: 7pm at the Jongno counter is
     7pm whether you read this dashboard from Seoul or from London. So take the
     date and time straight out of what Notion wrote and never let Date()
     shift it into the reader's own timezone. (Going through Date() also turns
     a bare "2026-09-04" into UTC midnight, i.e. the day before, west of UTC.) */
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  /* something a creator typed by hand — keep it if it's a real date, else
     keep their words rather than losing the answer */
  const d = parseDateCell(s);
  if (!d || isNaN(d)) return s;
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return /\d{1,2}:\d{2}/.test(s) ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/* Read a stored slot back as a local wall-clock Date, for the calendar and
   the confirmation message. Built from parts, never parsed as an instant. */
export function parseVisitSlot(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return isNaN(d) ? null : d;
}

/* Metrics come back as a Notion number, or as text a human typed ("12.3K",
   "1.2만", "4,530"). Returns null when the cell is empty so an untouched
   column never overwrites a figure already recorded. NOT parseFollowers —
   that reads a bare 45 as 45,000, which is right for follower counts and
   very wrong for 45 comments. */
export function notionMetricValue(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).trim().replace(/[, ]/g, '').toLowerCase();
  if (!s) return null;
  let m = s.match(/^([\d.]+)만$/); if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = s.match(/^([\d.]+)k$/);      if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = s.match(/^([\d.]+)m$/);      if (m) return Math.round(parseFloat(m[1]) * 1e6);
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n);
}

/* one Notion page's properties, read through a saved field mapping,
   shaped exactly like one row out of parseImportRows() above */
export function notionRowToApplicant(properties, mapping) {
  const get = (key) => {
    const propName = mapping[key];
    if (!propName) return '';
    const v = properties[propName];
    return v == null ? '' : v;
  };
  const igRaw = get('instagram');
  const ttRaw = get('tiktok');
  const id1 = handleFromUrl(igRaw, 'Instagram');
  const id2 = handleFromUrl(ttRaw, 'TikTok');
  const ident = id1 || id2;
  const nameRaw = get('fullName');
  const statusRaw = String(get('status') || '').trim();
  const mapped = STATUS_MAP[statusRaw.toLowerCase()] || null;
  const fol = parseFollowers(get('followers'));
  const stage = (mapped || { stage: 'sourced' }).stage;

  return {
    handle: ident ? ident.handle : null,
    platform: ident ? ident.platform : 'Instagram',
    fullName: nameRaw ? String(nameRaw).trim() : (ident ? ident.handle : ''),
    email: String(get('email') || '').trim(),
    address: String(get('address') || '').trim(),
    contact: String(get('contact') || '').trim(),
    nationality: String(get('nationality') || '').trim(),
    otherSns: String(get('otherSns') || '').trim(),
    contentUrl: String(get('contentUrl') || '').trim(),
    note: String(get('note') || '').trim(),
    /* the creator's own Notes answer, kept apart from the private internal
       note — this one is shown to the partner */
    formNotes: String(get('formNotes') || '').trim(),
    remark: String(get('remark') || '').trim(),
    /* how many are coming, which is what a restaurant holds tables for */
    headcount: String(get('headcount') || '').trim(),
    gender: String(get('gender') || '').trim(),
    visitAt: notionVisitValue(get('visitAt')),
    metricsAt: notionVisitValue(get('metricsAt')),
    metrics: NOTION_METRIC_KEYS.reduce((acc, k) => {
      const n = notionMetricValue(get(k));
      if (n != null) acc[k] = n;
      return acc;
    }, {}),
    followers: fol.value,
    statusRaw,
    stage,
    dropReason: (mapped || {}).reason || (stage === 'dropped' ? 'Rejected' : null)
  };
}

/* Keep a participant's stage timestamps consistent with the stage it just
   moved to — the funnel, "Delivered", and the campaign stats all read
   these, so a stage change alone (without them) shows up as a card that
   moved but numbers that didn't. */
export function applyStageDates(p, stage, cp) {
  const at = STAGE_IDX[stage];
  const when = (cp && cp.start) || iso(TODAY);
  const dropped = stage === 'dropped';
  p.stage = stage;
  if (at >= 1 && !p.contactedAt) p.contactedAt = when;
  if (at >= 2 && !dropped && !p.repliedAt) p.repliedAt = when;
  if (at >= 4 && !dropped && !p.confirmedAt) p.confirmedAt = when;
  if (at >= 5 && !dropped && !p.shippedAt) p.shippedAt = p.arrivingDate || when;
}

export function openNotionLinkDrawer(cp) {
  openDrawer('Connect Notion — ' + esc(cp.brand), `
    <div class="note" style="margin-bottom:16px;">
      Paste the link to this campaign's Notion submissions database — the one behind your duplicated form.
      In Notion, open it as a full page, click <strong>Share</strong>, and make sure the integration this
      dashboard uses has access, then copy the page link here.
    </div>
    <div class="field"><label>Notion database link or ID</label>
      <input type="text" id="notionDbInput" placeholder="https://www.notion.so/.../1a2b3c4d5e6f..." value="${esc(cp.notionDatabaseId || '')}"/></div>
    <button class="btn primary" id="notionDbSave">Continue</button>
  `);
  $('#notionDbSave').addEventListener('click', () => {
    const v = $('#notionDbInput').value.trim();
    if (!v) { toast('Paste a Notion database link first'); return; }
    cp.notionDatabaseId = v;
    cp.notionMapping = null; /* new database — mapping needs to be redone */
    closeDrawer();
    openNotionMappingDrawer(cp);
  });
}

export async function openNotionMappingDrawer(cp) {
  openDrawer('Map Notion fields — ' + esc(cp.brand), `<div class="empty">Reading the database…</div>`);
  let schema;
  try {
    const res = await fetch('/api/notion/database?id=' + encodeURIComponent(cp.notionDatabaseId));
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || ('Server responded ' + res.status));
    schema = out;
    /* the server may have resolved a page link down to the database it
       contains — store that clean ID so later syncs skip the extra hop */
    cp.notionDatabaseId = out.id;
    /* the blurb above the Notion form describes the campaign — it's what the
       message generator writes from, so adopt it when there's no note yet */
    if (out.description) {
      cp.notionDescription = out.description;
      if (!String(cp.note || '').trim()) cp.note = out.description;
    }
  } catch (err) {
    $('#drawerBody').innerHTML = `
      <div class="note warn"><strong>Could not read that database.</strong> ${esc(err.message)}</div>
      <button class="btn" id="notionRetryLink" style="margin-top:12px">Use a different link</button>`;
    $('#notionRetryLink').addEventListener('click', () => openNotionLinkDrawer(cp));
    return;
  }

  const props = schema.properties || [];

  /* Show what each Notion property actually contains. Property names alone
     are guesswork — one look at a real value makes the right pick obvious,
     and makes a column that's empty in Notion immediately visible as such. */
  let samples = {};
  try {
    const qr = await fetch('/api/notion/query?id=' + encodeURIComponent(cp.notionDatabaseId));
    const qd = await qr.json();
    if (qr.ok && qd.rows) {
      props.forEach((p) => {
        const hit = qd.rows.find((r) => r.properties[p.name] !== '' && r.properties[p.name] != null);
        samples[p.name] = hit ? String(hit.properties[p.name]).slice(0, 40) : '';
      });
    }
  } catch (e) { /* samples are a nicety — the mapping UI works without them */ }

  const used = new Set();
  const guesses = {};
  NOTION_FIELD_DEFS.forEach((f) => {
    const saved = cp.notionMapping && cp.notionMapping[f.key];
    let pick = saved && props.some((p) => p.name === saved) ? saved : '';
    if (!pick) {
      const hit = props.find((p) => !used.has(p.name) && guessNotionField(p.name, p.type) === f.key);
      pick = hit ? hit.name : '';
    }
    if (pick) used.add(pick);
    guesses[f.key] = pick;
  });

  $('#drawerBody').innerHTML = `
    <div class="note" style="margin-bottom:16px;">
      <strong>${esc(schema.title)}</strong> — ${props.length} fields found.
      Match each of ours to the Notion property that holds it. Leave “— none —” for anything this form doesn't collect.
      This mapping is remembered, so future syncs for this campaign won't ask again.
    </div>
    ${NOTION_FIELD_DEFS.map((f) => `
      <div class="field">
        <label>${esc(f.label)}</label>
        <select id="nm_${f.key}">
          <option value="">— none —</option>
          ${props.map((p) => {
            const s = samples[p.name];
            return `<option value="${esc(p.name)}" ${guesses[f.key] === p.name ? 'selected' : ''}>${esc(p.name)} (${esc(p.type)})${s ? ' — e.g. ' + esc(s) : ' — empty in Notion'}</option>`;
          }).join('')}
        </select>
      </div>`).join('')}
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn primary" id="notionMapSave">Save mapping & sync</button>
      <button class="btn" id="notionMapBack">Use a different link</button>
    </div>`;

  $('#notionMapBack').addEventListener('click', () => openNotionLinkDrawer(cp));
  $('#notionMapSave').addEventListener('click', async () => {
    const mapping = {};
    NOTION_FIELD_DEFS.forEach((f) => { mapping[f.key] = $('#nm_' + f.key).value || null; });
    if (!mapping.instagram && !mapping.tiktok) {
      if (!confirm("Neither Instagram nor TikTok is mapped, so synced submissions won't match to a creator. Continue anyway?")) return;
    }
    cp.notionMapping = mapping;
    closeDrawer();
    await runNotionSync(cp);
  });
}

/* opts.batch: caller is syncing several campaigns, so skip the per-campaign
   toast / render / save and hand the numbers back to be totalled instead. */
/* Put the video link and its numbers onto a participant. The old code only
   ever set content when there wasn't one — fine for a link, wrong for
   metrics, which are the whole point of re-syncing: views on day 14 are not
   views on day 7. Link is written once; numbers refresh every sync. */
export function applyNotionContent(p, ap, cr) {
  const hasMetrics = Object.keys(ap.metrics || {}).length > 0;
  if (!ap.contentUrl && !hasMetrics) return 0;
  if (!p.content) {
    p.content = {
      url: '', platform: ap.platform, format: 'Reel', postedAt: iso(TODAY), submittedAt: iso(TODAY),
      views: 0, paidViews: 0, organicViews: 0, likes: 0, comments: 0, shares: 0, saves: 0,
      reach: 0, profileVisits: 0, followsGained: 0, linkClicks: 0,
      curve: [], boosted: false, viral: false, topCountries: [], thumbTint: avColor(cr.handle)
    };
  }
  let touched = 0;
  if (ap.contentUrl && p.content.url !== ap.contentUrl) { p.content.url = ap.contentUrl; touched++; }
  NOTION_METRIC_KEYS.forEach((k) => {
    if (ap.metrics[k] == null) return;
    if (p.content[k] !== ap.metrics[k]) { p.content[k] = ap.metrics[k]; touched++; }
  });
  /* When the numbers were read. Views are a rolling figure, so a bare
     count means little without the date it was taken — record Notion's
     own "Metrics Updated" when set, else stamp today so a refreshed
     figure is never left looking as old as the one it replaced. */
  if (ap.metricsAt && p.content.metricsAt !== ap.metricsAt) { p.content.metricsAt = ap.metricsAt; touched++; }
  else if (hasMetrics && touched && !ap.metricsAt) p.content.metricsAt = iso(TODAY);
  /* views recorded but nothing split out — treat it all as organic so the
     performance tab's paid/organic maths doesn't read as 100% paid */
  if (p.content.views && !p.content.paidViews && !p.content.organicViews) {
    p.content.organicViews = p.content.views;
  }
  return touched;
}

export async function runNotionSync(cp, opts) {
  const batch = opts && opts.batch;
  if (!batch) toast('Syncing from Notion…');
  let data;
  try {
    const res = await fetch('/api/notion/query?id=' + encodeURIComponent(cp.notionDatabaseId));
    data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Server responded ' + res.status));
  } catch (err) {
    if (!batch) toast('Notion sync failed — ' + err.message);
    return { campaign: cp, error: err.message };
  }

  let newRows = 0, updated = 0, newCreators = 0, matched = 0, skipped = 0, moved = 0, reslotted = 0, adopted = 0, metricsUpdated = 0, rehomed = 0;
  data.rows.forEach((row) => {
    const ap = notionRowToApplicant(row.properties, cp.notionMapping);
    if (!ap.handle) { skipped++; return; }

    let cr = findCreatorByHandle(ap.handle);
    if (!cr) {
      const crId = newId('nt');
      cr = {
        id: crId, handle: ap.handle, name: ap.fullName || ap.handle,
        platform: ap.platform, followers: ap.followers,
        er: 0, avgViews: Math.round(ap.followers * 0.6),
        categories: [cp.category], country: countryOf(ap.nationality),
        nationality: ap.nationality, languages: ['EN'],
        tier: tierOf(ap.followers).id, source: 'Notion form',
        rate: 0, reliability: null, avgTurnaroundDays: null,
        campaignsDone: 0, lastWorked: null,
        email: ap.email, contact: ap.contact, address: ap.address,
        tags: [], notes: '', flag: null, flagReason: '', flagAt: null,
        campaignIds: [], contentCount: 0, totalViews: 0, bestViews: 0
      };
      DB.creators.push(cr); byCreator[crId] = cr; newCreators++;
    } else {
      matched++;
      if (ap.followers && !cr.followers) cr.followers = ap.followers;
      if (ap.email && !cr.email) cr.email = ap.email;
      if (ap.contact && !cr.contact) cr.contact = ap.contact;
      if (ap.address && !cr.address) cr.address = ap.address;
      if (ap.nationality && !cr.nationality) cr.nationality = ap.nationality;
    }

    /* Match the submission to the roster row it belongs to. A row that
       predates this Notion link — imported from an Excel sheet, added by
       hand, or created before page IDs were recorded — carries no
       notionPageId, so it never matches here; the campaign+creator guard
       further down then reads the submission as a duplicate and drops it.
       That withheld every stage change and booked slot from precisely the
       campaigns whose roster did not originate in Notion, which is why one
       campaign synced perfectly and the rest came back empty. Claim the
       existing row for this submission instead of skipping it. */
    let p = DB.participants.find((x) => x.notionPageId === row.pageId);
    let adoptedRow = false;
    /* This submission belongs to THIS campaign's form, so the row it matches
       belongs to this campaign whatever it currently says. Two campaigns
       that shared an id pooled their rosters under one campaignId; syncing
       either one now pulls its own rows back where they belong. */
    if (p && p.campaignId !== cp.id) {
      p.campaignId = cp.id;
      p.id = cp.id + '-' + p.creatorId;
      rehomed++;
    }
    if (!p) {
      const orphan = DB.participants.find((x) =>
        x.campaignId === cp.id && x.creatorId === cr.id && !x.notionPageId);
      if (orphan) { orphan.notionPageId = row.pageId; p = orphan; adoptedRow = true; }
    }
    if (p) {
      if (adoptedRow) adopted++; else updated++;
      /* A mapped column is authoritative, and that has to include an answer
         someone has cleared. The old "ap.x || p.x" kept the previous value
         whenever the new one was empty, so a field emptied in Notion stayed
         filled here forever - which is what made the roster look stuck.
         A field with no column mapped to it is still left alone, so this
         cannot wipe something Notion was never asked about. */
      const mapped = new Set(Object.values(cp.notionMapping || {}).filter((v) => v && v !== 'skip'));
      const merge = (key, cur) => (mapped.has(key) ? (ap[key] || '') : (ap[key] || cur));

      p.fullName = merge('fullName', p.fullName);
      p.address = merge('address', p.address);
      p.contact = merge('contact', p.contact);
      p.nationality = merge('nationality', p.nationality);
      p.otherSns = merge('otherSns', p.otherSns);
      p.formNotes = merge('formNotes', p.formNotes);
      p.remark = merge('remark', p.remark);
      p.headcount = merge('headcount', p.headcount);
      if (ap.gender && cr) cr.gender = ap.gender;
      p.importedStatus = ap.statusRaw || p.importedStatus;
      /* a booking removed in Notion has to clear here too, or the calendar
         keeps an event for a visit that is no longer happening */
      const nextVisit = merge('visitAt', p.visitAt);
      if (nextVisit !== p.visitAt) { p.visitAt = nextVisit; reslotted++; }
      /* Notion is the source of truth for the pipeline stage: when someone
         is marked accepted / visited / uploaded over there, the card has to
         move here too. Only a *forward* move is applied automatically, so a
         stage someone advanced by hand in the dashboard isn't yanked back by
         a Notion row that simply hasn't been updated yet. Dropped always
         wins — a rejection in Notion should always land. */
      const wasIdx = STAGE_IDX[p.stage], nowIdx = STAGE_IDX[ap.stage];
      if (ap.stage !== p.stage && (ap.stage === 'dropped' || p.stage === 'dropped' || nowIdx > wasIdx)) {
        applyStageDates(p, ap.stage, cp);
        if (ap.stage === 'dropped') p.dropReason = ap.dropReason || p.dropReason;
        else if (p.dropReason) p.dropReason = null;
        moved++;
      }
      if (applyNotionContent(p, ap, cr)) metricsUpdated++;
    } else {
      /* only rows already claimed by a *different* submission are duplicates
         now — unclaimed ones were adopted above */
      if (DB.participants.some((x) => x.campaignId === cp.id && x.creatorId === cr.id)) { skipped++; return; }
      const np = {
        id: cp.id + '-' + cr.id, campaignId: cp.id, creatorId: cr.id, stage: ap.stage,
        source: 'Notion form', fee: 0, contactedAt: null, repliedAt: null, confirmedAt: null, shippedAt: null,
        dropReason: ap.dropReason, revisions: 0, note: ap.note,
        fullName: ap.fullName, address: ap.address, contact: ap.contact, nationality: ap.nationality,
        visitAt: ap.visitAt, arrivingDate: '', otherSns: ap.otherSns, importedStatus: ap.statusRaw,
        formNotes: ap.formNotes, remark: ap.remark || '', headcount: ap.headcount || '',
        notionPageId: row.pageId, content: null
      };
      applyStageDates(np, ap.stage, cp);
      if (ap.visitAt) reslotted++;
      if (applyNotionContent(np, ap, cr)) metricsUpdated++;
      DB.participants.push(np); newRows++;
    }
  });

  const dedupe = batch ? { mergedCreators: 0 } : mergeDuplicateCreators();
  cp.notionSyncedAt = new Date().toISOString();

  /* why no visit dates landed — three different causes, three different fixes */
  let visitWarning = null;
  if (!reslotted && data.rows.length) {
    const mappedTo = cp.notionMapping.visitAt;
    if (!mappedTo) visitWarning = 'no field mapped to “Visit date & time”';
    else if (!data.rows.some((r) => r.properties[mappedTo])) visitWarning = `“${mappedTo}” is empty for every row`;
  }

  const stats = { campaign: cp, rows: data.rows.length, newRows, updated, moved, reslotted, skipped, newCreators, adopted, metricsUpdated, rehomed, visitWarning };
  if (batch) return stats;

  notify();
  if (visitWarning) toast(`No visit dates — ${visitWarning}. Click ⚙ next to Sync to pick the column.`);
  const summary = `Synced ${data.rows.length} Notion submission${data.rows.length === 1 ? '' : 's'} — ${newRows} new, ${updated + adopted} updated` +
    (adopted ? ` (${adopted} existing roster row${adopted === 1 ? '' : 's'} linked up)` : '') +
    (rehomed ? `, ${rehomed} moved back to this campaign` : '') +
    (moved ? `, ${moved} moved stage` : '') +
    (reslotted ? `, ${reslotted} visit date${reslotted === 1 ? '' : 's'}` : '') +
    (metricsUpdated ? `, ${metricsUpdated} content/metrics` : '') +
    (skipped ? ', ' + skipped + ' skipped' : '') +
    (newCreators ? ', ' + newCreators + ' new creators' : '') +
    (dedupe.mergedCreators ? `, ${dedupe.mergedCreators} duplicate${dedupe.mergedCreators === 1 ? '' : 's'} merged` : '');
  toast(summary);
  serverSave({ force: true, silent: true }).then(() =>
    toast(SERVER.status === 'idle' ? summary + ' — saved' : summary + ' — click Save to store it on the server'));
  return stats;
}

/* Sync every campaign that has a Notion database linked. Syncing is
   otherwise per-campaign and manual, so with several live campaigns it's
   easy to update one and assume the rest followed — they don't. */
export function notionLinkedCampaigns() { return DB.campaigns.filter((c) => c.notionDatabaseId && c.notionMapping); }

export async function syncAllNotionCampaigns() {
  const list = notionLinkedCampaigns();
  if (!list.length) { toast('No campaigns are linked to a Notion database yet'); return; }

  toast(`Syncing ${list.length} campaign${list.length === 1 ? '' : 's'} from Notion…`);
  const results = [];
  for (const cp of list) {
    /* sequential on purpose: Notion rate-limits, and a half-applied
       parallel run is far harder to reason about than a slower clean one */
    try {
      await healNotionMapping(cp);
      results.push(await runNotionSync(cp, { batch: true }));
    } catch (err) {
      results.push({ campaign: cp, error: err.message });
    }
  }

  const dedupe = mergeDuplicateCreators();
  const ok = results.filter((r) => r && !r.error);
  const failed = results.filter((r) => r && r.error);
  const sum = (k) => ok.reduce((n, r) => n + (r[k] || 0), 0);
  notify();

  const summary = `Synced ${ok.length} of ${list.length} campaigns — ` +
    `${sum('newRows')} new, ${sum('updated') + sum('adopted')} updated` +
    (sum('adopted') ? ` (${sum('adopted')} existing roster rows linked up)` : '') +
    (sum('moved') ? `, ${sum('moved')} moved stage` : '') +
    (sum('reslotted') ? `, ${sum('reslotted')} visit dates` : '') +
    (sum('metricsUpdated') ? `, ${sum('metricsUpdated')} content/metrics` : '') +
    (sum('newCreators') ? `, ${sum('newCreators')} new creators` : '') +
    (dedupe.mergedCreators ? `, ${dedupe.mergedCreators} duplicates merged` : '');
  toast(summary);

  /* name the campaigns that need attention — a per-campaign problem is
     invisible in a total */
  failed.forEach((r) => toast(`${r.campaign.brand}: sync failed — ${r.error}`));
  ok.filter((r) => r.visitWarning).forEach((r) =>
    toast(`${r.campaign.brand}: no visit dates — ${r.visitWarning}`));

  serverSave({ force: true, silent: true }).then(() =>
    toast(SERVER.status === 'idle' ? summary + ' — saved' : summary + ' — click Save to store it on the server'));
}

/* A mapping saved before a field existed simply has no entry for it, and
   because *a* mapping is present the sync skips the mapping screen and
   never asks — so the new field silently stays empty forever. Fill in any
   key the saved mapping has never seen by guessing it against the live
   schema, and say which ones were added rather than doing it invisibly. */
export async function healNotionMapping(cp) {
  /* Absent *or* null: a mapping saved by an older build can carry the key
     with nothing in it, which is indistinguishable from "empty" at read
     time and just as silently broken. Only a property whose name clearly
     means this field is ever filled in, so a considered "none" for an
     unrelated column stays none. */
  const missing = NOTION_FIELD_DEFS.filter((f) => !cp.notionMapping[f.key]);
  if (!missing.length) return [];
  let props;
  try {
    const res = await fetch('/api/notion/database?id=' + encodeURIComponent(cp.notionDatabaseId));
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || ('Server responded ' + res.status));
    props = out.properties || [];
    if (out.description && !String(cp.note || '').trim()) {
      cp.notionDescription = out.description;
      cp.note = out.description;
    }
  } catch (err) {
    /* can't reach the schema — leave the mapping alone and let the sync
       itself surface the failure rather than guessing blind */
    return [];
  }
  const taken = new Set(Object.values(cp.notionMapping).filter(Boolean));
  const added = [];
  missing.forEach((f) => {
    const hit = props.find((p) => !taken.has(p.name) && guessNotionField(p.name, p.type) === f.key);
    cp.notionMapping[f.key] = hit ? hit.name : null;
    if (hit) { taken.add(hit.name); added.push(`${f.label} → “${hit.name}”`); }
  });
  return added;
}
