/* ═══════════════════════════════════════════════════════════════════════════
   Cume — distinct devices reached in a period

   THE NUMBER THIS PRODUCT EXISTS TO PRODUCE, and the reason the admin
   credential and the login were built at all. Every other audience figure on
   the page answers a different question:

     total listeners   how many times someone STARTED listening
     peak / average    how many were connected at one INSTANT
     listening hours   how much listening happened

   None of those is audience size. A station reporting to a board, pricing
   underwriting, or filling in a funder's reach question needs the count of
   distinct PEOPLE, which in broadcast is called cume, and it is the currency
   the entire industry runs on.

   THE CLASS OF BUG THESE TESTS EXIST TO PREVENT: every naive implementation
   counts observations rather than identities, and therefore RISES WHEN THE
   STREAM BREAKS — a flapping encoder makes every listener reconnect, and each
   reconnect looks like another person. That is precisely backwards: the number
   a station reports as growth would climb on the days it served its audience
   worst. `total listeners` has that property today and is honest about it;
   cume must not, and the flapping test below is the one that pins it.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cume-'));

const store = require('../store');
const ld = require('../listener-detail');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 2, 18, 0, 0);
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

const dev = (n) => ({ id: `dev${n}`, cls: 'Safari|iOS' });

function reset() {
  store._resetDevices();
}

// ── The core property ───────────────────────────────────────────────────────

test('the same device seen in many polls is ONE listener', () => {
  reset();
  // Twelve polls across one hour, identical audience each time — which is what
  // a five-minute collection cadence actually produces.
  for (let i = 0; i < 12; i++) {
    store.recordDevices('a', at(1), [dev(1), dev(2), dev(3)]);
  }
  assert.equal(store.getDistinctDevices(['a'], NOW - 24 * HOUR, NOW).devices, 3);
});

test('THE CLASS: a flapping stream does not inflate cume', () => {
  reset();
  // The real 2026-09-02 shape: the mount drops and returns repeatedly and the
  // SAME audience reconnects every time. Tune-ins count each reconnection —
  // correctly, that is what they are. Cume must not, or the number a station
  // reports as reach would go UP on the day it served its listeners worst.
  const audience = [dev(1), dev(2), dev(3), dev(4), dev(5)];
  for (let flap = 0; flap < 14; flap++) {
    store.recordDevices('a', at(2), audience);
  }
  const c = store.getDistinctDevices(['a'], NOW - 24 * HOUR, NOW);
  assert.equal(c.devices, 5, 'fourteen outages, five people — cume counts the people');
});

test('genuinely new devices DO raise it', () => {
  reset();
  store.recordDevices('a', at(3), [dev(1), dev(2)]);
  store.recordDevices('a', at(2), [dev(2), dev(3)]);   // dev2 returns, dev3 is new
  assert.equal(store.getDistinctDevices(['a'], NOW - 24 * HOUR, NOW).devices, 3);
});

// ── Windows ─────────────────────────────────────────────────────────────────

test('a window only counts what falls inside it', () => {
  reset();
  store.recordDevices('a', at(1), [dev(1)]);
  store.recordDevices('a', at(50), [dev(2)]);          // outside 24h
  assert.equal(store.getDistinctDevices(['a'], NOW - 24 * HOUR, NOW).devices, 1);
  assert.equal(store.getDistinctDevices(['a'], NOW - 72 * HOUR, NOW).devices, 2);
});

test('windows nest — a longer window can never report fewer people', () => {
  reset();
  for (let h = 1; h < 30; h++) store.recordDevices('a', at(h), [dev(h)]);
  const day = store.getDistinctDevices(['a'], NOW - 24 * HOUR, NOW).devices;
  const week = store.getDistinctDevices(['a'], NOW - 7 * 24 * HOUR, NOW).devices;
  assert.ok(week >= day, `7d (${week}) must be >= 24h (${day})`);
});

test('channels union without double-counting a device on both', () => {
  reset();
  store.recordDevices('a', at(1), [dev(1), dev(2)]);
  store.recordDevices('b', at(1), [dev(2), dev(3)]);   // dev2 listens to both
  assert.equal(store.getDistinctDevices(['a', 'b'], NOW - 24 * HOUR, NOW).devices, 3);
});

// ── Compaction ──────────────────────────────────────────────────────────────

test('compaction into daily buckets preserves the count exactly', () => {
  reset();
  // A union is order-free and idempotent, which is WHY it can be compacted at
  // all — an average could not survive this and that is why samples cannot be
  // treated the same way.
  for (let h = 50; h < 70; h++) store.recordDevices('a', at(h), [dev(h % 7)]);
  const before = store.getDistinctDevices(['a'], NOW - 90 * 24 * HOUR, NOW).devices;
  store.compactDevices(NOW);
  const after = store.getDistinctDevices(['a'], NOW - 90 * 24 * HOUR, NOW).devices;
  assert.equal(after, before, 'compaction must not lose or duplicate a person');
  const tiers = store._deviceTiers();
  assert.equal(tiers.hour, 0, 'old hours folded away');
  assert.ok(tiers.day > 0, 'and landed in days');
});

test('a device active every hour costs one row per day after compaction', () => {
  reset();
  for (let h = 50; h < 74; h++) store.recordDevices('a', at(h), [dev(1)]);
  store.compactDevices(NOW);
  // THE PROPERTY: a listener present every hour costs one row PER DAY, not one
  // per hour. The window below spans more than one UTC day, so the count is the
  // number of days touched — asserting a flat 1 would be asserting the calendar,
  // not the deduplication.
  const daysTouched = new Set();
  for (let h = 50; h < 74; h++) daysTouched.add(at(h).slice(0, 10));
  assert.equal(
    store._deviceTiers().day, daysTouched.size,
    `24 hourly observations of one device became ${daysTouched.size} daily row(s)`,
  );
  assert.ok(daysTouched.size < 24, 'and that is far fewer than the 24 hours it was seen in');
  assert.equal(store.getDistinctDevices(['a'], 0, NOW).devices, 1, 'still one person');
});

test('OLD DATA IS NOT DROPPED — the day tier empties into months, nobody is lost', () => {
  // This test previously asserted the opposite: that a device older than 40 days
  // was deleted. That cap was wrong, and it is the whole reason this was
  // rewritten — a station's reach a year ago is the baseline every growth claim
  // is measured against. What ages out is RESOLUTION, never the person.
  reset();
  store.recordDevices('a', at(24 * 400), [dev(1)]);
  store.compactDevices(NOW);

  assert.equal(
    store._deviceTiers().day, 0,
    'the day-level bucket is gone — that is the resolution being released',
  );
  assert.equal(
    store.getDistinctDevices(['a'], 0, NOW).devices, 1,
    'but the listener is still counted, 400 days later',
  );
  assert.ok(
    store._deviceTiers().month > 0,
    'because they were folded into the permanent month tier',
  );
});

test('months are kept for ever by default', () => {
  // 0 means never delete, and the default IS 0. A deployment can opt into
  // forgetting; it can never happen by accident.
  assert.equal(store.DEVICE_MONTH_RETENTION, 0);
});

// ── Honesty about coverage ──────────────────────────────────────────────────

test('a window longer than the history is flagged partial, not quoted as whole', () => {
  reset();
  store.recordDevices('a', at(2), [dev(1)]);
  const month = store.getDistinctDevices(['a'], NOW - 30 * 24 * HOUR, NOW);
  assert.equal(month.devices, 1);
  assert.equal(month.partial, true, 'two hours of data is not a 30-day cume');
});

test('the device mix is carried with the count', () => {
  reset();
  store.recordDevices('a', at(1), [
    { id: 'x1', cls: 'Alexa|Unknown' },
    { id: 'x2', cls: 'Safari|iOS' },
    { id: 'x3', cls: 'Safari|iOS' },
  ]);
  const c = store.getDistinctDevices(['a'], NOW - 24 * HOUR, NOW);
  assert.equal(c.devices, 3);
  assert.equal(c.players.Safari, 2);
  assert.equal(c.players.Alexa, 1);
  assert.equal(c.platforms.iOS, 2);
});

// ── Identity ────────────────────────────────────────────────────────────────

test('a device identity is stable, and reveals neither address nor agent', () => {
  const salt = 'test-salt';
  const a = ld.deviceId('203.0.113.7', 'VLC/3.0.20', salt);
  const b = ld.deviceId('203.0.113.7', 'VLC/3.0.20', salt);
  assert.equal(a, b, 'the same device must count once across polls');
  assert.ok(!a.includes('203.0.113.7'));
  assert.ok(!a.includes('VLC'));
});

test('a different salt yields a different identity — so it must never rotate', () => {
  // Pinned because rotating the salt silently resets cume to zero and makes
  // every returning listener look new: the most important number in the product
  // would quietly become a deploy counter.
  const a = ld.deviceId('203.0.113.7', 'VLC', 'salt-one');
  const b = ld.deviceId('203.0.113.7', 'VLC', 'salt-two');
  assert.notEqual(a, b);
});

test('two devices in one household are two identities', () => {
  const salt = 's';
  // Same address, different players. NAT means we cannot tell one household
  // from one person, but we can tell two devices apart, and that is the honest
  // unit — which is why the figure is labelled devices reached.
  assert.notEqual(
    ld.deviceId('198.51.100.22', 'VLC/3.0.20', salt),
    ld.deviceId('198.51.100.22', 'Sonos/70.1', salt),
  );
});

test('machines never enter cume', () => {
  const rows = [
    { ip: '1.1.1.1', userAgent: 'Safari/605', connectedSec: 300, id: '1' },
    { ip: '1.1.1.2', userAgent: 'UptimeRobot/2.0', connectedSec: 30, id: '2' },
    { ip: '1.1.1.3', userAgent: 'Chrome/120', connectedSec: 340388, id: '3' },
  ];
  const ids = ld.deviceIdentities(rows, 's');
  assert.equal(ids.length, 1, 'a scraper and a week-long relay were never reached');
});

/* ── Permanent retention ────────────────────────────────────────────────────
   THE POINT OF THE PRODUCT. A radio station's reach five years ago is not
   stale data — it is the baseline every growth claim is measured against, and
   it is exactly what a board, a funder and a CPB return ask for. An earlier
   version of this file capped devices at 40 days, which quietly made the most
   important figure in the app unable to answer the questions it exists for.

   The rule these tests pin: RESOLUTION is discarded as data ages, DATA IS NOT.
   ═════════════════════════════════════════════════════════════════════════ */

test('a device from years ago is still counted — nothing ages out', () => {
  reset();
  const fiveYears = 5 * 365 * 24 * HOUR;
  store.recordDevices('a', new Date(NOW - fiveYears).toISOString(), [dev(1), dev(2)]);
  store.compactDevices(NOW);
  const all = store.getDistinctDevices(['a'], 0, NOW);
  assert.equal(all.devices, 2, 'five-year-old reach must still be answerable');
});

test('hours fold to days fold to months, and the count never changes', () => {
  reset();
  // The same five listeners, seen once an hour for four days.
  const audience = [dev(1), dev(2), dev(3), dev(4), dev(5)];
  for (let h = 1; h <= 96; h++) store.recordDevices('a', at(h), audience);
  const before = store.getDistinctDevices(['a'], 0, NOW).devices;

  store.compactDevices(NOW);
  assert.equal(store.getDistinctDevices(['a'], 0, NOW).devices, before, 'hour->day loses nobody');

  // Push it past the day tier as well.
  store.compactDevices(NOW + 200 * 24 * HOUR);
  assert.equal(
    store.getDistinctDevices(['a'], 0, NOW + 200 * 24 * HOUR).devices, before,
    'day->month loses nobody either',
  );
  assert.ok(store._deviceTiers().month > 0, 'and it landed in the month tier');
});

test('compaction shrinks storage without shrinking the answer', () => {
  reset();
  const audience = Array.from({ length: 20 }, (_, i) => dev(i));
  for (let h = 1; h <= 96; h++) store.recordDevices('a', at(h), audience);
  const rowsBefore = store._deviceRows();

  store.compactDevices(NOW + 200 * 24 * HOUR);
  const rowsAfter = store._deviceRows();

  assert.equal(store.getDistinctDevices(['a'], 0, NOW + 200 * 24 * HOUR).devices, 20);
  assert.ok(rowsAfter < rowsBefore, `stored rows fell ${rowsBefore} -> ${rowsAfter} for the same 20 people`);
});

test('the device mix survives into the permanent tier', () => {
  reset();
  store.recordDevices('a', at(200 * 24), [
    { id: 'm1', cls: 'Alexa|Unknown' },
    { id: 'm2', cls: 'Safari|iOS' },
  ]);
  store.compactDevices(NOW);
  const c = store.getDistinctDevices(['a'], 0, NOW);
  assert.equal(c.players.Alexa, 1, 'what they listened ON is kept, not just how many');
  assert.equal(c.platforms.iOS, 1);
});

// ── Named months, the growth series ─────────────────────────────────────────

test('months are reported by name, oldest first', () => {
  reset();
  store.recordDevices('a', '2026-07-15T12:00:00.000Z', [dev(1), dev(2)]);
  store.recordDevices('a', '2026-08-15T12:00:00.000Z', [dev(2), dev(3), dev(4)]);
  const rows = store.getMonthlyAudience(['a'], { now: NOW });
  const july = rows.find((r) => r.month === '2026-07');
  const aug = rows.find((r) => r.month === '2026-08');
  assert.equal(july.devices, 2);
  assert.equal(aug.devices, 3);
  assert.ok(rows.indexOf(july) < rows.indexOf(aug), 'chronological');
});

test('a multi-month figure is a UNION, never a sum', () => {
  reset();
  // dev2 listened in both months. Adding 2 + 3 would report five people; there
  // were four. This is the property that makes cume un-rollupable and is the
  // whole reason the identity sets are kept rather than just the counts.
  store.recordDevices('a', '2026-07-15T12:00:00.000Z', [dev(1), dev(2)]);
  store.recordDevices('a', '2026-08-15T12:00:00.000Z', [dev(2), dev(3), dev(4)]);
  const both = store.getDistinctDevices(
    ['a'], Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'),
  );
  assert.equal(both.devices, 4, 'not 5 — one person listened in both months');
});

test('a year-over-year comparison needs two COMPLETE months', () => {
  reset();
  store.recordDevices('a', '2025-08-15T12:00:00.000Z', [dev(1), dev(2)]);
  store.recordDevices('a', '2026-08-15T12:00:00.000Z', [dev(1), dev(2), dev(3)]);
  const rows = store.getMonthlyAudience(['a'], { months: 36, now: Date.parse('2026-09-15T00:00:00Z') });
  const aug26 = rows.find((r) => r.month === '2026-08');
  assert.equal(aug26.vsLastYear, 50, '2 -> 3 devices is +50% on the same month last year');

  // The month still running is not comparable with a whole one.
  const sep = store.getMonthlyAudience(['a'], { months: 36, now: Date.parse('2026-09-15T00:00:00Z') })
    .find((r) => r.month === '2026-09');
  if (sep) assert.equal(sep.vsLastYear, null, 'a part-month must not be put in a ratio');
});

/* ── The salt must survive a restart ────────────────────────────────────────
   THE FAILURE THIS PREVENTS IS SILENT AND TOTAL. Device identity is a hash of
   (IP + user agent + salt). If the salt is regenerated on boot, every returning
   listener hashes to a new value and counts as a new person — so cume climbs by
   the entire connected audience on every deploy, and the most important number
   in the product quietly becomes a deploy counter. Nothing errors, nothing
   looks wrong, and the graph goes up.

   It was asserted in a comment and never tested. This tests it. */

test('THE REAL TEST: the salt survives a process restart', () => {
  // An in-process store.load() does NOT exercise this — module state stays in
  // memory and the test passes while the real failure is wide open. That is
  // exactly what happened: this was asserted in a comment, "tested" by reload,
  // and a genuine restart produced a different salt every time. It must be a
  // separate process or it proves nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-restart-'));
  const read = () => execFileSync(
    process.execPath,
    ['-e', 'const s=require("./store");s.load([]);process.stdout.write(s.deviceSalt())'],
    { env: { ...process.env, DATA_DIR: dir }, cwd: path.join(__dirname, '..'),
      encoding: 'utf8' },
  ).trim().split('\n').pop();

  const first = read();
  assert.ok(first && first.length >= 24, 'a salt was generated');
  assert.equal(read(), first, 'a new salt on restart would reset cume to zero on every deploy');
  assert.equal(read(), first, 'and stays stable on the one after that');
});

test('a returning listener hashes the same after a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-dev-'));
  const idFor = () => execFileSync(
    process.execPath,
    ['-e',
      'const s=require("./store");const l=require("./listener-detail");s.load([]);'
      + 'process.stdout.write(l.deviceId("203.0.113.9","Safari/605",s.deviceSalt()))'],
    { env: { ...process.env, DATA_DIR: dir }, cwd: path.join(__dirname, '..'),
      encoding: 'utf8' },
  ).trim().split('\n').pop();

  assert.equal(idFor(), idFor(), 'the same device must not look new after a redeploy');
});

test('an explicit DEVICE_HASH_SALT wins and is stable', () => {
  const saved = process.env.DEVICE_HASH_SALT;
  process.env.DEVICE_HASH_SALT = 'operator-supplied-salt';
  try {
    assert.equal(store.deviceSalt(), 'operator-supplied-salt');
    store.load([]);
    assert.equal(store.deviceSalt(), 'operator-supplied-salt');
  } finally {
    if (saved === undefined) delete process.env.DEVICE_HASH_SALT;
    else process.env.DEVICE_HASH_SALT = saved;
  }
});
