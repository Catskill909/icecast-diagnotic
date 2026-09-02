/* ═══════════════════════════════════════════════════════════════════════════
   A repeating fault is one fault, and gets one alert

   On 2026-09-02 KPFT's source encoder cycled for over an hour. Between 12:16
   and 13:02 the inbox took FOURTEEN messages — DOWN, RECOVERED, DOWN, RECOVERED
   — for a single ongoing fault whose cause never changed.

   THE MECHANISM: every gate in monitor.js asks the same question, and it is a
   question about ONE episode. Is this outage confirmed? Did it cost listeners?
   Is Icecast still serving the mount? A flapping encoder answers those honestly
   and correctly every single time — each disconnect really does drop every
   connected player — so nothing suppressed anything. The consolidation that
   existed was SPATIAL (several streams at once become one message) and there
   was none at all across TIME.

   That is the class: an alerting decision with no memory of the previous
   episode floods on any fault that repeats. These tests replay the real
   sequence, and the sequences either side of it that must NOT be silenced —
   because a mechanism that quiets a genuine isolated outage is worse than the
   flood it replaced.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must precede the requires: store.js resolves DATA_DIR once at module load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-storm-'));

const store = require('../store');
const monitor = require('../monitor');

const MIN = 60 * 1000;

const kpftMain = {
  id: 'kpft-main',
  name: 'KPFT Main',
  stationId: 'kpft',
  stationName: 'KPFT Houston',
  stationTimezone: 'America/Chicago',
  stationAlerts: { enabled: true, recipients: ['gm@example.org'] },
};

const at = (mins) => new Date(Date.UTC(2026, 8, 2, 17, 0, 0) + mins * MIN).toISOString();

function reset() {
  monitor._resetStorms();
  store.setMeta('storms', {});
  monitor._setStreams([kpftMain]);
  monitor._setEpisodes({});
}

/**
 * One complete outage: it becomes alertable at `startMin` and recovers at
 * `endMin`. Returns the mail verdict the monitor reached for the DOWN.
 */
function outage(startMin, endMin, { listenersBefore = 14 } = {}) {
  const verdict = monitor.noteStormEpisode(kpftMain, at(startMin));
  monitor.noteStormClear(kpftMain, {
    durationMs: (endMin - startMin) * MIN,
    audience: { listenersBefore, listenerMinutesLost: listenersBefore * (endMin - startMin) },
    timestamp: at(endMin),
  });
  return verdict;
}

// ── The reported instance ───────────────────────────────────────────────────

test('the real 2026-09-02 flap sequence sends two alerts, not fourteen', async () => {
  reset();

  // Every DOWN/RECOVERED pair visible in the inbox that hour, in order.
  const pairs = [
    [16, 22], [22, 36], [38, 39], [45, 49], [51, 58], [55, 59], [60, 62],
  ];
  const verdicts = pairs.map(([a, b]) => outage(a, b));

  const emailed = verdicts.filter((v) => v !== 'suppress');
  assert.strictEqual(emailed.length, 2, `expected 2 emailed outages, got ${emailed.length}: ${verdicts}`);
  assert.deepStrictEqual(verdicts.slice(0, 2), ['alert', 'declare']);
  assert.ok(verdicts.slice(2).every((v) => v === 'suppress'), 'every later flap must be silent');
});

test('every suppressed outage is still counted, so the summary can total them', () => {
  reset();
  const pairs = [[16, 22], [22, 36], [38, 39], [45, 49], [51, 58], [55, 59], [60, 62]];
  pairs.forEach(([a, b]) => outage(a, b));

  const totals = monitor.stormTotals(monitor._storms()['kpft-main']);
  assert.strictEqual(totals.outages, 7, 'the record must cover the whole storm, not just the emailed part');
  assert.ok(totals.downtimeMs > 0);
  assert.ok(totals.listenerMinutesLost > 0, 'the audience cost is the point of the summary');
  assert.strictEqual(totals.peakListeners, 14);
});

// ── The mechanism must not silence a real outage ────────────────────────────

test('an isolated outage always alerts — one fault is not a storm', () => {
  reset();
  assert.strictEqual(outage(0, 8), 'alert');
});

test('outages further apart than the window are separate faults, not a storm', () => {
  reset();
  assert.strictEqual(outage(0, 8), 'alert');
  // 90 minutes later — twice the window. Nothing connects these two.
  assert.strictEqual(outage(90, 98), 'alert');
});

test('a slow flap inside the window still trips — the gate is time, not tempo', () => {
  reset();
  assert.strictEqual(outage(0, 8), 'alert');
  // 40 minutes on: too slow to look like a flap, still the same encoder fault.
  assert.strictEqual(outage(40, 48), 'declare');
});

// ── Ending a storm ──────────────────────────────────────────────────────────

test('a storm ends only after uninterrupted health, and emails one summary', async () => {
  reset();
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  outage(0, 8);
  outage(10, 14);   // declares
  outage(20, 24);   // suppressed

  // 25 minutes of health — short of the 30-minute clear window.
  await monitor.resolveStorms(at(49));
  assert.strictEqual(sent.length, 0, 'a storm must not be called over early');
  assert.ok(monitor._storms()['kpft-main'].active);

  // Past it.
  await monitor.resolveStorms(at(56));
  assert.strictEqual(sent.length, 1, 'exactly one summary email ends a storm');
  assert.match(sent[0].subject, /STABLE/);
  assert.match(sent[0].subject, /3 outages/);
  assert.strictEqual(monitor._storms()['kpft-main'], undefined, 'the storm is over and forgotten');

  monitor._setTransporter(null);
});

test('a flap during the quiet window restarts the clock rather than ending the storm', async () => {
  reset();
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  outage(0, 8);
  outage(10, 14);   // declares

  await monitor.resolveStorms(at(40));       // 26 min of health — not yet
  assert.strictEqual(sent.length, 0);

  outage(41, 45);                             // back down; the clock restarts
  await monitor.resolveStorms(at(70));        // 25 min since THAT recovery
  assert.strictEqual(sent.length, 0, 'health is measured from the last recovery, not the first');

  await monitor.resolveStorms(at(76));
  assert.strictEqual(sent.length, 1);

  monitor._setTransporter(null);
});

test('a stream that is down right now is never declared stable', async () => {
  reset();
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  outage(0, 8);
  outage(10, 14);
  monitor._setEpisodes({ 'kpft-main': { eventId: 'x', startedAt: at(40), severity: 'outage' } });

  await monitor.resolveStorms(at(80));
  assert.strictEqual(sent.length, 0, 'an open episode means the stream is not well');

  monitor._setEpisodes({});
  monitor._setTransporter(null);
});

// ── Surviving a redeploy ────────────────────────────────────────────────────

test('a storm survives a restart — otherwise the flood begins again from email one', () => {
  reset();
  outage(0, 8);
  outage(10, 14);   // declares
  assert.ok(monitor._storms()['kpft-main'].active);

  // What a redeploy does: the process forgets everything and reads the store.
  monitor._resetStorms();
  monitor.loadStorms();

  assert.ok(monitor._storms()['kpft-main']?.active, 'storm state must be persisted');
  assert.strictEqual(outage(20, 24), 'suppress', 'a restart must not re-open the floodgate');
});

// ── What the recipient is actually told ─────────────────────────────────────

test('the declaring alert says the silence that follows is deliberate', () => {
  const { subject, html } = monitor.composeAlert({
    kind: 'down',
    scope: 'stream',
    entries: [{
      stream: kpftMain,
      result: { responseTime: 0, error: 'socket hang up' },
      diagnosis: { scope: 'stream', causeLabel: 'Source encoder disconnected', cause: 'source_disconnected' },
      audience: { listenersBefore: 14 },
      storm: { outages: 2, spanMs: 14 * MIN, since: at(0), downtimeMs: 8 * MIN, listenerMinutesLost: 112, peakListeners: 14 },
    }],
  });

  assert.match(subject, /UNSTABLE/, 'the subject must not read as a plain first outage');
  assert.match(html, /alerts for KPFT Main are paused/i);
  assert.match(html, /recorded on the dashboard/i);
});

test('the summary reports the whole storm, not the last outage of it', () => {
  const { subject, html } = monitor.composeAlert({
    kind: 'storm_cleared',
    scope: 'stream',
    entries: [{
      stream: kpftMain,
      storm: {
        outages: 9, spanMs: 134 * MIN, downtimeMs: 31 * MIN,
        listenerMinutesLost: 310, peakListeners: 33,
        since: at(0), steadyMs: 30 * MIN,
      },
    }],
  });

  assert.match(subject, /STABLE/);
  assert.match(subject, /9 outages/);
  assert.match(html, /310 listener-minutes lost/);
  assert.match(html, /33 listeners/);
});

// ── The suppression reaches the mail, not just the decision ─────────────────

test('no all-clear is emailed while a storm is running', async () => {
  reset();
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  outage(0, 8);
  outage(10, 14);   // declares — storm now active

  const down = store.addEvent({
    timestamp: at(10), streamId: kpftMain.id, streamName: kpftMain.name,
    type: 'down', severity: 'outage', confirmed: true, message: 'DOWN',
  });

  await monitor.dispatchNotifications([], [{
    stream: kpftMain,
    result: { responseTime: 210 },
    diagnosis: { scope: 'stream', causeLabel: 'Source encoder disconnected' },
    // `alerted` is true: this is the outage that DECLARED the storm and was
    // emailed. Its all-clear is still the second half of a pair, and the
    // storm's own summary is what replaces it.
    episode: { eventId: down.id, startedAt: at(10), alerted: true, severity: 'outage' },
    durationMs: 4 * MIN,
    sourceOutage: null,
    audience: { listenersBefore: 14 },
  }], { allDown: false, timestamp: at(14) });

  assert.strictEqual(sent.length, 0, 'a RECOVERED email during a storm is half the flood');

  // Recorded regardless — muting the mail never mutes the history.
  const up = store.getEvents().events.find((e) => e.type === 'up' && e.relatedTo === down.id);
  assert.ok(up, 'the recovery event must still exist');
  assert.match(up.email.reason, /flapping/);

  monitor._setTransporter(null);
});

/* ═══════════════════════════════════════════════════════════════════════════
   The same class, in the dead-air path

   Two faults found by sweeping the other senders for the same mechanism:

   1. Dead air had no memory across episodes either. An encoder feeding
      intermittent silence floods exactly like one dropping its connection, and
      dead air is the ONE state the policy says always emails — so it had no
      other gate to slow it down at all.

   2. resolveDeadAir() and the dead-air alarm called sendAlert() directly and so
      never consulted alertsEnabledFor(). recipientsFor() answers with the
      station's stored list whether or not the station is enabled, so a station
      with alerts switched off was emailed its dead air anyway. Every other
      sender in monitor.js checks; these two were the exception.
   ═══════════════════════════════════════════════════════════════════════════ */

const muted = { ...kpftMain, id: 'wpfw-main', name: 'WPFW Main', stationId: 'wpfw',
  stationAlerts: { enabled: false, recipients: ['gm@wpfw.example.org'] } };

test('outages and dead air share one storm — alternating symptoms are one fault', () => {
  reset();
  // Down, back, then silent: the same encoder, two symptoms.
  assert.strictEqual(monitor.noteStormEpisode(kpftMain, at(0)), 'alert');
  monitor.noteStormClear(kpftMain, { durationMs: 4 * MIN, audience: { listenersBefore: 14 }, timestamp: at(4) });
  assert.strictEqual(
    monitor.noteStormEpisode(kpftMain, at(10)), 'declare',
    'a second symptom of the same fault must not get its own fresh budget of emails',
  );
});

test('a muted station is not emailed its dead air, and the event says why', async () => {
  reset();
  monitor._setStreams([muted]);
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  const down = store.addEvent({
    timestamp: at(0), streamId: muted.id, streamName: muted.name,
    type: 'dead_air', severity: 'dead_air', confirmed: true, message: 'DEAD AIR',
  });
  monitor._setEpisodes({ [muted.id]: { eventId: down.id, startedAt: at(0), alerted: false, severity: 'dead_air' } });

  await monitor.resolveDeadAir(muted, { responseTime: 190, audioEnergy: 0.4 }, at(6));

  assert.strictEqual(sent.length, 0, 'a station with alerts off must not be emailed');
  const up = store.getEvents().events.find((e) => e.type === 'up' && e.relatedTo === down.id);
  assert.ok(up, 'the recovery is recorded whether or not it is emailed');
  assert.match(up.email.reason, /switched off/);

  monitor._setEpisodes({});
  monitor._setTransporter(null);
});

test('no dead-air all-clear is emailed while a storm is running', async () => {
  reset();
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  outage(0, 8);
  outage(10, 14);   // declares — storm active

  const down = store.addEvent({
    timestamp: at(20), streamId: kpftMain.id, streamName: kpftMain.name,
    type: 'dead_air', severity: 'dead_air', confirmed: true, message: 'DEAD AIR',
  });
  monitor._setEpisodes({ [kpftMain.id]: { eventId: down.id, startedAt: at(20), alerted: true, severity: 'dead_air' } });

  await monitor.resolveDeadAir(kpftMain, { responseTime: 190, audioEnergy: 0.4 }, at(24));

  assert.strictEqual(sent.length, 0, 'the storm covers dead air too');
  const up = store.getEvents().events.find((e) => e.type === 'up' && e.relatedTo === down.id);
  assert.match(up.email.reason, /failing repeatedly/);

  monitor._setEpisodes({});
  monitor._setTransporter(null);
});

test('a dead-air all-clear is still emailed when nothing is suppressing it', async () => {
  reset();
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  const down = store.addEvent({
    timestamp: at(0), streamId: kpftMain.id, streamName: kpftMain.name,
    type: 'dead_air', severity: 'dead_air', confirmed: true, message: 'DEAD AIR',
  });
  monitor._setEpisodes({ [kpftMain.id]: { eventId: down.id, startedAt: at(0), alerted: true, severity: 'dead_air' } });

  await monitor.resolveDeadAir(kpftMain, { responseTime: 190, audioEnergy: 0.4 }, at(6));

  assert.strictEqual(sent.length, 1, 'suppression must not become a permanent mute');
  assert.match(sent[0].subject, /RECOVERED/);

  monitor._setEpisodes({});
  monitor._setTransporter(null);
});

/* ═══════════════════════════════════════════════════════════════════════════
   A storm suppresses REPETITION. It must never suppress DURATION.

   THE MECHANISM, and it is the mirror image of the flood above: the storm's
   only exit is `resolveStorms()`, which begins `if (episodes[streamId]) continue`
   — a stream that is down right now is never declared stable, correctly. But a
   stream that flaps and then STAYS down keeps that episode open for ever. The
   storm therefore never clears, and every outage on it stays suppressed with no
   path back to an alert, however long it lasts.

   That inverts the whole point of the monitor: the worse the fault gets, the
   more certain the silence. Observed on KPFT 2026-09-02 — 52 alerts up to
   13:47, then a permanent outage from 15:44 that nobody was emailed about,
   because the flapping that came first had already declared a storm.

   That is the class: ANY suppressor whose only exit is a state the failure
   itself prevents will go permanently silent on the worst version of the fault
   it was built for. These tests pin the escape hatch, and pin that it fires
   ONCE — an escalation on every cycle would just be the flood again.
   ═══════════════════════════════════════════════════════════════════════════ */

const SUSTAINED = monitor.STORM_SUSTAINED_MS;

const suppressedEpisode = (startedAt) => ({
  eventId: 'e1', startedAt, alerted: false, severity: 'outage', stormSuppressed: true,
});

test('THE CLASS: a suppressed outage that never recovers still has no way to alert', async () => {
  reset();
  // A storm is running and the stream is down right now — the real KPFT state.
  monitor.noteStormEpisode(kpftMain, at(0));
  monitor.noteStormClear(kpftMain, { durationMs: MIN, audience: {}, timestamp: at(1) });
  monitor.noteStormEpisode(kpftMain, at(5));
  monitor._setEpisodes({ 'kpft-main': suppressedEpisode(at(5)) });

  // Hours later, still down. The clear-down path is the ONLY other exit.
  await monitor.resolveStorms(at(600));
  assert.ok(monitor._storms()['kpft-main'], 'storm cannot clear while the stream is down');

  // So without the duration escape hatch there is no alert at all. That is the bug.
  const esc = monitor.sustainedEscalation(suppressedEpisode(at(5)), Date.parse(at(600)));
  assert.ok(esc, 'a permanently down, storm-suppressed stream MUST escalate');
});

test('a suppressed outage escalates once it has been down long enough', () => {
  const ep = suppressedEpisode(at(0));
  const esc = monitor.sustainedEscalation(ep, Date.parse(at(0)) + SUSTAINED);
  assert.ok(esc, 'reaching the threshold escalates');
  assert.equal(esc.downMs, SUSTAINED);
});

test('it escalates EXACTLY once — a per-cycle escalation is the flood again', () => {
  const ep = suppressedEpisode(at(0));
  const first = monitor.sustainedEscalation(ep, Date.parse(at(0)) + SUSTAINED);
  assert.ok(first, 'first crossing escalates');
  ep.sustainedAlerted = true;                       // what the call site sets
  for (const mins of [30, 60, 240, 1440]) {
    assert.equal(
      monitor.sustainedEscalation(ep, Date.parse(at(0)) + mins * MIN), null,
      `still silent ${mins} minutes in — one escalation per episode, not one per cycle`,
    );
  }
});

test('a suppressed outage below the threshold stays silent', () => {
  const ep = suppressedEpisode(at(0));
  assert.equal(
    monitor.sustainedEscalation(ep, Date.parse(at(0)) + SUSTAINED - MIN), null,
    'a flap that is merely ongoing is still a flap',
  );
});

test('an outage that was never suppressed does not take this path', () => {
  const ep = { eventId: 'e', startedAt: at(0), alerted: true, severity: 'outage' };
  assert.equal(
    monitor.sustainedEscalation(ep, Date.parse(at(0)) + SUSTAINED * 4), null,
    'it already sent its own alert; this hatch is only for suppressed episodes',
  );
});

test('a garbled start time cannot manufacture an escalation', () => {
  const ep = suppressedEpisode('not-a-date');
  assert.equal(monitor.sustainedEscalation(ep, Date.now()), null);
});
