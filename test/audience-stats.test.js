/* ═══════════════════════════════════════════════════════════════════════════
   Audience statistics

   These ran inline in the audience page, where nothing could test them, and the
   page shipped reporting a station-wide peak of 212 when the true simultaneous
   peak was 179 — because it added together peaks that happened at different
   moments. Nobody spotted it by looking, because 212 is a perfectly plausible
   number.

   The fixture below reproduces that arithmetic exactly, so the mistake cannot
   come back by any route.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const A = require('../public/audience-stats');

const T1 = '2026-08-27T19:00:00.000Z';
const T2 = '2026-08-27T20:00:00.000Z';
const HOUR = 60 * 60 * 1000;

// Two channels whose busiest moments are an hour apart — the shape that broke
// it. Peaks: 130 and 82, summing to the 212 the page used to report. The real
// simultaneous maximum is 179, at T1.
const SERIES = {
  main: [
    { t: T1, avg: 130, peak: 130 },
    { t: T2, avg: 40, peak: 40 },
  ],
  hd2: [
    { t: T1, avg: 49, peak: 49 },
    { t: T2, avg: 82, peak: 82 },
  ],
};
const IDS = ['main', 'hd2'];

// ── The regression ──────────────────────────────────────────────────────────

test('the station peak is a real moment, not the sum of separate peaks', () => {
  const st = A.stationStats(A.stationSeries(SERIES, IDS));
  assert.equal(st.peak, 179, 'T1: 130 + 49, the largest the station was ever at once');

  const sumOfPeaks = IDS.reduce((a, id) => a + Math.max(...SERIES[id].map((p) => p.peak)), 0);
  assert.equal(sumOfPeaks, 212, 'the figure the page used to print');
  assert.notEqual(st.peak, sumOfPeaks, 'two channels peaking an hour apart is not one moment');
});

test('the peak carries the moment it happened', () => {
  // A peak with no "when" is trivia; with one it is something to schedule
  // against.
  const st = A.stationStats(A.stationSeries(SERIES, IDS));
  assert.equal(st.peakAt, T1);
});

test('the floor is the quietest simultaneous moment', () => {
  const st = A.stationStats(A.stationSeries(SERIES, IDS));
  assert.equal(st.low, 122, 'T2: 40 + 82');
});

test('buckets are summed by timestamp, so channels align', () => {
  const ser = A.stationSeries(SERIES, IDS);
  assert.deepEqual(ser, [{ t: T1, v: 179 }, { t: T2, v: 122 }]);
});

test('a channel with no series contributes nothing rather than breaking', () => {
  const ser = A.stationSeries(SERIES, ['main', 'missing']);
  assert.deepEqual(ser.map((p) => p.v), [130, 40]);
  assert.deepEqual(A.stationStats([]), { peak: null, peakAt: null, low: null, avg: null });
});

// ── Per channel ─────────────────────────────────────────────────────────────

test('a channel reports its own peak, when it happened, and its floor', () => {
  const s = A.channelStats(SERIES.main);
  assert.equal(s.peak, 130);
  assert.equal(s.peakAt, T1);
  assert.equal(s.low, 40, 'the baseline it holds, read from the averages');
  assert.equal(s.avg, 85);
});

test('buckets with no reading do not count as zero listeners', () => {
  // A gap in monitoring is not an audience of nobody. Averaging nulls in as
  // zeros would understate every channel in proportion to its downtime.
  const s = A.channelStats([{ t: T1, avg: 100, peak: 100 }, { t: T2, avg: null, peak: null }]);
  assert.equal(s.avg, 100);
  assert.equal(s.low, 100);
  assert.equal(s.buckets, 1);
});

test('an empty series reports nothing rather than zero', () => {
  const s = A.channelStats([]);
  assert.equal(s.avg, null);
  assert.equal(s.peak, null);
  assert.equal(s.low, null);
});

// ── Now vs typical ──────────────────────────────────────────────────────────

test('the current audience is compared against this hour\'s norm', () => {
  const streams = [
    { current: 60, hourProfile: Array(24).fill(50) },
    { current: 40, hourProfile: Array(24).fill(50) },
  ];
  const v = A.vsTypical(streams, 19);
  assert.equal(v.now, 100);
  assert.equal(v.typical, 100);
  assert.equal(v.changePct, 0);

  const up = A.vsTypical([{ current: 150, hourProfile: Array(24).fill(100) }], 19);
  assert.equal(up.changePct, 50);
});

test('no profile means no comparison, not a comparison against zero', () => {
  // "0% vs typical" reads as normal. It would mean unknown.
  assert.equal(A.vsTypical([{ current: 60 }], 19), null);
  assert.equal(A.vsTypical([{ current: 60, hourProfile: Array(24).fill(0) }], 19), null);
});

// ── Per mount ───────────────────────────────────────────────────────────────

test('mount averages ignore buckets recorded before the breakdown existed', () => {
  // Counting them as zeros would drag every mount average down in proportion to
  // how long ago per-mount recording began — a declining audience that never
  // happened.
  const series = [
    { t: T1, avg: 100 },                                        // no byMount
    { t: T2, avg: 100, byMount: { '/live_128': 60, '/live_64': 40 } },
  ];
  const m = A.mountStats(series);
  assert.equal(m.covered, 1);
  assert.equal(m.total, 2);
  assert.deepEqual(m.mounts, [
    { path: '/live_128', avg: 60 },
    { path: '/live_64', avg: 40 },
  ], 'averaged over the buckets that carry data, not all of them');
});

test('mounts come back busiest first', () => {
  const m = A.mountStats([{ t: T1, avg: 100, byMount: { '/a': 10, '/b': 90 } }]);
  assert.deepEqual(m.mounts.map((x) => x.path), ['/b', '/a']);
});

// ── Day by day ──────────────────────────────────────────────────────────────

test('daily hours scale with the bucket width, not the bucket count', () => {
  // A bucket holding 40 listeners for fifteen minutes is ten listening hours,
  // not forty. Getting this wrong would inflate ATH by the bucket count — the
  // figure carrying a royalty threshold.
  const ser = [
    { t: '2026-08-27T00:00:00.000Z', v: 40 },
    { t: '2026-08-27T00:15:00.000Z', v: 40 },
    { t: '2026-08-27T00:30:00.000Z', v: 40 },
    { t: '2026-08-27T00:45:00.000Z', v: 40 },
  ];
  const quarterHour = A.dailyBreakdown(ser, 15 * 60 * 1000);
  assert.equal(quarterHour[0].hours, 40, 'four quarter-hours of 40 listeners is 40 listener-hours');

  const hourly = A.dailyBreakdown(ser, HOUR);
  assert.equal(hourly[0].hours, 160, 'the same buckets an hour wide are four times the listening');
});

test('days come back newest first, with average, peak and floor', () => {
  const ser = [
    { t: '2026-08-26T12:00:00.000Z', v: 10 },
    { t: '2026-08-26T13:00:00.000Z', v: 30 },
    { t: '2026-08-27T12:00:00.000Z', v: 50 },
  ];
  const days = A.dailyBreakdown(ser, HOUR);
  assert.equal(days.length, 2);
  assert.ok(days[0].key > days[1].key, 'newest first');
  const older = days[1];
  assert.equal(older.avg, 20);
  assert.equal(older.peak, 30);
  assert.equal(older.low, 10);
});
