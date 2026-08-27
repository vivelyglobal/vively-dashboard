import { DB, byCreator, byCampaign } from './db.js';
import { parseVisitSlot } from '../import/notion.js';

/* ============================================================
   VISIT CALENDAR
   Store-visit and salon campaigns live or die on who is coming
   in on which day. Every participant with a booked slot (from
   their Notion form answer, an Excel import, or typed in by
   hand) shows up here as a dot on that date.
   ============================================================ */
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* every participant who has a readable visit slot, grouped by day */
export function visitsByDay(campaignId) {
  const map = {};
  DB.participants.forEach((p) => {
    if (!p.visitAt) return;
    if (campaignId && p.campaignId !== campaignId) return;
    const d = parseVisitSlot(p.visitAt);
    if (!d) return;
    const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId];
    if (!cr || !cp) return;
    const k = dayKey(d);
    (map[k] = map[k] || []).push({ p, cr, cp, at: d });
  });
  Object.values(map).forEach((list) => list.sort((a, b) => a.at - b.at));
  return map;
}
