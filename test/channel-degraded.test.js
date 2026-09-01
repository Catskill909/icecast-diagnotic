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
const os = require('os');
const path = require('path');
const fs = require('fs');

// MUST be set before ../store is required for the first time, anywhere in this
// file. store.js resolves DATA_DIR once at module load, so a require that runs
// earlier binds the developer's real data/ directory — and this suite then
// writes its fixture station and samples straight into it. That is exactly what
// used to happen: the require below sat above this line, and running the suite
// replaced a local configuration with the test's own.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'degraded-test-'));

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
  const realSnapshot = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;

  // Stubbed at fetchHostSnapshots, which is what a cycle calls: inventories are
  // fetched per host, since a mount path only means anything on its own server.
  const HOST = 'stream.example.org:9000';
  diagnose.fetchHostSnapshots = async () => {
    order.push('snapshot');
    const perHost = {
      reachable: true,
      mountCount: 2,
      mounts: { '/a_128': mount(10), '/a_64': mount(5) },
    };
    return {
      byHost: { [HOST]: perHost },
      hosts: [HOST],
      servers: [],
      reachable: true,
      mounts: {},
      mountCount: 2,
    };
  };
  diagnose.probeStream = async () => {
    order.push('probe');
    return { status: 'up', responseTime: 12, isSilent: false, audioEnergy: 9, timings: {} };
  };

  try {
    await monitor.runChecks();
  } finally {
    diagnose.fetchHostSnapshots = realSnapshot;
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

// ── When a degradation is worth an email ────────────────────────────────────
// Never on its own: the channel is still playing for most of its audience, and
// a message that reads like an outage for something that is not one is how a
// station learns to ignore the next alert. But a variant dead for half an hour
// with listeners on it is a real loss nobody would otherwise find out about —
// the dashboard shows it and nobody is watching the dashboard at 4am.
//
// Sustained AND costing listeners. Either alone stays silent and recorded.

const ALERT_STREAM = { id: 'alrt', name: 'Alert Channel', url: CH.url, mounts: CH.mounts };
const notices = () => ({ alerts: [], recoveries: [] });
const gone = () => channelDegradation(snap({ '/live_128': mount(37) }), FULL, ALERT_STREAM);
const whole = () => channelDegradation(FULL, FULL, ALERT_STREAM);

test('a short degradation is recorded and not emailed', () => {
  const n = notices();
  monitor.trackVariantDegradation(ALERT_STREAM, gone(), at(0), n);
  monitor.trackVariantDegradation(ALERT_STREAM, gone(), at(5), n);
  assert.deepEqual(n.alerts, [], 'five minutes is not sustained');
});

test('a sustained degradation with listeners on it escalates exactly once', () => {
  const n = notices();
  monitor.trackVariantDegradation(ALERT_STREAM, gone(), at(30), n);
  assert.equal(n.alerts.length, 1, 'the 30-minute threshold is crossed');
  assert.equal(n.alerts[0].episode.listenersBefore, 22);

  monitor.trackVariantDegradation(ALERT_STREAM, gone(), at(40), n);
  monitor.trackVariantDegradation(ALERT_STREAM, gone(), at(90), n);
  assert.equal(n.alerts.length, 1, 'still one — not one per cycle for as long as it lasts');
});

test('recovery after an alert sends an all-clear', () => {
  // An alert with no all-clear trains people to ignore the next one.
  const n = notices();
  monitor.trackVariantDegradation(ALERT_STREAM, whole(), at(100), n);
  assert.equal(n.recoveries.length, 1);
  assert.equal(n.alerts.length, 0);
});

test('a degradation nobody was told about gets no all-clear', () => {
  const quiet = { id: 'quiet', name: 'Quiet', url: CH.url, mounts: CH.mounts };
  const n = notices();
  monitor.trackVariantDegradation(quiet, channelDegradation(snap({ '/live_128': mount(37) }), FULL, quiet), at(0), n);
  monitor.trackVariantDegradation(quiet, channelDegradation(FULL, FULL, quiet), at(10), n);
  assert.deepEqual(n.recoveries, [], 'announcing the end of something never announced is noise');
});

test('a sustained degradation nobody was listening to stays silent', () => {
  const empty = { id: 'empty', name: 'Empty', url: CH.url, mounts: CH.mounts };
  const before = snap({ '/live_128': mount(37), '/live_64': mount(0) });
  const now = snap({ '/live_128': mount(37) });
  const n = notices();
  for (const m of [0, 30, 60, 120]) {
    monitor.trackVariantDegradation(empty, channelDegradation(now, before, empty), at(m), n);
  }
  assert.deepEqual(n.alerts, [], 'sustained, but it cost nobody anything');
});

// ── Per-mount audience history ──────────────────────────────────────────────

test('the listener series carries a per-mount breakdown', () => {
  const id = 'series';
  store.ensureStreams([id]);
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    store.addSample(id, {
      timestamp: new Date(now - (10 - i) * 60 * 1000).toISOString(),
      status: 'up',
      responseTime: 10,
      listeners: 60,
      mountListeners: { '/live_128': 40, '/live_64': 20 },
    });
  }
  const series = store.getListenerSeries(id, 60 * 60 * 1000);
  const last = series[series.length - 1];
  assert.equal(last.avg, 60, 'the summed figure is unchanged');
  assert.deepEqual(last.byMount, { '/live_128': 40, '/live_64': 20 });
});

test('buckets with no per-mount data say so by absence, not by zero', () => {
  // Samples written before this existed, and hourly rollups, carry no
  // breakdown. Reporting {} would claim every mount had no listeners.
  const id = 'legacy';
  store.ensureStreams([id]);
  store.addSample(id, {
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    status: 'up', responseTime: 10, listeners: 60,
  });
  const series = store.getListenerSeries(id, 60 * 60 * 1000);
  assert.equal(series[series.length - 1].byMount, undefined);
});

// ── Station scoping ─────────────────────────────────────────────────────────
// "Every aggregate must be scoped by station" is a standing invariant here: with
// two stations, a figure that quietly covers both reports one station's numbers
// as another's. getListeners() computed its series from the scoped set but
// returned the FULL stream list beside it. The audience chart happened to filter
// on which ids had a series, so nothing looked wrong — which is exactly why it
// survived. The new audience page reads that list directly.

test('getListeners returns only the requested station\'s channels', () => {
  store.setStationConfig({
    version: 1,
    hosts: [{ id: 'h', host: 'stream.example.org:9000', statusUrl: 'https://stream.example.org:9000/status-json.xsl' }],
    stations: [
      {
        id: 'alpha',
        name: 'Alpha',
        timezone: 'UTC',
        channels: [{ id: 'a1', name: 'A1', url: 'https://stream.example.org:9000/a_128', mounts: ['/a_128'] }],
      },
      {
        id: 'beta',
        name: 'Beta',
        timezone: 'UTC',
        channels: [{ id: 'b1', name: 'B1', url: 'https://stream.example.org:9000/b_128', mounts: ['/b_128'] }],
      },
    ],
  });
  monitor.reloadConfig();

  const all = monitor.getListeners(60 * 60 * 1000, undefined, null);
  assert.deepEqual(all.streams.map((s) => s.id).sort(), ['a1', 'b1'], 'unscoped means every station');

  const alpha = monitor.getListeners(60 * 60 * 1000, undefined, 'alpha');
  assert.deepEqual(alpha.streams.map((s) => s.id), ['a1'], "Beta's channel must not appear in Alpha's payload");
  assert.deepEqual(Object.keys(alpha.series), ['a1'], 'and the series agree with the list');
});

test('the audience payload carries what the page renders from', () => {
  const alpha = monitor.getListeners(60 * 60 * 1000, undefined, 'alpha');
  const s = alpha.streams[0];
  assert.deepEqual(s.mounts, ['/a_128'], 'every mount, for the per-mount breakdown');
  assert.equal(Array.isArray(s.hourProfile), true, 'hour-of-day profile');
  assert.equal(s.hourProfile.length, 24);
  assert.ok('current' in s, 'live listener count, which no windowed average shows');
});

// ── Aggregate Tuning Hours ──────────────────────────────────────────────────
// ATH is the figure a US noncommercial webcaster's royalty rate is computed
// from — the annual fee covers each channel's first 159,140 per month. So it is
// not an engagement metric that can be roughly right: it is a number with a
// threshold and money attached, and the ways it can mislead are specific.
//
// It is also an ESTIMATE, derived from polling counts once a minute rather than
// from a log of connections. The tests below cover both the arithmetic and the
// labelling, because an unqualified figure someone files on is the worst thing
// this page could produce.

const MIN = 60 * 1000;

function seedAth(id, { listeners, minutes, endingMsAgo = 0, now = Date.now() }) {
  store.ensureStreams([id]);
  const end = now - endingMsAgo;
  for (let i = minutes; i > 0; i--) {
    store.addSample(id, {
      timestamp: new Date(end - i * MIN).toISOString(),
      status: 'up',
      responseTime: 10,
      listeners,
    });
  }
}

/**
 * A moment with a month already well underway.
 *
 * PINNED, because these assertions are about a month that started before we
 * were watching — and the wall clock supplies that for twenty-nine days in
 * thirty. Run in the first hours of the 1st, the elapsed month is SHORTER than
 * the fixture's own hour of history, so coverage stops being a subset of the
 * month and both invariants inverted. CI went red at 01:00 UTC on 1 September
 * having been green all August, on a commit that touched none of this.
 *
 * A test whose result depends on the day it runs is not testing the code.
 */
const MID_MONTH = Date.parse('2026-08-14T12:00:00.000Z');

test('ATH is listener-hours: ten listeners for an hour is ten', () => {
  seedAth('ath1', { listeners: 10, minutes: 60 });
  assert.equal(Math.round(store.getAth(['ath1'], 2 * 60 * MIN)), 10);
});

test('the same listening split across two channels totals the same', () => {
  // The allowance is per channel, but a station-level figure has to be the sum —
  // if these disagreed, the two views of one month would contradict each other.
  seedAth('ath2a', { listeners: 5, minutes: 60 });
  seedAth('ath2b', { listeners: 5, minutes: 60 });
  const combined = store.getAth(['ath2a', 'ath2b'], 2 * 60 * MIN);
  assert.equal(Math.round(combined), 10);
});

test('the month runs on the station clock, not UTC', () => {
  // A month boundary is only meaningful in a timezone. Chicago's month starts
  // five or six hours after UTC's, and a station near the threshold on the 1st
  // would otherwise be shown someone else's month.
  const chi = store.getMonthToDateAth(['ath1'], 'America/Chicago');
  const utc = store.getMonthToDateAth(['ath1'], 'UTC');
  assert.notEqual(chi.monthStart, utc.monthStart);
  assert.match(chi.monthStart, /T0[56]:00:00/, 'Chicago midnight expressed in UTC');
  assert.equal(chi.timeZone, 'America/Chicago');
});

test('the figure always declares itself an estimate', () => {
  // Not a cosmetic flag. It is polled counts, not a connection census, and the
  // UI keys its caveat off this. It must not be droppable by accident.
  const m = store.getMonthToDateAth(['ath1'], 'UTC');
  assert.equal(m.estimated, true);
  assert.equal(m.allowance, 159140, 'the SoundExchange noncommercial allowance');
});

test('a month that began before monitoring did is flagged partial', () => {
  // Otherwise the month-to-date figure reads as a total when it is a floor.
  // An hour of history, thirteen days into the month: the month plainly began
  // first, and that is the case the flag exists for.
  seedAth('ath-partial', { listeners: 10, minutes: 60, now: MID_MONTH });
  const m = store.getMonthToDateAth(['ath-partial'], 'UTC', MID_MONTH);
  assert.equal(m.partial, true, 'this stream has minutes of history, not a month');
  assert.ok(m.coveredMs < m.elapsedMs, 'and the covered span says so');
});

test('the projection is rated over what was watched, not the elapsed month', () => {
  // The failure this prevents: a monitor that started recently has an empty
  // stretch of month in its record that was not a stretch of no listeners.
  // Rating over elapsed time would project far too low — on the one number whose
  // entire purpose is warning about a threshold.
  seedAth('ath-proj', { listeners: 10, minutes: 60, now: MID_MONTH });
  const m = store.getMonthToDateAth(['ath-proj'], 'UTC', MID_MONTH);
  const elapsedRate = (m.ath / m.elapsedMs) * (new Date(m.monthEnd) - new Date(m.monthStart));
  assert.ok(
    m.projected > elapsedRate * 2,
    `projection ${m.projected} must not be rated over the whole elapsed month (${Math.round(elapsedRate)})`,
  );
});

test('the trend is withheld rather than guessed when history is too short', () => {
  // A monitor watching for four days comparing week against week would report a
  // collapse in listening that only ever happened to the recording.
  store.setStationConfig({
    version: 1,
    hosts: [{ id: 'h', host: 'stream.example.org:9000', statusUrl: 'https://stream.example.org:9000/status-json.xsl' }],
    stations: [{
      id: 'trend',
      name: 'Trend',
      timezone: 'America/Chicago',
      channels: [{ id: 'ath1', name: 'Ath1', url: 'https://stream.example.org:9000/a_128', mounts: ['/a_128'] }],
    }],
  });
  monitor.reloadConfig();

  const payload = monitor.getListeners(30 * 24 * 60 * MIN, undefined, 'trend');
  const w = payload.streams[0].ath.window;
  assert.equal(w.previous, null, 'no comparable earlier window exists');
  assert.equal(w.changePct, null);
});

test('the station timezone reaches ATH from the station config', () => {
  const payload = monitor.getListeners(24 * 60 * MIN, undefined, 'trend');
  assert.equal(payload.streams[0].ath.month.timeZone, 'America/Chicago');
});
