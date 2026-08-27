/* blacklist / preference flags feed both suggestions and search */
export const SETTINGS = { hideBlocked: true };
export const isBlocked = (cr) => cr.flag === 'blocked';
export function selectable(list) { return SETTINGS.hideBlocked ? list.filter((c) => !isBlocked(c)) : list; }
