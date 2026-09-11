/* ═══════════════════════════════════════════════════════════════════════════
   Player and device mix, as a series rather than a snapshot

   "Smart speakers went from 8% to 22% this year" is a platform decision with
   money attached, and the data for it has been sitting in `devices` since cume
   shipped — `cls` is written per device per bucket and has only ever been read
   as a single current distribution.

   TWO ARTEFACTS THIS FILE EXISTS TO PREVENT, both of which look like findings:

   1. Records age into CALENDAR MONTH buckets carrying the month's start as
      their timestamp. Bucketed by day, every device in a year of history lands
      on the 1st — twelve enormous spikes with emptiness between them, which
      reads as a station that is only listened to on the first of the month.
   2. The bucket in progress is not a smaller bucket. "This month so far"
      against eleven finished months is a collapse that did not happen.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeviceStore } = require('../device-store');
const { kindForFamily } = require('../listener-detail');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (d) => NOW - d * DAY;

let seq = 0;
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'));
  return new DeviceStore(path.join(dir, `d${seq++}.db`));
}
const dev = (n, cls) => ({ id: `dev${n}`, cls, place: 'US:TX' });
const SONOS = 'Sonos|Unknown';
const SAFARI = 'Safari|iOS';

test('it reports the mix per day, counting each device once per bucket', () => {
  const s = freshStore();
  // One person, seen three times in one day, is one device that day.
  s.recordDevices('kpft-main', iso(daysAgo(3)), [dev(1, SONOS)]);
  s.recordDevices('kpft-main', iso(daysAgo(3) + HOUR), [dev(1, SONOS)]);
  s.recordDevices('kpft-main', iso(daysAgo(3) + 2 * HOUR), [dev(1, SONOS), dev(2, SAFARI)]);

  const t = s.getDeviceTrend(['kpft-main'], daysAgo(7), NOW);
  assert.equal(t.granularity, 'day');
  assert.equal(t.buckets.length, 1);
  assert.equal(t.buckets[0].devices, 2);
  assert.deepEqual(t.buckets[0].families, { Sonos: 1, Safari: 1 });
  assert.deepEqual(t.buckets[0].platforms, { Unknown: 1, iOS: 1 });
});

test('a rising share is visible across days', () => {
  const s = freshStore();
  // Day 5: 1 of 4 on a speaker. Day 1: 3 of 4.
  s.recordDevices('kpft-main', iso(daysAgo(5)), [
    dev(1, SONOS), dev(2, SAFARI), dev(3, SAFARI), dev(4, SAFARI)]);
  s.recordDevices('kpft-main', iso(daysAgo(1)), [
    dev(5, SONOS), dev(6, SONOS), dev(7, SONOS), dev(8, SAFARI)]);

  const t = s.getDeviceTrend(['kpft-main'], daysAgo(7), NOW);
  assert.equal(t.buckets.length, 2);
  const [first, last] = t.buckets;
  assert.equal(first.families.Sonos / first.devices, 0.25);
  assert.equal(last.families.Sonos / last.devices, 0.75);
});

test('the classes in a bucket account for exactly its devices', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(2)), [
    dev(1, SONOS), dev(2, SAFARI), dev(3, 'VLC|Windows')]);

  const [b] = s.getDeviceTrend(['kpft-main'], daysAgo(7), NOW).buckets;
  const summed = Object.values(b.families).reduce((a, n) => a + n, 0);
  assert.equal(summed, b.devices, 'a device has exactly one class, so these cannot diverge');
});

/* ── The artefact that would look like a finding ─────────────────────────── */

test('a range reaching month-tier data is reported MONTHLY, not as spikes on the 1st', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(200)), [dev(1, SONOS)]);
  s.recordDevices('kpft-main', iso(daysAgo(150)), [dev(2, SAFARI)]);
  s.recordDevices('kpft-main', iso(daysAgo(5)), [dev(3, SONOS)]);
  // Fold the old rows down into calendar months.
  s.compactDevices(NOW, { hourRetentionH: 48, dayRetentionDays: 90, monthRetention: 0 });

  const t = s.getDeviceTrend(['kpft-main'], daysAgo(365), NOW);
  assert.equal(
    t.granularity, 'month',
    'bucketed by day, a month-tier device lands on the 1st and invents a spike',
  );
  for (const b of t.buckets) {
    assert.match(b.key, /^\d{4}-\d{2}$/, `a monthly bucket key, got ${b.key}`);
  }
});

test('a range inside the day tier keeps daily resolution', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(10)), [dev(1, SONOS)]);
  s.recordDevices('kpft-main', iso(daysAgo(2)), [dev(2, SAFARI)]);
  s.compactDevices(NOW, { hourRetentionH: 48, dayRetentionDays: 3650, monthRetention: 0 });

  const t = s.getDeviceTrend(['kpft-main'], daysAgo(30), NOW);
  assert.equal(t.granularity, 'day');
  assert.equal(t.buckets.length, 2);
});

test('the bucket still running is marked incomplete', () => {
  const s = freshStore();
  const store = s;
  // Today, which has not finished.
  store.recordDevices('kpft-main', new Date().toISOString(), [dev(1, SONOS)]);
  const t = store.getDeviceTrend(['kpft-main'], Date.now() - 7 * DAY, Date.now());
  const last = t.buckets.at(-1);
  assert.equal(last.complete, false, '"today so far" against whole days is a decline that did not happen');
});

test('a finished bucket is marked complete', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(3)), [dev(1, SONOS)]);
  const t = s.getDeviceTrend(['kpft-main'], daysAgo(7), NOW);
  assert.equal(t.buckets[0].complete, true);
});

test('it is scoped to the station, like every other figure', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(2)), [dev(1, SONOS)]);
  s.recordDevices('wpfw', iso(daysAgo(2)), [dev(2, SAFARI)]);

  const t = s.getDeviceTrend(['kpft-main'], daysAgo(7), NOW);
  assert.deepEqual(t.buckets[0].families, { Sonos: 1 });
});

test('no channels selected returns nothing, not the whole network', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(2)), [dev(1, SONOS)]);
  const t = s.getDeviceTrend([], daysAgo(7), NOW);
  assert.deepEqual(t.buckets, []);
  assert.equal(t.reason, 'no-channels');
});

/* ── The kind lookup, which is what makes "smart speakers" answerable ────── */

test('kind is recovered from family, so no new column was needed', () => {
  assert.equal(kindForFamily('Sonos'), 'smart-speaker');
  assert.equal(kindForFamily('Alexa'), 'smart-speaker');
  assert.equal(kindForFamily('Chromecast'), 'smart-speaker');
  assert.equal(kindForFamily('VLC'), 'desktop-player');
  assert.equal(kindForFamily('iOS app'), 'app');
});

test('an unrecognised family is unknown rather than silently miscategorised', () => {
  assert.equal(kindForFamily('Nonesuch Player'), 'unknown');
  assert.equal(kindForFamily(''), 'unknown');
  assert.equal(kindForFamily(undefined), 'unknown');
});

test('the family shown in the mix maps to a kind the page can group by', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', iso(daysAgo(2)), [
    dev(1, SONOS), dev(2, 'Alexa|Unknown'), dev(3, SAFARI)]);

  const [b] = s.getDeviceTrend(['kpft-main'], daysAgo(7), NOW).buckets;
  const speakers = Object.entries(b.families)
    .filter(([f]) => kindForFamily(f) === 'smart-speaker')
    .reduce((n, [, v]) => n + v, 0);
  assert.equal(speakers, 2, 'Sonos and Alexa are both smart speakers');
  assert.equal(speakers / b.devices, 2 / 3);
});
