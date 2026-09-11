/* ═══════════════════════════════════════════════════════════════════════════
   How long people listen, over a period rather than at this instant

   TSL is the engagement metric station managers say they actually watch. Reach
   says how many; this says whether they stayed. A station can grow its audience
   while losing engagement, and nothing here could previously show that: session
   figures came from the live snapshot and could not be trended at all.

   THE TRAP, and it is the whole reason this is stored per device.

   Listener detail is read every few minutes. The obvious implementation tallies
   the durations each reading sees and adds them up — and that is LENGTH-BIASED
   sampling. A six-hour session is present in seventy-two consecutive readings;
   a two-minute one is present in at most a single reading. Summed, the
   distribution reports an audience that stays far longer than it does, and the
   error grows with exactly the quantity being measured. A confident,
   flattering, entirely wrong engagement figure.

   So the band is stored ONCE PER DEVICE and RAISED to the longest session seen.
   A listener sampled seventy-two times counts once.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeviceStore } = require('../device-store');
const listenerDetail = require('../listener-detail');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const at = (h) => new Date(NOW - h * HOUR).toISOString();
const since = (h) => NOW - h * HOUR;
const RETENTION = { hourRetentionH: 48, dayRetentionDays: 90, monthRetention: 0 };

let seq = 0;
const freshStore = () => new DeviceStore(
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')), `d${seq++}.db`),
);
const dev = (n, sess) => ({ id: `dev${n}`, cls: 'Safari|iOS', place: 'US:TX', sess });

const B = listenerDetail.SESSION_BUCKET_LABELS;   // index → label

// ── The banding itself ──────────────────────────────────────────────────────

test('a duration lands in the band it belongs to', () => {
  const b = listenerDetail.sessionBucket;
  assert.equal(B[b(30)], 'under 1m');
  assert.equal(B[b(61)], '1–5m');
  assert.equal(B[b(10 * 60)], '5–15m');
  assert.equal(B[b(30 * 60)], '15–60m');
  assert.equal(B[b(2 * 3600)], '1–6h');
  assert.equal(B[b(25 * 3600)], '6h+');
});

test('a missing duration is NOT the shortest band', () => {
  const b = listenerDetail.sessionBucket;
  assert.equal(b(null), -1);
  assert.equal(b(undefined), -1);
  assert.equal(b(-5), -1);
  assert.equal(b(NaN), -1);
  assert.notEqual(b(null), b(0), '"we did not measure" and "under a minute" are different answers');
});

// ── The trap ────────────────────────────────────────────────────────────────

test('THE BIAS: a listener sampled many times counts ONCE, at their longest', () => {
  const s = freshStore();
  const t = at(3);
  // The same six-hour listener, seen in twelve consecutive passes as their
  // session grows. Tallied per reading this would be twelve long sessions.
  for (const secs of [60, 400, 1200, 3000, 5400, 9000, 12000, 15000, 18000, 19000, 20000, 21600]) {
    s.recordDevices('kpft-main', t, [dev(1, listenerDetail.sessionBucket(secs))]);
  }
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);

  assert.equal(r.sessions.measured, 1, 'one listener, not twelve');
  // 21600s is exactly six hours, which is the floor of the 6h+ band.
  assert.deepEqual(r.sessions.bands, { 5: 1 }, 'and recorded at their LONGEST');
  assert.equal(B[5], '6h+');
});

test('the band is raised, never lowered, as a session grows', () => {
  const s = freshStore();
  const t = at(3);
  s.recordDevices('kpft-main', t, [dev(1, 4)]);   // already 1-6h
  s.recordDevices('kpft-main', t, [dev(1, 0)]);   // a later pass reporting less
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.deepEqual(r.sessions.bands, { 4: 1 }, 'a session cannot get shorter');
});

test('a short session is still counted, not lost among the long ones', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(3), [dev(1, 0), dev(2, 0), dev(3, 5)]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.deepEqual(r.sessions.bands, { 0: 2, 5: 1 });
  assert.equal(r.sessions.measured, 3);
});

// ── Not recorded is its own answer ──────────────────────────────────────────

test('listeners with no duration are counted apart, never as short sessions', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(3), [dev(1, 2), dev(2, -1)]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.equal(r.sessions.measured, 1);
  assert.equal(r.sessions.notRecorded, 1);
  assert.deepEqual(r.sessions.bands, { 2: 1 }, 'the unmeasured one is in no band at all');
});

test('rows written before the column existed read as not recorded', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(3), [{ id: 'old', cls: 'Safari|iOS', place: 'US:TX' }]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.equal(r.sessions.notRecorded, 1);
  assert.equal(r.sessions.measured, 0);
});

// ── It has to survive compaction, like everything else here ────────────────

test('the longest session survives the fold into days and months', () => {
  const s = freshStore();
  // Two hours of one listener, the second longer than the first.
  s.recordDevices('kpft-main', at(200), [dev(1, 1)]);
  s.recordDevices('kpft-main', at(199), [dev(1, 4)]);
  s.compactDevices(NOW, RETENTION);

  const r = s.getDistinctDevices(['kpft-main'], since(300), NOW);
  assert.equal(r.devices, 1);
  assert.deepEqual(
    r.sessions.bands, { 4: 1 },
    'folding must take the MAX, or a listener freezes at whatever they were when first noticed',
  );
});

test('a device on two channels keeps its longest, counted once', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(3), [dev(1, 1)]);
  s.recordDevices('kpft-hd2', at(3), [dev(1, 5)]);
  const r = s.getDistinctDevices(['kpft-main', 'kpft-hd2'], since(6), NOW);
  assert.equal(r.sessions.measured, 1);
  assert.deepEqual(r.sessions.bands, { 5: 1 });
});

// ── Scope ───────────────────────────────────────────────────────────────────

test('it is scoped to the station, like every other figure', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(3), [dev(1, 0)]);
  s.recordDevices('wpfw', at(3), [dev(2, 5)]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.deepEqual(r.sessions.bands, { 0: 1 });
});

test('no channels returns an empty distribution in the same shape', () => {
  const s = freshStore();
  const r = s.getDistinctDevices([], since(6), NOW);
  assert.deepEqual(r.sessions, { bands: {}, measured: 0, notRecorded: 0 });
});

test('the bands sum to the measured count, always', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(3), [
    dev(1, 0), dev(2, 1), dev(3, 1), dev(4, 5), dev(5, -1)]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  const summed = Object.values(r.sessions.bands).reduce((a, n) => a + n, 0);
  assert.equal(summed, r.sessions.measured);
  assert.equal(summed + r.sessions.notRecorded, r.devices);
});
