/* ═══════════════════════════════════════════════════════════════════════════
   Stream configuration normalisation

   THE CLASS OF BUG THIS PREVENTS. init() used to rebuild each configured stream
   from a fixed list of fields — id, name, url, m3u. Anything not on that list
   was silently discarded. When channels gained a `mounts` list, an env-configured
   station lost it and reverted to counting one mount per channel, undercounting
   its audience with no error and no log line.

   The whitelist is the bug, not the missing field: every field added later would
   have disappeared the same way. These tests pin the general property — unknown
   fields survive — as well as the specific one that bit us.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { normaliseStreams, normaliseMounts } = require('../monitor');

test('mounts survive configuration — the regression that started this', () => {
  const [s] = normaliseStreams([
    { id: 'kpft-main', name: 'KPFT Main', url: 'https://h:9000/live_128', mounts: ['/live_128', '/live_64'] },
  ]);
  assert.deepEqual(s.mounts, ['/live_128', '/live_64']);
});

test('fields the normaliser has never heard of are preserved', () => {
  // The actual defect was a whitelist. This fails if anyone reintroduces one.
  const [s] = normaliseStreams([
    { id: 'a', url: 'https://h:9000/a', somethingAddedNextYear: 42, nested: { deep: true } },
  ]);
  assert.equal(s.somethingAddedNextYear, 42);
  assert.deepEqual(s.nested, { deep: true });
});

test('defaults are applied without clobbering supplied values', () => {
  const [a, b] = normaliseStreams([
    { url: 'https://h:9000/a' },
    { id: 'mine', name: 'Mine', url: 'https://h:9000/b', m3u: 'https://h/x.m3u' },
  ]);
  assert.equal(a.id, 'stream-0');
  assert.equal(a.name, 'Stream 1');
  assert.equal(a.m3u, '');
  assert.equal(b.id, 'mine');
  assert.equal(b.name, 'Mine');
  assert.equal(b.m3u, 'https://h/x.m3u');
});

// ── Mount normalisation ─────────────────────────────────────────────────────
test('full URLs are reduced to pathnames — an admin UI will produce these', () => {
  assert.deepEqual(
    normaliseMounts(['https://streams.pacifica.org:9000/live_128', '/live_64']),
    ['/live_128', '/live_64'],
  );
});

test('duplicates are collapsed however they were written', () => {
  assert.deepEqual(
    normaliseMounts(['/live_128', 'https://streams.pacifica.org:9000/live_128']),
    ['/live_128'],
  );
});

test('junk entries are dropped rather than poisoning the mount list', () => {
  assert.deepEqual(normaliseMounts(['/live_128', '', '   ', null, 42, 'not a url']), ['/live_128']);
});

test('no usable mounts yields undefined, so the stream falls back to its URL', () => {
  assert.equal(normaliseMounts([]), undefined);
  assert.equal(normaliseMounts(['', null]), undefined);
  assert.equal(normaliseMounts(undefined), undefined);
  assert.equal(normaliseMounts('not-an-array'), undefined);
});

test('a stream with no mounts list is still valid', () => {
  const [s] = normaliseStreams([{ id: 'a', url: 'https://h:9000/a' }]);
  assert.equal(s.mounts, undefined);
  assert.equal(s.url, 'https://h:9000/a');
});

test('a non-array STREAMS value is rejected loudly, not silently accepted', () => {
  // init() catches this and falls back to defaults with a logged reason.
  assert.throws(() => normaliseStreams({ id: 'a' }), /must be a JSON array/);
});
