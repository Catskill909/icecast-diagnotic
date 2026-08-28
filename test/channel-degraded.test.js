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
  assert.deepEqual(evts[0].detail.impaired.map((m) => m.path), ['/live_64']);
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
  assert.deepEqual(open.detail.impaired.map((m) => m.path).sort(), ['/live_32', '/live_64']);
  assert.equal(open.detail.listenersBefore, 27, 'both lost audiences counted');
});

// ── Stalled mounts ──────────────────────────────────────────────────────────
// The half the inventory cannot see. Icecast lists the mount, so nothing is
// "missing", but connecting to it fails or returns silence — and the listeners
// still attached to it are hearing nothing. Only a probe can tell.

const ok = { ok: true, reason: null };
const bad = (reason) => ({ ok: false, reason });

test('a mount Icecast lists but does not serve is a degradation', () => {
  const d = channelDegradation(FULL, FULL, CH, { '/live_64': bad('not serving') });
  assert.equal(d.degraded, true);
  assert.deepEqual(d.stalled.map((m) => m.path), ['/live_64']);
  assert.deepEqual(d.missing, [], 'it is present — just broken');
});

test('a stalled mount counts the listeners still attached to it', () => {
  // The opposite of a missing mount, and deliberately so. A stalled mount is
  // still listed and still holding its audience, so the CURRENT count is the
  // right one — those people are connected and hearing nothing.
  const d = channelDegradation(FULL, FULL, CH, { '/live_64': bad('serving silence') });
  assert.equal(d.listenersBefore, 22);
  assert.equal(d.listenersKnown, true);
});

test('healthy variant probes are not a degradation', () => {
  const d = channelDegradation(FULL, FULL, CH, { '/live_64': ok });
  assert.equal(d.degraded, false);
});

test('a mount that is stalled AND then vanishes is reported once, as missing', () => {
  // Otherwise one fault is counted twice, and the affected audience with it.
  const d = channelDegradation(snap({ '/live_128': mount(37) }), FULL, CH, { '/live_64': bad('not serving') });
  assert.deepEqual(d.missing.map((m) => m.path), ['/live_64']);
  assert.deepEqual(d.stalled, [], 'a mount that is gone cannot also be stalled');
  assert.equal(d.listenersBefore, 22, 'counted once, not 44');
});

test('every mount stalled is an outage, not a degradation', () => {
  // Nothing is serving. The outage path owns that, and recording a degradation
  // as well would describe one silent channel as two different faults.
  const d = channelDegradation(FULL, FULL, CH, {
    '/live_128': bad('serving silence'),
    '/live_64': bad('serving silence'),
  });
  assert.equal(d.working, 0);
  assert.equal(d.degraded, false);
});

test('a stale verdict for a mount Icecast no longer lists is ignored', () => {
  // variantHealth persists between probe cycles by design. It must not keep
  // asserting things about mounts that are no longer in the inventory.
  const d = channelDegradation(snap({ '/live_128': mount(37) }), FULL, CH, { '/live_999': bad('not serving') });
  assert.deepEqual(d.stalled, []);
});

test('missing and stalled mounts are reported together', () => {
  const three = { ...CH, mounts: ['/live_128', '/live_64', '/live_32'] };
  const before = snap({ '/live_128': mount(37), '/live_64': mount(22), '/live_32': mount(5) });
  const now = snap({ '/live_128': mount(37), '/live_32': mount(5) });
  const d = channelDegradation(now, before, three, { '/live_32': bad('serving silence') });

  assert.equal(d.degraded, true);
  assert.equal(d.working, 1, 'only the primary is actually serving');
  assert.deepEqual(d.impaired.map((m) => m.path).sort(), ['/live_32', '/live_64']);
  assert.equal(d.listenersBefore, 27, '22 from the missing mount, 5 from the stalled one');
});

// ── Measurement must not perturb what it measures ───────────────────────────
// Icecast counts every connection as a listener, ours included. Measured against
// the production host: opening a single connection took /kpfk from 1 listener to
// 2. So the order of these two operations inside a cycle is not a style choice —
// probing first puts our own probes inside the listener counts we then record
// and store, permanently, on every probed mount.

const diagnose = require('../diagnose');

test('the Icecast snapshot is read before any probe opens a connection', async () => {
  store.setStationConfig({
    version: 1,
    hosts: [{ id: 'h', host: 'stream.example.org:9000', statusUrl: 'https://stream.example.org:9000/status-json.xsl' }],
    stations: [{
      id: 'st',
      name: 'Station',
      timezone: 'UTC',
      channels: [{ id: 'seq', name: 'Seq', url: 'https://stream.example.org:9000/a_128', mounts: ['/a_128', '/a_64'] }],
    }],
  });
  monitor.reloadConfig();

  const order = [];
  const realSnapshot = diagnose.fetchIcecastSnapshot;
  const realProbe = diagnose.probeStream;

  diagnose.fetchIcecastSnapshot = async () => {
    order.push('snapshot');
    return {
      reachable: true,
      mountCount: 2,
      mounts: { '/a_128': mount(10), '/a_64': mount(5) },
    };
  };
  diagnose.probeStream = async () => {
    order.push('probe');
    return { status: 'up', responseTime: 12, isSilent: false, audioEnergy: 9, timings: {} };
  };

  try {
    await monitor.runChecks();
  } finally {
    diagnose.fetchIcecastSnapshot = realSnapshot;
    diagnose.probeStream = realProbe;
  }

  assert.ok(order.length >= 2, 'the cycle ran');
  assert.equal(order[0], 'snapshot', 'the inventory must be read before we connect to anything');
  assert.ok(order.slice(1).every((o) => o === 'probe'), 'and every probe comes after it');
});

test('a sample carries the per-mount listener breakdown, not just the sum', () => {
  // The summed count can hold steady while one variant's audience collapses
  // inside it, so the sum alone cannot answer "which variant lost its
  // listeners" after the fact. Raw samples are the only per-mount history there
  // is, and they expire — so if it is not written here it is unrecoverable.
  const samples = store.getSamples('seq');
  const latest = samples[samples.length - 1];
  assert.ok(latest, 'the cycle above wrote a sample');
  assert.equal(latest.listeners, 15, 'the channel total');
  assert.deepEqual(latest.mountListeners, { '/a_128': 10, '/a_64': 5 });
  assert.equal(latest.variantsPresent, 2);
  assert.equal(latest.variantsTotal, 2);
});

// ── What the variant probe actually connects to ─────────────────────────────
// Every connection here costs audio off the station's own server and adds a
// listener to the mount it touches, so what it skips matters as much as what it
// checks.

test('variant probing skips the primary and any mount Icecast has already dropped', async () => {
  const probed = [];
  const realProbe = diagnose.probeStream;
  diagnose.probeStream = async (s) => {
    probed.push(new URL(s.url).pathname);
    return { status: 'up', responseTime: 5, isSilent: false, audioEnergy: 9, timings: {} };
  };

  store.setStationConfig({
    version: 1,
    hosts: [{ id: 'h', host: 'stream.example.org:9000', statusUrl: 'https://stream.example.org:9000/status-json.xsl' }],
    stations: [{
      id: 'st',
      name: 'Station',
      timezone: 'UTC',
      channels: [{
        id: 'vp',
        name: 'VP',
        url: 'https://stream.example.org:9000/v_128',
        mounts: ['/v_128', '/v_64', '/v_32'],
      }],
    }],
  });
  monitor.reloadConfig();

  try {
    // /v_32 is absent from the inventory. Icecast already told us it is gone;
    // spending a connection to rediscover that buys nothing.
    await monitor.probeVariants(snap({ '/v_128': mount(10), '/v_64': mount(5) }));
  } finally {
    diagnose.probeStream = realProbe;
  }

  assert.deepEqual(probed, ['/v_64'], 'not the primary, not the mount already known missing');
});

test('a variant probe failure is conclusive, a single silent read is not', async () => {
  // Connection failure means Icecast advertised a mount it would not serve —
  // no second opinion needed. Silence is ambiguous: one quiet 8 KB read is a
  // quiet passage at least as often as it is dead air, so it has to repeat
  // before it is allowed to mark a mount stalled.
  const realProbe = diagnose.probeStream;
  const inventory = snap({ '/v_128': mount(10), '/v_64': mount(5), '/v_32': mount(2) });

  try {
    diagnose.probeStream = async () => ({ status: 'up', responseTime: 5, isSilent: true, audioEnergy: 0, timings: {} });

    await monitor.probeVariants(inventory);
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].ok, true, 'one silent read settles nothing');
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].silentStreak, 1);

    await monitor.probeVariants(inventory);
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].ok, false, 'the second consecutive one does');
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].reason, 'serving silence');

    // And it feeds through to a real degradation.
    const d = channelDegradation(inventory, inventory, monitor.getStreams()[0], monitor.getVariantHealth('vp'));
    assert.equal(d.degraded, true);
    assert.deepEqual(d.stalled.map((m) => m.path).sort(), ['/v_32', '/v_64']);

    // A failed connection needs no streak at all.
    diagnose.probeStream = async () => ({ status: 'down', responseTime: 5, error: 'HTTP 404', errorCode: 'MOUNT_NOT_FOUND', timings: {} });
    await monitor.probeVariants(inventory);
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].ok, false);
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].reason, 'HTTP 404');

    // Audio returning clears it immediately — a recovered mount must not stay
    // marked stalled until some streak decays.
    diagnose.probeStream = async () => ({ status: 'up', responseTime: 5, isSilent: false, audioEnergy: 9, timings: {} });
    await monitor.probeVariants(inventory);
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].ok, true);
    assert.equal(monitor.getVariantHealth('vp')['/v_64'].silentStreak, 0);
  } finally {
    diagnose.probeStream = realProbe;
  }
});

// ── A degradation is not downtime ───────────────────────────────────────────
// Every "what went wrong" figure in the system reads the event log, and most of
// them were written when any non-'up' event with a duration meant the channel
// had been off air. A degraded event is the first one that is neither: a real
// recorded fault on a channel that never stopped playing.
//
// Four separate places embedded that assumption — the period rollup, the daily
// buckets, audio uptime, and the audience backfill. This covers the class: no
// figure anywhere may move because a degradation was recorded.

test('a resolved degradation moves no downtime, uptime or listener-loss figure', () => {
  const id = 'acct';
  store.ensureStreams([id]);

  const now = Date.now();
  const WINDOW = 6 * 60 * 60 * 1000;
  for (let i = 0; i < 180; i++) {
    store.addSample(id, {
      timestamp: new Date(now - (180 - i) * 60 * 1000).toISOString(),
      status: 'up',
      responseTime: 10,
      listeners: 50,
    });
  }

  const before = {
    audioUptime: store.getAudioUptime([id], WINDOW),
    rollup: store.getPeriodRollup([id], WINDOW),
    audience: store.getAudienceSummary([id], WINDOW),
  };
  assert.equal(before.audioUptime, 100, 'the channel played throughout');

  // The worst case for every total: resolved, with a real duration, and with a
  // listener-impact verdict of 'confirmed' — because listeners on the failed
  // mount genuinely were cut off. That is true and must still not become
  // channel downtime.
  const degraded = store.addEvent({
    timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    streamId: id,
    streamName: 'Acct',
    type: 'degraded',
    severity: 'degraded',
    confirmed: true,
    scope: 'stream',
    message: 'Acct is serving 1 of 2 mounts',
    resolvedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    durationMs: 60 * 60 * 1000,
    durationLabel: '1h',
    detail: { present: 1, total: 2, impaired: [{ path: '/x_64', reason: 'missing' }], listenersBefore: 22, listenersKnown: true },
    diagnosis: { causeLabel: 'Mount missing from Icecast', listenerImpact: 'confirmed' },
    email: { attempted: false, sent: null },
  });

  const after = {
    audioUptime: store.getAudioUptime([id], WINDOW),
    rollup: store.getPeriodRollup([id], WINDOW),
    audience: store.getAudienceSummary([id], WINDOW),
  };

  assert.equal(after.audioUptime, before.audioUptime, 'an hour of degradation is not an hour off air');
  assert.equal(after.rollup.counts.failures, before.rollup.counts.failures, 'not a failure');
  assert.equal(after.rollup.counts.listenerAffecting, before.rollup.counts.listenerAffecting);
  assert.equal(after.rollup.downtime.wallClockMs, before.rollup.downtime.wallClockMs, 'no downtime added');
  assert.equal(
    after.audience.perStream[id].listenerMinutesLost,
    before.audience.perStream[id].listenerMinutesLost,
    'no listening counted as lost',
  );

  // And the backfill must not invent a channel-wide audience block for it. The
  // channel's own samples say 50 listeners were connected the whole time; costed
  // as an outage that becomes 3,000 listener-minutes of loss that never happened.
  store.backfillAudience();
  const stored = store.getEvents({ streamId: id }).events.find((e) => e.id === degraded.id);
  assert.equal(stored.audience, undefined, 'no reconstructed loss figure');
  assert.equal(stored.detail.listenersBefore, 22, 'the variant-scoped count is the one that stands');
});
