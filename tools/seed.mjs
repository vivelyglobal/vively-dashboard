/* A small but realistic workspace, so the browser check exercises the
   populated code paths and not just the empty states. */
const iso = (d) => d.toISOString().slice(0, 10);
const T = new Date(); const day = 86400000;
const mk = (n) => iso(new Date(T.getTime() + n * day));
const STAGES = ['sourced','contacted','replied','shortlisted','confirmed','shipped','production','live','wrapped'];

const creators = [], participants = [], campaigns = [];
const CPS = [
  { id: 'cp1', brand: 'Sushikoji', name: 'Sushikoji Jongno counter visit', kind: 'Store visit', market: 'Korea',
    status: 'live', category: 'Cafe & Dining', fulfilment: 'visit' },
  { id: 'cp2', brand: 'Juno Seoul', name: 'Juno Seoul salon seeding', kind: 'Salon visit', market: 'Korea',
    status: 'production', category: 'Beauty', fulfilment: 'visit' },
  { id: 'cp3', brand: 'Glowbe', name: 'Glowbe serum delivery', kind: 'Product seeding', market: 'Vietnam',
    status: 'wrapped', category: 'Skincare', fulfilment: 'delivery' }
];
CPS.forEach((c, ci) => {
  campaigns.push(Object.assign({
    start: mk(-30 + ci * 5), end: mk(20 + ci * 5), targetCreators: 8, minFollowers: 5000,
    productCostPer: 25000, adSpend: 0, budget: 8 * 25000, owner: 'Kunzang',
    deliverables: '1 Reel + 3 stories', platforms: ['Instagram', 'TikTok'],
    hashtags: ['#vively'], note: '', createdAt: mk(-40), categories: [c.category]
  }, c));
  for (let i = 0; i < 8; i++) {
    const id = `cr${ci}${i}`;
    const followers = 4000 + i * 9000 + ci * 3000;
    creators.push({ id, handle: `@creator${ci}${i}`, name: `Creator ${ci}${i}`,
      platform: i % 3 === 0 ? 'TikTok' : 'Instagram', followers,
      er: 0.03 + i * 0.002, avgViews: Math.round(followers * 0.6),
      categories: [c.category], country: ci === 2 ? 'Vietnam' : 'Korea',
      nationality: ci === 2 ? 'Vietnamese' : 'Korean', languages: ['EN'],
      tier: followers > 50000 ? 'mid' : 'micro', source: 'Notion form',
      rate: 0, reliability: 0.8, avgTurnaroundDays: 5, campaignsDone: 0, lastWorked: null,
      email: `c${ci}${i}@mail.com`, contact: '', address: '', tags: [], notes: '',
      flag: i === 7 && ci === 0 ? 'blocked' : null, flagReason: '', flagAt: null,
      campaignIds: [], contentCount: 0, totalViews: 0, bestViews: 0 });
    const stage = STAGES[Math.min(STAGES.length - 1, 2 + i)];
    const live = stage === 'live' || stage === 'wrapped';
    participants.push({
      id: `${c.id}-${id}`, campaignId: c.id, creatorId: id, stage,
      source: 'Notion form', fee: 0,
      contactedAt: c.start, repliedAt: c.start, confirmedAt: i >= 4 ? c.start : null,
      shippedAt: i >= 5 ? c.start : null, dropReason: null, revisions: 0, note: '',
      fullName: `Creator ${ci}${i}`, address: '', contact: '', nationality: '', otherSns: '',
      visitAt: c.fulfilment === 'visit' && i >= 3 ? `${mk(i - 2)} ${13 + (i % 6)}:00` : '',
      arrivingDate: '', importedStatus: '', notionPageId: `pg-${c.id}-${id}`,
      content: live ? {
        url: `https://www.instagram.com/reel/abc${ci}${i}`, platform: 'Instagram', format: 'Reel',
        postedAt: mk(-7 + i), submittedAt: mk(-8 + i),
        views: 20000 + i * 7000, paidViews: 0, organicViews: 20000 + i * 7000,
        likes: 900 + i * 60, comments: 30 + i * 4, shares: 10 + i, saves: 25 + i,
        reach: 26000 + i * 8000, profileVisits: 400, followsGained: 40, linkClicks: 12,
        curve: [], boosted: false, viral: i === 7, topCountries: ['Korea'],
        metricsAt: mk(-1), thumbTint: '#4e8ef7'
      } : null
    });
  }
});
console.log(JSON.stringify({ savedAt: new Date().toISOString(),
  db: { creators, campaigns, participants }, settings: { hideBlocked: true } }));
