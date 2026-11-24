import { normHandle } from './creators.js';
import { STAGES, STAGE_IDX, stageOf } from './vocab.js';

/* ============================================================
   BRAND SHEET EXPORT — one campaign's creator list in the layout
   of the founder's brand-sheet template, as an .xlsx.
   Pure functions: nothing here reads DB, DOM or the network, so
   the privacy rules below can be tested on plain objects.

   Two modes. 'brand' (the default) leaves out every column that
   can carry personal data, and shows the creator NAME and the
   NATIONALITY only when staff switched those on. 'internal' is the
   full template including address and phone; it refuses to build
   unless the caller passes confirmInternal: true.
   Column names are the template's own: the date write-back finds
   its columns by header text, so these must not be reworded.
   ============================================================ */
export const BRAND_SHEET_HEADERS = [
  '#', '브랜드 의견', 'Instagram', '선택하는 기준', '크리에이터', '국적', 'IG 팔로워수', 'VIVELY 의견',
  '캠페인', 'Message Accepted', '성별', 'Address', 'Phone Number', 'Secondary Usage', '메시지',
  'Replied Confirmed', 'Visiting Date', 'Posted Date', 'Reminder for Brand', 'Reminder to Creator',
  'Status', 'Submission time', 'T&C', 'Text', 'Type', 'Type of Content', '💬 DM Creator on D-Day'
];
/* never in a brand-safe file, whatever the settings say */
export const BRAND_SHEET_PRIVATE = ['성별', 'Address', 'Phone Number', 'Secondary Usage', '메시지'];
/* only when staff switched the matching setting on */
export const BRAND_SHEET_OPTIONAL = { '크리에이터': 'showNames', '국적': 'showNationality' };
export const BRAND_SHEET_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* The three tick-boxes of the export drawer. They live in this browser only
   (localStorage, own key) and are NOT part of the workspace: ticking a box or
   downloading must never trigger the workspace save or the Sheet push, so
   nothing here touches SETTINGS or persist(). Only a real true counts. */
export const BRAND_SHEET_OPTS_KEY = 'vively.brandSheetOpts.v1';
export function loadBrandSheetOptions(storage) {
  const out = { showNames: false, showNationality: false, includeRejected: false };
  try {
    const o = JSON.parse(storage.getItem(BRAND_SHEET_OPTS_KEY) || '{}');
    Object.keys(out).forEach((k) => { out[k] = !!o && o[k] === true; });
  } catch (e) { /* no storage or bad JSON: everything stays off */ }
  return out;
}
export function saveBrandSheetOptions(storage, opts) {
  const o = opts || {};
  try {
    storage.setItem(BRAND_SHEET_OPTS_KEY, JSON.stringify({
      showNames: o.showNames === true, showNationality: o.showNationality === true, includeRejected: o.includeRejected === true
    }));
    return true;
  } catch (e) { return false; }
}

/* Status column of the BRAND-SAFE file: the dashboard's own stage label only.
   Imported Notion status text is free text and may hold internal remarks, so it
   never goes to a brand. Anything that is not a known stage gets a neutral label. */
export const BRAND_SHEET_NEUTRAL_STATUS = 'In progress';
export function brandSheetStatusLabel(stage) {
  const s = STAGES.find((x) => x.id === stage);
  return s ? s.label : BRAND_SHEET_NEUTRAL_STATUS;
}

/* Excel tab names: at most 31 characters, none of [ ] : * ? / \, no control
   characters, and no apostrophe at either end (dropped everywhere here). */
export function brandSheetTabName(raw, fallback) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/g, ' ')
    .replace(/[\[\]:*?\/\\'&<>"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 31) s = s.slice(0, 31);
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);   /* never cut a surrogate pair in half */
  s = s.trim();
  return s || fallback || 'Campaign';
}

/* A cell that starts with = + - @ (or a tab / carriage return) can run as a
   formula when the file is opened or re-saved as CSV, so it gets a leading
   apostrophe. Control characters that are illegal in XML are dropped so the
   file always opens. */
export function brandSheetSafeCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  let s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, '');
  if (s.length > 2000) s = s.slice(0, 2000);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

/* "Seongsu store: Oct 17" / "Hongdae store: Oct 27 17.30" / "Oct 17" (no store).
   Same text the date write-back puts in the Visiting Date column.
   brandSheetFormatVisit is the one place that lays the text out; the label
   it gets is already final. */
export function brandSheetFormatVisit(confirmedVisitAt, label) {
  const raw = String(confirmedVisitAt == null ? '' : confirmedVisitAt).trim();
  if (!raw) return '';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return raw;
  const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return raw;
  const time = m[4] !== undefined ? String(+m[4]).padStart(2, '0') + '.' + m[5] : '';
  const when = BRAND_SHEET_MONTHS[mo - 1] + ' ' + d + (time ? ' ' + time : '');
  return label ? label + ': ' + when : when;
}
/* control characters and a leading = + - @ removed, 60 characters at most */
export function brandSheetCleanName(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[=+\-@\s]+/, '').trim().slice(0, 60);
}
/* LEGACY: a short venue name gets the word "store" added once:
   'Seongsu' / 'Seongsu store' -> "Seongsu store: Oct 17" */
export function brandSheetVisitText(confirmedVisitAt, storeName) {
  const label = brandSheetCleanName(storeName).replace(/\s+store$/i, '').trim();
  return brandSheetFormatVisit(confirmedVisitAt, label ? label + ' store' : '');
}
/* STORE NAME rule (founder decision 2026-11-24): the stored name is used as
   written, "<Store name>: <Mon D> <HH.MM>", and the word "store" is never
   added. "Seongsu store" -> "Seongsu store: Oct 17"; "UH Cell Gangnam 12" ->
   "UH Cell Gangnam 12: Oct 17". Same rule as server/date-writeback.js. */
export function brandSheetVisitTextFor(confirmedVisitAt, storeName) {
  return brandSheetFormatVisit(confirmedVisitAt, brandSheetCleanName(storeName));
}
/* the store name of one creator row: the participant's own, else the
   campaign's, else the campaign name (the default). p may be null: then it is
   the campaign-level name. visitStore is the older field name, still read. */
export function brandSheetStoreName(p, cp) {
  const pick = (o) => brandSheetCleanName(o && (o.storeName || o.visitStore));
  return pick(p) || pick(cp) || brandSheetCleanName(cp && cp.name);
}

export function brandSheetProfileUrl(cr) {
  const h = normHandle(cr && cr.handle).replace(/[^a-z0-9._\-]/g, '');
  if (!h) return '';
  const pf = String((cr && cr.platform) || 'Instagram').toLowerCase();
  if (pf === 'tiktok') return 'https://www.tiktok.com/@' + h;
  if (pf === 'youtube') return 'https://www.youtube.com/@' + h;
  return 'https://www.instagram.com/' + h + '/';
}

/* which block of the sheet a creator belongs in: 'confirmed' (listed first),
   'standby' (sent to the brand, no answer yet), 'rejected' (brand said no),
   or null (not part of a brand sheet: not yet put to the brand, or dropped
   for another reason) */
export function brandSheetBucket(p) {
  if (!p) return null;
  if (p.stage === 'dropped') return /^brand\s*rejected$/i.test(String(p.dropReason || '').trim()) ? 'rejected' : null;
  if (STAGE_IDX[p.stage] >= STAGE_IDX.confirmed) return 'confirmed';
  if (p.stage === 'shortlisted') return 'standby';
  return null;
}

export function brandSheetFileName(campaignName, mode, date) {
  let base = String(campaignName || '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]+/gu, ' ')
    .replace(/\s+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 60);
  if (!base) base = 'campaign';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  return (mode === 'internal' ? 'INTERNAL_' : '') + base + '_' + d + '.xlsx';
}

/* opts: { cp, participants, creators (id -> creator), mode: 'brand'|'internal',
           confirmInternal, showNames, showNationality, includeRejected, date }
   -> { mode, headers, rows (header row first, STANDBY row between the blocks),
        sheetName, filename, counts } */
export function buildBrandSheet(opts) {
  const o = opts || {};
  const mode = o.mode === 'internal' ? 'internal' : 'brand';
  if (mode === 'internal' && o.confirmInternal !== true)
    throw new Error('The internal sheet contains addresses and phone numbers and needs an explicit confirmation.');
  const cp = o.cp || {};
  const creators = o.creators || {};
  const headers = BRAND_SHEET_HEADERS.filter((h) => {
    if (mode === 'internal') return true;
    if (BRAND_SHEET_PRIVATE.includes(h)) return false;
    const gate = BRAND_SHEET_OPTIONAL[h];
    return gate ? o[gate] === true : true;
  });

  /* brand-rejected rows go to a brand only when staff ticked "Include rejected";
     internal mode keeps them as before. Creators who declined themselves are
     never in the file (brandSheetBucket gives them null). */
  const withRejected = mode === 'internal' || o.includeRejected === true;
  const blocks = { confirmed: [], standby: [], rejected: [] };
  let rejectedHidden = 0;
  (o.participants || []).forEach((p) => {
    const b = brandSheetBucket(p);
    const cr = creators[p && p.creatorId];
    if (!b || !cr) return;
    if (b === 'rejected' && !withRejected) { rejectedHidden++; return; }
    blocks[b].push({ p, cr, b });
  });
  /* store name only from stored data on the creator row or the campaign (the
     campaign's own name when its store name is empty), never from what the
     Booking tab happened to load, so the same campaign always gives the same
     text. Counted as missing only when the creator row, the campaign's store
     name and the campaign name are all empty. */
  const storeOf = (p) => brandSheetStoreName(p, cp);
  let missingStore = 0;

  const dt = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 16).replace('T', ' ') : ''; };
  const rowOf = (item, n) => {
    const { p, cr, b } = item;
    const idx = STAGE_IDX[p.stage];
    const c = p.content || null;
    const v = {
      '#': n,
      '브랜드 의견': b === 'confirmed' ? 'Accepted' : b === 'rejected' ? 'Rejected' : '',
      'Instagram': brandSheetProfileUrl(cr),
      '선택하는 기준': '',
      '크리에이터': p.fullName || cr.name || '',
      '국적': p.nationality || cr.nationality || '',
      'IG 팔로워수': Number.isFinite(+cr.followers) && +cr.followers > 0 ? +cr.followers : '',
      'VIVELY 의견': b === 'confirmed' ? 'Confirmed' : 'Optional',
      '캠페인': cp.name || cp.brand || '',
      'Message Accepted': (p.stage === 'dropped' ? !!p.repliedAt || b === 'rejected' : idx >= STAGE_IDX.replied) ? 'TRUE' : 'FALSE',
      '성별': cr.gender || '',
      'Address': p.address || cr.address || '',
      'Phone Number': p.contact || cr.contact || '',
      'Secondary Usage': '',
      '메시지': p.message || '',
      'Replied Confirmed': b === 'confirmed' ? 'TRUE' : 'FALSE',
      'Visiting Date': (() => {
        if (!String(p.confirmedVisitAt || '').trim()) return '';
        const st = storeOf(p);
        if (!st) missingStore++;
        return brandSheetVisitTextFor(p.confirmedVisitAt, st);
      })(),
      'Posted Date': c ? String(c.postedAt || c.publishedAt || '') : '',
      'Reminder for Brand': '',
      'Reminder to Creator': '',
      'Status': mode === 'internal' ? (p.importedStatus || (stageOf(p.stage) || {}).label || '') : brandSheetStatusLabel(p.stage),
      'Submission time': dt(p.appliedAt),
      'T&C': '', 'Text': '', 'Type': '',
      'Type of Content': c ? String(c.format || '') : '',
      '💬 DM Creator on D-Day': ''
    };
    return headers.map((h) => brandSheetSafeCell(v[h]));
  };

  const rows = [headers.slice()];
  let n = 0;
  blocks.confirmed.forEach((it) => rows.push(rowOf(it, ++n)));
  const standby = blocks.standby.concat(blocks.rejected);
  if (standby.length) {
    const sep = headers.map(() => '');
    sep[0] = 'STANDBY';
    rows.push(sep);
    standby.forEach((it) => rows.push(rowOf(it, ++n)));
  }
  const sheetName = brandSheetTabName((mode === 'internal' ? 'INTERNAL ' : '') + String(cp.name || cp.brand || 'Campaign'), mode === 'internal' ? 'INTERNAL' : 'Campaign');
  return {
    mode, headers, rows, sheetName,
    filename: brandSheetFileName(cp.name || cp.brand, mode, o.date),
    counts: { confirmed: blocks.confirmed.length, standby: blocks.standby.length, rejected: blocks.rejected.length, rejectedHidden, missingStore }
  };
}
