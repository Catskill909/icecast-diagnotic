/* ═══════════════════════════════════════════════════════════════════════════
   Live configuration reload

   Configuration lives in the store so an admin panel can change it while the
   monitor runs. Reading it once at startup would have made that pointless:
   adding a station would write to the store and change nothing until someone
   redeployed.

   The reload's easy half is adding a channel. The half worth testing is
   removal, where three things go wrong quietly:

     - a pending silence-probe timer keeps firing against a stream nobody
       watches any more;
     - an open episode stays open, and is counted as an ongoing failure in every
       rollup from then on;
     - or it gets closed as a "recovery", claiming an observation nobody made.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// A scratch data directory, so the real record is never touched.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-test-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const monitor = require('../monitor');

function config(channels) {
  return {
    version: 1,
    hosts: [{ id: 'h', host: 'streams.example.org:9000', statusUrl: 'https://streams.example.org:9000/status-json.xsl' }],
    stations: [{ id: 'st', name: 'Station', timezone: 'UTC', channels }],
  };
}
const CH = (id, mounts) => ({ id, name: id, url: `https://streams.example.org:9000${mounts[0]}`, mounts });

test('a new channel is picked up without a restart', () => {
  store.setStationConfig(config([CH('a', ['/a_128', '/a_64'])]));
  const r = monitor.reloadConfig();
  assert.deepEqual(r.added, ['a']);
  assert.equal(r.changed, true);
  const ids = monitor.getStreams().map((s) => s.id);
  assert.deepEqual(ids, ['a']);
});

test('its mount list comes through, so audience is counted per channel', () => {
  store.setStationConfig(config([CH('a', ['/a_128', '/a_64'])]));
  monitor.reloadConfig();
  assert.deepEqual(monitor.getStreams()[0].mounts, ['/a_128', '/a_64']);
});

test('adding a second channel leaves the first alone', () => {
  store.setStationConfig(config([CH('a', ['/a_128']), CH('b', ['/b_128'])]));
  const r = monitor.reloadConfig();
  assert.deepEqual(r.added, ['b'], 'only the new one is reported added');
  assert.deepEqual(r.removed, []);
  assert.deepEqual(monitor.getStreams().map((s) => s.id).sort(), ['a', 'b']);
});

test('editing a surviving channel takes effect without a restart', () => {
  store.setStationConfig(config([CH('a', ['/a_128', '/a_64', '/a_32']), CH('b', ['/b_128'])]));
  const r = monitor.reloadConfig();
  assert.equal(r.changed, false, 'no channel was added or removed');
  const a = monitor.getStreams().find((s) => s.id === 'a');
  assert.deepEqual(a.mounts, ['/a_128', '/a_64', '/a_32'], 'but the new mount is live');
});

test('a removed channel stops being monitored', () => {
  store.setStationConfig(config([CH('a', ['/a_128'])]));
  const r = monitor.reloadConfig();
  assert.deepEqual(r.removed, ['b']);
  assert.deepEqual(monitor.getStreams().map((s) => s.id), ['a']);
});

test('removing a channel does NOT delete its history', () => {
  // Configuration says what to watch from now on. It is not a statement about
  // the past, and deleting the record would destroy the thing this app exists
  // to keep.
  store.addSample('b', { timestamp: new Date().toISOString(), status: 'up', responseTime: 100, listeners: 5 });
  store.setStationConfig(config([CH('a', ['/a_128'])]));
  monitor.reloadConfig();
  assert.equal(store.getSamples('b', 60 * 60 * 1000).length, 1, 'samples for the removed channel survive');
});

// ── Refusals ────────────────────────────────────────────────────────────────
test('an empty configuration is refused rather than monitoring nothing', () => {
  const before = monitor.getStreams().length;
  store.setStationConfig(config([]));
  const r = monitor.reloadConfig();
  assert.equal(r.changed, false);
  assert.match(r.reason, /no channels/);
  assert.equal(monitor.getStreams().length, before, 'the running set is untouched');
});

// ── The part that matters: an episode open at removal ───────────────────────
test('an episode still open when its channel is removed is closed as ABANDONED', () => {
  const started = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const event = store.addEvent({
    timestamp: started, streamId: 'z', streamName: 'Z', type: 'down',
    severity: 'outage', message: 'Z is off air',
  });
  assert.equal(event.resolvedAt, undefined, 'precondition: the event is open');

  monitor.abandonEpisode('z', { eventId: event.id, startedAt: started });

  const after = store.getEvents({}).events.find((e) => e.id === event.id);
  assert.ok(after.resolvedAt, 'must be closed — an open event counts as an ongoing failure forever');
  assert.equal(after.abandoned, true, 'and marked as abandoned, not recovered');
  assert.match(after.resolutionNote, /never observed/i, 'the record must not imply it came back');
});

test('the abandoned episode carries a real duration', () => {
  const started = new Date(Date.now() - 90 * 1000).toISOString();
  const event = store.addEvent({
    timestamp: started, streamId: 'y', streamName: 'Y', type: 'down', severity: 'outage', message: 'Y down',
  });
  monitor.abandonEpisode('y', { eventId: event.id, startedAt: started });
  const after = store.getEvents({}).events.find((e) => e.id === event.id);
  assert.ok(after.durationMs >= 89000 && after.durationMs <= 95000, `duration was ${after.durationMs}`);
  assert.ok(after.durationLabel, 'and a human-readable label');
});

test('an abandoned episode is no longer counted as an open failure', () => {
  // The whole reason not to leave it open.
  const open = store.getEvents({}).events.filter((e) => e.type === 'down' && !e.resolvedAt);
  assert.deepEqual(open, [], 'no failure may be left open by a reload');
});
