/* ============================================================
   METRICS
   ============================================================ */
export const nf  = new Intl.NumberFormat('en-US');
export const num = (v) => nf.format(Math.round(v || 0));
export const kmb = (v) => {
  v = v || 0;
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(v));
};
export const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
export const won = (v) => '₩' + nf.format(Math.round(v || 0));
export const wonK = (v) => {
  v = v || 0;
  if (v >= 1e8) return '₩' + (v / 1e8).toFixed(2).replace(/\.00$/, '') + '억';
  if (v >= 1e4) return '₩' + nf.format(Math.round(v / 1e4)) + '만';
  return '₩' + nf.format(Math.round(v));
};
export const money2 = (v) => '₩' + (v >= 100 ? nf.format(Math.round(v)) : v.toFixed(1));

export const engagementsOf = (c) => c ? (c.likes + c.comments + c.shares + c.saves) : 0;
