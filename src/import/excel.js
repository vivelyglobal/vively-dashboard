/* ============================================================
   CAMPAIGN IMPORT — build a campaign from the VIVELY sheets
   Two templates: delivery (product shipped) and visit (방문).
   The sheet supplies the creator rows; project name, type and
   the commercial fields are still entered by hand.
   ============================================================ */

export const IMPORT_FIELDS = [
  { key: 'skip',        label: '— ignore —' },
  { key: 'no',          label: 'No / row number' },
  { key: 'status',      label: 'Status' },
  { key: 'message',     label: 'Message sent (text)' },
  { key: 'fullName',    label: 'Name' },
  { key: 'address',     label: 'Address' },
  { key: 'contact',     label: 'Kakao ID / phone' },
  { key: 'nationality', label: 'Nationality' },
  { key: 'visitAt',     label: 'Date & time availability' },
  { key: 'arrivingDate',label: 'Arriving date' },
  { key: 'instagram',   label: 'Instagram link' },
  { key: 'tiktok',      label: 'TikTok link' },
  { key: 'otherSns',    label: 'Other SNS' },
  { key: 'followers',   label: 'Followers' },
  { key: 'contentUrl',  label: 'Reel / content link' }
];

export const HEADER_ALIASES = {
  no:           ['no', 'number', '번호', '순번'],
  status:       ['status', '상태', '진행상태'],
  fullName:     ['full name', 'name', 'creator', 'creator name', '이름', '성함', '크리에이터'],
  address:      ['address', 'shipping address', '주소', '배송지'],
  contact:      ['kakao id / phone number', 'kakao id', 'kakao', 'phone', 'phone number', 'contact', '연락처', '카카오'],
  nationality:  ['nationality', 'country', '국적', '국가'],
  visitAt:      ['date & time availability', 'date and time availability', 'availability', 'visit date', 'visit', 'reservation', '방문일', '방문일시', '예약'],
  arrivingDate: ['arriving date', 'arrival date', 'delivery date', 'shipped date', 'shipping date', '도착일', '발송일'],
  instagram:    ['instagram link', 'instagram', 'insta', 'ig', 'ig link', '인스타', '인스타그램'],
  tiktok:       ['tiktok link', 'tiktok', 'tik tok', '틱톡'],
  otherSns:     ['other active sns (if any)', 'other active sns', 'other sns', 'other', 'sns', '기타 sns', '기타'],
  followers:    ['followers', 'follower', 'follower count', '팔로워', '팔로워수'],
  contentUrl:   ['reel (link)', 'reel link', 'reel', 'content link', 'post link', 'url', 'link', '링크', '업로드 링크']
};

/* their sheet status -> our pipeline stage */
export const STATUS_MAP = {
  '':                    { stage: 'sourced' },
  'applied':             { stage: 'sourced' },
  'waiting approval':    { stage: 'shortlisted' },
  'pending':             { stage: 'shortlisted' },
  'brand accepted':      { stage: 'confirmed' },
  'accepted':            { stage: 'confirmed' },
  'confirmation sent':   { stage: 'confirmed' },
  'confirmed':           { stage: 'confirmed' },
  'contacted':           { stage: 'contacted' },
  'replied':             { stage: 'replied' },
  'waiting upload':      { stage: 'shipped' },
  'shipped':             { stage: 'shipped' },
  'visited':             { stage: 'shipped' },
  'uploaded':            { stage: 'live' },
  'posted':              { stage: 'live' },
  'live':                { stage: 'live' },
  'in review':           { stage: 'review' },
  'brand rejected':      { stage: 'dropped', reason: 'Brand rejected' },
  'rejected':            { stage: 'dropped', reason: 'Rejected' },
  'reject':              { stage: 'dropped', reason: 'Rejected' },
  'cancelled':           { stage: 'dropped', reason: 'Cancelled' },
  'canceled':            { stage: 'dropped', reason: 'Cancelled' },
  'no show':             { stage: 'dropped', reason: 'No show' },
  'ghosted':             { stage: 'dropped', reason: 'Ghosted' }
};

export const TEMPLATES = {
  delivery: {
    id: 'delivery',
    label: 'Delivery — product shipped',
    sheetName: 'Creator List',
    columns: ['Status', 'Arriving Date', 'Reel (Link)', 'Full Name', 'Address', 'Kakao ID / Phone Number',
              'Nationality', 'Date & Time Availability', 'Instagram Link', 'Tiktok Link', 'Other Active SNS (if any)', 'Followers'],
    statuses: ['Waiting Approval', 'Brand Accepted', 'Brand Rejected', 'Waiting Upload', 'Uploaded', 'Cancelled'],
    note: 'Address and Kakao ID / phone are required before you can ship. Arriving Date is filled in when the parcel lands.'
  },
  visit: {
    id: 'visit',
    label: 'Store visit (방문)',
    sheetName: 'Creator List',
    columns: ['No', 'Status', 'Message', 'Name', 'Date & Time Availability', 'Nationality',
              'Instagram Link', 'Followers', 'Other SNS', 'Reel (Link)'],
    statuses: ['Waiting Approval', 'Confirmation Sent', 'Reject', 'Visited', 'Uploaded', 'Cancelled'],
    note: 'No address needed. Date & Time Availability is the booked slot — one row per creator per visit.'
  }
};

export const normHeader = (h) => String(h == null ? '' : h).toLowerCase().replace(/[\s_\-().]+/g, ' ').trim();

export function guessField(header, colIdx, sampleValues) {
  const h = normHeader(header);
  if (h) {
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => h === a)) return key;
    }
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => h.includes(a) || a.includes(h))) return key;
    }
  }
  /* the visit sheet has an unlabelled column holding the message that was sent */
  const long = sampleValues.filter((v) => typeof v === 'string' && v.length > 60).length;
  if (!h && long >= 2) return 'message';
  return 'skip';
}

export function detectTemplate(mapping) {
  const keys = new Set(Object.values(mapping));
  if (keys.has('address') || keys.has('arrivingDate')) return 'delivery';
  return 'visit';
}

/* ------------------------------ value parsing ------------------------------ */
export function handleFromUrl(url, platform) {
  if (!url) return null;
  const s = String(url).trim();
  let m = s.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (m) return { handle: '@' + m[1], platform: 'TikTok' };
  m = s.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m && !/^(p|reel|reels|stories|explore)$/i.test(m[1])) return { handle: '@' + m[1], platform: 'Instagram' };
  m = s.match(/youtube\.com\/@([^/?#\s]+)/i);
  if (m) return { handle: '@' + m[1], platform: 'YouTube' };
  if (/^@?[\w.]{2,40}$/.test(s)) return { handle: s.startsWith('@') ? s : '@' + s, platform: platform || 'Instagram' };
  return null;
}

export function parseFollowers(v) {
  if (v == null || v === '') return { value: 0, warn: null };
  if (typeof v === 'number') {
    if (v > 0 && v < 100) return { value: Math.round(v * 1000), warn: 'read ' + v + ' as ' + Math.round(v * 1000) };
    return { value: Math.round(v), warn: null };
  }
  const s = String(v).replace(/[, ]/g, '').toLowerCase();
  let m = s.match(/^([\d.]+)만$/); if (m) return { value: Math.round(parseFloat(m[1]) * 10000), warn: null };
  m = s.match(/^([\d.]+)k$/);      if (m) return { value: Math.round(parseFloat(m[1]) * 1000), warn: null };
  m = s.match(/^([\d.]+)m$/);      if (m) return { value: Math.round(parseFloat(m[1]) * 1e6), warn: null };
  const n = parseFloat(s);
  if (isNaN(n)) return { value: 0, warn: 'could not read "' + v + '"' };
  if (n > 0 && n < 100) return { value: Math.round(n * 1000), warn: 'read ' + n + ' as ' + Math.round(n * 1000) };
  return { value: Math.round(n), warn: null };
}

export function parseDateCell(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

export const NATIONALITY_TO_COUNTRY = {
  korea: 'Korea', 'south korea': 'Korea', korean: 'Korea', 한국: 'Korea', 대한민국: 'Korea',
  japan: 'Japan', japanese: 'Japan', 일본: 'Japan', 日本: 'Japan',
  vietnam: 'Vietnam', vietnamese: 'Vietnam', 베트남: 'Vietnam',
  indonesia: 'Indonesia', indonesian: 'Indonesia', 인도네시아: 'Indonesia',
  thailand: 'Thailand', thai: 'Thailand', 태국: 'Thailand',
  singapore: 'Singapore', singaporean: 'Singapore',
  malaysia: 'Malaysia', malaysian: 'Malaysia',
  philippines: 'Philippines', filipino: 'Philippines', philippine: 'Philippines',
  taiwan: 'Taiwan', taiwanese: 'Taiwan',
  'united states': 'USA', usa: 'USA', american: 'USA', us: 'USA'
};
export const countryOf = (nat) => {
  if (!nat) return 'Other';
  const k = String(nat).trim().toLowerCase();
  return NATIONALITY_TO_COUNTRY[k] || String(nat).trim();
};

/* --------------------------- parse sheet into rows --------------------------- */
export function parseImportRows(rows, mapping) {
  const idx = {};
  Object.entries(mapping).forEach(([ci, key]) => { if (key !== 'skip') idx[key] = +ci; });
  const get = (row, key) => (idx[key] == null ? null : row[idx[key]]);

  const out = [];
  rows.forEach((row, i) => {
    if (!row || row.every((c) => c == null || c === '')) return;
    const igRaw = get(row, 'instagram');
    const ttRaw = get(row, 'tiktok');
    const id1 = handleFromUrl(igRaw, 'Instagram');
    const id2 = handleFromUrl(ttRaw, 'TikTok');
    const ident = id1 || id2;
    const nameRaw = get(row, 'fullName');
    const statusRaw = String(get(row, 'status') || '').trim();
    const mapped = STATUS_MAP[statusRaw.toLowerCase()] || null;
    const fol = parseFollowers(get(row, 'followers'));
    const issues = [];

    if (!ident && !nameRaw) return; /* genuinely empty row */
    if (!ident) issues.push('no Instagram / TikTok link — cannot match a creator');
    if (statusRaw && !mapped) issues.push(`status “${statusRaw}” not recognised, treated as Sourced`);
    if (fol.warn) issues.push('followers ' + fol.warn);

    const stage = (mapped || { stage: 'sourced' }).stage;
    if (stage === 'shipped' && idx.address != null && !get(row, 'address')) issues.push('marked for shipping but no address');

    out.push({
      rowNo: i + 2,
      handle: ident ? ident.handle : null,
      platform: ident ? ident.platform : 'Instagram',
      fullName: nameRaw ? String(nameRaw).trim() : (ident ? ident.handle : ''),
      address: get(row, 'address') ? String(get(row, 'address')).trim() : '',
      contact: get(row, 'contact') ? String(get(row, 'contact')).trim() : '',
      nationality: get(row, 'nationality') ? String(get(row, 'nationality')).trim() : '',
      visitAt: parseDateCell(get(row, 'visitAt')),
      arrivingDate: parseDateCell(get(row, 'arrivingDate')),
      instagram: igRaw ? String(igRaw).trim() : '',
      tiktok: ttRaw ? String(ttRaw).trim() : '',
      otherSns: get(row, 'otherSns') ? String(get(row, 'otherSns')).trim() : '',
      contentUrl: get(row, 'contentUrl') ? String(get(row, 'contentUrl')).trim() : '',
      message: get(row, 'message') ? String(get(row, 'message')).trim() : '',
      followers: fol.value,
      statusRaw,
      stage,
      dropReason: (mapped || {}).reason || (stage === 'dropped' ? 'Rejected' : null),
      issues
    });
  });
  return out;
}
