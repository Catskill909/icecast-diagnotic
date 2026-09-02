/* ═══════════════════════════════════════════════════════════════════════════
   Listener counts

   HEADCOUNTS, not listening hours. "How many people are listening" is the
   question a station actually asks first, and it is a different question from
   "how much listening was delivered".

   ROLLING WINDOWS, NOT CALENDAR PERIODS. The cards cover the last 24 hours, the
   last 7 days and the last 30 days, each compared against the window of equal
   length immediately before it.

   This replaced month-to-date / week-to-date / day-to-date, which spent most of
   their lives partly elapsed. On 1 Sep 2026 the dashboard read 415 for "This
   month" beside 1,809 for "This week" — the month card was nine hours old and
   the week card was thirty-three. Correct to the hour, and read by everyone who
   saw it as data loss.

   Three things here are easy to get wrong and impossible to spot by looking:

     · A station-wide peak must be the channels summed at each MOMENT. Adding
       each channel's own maximum reports a total that never happened.

     · The windows must NEST. 30 days ⊇ 7 days ⊇ 24 hours, so no card may ever
       report less than the card inside it — that is the whole reason the
       calendar version was replaced.

     · A window can reach back further than the recording behind it, and the two
       figures on a card began on DIFFERENT days. Each must be dated from when
       it started being true.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'counts-test-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Samples every 5 minutes across a span, at a fixed listener count. */
function fill(id, fromIso, toIso, listeners, status = 'up') {
  store.ensureStreams([id]);
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  for (let t = from; t < to; t += 5 * MIN) {
    store.addSample(id, {
      timestamp: new Date(t).toISOString(),
      status,
      responseTime: 10,
      listeners,
    });
  }
}

/**
 * A channel whose audience TURNS OVER for `minutes` before `endMs`.
 *
 * The churn is the point wherever nesting is under test. A steady audience
 * yields the same reach over a day as over a month — everyone connected when the
 * window opened counts once and nobody else arrives — so a flat fixture would
 * hide exactly the property being asserted. Sampled every four minutes because
 * getTuneIns() discards a rise across a gap wider than five and would read
 * anything sparser as monitoring downtime rather than as arrivals.
 */
function churn(id, minutes, endMs = NOW, low = 20, peak = 60) {
  store.ensureStreams([id]);
  for (let i = Math.floor(minutes / 4); i >= 1; i--) {
    store.addSample(id, {
      timestamp: new Date(endMs - i * 4 * MIN).toISOString(),
      status: 'up',
      responseTime: 10,
      listeners: i % 2 === 0 ? low : peak,
    });
  }
}

// The 24 hours before last: 100 listeners throughout. The last 24 hours: 80.
fill('a', '2026-08-26T12:00:00.000Z', '2026-08-27T12:00:00.000Z', 100);
fill('a', '2026-08-27T12:00:00.000Z', '2026-08-28T12:00:00.000Z', 80);

test('the last 24 hours is compared against the 24 hours before it', () => {
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.equal(c.day.avg, 80);
  assert.equal(c.day.previous.avg, 100, 'the equal window immediately before');
  assert.equal(c.day.changePct.avg, -20);
});

test('a window is always its full length, whatever the hour or the date', () => {
  // The calendar version could not say this: month-to-date on the 1st was hours
  // old, and week-to-date on a Tuesday was shorter than the day card would be by
  // Friday. A rolling window has one length, always.
  for (const when of [
    Date.parse('2026-09-01T00:05:00.000Z'),  // five minutes into a new month
    Date.parse('2026-08-31T05:00:00.000Z'),  // a Monday, five minutes into a week
    Date.parse('2026-09-15T23:59:00.000Z'),  // mid-month, end of a day
  ]) {
    const c = store.getListenerCounts(['a'], TZ, when);
    assert.equal(c.day.windowMs, DAY, 'the day window is 24 hours');
    assert.equal(c.week.windowMs, 7 * DAY, 'the week window is 7 days');
    assert.equal(c.month.windowMs, 30 * DAY, 'the month window is 30 days');
    assert.equal(c.day.elapsedMs, DAY, 'and it is never partly elapsed');
  }
});

test('the windows nest, so a longer one can never report less than a shorter', () => {
  // THE regression. "This month 415" sat beside "This week 1,809" — a month
  // smaller than the week inside it. Under rolling windows that is arithmetically
  // impossible, and this is the assertion that keeps it so.
  churn('nest', 30 * 24 * 60);
  const c = store.getListenerCounts(['nest'], TZ, NOW);

  assert.ok(c.week.totalListeners > c.day.totalListeners,
    `7 days (${c.week.totalListeners}) must exceed 24 hours (${c.day.totalListeners})`);
  assert.ok(c.month.totalListeners > c.week.totalListeners,
    `30 days (${c.month.totalListeners}) must exceed 7 days (${c.week.totalListeners})`);
  assert.ok(c.week.peak >= c.day.peak, 'a longer window contains the shorter one\'s peak');
  assert.ok(c.month.peak >= c.week.peak);
});

test('on the first of the month the month card still covers thirty days', () => {
  // The exact moment the bug was reported: 1 Sep 2026, nine hours into September.
  const firstOfMonth = Date.parse('2026-09-01T13:00:00.000Z');
  churn('sep', 40 * 24 * 60, firstOfMonth);
  const c = store.getListenerCounts(['sep'], TZ, firstOfMonth);

  assert.equal(c.month.windowMs, 30 * DAY, 'not "September so far"');
  assert.ok(c.month.totalListeners > c.week.totalListeners,
    'the month is not a few hours old on the 1st');
  assert.ok(c.week.totalListeners > c.day.totalListeners);
});

test('a station-wide peak is the channels summed at one moment', () => {
  // Two channels, each peaking at a different time. Summing their separate
  // maxima gives 150; the most people ever connected at once is 110.
  fill('p1', '2026-08-28T06:00:00.000Z', '2026-08-28T07:00:00.000Z', 90);
  fill('p1', '2026-08-28T07:00:00.000Z', '2026-08-28T08:00:00.000Z', 50);
  fill('p2', '2026-08-28T06:00:00.000Z', '2026-08-28T07:00:00.000Z', 20);
  fill('p2', '2026-08-28T07:00:00.000Z', '2026-08-28T08:00:00.000Z', 60);

  const c = store.getListenerCounts(['p1', 'p2'], TZ, NOW);
  assert.equal(c.day.peak, 110, '90 + 20 in the first hour');
  assert.notEqual(c.day.peak, 150, 'peaks an hour apart are not one moment');
});

test('an off-air channel reports no listeners, not zero listeners', () => {
  // Icecast returns zero for a mount that no longer exists — because nobody can
  // reach it, not because nobody wanted to. Averaging those zeros in would push
  // the headcount down hardest in exactly the periods a station is already
  // unhappy about.
  fill('d', '2026-08-28T06:00:00.000Z', '2026-08-28T08:00:00.000Z', 100);
  fill('d', '2026-08-28T08:00:00.000Z', '2026-08-28T10:00:00.000Z', 0, 'down');
  const c = store.getListenerCounts(['d'], TZ, NOW);
  assert.equal(c.day.avg, 100, 'the down stretch is absent, not counted as an audience of nobody');
});

test('a missing comparison is withheld, never reported as no change', () => {
  // "0%" reads as "steady". It would mean "we have nothing to compare with",
  // which is a different thing to tell a station.
  const c = store.getListenerCounts(['nothing-here'], TZ, NOW);
  assert.equal(c.day.peak, null);
  assert.equal(c.day.changePct.avg, null);
  assert.notEqual(c.day.changePct.avg, 0);
});

test('each figure is dated from when IT began being recorded', () => {
  // Arrivals and audience levels do not share a start date: the early tune-in
  // figures were listener-minutes rather than arrivals and were cleared, so
  // reach begins later than levels do. Unexplained, that is why one row on a
  // card carries a comparison while the row beneath it says there is not enough
  // history — which reads as a fault instead of as a start date.
  const id = 'ages';
  store.ensureStreams([id]);
  // Levels from ten days back, as rollups carrying no tune-in figure.
  for (let h = 10 * 24; h > 2 * 24; h--) {
    store.getRollups(id).push({
      hour: new Date(NOW - h * HOUR).toISOString(),
      checks: 60, up: 60, down: 0, silent: 0,
      listenerCount: 60, avgListeners: 40, listenerPeak: 55,
    });
  }
  // Arrivals only from the raw samples of the last two days.
  churn(id, 2 * 24 * 60);

  const c = store.getListenerCounts([id], TZ, NOW);

  // A 30-day window reaches past both start dates, so both are declared.
  assert.ok(c.month.recordedFrom.levels, 'the levels start date is carried');
  assert.ok(c.month.recordedFrom.arrivals, 'the arrivals start date is carried');
  assert.ok(
    Date.parse(c.month.recordedFrom.arrivals) > Date.parse(c.month.recordedFrom.levels),
    'arrivals began later than levels, and the card must be able to say so',
  );

  // A 24-hour window sits inside both recordings, so there is nothing to declare.
  assert.equal(c.day.recordedFrom.levels, null, 'no caveat when the window is fully covered');
  assert.equal(c.day.recordedFrom.arrivals, null);
});

test('total listeners counts tune-ins, not the concurrent figure', () => {
  // THE headline. Every rise in the listener count is somebody starting to
  // listen. On the production record this runs six to nine times the concurrent
  // peak — quoting the concurrent number instead understates a station by an
  // order of magnitude to the funders who ask.
  const id = 'tune';
  store.ensureStreams([id]);
  // 10 already listening, then +5, then -3, then +4. Peak is 16; the number of
  // people who tuned in is 10 + 5 + 4 = 19.
  const base = Date.parse('2026-08-28T06:00:00.000Z');
  [10, 15, 12, 16].forEach((n, i) => {
    store.addSample(id, {
      timestamp: new Date(base + i * MIN).toISOString(),
      status: 'up', responseTime: 10, listeners: n,
    });
  });

  const t = store.getTuneIns([id], base - 1000, NOW);
  assert.equal(t.total, 19, '10 present + 5 joining + 4 joining');
  assert.notEqual(t.total, 16, 'the concurrent peak is a different question');
  assert.equal(t.floor, true, 'and it is a floor, never an exact count');
});

test('a monitoring gap is not a surge of listeners', () => {
  // The failure this prevents: after an outage or a restart, the audience
  // becoming visible again looks like everyone arriving at once. Counting it
  // would invent a spike of listeners precisely on the days a station already
  // had a bad time.
  const id = 'gap';
  store.ensureStreams([id]);
  const base = Date.parse('2026-08-28T06:00:00.000Z');
  store.addSample(id, { timestamp: new Date(base).toISOString(), status: 'up', responseTime: 10, listeners: 50 });
  // An hour of silence, then the audience reappears at 90.
  store.addSample(id, { timestamp: new Date(base + HOUR).toISOString(), status: 'up', responseTime: 10, listeners: 90 });

  const t = store.getTuneIns([id], base - 1000, NOW);
  assert.equal(t.total, 50, 'the 40 that appeared across the gap are not counted as arrivals');
  assert.equal(t.gaps, 1, 'and the skip is reported rather than silent');
});

test('someone leaving does not subtract from total listeners', () => {
  // Reach only ever accumulates. A listener who leaves still listened.
  const id = 'leave';
  store.ensureStreams([id]);
  const base = Date.parse('2026-08-28T06:00:00.000Z');
  [100, 40, 10].forEach((n, i) => {
    store.addSample(id, {
      timestamp: new Date(base + i * MIN).toISOString(),
      status: 'up', responseTime: 10, listeners: n,
    });
  });
  assert.equal(store.getTuneIns([id], base - 1000, NOW).total, 100);
});

test('total listeners is carried per window with its own comparison', () => {
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.ok(c.day.totalListeners > 0, 'the last 24 hours has a reach figure');
  assert.ok('totalListeners' in c.day.changePct, 'compared like the others');
  assert.equal(c.day.totalListenersMeta.floor, true);
});

test('individual listeners stay a declared headline, not a fabricated one', () => {
  // One person who tunes in ten times is TEN total listeners and ONE individual
  // listener. Both are headline figures for a station; only the first is
  // derivable from a connection count, so the second says why it is empty rather
  // than being quietly filled with the other.
  const c = store.getListenerCounts(['a'], TZ, NOW);
  const u = c.unavailable.individualListeners;
  assert.equal(u.value, null);
  assert.notEqual(u.label, undefined);
  // It must never be conflated with the tune-in count sitting beside it.
  assert.notEqual(u.value, c.day.totalListeners);

  // The REASON has to name the current blocker, and the blocker moved on
  // 2026-09-02: an Icecast admin credential now exists, so "needs admin access"
  // would send a reader hunting for something they already have. What is still
  // missing is collection ACROSS the period — Icecast reports who is connected
  // now, and distinct people over a day is the union of every poll.
  assert.ok(u.reason && u.reason.length > 20, 'an empty slot must explain itself');
  assert.match(u.reason, /collect|stored|period|poll/i, 'the reason must name the real blocker');
  assert.doesNotMatch(
    u.reason, /needs Icecast admin access/i,
    'the credential exists now — this reason is stale and misdirects',
  );
});

test('a live distinct-address count is never presented as a distinct-people count', () => {
  // THE TRAP THIS PINS: a snapshot of who is connected right now is easy to
  // reach for and answers a DIFFERENT question than the card asks. Filling the
  // period card with a concurrent figure is precisely what store.js warns
  // against, and it would misdescribe the number under a headline label.
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.equal(
    c.unavailable.individualListeners.value, null,
    'a now-figure must not be promoted into the over-the-period slot',
  );
});

test('a reach comparison is withheld when the earlier window is under-recorded', () => {
  // Caught in the live audit on the day this shipped: the comparison window fell
  // outside raw retention and its rollups predated tune-in recording, so it came
  // back 1,339 against 5,813 and the page announced "+376%". Entirely an artefact
  // of the older window being half-recorded — the kind of number a station would
  // repeat in a board meeting.
  const id = 'partial';
  store.ensureStreams([id]);
  const base = Date.parse('2026-08-28T06:00:00.000Z');
  [10, 20].forEach((n, i) => {
    store.addSample(id, {
      timestamp: new Date(base + i * MIN).toISOString(),
      status: 'up', responseTime: 10, listeners: n,
    });
  });
  // An hour inside the comparison window that was rolled up before tune-ins
  // existed: present, but carrying no tuneIns figure.
  store.getRollups(id).push({
    hour: '2026-08-27T06:00:00.000Z',
    checks: 60, up: 60, down: 0, silent: 0,
    listenerCount: 60, avgListeners: 40, listenerPeak: 55,
  });

  const t = store.getTuneIns([id], Date.parse('2026-08-27T00:00:00.000Z'), Date.parse('2026-08-28T00:00:00.000Z'));
  assert.ok(t.hoursMissing > 0, 'the gap in recording is detected');

  const c = store.getListenerCounts([id], TZ, NOW);
  assert.equal(c.day.totalListenersComparable, false, 'so the comparison is refused');
  assert.equal(c.day.changePct.totalListeners, null, 'rather than dividing by a partial total');
});
