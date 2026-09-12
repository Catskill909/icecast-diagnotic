/* ═══════════════════════════════════════════════════════════════════════════
   The sign-in page can load everything it needs without a session

   With REQUIRE_LOGIN_FOR_READ=true, every path outside ALWAYS_PUBLIC redirects
   or 401s until the visitor signs in. The sign-in page is the one page that
   visitor can see, so any file it pulls in that is missing from the list
   renders broken for exactly the person it exists to serve — and nobody signed
   in ever notices, because for them the file loads fine.

   Written against the CLASS: it walks every local stylesheet, script and image
   login.html references, so an asset added later is covered automatically.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** The public path set, read from the source rather than duplicated here. */
function publicPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const block = src.match(/const ALWAYS_PUBLIC = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'ALWAYS_PUBLIC could not be located in server.js');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/** Local stylesheets, scripts and images a page pulls in, as server paths. */
function assetsOf(htmlPath) {
  const html = fs.readFileSync(path.join(ROOT, 'public', htmlPath), 'utf8');
  const refs = [
    ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<(?:script|img)[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ];
  return refs
    .filter((r) => !/^(https?:|data:)/.test(r))       // fonts, CDNs and inline data are not ours
    .map((r) => (r.startsWith('/') ? r : '/' + r))
    .map((r) => r.split('?')[0]);                     // the gate matches req.path, without the query
}

test('every local asset the sign-in page loads is always public', () => {
  const open = publicPaths();
  const missing = assetsOf('login.html').filter((a) => !open.has(a));
  assert.deepEqual(missing, [], `login.html loads files a signed-out visitor cannot fetch: ${missing.join(', ')}`);
});

test('the sign-in page loads the header logo, so the check above has something to cover', () => {
  assert.ok(assetsOf('login.html').includes('/pacifica-network-header.png'));
});

test('every always-public file path actually exists', () => {
  // A typo'd entry opens nothing and looks like it does. /health is a route, not a file.
  for (const p of publicPaths()) {
    if (p === '/health') continue;
    assert.ok(fs.existsSync(path.join(ROOT, 'public', p.slice(1))), `${p} is listed but does not exist`);
  }
});
