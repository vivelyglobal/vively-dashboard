import { DB, byCampaign, byCreator } from '../model/db.js';

/* ============================================================
   PARTNER VIEW

   SPLABAB brings the brands; we deliver the seeding. Their point
   of contact needs to see progress as it happens — who is coming,
   when, and what went up — without a login, without a spreadsheet
   anyone has to remember to re-send, and without being able to
   change anything.

   So: one unguessable link per partner, read from the same
   database the dashboard reads, scoped to that partner's
   campaigns. Live because it is the same data, not because
   somebody exported it recently.

   What deliberately never crosses to that page: bank details,
   internal notes, fees, and every campaign that is not theirs.
   ============================================================ */

/* Their Notion form has nine statuses; a partner needs six, plus the
   one that means "this is sitting with you". Waiting Approval is that
   one — the creator has been sent for brand approval and nothing moves
   until SPLABAB answers. Folding it into "Contacted" would hide the
   only column the POC can actually act on. */
export const PARTNER_STATUS = {
  'waiting approval': { key: 'waiting',   ko: '승인 대기',   en: 'Waiting Approval', tone: 'amber', theirs: true },
  'brand accepted':   { key: 'confirmed', ko: '확정',        en: 'Confirmed',        tone: 'green' },
  'confirmed':        { key: 'confirmed', ko: '확정',        en: 'Confirmed',        tone: 'green' },
  'brand rejected':   { key: 'rejected',  ko: '브랜드 거절', en: 'Brand Rejected',   tone: 'red' },
  'declined':         { key: 'refused',   ko: '거절',        en: 'Refused',          tone: 'grey' },
  'cancelled':        { key: 'refused',   ko: '거절',        en: 'Refused',          tone: 'grey' },
  'canceled':         { key: 'refused',   ko: '거절',        en: 'Refused',          tone: 'grey' },
  're-schedule':      { key: 'waitupload',ko: '업로드 대기', en: 'Waiting For upload', tone: 'blue' },
  'waiting upload':   { key: 'waitupload',ko: '업로드 대기', en: 'Waiting For upload', tone: 'blue' },
  'uploaded':         { key: 'uploaded',  ko: '업로드 완료', en: 'Uploaded',         tone: 'green' }
};

/* Rows that never came from a Notion form still need a status, so the
   pipeline stage maps onto the same six. */
export const STAGE_TO_PARTNER = {
  sourced:     { key: 'contacted', ko: '컨택',        en: 'Contacted',          tone: 'grey' },
  contacted:   { key: 'contacted', ko: '컨택',        en: 'Contacted',          tone: 'grey' },
  replied:     { key: 'contacted', ko: '컨택',        en: 'Contacted',          tone: 'grey' },
  shortlisted: { key: 'waiting',   ko: '승인 대기',   en: 'Waiting Approval',   tone: 'amber', theirs: true },
  confirmed:   { key: 'confirmed', ko: '확정',        en: 'Confirmed',          tone: 'green' },
  shipped:     { key: 'waitupload',ko: '업로드 대기', en: 'Waiting For upload', tone: 'blue' },
  submitted:   { key: 'waitupload',ko: '업로드 대기', en: 'Waiting For upload', tone: 'blue' },
  review:      { key: 'waitupload',ko: '업로드 대기', en: 'Waiting For upload', tone: 'blue' },
  live:        { key: 'uploaded',  ko: '업로드 완료', en: 'Uploaded',           tone: 'green' },
  dropped:     { key: 'refused',   ko: '거절',        en: 'Refused',            tone: 'grey' }
};

export function partnerStatus(p) {
  /* the exact word from their own Notion form wins where there is one —
     no reason to show a partner a re-derived approximation */
  const raw = String(p.importedStatus || '').trim().toLowerCase();
  if (raw && PARTNER_STATUS[raw]) return PARTNER_STATUS[raw];
  if (raw === 'brand rejected' || /brand.*reject/.test(raw)) return PARTNER_STATUS['brand rejected'];
  if (p.stage === 'dropped' && /brand/i.test(p.dropReason || '')) return PARTNER_STATUS['brand rejected'];
  return STAGE_TO_PARTNER[p.stage] || STAGE_TO_PARTNER.contacted;
}

export const partnersInUse = () => [...new Set(DB.campaigns.map((c) => c.partner).filter(Boolean))].sort();

/* the rows one partner is allowed to see, in the shape their POC asked for */
export function partnerRows(partner) {
  const camps = DB.campaigns.filter((c) => (c.partner || '') === partner);
  const ids = new Set(camps.map((c) => c.id));
  /* mirrors the server: a creator awaiting brand approval is not shown */
  return DB.participants.filter((p) => ids.has(p.campaignId))
    .filter((p) => !partnerStatus(p).theirs)
    .map((p) => {
    const cr = byCreator[p.creatorId] || {};
    const cp = byCampaign[p.campaignId] || {};
    const st = partnerStatus(p);
    const slot = String(p.visitAt || '').trim();
    const m = slot.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/);
    return {
      pid: p.id,
      campaign: cp.brand || '',
      campaignId: cp.id,
      creator: p.fullName || cr.name || cr.handle || '',
      handle: cr.handle || '',
      igUrl: cr.handle ? 'https://www.instagram.com/' + String(cr.handle).replace(/^@/, '') + '/' : '',
      visitDate: m ? m[1] : '',
      visitTime: m && m[2] ? m[2] : '',
      email: cr.email || '',
      status: st,
      gender: cr.gender || '',
      followers: cr.followers || 0,
      remark: p.remark || '',
      contentUrl: (p.content && p.content.url) || '',
      nationality: p.nationality || cr.nationality || cr.country || '',
      /* the creator's own answer to the form's Notes question. p.note is a
         DIFFERENT field — the private one the drawer calls "Internal note",
         which people have been typing private things into for months and
         which must never appear here. */
      notes: p.formNotes || '',
      otherSns: p.otherSns || ''
    };
  }).sort((a, b) => (a.visitDate || '9999').localeCompare(b.visitDate || '9999') ||
                    (a.visitTime || '').localeCompare(b.visitTime || '') ||
                    a.creator.localeCompare(b.creator));
}
