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
      timestamp: new Date(base + i * 60 * 1000).toISOString(),
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
  store.addSample(id, { timestamp: new Date(base + 60 * 60 * 1000).toISOString(), status: 'up', responseTime: 10, listeners: 90 });

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
      timestamp: new Date(base + i * 60 * 1000).toISOString(),
      status: 'up', responseTime: 10, listeners: n,
    });
  });
  assert.equal(store.getTuneIns([id], base - 1000, NOW).total, 100);
});

test('total listeners is carried per period with its own comparison', () => {
  const c = store.getListenerCounts(['a'], TZ, NOW);
  assert.ok(c.today.totalListeners > 0, 'today has a reach figure');
  assert.ok('totalListeners' in c.today.changePct, 'compared like the others');
  assert.equal(c.today.totalListenersMeta.floor, true);
});

test('individual listeners stay a declared headline, not a fabricated one', () => {
  // One person who tunes in ten times is TEN total listeners and ONE individual
  // listener. Both are headline figures for a station; only the first is
  // derivable from a connection count, so the second says why it is empty rather
  // than being quietly filled with the other.
  const c = store.getListenerCounts(['a'], TZ, NOW);
  const u = c.unavailable.individualListeners;
  assert.equal(u.value, null);
  assert.match(u.reason, /admin/i);
  assert.notEqual(u.label, undefined);
  // It must never be conflated with the tune-in count sitting beside it.
  assert.notEqual(u.value, c.today.totalListeners);
});

test('a reach comparison is withheld when the earlier window is under-recorded', () => {
  // Caught in the live audit on the day this shipped: last week fell outside raw
  // retention and its rollups predated tune-in recording, so it came back 1,339
  // against this week's 5,813 and the page announced "+376%". Entirely an
  // artefact of the older window being half-recorded — the kind of number a
  // station would repeat in a board meeting.
  const id = 'partial';
  store.ensureStreams([id]);
  const base = Date.parse('2026-08-28T06:00:00.000Z');
  [10, 20].forEach((n, i) => {
    store.addSample(id, {
      timestamp: new Date(base + i * 60 * 1000).toISOString(),
      status: 'up', responseTime: 10, listeners: n,
    });
  });
  // An hour in the comparison window that was rolled up before tune-ins existed:
  // present, but carrying no tuneIns figure.
  store.getRollups(id).push({
    hour: '2026-08-27T06:00:00.000Z',
    checks: 60, up: 60, down: 0, silent: 0,
    listenerCount: 60, avgListeners: 40, listenerPeak: 55,
  });

  const t = store.getTuneIns([id], Date.parse('2026-08-27T00:00:00.000Z'), Date.parse('2026-08-28T00:00:00.000Z'));
  assert.ok(t.hoursMissing > 0, 'the gap in recording is detected');

  const c = store.getListenerCounts([id], TZ, NOW);
  assert.equal(c.today.totalListenersComparable, false, 'so the comparison is refused');
  assert.equal(c.today.changePct.totalListeners, null, 'rather than dividing by a partial total');
});
