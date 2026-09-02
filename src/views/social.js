import { SERIES_HEX, lineChart } from '../charts/index.js';
import { kmb, num } from '../lib/format.js';
import { DB, SOCIAL_MATCH_STATUS, byCampaign, byCreator, notify, socialEngagementRate, socialEngagements, socialViewRatio } from '../model/db.js';
import { avColor, tierOf } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { avatarHtml, downloadFile, emptyState, statCard, tierPill, toCsv } from '../ui/html.js';
import { openDrawer } from '../ui/overlay.js';

/* ============================================================
   SOCIAL MEDIA — content library

   Every published post in one searchable place. The library reads
   DB.socialContent, which is the single home for a post; the roster
   row points at the same object, so nothing here is a second copy of
   numbers kept somewhere else.
   ============================================================ */
export const SOCIAL_ITEMS = [
  { id: 'library', label: 'Content', sub: 'every video, searchable' }
];
export const SOCIAL_TABS = [
  ['all', 'All'], ['matched', 'In a campaign'], ['review', 'Needs review'], ['unassigned', 'Unassigned']
];

export const socialState = {
  q: '', campaign: '', creator: '', platform: '', country: '', tier: '',
  from: '', to: '', minViews: '', minRate: '', hashtag: '', sort: 'views'
};

/* One row of the library: the post, plus the creator and campaign it
   belongs to and the figures derived from them. Derived once here so the
   table, the sort and the CSV all agree. */
export function socialRows() {
  return DB.socialContent.map((c) => {
    const cr = byCreator[c.creatorId] || {};
    const cp = byCampaign[c.campaignId] || null;
    return {
      c, cr, cp,
      handle: cr.handle || c.username || '—',
      campaignName: cp ? (cp.brand || cp.name || '') : '',
      country: cr.country || '',
      tier: cr.followers ? tierOf(cr.followers).id : '',
      published: c.publishedAt || c.postedAt || '',
      eng: socialEngagements(c),
      rate: socialEngagementRate(c),
      ratio: socialViewRatio(c, cr)
    };
  });
}

export function socialFiltered(tab) {
  const q = socialState.q.trim().toLowerCase();
  const tags = (socialState.hashtag || '').trim().toLowerCase().replace(/^#/, '');
  return socialRows().filter((r) => {
    const st = r.c.matchStatus || 'unassigned';
    if (tab === 'matched'    && !(st === 'confirmed' || st === 'auto_matched')) return false;
    if (tab === 'review'     && st !== 'suggested') return false;
    if (tab === 'unassigned' && !(st === 'unassigned' || st === 'excluded')) return false;

    if (socialState.campaign && r.c.campaignId !== socialState.campaign) return false;
    if (socialState.creator  && r.c.creatorId !== socialState.creator) return false;
    if (socialState.platform && r.c.platform !== socialState.platform) return false;
    if (socialState.country  && r.country !== socialState.country) return false;
    if (socialState.tier     && r.tier !== socialState.tier) return false;
    if (socialState.from && (!r.published || r.published < socialState.from)) return false;
    if (socialState.to   && (!r.published || r.published > socialState.to)) return false;
    if (socialState.minViews !== '' && (r.c.views || 0) < +socialState.minViews) return false;
    /* a post with no views has no rate; a minimum rate has to exclude it
       rather than treat "unknown" as zero */
    if (socialState.minRate !== '' && (r.rate == null || r.rate < +socialState.minRate)) return false;

    if (tags === '__none') { if ((r.c.hashtags || []).length) return false; }
    else if (tags === '__any') { if (!(r.c.hashtags || []).length) return false; }
    else if (tags && !(r.c.hashtags || []).some((h) => h.includes(tags))) return false;

    if (q) {
      const hay = [r.handle, r.campaignName, r.c.caption, (r.c.hashtags || []).join(' '),
                   r.c.username, r.c.url].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export const SOCIAL_SORTS = {
  views:     (a, b) => (b.c.views || 0) - (a.c.views || 0),
  eng:       (a, b) => b.eng - a.eng,
  rate:      (a, b) => (b.rate == null ? -1 : b.rate) - (a.rate == null ? -1 : a.rate),
  published: (a, b) => String(b.published).localeCompare(String(a.published)),
  creator:   (a, b) => a.handle.localeCompare(b.handle)
};

export function socialStatusPill(st) {
  const m = SOCIAL_MATCH_STATUS[st] || SOCIAL_MATCH_STATUS.unassigned;
  return `<span class="pill ${m.tone}" title="${esc(m.sub)}">${esc(m.label)}</span>`;
}

export function renderSocial(view, item, tab) {
  const rows = socialFiltered(tab || 'all').sort(SOCIAL_SORTS[socialState.sort] || SOCIAL_SORTS.views);
  const countries = [...new Set(DB.creators.map((c) => c.country).filter(Boolean))].sort();
  const platforms = [...new Set(DB.socialContent.map((c) => c.platform).filter(Boolean))].sort();
  const opts = (list, cur, label) =>
    `<option value="">${label}</option>` + list.map(([v, l]) =>
      `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

  const totalViews = rows.reduce((n, r) => n + (r.c.views || 0), 0);
  const totalEng = rows.reduce((n, r) => n + r.eng, 0);
  const measured = rows.filter((r) => r.rate != null);
  const avgRate = measured.length ? measured.reduce((n, r) => n + r.rate, 0) / measured.length : null;

  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:14px">
      ${statCard('Videos', num(rows.length), { foot: `${DB.socialContent.length} in the library` })}
      ${statCard('Views', kmb(totalViews), { foot: rows.length ? `${kmb(Math.round(totalViews / rows.length))} average` : '—' })}
      ${statCard('Engagements', kmb(totalEng), { foot: 'likes · comments · shares · saves' })}
      ${statCard('Engagement rate', avgRate == null ? '—' : avgRate.toFixed(2) + '%',
        { foot: `${measured.length} of ${rows.length} have view counts` })}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="grid g4" style="gap:10px">
        <div class="field" style="grid-column:1/-1"><label>Search</label>
          <input type="search" id="soQ" placeholder="creator, campaign, caption or #hashtag" value="${esc(socialState.q)}"/></div>
        <div class="field"><label>Campaign</label><select id="soCampaign">${
          opts(DB.campaigns.map((c) => [c.id, c.brand || c.name]), socialState.campaign, 'Any campaign')}</select></div>
        <div class="field"><label>Creator</label><select id="soCreator">${
          opts(DB.creators.filter((c) => DB.socialContent.some((x) => x.creatorId === c.id))
            .map((c) => [c.id, c.handle]), socialState.creator, 'Any creator')}</select></div>
        <div class="field"><label>Platform</label><select id="soPlatform">${
          opts(platforms.map((x) => [x, x]), socialState.platform, 'Any platform')}</select></div>
        <div class="field"><label>Country</label><select id="soCountry">${
          opts(countries.map((x) => [x, x]), socialState.country, 'Any country')}</select></div>
        <div class="field"><label>Follower tier</label><select id="soTier">${
          opts([['nano', 'Nano'], ['micro', 'Micro'], ['mid', 'Mid'], ['macro', 'Macro']], socialState.tier, 'Any tier')}</select></div>
        <div class="field"><label>Published from</label><input type="date" id="soFrom" value="${esc(socialState.from)}"/></div>
        <div class="field"><label>…until</label><input type="date" id="soTo" value="${esc(socialState.to)}"/></div>
        <div class="field"><label>Min views</label><input type="number" id="soViews" min="0" step="100" value="${esc(socialState.minViews)}"/></div>
        <div class="field"><label>Min engagement %</label><input type="number" id="soRate" min="0" step="0.1" value="${esc(socialState.minRate)}"/></div>
        <div class="field"><label>Hashtag</label>
          <input type="text" id="soTag" list="soTagList" placeholder="#vively · __any · __none" value="${esc(socialState.hashtag)}"/>
          <datalist id="soTagList">${[...new Set(DB.socialContent.flatMap((c) => c.hashtags || []))]
            .sort().map((h) => `<option value="${esc(h)}"></option>`).join('')}</datalist></div>
        <div class="field"><label>Sort by</label><select id="soSort">${
          [['views', 'Views'], ['eng', 'Engagements'], ['rate', 'Engagement rate'],
           ['published', 'Newest'], ['creator', 'Creator']]
            .map(([v, l]) => `<option value="${v}" ${socialState.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn sm" id="soClear">Clear filters</button>
        <button class="btn sm" id="soCsv">Export these (CSV)</button>
      </div>
    </div>

    ${rows.length ? `<div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:calc(100vh - 430px);overflow-y:auto">
      <table class="tbl"><thead><tr>
        <th>Creator</th><th>Campaign</th><th>Platform</th><th>Published</th>
        <th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th>
        <th class="num">Shares</th><th class="num">Saves</th>
        <th class="num">Eng. rate</th><th class="num">Views/follower</th><th>Match</th>
      </tr></thead><tbody>
      ${rows.map((r) => `<tr class="row-link" data-sc="${esc(r.c.id)}" style="cursor:pointer">
        <td><div style="display:flex;align-items:center;gap:8px">
          <span style="width:26px;height:26px;border-radius:6px;flex:0 0 auto;background:${esc(r.c.thumbTint || avColor(r.handle))}"></span>
          <span>${esc(r.handle)}${r.cr.country ? ` <span style="color:var(--text-3)">${esc(r.cr.country)}</span>` : ''}</span>
        </div></td>
        <td>${r.campaignName ? esc(r.campaignName) : '<span style="color:var(--text-3)">—</span>'}</td>
        <td>${esc(r.c.platform)}</td>
        <td>${esc(r.published || '—')}</td>
        <td class="num">${r.c.views ? num(r.c.views) : '<span style="color:var(--text-3)">—</span>'}</td>
        <td class="num">${num(r.c.likes || 0)}</td>
        <td class="num">${num(r.c.comments || 0)}</td>
        <td class="num">${num(r.c.shares || 0)}</td>
        <td class="num">${num(r.c.saves || 0)}</td>
        <td class="num">${r.rate == null ? '<span style="color:var(--text-3)">—</span>' : r.rate.toFixed(2) + '%'}</td>
        <td class="num">${r.ratio == null ? '<span style="color:var(--text-3)">—</span>' : r.ratio.toFixed(2) + '×'}</td>
        <td>${socialStatusPill(r.c.matchStatus)}</td>
      </tr>`).join('')}
      </tbody></table></div></div>`
    : emptyState('Nothing matches those filters',
        DB.socialContent.length
          ? 'Loosen a filter, or clear them all. Every video is still in the library.'
          : 'Add a content link on a creator in any campaign roster and it will appear here.',
        { icon: '▶' })}
  `;

  const bind = (id, key, ev) => { const el = $('#' + id); if (el) el.addEventListener(ev || 'change', () => {
    socialState[key] = el.value; notify();
  }); };
  bind('soQ', 'q', 'input');
  bind('soCampaign', 'campaign'); bind('soCreator', 'creator'); bind('soPlatform', 'platform');
  bind('soCountry', 'country'); bind('soTier', 'tier'); bind('soFrom', 'from'); bind('soTo', 'to');
  bind('soViews', 'minViews', 'input'); bind('soRate', 'minRate', 'input');
  bind('soTag', 'hashtag', 'input'); bind('soSort', 'sort');

  $('#soClear').addEventListener('click', () => {
    Object.assign(socialState, { q: '', campaign: '', creator: '', platform: '', country: '',
      tier: '', from: '', to: '', minViews: '', minRate: '', hashtag: '' });
    notify();
  });
  $('#soCsv').addEventListener('click', () => {
    downloadFile('vively-content.csv', toCsv(
      ['Creator', 'Country', 'Followers', 'Campaign', 'Platform', 'Published', 'URL',
       'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Engagements', 'Engagement rate %',
       'Views per follower', 'Match status', 'Match method', 'Confidence'],
      rows.map((r) => [r.handle, r.country, r.cr.followers || '', r.campaignName, r.c.platform,
        r.published, r.c.url || '', r.c.views || 0, r.c.likes || 0, r.c.comments || 0,
        r.c.shares || 0, r.c.saves || 0, r.eng,
        r.rate == null ? '' : r.rate.toFixed(2), r.ratio == null ? '' : r.ratio.toFixed(2),
        (SOCIAL_MATCH_STATUS[r.c.matchStatus] || {}).label || '', r.c.matchMethod || '',
        r.c.matchConfidence || ''])), 'text/csv');
  });
  $$('#view tr[data-sc]').forEach((tr) =>
    tr.addEventListener('click', () => showSocialContent(tr.dataset.sc)));
}

/* ---- one video, in full ------------------------------------------- */
export function showSocialContent(id) {
  const c = DB.socialContent.find((x) => x.id === id);
  if (!c) return;
  const cr = byCreator[c.creatorId] || {};
  const cp = byCampaign[c.campaignId] || null;
  const rate = socialEngagementRate(c);
  const ratio = socialViewRatio(c, cr);
  const snaps = (c.curve || []).filter((x) => x && x.at);

  openDrawer(`${avatarHtml(cr.handle || c.username || '?')} <span style="margin-left:8px">${esc(cr.handle || c.username || 'Content')}</span>`, `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${socialStatusPill(c.matchStatus)}
      <span class="pill grey">${esc(c.platform)}</span>
      <span class="pill grey">${esc(c.format || 'Reel')}</span>
      ${cr.followers ? tierPill(tierOf(cr.followers).id) : ''}
      ${c.boosted ? '<span class="pill yellow">Boosted</span>' : ''}
    </div>

    <div class="grid g4" style="margin-bottom:16px">
      ${statCard('Views', c.views ? num(c.views) : '—', { foot: c.paidViews ? `${num(c.organicViews || 0)} organic / ${num(c.paidViews)} paid` : '' })}
      ${statCard('Engagements', num(socialEngagements(c)), { foot: `${num(c.likes || 0)} · ${num(c.comments || 0)} · ${num(c.shares || 0)} · ${num(c.saves || 0)}` })}
      ${statCard('Engagement rate', rate == null ? '—' : rate.toFixed(2) + '%', { foot: rate == null ? 'no view count yet' : 'of views' })}
      ${statCard('Views per follower', ratio == null ? '—' : ratio.toFixed(2) + '×', { foot: cr.followers ? `${kmb(cr.followers)} followers` : 'no follower count' })}
    </div>

    <dl class="kv" style="margin-bottom:18px">
      <dt>Campaign</dt><dd>${cp ? `<a href="#/campaigns/${esc(cp.id)}/roster">${esc(cp.brand)} — ${esc(cp.name)}</a>` : '<span style="color:var(--text-3)">not assigned to a campaign</span>'}</dd>
      <dt>Creator</dt><dd>${esc(cr.handle || c.username || '—')}${cr.country ? ' · ' + esc(cr.country) : ''}</dd>
      <dt>Published</dt><dd>${esc(c.publishedAt || c.postedAt || '—')}</dd>
      <dt>Post</dt><dd>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(String(c.url).slice(0, 54))}…</a>` : '—'}</dd>
      ${c.platformPostId ? `<dt>Post id</dt><dd><code>${esc(c.platformPostId)}</code></dd>` : ''}
      ${c.caption ? `<dt>Caption</dt><dd style="white-space:pre-wrap">${esc(c.caption)}</dd>` : ''}
      ${(c.hashtags || []).length ? `<dt>Hashtags</dt><dd>${c.hashtags.map((h) => `<span class="tag">${esc(h)}</span>`).join(' ')}</dd>` : ''}
      ${(c.mentions || []).length ? `<dt>Mentions</dt><dd>${c.mentions.map((h) => `<span class="tag">${esc(h)}</span>`).join(' ')}</dd>` : ''}
      <dt>Reach</dt><dd>${num(c.reach || 0)} · ${num(c.profileVisits || 0)} profile visits · ${num(c.followsGained || 0)} follows · ${num(c.linkClicks || 0)} link clicks</dd>
      <dt>How it got its campaign</dt><dd>${c.matchMethod ? `${esc(c.matchMethod)} · confidence ${num(c.matchConfidence || 0)}` : '—'}</dd>
      <dt>Where the numbers came from</dt><dd>${esc(c.dataSource || 'manual')}${c.metricsAt ? ` · as of ${esc(String(c.metricsAt).slice(0, 10))}` : ''}</dd>
    </dl>

    <div class="divider"></div>
    <div class="lbl">Daily performance</div>
    ${snaps.length > 1
      ? '<div id="scCurve" style="height:180px"></div>'
      : `<div class="note" style="margin-top:8px">
           ${snaps.length === 1 ? 'One reading so far.' : 'No readings yet.'}
           Growth is drawn from daily snapshots, which are only recorded from the day
           capture is switched on — history before that cannot be reconstructed.
         </div>`}
  `, true);

  if (snaps.length > 1) {
    lineChart($('#scCurve'), {
      labels: snaps.map((x) => String(x.at).slice(5, 10)),
      series: [{ name: 'Views', values: snaps.map((x) => x.views || 0), color: SERIES_HEX[0], area: true }]
    });
  }
}
