export const TODAY = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
export const DAY = 86400000;
export const addDays = (d, n) => new Date(d.getTime() + n * DAY);
export const iso = (d) => d.toISOString().slice(0, 10);
export const dLabel = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
