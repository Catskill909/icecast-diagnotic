/* ═══════════════════════════════════════════════════════════════════════════
   When each region listens — the daypart question

   WHY THIS NEEDED A TABLE RATHER THAN A QUERY. Everything else in §4.5 was
   answerable from data already stored. This one is not: `devices` keeps hour
   resolution for DEVICE_HOUR_RETENTION_H (48h) and then a device's timestamp
   becomes its DAY. Two days cannot tell a weekday from a weekend — on this
   station's own record weekends average 69-78 against 43-47 on Monday and
   Tuesday — so a profile built from them could be wrong by more than half
   depending which two days it happened to catch.

   Dayparts are how radio is scheduled and sold, so the aggregate is frozen at
   the moment the exact data still exists, exactly as tune-ins are frozen onto
   an hour's rollup as samples compact. Freeze late and the hour is gone for
   ever; there is no backfill.

   THE HOUR IS THE STATION'S, and converted PER DAY. One offset applied across
   a month puts an hour of October in the wrong column every year.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeviceStore } = require('../device-store');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RETENTION = { hourRetentionH: 48, dayRetentionDays: 90, monthRetention: 0 };

let seq = 0;
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reghours-'));
  return new DeviceStore(path.join(dir, `d${seq++}.db`));
}
const dev = (n, place) => ({ id: `dev${n}`, cls: 'Safari|iOS', place });

/** A UTC instant on a given day at a given hour. */
const utc = (y, m, d, h) => Date.UTC(y, m - 1, d, h);

test('the hour survives compaction, which is the whole point', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 14);           // 14:00 UTC
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX'), dev(2, 'US:TX')]);

  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);        // folds the hour away — and freezes it first

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  const tx = p.regions.find((r) => r.key === 'US:TX');
  assert.ok(tx, 'the region must survive the fold');
  assert.equal(tx.hours[14], 2, 'at the hour it actually happened');
  assert.equal(tx.total, 2);
});

test('freezing happens BEFORE the fold, or the hour is unrecoverable', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 9);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:NY')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  // The device row is now day-resolution; only the frozen aggregate knows 09:00.
  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  assert.equal(p.regions[0].hours[9], 1);
  assert.equal(p.regions[0].hours.filter((n) => n > 0).length, 1, 'one hour, not smeared across the day');
});

test('the live tail and the frozen record are added, never double counted', () => {
  const s = freshStore();
  const base = utc(2026, 6, 10, 8);
  // Old enough to be frozen and folded.
  s.recordDevices('kpft-main', new Date(base).toISOString(), [dev(1, 'US:TX')]);
  const now = base + 5 * DAY;
  s.compactDevices(now, RETENTION);
  // Recent, still in the hour tier and not yet frozen.
  s.recordDevices('kpft-main', new Date(now - HOUR).toISOString(), [dev(2, 'US:TX')]);

  const p = s.getRegionHourProfile(['kpft-main'], base - DAY, now + HOUR, 'UTC');
  assert.equal(p.total, 2, 'one from each source, counted once each');
});

test('compacting twice does not count the same hour twice', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 12);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);
  s.compactDevices(now, RETENTION);        // the rows are gone; nothing to re-freeze
  s.compactDevices(now + DAY, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now + 2 * DAY, 'UTC');
  assert.equal(p.total, 1, 'the fold deletes what it freezes, so a repeat pass sees nothing');
});

test('a channel\'s bitrate variants accumulate into the one hour they share', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 7);
  // The same listener on two channels is two rows; both are that station's.
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX')]);
  s.recordDevices('kpft-hd2', new Date(t).toISOString(), [dev(2, 'US:TX')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main', 'kpft-hd2'], t - DAY, now, 'UTC');
  assert.equal(p.regions[0].hours[7], 2);
});

/* ── The station's clock ─────────────────────────────────────────────────── */

test('the hour is reported on the station\'s clock, not UTC', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 14);           // 14:00 UTC = 09:00 Chicago (CDT)
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'America/Chicago');
  assert.equal(p.timeZone, 'America/Chicago');
  assert.equal(p.regions[0].hours[9], 1, '14:00 UTC is 09:00 in Chicago in June');
  assert.equal(p.regions[0].hours[14], 0);
});

test('DAYLIGHT SAVING is handled per day, not by one offset for the range', () => {
  const s = freshStore();
  // Same UTC hour either side of the US change on 2026-11-01.
  const summer = utc(2026, 10, 15, 14);    // CDT, UTC-5 → 09:00
  const winter = utc(2026, 12, 15, 14);    // CST, UTC-6 → 08:00
  s.recordDevices('kpft-main', new Date(summer).toISOString(), [dev(1, 'US:TX')]);
  s.recordDevices('kpft-main', new Date(winter).toISOString(), [dev(2, 'US:TX')]);
  const now = winter + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], summer - DAY, now, 'America/Chicago');
  const tx = p.regions[0];
  assert.equal(tx.hours[9], 1, 'October is CDT');
  assert.equal(tx.hours[8], 1, 'December is CST — one offset for the range would merge these');
});

test('an unrecognised timezone falls back to UTC rather than losing the data', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 14);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'Not/AZone');
  assert.equal(p.timeZone, 'UTC', 'and it says so rather than pretending');
  assert.equal(p.regions[0].hours[14], 1);
});

/* ── Scope and exclusions ────────────────────────────────────────────────── */

test('relays and unplaceable listeners are excluded, as they are from the map', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 12);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [
    dev(1, 'US:TX'), dev(2, '-'), dev(3, '?'), dev(4, '')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  assert.equal(p.total, 1, 'a datacenter is not an audience, and an unplaced one is not a region');
});

test('non-US listeners are kept at country resolution, as the map publishes them', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 12);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'GB:'), dev(2, 'US:')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  const keys = p.regions.map((r) => r.key).sort();
  assert.deepEqual(keys, ['GB:', 'US:']);
  assert.equal(p.regions.find((r) => r.key === 'GB:').country, 'GB');
  assert.equal(p.regions.find((r) => r.key === 'US:').region, null, 'a withheld state stays withheld');
});

test('it is scoped to the station, in the SQL', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 12);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX')]);
  s.recordDevices('wpfw', new Date(t).toISOString(), [dev(2, 'US:DC')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  assert.deepEqual(p.regions.map((r) => r.key), ['US:TX']);
});

test('no channels returns nothing, not the whole network', () => {
  const s = freshStore();
  const p = s.getRegionHourProfile([], Date.now() - DAY, Date.now(), 'UTC');
  assert.deepEqual(p.regions, []);
  assert.equal(p.reason, 'no-channels');
});

test('it reports when the hour-of-day record begins, because it cannot be backfilled', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 12);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [dev(1, 'US:TX')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  assert.equal(p.coveredFrom, new Date(utc(2026, 6, 1, 0)).toISOString());
});

test('regions come back ordered by how much listening they account for', () => {
  const s = freshStore();
  const t = utc(2026, 6, 1, 12);
  s.recordDevices('kpft-main', new Date(t).toISOString(), [
    dev(1, 'US:TX'), dev(2, 'US:TX'), dev(3, 'US:TX'), dev(4, 'US:NY')]);
  const now = t + 10 * DAY;
  s.compactDevices(now, RETENTION);

  const p = s.getRegionHourProfile(['kpft-main'], t - DAY, now, 'UTC');
  assert.deepEqual(p.regions.map((r) => r.key), ['US:TX', 'US:NY']);
  assert.equal(p.total, 4);
});
