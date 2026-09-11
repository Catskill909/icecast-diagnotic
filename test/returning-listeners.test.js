/* ═══════════════════════════════════════════════════════════════════════════
   Returning vs new listeners

   The retention question — "3,400 people listened this week, 1,900 of them were
   here last week too" — answered from data already in `devices`. No new field,
   no new collection: the device hash has been stable across weeks since cume
   shipped and has simply never been queried this way.

   THE FAILURE THIS FILE EXISTS TO PREVENT. The earlier window is half of the
   figure. If the monitor was not running through all of it, the listeners who
   WERE there are not recorded, so every one of them counts as new — and a
   recording gap renders as a surge of first-time listeners. That is the most
   flattering possible misreading, on the one metric a station would put in
   front of a funder. It must be withheld as null, not reported as zero.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeviceStore } = require('../device-store');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const since = (daysAgo) => NOW - daysAgo * DAY;

let seq = 0;
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'returning-'));
  return new DeviceStore(path.join(dir, `d${seq++}.db`));
}
const dev = (n) => ({ id: `dev${n}`, cls: 'Safari|iOS', place: 'US:TX' });

/** Devices seen this week and last, with a run of recording behind both. */
function twoWeeks() {
  const s = freshStore();
  // Recording reaches back past the earlier window, so it is comparable.
  s.recordDevices('kpft-main', at(24 * 20), [dev(0)]);
  // Last week: 1, 2, 3
  s.recordDevices('kpft-main', at(24 * 10), [dev(1), dev(2), dev(3)]);
  // This week: 2, 3 return; 4, 5 are new
  s.recordDevices('kpft-main', at(24 * 3), [dev(2), dev(3), dev(4), dev(5)]);
  return s;
}

test('it separates the audience into returning and new', () => {
  const s = twoWeeks();
  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);

  assert.equal(r.comparable, true);
  assert.equal(r.current, 4, 'four people listened in the last 7 days');
  assert.equal(r.returning, 2, 'two of them were here the week before');
  assert.equal(r.newListeners, 2);
  assert.equal(r.previous, 3, 'three people listened in the earlier week');
  assert.equal(r.returningShare, 0.5);
});

test('returning plus new always accounts for exactly the current audience', () => {
  const s = twoWeeks();
  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.returning + r.newListeners, r.current, 'the split must be exhaustive');
  assert.ok(r.newListeners >= 0, 'INTERSECT counts a subset — new can never be negative');
});

test('THE GATE: an earlier window nobody watched is withheld, not called zero', () => {
  const s = freshStore();
  // Recording began four days ago. The 7-day comparison needs 14 days.
  s.recordDevices('kpft-main', at(24 * 4), [dev(1), dev(2)]);
  s.recordDevices('kpft-main', at(24 * 1), [dev(2), dev(3)]);

  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'earlier-period-not-recorded');
  assert.equal(r.returning, null, 'zero would read as "nobody came back"');
  assert.equal(r.newListeners, null, 'and this would read as "everyone is new"');
  assert.equal(r.returningShare, null);
  assert.ok(r.current > 0, 'the current period is still perfectly countable');
});

test('an empty database withholds rather than reporting a clean slate', () => {
  const s = freshStore();
  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'nothing-recorded');
  assert.equal(r.returning, null);
  assert.equal(r.current, 0);
});

test('recording that began a few minutes into the earlier window still counts', () => {
  const s = freshStore();
  /* 30 minutes after the SNAPPED start of the earlier window — the windows are
     whole days, so the tolerance is measured from midnight, not from `now`
     minus fourteen times twenty-four hours. */
  const snappedPrevStart = Math.floor(NOW / DAY) * DAY - 14 * DAY;
  const justInside = new Date(snappedPrevStart + 30 * 60 * 1000).toISOString();
  s.recordDevices('kpft-main', justInside, [dev(1)]);
  s.recordDevices('kpft-main', at(24 * 3), [dev(1), dev(2)]);

  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.comparable, true, 'demanding the exact millisecond withholds a sound figure for ever');
  assert.equal(r.returning, 1);
});

test('the comparison is scoped to the station, like every other figure', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(24 * 20), [dev(0)]);
  s.recordDevices('wpfw', at(24 * 20), [dev(0)]);
  // A device that listened to WPFW last week and KPFT this week is NOT a
  // returning KPFT listener.
  s.recordDevices('wpfw', at(24 * 10), [dev(9)]);
  s.recordDevices('kpft-main', at(24 * 3), [dev(9)]);

  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.current, 1);
  assert.equal(r.returning, 0, 'last week they listened to a different station');
});

test('one person on two of a station\'s channels is one person, both weeks', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(24 * 20), [dev(0)]);
  s.recordDevices('kpft-main', at(24 * 10), [dev(1)]);
  s.recordDevices('kpft-hd2', at(24 * 10), [dev(1)]);
  s.recordDevices('kpft-main', at(24 * 3), [dev(1)]);
  s.recordDevices('kpft-hd2', at(24 * 3), [dev(1)]);

  const r = s.getReturningDevices(['kpft-main', 'kpft-hd2'], since(7), NOW);
  assert.equal(r.current, 1);
  assert.equal(r.returning, 1);
  assert.equal(r.newListeners, 0);
});

test('it survives the day fold — a 30-day comparison stays exact', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(24 * 100), [dev(0)]);
  s.recordDevices('kpft-main', at(24 * 50), [dev(1), dev(2)]);
  s.recordDevices('kpft-main', at(24 * 10), [dev(2), dev(3)]);
  // Out of the hour tier and into DAY buckets, which a whole-day window splits
  // exactly. Day retention is generous so nothing reaches the month tier.
  s.compactDevices(NOW, { hourRetentionH: 48, dayRetentionDays: 3650, monthRetention: 0 });

  const r = s.getReturningDevices(['kpft-main'], since(30), NOW);
  assert.equal(r.comparable, true);
  assert.equal(r.current, 2, 'devices 2 and 3 listened in the last 30 days');
  assert.equal(r.returning, 1, 'device 2 was also in the 30 days before that');
});

/* ── The resolution ceiling ──────────────────────────────────────────────────
   Buckets age into whole CALENDAR MONTHS, and a month cannot be divided by a
   30-day boundary however the window is snapped. The device lands in both
   periods at once and reads as loyal on the strength of a single visit two
   months ago — measured: `returning` went from 1 to 2 on identical data purely
   because compaction ran. Withheld, not reported. */
test('a comparison reaching month-tier data is withheld, not silently inflated', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(24 * 100), [dev(0)]);
  s.recordDevices('kpft-main', at(24 * 50), [dev(1), dev(2)]);
  s.recordDevices('kpft-main', at(24 * 10), [dev(2), dev(3)]);
  s.compactDevices(NOW, { hourRetentionH: 48, dayRetentionDays: 30, monthRetention: 0 });

  const r = s.getReturningDevices(['kpft-main'], since(30), NOW);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'resolution-too-coarse');
  assert.equal(r.returning, null, 'a month bucket in both periods is not evidence of loyalty');
  assert.ok(r.current > 0, 'the current count is still reported');
});

test('the window is snapped to whole days, and says which', () => {
  const s = twoWeeks();
  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.days, 7);
  // Midnight-aligned on both ends, so no day bucket straddles a boundary.
  assert.equal(new Date(r.since).getTime() % DAY, 0, `since is not a day boundary: ${r.since}`);
  assert.equal(new Date(r.until).getTime() % DAY, 0, `until is not a day boundary: ${r.until}`);
  assert.equal(new Date(r.until) - new Date(r.since), 7 * DAY);
});

test('a device seen only in the hours after the snapped end is not lost from the count', () => {
  // NOW is 12:00; the window ends at the preceding midnight. Someone listening
  // this morning falls outside it, which is the cost of whole days and is why
  // the range is reported rather than assumed.
  const s = twoWeeks();
  s.recordDevices('kpft-main', at(2), [dev(77)]);
  const r = s.getReturningDevices(['kpft-main'], since(7), NOW);
  assert.equal(r.current, 4, 'today is not yet a whole day and is not counted');
  assert.ok(new Date(r.until).getTime() < NOW);
});

test('no channels selected is withheld, not answered for the whole network', () => {
  const s = twoWeeks();
  const r = s.getReturningDevices([], since(7), NOW);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'no-channels');
  assert.equal(r.current, 0);
});
