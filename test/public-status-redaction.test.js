/* ═══════════════════════════════════════════════════════════════════════════
   Recipient addresses never leave through the status API

   `stationAlerts` rides on each flattened stream so the alert path can resolve
   recipients without re-reading configuration mid-send. `getStatus()` spread the
   stream object straight into its response, and that response is what
   /api/status and /api/diagnostics return — both PUBLIC.

   So the monitor published every station's alert recipients to anyone who loaded
   the dashboard's own API. Found on the live site by grepping public responses
   for anything address-shaped: four real addresses, including the general
   manager's and the operator's.

   This is the second time a field added to a stored object walked into a public
   response — /api/events did it with delivery records on 2026-08-27, which is
   why redact.js exists. redact.js could not catch this one: it projects EVENTS
   and STATION CONFIG, and this arrived through neither.

   THE RULE: a field that must never be published does not leave the module that
   owns it. Stripped at the source in getStatus(), not in a projection, because
   two public routes read it and nothing forces a third through redact.js.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pubstatus-'));
process.env.SEED_FILE = '/nonexistent';

const monitor = require('../monitor');
const store = require('../store');

const SECRET = 'gm@kpft.org';

store.load();
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: 'streams.example.org:9000' }],
  stations: [{
    id: 'kpft',
    name: 'KPFT',
    timezone: 'America/Chicago',
    alerts: { enabled: true, recipients: [SECRET, 'omaclay@example.com'], cc: ['legacy@example.com'] },
    channels: [
      { id: 'kpft-main', name: 'Main', url: 'https://streams.example.org:9000/live_128', mounts: ['/live_128'] },
      { id: 'kpft-hd2', name: 'HD2', url: 'https://streams.example.org:9000/HD3_128', mounts: ['/HD3_128'] },
    ],
  }],
});
monitor.reloadConfig();

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

test('the alert path can still see the recipients — this is not solved by deleting them', () => {
  // The guard below must not be satisfiable by breaking alerting. Recipients
  // have to remain reachable internally, and absent externally.
  const stream = monitor.getStreams().find((s) => s.id === 'kpft-main');
  assert.deepEqual(monitor.recipientsFor(stream).recipients, [SECRET, 'omaclay@example.com']);
});

test('getStatus() carries no recipient addresses', () => {
  const body = JSON.stringify(monitor.getStatus());
  const found = body.match(ADDRESS) || [];
  assert.deepEqual(found, [], `addresses published through getStatus(): ${found.join(', ')}`);
});

test('getStatus() carries no stationAlerts key at all', () => {
  // Asserted separately from the address scan: an empty or disabled block leaks
  // no address but still exposes that a station is configured and how.
  for (const s of monitor.getStatus()) {
    assert.equal('stationAlerts' in s, false, `${s.id} still carries stationAlerts`);
  }
});

test('the useful fields survive — this must not be fixed by returning less', () => {
  const s = monitor.getStatus().find((x) => x.id === 'kpft-main');
  assert.equal(s.name, 'Main');
  assert.equal(s.stationId, 'kpft');
  assert.equal(s.stationName, 'KPFT');
  assert.deepEqual(s.mounts, ['/live_128']);
  assert.ok('status' in s, 'live state is still merged in');
});

test('no public monitor accessor leaks an address', () => {
  // Written against the CLASS rather than the one function: every accessor a
  // public route reads is scanned, so a new one is covered without anyone
  // remembering this file exists.
  const publicAccessors = {
    getStatus: () => monitor.getStatus(),
    getStations: () => monitor.getStations(),
    getConfig: () => monitor.getConfig(),
    getHistory: () => monitor.getHistory(),
    getIncidents: () => monitor.getIncidents(),
  };

  for (const [name, fn] of Object.entries(publicAccessors)) {
    const found = JSON.stringify(fn() ?? null).match(ADDRESS) || [];
    assert.deepEqual(found, [], `${name}() published: ${found.join(', ')}`);
  }
});
