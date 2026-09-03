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
/* two creators deliberately share one slot, so the double-booking check
   has something real to find */
participants.filter((p) => p.campaignId === 'cp1' && p.visitAt).slice(0, 2)
  .forEach((p) => { p.visitAt = `${mk(3)} 19:00`; });
/* and one unreadable slot */
const junk = participants.find((p) => p.campaignId === 'cp2' && p.visitAt);
if (junk) junk.visitAt = 'next tuesday-ish';

campaigns.forEach((c) => { if (c.fulfilment === 'visit') { c.venue = c.brand + ', Seoul'; c.timezone = 'Asia/Seoul'; } });

/* two partners and one campaign belonging to neither, so the scoping can be
   shown to actually scope rather than merely be intended to */
/* the SPLABAB campaigns are Notion-linked, with a Status column mapped, so
   the write-back has something to write to */
/* A data-source id has to be uuid-shaped: the server normalises it before
   calling Notion and refuses anything else, so 'ds-cp1' never reached the
   API at all — every browser sync failed at the first step and the
   harnesses around it were passing on a sync that never ran. */
const dsId = (n) => `d5000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
campaigns.forEach((c, i) => {
  c.notionDatabaseId = dsId(i + 1);
  /* Without a column that identifies the creator, runNotionSync skips every
     row before it does anything ("8 skipped, 0 updated") — so every harness
     that pressed Sync was measuring a sync that did no work. */
  c.notionMapping = { 'Instagram Link (URL)': 'handle',
                      'Full Name ': 'fullName', 'Status': 'status',
                      'Date & Time Availability ': 'visitAt', 'Remark': 'remark',
                      'Number of people visiting ': 'headcount', 'Notes': 'formNotes' };
});
/* real Notion page ids are uuids, and the server refuses anything that is
   not one — so the fixture has to look like the real thing */
const fakePageId = (n) => {
  const h = (n + 0x10000000).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
participants.forEach((p, i) => { p.notionPageId = fakePageId(i + 1); p.headcount = String(1 + (i % 4)); });

campaigns[0].partner = 'SPLABAB';
campaigns[1].partner = 'SPLABAB';
campaigns[2].partner = 'OTHERCO';

/* things a partner must never be handed */
creators.forEach((c, i) => {
  if (i % 3 === 0) c.payout = { bank: 'KB국민', name: c.name, number: '110-234-5678' + i };
  if (i % 4 === 0) c.gender = i % 8 === 0 ? 'M' : 'F';
});
participants.forEach((p, i) => {
  p.note = 'INTERNAL ONLY — do not show a partner ' + i;
  p.formNotes = i % 3 === 0 ? '채식주의자입니다' : '';
  p.remark = i % 5 === 0 ? '2명 방문 예정' : '';
  p.fee = 50000 + i * 1000;
  p.address = '서울시 강남구 비밀주소 ' + i;
  /* order matters: whichever runs last decides the status, and the marker
     below has to end up on rows that really are withheld */
  if (i % 7 === 0) { p.importedStatus = 'Brand Rejected'; p.stage = 'dropped'; p.dropReason = 'Brand rejected'; }
  if (i % 6 === 0) { p.importedStatus = 'Waiting Approval'; p.stage = 'shortlisted'; p.dropReason = null;
                     p.remark = 'WITHHELD-MARKER-DO-NOT-SHOW'; }
});

/* two rows arranged for the write-back checks, so the harness never has to
   poke at internals to set up a case */
{
  const mine = participants.filter((p) => p.campaignId === campaigns[0].id);
  mine[2].dropReason = 'Brand rejected';   mine[2].stage = 'confirmed'; mine[2].importedStatus = 'Confirmed';
  mine[3].importedStatus = 'Brand Accepted'; mine[3].stage = 'confirmed';
  /* index 6 is the Waiting Approval marker the partner-page checks rely on,
     so the "no status yet" fixture goes on a row nothing else claims */
  mine[5].importedStatus = '';             mine[5].stage = 'confirmed';
}

/* Reproduces the collision found in the live workspace: two campaigns on
   one id, with both rosters pooled under it. */
{
  const clash = JSON.parse(JSON.stringify(campaigns[1]));
  clash.brand = 'Sushisora'; clash.name = 'Sushisora';
  clash.id = campaigns[1].id;                      /* the same id as Juno Seoul */
  clash.notionDatabaseId = dsId(90);               /* its own form, not Juno's */
  clash.partner = campaigns[1].partner;            /* same partner, so partner
                                                      scoping stays testable */
  campaigns.push(clash);
}

const partnerLinks = [
  { partner: 'SPLABAB', token: 'tok-splabab-test', createdAt: new Date().toISOString(), revokedAt: null },
  { partner: 'OTHERCO', token: 'tok-otherco-test', createdAt: new Date().toISOString(), revokedAt: null },
  { partner: 'GONE',    token: 'tok-revoked-test', createdAt: new Date().toISOString(), revokedAt: new Date().toISOString() }
];

/* ------------------------------------------------------------------
   Two fixtures the partner page needs, and did not have.

   The partner payload is built on the SERVER, in its own copy of the
   rules — so a change made only in the dashboard's copy goes unnoticed
   until a partner is looking at the wrong time. These two rows exist
   so that a harness can see through the server's eyes.
   ------------------------------------------------------------------ */
const splababRows = participants.filter((x) => {
  const cp = campaigns.find((c) => c.id === x.campaignId);
  return cp && cp.partner === 'SPLABAB' && x.visitAt && x.stage !== 'dropped';
});

/* one booking moved off what the creator asked for */
const rescheduled = splababRows[0];
if (rescheduled) {
  rescheduled.visitAt = '2026-09-05 19:00';
  rescheduled.confirmedVisitAt = '2026-09-11 12:30';
}

/* and one post stored the way it is stored now — in the library, with
   nothing left on the roster row */
const socialContent = [];
const moved = splababRows.find((x) => x !== rescheduled && x.content && x.content.url);
if (moved) {
  socialContent.push(Object.assign({}, moved.content, {
    id: 'sc-partner-fixture',
    participantId: moved.id,
    campaignId: moved.campaignId,
    creatorId: moved.creatorId,
    postUrl: moved.content.url,
    matchStatus: 'confirmed'
  }));
  delete moved.content;
}

const appointments = [{
  id: 'ap-shoot', title: 'Sushikoji — filming day', date: mk(5), endDate: '', startTime: '10:00',
  endTime: '16:00', timezone: 'Asia/Seoul', location: 'https://meet.google.com/abc-defg-hij',
  description: 'Full day shoot', campaignId: 'cp1', createdAt: new Date().toISOString()
}];

console.log(JSON.stringify({ savedAt: new Date().toISOString(),
  db: { creators, campaigns, participants, appointments, partnerLinks, socialContent },
  settings: { hideBlocked: true } }));
