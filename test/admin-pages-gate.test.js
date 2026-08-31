/* ═══════════════════════════════════════════════════════════════════════════
   The session gate covers whole pages, not scattered files

   ADMIN_PAGES lists individual paths, so a page and its assets can end up on
   opposite sides of the gate — and BOTH directions are real bugs that fail
   quietly:

     · asset gated, page not — the page is served to anonymous visitors and
       renders unstyled, which looks like a broken site rather than a refusal.
       This happened: station.html was added linking admin.css, which was
       already gated, and the page itself was not.

     · page gated, asset not — the gate reads as protection it does not give,
       and the un-gated file is served to anyone who asks for it by name.

   Written against the CLASS: it walks whatever ADMIN_PAGES actually contains
   and checks the local assets each gated page references, so a page added later
   is covered without anyone remembering this file exists.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** The gated path set, read from the source rather than duplicated here. */
function gatedPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const block = src.match(/const ADMIN_PAGES = new Set\(\[?([\s\S]*?)\]?\);/);
  assert.ok(block, 'ADMIN_PAGES could not be located in server.js');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/** Local stylesheets and scripts a page pulls in, as server paths. */
function assetsOf(htmlPath) {
  const html = fs.readFileSync(path.join(ROOT, 'public', htmlPath), 'utf8');
  const refs = [
    ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ];
  return refs
    .filter((r) => !/^https?:\/\//.test(r))          // fonts and CDNs are not ours
    .map((r) => (r.startsWith('/') ? r : '/' + r));
}

test('every asset a gated page loads is gated too', () => {
  const gated = gatedPaths();
  const problems = [];

  for (const p of gated) {
    if (!p.endsWith('.html')) continue;
    for (const asset of assetsOf(p.slice(1))) {
      if (!gated.has(asset)) problems.push(`${p} loads ${asset}, which is NOT gated`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every gated asset belongs to a gated page', () => {
  // The other direction. A stylesheet behind the gate whose page is not behind
  // it serves that page unstyled to precisely the visitor being turned away.
  const gated = gatedPaths();
  const pages = [...gated].filter((p) => p.endsWith('.html'));
  const referenced = new Set(pages.flatMap((p) => assetsOf(p.slice(1))));

  const orphans = [...gated].filter((p) => !p.endsWith('.html') && !referenced.has(p));
  assert.deepEqual(orphans, [], `gated but loaded by no gated page: ${orphans.join(', ')}`);
});

test('the page that edits alert recipients is gated', () => {
  // Not merely an instance of the rule above: this is the one page in the app
  // whose visible content can be a list of named individuals' addresses, so it
  // is asserted by name rather than left to a general check.
  //
  // Recipients briefly lived on a station.html of their own. That page was
  // folded into the admin panel because the split assumed two kinds of login
  // and there is one — but the gate it needed did not become less necessary
  // for moving, which is what this asserts.
  const gated = gatedPaths();
  for (const p of ['/admin.html', '/admin.js', '/admin.css']) {
    assert.ok(gated.has(p), `${p} must require a session`);
  }

  const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  assert.match(admin, /alerts/i, 'the recipient editor is expected to live in the gated admin page');
});

test('every gated path is a file that actually exists', () => {
  // A typo'd entry protects nothing and looks like it does.
  for (const p of gatedPaths()) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', p.slice(1))), `${p} is listed but does not exist`);
  }
});
