/* ═══════════════════════════════════════════════════════════════════════════
   Validating a station before it is written

   Two of these matter more than the rest.

   CHANNEL IDS ARE LOAD-BEARING. Every sample, rollup and event is keyed by them,
   so reusing one attaches a new channel to another channel's history. The data
   does not vanish — it silently becomes wrong, and uptime is computed from it.

   URLS BECOME THINGS THE SERVER FETCHES. A saved channel is probed every sixty
   seconds forever, so the payload is validated on save and not merely on
   discovery.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { validateStationPayload, addStationToConfig, existingChannelIds } = require('../discover');

const CONFIG = {
  version: 1,
  hosts: [{ id: 'h', host: 'streams.pacifica.org:9000', statusUrl: 'https://streams.pacifica.org:9000/status-json.xsl' }],
  stations: [{
    id: 'kpft', name: 'KPFT Houston', timezone: 'America/Chicago',
    channels: [{ id: 'kpft-main', name: 'KPFT Main', url: 'https://streams.pacifica.org:9000/live_128', mounts: ['/live_128', '/live_64'] }],
  }],
};

const valid = (over = {}) => ({
  station: { id: 'wpfw', name: 'WPFW Washington', timezone: 'America/New_York', ...(over.station || {}) },
  channels: over.channels || [{ id: 'wpfw-main', name: 'WPFW', url: 'https://streams.pacifica.org:9000/wpfw_128', mounts: ['/wpfw_128'] }],
});

test('a well-formed station is accepted', () => {
  const r = validateStationPayload(valid(), CONFIG);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.station.id, 'wpfw');
  assert.deepEqual(r.station.channels[0].mounts, ['/wpfw_128']);
});

// ── The id collision that would corrupt history ─────────────────────────────
test('a channel id already used elsewhere is REFUSED', () => {
  const r = validateStationPayload(valid({ channels: [{ id: 'kpft-main', name: 'X', url: 'https://streams.pacifica.org:9000/x' }] }), CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /already used|inherit/i);
});

test('a repeated id within one submission is refused', () => {
  const r = validateStationPayload(valid({ channels: [
    { id: 'dup', name: 'A', url: 'https://streams.pacifica.org:9000/a' },
    { id: 'dup', name: 'B', url: 'https://streams.pacifica.org:9000/b' },
  ] }), CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /repeated/i);
});

test('a duplicate STATION id is refused', () => {
  const r = validateStationPayload(valid({ station: { id: 'kpft' } }), CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /already exists/i);
});

// ── URLs ────────────────────────────────────────────────────────────────────
test('a channel URL pointing somewhere private is refused at save, not just at discovery', () => {
  // The hole this closes: discover a real inventory, then swap the address in
  // before saving.
  for (const url of ['http://169.254.169.254/x', 'http://127.0.0.1:9000/live', 'file:///etc/passwd']) {
    const r = validateStationPayload(valid({ channels: [{ id: 'c', name: 'C', url }] }), CONFIG);
    assert.equal(r.ok, false, `${url} must be refused`);
  }
});

test('credentials in a channel URL are refused', () => {
  const r = validateStationPayload(valid({ channels: [{ id: 'c', name: 'C', url: 'https://u:p@streams.pacifica.org:9000/x' }] }), CONFIG);
  assert.equal(r.ok, false);
});

test('mounts must be Icecast paths', () => {
  const r = validateStationPayload(valid({ channels: [{ id: 'c', name: 'C', url: 'https://streams.pacifica.org:9000/x', mounts: ['live_128'] }] }), CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /beginning with/i);
});

// ── Shape ───────────────────────────────────────────────────────────────────
test('every problem is reported at once, not one per submission', () => {
  const r = validateStationPayload({ station: { id: 'BAD ID', name: '' }, channels: [] }, CONFIG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `expected several errors, got ${r.errors.length}`);
});

test('an unrecognised timezone is refused', () => {
  const r = validateStationPayload(valid({ station: { timezone: 'Mars/Olympus' } }), CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /timezone/i);
});

test('junk payloads are refused without throwing', () => {
  for (const bad of [null, undefined, {}, 'string', 42, { station: null }, { channels: 'no' }]) {
    assert.doesNotThrow(() => validateStationPayload(bad, CONFIG));
    assert.equal(validateStationPayload(bad, CONFIG).ok, false);
  }
});

// ── Merging ─────────────────────────────────────────────────────────────────
test('adding a station does not mutate the existing configuration', () => {
  const before = JSON.stringify(CONFIG);
  const r = validateStationPayload(valid(), CONFIG);
  addStationToConfig(CONFIG, r.station, r.hosts);
  assert.equal(JSON.stringify(CONFIG), before, 'the original must be untouched');
});

test('a station on an already-known host does not duplicate the host', () => {
  const r = validateStationPayload(valid(), CONFIG);
  const next = addStationToConfig(CONFIG, r.station, r.hosts);
  assert.equal(next.hosts.length, 1, 'one snapshot fetch still serves both stations');
  assert.equal(next.stations.length, 2);
});

test('a station on a new host adds that host', () => {
  const r = validateStationPayload(valid({ channels: [{ id: 'other', name: 'Other', url: 'https://other.example.org:8000/live' }] }), CONFIG);
  const next = addStationToConfig(CONFIG, r.station, r.hosts);
  assert.equal(next.hosts.length, 2);
  assert.ok(next.hosts.some((h) => h.host === 'other.example.org:8000'));
});

test('existingChannelIds sees across every station', () => {
  const ids = existingChannelIds(CONFIG);
  assert.ok(ids.has('kpft-main'));
  assert.equal(existingChannelIds(null).size, 0);
});
