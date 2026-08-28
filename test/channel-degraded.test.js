/* ═══════════════════════════════════════════════════════════════════════════
   Degraded channels — a mount missing while the channel plays on

   A channel is published as several mounts, one per bitrate, but the probe only
   ever asks the highest one. So a single variant can stop being served while
   the probe keeps getting a clean answer: the card reads ONLINE, no event is
   written, and everyone listening on that variant is off the air with nothing
   recorded anywhere.

   The exposure is not marginal. On the production host /live_64 carries 22 of
   KPFT Main's 59 listeners and /kpfk_128 carries 110 of KPFK's 112 — either one
   disappearing alone is most of an audience, invisibly.

   These cover the class: any channel with more than one mount, on any host.
   The second half covers the bug this feature can itself cause — a degraded
   channel being counted as downtime it never had.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { channelDegradation } = require('../diagnose');
const { isFailureEvent } = require('../store');

const snap = (mounts) => ({ reachable: true, mounts });
const mount = (listeners) => ({ listeners, listenerPeak: listeners });

const CH = {
  id: 'ch',
  url: 'https://stream.example.org:9000/live_128',
  mounts: ['/live_128', '/live_64'],
};
const SINGLE = { id: 'one', url: 'https://stream.example.org:9000/solo', mounts: ['/solo'] };

const FULL = snap({ '/live_128': mount(37), '/live_64': mount(22) });

// ── Detection ───────────────────────────────────────────────────────────────

test('a channel serving every mount is not degraded', () => {
  const d = channelDegradation(FULL, FULL, CH);
  assert.equal(d.degraded, false);
  assert.equal(d.present, 2);
  assert.deepEqual(d.missing, []);
});

test('one variant missing is a degradation, and it names the mount', () => {
  const d = channelDegradation(snap({ '/live_128': mount(37) }), FULL, CH);
  assert.equal(d.degraded, true);
  assert.equal(d.present, 1);
  assert.equal(d.total, 2);
  assert.deepEqual(d.missing.map((m) => m.path), ['/live_64']);
});

test('the lost audience is read from the previous snapshot, not the current one', () => {
  // The whole point: the current snapshot cannot report listeners for a mount it
  // no longer lists. Reading it would score every degradation as costing nobody
  // anything, which is the failure mode that makes the feature pointless.
  const d = channelDegradation(snap({ '/live_128': mount(37) }), FULL, CH);
  assert.equal(d.listenersBefore, 22, "the missing mount's last known audience");
  assert.equal(d.listenersKnown, true);
});

test('a variant missing with nobody on it is degraded but cost no listeners', () => {
  const before = snap({ '/live_128': mount(37), '/live_64': mount(0) });
  const d = channelDegradation(snap({ '/live_128': mount(37) }), before, CH);
  assert.equal(d.degraded, true, 'still a real fault worth recording');
  assert.equal(d.listenersBefore, 0);
  assert.equal(d.listenersKnown, true, 'a measured zero, not an unknown');
});

test('a variant already missing when monitoring started has an unknown audience', () => {
  // Distinct from zero. Nothing ever observed a listener count for it, and
  // reporting 0 would assert something we never saw.
  const d = channelDegradation(snap({ '/live_128': mount(37) }), snap({ '/live_128': mount(37) }), CH);
  assert.equal(d.degraded, true);
  assert.equal(d.listenersKnown, false);
});

test('a channel with every mount gone is an outage, not a degradation', () => {
  // The outage path owns this. Reporting it here too would record the same
  // fault twice, under two names, with two durations.
  const d = channelDegradation(snap({}), FULL, CH);
  assert.equal(d.degraded, false);
  assert.equal(d.present, 0);
});

test('an unreachable Icecast is not a degradation', () => {
  // We cannot see any mount. That is an absence of evidence, and treating it as
  // evidence of absence would fire a degradation for every channel on the host
  // every time the status endpoint times out.
  const d = channelDegradation({ reachable: false, mounts: {} }, FULL, CH);
  assert.equal(d.degraded, false);
});

test('a single-mount channel can never be degraded', () => {
  const present = channelDegradation(snap({ '/solo': mount(5) }), snap({ '/solo': mount(5) }), SINGLE);
  const gone = channelDegradation(snap({}), snap({ '/solo': mount(5) }), SINGLE);
  assert.equal(present.degraded, false);
  assert.equal(gone.degraded, false, 'its mount vanishing is a full outage');
});

test('a second variant dropping is detected on top of the first', () => {
  const three = { ...CH, mounts: ['/live_128', '/live_64', '/live_32'] };
  const d = channelDegradation(snap({ '/live_128': mount(37) }), FULL, three);
  assert.equal(d.present, 1);
  assert.equal(d.total, 3);
  assert.deepEqual(d.missing.map((m) => m.path).sort(), ['/live_32', '/live_64']);
});

// ── Accounting ──────────────────────────────────────────────────────────────
// A degraded channel is still playing. Counting it as a failure would charge
// the station off-air time it did not have, in every rollup, uptime figure and
// history total — the same class of overcounting that the recovery-settling
// logic exists to undo for probe resets.

test('a degraded event is not counted as a failure', () => {
  assert.equal(isFailureEvent({ type: 'degraded', severity: 'degraded' }), false);
});

test('real failures still count', () => {
  assert.equal(isFailureEvent({ type: 'down', severity: 'outage' }), true);
  assert.equal(isFailureEvent({ type: 'dead_air', severity: 'dead_air' }), true);
});

test('recoveries are still not failures', () => {
  assert.equal(isFailureEvent({ type: 'up', severity: 'recovery' }), false);
});

// ── Episode lifecycle ───────────────────────────────────────────────────────
// One degradation is ONE event, held open until every mount is back. The
// obvious wrong implementation writes a fresh event on every check cycle, which
// at a sixty-second interval turns a variant that is down for a day into 1,440
// events and buries the rest of the history under them.

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'degraded-test-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const monitor = require('../monitor');

const STREAM = { id: 'ch', name: 'Test Channel', url: CH.url, mounts: CH.mounts };
const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
const degradedEvents = () => store.getEvents({ streamId: 'ch' }).events.filter((e) => e.type === 'degraded');

test('a degradation lasting many cycles is recorded once', () => {
  const d = channelDegradation(snap({ '/live_128': mount(37) }), FULL, STREAM);
  monitor.trackVariantDegradation(STREAM, d, at(0));

  // Twelve more cycles with the variant still gone. By now the previous
  // snapshot has forgotten it too, which is exactly when a re-derived listener
  // count would silently become zero.
  const stale = snap({ '/live_128': mount(37) });
  for (let i = 1; i <= 12; i++) {
    monitor.trackVariantDegradation(STREAM, channelDegradation(stale, stale, STREAM), at(i));
  }

  const evts = degradedEvents();
  assert.equal(evts.length, 1, 'thirteen cycles, one event');
  assert.equal(evts[0].resolvedAt, undefined, 'still open while the mount is gone');
  assert.equal(evts[0].detail.listenersBefore, 22, 'the audience frozen at the moment it was still knowable');
  assert.equal(evts[0].diagnosis.listenerImpact, 'confirmed');
  assert.match(evts[0].message, /\/live_64/, 'the message names the missing mount');
});

test('the event closes when every mount is back', () => {
  monitor.trackVariantDegradation(STREAM, channelDegradation(FULL, FULL, STREAM), at(13));

  const evts = degradedEvents();
  assert.equal(evts.length, 1, 'recovery closes the event rather than opening another');
  assert.equal(evts[0].resolvedAt, at(13));
  assert.equal(evts[0].durationMs, 13 * 60 * 1000);
});

test('a channel going fully down closes its degradation instead of leaving it open', () => {
  // Otherwise the outage event and a still-open degradation both describe the
  // same fault, and the degradation never ends because a channel that is off
  // air is never "partly" serving again.
  monitor.trackVariantDegradation(STREAM, channelDegradation(snap({ '/live_128': mount(37) }), FULL, STREAM), at(20));
  assert.equal(degradedEvents().filter((e) => !e.resolvedAt).length, 1);

  monitor.trackVariantDegradation(STREAM, channelDegradation(snap({}), FULL, STREAM), at(25));
  assert.equal(degradedEvents().filter((e) => !e.resolvedAt).length, 0, 'closed, not abandoned');
});

test('a second variant dropping updates the open event rather than opening another', () => {
  const three = { ...STREAM, mounts: ['/live_128', '/live_64', '/live_32'] };
  const before = snap({ '/live_128': mount(37), '/live_64': mount(22), '/live_32': mount(5) });
  const opened = degradedEvents().length;

  monitor.trackVariantDegradation(three, channelDegradation(snap({ '/live_128': mount(37), '/live_32': mount(5) }), before, three), at(30));
  monitor.trackVariantDegradation(three, channelDegradation(snap({ '/live_128': mount(37) }), before, three), at(31));

  const evts = degradedEvents();
  assert.equal(evts.length, opened + 1, 'one event for the whole worsening episode');
  const open = evts.find((e) => !e.resolvedAt);
  assert.deepEqual([...open.detail.missing].sort(), ['/live_32', '/live_64']);
  assert.equal(open.detail.listenersBefore, 27, 'both lost audiences counted');
});
