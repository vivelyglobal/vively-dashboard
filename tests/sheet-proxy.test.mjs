/* server/sheet-proxy.js — the read-only relay between Setup → Sheet
   metrics and Google Sheets.

   Google is never contacted here: a stand-in fetch answers the way
   docs.google.com does (a viewer page, a CSV, a sign-in redirect), and
   records every URL it was asked for, so the tests can also prove the
   relay only ever asks docs.google.com. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { mountSheetProxy, parseSheetRef, parseSheetTabs } = require('../server/sheet-proxy.js');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab';
const EDIT = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=482910`;

/* ---- links ---------------------------------------------------------- */

test('a normal edit link gives the Sheet id and the open tab as a hint', () => {
  assert.deepEqual(parseSheetRef(EDIT), { id: ID, published: false, gidHint: '482910' });
  assert.deepEqual(parseSheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`),
    { id: ID, published: false, gidHint: '' });
  assert.equal(parseSheetRef(ID).id, ID);
});

test('a published-to-web link is recognised as one', () => {
  const r = parseSheetRef('https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml');
  assert.equal(r.published, true);
  assert.equal(r.id, '2PACX-1vQabcdefghijklmnopqrstuvwxyz');
});

test('anything else is refused', () => {
  for (const bad of ['', 'hello', 'https://evil.example/x', 'https://docs.google.com/spreadsheets/d/short/edit', '../../etc']) {
    assert.equal(parseSheetRef(bad), null, bad);
  }
});

/* ---- the tab list --------------------------------------------------- */

const VIEWER = `<html><head><title>Master - Google Drive</title></head><body>
<ul id="sheet-menu">
  <li id="sheet-button-0"><a href="#">README</a></li>
  <li id="sheet-button-482910"><a href="#">KOWORK</a></li>
  <li id="sheet-button-77"><a href="#">R&amp;D &lt;test&gt;</a></li>
</ul>
<script>var items = [];
items.push({name: "README", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/${ID}\\/htmlview\\/sheet?headers\\x3dtrue\\x26gid\\x3d0", gid: "0",initialSheet: ("0" == gid)});
items.push({name: "KOWORK", pageUrl: "x", gid: "482910",initialSheet: false});
items.push({name: "\\uc790\\uc784\\ub2f9", pageUrl: "x", gid: "1300",initialSheet: false});
</script></body></html>`;

test('every tab is read from the viewer page, with its gid, once each', () => {
  assert.deepEqual(parseSheetTabs(VIEWER), [
    { gid: '0', name: 'README' },
    { gid: '482910', name: 'KOWORK' },
    { gid: '1300', name: '자임당' },
    { gid: '77', name: 'R&D <test>' }
  ]);
});

test('either half of the page is enough on its own', () => {
  const scriptOnly = VIEWER.replace(/<ul[\s\S]*?<\/ul>/, '');
  const markupOnly = VIEWER.replace(/<script>[\s\S]*?<\/script>/, '');
  assert.deepEqual(parseSheetTabs(scriptOnly).map((t) => t.name), ['README', 'KOWORK', '자임당']);
  assert.deepEqual(parseSheetTabs(markupOnly).map((t) => t.name), ['README', 'KOWORK', 'R&D <test>']);
  assert.deepEqual(parseSheetTabs('<html>nothing here</html>'), []);
});

/* ---- the routes, against a stand-in Google -------------------------- */

const CSV = 'deliverable_id,post_url,views\nD1,"https://www.instagram.com/reel/A/",100\n';

function fakeGoogle(behaviour) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const r = behaviour(url) || { status: 404, body: 'Not Found' };
    return {
      status: r.status || 200, ok: (r.status || 200) < 400, url: r.finalUrl || url,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (r.type || 'text/html') : null) },
      text: async () => r.body
    };
  };
  return { fetchImpl, asked };
}

async function serve(fetchImpl, { staff = true } = {}) {
  const app = express();
  const requireStaff = (h) => (req, res) => (staff ? h(req, res) : res.status(401).json({ error: 'Sign in to continue.' }));
  mountSheetProxy(app, { requireStaff, fetchImpl });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  return { get, close: () => srv.close() };
}
const q = (o) => '?' + new URLSearchParams(o).toString();

test('GET /tabs lists the tabs of a normal edit link through the viewer page', async () => {
  const g = fakeGoogle((u) => (u.endsWith('/htmlview') ? { body: VIEWER } : null));
  const s = await serve(g.fetchImpl);
  try {
    const r = await s.get('/api/sheet-metrics/tabs' + q({ sheet: EDIT }));
    assert.equal(r.status, 200);
    assert.equal(r.body.gidHint, '482910');
    assert.deepEqual(r.body.tabs.map((t) => t.name), ['README', 'KOWORK', '자임당', 'R&D <test>']);
    assert.deepEqual(g.asked, [`https://docs.google.com/spreadsheets/d/${ID}/htmlview`]);
  } finally { s.close(); }
});

test('GET /csv reads one tab by gid through the export URL', async () => {
  const g = fakeGoogle((u) => (u.includes('/export?format=csv&gid=482910') ? { body: CSV, type: 'text/csv' } : null));
  const s = await serve(g.fetchImpl);
  try {
    const r = await s.get('/api/sheet-metrics/csv' + q({ sheet: EDIT, gid: '482910' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.csv, CSV);
    assert.deepEqual(g.asked, [`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=482910`]);
  } finally { s.close(); }
});

test('with no gid a tab is read by name', async () => {
  const g = fakeGoogle((u) => (u.includes('/gviz/tq?') ? { body: CSV, type: 'text/csv' } : null));
  const s = await serve(g.fetchImpl);
  try {
    const r = await s.get('/api/sheet-metrics/csv' + q({ sheet: EDIT, name: 'KOWORK' }));
    assert.equal(r.status, 200);
    assert.match(g.asked[0], /gviz\/tq\?tqx=out:csv&headers=1&sheet=KOWORK$/);
  } finally { s.close(); }
});

test('a published Sheet is read through its pub URLs', async () => {
  const pub = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml';
  const g = fakeGoogle((u) => (u.endsWith('/pubhtml') ? { body: VIEWER }
    : u.includes('/pub?output=csv') ? { body: CSV, type: 'text/csv' } : null));
  const s = await serve(g.fetchImpl);
  try {
    assert.equal((await s.get('/api/sheet-metrics/tabs' + q({ sheet: pub }))).body.tabs.length, 4);
    assert.equal((await s.get('/api/sheet-metrics/csv' + q({ sheet: pub, gid: '482910' }))).body.csv, CSV);
    assert.match(g.asked[1], /\/pub\?output=csv&single=true&gid=482910$/);
  } finally { s.close(); }
});

test('a Sheet that is not shared says how to share it', async () => {
  const g = fakeGoogle(() => ({ body: '<html><title>Sign in - Google Accounts</title></html>',
    finalUrl: 'https://accounts.google.com/ServiceLogin?continue=x' }));
  const s = await serve(g.fetchImpl);
  try {
    for (const path of ['/api/sheet-metrics/tabs' + q({ sheet: EDIT }), '/api/sheet-metrics/csv' + q({ sheet: EDIT, gid: '1' })]) {
      const r = await s.get(path);
      assert.equal(r.status, 403);
      assert.match(r.body.error, /Anyone with the link/);
    }
  } finally { s.close(); }
});

test('a web page where CSV was expected is an error, not rows', async () => {
  const g = fakeGoogle(() => ({ body: '<!DOCTYPE html><html>…</html>', type: 'text/html' }));
  const s = await serve(g.fetchImpl);
  try {
    const r = await s.get('/api/sheet-metrics/csv' + q({ sheet: EDIT, gid: '1' }));
    assert.equal(r.status, 502);
    assert.equal(r.body.ok, false);
  } finally { s.close(); }
});

test('a viewer page with no readable tabs asks for them by hand', async () => {
  const g = fakeGoogle(() => ({ body: '<html>a redesign</html>' }));
  const s = await serve(g.fetchImpl);
  try {
    const r = await s.get('/api/sheet-metrics/tabs' + q({ sheet: EDIT }));
    assert.equal(r.status, 502);
    assert.match(r.body.error, /by hand/);
  } finally { s.close(); }
});

test('Google unreachable, or 404, is reported as such', async () => {
  const down = await serve(async () => { throw new Error('ECONNRESET'); });
  const gone = await serve(fakeGoogle(() => ({ status: 404, body: 'x' })).fetchImpl);
  try {
    const a = await down.get('/api/sheet-metrics/tabs' + q({ sheet: EDIT }));
    assert.equal(a.status, 502); assert.match(a.body.error, /could not reach Google/);
    const b = await gone.get('/api/sheet-metrics/tabs' + q({ sheet: EDIT }));
    assert.equal(b.status, 404);
  } finally { down.close(); gone.close(); }
});

test('bad input never reaches Google, and nothing but docs.google.com is ever asked', async () => {
  const g = fakeGoogle(() => ({ body: CSV, type: 'text/csv' }));
  const s = await serve(g.fetchImpl);
  try {
    assert.equal((await s.get('/api/sheet-metrics/tabs' + q({ sheet: 'https://evil.example/spreadsheets/x' }))).status, 400);
    assert.equal((await s.get('/api/sheet-metrics/csv' + q({ sheet: EDIT, gid: '1&x=https://evil' }))).status, 400);
    assert.equal((await s.get('/api/sheet-metrics/csv' + q({ sheet: EDIT }))).status, 400);
    assert.equal(g.asked.length, 0);
    await s.get('/api/sheet-metrics/csv' + q({ sheet: 'https://evil.example/spreadsheets/d/' + ID + '/edit', gid: '5' }));
    assert.ok(g.asked.every((u) => u.startsWith('https://docs.google.com/spreadsheets/d/')), g.asked.join());
  } finally { s.close(); }
});

test('both routes are staff only', async () => {
  const g = fakeGoogle(() => ({ body: VIEWER }));
  const s = await serve(g.fetchImpl, { staff: false });
  try {
    assert.equal((await s.get('/api/sheet-metrics/tabs' + q({ sheet: EDIT }))).status, 401);
    assert.equal((await s.get('/api/sheet-metrics/csv' + q({ sheet: EDIT, gid: '0' }))).status, 401);
    assert.equal(g.asked.length, 0);
  } finally { s.close(); }
});
