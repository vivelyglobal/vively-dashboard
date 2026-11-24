import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* The REAL server.js on its own port with a bare env (no Mongo, no staff
   list). Proves the wiring: the brand page and API are mounted with their
   headers, the staff routes sit behind the real requireStaff, client.html is
   served, and nothing the static deny-list refused before is served now. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let child, PORT;
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); r.end(body);
  });
}
before(async () => {
  PORT = await freePort();
  const env = { PATH: process.env.PATH, PORT: String(PORT) };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('VIVELY app listening on port')) { clearTimeout(t); resolve(); } });
    child.on('exit', () => reject(new Error('server exited early')));
  });
});
after(() => { if (child) child.kill(); });

test('page: /c/<token> serves client.html with the brand headers, for any token (the page decides nothing)', async () => {
  const r = await req('/c/abcdefgh12345678');
  assert.equal(r.status, 200);
  assert.equal(r.body, fs.readFileSync(ROOT + 'client.html', 'utf8'));
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.headers['x-robots-tag'], /noindex/);
});

test('api: /api/client/<token> carries the headers on the error path too', async () => {
  const r = await req('/api/client/abcdefgh12345678');
  assert.equal(r.status, 503, 'no Mongo in this run');
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-frame-options'], 'DENY');
});

test('api: 30 reads of one token, then 429 (real limiter, real IP rule)', async () => {
  const s = [];
  for (let i = 0; i < 32; i++) s.push((await req('/api/client/limitedtoken0001')).status);
  assert.equal(s[29], 503); assert.equal(s[30], 429);
});

test('staff: every management route is 401 without a session (real requireStaff), and is not a brand route', async () => {
  for (const [method, path] of [['GET', '/api/client-links'], ['GET', '/api/client-links/status'], ['POST', '/api/client-links'],
    ['POST', '/api/client-links/rebuild'], ['POST', '/api/client-links/lnk_abcdefgh/regenerate'], ['POST', '/api/client-links/lnk_abcdefgh/revoke']]) {
    const r = await req(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 401, method + ' ' + path);
    assert.equal(r.headers['content-security-policy'], undefined, 'the brand-page CSP must not sit on a staff route: ' + path);
  }
});

test('static: client.html is a public page like partner.html, and the deny-list still refuses what it refused', async () => {
  assert.equal((await req('/client.html')).status, 200);
  for (const p of ['/server.js', '/server/client-views.js', '/server/auth.js', '/tests/client-views.test.mjs', '/package.json',
    '/render.yaml', '/.env', '/./server.js', '/src/main.jsx', '/data/users.json', '/docs/DASHBOARD-OVERVIEW.md', '/tmp/seed.json']) {
    const r = await req(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('createClientViews'), p);
  }
  for (const p of ['/', '/index.html', '/partner.html', '/book.html', '/api/health', '/partner/abcdefgh12']) assert.equal((await req(p)).status, 200, p);
});

test('the existing partner API is untouched: same 503 without Mongo, same headers', async () => {
  const r = await req('/api/partner/abcdefgh12');
  assert.equal(r.status, 503);
  assert.match(r.headers['cache-control'], /no-store/);
});
