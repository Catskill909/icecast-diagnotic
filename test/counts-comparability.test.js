/* ═══════════════════════════════════════════════════════════════════════════
   Period comparisons must compare like with like

   A percentage on the audience page is a claim about the station, and the two
   windows behind it are NOT automatically the same kind of measurement.

   Raw samples are kept for SAMPLE_RETENTION_DAYS and then compact into hourly
   rollups. So any window longer than that compares a per-minute present against
   an hourly past — and hourly averaging flattens every spike. This week's "peak"
   is the busiest MINUTE; last week's is the busiest HOUR's AVERAGE. Put them in
   a ratio and the station is told it grew, when nothing happened at all.

   Measured on production on 1 Sep 2026: the week card read +887% on peak and
   +989% on average, drawn from a previous window holding 33 readings against the
   current window's 1,969.

   Withholding the figure would hide it FOR EVER, because the 7-day window will
   always outlive the raw retention window. So the fix levels the comparison
   instead: coarsen the finer side and measure both hourly.

   The guard has to hold for EVERY figure computed from those two windows, not
   just the one that was noticed first — that is the class, and the reason the
   last test here loops over all of them instead of naming one.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'comparability-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SEED_FILE = '/nonexistent';

const TZ = 'America/Chicago';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Hour-aligned, so the windows below start and end on exact hour boundaries and
// "hours covered" can be compared against "hours in the window" without slack.
const NOW = Date.parse('2026-09-01T13:00:00.000Z');
const WEEK_START = NOW - 7 * DAY;
const PREV_WEEK_START = NOW - 14 * DAY;
const PREV_WEEK_HOURS = 7 * 24;

/**
 * One hour of raw samples averaging EXACTLY 100, spiking to 180 for a minute.
 *
 * The pairing is deliberate: 180 and 20 either side of 58 minutes at 100 leaves
 * the hourly mean at 100 exactly. So the two weeks below hold an identical
 * audience, and any percentage between them other than zero is an artefact of
 * how the data was stored rather than anything a listener did.
 */
function rawHour(startMs) {
  const out = [];
  for (let m = 0; m < 60; m++) {
    const listeners = m === 0 ? 180 : m === 1 ? 20 : 100;
    out.push({
      timestamp: new Date(startMs + m * MINUTE).toISOString(),
      status: 'up',
      responseTime: 10,
      listeners,
    });
  }
  return out;
}

/** The same hour after compaction: the spike is gone, as it is in production. */
function rollupHour(startMs) {
  return {
    hour: new Date(startMs).toISOString(),
    checks: 60,
    up: 60,
    down: 0,
    silent: 0,
    listenerCount: 60,
    avgListeners: 100,
    listenerPeak: 180,
  };
}

function seed({ prevHoursCovered = PREV_WEEK_HOURS } = {}) {
  // The last 7 days at full resolution — what retention still holds.
  const samples = [];
  for (let t = WEEK_START; t < NOW; t += HOUR) samples.push(...rawHour(t));

  // The 7 days before that exist ONLY as rollups — what retention leaves behind.
  // Coverage is filled from the END of the window backwards, because a monitor
  // that started mid-window is the case that produced "+376%".
  const rollups = [];
  for (let i = PREV_WEEK_HOURS - prevHoursCovered; i < PREV_WEEK_HOURS; i++) {
    rollups.push(rollupHour(PREV_WEEK_START + i * HOUR));
  }

  fs.writeFileSync(
    path.join(DATA_DIR, 'samples.json'),
    JSON.stringify({ samples: { a: samples }, rollups: { a: rollups } }),
  );
}

/** Re-reads the store from disk, so a reseed is actually observed. */
function freshStore() {
  delete require.cache[require.resolve('../store')];
  const s = require('../store');
  s.load();
  return s;
}

seed();
const store = freshStore();

test('an identical audience is not reported as growth just because the older week compacted', () => {
  const c = store.getListenerCounts(['a'], TZ, NOW);

  // The headline keeps full resolution: the busiest minute really was 180.
  assert.equal(c.week.peak, 180, 'the headline peak stays a peak MINUTE');
  assert.equal(c.week.previous.peak, 100, 'the compacted week can only offer a peak HOUR');

  // Before the fix this divided 180 by 100 and announced +80% growth from two
  // identical weeks. The comparison is now levelled to the coarser side.
  assert.equal(c.week.comparisonResolution, 'hour', 'compared hour-to-hour');
  assert.equal(c.week.changePct.peak, 0, 'identical audiences compare as flat');
  assert.equal(c.week.changePct.avg, 0, 'identical audiences compare as flat');
  assert.equal(c.week.concurrencyComparable, true);
});

test('a window still inside raw retention is compared at full resolution', () => {
  // The guard must not coarsen what does not need coarsening: the last 24 hours
  // and the 24 before it are both raw, so the minute-level comparison survives.
  const c = store.getListenerCounts(['a'], TZ, NOW);

  assert.equal(c.day.comparisonResolution, 'minute', 'no needless downgrade');
  assert.equal(c.day.concurrencyComparable, true);
  assert.equal(c.day.peak, 180, 'and the peak is still the peak MINUTE');
  assert.equal(c.day.changePct.peak, 0, 'same audience, same resolution, flat');
});

test('a previous window the monitor only saw the end of is not compared at all', () => {
  // Six hours of a 168-hour window. Dividing by it is how "+376%" was invented.
  seed({ prevHoursCovered: 6 });
  const c = freshStore().getListenerCounts(['a'], TZ, NOW);

  assert.equal(c.week.concurrencyComparable, false, 'a tail is not a measurement');
  assert.equal(c.week.changePct.peak, null, 'withheld, not invented');
  assert.equal(c.week.changePct.avg, null, 'withheld, not invented');
  assert.equal(c.week.comparisonResolution, null);

  // Withheld is not the same as absent: the figures themselves still show.
  assert.equal(c.week.peak, 180, 'the window still reports its own peak');
});

test('a window with partial edge hours is still counted as fully measured', () => {
  // `now` almost never lands on an hour boundary, so a window's first and last
  // hours are fractions — and an hourly rollup sits on an exact boundary and can
  // never fill a fraction. Counting the edges left every rollup-backed window one
  // or two hours short of its own span for ever, which withheld the 7-day and
  // 30-day comparisons permanently. Caught on live data: 167 hours needed, 167
  // available, and the comparison refused because the span was measured as 169.
  seed();
  const offset = NOW + 37 * MINUTE;   // deliberately not on the hour
  const c = freshStore().getListenerCounts(['a'], TZ, offset);

  assert.equal(c.week.concurrencyComparable, true,
    'partial edges are not missing data — they are outside the whole hours');
  assert.equal(c.week.comparisonResolution, 'hour');
});

test('a single missed hour does not void a whole week of comparison', () => {
  // A monitor restart costs an hour. Demanding all 168 meant one gap silently
  // withheld the week-over-week figure — the guard doing more damage than the
  // artefact it exists to prevent. 167 of 168 is a measurement of that window.
  seed({ prevHoursCovered: PREV_WEEK_HOURS - 1 });
  const c = freshStore().getListenerCounts(['a'], TZ, NOW);

  assert.equal(c.week.concurrencyComparable, true, 'one hour short is still measured');
  assert.equal(c.week.changePct.peak, 0, 'and the levelled comparison still reads flat');
});

test('NO figure is ever compared against a window the gate rejected', () => {
  // The class, not the instance. The original bug was that one metric was gated
  // and its two neighbours, built from the very same pair of windows, were not.
  // Any percentage added here in future is covered by this without being named.
  seed({ prevHoursCovered: 6 });
  const c = freshStore().getListenerCounts(['a'], TZ, NOW);

  for (const window of ['day', 'week', 'month']) {
    const w = c[window];
    if (w.concurrencyComparable) continue;
    for (const [metric, value] of Object.entries(w.changePct)) {
      if (metric === 'totalListeners') continue; // gated separately, on reach coverage
      assert.equal(
        value,
        null,
        `${window}.changePct.${metric} was computed from a window the gate rejected`,
      );
    }
  }
});
