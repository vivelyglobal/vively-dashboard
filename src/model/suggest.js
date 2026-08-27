import { TODAY, DAY } from '../lib/dates.js';

/* auto-suggest scoring: how well a creator fits a campaign */
export function suggestScore(cr, cp) {
  let s = 0;
  const reasons = [];
  if (cr.flag === 'blocked') return { score: 0, blocked: true, reasons: ['blacklisted'] };
  if (cr.flag === 'preferred') { s += 12; reasons.push('preferred creator'); }
  if (cr.flag === 'caution') { s -= 20; reasons.push('flagged — caution'); }
  if (cr.categories.includes(cp.category)) { s += 28; reasons.push('category match'); }
  else if (cr.categories.some((c) => ['Beauty', 'Skincare'].includes(c) && ['Beauty', 'Skincare'].includes(cp.category))) { s += 14; reasons.push('adjacent category'); }
  if (cr.country === cp.market) { s += 16; reasons.push('in target market'); }
  if (cr.followers >= cp.minFollowers) { s += 10; } else { s -= 25; reasons.push('below min followers'); }
  if (cp.platforms.includes(cr.platform)) { s += 10; reasons.push(cr.platform); }
  if (cr.er >= 4) { s += 8; reasons.push('ER ' + cr.er + '%'); }
  if (cr.reliability >= 4.3) { s += 12; reasons.push('reliable (' + cr.reliability + ')'); }
  if (cr.campaignsDone >= 2) { s += 8; reasons.push(cr.campaignsDone + ' past campaigns'); }
  if (cr.lastWorked && (TODAY - new Date(cr.lastWorked)) / DAY < 45) { s -= 14; reasons.push('worked recently'); }
  if (cr.tags.includes('needs reminders')) { s -= 6; }
  return { score: Math.max(0, Math.min(100, Math.round(s + 8))), reasons: reasons.slice(0, 3) };
}
