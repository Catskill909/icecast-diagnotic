/* ═══════════════════════════════════════════════════════════════════════════
   Editing and removing a station

   Two hazards, neither of which announces itself.

   CHANNEL IDS KEY EVERY STORED SAMPLE, ROLLUP AND EVENT. Renaming one does not
   move its history — it orphans it. The channel starts again from zero while the
   old record sits under a name nothing references, and uptime is computed from
   the empty one.

   CONFIGURATION IS NOT A STATEMENT ABOUT THE PAST. Removing a station stops it
   being watched. What happened while it WAS watched stays exactly where it is.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const {
  validateStationEdit, replaceStationInConfig, removeStationFromConfig,
} = require('../discover');

const CONFIG = () => ({
  version: 1,
  hosts: [
    { id: 'a', host: 'streams.pacifica.org:9000', statusUrl: 'https://streams.pacifica.org:9000/status-json.xsl' },
    { id: 'b', host: 'other.example.org:8000', statusUrl: 'https://other.example.org:8000/status-json.xsl' },
  ],
  stations: [
    { id: 'kpft', name: 'KPFT Houston', timezone: 'America/Chicago', channels: [
      { id: 'kpft-main', name: 'KPFT Main', url: 'https://streams.pacifica.org:9000/live_128', mounts: ['/live_128', '/live_64'] },
      { id: 'kpft-hd2', name: 'KPFT HD2', url: 'https://streams.pacifica.org:9000/HD3_128', mounts: ['/HD3_128'] }]},
    { id: 'other', name: 'Other Station', timezone: 'UTC', channels: [
      { id: 'other-main', name: 'Other', url: 'https://other.example.org:8000/live' }]},
  ],
});

// ── Editing ─────────────────────────────────────────────────────────────────
test('a station name and timezone can be changed', () => {
  const r = validateStationEdit({ name: 'KPFT', timezone: 'America/New_York' }, CONFIG(), 'kpft');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.station.name, 'KPFT');
  assert.equal(r.station.timezone, 'America/New_York');
});

test('omitted fields keep their current value rather than being blanked', () => {
  const r = validateStationEdit({ name: 'KPFT' }, CONFIG(), 'kpft');
  assert.equal(r.station.timezone, 'America/Chicago');
  assert.equal(r.station.channels.length, 2, 'channels are untouched when not supplied');
});

test('a channel keeps its id while its display name and URL change', () => {
  // The whole point: history follows the id, so the id must survive an edit that
  // changes everything a human sees.
  const c = CONFIG();
  const r = validateStationEdit({ channels: [
    { id: 'kpft-main', name: 'Renamed Main', url: 'https://streams.pacifica.org:9000/live_64', mounts: ['/live_64'] },
    c.stations[0].channels[1],
  ] }, c, 'kpft');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.station.channels[0].id, 'kpft-main');
  assert.equal(r.station.channels[0].name, 'Renamed Main');
  assert.match(r.station.channels[0].url, /live_64/);
});

test('an id belonging to ANOTHER station is refused', () => {
  const r = validateStationEdit({ channels: [
    { id: 'other-main', name: 'X', url: 'https://streams.pacifica.org:9000/x' },
  ] }, CONFIG(), 'kpft');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /belongs to another station/i);
});

test("but the station's OWN ids are not treated as taken", () => {
  // Otherwise no edit would ever validate.
  const c = CONFIG();
  const r = validateStationEdit({ channels: c.stations[0].channels }, c, 'kpft');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('a dropped channel is reported by name, not left to be inferred', () => {
  const c = CONFIG();
  const r = validateStationEdit({ channels: [c.stations[0].channels[0]] }, c, 'kpft');
  assert.equal(r.ok, true);
  assert.deepEqual(r.removedChannels, ['kpft-hd2']);
});

test('a station cannot be left with no channels', () => {
  const r = validateStationEdit({ channels: [] }, CONFIG(), 'kpft');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /at least one channel/i);
});

test('a channel URL pointing somewhere private is refused on edit too', () => {
  for (const url of ['http://169.254.169.254/x', 'http://127.0.0.1:9000/live', 'file:///etc/passwd']) {
    const r = validateStationEdit({ channels: [{ id: 'kpft-main', name: 'M', url }] }, CONFIG(), 'kpft');
    assert.equal(r.ok, false, `${url} must be refused`);
  }
});

test('editing a station that does not exist is a 404, not a silent create', () => {
  const r = validateStationEdit({ name: 'X' }, CONFIG(), 'nosuch');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /No station/);
});

test('replacing a station does not mutate the original configuration', () => {
  const c = CONFIG();
  const before = JSON.stringify(c);
  const r = validateStationEdit({ name: 'KPFT' }, c, 'kpft');
  replaceStationInConfig(c, r.station, r.hosts);
  assert.equal(JSON.stringify(c), before);
});

// ── Removing ────────────────────────────────────────────────────────────────
test('removing a station takes it out of the configuration', () => {
  const next = removeStationFromConfig(CONFIG(), 'kpft');
  assert.deepEqual(next.stations.map((s) => s.id), ['other']);
});

test('a host left serving nothing is dropped with it', () => {
  // Otherwise the check cycle keeps fetching a status document nothing reads.
  const next = removeStationFromConfig(CONFIG(), 'other');
  assert.deepEqual(next.hosts.map((h) => h.host), ['streams.pacifica.org:9000']);
});

test('a host still serving another station is KEPT', () => {
  const c = CONFIG();
  // Point 'other' at the shared Pacifica host, then remove it.
  c.stations[1].channels[0].url = 'https://streams.pacifica.org:9000/wpfw_128';
  const next = removeStationFromConfig(c, 'other');
  assert.ok(next.hosts.some((h) => h.host === 'streams.pacifica.org:9000'),
    'KPFT still needs that host');
});

test('removing does not mutate the original configuration', () => {
  const c = CONFIG();
  const before = JSON.stringify(c);
  removeStationFromConfig(c, 'kpft');
  assert.equal(JSON.stringify(c), before);
});

test('removing a station that does not exist changes nothing', () => {
  const next = removeStationFromConfig(CONFIG(), 'nosuch');
  assert.equal(next.stations.length, 2);
});
