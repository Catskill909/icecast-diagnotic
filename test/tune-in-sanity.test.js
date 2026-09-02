/* ═══════════════════════════════════════════════════════════════════════════
   An arrival figure its own hour disproves is never stored

   THE CLASS, not the instance. The listener-minutes fault (repairTuneIns) is one
   way compaction can produce a wrong arrival count; it will not be the last. What
   makes such a fault unrecoverable is not the arithmetic but the ORDER: arrivals
   are computed at the moment the raw samples are destroyed, so a wrong figure
   outlives the only evidence that could contradict it. Twenty days of KPFT
   history were lost that way, and the number went unchallenged for a month.

   So the guard is stated against the OUTPUT, not against any particular bug:
   whatever the cause, an hour claiming more arrivals than its own peak can
   support is refused. A test that reproduced only the 60x listener-minutes shape
   would pass again the next time compaction miscounts differently.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tunein-sanity-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const RETENTION = store.SAMPLE_RETENTION_DAYS * 24 * HOUR;

/** An hour old enough that prune() will compact it. */
function agedHourStart() {
  const t = Date.now() - RETENTION - 2 * HOUR;
  return Math.floor(t / HOUR) * HOUR;
}

/**
 * Writes one aged hour of per-minute samples, then compacts it.
 *
 * `levels` is read cyclically, so a two-element array is a sawtooth and a
 * one-element array is a flat audience.
 */
function compactHour(id, levels) {
  store.ensureStreams([id]);
  const start = agedHourStart();
  for (let m = 0; m < 60; m++) {
    store.addSample(id, {
      timestamp: new Date(start + m * MIN).toISOString(),
      status: 'up',
      responseTime: 10,
      listeners: levels[m % levels.length],
    });
  }
  store.prune();
  const hour = new Date(start).toISOString().slice(0, 13) + ':00:00.000Z';
  return (store.getRollups(id) || []).find((r) => r.hour === hour)
    || (store.getRollups(id) || []).find((r) => Date.parse(r.hour) === start);
}

test('an hour whose arrivals its own peak cannot support is recorded as unmeasured', () => {
  // Total turnover every two minutes: 30 rises of 100 = 3,000 arrivals against a
  // peak of 100. Thirty times the peak. No real audience behaves this way; a
  // miscount does. The exact multiple does not matter — only that it is one no
  // hour could legitimately reach.
  const r = compactHour('sanity-sawtooth', [0, 100]);

  assert.ok(r, 'the hour was compacted');
  assert.equal(r.tuneIns, undefined,
    'an arrival count the hour disproves must not be stored');
  assert.equal(r.listenerPeak, 100,
    'the level record is sound and is kept — only the derived figure is refused');
  assert.ok(r.checks > 0, 'the uptime record is kept too');
});

test('the refused hour reports as uncounted, never as zero arrivals', () => {
  // The distinction the whole repair turned on: "not recorded" and "nobody tuned
  // in" are different facts, and a floor presented as a total is what misled the
  // audience page for a month.
  const start = agedHourStart();
  const got = store.getTuneIns(['sanity-sawtooth'], start, start + HOUR);

  assert.ok(got.hoursMissing >= 1,
    'the refused hour is counted as missing so the UI can say the period is partial');
  assert.equal(got.total, 0, 'and contributes nothing rather than a fabricated figure');
});

test('an ordinary hour of real churn is stored untouched', () => {
  // The guard must not be a silent data shredder. A steady 100 drifting to 130
  // is 30 arrivals against a peak of 130 — nowhere near the ceiling.
  const levels = [];
  for (let m = 0; m < 60; m++) levels.push(100 + Math.floor(m / 2));
  const r = compactHour('sanity-normal', levels);

  assert.ok(r, 'the hour was compacted');
  assert.equal(typeof r.tuneIns, 'number', 'a plausible figure is stored');
  assert.ok(r.tuneIns > 0, 'and it is the real churn, not zero');
  assert.ok(r.tuneIns <= r.listenerPeak * store.TUNE_IN_PEAK_MULTIPLE,
    'a plausible figure sits under the ceiling by definition');
});

test('a tiny flapping mount is not punished by a ratio it cannot pass', () => {
  // Peak 1, toggling every minute: 30 arrivals, which is 30x the peak and would
  // fail a pure ratio test. The absolute floor exists for exactly this — a relay
  // holding one listener is not evidence of a counting fault.
  const r = compactHour('sanity-tiny', [0, 1]);

  assert.ok(r, 'the hour was compacted');
  assert.equal(typeof r.tuneIns, 'number',
    'a small mount keeps its figure — the floor absorbs the ratio');
  assert.ok(r.tuneIns <= store.TUNE_IN_SANITY_FLOOR);
});

test('the ceiling is the documented one, so the guard cannot be loosened silently', () => {
  assert.equal(store.TUNE_IN_PEAK_MULTIPLE, 12);
  assert.equal(store.TUNE_IN_SANITY_FLOOR, 50);
});

/* ── Under-counting ─────────────────────────────────────────────────────────
   The other half, and the harder one to catch. A figure that is too LOW is
   plausible against its own hour — it looks like a quiet stretch — so nothing
   about its size gives it away. Only the readings can, and only while they still
   exist.

   Driven through arrivalFault() rather than through prune(), because the live
   counter is correct and will not produce an under-count on demand. Proving the
   arm fires means handing it a figure the real code cannot generate.
   ─────────────────────────────────────────────────────────────────────────── */

test('arrivals below the rise the readings observed are refused', () => {
  // The hour climbed from 40 to 300, so at least 260 people arrived. A counter
  // reporting 12 has missed them, and 12 is a number nobody would question.
  const fault = store.arrivalFault(12, 260, 300, 60);

  assert.ok(fault, 'an impossible figure is rejected however modest it looks');
  assert.match(fault, /under-counting/);
  assert.match(fault, /at least 260/);
});

test('a figure exactly at the floor is allowed', () => {
  // A monotonic climb from 40 to 300 with no dips: the rise IS the arrivals, and
  // the bound is inclusive. An off-by-one here would reject sound data every time
  // an audience only ever grew.
  assert.equal(store.arrivalFault(260, 260, 300, 60), null);
});

test('the two arms cannot both be satisfied away — a real figure passes both', () => {
  // Floor 260, ceiling max(50, 300 * 12) = 3,600. A true count sits between.
  assert.equal(store.arrivalFault(410, 260, 300, 60), null);
  assert.ok(store.arrivalFault(259, 260, 300, 60), 'one below the floor still fails');
  assert.ok(store.arrivalFault(3601, 260, 300, 60), 'one above the ceiling still fails');
});

test('a rise across a monitoring gap does not become a floor the counter must meet', () => {
  // THE FALSE-POSITIVE THIS GUARD COULD CAUSE. A stream off the air for ten
  // minutes returns with its audience intact; compaction deliberately does not
  // count that step as arrivals. If the floor measured the whole hour instead of
  // each contiguous run, it would demand arrivals the counter is right to omit
  // and would erase sound hours — the guard becoming the bug.
  store.ensureStreams(['sanity-gap']);
  const start = agedHourStart();
  const push = (m, listeners) => store.addSample('sanity-gap', {
    timestamp: new Date(start + m * MIN).toISOString(),
    status: 'up',
    responseTime: 10,
    listeners,
  });

  for (let m = 0; m < 10; m++) push(m, 30);   // steady, then off the air
  for (let m = 40; m < 60; m++) push(m, 300); // back with the audience intact

  store.prune();
  const r = (store.getRollups('sanity-gap') || []).find((x) => Date.parse(x.hour) === start);

  assert.ok(r, 'the hour was compacted');
  assert.equal(typeof r.tuneIns, 'number',
    'the hour survives: the 30 -> 300 step is across a gap and is not arrivals');
  assert.ok(r.tuneIns < 270,
    'and the step was genuinely not counted, so the floor never demanded it');
});
