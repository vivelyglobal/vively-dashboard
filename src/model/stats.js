import { DAY, TODAY, addDays, iso } from '../lib/dates.js';
import { engagementsOf } from '../lib/format.js';
import { DB, byCreator } from './db.js';
import { STAGES, STAGE_IDX } from './vocab.js';

export function partsOf(campaignId) { return DB.participants.filter((p) => p.campaignId === campaignId); }
export function liveOf(campaignId)  { return partsOf(campaignId).filter((p) => p.stage === 'live' && p.content); }

/* viral score: how far a post beat the creator's own baseline, weighted by
   share+save rate. 1.0 = on par with baseline. */
export function viralScore(p) {
  const cr = byCreator[p.creatorId];
  if (!p.content || !cr || !cr.avgViews) return 0;
  const lift = p.content.views / cr.avgViews;
  const sr = p.content.views ? (p.content.shares + p.content.saves) / p.content.views : 0;
  return +(lift * (1 + sr * 6)).toFixed(2);
}

export function campaignSpend(cp) {
  const ps = partsOf(cp.id);
  const shipped = ps.filter((p) => STAGE_IDX[p.stage] >= 5 && p.stage !== 'dropped').length;
  const fees = ps.reduce((a, p) => a + (STAGE_IDX[p.stage] >= 4 && p.stage !== 'dropped' ? p.fee : 0), 0);
  return shipped * cp.productCostPer + fees + cp.adSpend;
}

export function campaignStats(cp) {
  const ps = partsOf(cp.id);
  const live = ps.filter((p) => p.stage === 'live' && p.content);
  const views = live.reduce((a, p) => a + p.content.views, 0);
  const paid  = live.reduce((a, p) => a + p.content.paidViews, 0);
  const reach = live.reduce((a, p) => a + p.content.reach, 0);
  const eng   = live.reduce((a, p) => a + engagementsOf(p.content), 0);
  const comments = live.reduce((a, p) => a + p.content.comments, 0);
  const spend = campaignSpend(cp);
  const contacted = ps.filter((p) => STAGE_IDX[p.stage] >= 1 && p.stage !== 'dropped').length
                  + ps.filter((p) => p.stage === 'dropped' && p.contactedAt).length;
  const confirmed = ps.filter((p) => STAGE_IDX[p.stage] >= 4 && p.stage !== 'dropped').length;
  return {
    total: ps.length, contacted, confirmed,
    delivered: live.length,
    views, paidViews: paid, organicViews: views - paid, reach, eng, comments,
    er: views ? eng / views : 0,
    spend,
    cpm: reach ? spend / reach * 1000 : 0,
    cpv: views ? spend / views : 0,
    cpe: eng ? spend / eng : 0,
    cpi: confirmed ? spend / confirmed : 0,          // cost per influencer
    replyRate: contacted ? ps.filter((p) => p.repliedAt).length / contacted : 0,
    confirmRate: contacted ? confirmed / contacted : 0,
    deliveryRate: confirmed ? live.length / confirmed : 0,
    progress: cp.targetCreators ? Math.min(1, confirmed / cp.targetCreators) : 0,
    viralCount: live.filter((p) => viralScore(p) >= 3).length
  };
}

export function portfolioStats(campaigns) {
  const acc = { views: 0, paidViews: 0, reach: 0, eng: 0, comments: 0, spend: 0, delivered: 0, confirmed: 0, contacted: 0, viralCount: 0 };
  campaigns.forEach((cp) => {
    const s = campaignStats(cp);
    acc.views += s.views; acc.paidViews += s.paidViews; acc.reach += s.reach;
    acc.eng += s.eng; acc.comments += s.comments; acc.spend += s.spend;
    acc.delivered += s.delivered; acc.confirmed += s.confirmed; acc.contacted += s.contacted;
    acc.viralCount += s.viralCount;
  });
  acc.organicViews = acc.views - acc.paidViews;
  acc.er  = acc.views ? acc.eng / acc.views : 0;
  acc.cpm = acc.reach ? acc.spend / acc.reach * 1000 : 0;
  acc.cpv = acc.views ? acc.spend / acc.views : 0;
  acc.cpe = acc.eng ? acc.spend / acc.eng : 0;
  acc.cpi = acc.confirmed ? acc.spend / acc.confirmed : 0;
  return acc;
}

/* daily aggregate views across a set of campaigns, last N days */
export function dailySeries(campaigns, days) {
  const out = new Array(days).fill(0);
  const outEng = new Array(days).fill(0);
  campaigns.forEach((cp) => liveOf(cp.id).forEach((p) => {
    const c = p.content;
    const posted = new Date(c.postedAt + 'T00:00:00Z');
    const startIdx = days - 1 - Math.round((TODAY - posted) / DAY);
    let prev = 0;
    c.curve.forEach((cum, i) => {
      const inc = cum - prev; prev = cum;
      const idx = startIdx + i;
      if (idx >= 0 && idx < days) {
        out[idx] += inc;
        outEng[idx] += inc * (engagementsOf(c) / (c.views || 1));
      }
    });
  }));
  const labels = [];
  for (let i = days - 1; i >= 0; i--) labels.push(iso(addDays(TODAY, -i)));
  return { labels, views: out, eng: outEng.map((v) => Math.round(v)) };
}

export function funnelOf(campaignIds) {
  const ps = DB.participants.filter((p) => campaignIds.includes(p.campaignId));
  const active = ps.filter((p) => p.stage !== 'dropped');
  const counts = STAGES.filter((s) => s.id !== 'dropped').map((s) => ({
    stage: s,
    n: active.filter((p) => STAGE_IDX[p.stage] >= STAGE_IDX[s.id]).length
  }));
  return { counts, dropped: ps.length - active.length, total: ps.length };
}
