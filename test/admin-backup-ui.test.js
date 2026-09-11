/* ═══════════════════════════════════════════════════════════════════════════
   The backup panel in the admin page

   This is the one control in the product that can destroy the record. It is
   used rarely, by one person, usually while something else has already gone
   wrong — which is exactly when a confirmation gets clicked through.

   So the properties worth pinning are not "the button exists". They are:
   the file is DESCRIBED before anything is replaced, the destructive step goes
   through the same confirmation every other destructive action uses, and the
   text says what survives rather than asking a question the reader cannot
   answer.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/admin.css'), 'utf8');

/** The block of admin.js that implements the panel. */
const panel = js.slice(js.indexOf('  /* ── Backup and move'), js.indexOf("  $('logout')"));

test('the panel exists, and its controls are wired', () => {
  for (const id of ['export-btn', 'import-pick', 'import-file', 'import-preview', 'import-msg', 'export-msg']) {
    assert.ok(html.includes(`id="${id}"`), `admin.html is missing #${id}`);
  }
  assert.match(panel, /\$\('export-btn'\)\.addEventListener/);
  assert.match(panel, /\$\('import-file'\)\.addEventListener/);
});

test('the file is DESCRIBED before anything can be replaced', () => {
  const previewAt = panel.indexOf('/api/import/preview');
  const importAt = panel.indexOf("api('/api/import'");
  assert.ok(previewAt > -1, 'the preview endpoint must be called');
  assert.ok(importAt > -1, 'the import endpoint must be called');
  assert.ok(previewAt < importAt, 'preview must come first — nobody should replace a file they have not seen');
});

test('restoring goes through the shared confirmation, not a bare click', () => {
  assert.match(panel, /await confirmAction\(\{/, 'the same dialog every other destructive action uses');
  const confirmAt = panel.indexOf('confirmAction({');
  const importAt = panel.indexOf("api('/api/import'");
  assert.ok(confirmAt < importAt, 'the confirmation must precede the request, not follow it');
  assert.match(panel, /replace: true/, 'the server requires an explicit acknowledgement');
});

test('the confirmation says what SURVIVES, not just what is destroyed', () => {
  // "Are you sure?" asks a question the reader has no way to answer.
  assert.match(panel, /keep:/);
  assert.match(panel, /renamed and left on the server/i, 'the undo path must be stated');
  assert.match(panel, /Passwords and settings held outside the data folder are untouched/i);
});

test('the reader is told a restart is required, at the moment it becomes true', () => {
  assert.match(panel, /RESTART THE APP NOW/);
  assert.match(panel, /still running the old data in memory/i,
    'why it matters, not just that it is required');
});

/* ── The salt, again, because a backup missing it looks identical ───────── */

test('an export that cannot carry the salt says so, and says it loudly', () => {
  assert.match(panel, /x-device-salt-included/i, 'the server reports it in a header');
  assert.match(panel, /DEVICE_HASH_SALT/, 'and the variable is named');
  assert.match(panel, /set the same one on any server you restore to/i);
  // Reported as an error style, not a neutral note: it is a silent data loss.
  assert.match(panel, /salted \? 'ok' : 'err'/);
});

test('the preview shows the salt note from the bundle rather than assuming', () => {
  assert.match(panel, /m\.deviceSaltNote/);
});

/* ── Large files ────────────────────────────────────────────────────────── */

test('base64 is chunked, so a large backup does not fail silently', () => {
  assert.match(panel, /i \+= 0x8000/,
    'a one-shot fromCharCode over megabytes overflows the argument stack');
  assert.match(panel, /subarray\(i, i \+ 0x8000\)/);
});

test('the same file can be chosen twice', () => {
  // Clearing the input matters: picking the same file again fires no change
  // event otherwise, and the panel appears dead.
  assert.match(panel, /e\.target\.value = ''/);
});

/* ── Presentation ───────────────────────────────────────────────────────── */

test('every class the panel uses is styled', () => {
  for (const cls of ['backup-row', 'import-preview']) {
    assert.ok(html.includes(`class="${cls}"`) || html.includes(`"${cls}"`), `${cls} not used in admin.html`);
    assert.ok(css.includes(`.${cls}`), `.${cls} has no style — it would render as bare text`);
  }
});

test('the panel is last on the page', () => {
  // Rarely used and destructive: it must not sit above the things done daily.
  assert.ok(
    html.indexOf('Backup &amp; move') > html.indexOf('Monitored now'),
    'the destructive panel must come after the everyday ones',
  );
});
