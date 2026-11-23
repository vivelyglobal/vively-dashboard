import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* Real server, own port, no Mongo / Notion env at all. Raw paths are sent
   exactly as written (http.request does not normalise), which is what curl
   --path-as-is and scripts do and a browser does not. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let child, PORT;
const SOURCE_MARK = 'VIVELY app listening on port';

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function req(path, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (chunks) { chunks.forEach((c) => r.write(c)); r.end(); } else r.end(body);
  });
}

before(async () => {
  PORT = await freePort();
  const env = { PATH: process.env.PATH, PORT: String(PORT) };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes(SOURCE_MARK)) { clearTimeout(t); resolve(); } });
    child.on('exit', () => reject(new Error('server exited early')));
  });
});
after(() => { if (child) child.kill(); });

const DENIED = ['/server.js', '/./server.js', '/%2e/server.js', '/%2E/server.js', '/x/../server.js', '/x/%2e%2e/server.js',
  '/.//server.js', '/%2E%2E/', '/%2e%2e/server.js', '/%2e%2e%2fserver.js', '/SERVER.JS', '/Server.Js', '//server.js',
  '/server.js.', '/server.js%20', '/server.js%2e', '/server.js%00.html', '/%00', '/%5cserver.js', '/\\server.js',
  '/./src/main.jsx', '/./package.json', '/%2e/ARCHITECTURE.md', '/Src/main.jsx', '/dist/../server.js',
  '/server/auth.js', '/./server/auth.js', '/data/users.json', '/./data/users.json', '/tests/partner.test.mjs',
  '/tools/seed.mjs', '/docs/REFERENCE.md', '/README.md', '/render.yaml', '/package-lock.json', '/vite.config.mjs',
  '/node_modules/express/package.json', '/.git/config', '/.env', '/a/./b', '/%zz'];

for (const p of DENIED) {
  test('static: ' + JSON.stringify(p) + ' is refused and never returns source', async () => {
    const r = await req(p);
    assert.ok(!r.body.includes(SOURCE_MARK), 'server source returned');
    assert.ok(!r.body.includes('"dependencies"') && !r.body.includes('services:'), 'config returned');
    assert.equal(r.status, 404);
  });
}

test('static: the production pages still serve', async () => {
  for (const p of ['/', '/index.html', '/partner.html', '/book.html', '/api/health']) {
    const r = await req(p);
    assert.equal(r.status, 200, p);
  }
  assert.ok((await req('/partner.html')).body.includes('safeHref'));
  assert.equal((await req('/partner/abcdefgh12')).status, 200);
});

test('static: built assets under dist/next still serve', async () => {
  const dir = new URL('../dist/next/assets/', import.meta.url);
  if (!fs.existsSync(dir)) return;
  const f = fs.readdirSync(dir).find((n) => n.endsWith('.css'));
  if (!f) return;
  assert.equal((await req('/next/assets/' + f)).status, 200);
  assert.equal((await req('/dist/next/assets/' + f)).status, 200);
});

test('comment route: a chunked body over 8 KB is refused with 413 before the global parser', async () => {
  const big = JSON.stringify({ pid: 'a-c1', text: 'x'.repeat(20000), author: 'a' });
  const r = await req('/api/partner/abcdefgh12/comment', { method: 'POST',
    headers: { 'content-type': 'application/json' }, chunks: [big.slice(0, 9000), big.slice(9000)] });
  assert.equal(r.status, 413);
  assert.ok(JSON.parse(r.body).error);
});

test('comment route: a declared-large body is 413; a small one passes the size gate', async () => {
  const big = JSON.stringify({ pid: 'p', text: 'x'.repeat(20000) });
  const r = await req('/api/partner/abcdefgh12/comment', { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) }, body: big });
  assert.equal(r.status, 413);
  const ok = await req('/api/partner/abcdefgh12/comment', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: 'p', text: 'hi' }) });
  assert.equal(ok.status, 503, 'no Mongo here, so a small body reaches the handler');
});

test('limiter: a spoofed first x-forwarded-for entry does not buy a fresh bucket', async () => {
  const statuses = [];
  for (let i = 0; i < 75; i++) {
    const r = await req('/api/partner/tokentoken' + String(i).padStart(3, '0'),
      { headers: { 'x-forwarded-for': 'spoof' + i + ', 203.0.113.7' } });
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(429), 'rotating the first entry escaped the limit: ' + [...new Set(statuses)]);
  const other = await req('/api/partner/tokentokenzzz', { headers: { 'x-forwarded-for': 'spoof, 203.0.113.99' } });
  assert.notEqual(other.status, 429, 'a different real client must not be limited');
});
