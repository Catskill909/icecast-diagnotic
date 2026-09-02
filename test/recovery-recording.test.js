/* ═══════════════════════════════════════════════════════════════════════════
   A recovery is RECORDED whether or not it is emailed

   On 2026-09-02 WPFW went down at 09:46 and came back four minutes later. The
   dashboard showed the outage — with "lasted 4m" on it, so the recovery had
   plainly been observed and measured — and no RECOVERED row at all. Across the
   whole 512-event production record, the two stations whose alerts are switched
   off had 5 outages and 0 recoveries between them, while the three KPFT
   channels had 107 outages and 115 recoveries.

   THE MECHANISM: writing the `up` event was gated on `episode.alerted`, a flag
   set only inside the branch that sends mail. Muting a station therefore did not
   mute it — it erased half its history. The same hole swallowed 8 recoveries on
   KPFT, where alerts ARE on: a confirmed outage that the listener-impact gate
   declined to email never set `alerted` either.

   These cover the CLASS: for every reason an all-clear might not be sent, the
   event still has to exist. The specific station is incidental.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must precede the requires: store.js resolves DATA_DIR once at module load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-recording-'));

const store = require('../store');
const monitor = require('../monitor');

const T0 = '2026-09-02T13:46:29.657Z';
const T1 = '2026-09-02T13:50:29.665Z';
const FOUR_MIN = 4 * 60 * 1000;

/** A station whose alerts are switched off — WPFW's shape. */
const muted = (id) => ({
  id, name: id.toUpperCase(), stationId: id,
  stationAlerts: { enabled: false, recipients: [] },
});

/** A station that does email — KPFT's shape. */
const alerting = (id) => ({
  id, name: id.toUpperCase(), stationId: id,
  stationAlerts: { enabled: true, recipients: ['gm@example.org'] },
});

function recoveryOf(stream, { alerted }) {
  const down = store.addEvent({
    timestamp: T0,
    streamId: stream.id,
    streamName: stream.name,
    type: 'down',
    severity: 'outage',
    confirmed: true,
    message: `${stream.name} is DOWN`,
  });
  return {
    stream,
    result: { responseTime: 282 },
    diagnosis: { scope: 'stream', causeLabel: 'Source encoder disconnected' },
    episode: { eventId: down.id, startedAt: T0, alerted, severity: 'outage' },
    durationMs: FOUR_MIN,
    sourceOutage: null,
    audience: { listenersBefore: 66 },
    downId: down.id,
  };
}

const upFor = (downId) =>
  store.getEvents().events.find((e) => e.type === 'up' && e.relatedTo === downId);

// ── The reported instance, and every sibling of it ──────────────────────────

test('a muted station records its recovery, and says why no mail went out', async () => {
  const r = recoveryOf(muted('wpfw'), { alerted: false });
  await monitor.dispatchNotifications([], [r], { allDown: false, timestamp: T1 });

  const up = upFor(r.downId);
  assert.ok(up, 'the recovery event must exist — muting decides mail, not history');
  assert.equal(up.type, 'up');
  assert.equal(up.severity, 'recovery');
  assert.equal(up.durationLabel, '4m');
  assert.equal(up.email.attempted, false);
  assert.match(up.email.reason, /switched off for station "wpfw"/);
});

test('a confirmed outage that was never emailed still records its recovery', async () => {
  // The listener-impact gate suppressed the alert: Icecast kept serving the
  // mount, so nobody was told. The outage was still confirmed and still ended.
  const r = recoveryOf(alerting('kpft-main'), { alerted: false });
  await monitor.dispatchNotifications([], [r], { allDown: false, timestamp: T1 });

  const up = upFor(r.downId);
  assert.ok(up, 'an unemailed outage is still an outage that ended');
  assert.equal(up.email.attempted, false);
  assert.equal(up.email.reason, 'no all-clear sent — the outage it ends was not emailed');
});

test('an emailed outage still records its recovery, and attempts the all-clear', async () => {
  const sent = [];
  monitor._setTransporter({
    sendMail: async ({ to, subject }) => {
      sent.push(subject);
      const addrs = String(to).split(',').map((a) => a.trim());
      return { messageId: '<m@example.org>', accepted: addrs, rejected: [] };
    },
  });
  const saved = process.env.ALERTS_FORCE;
  process.env.ALERTS_FORCE = '1';
  try {
    const r = recoveryOf(alerting('kpft-hd2'), { alerted: true });
    await monitor.dispatchNotifications([], [r], { allDown: false, timestamp: T1 });

    const up = upFor(r.downId);
    assert.ok(up, 'the path that always worked must keep working');
    assert.equal(up.email.attempted, true, 'an alerted outage gets its all-clear');
    assert.equal(sent.length, 1);
  } finally {
    if (saved === undefined) delete process.env.ALERTS_FORCE;
    else process.env.ALERTS_FORCE = saved;
    monitor._setTransporter(null);
  }
});

test('every recovery in a batch is recorded, not only the emailable ones', async () => {
  // A server-level failure takes muted and alerting stations down together. The
  // batch used to be filtered down to the emailable ones before anything was
  // written, so the muted half of a shared outage vanished.
  const a = recoveryOf(muted('wbai-wpfw'), { alerted: false });
  const b = recoveryOf(alerting('kpft-hd3'), { alerted: false });
  await monitor.dispatchNotifications([], [a, b], { allDown: true, timestamp: T1 });

  assert.ok(upFor(a.downId), 'muted station');
  assert.ok(upFor(b.downId), 'alerting station whose outage was not emailed');
});

// ── "Self-cleared" must mean self-cleared ───────────────────────────────────
// The same conflation, one field along: `selfCleared: !episode.alerted` labelled
// every unemailed outage as having cleared before confirmation. WPFW's 4-minute
// outage carried `confirmed: true` and `selfCleared: true` at once, and the
// event detail rendered "Self-cleared before confirmation" on it.

test('a confirmed outage is never self-cleared, however quiet it was', () => {
  for (const alerted of [true, false]) {
    assert.equal(
      monitor.isSelfCleared({ severity: 'outage', alerted }), false,
      `confirmed outage, alerted=${alerted}`,
    );
  }
});

test('a failure that never reached confirmation is self-cleared', () => {
  assert.equal(monitor.isSelfCleared({ severity: 'brief_outage', alerted: false }), true);
  assert.equal(monitor.isSelfCleared({ severity: 'probe_error', alerted: false }), true);
});

// ── Backfill: the history that was already lost ─────────────────────────────

test('backfillRecoveries writes the missing event from the outage record', () => {
  const down = store.addEvent({
    timestamp: T0,
    streamId: 'wpfw-backfill',
    streamName: 'WPFW Washington DC',
    type: 'down',
    severity: 'outage',
    confirmed: true,
    resolvedAt: T1,
    durationMs: FOUR_MIN,
    durationLabel: '4m',
    message: 'WPFW Washington DC is DOWN',
  });

  assert.equal(store.backfillRecoveries(), 1);

  const up = upFor(down.id);
  assert.ok(up);
  assert.equal(up.timestamp, T1, 'the recovery happened when the check saw it, not now');
  assert.equal(up.durationLabel, '4m');
  assert.equal(up.reconstructed, true, 'a backfilled row must never read as a live observation');
  assert.match(up.message, /RECOVERED after 4m/);
});

test('backfillRecoveries is idempotent', () => {
  const before = store.getEvents().total;
  assert.equal(store.backfillRecoveries(), 0);
  assert.equal(store.getEvents().total, before, 'a second boot must not duplicate anything');
});

test('backfill leaves alone what was never observed to recover', () => {
  const open = store.addEvent({
    timestamp: T0, streamId: 'still-down', streamName: 'Still Down',
    type: 'down', severity: 'outage', confirmed: true, message: 'down',
  });
  const abandoned = store.addEvent({
    timestamp: T0, streamId: 'abandoned', streamName: 'Abandoned',
    type: 'down', severity: 'outage', confirmed: true,
    resolvedAt: T1, durationMs: FOUR_MIN, durationLabel: '4m',
    abandoned: true, message: 'down',
  });
  // Unconfirmed failures never had a recovery event by design — inventing
  // all-clears for one-check blips would bury the outages that matter.
  const blip = store.addEvent({
    timestamp: T0, streamId: 'blippy', streamName: 'Blippy',
    type: 'down', severity: 'brief_outage', confirmed: false,
    resolvedAt: T1, durationMs: 60000, durationLabel: '1m', message: 'blip',
  });
  const probe = store.addEvent({
    timestamp: T0, streamId: 'probey', streamName: 'Probey',
    type: 'down', severity: 'probe_error', confirmed: false,
    resolvedAt: T1, durationMs: 60000, durationLabel: '1m', message: 'probe',
  });

  assert.equal(store.backfillRecoveries(), 0);
  for (const e of [open, abandoned, blip, probe]) {
    assert.equal(upFor(e.id), undefined, `${e.streamId} must not gain a recovery`);
  }
});

test('a backfilled recovery is inserted in time order, not appended', () => {
  // One stream, an old outage that lost its recovery, and a NEW outage that is
  // still open. findOpenOutage() walks the record backwards and stops at the
  // first 'up' it meets, so appending the reconstructed recovery at the end
  // would hide the open outage behind it and report a stream that is off the
  // air as healthy.
  const resolved = store.addEvent({
    timestamp: '2026-09-01T10:00:00.000Z',
    streamId: 'order-check', streamName: 'Order Check',
    type: 'down', severity: 'outage', confirmed: true,
    resolvedAt: '2026-09-01T10:04:00.000Z', durationMs: FOUR_MIN, durationLabel: '4m',
    message: 'down',
  });
  const stillOpen = store.addEvent({
    timestamp: '2026-09-01T18:00:00.000Z',
    streamId: 'order-check', streamName: 'Order Check',
    type: 'down', severity: 'outage', confirmed: true, message: 'down again',
  });

  assert.equal(store.backfillRecoveries(), 1);
  assert.ok(upFor(resolved.id), 'the old outage gets its recovery');

  const open = store.findOpenOutage('order-check');
  assert.ok(open, 'the still-open outage must remain findable');
  assert.equal(open.id, stillOpen.id);
});
