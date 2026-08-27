/* ═══════════════════════════════════════════════════════════════════════════
   Icecast status document parsing

   Regression cover for the class of bug where Icecast emits a status document
   that is not valid JSON, and the monitor reports that as "server unreachable".

   Why this class matters more than the single instance: an unreachable verdict
   makes assessListenerImpact() return 'unknown', and warrantsAlert() treats
   'unknown' as alertable. So ANY malformation — from any mount, on any station
   sharing the server — silently disables the listener-impact gate and restores
   the alert noise the gate exists to suppress. The tests below therefore probe
   several malformed shapes, not just the one observed in production.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseIcecastStatus, repairIcecastJson } = require('../diagnose');

const FIXTURE = path.join(__dirname, 'fixtures', 'icecast-2.4.4-malformed-title.json');

function doc(sources) {
  return JSON.stringify({ icestats: { server_id: 'Icecast 2.4.4', source: sources } });
}

// ── The real thing ──────────────────────────────────────────────────────────
test('real Icecast 2.4.4 document with a bare `-` title is recovered in full', () => {
  const body = fs.readFileSync(FIXTURE, 'utf8');

  // Precondition: the fixture really is invalid JSON. If Icecast is ever fixed
  // and someone refreshes this file, this assertion fails loudly rather than
  // letting the test pass vacuously against a well-formed document.
  assert.throws(() => JSON.parse(body), 'fixture should be malformed');

  const result = parseIcecastStatus(body);
  assert.ok(result, 'malformed document must still parse');
  assert.equal(result.repaired, true);
  assert.equal(result.mountCount, 39, 'every mount must survive the repair');
  assert.ok(result.mounts['/weru'], 'a known affiliate mount is present');
  assert.equal(typeof result.mounts['/weru'].listeners, 'number');
});

// ── The class, not the instance ─────────────────────────────────────────────
test('bare `-` is repaired wherever it appears, in any field', () => {
  for (const field of ['title', 'server_name', 'genre', 'server_description']) {
    const body = doc([{ listenurl: 'http://h:9000/a', [field]: 'X' }])
      .replace(`"${field}":"X"`, `"${field}": - `);
    assert.throws(() => JSON.parse(body), `${field} fixture should be malformed`);
    const r = parseIcecastStatus(body);
    assert.ok(r, `${field}: must parse`);
    assert.equal(r.mountCount, 1, `${field}: mount must survive`);
  }
});

test('multiple malformed mounts in one document all survive', () => {
  const body = doc([
    { listenurl: 'http://h:9000/a', title: 'X' },
    { listenurl: 'http://h:9000/b', title: 'X' },
    { listenurl: 'http://h:9000/c', title: 'ok' },
  ]).replace(/"title":"X"/g, '"title": - ');
  assert.throws(() => JSON.parse(body));
  const r = parseIcecastStatus(body);
  assert.equal(r.mountCount, 3);
  assert.equal(r.mounts['/c'].title, 'ok');
});

// ── The repair must not damage healthy documents ────────────────────────────
test('well-formed documents are untouched and not flagged as repaired', () => {
  const body = doc([{ listenurl: 'http://h:9000/a', title: 'Song', listeners: 12 }]);
  const r = parseIcecastStatus(body);
  assert.equal(r.repaired, false);
  assert.equal(r.mounts['/a'].listeners, 12);
  assert.equal(r.mounts['/a'].title, 'Song');
});

test('negative numbers are not corrupted by the repair', () => {
  // A minus followed by a digit is valid JSON and must be left alone.
  const body = '{"icestats":{"offset":-5,"source":[{"listenurl":"http://h:9000/a","listeners":3}]}}';
  assert.equal(repairIcecastJson(body), body, 'repair must be a no-op here');
  assert.equal(parseIcecastStatus(body).mounts['/a'].listeners, 3);
});

test('a hyphen inside a legitimate title string is preserved', () => {
  const body = doc([{ listenurl: 'http://h:9000/a', title: 'Artist - Track' }]);
  assert.equal(repairIcecastJson(body), body, 'repair must be a no-op here');
  assert.equal(parseIcecastStatus(body).mounts['/a'].title, 'Artist - Track');
});

// ── Genuinely unusable input still reports failure ──────────────────────────
test('unrecoverable documents return null so the EPARSE path still works', () => {
  assert.equal(parseIcecastStatus('<html>404 not found</html>'), null);
  assert.equal(parseIcecastStatus('{"not_icestats":1}'), null);
  assert.equal(parseIcecastStatus(''), null);
});

test('a document with no sources parses to an empty inventory, not a failure', () => {
  const r = parseIcecastStatus('{"icestats":{"server_id":"Icecast 2.4.4"}}');
  assert.ok(r, 'an idle server is reachable with zero mounts, not unparseable');
  assert.equal(r.mountCount, 0);
});
