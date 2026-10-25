import { parseHash } from '../app/routes.js';
import { fitHeight, funnelView, lineChart, splitBar } from '../charts/index.js';
import { DAY, TODAY, iso } from '../lib/dates.js';
import { engagementsOf, kmb, money2, num, pct, won, wonK } from '../lib/format.js';
import { DB, byCampaign, byCreator, notify, setContentUrl } from '../model/db.js';
import { campaignStats, dailySeries, funnelOf, partsOf, portfolioStats, viralScore } from '../model/stats.js';
import { STAGE_IDX } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { copyText, downloadFile, emptyState, flaggedOnRoster, statCard, statusPill, toCsv, whoHtml } from '../ui/html.js';
import { toast } from '../ui/overlay.js';
import { maskAccount, moveStage, showParticipant } from './campaigns.js';
import { DESK, kstToday, loadDesk } from './desk.js';
import { POSTS_IN, chaseMessage, loadPostsIn, markPaid, payInfo, plannerRow, postedState, reminderMessage, setAttendance, settlePostIn, snoozeToday, todayCounts, todayItems } from './planner.js';

/* ============================================================
   VIEW — OVERVIEW  (layer 2 items × layer 3 tabs)
   ============================================================ */
export const state = {
  range: 30,
  creatorFilters: { q: '', tier: '', cat: '', country: '', platform: '', worked: '' },
  boardMode: 'board',
  msgTone: 'friendly',
  msgLang: 'en',
  panelQ: '',
  calMonth: null,      /* which month the visit calendar is showing */
  calCampaign: '',     /* '' = every campaign */
  calSeededFor: null   /* scope the month was auto-picked for */
};

export function activeCampaigns() { return DB.campaigns.filter((c) => c.status !== 'wrapped'); }

export function alertsList() {
  const out = [];
  const push = (sev, kind, title, sub, href) => out.push({ sev, kind, title, sub, href });

  activeCampaigns().forEach((cp) => {
    const ps = partsOf(cp.id);
    const stale = ps.filter((p) => p.stage === 'contacted' && p.contactedAt && (TODAY - new Date(p.contactedAt)) / DAY > 7);
    if (stale.length) push('warning', 'chasing', `${stale.length} creators un-answered for 7+ days`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);

    const unshipped = ps.filter((p) => p.stage === 'confirmed' && p.confirmedAt && (TODAY - new Date(p.confirmedAt)) / DAY > 5);
    if (unshipped.length) push('serious', 'chasing', `${unshipped.length} confirmed creators not shipped yet`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);

    const lateContent = ps.filter((p) => p.stage === 'shipped' && p.shippedAt && (TODAY - new Date(p.shippedAt)) / DAY > 14);
    if (lateContent.length) push('critical', 'chasing', `${lateContent.length} shipped but no content after 14 days`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);

    const inReview = ps.filter((p) => p.stage === 'review' || p.stage === 'submitted');
    if (inReview.length >= 3) push('warning', 'chasing', `${inReview.length} drafts waiting on review`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/content`);

    /* A blacklisted creator on an active campaign is a mistake somebody
       has to undo, not a number to watch — so it is said here as well as
       on the roster itself. */
    const flagged = flaggedOnRoster(cp.id);
    const blockedOn = flagged.filter((x) => x.cr.flag === 'blocked');
    const cautionOn = flagged.filter((x) => x.cr.flag === 'caution');
    if (blockedOn.length) {
      push('critical', 'flag', `${blockedOn.length} blacklisted creator${blockedOn.length === 1 ? '' : 's'} on this roster`,
        `${cp.brand} · ${blockedOn.slice(0, 3).map((x) => x.cr.handle).join(', ')}${blockedOn.length > 3 ? ' and more' : ''}`,
        `#/campaigns/${cp.id}/roster`);
    }
    if (cautionOn.length) {
      push('warning', 'flag', `${cautionOn.length} creator${cautionOn.length === 1 ? '' : 's'} marked caution on this roster`,
        `${cp.brand} · ${cautionOn.slice(0, 3).map((x) => x.cr.handle).join(', ')}${cautionOn.length > 3 ? ' and more' : ''}`,
        `#/campaigns/${cp.id}/roster`);
    }

    const s = campaignStats(cp);
    const daysToStart = Math.round((new Date(cp.start) - TODAY) / DAY);
    if (daysToStart > -3 && daysToStart < 8 && s.confirmed < cp.targetCreators * 0.7)
      push('critical', 'chasing', `Only ${s.confirmed}/${cp.targetCreators} confirmed, starts ${daysToStart <= 0 ? 'already' : 'in ' + daysToStart + 'd'}`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);
  });

  DB.participants.filter((p) => p.content && p.stage === 'live' && viralScore(p) >= 5).slice(0, 8).forEach((p) => {
    const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId];
    push('good', 'wins', `${cr.handle} is outperforming — ${kmb(p.content.views)} views`, `${cp.brand} · ${viralScore(p).toFixed(1)}× their baseline · worth boosting`, `#/campaigns/${cp.id}/performance`);
  });

  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

export const OVERVIEW_ITEMS = [
  { id: 'summary',   label: 'Summary',         sub: 'KPIs and the trend' },
  { id: 'attention', label: 'Needs attention',  sub: 'what to chase today' },
  { id: 'pipeline',  label: 'Pipeline',         sub: 'outreach funnel' },
  { id: 'content',   label: 'Top content',      sub: 'best performing posts' }
];
export const OVERVIEW_TABS = {
  summary:   [['views', 'Views'], ['engagement', 'Engagement'], ['cost', 'Cost']],
  attention: [['all', 'All'], ['critical', 'Urgent'], ['chasing', 'To chase'], ['wins', 'Wins']],
  pipeline:  [['funnel', 'Funnel'], ['conversion', 'Stage conversion'], ['status', 'Campaign status']],
  content:   [['viral', 'By viral score'], ['views', 'By views'], ['comments', 'By comments']]
};

export function rangeSeg() {
  return `<div class="seg no-print" id="rangeSeg">${[7, 30, 90].map((d) => `<button data-r="${d}" class="${state.range === d ? 'active' : ''}">${d}d</button>`).join('')}</div>`;
}
export function wireRange() {
  const el = $('#rangeSeg'); if (!el) return;
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.range = +b.dataset.r; notify(); } });
}

/* ============================================================
   VIEW — TODAY
   The page the dashboard opens on: todayItems(), grouped by how soon,
   with the action for each one on its own row. Copying a reminder,
   marking a visit, recording a payment — done here, without opening
   the campaign it belongs to.
   ============================================================ */
export const TODAY_VIEW = { deskAsked: false, postsAsked: false };
export const TODAY_GROUPS = [['now', 'Needs you now'], ['todo', 'To do'], ['soon', 'Coming up']];
export const TODAY_KIND = { blocked: 'Flag', caution: 'Flag', send_link: 'Booking', nudge_link: 'Booking', remind: 'Visit', attend: 'Visit',
  chase: 'Content', ship: 'Shipping', review: 'Content', pay: 'Payment', apply: 'Applications', behind: 'Campaign',
  desk: 'Desk', post_in: 'Post link' };
export const TODAY_ACT = { open: 'Open', booking: 'Send link', snooze: 'Later', remind: 'Copy reminder', done: 'Done',
  came: 'Came', noshow: 'No-show', chase: 'Copy chase message', addlink: 'Add post', content: 'Review', paid: 'Mark paid',
  planner: 'Review', roster: 'Open roster', desk: 'Open Desk', accept: 'Accept', view: 'View', reject: 'Not this' };
export const TODAY_PRIMARY = new Set(['accept', 'booking', 'remind', 'came', 'chase', 'content', 'paid', 'planner', 'desk', 'open', 'roster']);

export function ensureTodayStyles() {
  if (document.getElementById('tdCss')) return;
  const s = document.createElement('style');
  s.id = 'tdCss';
  s.textContent = `
  .td-wrap{max-width:980px}
  .td-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
  .td-head h2{margin:0;font-size:22px;font-weight:650;letter-spacing:-.025em}
  .td-head .d{color:var(--text-3);font-size:13px}
  .td-head select{width:auto;padding:6px 30px 6px 10px;font-size:12.5px}
  .td-sum{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
  .td-chip{display:flex;align-items:baseline;gap:7px;padding:10px 14px;border-radius:var(--r-lg);
    background:var(--surface);border:1px solid var(--line);min-width:130px}
  .td-chip b{font-size:22px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .td-chip span{font-size:12.5px;color:var(--text-3)}
  .td-chip.now b{color:var(--critical)}
  .td-group{margin-bottom:26px}
  .td-group h3{font-size:13px;font-weight:600;color:var(--text-2);margin:0 0 8px;display:flex;gap:8px;align-items:center}
  .td-group h3 .n{color:var(--text-3);font-weight:500}
  .td-list{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden}
  .td-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 14px;
    border-top:1px solid var(--line)}
  .td-row:first-child{border-top:0}
  .td-row .dot{width:8px;height:8px;border-radius:50%;background:var(--text-3)}
  .td-row.now .dot{background:var(--critical)}
  .td-row.todo .dot{background:var(--warning)}
  .td-row.soon .dot{background:var(--blue)}
  .td-row .t{font-size:13.5px;font-weight:500;min-width:0}
  .td-row .m{font-size:12px;color:var(--text-3);margin-top:2px;display:flex;gap:6px;flex-wrap:wrap}
  .td-row .m .k{color:var(--text-2)}
  .td-row .a{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .td-clear{padding:36px 20px;text-align:center;color:var(--text-3);font-size:14px}
  .td-clear b{display:block;color:var(--text);font-size:17px;font-weight:600;margin-bottom:6px}
  @media(max-width:760px){
    .td-row{grid-template-columns:8px minmax(0,1fr)}
    .td-row .a{grid-column:2;justify-content:flex-start}
    .td-chip{min-width:0;flex:1}
  }`;
  document.head.appendChild(s);
}

export function renderToday(view, item) {
  ensureTodayStyles();
  if (!DB.campaigns.length) {
    view.innerHTML = emptyState('Nothing to do yet', 'Import a campaign and its to-dos show up here.');
    return;
  }
  /* the Desk's clash checks need the server; ask once, draw without them meanwhile */
  if (!DESK.data && !DESK.loading && !TODAY_VIEW.deskAsked) {
    TODAY_VIEW.deskAsked = true;
    loadDesk().then(() => { if (parseHash().section === 'today') notify(); });
  }
  if (!POSTS_IN.list && !TODAY_VIEW.postsAsked) {
    TODAY_VIEW.postsAsked = true;
    loadPostsIn().then(() => { if (parseHash().section === 'today' && (POSTS_IN.list || []).length) notify(); });
  }
  /* the panel narrows it to one campaign; the item is that campaign's id */
  const only = item && item !== 'all' && byCampaign[item] ? item : '';
  const all = todayItems();
  const items = only ? all.filter((x) => x.campaignId === only) : all;
  const c = todayCounts(items);
  const when = new Date(kstToday() + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const row = (it) => `<div class="td-row ${it.sev}" data-tdkey="${esc(it.key)}">
      <span class="dot"></span>
      <div style="min-width:0"><div class="t">${esc(it.title)}</div>
        <div class="m"><span class="k">${esc(TODAY_KIND[it.kind] || '')}</span>${it.brand ? `<span>· ${esc(it.brand)}</span>` : ''}${
          it.sub ? `<span>· ${esc(it.sub)}</span>` : ''}</div></div>
      <div class="a">${it.acts.map((a, i) => `<button class="btn xs ${i === 0 && TODAY_PRIMARY.has(a) ? 'primary' : ''}"
        data-tdact="${esc(a)}">${esc(TODAY_ACT[a] || a)}</button>`).join('')}</div>
    </div>`;

  view.innerHTML = `<div class="td-wrap">
    <div class="td-head"><h2>${only ? esc(byCampaign[only].brand) : 'Today'}</h2><span class="d">${esc(when)}</span></div>
    <div class="td-sum">
      <div class="td-chip now"><b>${c.now}</b><span>need you now</span></div>
      <div class="td-chip"><b>${c.todo}</b><span>to do</span></div>
      <div class="td-chip"><b>${c.soon}</b><span>coming up</span></div>
    </div>
    ${items.length ? TODAY_GROUPS.map(([sev, label]) => {
      const list = items.filter((x) => x.sev === sev);
      return list.length ? `<div class="td-group"><h3>${label}<span class="n">${list.length}</span></h3>
        <div class="td-list">${list.map(row).join('')}</div></div>` : '';
    }).join('') : `<div class="td-list"><div class="td-clear"><b>All clear</b>Nothing needs a person right now.</div></div>`}
    ${DESK.error ? `<p class="card-sub">Booking clashes aren't included — the Desk couldn't reach the server.</p>` : ''}
  </div>`;

  const byKey = {};
  items.forEach((x) => { byKey[x.key] = x; });
  $$('[data-tdact]', view).forEach((b) => b.addEventListener('click', () => {
    const it = byKey[b.closest('[data-tdkey]').dataset.tdkey];
    if (it) todayAct(it, b.dataset.tdact);
  }));
}

export function todayAct(it, act) {
  const p = it.participantId ? DB.participants.find((x) => x.id === it.participantId) : null;
  const cp = byCampaign[it.campaignId];
  const go = (tab) => { location.hash = `#/campaigns/${it.campaignId}/${tab}`; };
  if (act === 'booking') return go('booking');
  if (act === 'content') return go('content');
  if (act === 'planner') return go('planner');
  if (act === 'roster') return go('roster');
  if (act === 'desk') { if (it.day) { DESK.day = it.day; } location.hash = '#/desk'; return; }
  if (act === 'view') { window.open(it.url, '_blank', 'noopener'); return; }
  if (act === 'accept' || act === 'reject') {
    const sub = (POSTS_IN.list || []).find((x) => x._id === it.sub_id);
    if (!sub) return;
    if (act === 'accept' && p) {
      /* the same write as typing the link into the roster drawer */
      setContentUrl(p, byCreator[p.creatorId], sub.url);
      if (STAGE_IDX[p.stage] < STAGE_IDX.submitted) moveStage(p, 'submitted');
    }
    settlePostIn(sub, act === 'accept' ? 'accepted' : 'rejected')
      .then(() => { toast(act === 'accept' ? 'Post added to the roster' : 'Link dismissed'); notify(); })
      .catch((err) => toast(err.message));
    return;
  }
  if (act === 'open' || act === 'addlink') { if (p) showParticipant(p.id); else go('roster'); return; }
  if (act === 'snooze') {
    snoozeToday(p || cp, it.kind, 2);
    toast('Hidden for 2 days');
    return notify();
  }
  if (!p) return;
  if (act === 'remind') {
    copyText(reminderMessage(cp, p));
    p.reminderFor = plannerRow(p).slot;
    return notify();
  }
  if (act === 'done') { p.reminderFor = plannerRow(p).slot; return notify(); }
  if (act === 'came' || act === 'noshow') {
    setAttendance(p, act === 'came' ? 'attended' : 'no_show');
    toast(act === 'came' ? 'Marked as came' : 'Marked as no-show');
    return notify();
  }
  if (act === 'chase') {
    copyText(chaseMessage(cp, p));
    p.chasedAt = new Date().toISOString();
    return notify();
  }
  if (act === 'paid') {
    markPaid(p);
    toast('Marked paid');
    return notify();
  }
}

/* ============================================================
   VIEW — PAYOUTS
   Who is owed money, for which campaign, and since when. The drawer
   already recorded payment mode, amount and the day it was paid; this
   is the list of those across every campaign, with the one action
   that matters here.

   Bank details never leave the server copy (see stripPayout). They are
   shown masked, and the CSV carries names and amounts only — the bank
   transfer itself is done from the drawer's Reveal, one person at a time.
   ============================================================ */
export const PAYOUT_TABS = [['due', 'To pay'], ['upcoming', 'Not due yet'], ['paid', 'Paid']];

export function payoutRows(campaignId) {
  return DB.participants
    .filter((p) => p.stage !== 'dropped' && (!campaignId || p.campaignId === campaignId) && byCampaign[p.campaignId])
    .map((p) => {
      const pay = payInfo(p);
      if (pay.mode === 'none' || !pay.amount) return null;
      const post = postedState(p);
      const posted = post.state === 'posted';
      const state = pay.paid ? 'paid' : posted ? 'due' : 'upcoming';
      return { p, pay, post, state, cp: byCampaign[p.campaignId], cr: byCreator[p.creatorId] || {} };
    })
    .filter(Boolean);
}

export function renderPayouts(view, item, tab) {
  const only = item && item !== 'all' && byCampaign[item] ? item : '';
  const rows = payoutRows(only);
  const pick = PAYOUT_TABS.some((t) => t[0] === tab) ? tab : 'due';
  const sum = (k) => rows.filter((r) => r.state === k).reduce((a, r) => a + r.pay.amount, 0);
  const n = (k) => rows.filter((r) => r.state === k).length;
  const month = iso(TODAY).slice(0, 7);
  const paidMonth = rows.filter((r) => r.state === 'paid' && String(r.pay.paidAt).slice(0, 7) === month);

  if (!rows.length) {
    view.innerHTML = emptyState('Nobody to pay yet',
      'Creators show up here once a fee or a paid amount is set on their roster card.', { actions: false, icon: '₩' });
    return;
  }
  const list = rows.filter((r) => r.state === pick)
    .sort((a, b) => pick === 'paid' ? String(b.pay.paidAt).localeCompare(String(a.pay.paidAt))
      : a.cp.brand.localeCompare(b.cp.brand));
  const bankOf = (cr) => cr.payout && cr.payout.number
    ? `${esc(cr.payout.bank || 'Bank')} ${esc(maskAccount(cr.payout.number))}` : '<span style="color:var(--critical)">no bank details</span>';

  view.innerHTML = `
    <div class="grid g3" style="margin-bottom:16px">
      ${statCard('To pay now', wonK(sum('due')), { foot: `${n('due')} creator${n('due') === 1 ? '' : 's'} — posted, not paid` })}
      ${statCard('Not due yet', wonK(sum('upcoming')), { foot: `${n('upcoming')} still to post` })}
      ${statCard('Paid this month', wonK(paidMonth.reduce((a, r) => a + r.pay.amount, 0)), { foot: `${paidMonth.length} payment${paidMonth.length === 1 ? '' : 's'}` })}
    </div>
    <div class="card" style="padding:0">
      <div class="card-head" style="padding:14px 16px 10px"><h3>${esc(PAYOUT_TABS.find((t) => t[0] === pick)[1])}</h3>
        <div class="sp"></div>
        <button class="btn sm" id="poCsv" title="Names and amounts only — bank details never go in a file">Download CSV</button></div>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>Creator</th><th>Campaign</th><th class="num">Amount</th><th>${pick === 'paid' ? 'Paid on' : 'Post'}</th><th>Bank</th><th></th>
      </tr></thead><tbody>${list.map((r) => `<tr data-poid="${esc(r.p.id)}">
        <td>${r.cr.handle ? whoHtml(r.cr, r.p.fullName || r.cr.name || '') : esc(r.p.fullName || '—')}</td>
        <td>${esc(r.cp.brand)}</td>
        <td class="num">${won(r.pay.amount)}</td>
        <td>${pick === 'paid' ? esc(r.pay.paidAt || 'paid') : `<span class="pill ${r.post.state === 'posted' ? 'green' : 'grey'}">${esc(r.post.label)}</span>`}</td>
        <td style="font-size:12.5px;color:var(--text-2)">${bankOf(r.cr)}</td>
        <td style="text-align:right;white-space:nowrap">
          ${pick === 'paid' ? '<button class="btn xs" data-pounpaid>Undo</button>' : `<button class="btn xs ${pick === 'due' ? 'primary' : ''}" data-popaid>Mark paid</button>`}
          <button class="btn xs" data-poopen>Open</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : `<p class="card-sub" style="padding:0 16px 16px">Nothing here.</p>`}
    </div>`;

  const rowP = (b) => DB.participants.find((x) => x.id === b.closest('[data-poid]').dataset.poid);
  $$('[data-popaid]', view).forEach((b) => b.addEventListener('click', () => { markPaid(rowP(b)); toast('Marked paid'); notify(); }));
  $$('[data-pounpaid]', view).forEach((b) => b.addEventListener('click', () => {
    const p = rowP(b);
    p.payment = Object.assign({}, p.payment, { status: 'unpaid', paidAt: '' });
    notify();
  }));
  $$('[data-poopen]', view).forEach((b) => b.addEventListener('click', () => showParticipant(rowP(b).id)));
  $('#poCsv').addEventListener('click', () => {
    downloadFile(toCsv(['creator', 'handle', 'campaign', 'amount_krw', 'status', 'paid_on'],
      rows.map((r) => [r.p.fullName || r.cr.name || '', r.cr.handle || '', r.cp.brand, r.pay.amount, r.state, r.pay.paidAt || ''])),
      `vively-payouts-${iso(TODAY)}.csv`, 'text/csv;charset=utf-8');
  });
}

export function renderOverview(view, item, tab) {
  const all = DB.campaigns, act = activeCampaigns();
  if (!all.length) {
    view.innerHTML = emptyState('Nothing here yet',
      'Start a campaign by hand, or upload one of the VIVELY creator sheets and the influencer rows will be read in automatically — statuses, handles, followers, addresses and visit slots included.',
      { icon: '⌂' });
    return;
  }
  /* Needs attention became Today: one list, counted one way */
  if (item === 'attention') { location.replace('#/today'); return; }
  if (item === 'pipeline')  return ovPipeline(view, tab, act);
  if (item === 'content')   return ovContent(view, tab);
  return ovSummary(view, tab, all, act);
}

export function ovSummary(view, tab, all, act) {
  const cur = dailySeries(all, state.range);
  const prev = dailySeries(all, state.range * 2);
  const prevViews = prev.views.slice(0, state.range).reduce((a, b) => a + b, 0);
  const curViews = cur.views.reduce((a, b) => a + b, 0);
  const curEng = cur.eng.reduce((a, b) => a + b, 0);
  const port = portfolioStats(all);
  const inFlight = DB.participants.filter((p) => act.some((c) => c.id === p.campaignId) &&
    ['contacted', 'replied', 'shortlisted', 'confirmed', 'shipped', 'submitted', 'review'].includes(p.stage)).length;

  const head = `<div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Active campaigns', act.length, { foot: `${all.length} total · ${all.filter((c) => c.status === 'live').length} live` })}
      ${statCard('Creators in flight', num(inFlight), { foot: `${num(port.confirmed)} confirmed all-time` })}
      ${statCard(`Views · last ${state.range}d`, kmb(curViews), { delta: prevViews ? (curViews - prevViews) / prevViews : null, foot: `${kmb(curEng)} engagements` })}
      ${statCard('Blended CPM', money2(port.cpm), { hint: 'Total spend ÷ reach × 1,000.', foot: `CPV ${money2(port.cpv)} · CPE ${money2(port.cpe)}` })}
    </div>`;

  if (tab === 'cost') {
    view.innerHTML = head + `<div class="grid g2">
      <div class="card"><div class="card-head"><h3>Cost efficiency</h3></div>
        <p class="card-sub">Across every campaign with live content.</p>
        <div class="grid g2" style="gap:10px">
          ${statCard('CPM', money2(port.cpm), { foot: 'per 1,000 reached' })}
          ${statCard('CPV', money2(port.cpv), { foot: 'per view' })}
          ${statCard('CPE', money2(port.cpe), { foot: 'per engagement' })}
          ${statCard('CPI', wonK(port.cpi), { foot: 'per confirmed creator' })}
        </div>
      </div>
      <div class="card"><div class="card-head"><h3>Where the money went</h3></div>
        <p class="card-sub">Total spend ${wonK(port.spend)}.</p>
        <div id="ovSpend" style="margin-top:12px"></div>
        <div class="divider"></div>
        <div class="card-head"><h3>Organic vs paid views</h3></div>
        <div id="ovOrg" style="margin-top:12px"></div>
      </div>
    </div>`;
    const shipped = DB.participants.filter((p) => STAGE_IDX[p.stage] >= 5 && p.stage !== 'dropped');
    const productCost = shipped.reduce((a, p) => a + byCampaign[p.campaignId].productCostPer, 0);
    const fees = DB.participants.reduce((a, p) => a + (STAGE_IDX[p.stage] >= 4 && p.stage !== 'dropped' ? p.fee : 0), 0);
    const ads = DB.campaigns.reduce((a, c) => a + c.adSpend, 0);
    splitBar($('#ovSpend'), [
      { label: 'Product & shipping', value: productCost, color: 'var(--s1)' },
      { label: 'Creator fees', value: fees, color: 'var(--s2)' },
      { label: 'Ad spend', value: ads, color: 'var(--s3)' }
    ]);
    splitBar($('#ovOrg'), [
      { label: 'Organic', value: port.organicViews, color: 'var(--s1)' },
      { label: 'Paid / boosted', value: port.paidViews, color: 'var(--s2)' }
    ]);
    return;
  }

  const isEng = tab === 'engagement';
  view.innerHTML = head + `<div class="card">
      <div class="card-head"><h3>${isEng ? 'Daily engagements' : 'Daily views'}</h3><div class="sp"></div>${rangeSeg()}</div>
      <p class="card-sub">${isEng ? 'Likes, comments, shares and saves accruing each day.' : 'Incremental views across every campaign with live content.'}</p>
      <div id="ovChart"></div>
    </div>`;
  lineChart($('#ovChart'), {
    labels: cur.labels, height: fitHeight(430, 240),
    series: [isEng
      ? { name: 'Engagements', values: cur.eng, color: 'var(--s2)', area: true }
      : { name: 'Views', values: cur.views, area: true }]
  });
  wireRange();
}

export function ovAttention(view, tab) {
  const all = alertsList();
  const list = tab === 'critical' ? all.filter((a) => a.sev === 'critical' || a.sev === 'serious')
    : tab === 'wins' ? all.filter((a) => a.kind === 'wins')
    : tab === 'chasing' ? all.filter((a) => a.kind === 'chasing')
    : all;

  const counts = {
    critical: all.filter((a) => a.sev === 'critical').length,
    serious: all.filter((a) => a.sev === 'serious').length,
    warning: all.filter((a) => a.sev === 'warning').length,
    good: all.filter((a) => a.sev === 'good').length
  };

  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Urgent', counts.critical, { foot: 'blocking delivery' })}
      ${statCard('Slipping', counts.serious, { foot: 'behind schedule' })}
      ${statCard('To follow up', counts.warning, { foot: 'nudge today' })}
      ${statCard('Wins to press', counts.good, { foot: 'posts worth boosting' })}
    </div>
    <div class="card"><div id="alerts" style="max-height:calc(100vh - 330px);overflow-y:auto"></div></div>`;

  $('#alerts').innerHTML = list.length ? list.map((a) => {
    const color = { critical: 'var(--critical)', serious: 'var(--serious)', warning: 'var(--warning)', good: 'var(--good)' }[a.sev];
    const icon = { critical: '!', serious: '!', warning: '•', good: '↑' }[a.sev];
    return `<a class="alert-row" href="${a.href}" style="color:inherit;text-decoration:none;">
      <span class="ai" style="background:${color};color:#0b0c0e;font-weight:700;">${icon}</span>
      <span class="at"><b>${esc(a.title)}</b><div class="as">${esc(a.sub)}</div></span>
      <span style="color:var(--text-3)">›</span></a>`;
  }).join('') : `<div class="empty">Nothing here — this queue is clear.</div>`;
}

export function ovPipeline(view, tab, act) {
  const f = funnelOf(act.map((c) => c.id));

  if (tab === 'status') {
    view.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:calc(100vh - 200px);overflow-y:auto" id="ovCampaigns"></div></div>`;
    $('#ovCampaigns').innerHTML = `<table class="tbl"><thead><tr>
        <th>Campaign</th><th>Status</th><th style="width:170px">Confirmed vs target</th><th class="num">Delivered</th>
        <th class="num">Views</th><th class="num">ER</th><th class="num">CPM</th></tr></thead><tbody>${
        act.map((cp) => {
          const s = campaignStats(cp);
          return `<tr class="clickable" onclick="location.hash='#/campaigns/${cp.id}/roster'">
            <td class="strong">${esc(cp.brand)}<div style="font-size:11.5px;color:var(--text-3);font-weight:400;">${esc(cp.kind)} · ${esc(cp.market)}</div></td>
            <td>${statusPill(cp.status)}</td>
            <td><div class="bar"><i style="width:${(s.progress * 100).toFixed(0)}%"></i></div>
                <div style="font-size:11px;color:var(--text-3);margin-top:4px;">${s.confirmed} / ${cp.targetCreators}</div></td>
            <td class="num">${s.delivered}</td><td class="num">${kmb(s.views)}</td>
            <td class="num">${s.views ? pct(s.er) : '—'}</td><td class="num">${s.reach ? money2(s.cpm) : '—'}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    return;
  }

  if (tab === 'conversion') {
    view.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap">
      <table class="tbl"><thead><tr><th>Stage</th><th>What it means</th><th class="num">Creators</th><th class="num">From previous</th><th class="num">From sourced</th></tr></thead>
      <tbody>${f.counts.map((c, i) => `<tr>
        <td class="strong"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.stage.color};margin-right:8px"></span>${c.stage.label}</td>
        <td style="color:var(--text-3);font-size:12.5px">${esc(c.stage.desc)}</td>
        <td class="num">${num(c.n)}</td>
        <td class="num">${i ? pct(c.n / (f.counts[i - 1].n || 1), 0) : '—'}</td>
        <td class="num">${pct(c.n / (f.counts[0].n || 1), 0)}</td></tr>`).join('')}
        <tr><td class="strong" style="color:#f08a8a">Dropped</td><td style="color:var(--text-3);font-size:12.5px">Declined, ghosted or removed by the brand</td>
        <td class="num">${num(f.dropped)}</td><td class="num">—</td><td class="num">${pct(f.dropped / (f.total || 1), 0)}</td></tr>
      </tbody></table></div></div>`;
    return;
  }

  view.innerHTML = `<div class="grid g-2-1">
      <div class="card"><div class="card-head"><h3>Outreach funnel</h3></div>
        <p class="card-sub">All active campaigns. Each row counts creators still in play at or past that stage.</p>
        <div id="ovFunnel"></div>
      </div>
      <div class="card"><div class="card-head"><h3>Health</h3></div>
        <div class="grid" style="gap:10px;margin-top:12px">
          ${statCard('Reply rate', pct(f.counts[2].n / (f.counts[1].n || 1), 0), { foot: 'replied ÷ contacted' })}
          ${statCard('Confirm rate', pct(f.counts[4].n / (f.counts[1].n || 1), 0), { foot: 'confirmed ÷ contacted' })}
          ${statCard('Delivery rate', pct(f.counts[8].n / (f.counts[4].n || 1), 0), { foot: 'live ÷ confirmed' })}
        </div>
      </div>
    </div>`;
  funnelView($('#ovFunnel'), f.counts, f.total);
  $('#ovFunnel').insertAdjacentHTML('beforeend',
    `<div style="margin-top:12px;font-size:12px;color:var(--text-3);">${num(f.dropped)} of ${num(f.total)} sourced dropped out or were declined along the way.</div>`);
}

export function ovContent(view, tab) {
  const live = DB.participants.filter((p) => p.stage === 'live' && p.content);
  const key = tab === 'views' ? (p) => p.content.views : tab === 'comments' ? (p) => p.content.comments : (p) => viralScore(p);
  const rows = live.slice().sort((a, b) => key(b) - key(a)).slice(0, 25);

  view.innerHTML = `<div class="card" style="padding:0">
    <div style="padding:16px 20px 0"><div class="card-head"><h3>Top ${rows.length} posts ${tab === 'views' ? 'by views' : tab === 'comments' ? 'by comments' : 'by viral score'}</h3></div>
    <p class="card-sub">${tab === 'comments' || tab === 'views' ? 'Live posts only.' : "Viral score is views ÷ that creator's own average, weighted by shares and saves. 1.0× is a normal post for them."}</p></div>
    <div class="tbl-wrap" style="max-height:calc(100vh - 260px);overflow-y:auto" id="ovTop"></div></div>`;

  $('#ovTop').innerHTML = `<table class="tbl"><thead><tr>
      <th>Creator</th><th>Campaign</th><th>Format</th><th class="num">Views</th><th class="num">ER</th>
      <th class="num">Comments</th><th class="num">Saves</th><th class="num">Viral</th><th></th></tr></thead><tbody>${
      rows.map((p) => {
        const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId], c = p.content, v = viralScore(p);
        return `<tr class="clickable" onclick="showParticipant('${p.id}')">
          <td>${whoHtml(cr)}</td><td>${esc(cp.brand)}</td>
          <td><span class="tag">${esc(c.format)}</span>${c.boosted ? ' <span class="pill yellow">Ad</span>' : ''}</td>
          <td class="num">${num(c.views)}</td><td class="num">${pct(engagementsOf(c) / (c.views || 1))}</td>
          <td class="num">${num(c.comments)}</td><td class="num">${num(c.saves)}</td>
          <td class="num" style="color:${v >= 5 ? 'var(--good)' : v >= 3 ? 'var(--warning)' : 'var(--text-2)'};font-weight:500;">${v.toFixed(1)}×</td>
          <td><a href="${c.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">open</a></td></tr>`;
      }).join('')}</tbody></table>`;
}
