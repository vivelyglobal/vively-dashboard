/* ---------------- pipeline model ---------------- */
export const STAGES = [
  { id: 'sourced',    label: 'Sourced',         color: 'var(--s7)', desc: 'Pulled from Instagram, ScoutLab or the in-house database' },
  { id: 'contacted',  label: 'Contacted',       color: 'var(--s1)', desc: 'First outreach DM sent' },
  { id: 'replied',    label: 'Replied',         color: 'var(--s5)', desc: 'Creator answered, negotiating' },
  { id: 'shortlisted',label: 'Shortlisted',     color: 'var(--s4)', desc: 'Sent to the brand for approval' },
  { id: 'confirmed',  label: 'Confirmed',       color: 'var(--s3)', desc: 'Participation agreed' },
  { id: 'shipped',    label: 'Shipped / Booked',color: 'var(--s2)', desc: 'Product dispatched or store visit scheduled' },
  { id: 'submitted',  label: 'Content in',      color: 'var(--s5)', desc: 'Draft received, awaiting review' },
  { id: 'review',     label: 'In review',       color: 'var(--s4)', desc: 'Brand / VIVELY review, revisions possible' },
  { id: 'live',       label: 'Live',            color: 'var(--s3)', desc: 'Published and tracking' },
  { id: 'dropped',    label: 'Dropped',         color: 'var(--s6)', desc: 'Declined, ghosted or removed' }
];
export const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
export const stageOf = (id) => STAGES.find((s) => s.id === id) || STAGES[0];

export const CAMPAIGN_STATUS = {
  planning:  { label: 'Planning',   cls: 'grey'   },
  outreach:  { label: 'Outreach',   cls: 'blue'   },
  confirming:{ label: 'Confirming', cls: 'purple' },
  production:{ label: 'Production', cls: 'yellow' },
  live:      { label: 'Live',       cls: 'green'  },
  wrapped:   { label: 'Wrapped',    cls: 'grey'   }
};

/* ---------------- vocab ---------------- */
export const CATEGORIES = ['Beauty', 'Skincare', 'K-Food', 'Fashion', 'Lifestyle', 'Travel', 'Fitness', 'Cafe & Dining', 'Tech', 'Baby & Kids'];
export const COUNTRIES  = ['Korea', 'Vietnam', 'Singapore', 'Thailand', 'Indonesia', 'Malaysia', 'Japan', 'Taiwan', 'Philippines', 'USA'];
export const PLATFORMS  = ['Instagram', 'TikTok', 'YouTube'];
export const SOURCES    = ['Instagram DM', 'ScoutLab', 'VIVELY database', 'Referral', 'Inbound form', 'Excel import', 'Imported CSV'];
export const CONTENT_FORMATS = ['Reel', 'Carousel', 'TikTok video', 'Shorts', 'Story set'];

export function tierOf(followers) {
  if (followers < 15000)  return { id: 'nano',  label: 'Nano',  cls: 'grey'   };
  if (followers < 60000)  return { id: 'micro', label: 'Micro', cls: 'blue'   };
  if (followers < 250000) return { id: 'mid',   label: 'Mid',   cls: 'purple' };
  return                         { id: 'macro', label: 'Macro', cls: 'yellow' };
}

export const AV_COLORS = ['#4e8ef7', '#d96a08', '#1e9e6a', '#bd8300', '#a06ee0', '#e5514a', '#00a0b0'];
export const avColor = (s) => {
  let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
};
export const initials = (s) => String(s).replace(/^@/, '').slice(0, 2).toUpperCase();

/* front-loaded view curve, used when a post is approved and starts tracking */
export function viewCurve(total, days, boosted) {
  const w = [];
  for (let i = 0; i < days; i++) {
    let v = Math.pow(0.72, i) + 0.02;
    if (boosted && i >= 3 && i <= 7) v += 0.35 * Math.pow(0.8, i - 3);
    w.push(v);
  }
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return w.map((x) => { acc += (x / sum) * total; return Math.round(acc); });
}
