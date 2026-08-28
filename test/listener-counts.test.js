/* ═══════════════════════════════════════════════════════════════════════════
   Listener counts

   HEADCOUNTS, not listening hours. "How many people are listening" is the
   question a station actually asks first, and it is a different question from
   "how much listening was delivered".

   Two things here are easy to get wrong and impossible to spot by looking:

     · A station-wide peak must be the channels summed at each MOMENT. Adding
       each channel's own maximum reports a total that never happened.

     · A period must be compared against the SAME ELAPSED SPAN of the period
       before. Nine days of this month against all thirty-one of last month
       reports a collapse every single month, for ever.
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
// 07:00 in Chicago on 28 Aug — seven hours into the local day.
const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** Samples every 5 minutes across a span, at a fixed listener count. */
function fill(id, fromIso, toIso, listeners, status = 'up') {
  store.ensureStreams([id]);
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  for (let t = from; t < to; t += 5 * 60 * 1000) {
    store.addSample(id, {
      timestamp: new Date(t).toISOString(),
      status,
      responseTime: 10,
      listeners,
    });
  }
}

// Yesterday: 100 listeners through the morning, then only 20 for the rest of
// the day. Today: 80 through the same morning hours.
fill('a', '2026-08-27T05:00:00.000Z', '2026-08-27T12:00:00.000Z', 100);
fill('a', '2026-08-27T12:00:00.000Z', '2026-08-28T05:00:00.000Z', 20);
fill('a', '2026-08-28T05:00:00.000Z', '2026-08-28T12:00:00.000Z', 80);

test('today is compared against the same hours of yesterday, not all of it', () => {
  // The whole point. Against the same seven morning hours, today is down 20%.
  // Against the WHOLE of yesterday — whose quiet evening drags the average to
  // about 43 — today would look like a 86% improvement. Same data, opposite
  // story, and only one of them is true.
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.equal(c.today.avg, 80);
  assert.equal(c.today.previous.avg, 100, 'the matching span of yesterday only');
  assert.equal(c.today.changePct.avg, -20);
});

test('the elapsed span drives the comparison window', () => {
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.equal(c.today.elapsedMs, 7 * HOUR, 'seven hours into the station\'s day');
  assert.equal(c.today.start, '2026-08-28T05:00:00.000Z', 'Chicago midnight');
});

test('a station-wide peak is the channels summed at one moment', () => {
  // Two channels, each peaking at a different time. Summing their separate
  // maxima gives 150; the most people ever connected at once is 110.
  fill('p1', '2026-08-28T06:00:00.000Z', '2026-08-28T07:00:00.000Z', 90);
  fill('p1', '2026-08-28T07:00:00.000Z', '2026-08-28T08:00:00.000Z', 50);
  fill('p2', '2026-08-28T06:00:00.000Z', '2026-08-28T07:00:00.000Z', 20);
  fill('p2', '2026-08-28T07:00:00.000Z', '2026-08-28T08:00:00.000Z', 60);

  const c = store.getListenerCounts(['p1', 'p2'], TZ, NOW);
  assert.equal(c.today.peak, 110, '90 + 20 in the first hour');
  assert.notEqual(c.today.peak, 150, 'peaks an hour apart are not one moment');
});

test('an off-air channel reports no listeners, not zero listeners', () => {
  // Icecast returns zero for a mount that no longer exists — because nobody can
  // reach it, not because nobody wanted to. Averaging those zeros in would push
  // the headcount down hardest in exactly the periods a station is already
  // unhappy about.
  fill('d', '2026-08-28T06:00:00.000Z', '2026-08-28T08:00:00.000Z', 100);
  fill('d', '2026-08-28T08:00:00.000Z', '2026-08-28T10:00:00.000Z', 0, 'down');
  const c = store.getListenerCounts(['d'], TZ, NOW);
  assert.equal(c.today.avg, 100, 'the down stretch is absent, not counted as an audience of nobody');
});

test('the week runs Monday to Sunday', () => {
  // A week that splits the weekend compares two halves of different things —
  // and a community station's weekend is its own schedule.
  const b = store.periodBounds(TZ, NOW);   // 28 Aug 2026 is a Friday
  assert.equal(new Date(b.week).toISOString(), '2026-08-24T05:00:00.000Z', 'the Monday');
});

test('the month starts on the station clock', () => {
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.equal(c.month.start, '2026-08-01T05:00:00.000Z');
  assert.equal(c.timeZone, TZ);
});

test('a missing comparison is withheld, never reported as no change', () => {
  // "0%" reads as "steady". It would mean "we have nothing to compare with",
  // which is a different thing to tell a station.
  const c = store.getListenerCounts(['nothing-here'], TZ, NOW);
  assert.equal(c.today.peak, null);
  assert.equal(c.today.changePct.avg, null);
  assert.notEqual(c.today.changePct.avg, 0);
});

test('plays and distinct listeners are declared unavailable, not fabricated', () => {
  // THREE different questions live here and only one is answerable:
  //
  //   concurrent  how many connections are open right now        ✅ we have it
  //   plays       how many times someone started listening       ❌ needs sessions
  //   distinct    how many different people                      ❌ needs identity
  //
  // A person who tunes in three times is one distinct listener and three plays.
  // Icecast's status endpoint reports neither — it reports how many connections
  // exist at an instant, not that one began or who owns it. Presenting a
  // concurrent figure under either name would be an invented number.
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.equal(c.unavailable.plays.value, null);
  assert.equal(c.unavailable.distinctListeners.value, null);
  assert.match(c.unavailable.plays.reason, /admin/i);
  assert.match(c.unavailable.distinctListeners.reason, /admin/i);
  // Each carries its own wording: they are not the same missing thing.
  assert.notEqual(c.unavailable.plays.detail, c.unavailable.distinctListeners.detail);
});
