/* ============================================================
   SHELL — three layers
   Ported unchanged from the single-file version: the same
   sections, the same default items, the same hash routes, so
   every bookmark and every link still lands where it did.
   ============================================================ */
import { DB, byCampaign } from '../model/db.js';
import { campaignStats } from '../model/stats.js';
import { CAMPAIGN_STATUS } from '../model/vocab.js';
import { num, kmb } from '../lib/format.js';
import { state, activeCampaigns, OVERVIEW_ITEMS, OVERVIEW_TABS } from '../views/overview.js';
import { ANALYTICS_ITEMS, ANALYTICS_TABS } from '../views/analytics.js';
import { SOCIAL_ITEMS, SOCIAL_TABS } from '../views/social.js';
import { CREATOR_SEGMENTS, CREATOR_TABS, segmentOf } from '../views/creators.js';
import { CONTRACT_DOCS, CONTRACT_TABS } from '../docs/contracts.js';
import { SETTINGS_ITEMS } from '../views/settings.js';
import { MSG_KINDS } from '../views/messages.js';
import { CAMPAIGN_TABS } from '../views/campaigns.js';

export const SECTIONS = [
  { id: 'overview',  icon: '⌂', label: 'Overview' },
  { id: 'campaigns', icon: '▤', label: 'Campaigns', badge: () => activeCampaigns().length },
  { id: 'messages',  icon: '✉', label: 'Messages' },
  { id: 'creators',  icon: '◎', label: 'Creators', badge: () => DB.creators.length },
  { id: 'contracts', icon: '§', label: 'Contracts' },
  { id: 'analytics', icon: '◫', label: 'Analytics' },
  { id: 'social',    icon: '▶', label: 'Social', badge: () => DB.socialContent.filter((c) => c.url).length },
  { id: 'settings',  icon: '⚙', label: 'Setup' }
];

export function defaultItem(section) {
  return { overview: 'summary', campaigns: 'all', creators: 'all', analytics: 'trend', contracts: 'msa',
           social: 'library', settings: 'templates',
           messages: (activeCampaigns()[0] || DB.campaigns[0] || {}).id }[section] || '';
}

export function tabsFor(section, item) {
  if (section === 'overview')  return OVERVIEW_TABS[item] || OVERVIEW_TABS.summary;
  if (section === 'analytics') return ANALYTICS_TABS[item] || ANALYTICS_TABS.trend;
  if (section === 'social')    return SOCIAL_TABS;
  if (section === 'creators')  return CREATOR_TABS;
  if (section === 'contracts') return CONTRACT_TABS;
  if (section === 'messages')  return MSG_KINDS.map(([k, l]) => [k, l]);
  if (section === 'campaigns') return (!item || item === 'all')
    ? [['active', 'Active'], ['all', 'All'], ['wrapped', 'Wrapped'], ['calendar', 'Calendar']]
    : CAMPAIGN_TABS;
  return [];
}

export function panelFor(section, item) {
  const q = state.panelQ.trim().toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);

  if (section === 'overview')
    return { title: 'Overview', groups: [{ items: OVERVIEW_ITEMS.map((o) => ({ id: o.id, title: o.label, sub: o.sub })) }] };

  if (section === 'analytics')
    return { title: 'Analytics', groups: [{ items: ANALYTICS_ITEMS.map((o) => ({ id: o.id, title: o.label, sub: o.sub })) }] };

  if (section === 'social')
    return { title: 'Social media', groups: [{ items: SOCIAL_ITEMS.map((o) => ({ id: o.id, title: o.label, sub: o.sub })) }] };

  if (section === 'settings')
    return { title: 'Setup', groups: [{ items: SETTINGS_ITEMS.map((o) => ({ id: o.id, title: o.label, sub: o.sub })) }] };

  if (section === 'contracts')
    return { title: 'Documents', groups: [{ items: Object.values(CONTRACT_DOCS).map((d) => ({ id: d.id, title: d.label, sub: d.sub })) }] };

  if (section === 'creators')
    return { title: 'Segments', search: true, searchPlaceholder: 'Filter segments…',
      groups: [{ items: CREATOR_SEGMENTS.filter((s) => match(s.label))
        .map((s) => ({ id: s.id, title: s.label, right: num(DB.creators.filter(s.test).length) })) }] };

  /* campaigns + messages both browse the campaign list */
  const order = ['live', 'production', 'confirming', 'outreach', 'planning', 'wrapped'];
  const groups = [];
  if (section === 'campaigns' && match('all campaigns'))
    groups.push({ items: [{ id: 'all', title: 'All campaigns', sub: `${DB.campaigns.length} total`, plain: true }] });
  order.forEach((st) => {
    const items = DB.campaigns.filter((c) => c.status === st && (match(c.brand) || match(c.name) || match(c.kind) || match(c.market)));
    if (!items.length) return;
    groups.push({
      label: CAMPAIGN_STATUS[st].label,
      items: items.map((c) => {
        const s = campaignStats(c);
        return { id: c.id, title: c.brand, sub: `${c.kind} · ${c.market}`,
                 right: s.delivered ? kmb(s.views) : `${s.confirmed}/${c.targetCreators}`,
                 dot: { live: 'var(--good)', production: 'var(--warning)', confirming: 'var(--s5)',
                        outreach: 'var(--s1)', planning: 'var(--text-3)', wrapped: 'var(--text-3)' }[st] };
      })
    });
  });
  return { title: section === 'messages' ? 'Pick a campaign' : 'Campaigns', search: true, searchPlaceholder: 'Filter campaigns…', groups };
}

export function titleFor(section, item) {
  if (section === 'campaigns') return (!item || item === 'all') ? 'Campaigns' : (byCampaign[item] || {}).brand || 'Campaign';
  if (section === 'messages')  return (byCampaign[item] || {}).brand || 'Messages';
  if (section === 'creators')  return segmentOf(item).label;
  if (section === 'analytics') return (ANALYTICS_ITEMS.find((x) => x.id === item) || {}).label || 'Analytics';
  if (section === 'social')    return (SOCIAL_ITEMS.find((x) => x.id === item) || {}).label || 'Social media';
  if (section === 'contracts') return (CONTRACT_DOCS[item] || CONTRACT_DOCS.msa).label;
  if (section === 'settings')  return (SETTINGS_ITEMS.find((x) => x.id === item) || {}).label || 'Setup';
  return (OVERVIEW_ITEMS.find((x) => x.id === item) || {}).label || 'Overview';
}

export function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let section = parts[0] || 'overview';
  if (!SECTIONS.some((s) => s.id === section)) section = 'overview';
  const item = parts[1] || defaultItem(section);
  const tabs = tabsFor(section, item);
  const tab = parts[2] || (tabs[0] ? tabs[0][0] : '');
  return { section, item, tab, tabs };
}
