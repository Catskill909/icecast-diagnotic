/* ═══════════════════════════════════════════════════════════════════════════
   The in-market share is a STATION's figure, not a deployment's

   THE BUG, seen in production: WPFW — Washington DC — reported "In Texas 0%,
   0 of 59 located US connections. Outside TX: 59." Every station on the install
   was measured against one state, because `homeRegion()` read a single
   deployment-wide STATION_REGION env var:

       homeRegion: () => (process.env.STATION_REGION || '')...

   Correct for the one station it was written for, and silently wrong for every
   station added afterwards. The failure is the dangerous kind: it does not
   error, it does not look empty, it produces a confident figure that is
   entirely false. "0% of our audience is in our own state" is a sentence a
   manager would act on.

   THE CLASS: any per-station figure derived from a deployment-wide value. The
   station's own value must win, and a deployment-wide fallback may only apply
   where it can be true — an install with exactly one station.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');

const monitor = require('../monitor');
const store = require('../store');
const discover = require('../discover');
const GeoMap = require('../public/geo-map');

const HOST = { id: 'h', host: 'streams.example.org:9000' };
const ch = (id, name) => ({ id, name, url: `https://streams.example.org:9000/${id}` });

function configure(stations) {
  store.load();
  store.setStationConfig({ version: 1, hosts: [HOST], stations });
  monitor.reloadConfig();
}

const NETWORK = [
  { id: 'kpft', name: 'KPFT Houston', timezone: 'America/Chicago', region: 'TX',
    channels: [ch('kpft-main', 'KPFT Main')] },
  { id: 'wpfw', name: 'WPFW Washington DC', timezone: 'America/New_York', region: 'DC',
    channels: [ch('wpfw', 'WPFW')] },
  // Deliberately left without one: not every operator will fill this in.
  { id: 'kpfk', name: 'KPFK Los Angeles', timezone: 'America/Los_Angeles',
    channels: [ch('kpfk', 'KPFK')] },
];

test('each station is measured against its OWN state', () => {
  configure(NETWORK);
  assert.equal(monitor.homeRegion('kpft'), 'TX');
  assert.equal(monitor.homeRegion('wpfw'), 'DC', 'WPFW is in Washington, not Texas');
  assert.notEqual(monitor.homeRegion('wpfw'), monitor.homeRegion('kpft'));
});

test('a station with no state configured gets none, never a neighbour\'s', () => {
  configure(NETWORK);
  assert.equal(monitor.homeRegion('kpfk'), null, 'no figure beats a false one');
});

test('a deployment-wide STATION_REGION is never applied to one station of many', () => {
  const saved = process.env.STATION_REGION;
  process.env.STATION_REGION = 'TX';
  try {
    configure(NETWORK);
    assert.equal(
      monitor.homeRegion('kpfk'), null,
      'one state cannot be true of three stations, so it is true of none of them',
    );
    assert.equal(monitor.homeRegion('wpfw'), 'DC', 'the station\'s own value still wins');
  } finally {
    if (saved === undefined) delete process.env.STATION_REGION; else process.env.STATION_REGION = saved;
  }
});

test('a single-station install still honours STATION_REGION, as it always did', () => {
  const saved = process.env.STATION_REGION;
  process.env.STATION_REGION = 'TX';
  try {
    configure([{ id: 'kpft', name: 'KPFT Houston', timezone: 'America/Chicago',
      channels: [ch('kpft-main', 'KPFT Main')] }]);
    assert.equal(monitor.homeRegion('kpft'), 'TX');
    assert.equal(monitor.homeRegion(), 'TX', 'with one station, no selection means that station');
  } finally {
    if (saved === undefined) delete process.env.STATION_REGION; else process.env.STATION_REGION = saved;
  }
});

test('asking with no station selected on a network answers for none of them', () => {
  configure(NETWORK);
  assert.equal(
    monitor.homeRegion(), null,
    '"All stations" spans three states — there is no single home region to report',
  );
});

test('the station list carries the region, so the editor can show it', () => {
  configure(NETWORK);
  const byId = Object.fromEntries(monitor.getStations().map((s) => [s.id, s]));
  assert.equal(byId.wpfw.region, 'DC');
  assert.equal(byId.kpfk.region, null);
});

// ── Configuration ──────────────────────────────────────────────────────────

const payload = (region) => ({
  station: { id: 'wpfw', name: 'WPFW', timezone: 'America/New_York', region },
  channels: [{ id: 'wpfw-main', name: 'WPFW', url: 'https://streams.example.org:9000/wpfw_128' }],
});
const EMPTY_CONFIG = { version: 1, hosts: [], stations: [] };

test('a valid state is stored, in upper case whatever was typed', () => {
  const v = discover.validateStationPayload(payload('dc'), EMPTY_CONFIG);
  assert.equal(v.ok, true, (v.errors || []).join('; '));
  assert.equal(v.station.region, 'DC');
});

test('a state that is not a state is refused, not quietly stored', () => {
  const v = discover.validateStationPayload(payload('ZZ'), EMPTY_CONFIG);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /not a US state/.test(e)), v.errors.join('; '));
});

test('blank is a legitimate answer and not an error', () => {
  const v = discover.validateStationPayload(payload(''), EMPTY_CONFIG);
  assert.equal(v.ok, true, (v.errors || []).join('; '));
  assert.equal(v.station.region, null);
});

test('an edit that does not mention the region keeps it', () => {
  const config = { version: 1, hosts: [HOST], stations: [{
    id: 'wpfw', name: 'WPFW', timezone: 'America/New_York', region: 'DC',
    channels: [{ id: 'wpfw-main', name: 'WPFW', url: 'https://streams.example.org:9000/wpfw_128' }],
  }] };
  const v = discover.validateStationEdit({
    name: 'WPFW Washington DC', timezone: 'America/New_York',
    channels: [{ id: 'wpfw-main', name: 'WPFW', url: 'https://streams.example.org:9000/wpfw_128' }],
  }, config, 'wpfw');
  assert.equal(v.ok, true, (v.errors || []).join('; '));
  assert.equal(v.station.region, 'DC', 'renaming a station must not blank its state');
});

test('every accepted code is a state the map can actually draw', () => {
  const drawable = new Set(GeoMap.GRID.map((g) => g[0]));
  const accepted = [...discover.US_REGIONS];

  const undrawable = accepted.filter((code) => !drawable.has(code));
  assert.deepEqual(undrawable, [], 'a code that passes validation but has no tile would vanish');

  const unacceptable = [...drawable].filter((code) => !discover.US_REGIONS.has(code));
  assert.deepEqual(unacceptable, [], 'a state on the map that configuration rejects is unreachable');
});
