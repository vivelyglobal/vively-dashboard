/* DESIGN TOKENS AND THE BRAND SKIN.

   The dashboard has no browser in the test run, so nothing here looks at
   pixels. What can be pinned down without one is pinned down:

     - every var(--name) the file reads is defined somewhere;
     - every text/background pair the redesign spec lists clears 4.5:1,
       computed from the hex values that are actually in the stylesheet
       (no rounding up: 4.499 fails);
     - the 12px floor holds in the Desk, Home and Today views;
     - there is a visible :focus-visible rule for rail items, tabs and cards;
     - the brand skin is ONE block, and removing it leaves a working sheet.

   Set PRINT_CONTRAST=1 to print the measured table. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SPLIT_CSS = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const STYLE = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>'));
const BEGIN = '/* ==== VIVELY-SKIN:BEGIN';
const END = '/* ==== VIVELY-SKIN:END ==== */';
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- a small colour toolkit ---------- */

function blocks(css) {                                  /* top-level :root and :root[light] blocks, in order */
  const out = [];
  const re = /(?:^|\n)(:root(?:\[data-theme="light"\])?)\s*\{([^}]*)\}/g;
  let m;
  const clean = stripComments(css);
  while ((m = re.exec(clean))) out.push({ sel: m[1], body: m[2] });
  return out;
}
function themes(css) {
  const dark = {}, light = {};
  for (const b of blocks(css)) {
    const target = b.sel === ':root' ? [dark] : [light];
    for (const [, k, v] of b.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target[0][k] = v.trim();
  }
  return { dark, light: { ...dark, ...light } };
}
function resolve(v, map, depth = 0) {
  if (depth > 6) throw new Error('var loop: ' + v);
  const m = /^var\((--[\w-]+)\)$/.exec(v.trim());
  if (!m) return v.trim();
  if (!(m[1] in map)) throw new Error('undefined token ' + m[1]);
  return resolve(map[m[1]], map, depth + 1);
}
function rgba(v) {
  v = v.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16)).concat(1);
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error('cannot read colour ' + v);
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (hi + 0.05) / (lo + 0.05); };
/* paint layers bottom to top; each is a CSS colour or a [colour, alpha] override */
function paint(layers, map) {
  let base = null;
  for (const l of layers) {
    const [r, g, b, a] = Array.isArray(l) ? [...rgba(resolve(l[0], map)).slice(0, 3), l[1]] : rgba(resolve(l, map));
    base = base ? [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)] : [r, g, b];
  }
  return base;
}
const T = (n) => `var(--${n})`;

const TH = themes(STYLE);

/* every text pair the spec table and the Desk / Home rules rely on: [label, foreground, [background layers]] */
const TEXT_PAIRS = [
  ['body text on page',                     T('text'),    [T('bg')]],
  ['body text on card',                     T('text'),    [T('surface')]],
  ['secondary text on card',                T('text-2'),  [T('surface')]],
  ['secondary text on page',                T('text-2'),  [T('bg')]],
  ['secondary text on raised (surface-2)',  T('text-2'),  [T('surface-2')]],
  ['helper text (--text-3) on page',        T('text-3'),  [T('bg')]],
  ['helper text (--text-3) on card',        T('text-3'),  [T('surface')]],
  ['helper text (--text-3) on surface-2',   T('text-3'),  [T('surface-2')]],
  ['helper text (--text-3) on surface-3 (.hm-idle chip)', T('text-3'), [T('surface-3')]],
  ['link / tab / ghost button (--blue-hi) on page', T('blue-hi'), [T('bg')]],
  ['link / tab (--blue-hi) on card',        T('blue-hi'), [T('surface')]],
  ['link (--blue-hi) on surface-2',         T('blue-hi'), [T('surface-2')]],
  ['link (--blue-hi) on blue-soft over card (.chip.on, .tab.active)', T('blue-hi'), [T('surface'), T('blue-soft')]],
  ['link (--blue-hi) on blue-soft over page (.chip.on, .rail-item.active)', T('blue-hi'), [T('bg'), T('blue-soft')]],
  ['--blue as text on card (.cal-today)',   T('blue'),    [T('surface')]],
  ['--blue as text on page',                T('blue'),    [T('bg')]],
  ['primary button label (--on-accent) on --blue', T('on-accent'), [T('blue')]],
  ['Desk "to look at" (.dk-day .w), .big.warn: --warn-ink on card', T('warn-ink'), [T('surface')]],
  ['Desk .dk-day.on .w: --warn-ink on blue-soft over page (the chip replaces the card fill)', T('warn-ink'), [T('bg'), T('blue-soft')]],
  ['Desk .dk-chip.clash: --warn-ink on surface-2', T('warn-ink'), [T('surface-2')]],
  ['Desk .dk-stale: --warn-ink on --warn-bg over page', T('warn-ink'), [T('bg'), T('warn-bg')]],
  ['Desk .dk-q .ic amber: --warn-ink on --warn-bg-2 over card', T('warn-ink'), [T('surface'), T('warn-bg-2')]],
  ['Desk .dk-q .ic red: --danger on --danger-bg over card', T('danger'), [T('surface'), T('danger-bg')]],
  ['Desk .big.bad: --danger on card',       T('danger'),  [T('surface')]],
  ['Home .hm-risk chip: --danger on --danger-bg-soft over card', T('danger'), [T('surface'), T('danger-bg-soft')]],
  ['Home .hm-ok chip: --success on --success-bg over card', T('success'), [T('surface'), T('success-bg')]],
  ['Home .hm-att warn figure: --warn-ink on card', T('warn-ink'), [T('surface')]],
  ['Home .hm-att crit figure: --danger on card', T('danger'), [T('surface')]],
  ['--success on card',                     T('success'), [T('surface')]],
  ['.note.warn strong: --warn-ink on warn tint (.09) over page', T('warn-ink'), [T('bg'), ['rgb(250,178,25)', 0.09]]],
  ['.pl-age.warm: --warn-ink on warn tint (.12) over card', T('warn-ink'), [T('surface'), ['rgb(250,178,25)', 0.12]]],
  ['.pl-age.hot: --danger on red tint (.14) over card', T('danger'), [T('surface'), ['rgb(208,59,59)', 0.14]]],
  ['.pl-group.warn: --warn-ink on --warning 9% over surface-2', T('warn-ink'), [T('surface-2'), [T('warning'), 0.09]]]
];
const NONTEXT_PAIRS = [
  ['focus ring (--blue) on page',  T('blue'), [T('bg')]],
  ['focus ring (--blue) on card',  T('blue'), [T('surface')]]
];
/* light-only: the hover state of a primary button swaps to --blue-hi */
const LIGHT_ONLY = [['primary button hover: --on-accent on --blue-hi', T('on-accent'), [T('blue-hi')]]];

function measure(theme, [label, fg, bgs]) {
  const map = TH[theme];
  const f = paint([fg], map), b = paint(bgs, map);
  return { theme, label, ratio: ratio(f, b) };
}

test('contrast: every text pair clears 4.5:1 in both themes (unrounded)', () => {
  const rows = [];
  for (const theme of ['light', 'dark']) {
    for (const p of TEXT_PAIRS) rows.push(measure(theme, p));
  }
  for (const p of LIGHT_ONLY) rows.push(measure('light', p));
  if (process.env.PRINT_CONTRAST) {
    for (const r of rows) console.log(`${r.theme.padEnd(5)} ${r.ratio.toFixed(4).padStart(8)}  ${r.label}`);
  }
  const bad = rows.filter((r) => r.ratio < 4.5);
  assert.deepEqual(bad.map((r) => `${r.theme} ${r.ratio.toFixed(4)} ${r.label}`), []);
});

test('contrast: focus ring clears 3:1 against what it sits on', () => {
  const rows = [];
  for (const theme of ['light', 'dark']) for (const p of NONTEXT_PAIRS) rows.push(measure(theme, p));
  if (process.env.PRINT_CONTRAST) for (const r of rows) console.log(`${r.theme.padEnd(5)} ${r.ratio.toFixed(4).padStart(8)}  ${r.label}`);
  assert.deepEqual(rows.filter((r) => r.ratio < 3).map((r) => r.label), []);
});

test('the spec values are the ones in the sheet (blue, helper grey, status text)', () => {
  assert.equal(TH.light['--blue'], '#0b63f6');
  assert.equal(TH.dark['--blue'], '#4d8dff');
  assert.equal(TH.light['--text-3'], '#666666');
  assert.equal(TH.light['--danger'], '#b42318');
  assert.equal(TH.light['--success'], '#0b6b1f');
  assert.equal(TH.light['--warn-ink'], '#8a5a00');
  assert.equal(TH.dark['--danger'], '#f08a8a');
  assert.equal(TH.dark['--success'], '#6fce6f');
  assert.equal(TH.dark['--warn-ink'], '#f5c451');
  assert.equal(TH.dark['--text-3'], '#8f949a', 'dark helper text is unchanged');
  assert.equal(TH.dark['--bg'], '#101012', 'dark surfaces are unchanged');
});

test('radius, spacing, shadow and type tokens exist with the spec values', () => {
  const d = TH.dark;
  assert.equal(d['--r-sm'], '6px'); assert.equal(d['--r'], '10px'); assert.equal(d['--r-lg'], '16px');
  assert.equal(d['--r-pill'], '999px');
  [['--sp-1', 4], ['--sp-2', 8], ['--sp-3', 12], ['--sp-4', 16], ['--sp-5', 24], ['--sp-6', 32], ['--sp-7', 48]]
    .forEach(([k, v]) => assert.equal(d[k], v + 'px', k));
  ['--shadow-1', '--shadow-2', '--r-inner', '--fs-eyebrow', '--fs-caption', '--fs-body', '--fs-card-title', '--fs-kpi',
    '--fs-title', '--fs-title-phone', '--ease', '--hit'].forEach((k) => assert.ok(k in d, k + ' missing'));
  assert.equal(TH.light['--shadow-1'], '0 1px 2px rgba(17,17,17,.05)');
  assert.equal(TH.light['--shadow-2'], '0 8px 24px rgba(17,17,17,.08)');
  /* every pre-existing token name is still defined */
  ['--bg', '--surface', '--surface-2', '--surface-3', '--line', '--line-strong', '--text', '--text-2', '--text-3',
    '--blue', '--blue-hi', '--blue-soft', '--blue-soft-2', '--s1', '--good', '--warning', '--serious', '--critical',
    '--shadow', '--r', '--r-lg', '--r-pill', '--rail', '--on-accent'].forEach((k) => assert.ok(k in d, k + ' lost'));
});

test('no var(--name) is read without being defined', () => {
  const css = stripComments(HTML);
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  [...css.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].forEach((m) => defined.add(m[1]));
  assert.deepEqual([...used].filter((n) => !defined.has(n)).sort(), []);
  ['--danger', '--success', '--warn-ink', '--amber', '--red', '--accent'].forEach((n) => assert.ok(defined.has(n), n));
});

test('there is no `transition: all` anywhere in the dashboard', () => {
  assert.equal(/transition\s*:\s*all\b/i.test(HTML), false);
});

test('text floor: nothing under 12px in Desk, Home or Today', () => {
  const lines = HTML.split('\n');
  const find = (re) => lines.findIndex((l) => re.test(l));
  const slices = {
    today: [find(/VIEW — TODAY \(the home page\)/), find(/^function renderToday/) + 130],
    home:  [find(/HOME — the page/), find(/VIEW — BOOKING/)],
    desk:  [find(/^function ensureDeskStyles/), find(/SYNC — SHEET METRICS  \(read-only\)/)]
  };
  const small = [];
  for (const [name, [a, b]] of Object.entries(slices)) {
    assert.ok(a >= 0 && b > a, name + ' slice not found');
    lines.slice(a, b).forEach((l, i) => {
      const code = l.replace(/\/\*.*?\*\//g, '');
      for (const m of code.matchAll(/font-size\s*:\s*([\d.]+)px/g)) if (+m[1] < 12) small.push(`${name}:${a + i + 1} ${m[0]}`);
      for (const m of code.matchAll(/font\s*:\s*[\w-]+\s+([\d.]+)px/g)) if (+m[1] < 12) small.push(`${name}:${a + i + 1} ${m[0]}`);
      for (const m of code.matchAll(/font-size="([\d.]+)"/g)) if (+m[1] < 12) small.push(`${name}:${a + i + 1} ${m[0]}`);
    });
  }
  assert.deepEqual(small, []);
});

test('Desk and Home colour their status text with tokens, not dark-theme hex', () => {
  const lines = HTML.split('\n');
  const a = lines.findIndex((l) => /^function ensureDeskStyles/.test(l));
  const b = lines.findIndex((l) => /SYNC — SHEET METRICS  \(read-only\)/.test(l));
  const desk = lines.slice(a, b).join('\n');
  assert.equal(/#f08a8a|#f5c451|rgba\(250,\s*178,\s*25|rgba\(208,\s*59,\s*59/i.test(desk), false);
  const h0 = lines.findIndex((l) => /HOME — the page/.test(l));
  const h1 = lines.findIndex((l) => /VIEW — BOOKING/.test(l));
  const home = lines.slice(h0, h1).join('\n');
  assert.equal(/var\(--warning\)/.test(home.split('\n').filter((l) => /\.hm-att .row\.warn \.tx b/.test(l)).join('\n')), false);
  assert.match(desk, /\.dk-day \.w\{[^}]*color:var\(--warn-ink\)/);
});

test('keyboard focus: one visible blue ring, including rail items, tabs and cards', () => {
  const skin = STYLE.slice(STYLE.indexOf(BEGIN), STYLE.indexOf(END));
  assert.match(skin, /(^|\n):focus-visible\s*\{\s*outline:\s*2px solid var\(--blue\)/);
  assert.match(skin, /\.rail-item:focus-visible/);
  assert.match(skin, /\.tab:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(skin, /\.card-link:focus-visible::after\s*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(skin, /\.card\[tabindex\]:focus-visible/);
  assert.match(skin, /\.btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  /* nothing in the skin switches an outline off without drawing another */
  assert.equal(/outline\s*:\s*(none|0)\b/.test(skin), false);
});

test('the brand skin is one block with the rules the spec asks for', () => {
  assert.equal(STYLE.split(BEGIN).length, 2, 'exactly one BEGIN marker');
  assert.equal(STYLE.split(END).length, 2, 'exactly one END marker');
  assert.ok(STYLE.indexOf(BEGIN) < STYLE.indexOf(END));
  const skin = STYLE.slice(STYLE.indexOf(BEGIN), STYLE.indexOf(END));
  assert.match(skin, /\.btn, \.btn\.sm, \.btn\.xs \{ border-radius: var\(--r-pill\)/);
  assert.match(skin, /\.btn\.primary \{ background: var\(--blue\);[^}]*color: var\(--on-accent\)/);
  assert.match(skin, /\[data-theme="light"\] \.seg button\.active[\s\S]*?background: var\(--surface\); box-shadow: var\(--shadow-1\)/);
  assert.match(skin, /\.card \{ border-radius: var\(--r-lg\)/);
  assert.match(skin, /\.card \.card \{ border-radius: var\(--r-inner\)/);
  assert.match(skin, /\.eyebrow \{/); assert.match(skin, /\.page-title \{[^}]*text-wrap: balance/);
  assert.match(skin, /min-height: var\(--hit\)/);
  assert.match(skin, /@media \(max-width: 760px\) \{\s*:root \{ --hit: 44px; \}/);
  assert.match(skin, /:active[\s\S]*?transform: scale\(\.97\)/);
  assert.match(skin, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(skin, /font-variant-numeric: tabular-nums/);
  /* the transitions it declares name their properties */
  for (const m of skin.matchAll(/transition\s*:\s*([^;]+);/g)) assert.doesNotMatch(m[1], /\ball\b/);
});

test('removing the skin block leaves nothing undefined, and brings back the old accent and radii', () => {
  const without = HTML.slice(0, HTML.indexOf(BEGIN)) + HTML.slice(HTML.indexOf(END) + END.length);
  const css = stripComments(without);
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  /* a var() written with a fallback may point at nothing; one without may not */
  const bare = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
  assert.deepEqual([...bare].filter((n) => !defined.has(n)).sort(), []);
  const old = themes(without.slice(without.indexOf('<style>') + 7));
  assert.equal(old.dark['--blue'], '#9b8cff');
  assert.equal(old.light['--blue'], '#5b45e0');
  assert.equal(old.dark['--r-lg'], '14px');
});

test('microcopy: the plain-words strings are in the code and the old ones are gone', () => {
  const must = ['Check the sheet for new numbers', 'Engagement rate is written as',
    "Ignore zeros (the scraper often means 'not read')", 'No numbers yet'];
  must.forEach((s) => assert.ok(HTML.includes(s), s));
  ['Treat as blank', 'post_er in the Sheet', 'Apply: update', '>Read the Sheet<', "'unmeasured' : '—'"]
    .forEach((s) => assert.equal(HTML.includes(s), false, s));
});

test('src/ carries the same stylesheet and the same Desk and Home rules as index.html', () => {
  assert.ok(SPLIT_CSS.includes(BEGIN) && SPLIT_CSS.includes(END));
  assert.equal(SPLIT_CSS.trim(), STYLE.trim().split('\n').slice(0).join('\n').trim().replace(/^\n+/, ''), 'styles.css is the head stylesheet verbatim');
  const desk = fs.readFileSync(new URL('../src/views/desk.js', import.meta.url), 'utf8');
  const home = fs.readFileSync(new URL('../src/views/home.js', import.meta.url), 'utf8');
  assert.match(desk, /var\(--warn-ink\)/); assert.match(home, /var\(--hm-gap-sec,44px\)/);
});
