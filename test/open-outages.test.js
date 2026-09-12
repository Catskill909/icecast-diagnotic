/* ═══════════════════════════════════════════════════════════════════════════
   An outage still in progress is the most important thing on the page

   2026-09-12: WPFW's source dropped at 20:52 UTC and stayed down, ~390
   listeners gone. The outage WAS recorded. The app still did not show it:

     · Its station report read "100% uptime · 1 brief interruption, none lasting
       more than 0s". `durationMs` is written only at recovery, and every figure
       read it as `|| 0` — so the longer a station stayed down, the longer it
       read as fine. Same in the history page (it totals events in the browser),
       the audience-chart bands, and listener-hours lost.
     · The dashboard lists the newest few events; five other stations'
       recoveries pushed the one open outage off the list.
     · The dashboard feed is 24 hours; an outage on its second day vanishes.

   Underneath: episodes live in memory, so every restart orphaned the open
   outage — open for ever, a second event opened beside it if still down. The
   live record held 18 from the redeploys of 2026-09-02. Counting open outages
   "to now" without fixing that would have reported ten days off air.

   These tests are written against the CLASS: any open failure, any restart.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'open-outages-'));
process.env.SEED_FILE = '/nonexistent';

const MIN = 60 * 1000;
const HOST = 'stream.example.org:9000';
const ago = (mins) => new Date(Date.now() - mins * MIN).toISOString();

/** A fresh process's view of the same data directory — a real restart. */
function boot() {
  for (const m of ['../monitor', '../store', '../diagnose']) delete require.cache[require.resolve(m)];
  const store = require('../store');
  const diagnose = require('../diagnose');
  const monitor = require('../monitor');
  return { store, diagnose, monitor };
}

let { store, diagnose, monitor } = boot();
store.load();
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  stations: [
    { id: 'alpha', name: 'Alpha', timezone: 'UTC', alerts: { enabled: true, recipients: ['gm@alpha.example.org'] },
      channels: [{ id: 'alpha', name: 'Alpha', url: `https://${HOST}/alpha_128`, mounts: ['/alpha_128'] }] },
    { id: 'beta', name: 'Beta', timezone: 'UTC', alerts: { enabled: false, recipients: [] },
      channels: [{ id: 'beta', name: 'Beta', url: `https://${HOST}/beta_128`, mounts: ['/beta_128'] }] },
  ],
});
monitor.reloadConfig();

/** A confirmed outage whose diagnosis says Icecast answered and the mount was gone. */
function openOutage(streamId, startedMinsAgo, extra = {}) {
  return store.addEvent({
    timestamp: ago(startedMinsAgo), streamId, streamName: streamId,
    type: 'down', severity: 'outage', confirmed: true, scope: 'stream',
    message: `${streamId} is DOWN`, failedChecks: startedMinsAgo,
    lastCheckAt: ago(1),
    diagnosis: { cause: 'source_disconnected', causeLabel: 'Source disconnected', listenerImpact: 'confirmed',
      icecast: { reachable: true, mountPresent: false } },
    ...extra,
  });
}

function clearEvents() {
  for (const e of store.getEvents({}).events) store.updateEvent(e.id, { streamId: '__cleared__' });
}

// ── Aggregates: an open outage lasts until now ──────────────────────────────

test('an open outage counts to now in the period report, not as a zero-second blip', () => {
  clearEvents();
  openOutage('alpha', 75);

  const r = monitor.getPeriodRollup(24 * 60 * MIN, 'alpha');
  assert.strictEqual(r.counts.ongoing, 1);
  assert.strictEqual(r.counts.brief, 0, 'a 75-minute open outage was classed as brief');
  assert.strictEqual(r.counts.significant, 1);
  assert.ok(r.downtime.streamMs >= 74 * MIN, `downtime ${r.downtime.streamMs}ms — the open outage added nothing`);
  assert.ok(r.longestOutage && r.longestOutage.ongoing, 'the longest outage is the one still going');
  assert.ok(r.topIncidents.some((i) => i.ongoing), '"What happened" omits the outage in progress');
  assert.ok(r.perStream[0].uptime < 100, 'a station off air for 75 minutes read 100% uptime');
});

test('the events feed carries an open outage\'s duration so far, and never writes it back', () => {
  clearEvents();
  const ev = openOutage('alpha', 30);

  const served = monitor.getEvents({ streamId: 'alpha' }).events.find((e) => e.id === ev.id);
  assert.strictEqual(served.ongoing, true);
  assert.ok(served.durationMs >= 29 * MIN);
  assert.ok(!served.resolvedAt, 'an open outage must still read as open');

  const stored = store.getEvents({ streamId: 'alpha' }).events.find((e) => e.id === ev.id);
  assert.strictEqual(stored.durationMs, undefined, 'the provisional duration leaked into the stored record');
});

test('the dashboard feed includes an open outage that began more than 24 hours ago', () => {
  clearEvents();
  const old = openOutage('alpha', 30 * 60);
  const inc = monitor.getIncidents().find((e) => e.id === old.id);
  assert.ok(inc, 'an outage on its second day dropped off the dashboard');
  assert.strictEqual(inc.ongoing, true);
});

// ── Restarts: resume, or close as unobserved ────────────────────────────────

test('startup closes superseded orphans at their last observed failure, and invents no recovery', () => {
  clearEvents();
  const orphan = openOutage('alpha', 600, { lastCheckAt: ago(590), diagnosis: {
    cause: 'timeout', causeLabel: 'Connection timeout', listenerImpact: 'unknown', icecast: { reachable: false } } });
  // A later, resolved event: the monitor restarted and moved on.
  store.addEvent({ timestamp: ago(300), streamId: 'alpha', streamName: 'alpha', type: 'down', severity: 'brief_outage',
    resolvedAt: ago(299), durationMs: MIN, diagnosis: { cause: 'timeout' } });
  store.save(true);

  ({ store, diagnose, monitor } = boot());
  monitor._init();

  const e = store.getEvents({ streamId: 'alpha' }).events.find((x) => x.id === orphan.id);
  assert.ok(e.resolvedAt, 'the orphan is still open after a restart');
  assert.strictEqual(e.recoveryObserved, false);
  assert.strictEqual(e.durationMs, 10 * MIN, 'duration must run to the last failed check the monitor saw');
  assert.notStrictEqual(store.settledImpact(e), 'none',
    'an unobserved end was read as "the source held" — a real outage written off as harmless');
  store.load();   // runs backfillRecoveries again
  assert.ok(!store.getEvents({}).events.some((x) => x.type === 'up' && x.relatedTo === orphan.id),
    'a recovery event was manufactured for a recovery nobody observed');
});

async function cycle(down) {
  const realSnapshot = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: { reachable: true, mountCount: 1, mounts: down ? {} : {
      '/alpha_128': { pathname: '/alpha_128', listeners: 5, streamStart: ago(1) },
      '/beta_128': { pathname: '/beta_128', listeners: 5, streamStart: ago(1) } } } },
    hosts: [HOST], servers: [], reachable: true, mounts: {}, mountCount: 1,
  });
  diagnose.probeStream = async () => (down
    ? { status: 'down', responseTime: 40, httpStatus: 404, error: 'HTTP 404', errorCode: 'HTTP_404', timings: {} }
    : { status: 'up', responseTime: 12, isSilent: false, audioEnergy: 9, timings: {} });
  try { await monitor.runChecks(); } finally {
    diagnose.fetchHostSnapshots = realSnapshot;
    diagnose.probeStream = realProbe;
  }
}

function mailbox() {
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });
  return sent;
}

test('a restart mid-outage resumes the SAME event — no second record, no second email', async () => {
  clearEvents();
  store.save(true);
  ({ store, diagnose, monitor } = boot());
  monitor._init();
  let sent = mailbox();
  for (let i = 0; i < 3; i++) await cycle(true);
  const before = store.getEvents({ streamId: 'alpha', type: 'down' }).events;
  assert.strictEqual(before.length, 1);
  assert.strictEqual(sent.filter((m) => /DOWN/.test(m.subject)).length, 1);
  store.save(true);

  // Redeploy while still down.
  ({ store, diagnose, monitor } = boot());
  monitor._init();
  sent = mailbox();
  for (let i = 0; i < 3; i++) await cycle(true);

  for (const id of ['alpha', 'beta']) {
    const downs = store.getEvents({ streamId: id, type: 'down' }).events;
    assert.strictEqual(downs.length, 1, `${id}: a restart opened a second event beside the first`);
    assert.ok(!downs[0].resolvedAt, `${id}: the resumed outage must still be open`);
    assert.ok(downs[0].failedChecks >= 5, `${id}: the failure count restarted from one`);
  }
  assert.strictEqual(sent.length, 0, 'the resumed outage was emailed again after the restart');
  assert.strictEqual(monitor._storms().beta?.outages.length ?? 1, 1, 'the resumed outage was counted toward a storm twice');

  // And its recovery, when watched, is a normal observed one.
  await cycle(false);
  const done = store.getEvents({ streamId: 'alpha', type: 'down' }).events[0];
  assert.ok(done.resolvedAt);
  assert.notStrictEqual(done.recoveryObserved, false);
  monitor._setTransporter(null);
});

test('a stream that recovered during the restart is closed as unobserved, with no all-clear', async () => {
  clearEvents();
  const ev = openOutage('alpha', 20, { lastCheckAt: ago(5), alertedAt: ago(19), email: { attempted: true, sent: true } });
  store.save(true);

  ({ store, diagnose, monitor } = boot());
  monitor._init();
  const sent = mailbox();
  await cycle(false);

  const e = store.getEvents({ streamId: 'alpha' }).events.find((x) => x.id === ev.id);
  assert.ok(e.resolvedAt);
  assert.strictEqual(e.recoveryObserved, false);
  assert.ok(Math.abs(e.durationMs - 15 * MIN) < 2000, 'duration must run to the last failed check');
  assert.ok(!store.getEvents({ streamId: 'alpha', type: 'up' }).events.some((x) => x.relatedTo === ev.id),
    'a recovery nobody watched was recorded as observed');
  assert.strictEqual(sent.length, 0);
  monitor._setTransporter(null);
});
