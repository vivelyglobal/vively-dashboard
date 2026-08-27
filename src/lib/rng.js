"use strict";
/* ============================================================
   DATA LAYER — starts empty.
   Campaigns arrive either from the New campaign form or from an
   Excel import; creators arrive with them, or via CSV import.
   Everything lives in memory for the session — export the
   workspace JSON from Setup → Data sources to keep a copy.
   ============================================================ */

/* small deterministic helpers still used for ids and demo curves */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const RNG = mulberry32(20260819);
export const rnd = () => RNG();
export const ri  = (a, b) => Math.floor(a + RNG() * (b - a + 1));
export const rf  = (a, b) => a + RNG() * (b - a);
