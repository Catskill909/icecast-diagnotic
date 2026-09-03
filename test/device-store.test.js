/* ═══════════════════════════════════════════════════════════════════════════
   Device records in SQLite

   The storage engine for cume, which is the one record in this app bounded by
   nothing: permanent by design, and growing with the AUDIENCE rather than with
   time or station count. Measured over one year of the Pacifica network it is
   16.7 MB resident as JSON and none at all on disk.

   THE BUG THESE TESTS CAUGHT, before any of it was wired in: the first version
   filtered channels in JavaScript, AFTER `GROUP BY device` had already
   collapsed rows across channels. Filtering the result cannot tell whose
   devices they were, so every station reported the whole network's cume — a
   station's headline audience figure silently becoming somebody else's. The
   filter has to be in the SQL, and the cross-channel tests below are what say
   so.

   Needs Node 22.5+ for `node:sqlite`, which test/runtime-version.test.js now
   enforces for the whole suite — so this file no longer guards for it itself.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeviceStore } = require('../device-store');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 2, 18, 0, 0);
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const dev = (n, cls = 'Safari|iOS') => ({ id: `dev${n}`, cls });
const RETENTION = { hourRetentionH: 48, dayRetentionDays: 90, monthRetention: 0 };

let seq = 0;
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devstore-'));
  return new DeviceStore(path.join(dir, `d${seq++}.db`));
}

/** Runs a test against a fresh database, closed however the test ends. */
function dbTest(name, fn) {
  test(name, () => {
    const db = freshStore();
    try { fn(db); } finally { db.close(); }
  });
}

// ── The core property ───────────────────────────────────────────────────────

dbTest('the same device seen in many polls is ONE listener', (db) => {
  for (let i = 0; i < 12; i++) db.recordDevices('a', at(1), [dev(1), dev(2), dev(3)]);
  assert.equal(db.getDistinctDevices(['a'], NOW - DAY, NOW).devices, 3);
});

dbTest('THE CLASS: a flapping stream does not inflate cume', (db) => {
  // Fourteen outages, the same five people reconnecting each time. Tune-ins
  // count each reconnection, correctly. Cume must not, or the number a station
  // reports as reach climbs on the day it served its listeners worst.
  const audience = [dev(10), dev(11), dev(12), dev(13), dev(14)];
  for (let f = 0; f < 14; f++) db.recordDevices('b', at(2), audience);
  assert.equal(db.getDistinctDevices(['b'], NOW - DAY, NOW).devices, 5);
});

// ── The channel filter — the bug this file caught ───────────────────────────

dbTest('THE LEAK: one channel never sees another channel\'s devices', (db) => {
  db.recordDevices('a', at(1), [dev(1), dev(2), dev(3)]);
  db.recordDevices('b', at(1), [dev(10), dev(11), dev(12), dev(13), dev(14)]);
  assert.equal(db.getDistinctDevices(['a'], NOW - DAY, NOW).devices, 3, 'a has three');
  assert.equal(db.getDistinctDevices(['b'], NOW - DAY, NOW).devices, 5, 'b has five, not eight');
});

dbTest('channels union without double-counting a device on both', (db) => {
  db.recordDevices('a', at(1), [dev(1), dev(2)]);
  db.recordDevices('c', at(1), [dev(1), dev(99)]);   // dev1 listens to both
  assert.equal(db.getDistinctDevices(['a', 'c'], NOW - DAY, NOW).devices, 3);
});

dbTest('an unknown or empty channel list reports nobody, not everybody', (db) => {
  db.recordDevices('a', at(1), [dev(1), dev(2)]);
  assert.equal(db.getDistinctDevices(['nope'], NOW - DAY, NOW).devices, 0);
  assert.equal(db.getDistinctDevices([], NOW - DAY, NOW).devices, 0);
});

// ── Windows ─────────────────────────────────────────────────────────────────

dbTest('a window only counts what falls inside it', (db) => {
  db.recordDevices('a', at(1), [dev(1)]);
  db.recordDevices('a', at(50), [dev(2)]);
  assert.equal(db.getDistinctDevices(['a'], NOW - DAY, NOW).devices, 1);
  assert.equal(db.getDistinctDevices(['a'], NOW - 72 * HOUR, NOW).devices, 2);
});

dbTest('windows nest — a longer window can never report fewer people', (db) => {
  for (let h = 1; h < 30; h++) db.recordDevices('a', at(h), [dev(h)]);
  const day = db.getDistinctDevices(['a'], NOW - DAY, NOW).devices;
  const week = db.getDistinctDevices(['a'], NOW - 7 * DAY, NOW).devices;
  assert.ok(week >= day, `7d (${week}) must be >= 24h (${day})`);
});

// ── Tiering and permanence ──────────────────────────────────────────────────

dbTest('hours fold to days fold to months, and the count never changes', (db) => {
  const audience = [dev(1), dev(2), dev(3), dev(4), dev(5)];
  for (let h = 1; h <= 96; h++) db.recordDevices('a', at(h), audience);
  const before = db.getDistinctDevices(['a'], 0, NOW).devices;

  db.compactDevices(NOW, RETENTION);
  assert.equal(db.getDistinctDevices(['a'], 0, NOW).devices, before, 'hour->day loses nobody');

  const later = NOW + 200 * DAY;
  db.compactDevices(later, RETENTION);
  assert.equal(db.getDistinctDevices(['a'], 0, later).devices, before, 'day->month loses nobody');
});

dbTest('compaction shrinks stored rows without shrinking the answer', (db) => {
  const audience = Array.from({ length: 20 }, (_, i) => dev(i));
  for (let h = 1; h <= 96; h++) db.recordDevices('a', at(h), audience);
  const rowsBefore = db.rowCount();

  db.compactDevices(NOW + 200 * DAY, RETENTION);
  assert.equal(db.getDistinctDevices(['a'], 0, NOW + 200 * DAY).devices, 20);
  assert.ok(db.rowCount() < rowsBefore, `rows fell ${rowsBefore} -> ${db.rowCount()} for the same 20 people`);
});

dbTest('a listener from years ago is still counted — nothing ages out', (db) => {
  db.recordDevices('a', new Date(NOW - 5 * 365 * DAY).toISOString(), [dev(1), dev(2)]);
  db.compactDevices(NOW, RETENTION);
  assert.equal(db.getDistinctDevices(['a'], 0, NOW).devices, 2, 'five-year-old reach stays answerable');
});

dbTest('months are only dropped when a deployment explicitly asks', (db) => {
  db.recordDevices('a', new Date(NOW - 5 * 365 * DAY).toISOString(), [dev(1)]);
  db.compactDevices(NOW, { ...RETENTION, monthRetention: 12 });
  assert.equal(db.getDistinctDevices(['a'], 0, NOW).devices, 0, 'opted in to forgetting');
});

// ── The mix ─────────────────────────────────────────────────────────────────

dbTest('the device mix is carried with the count, and survives compaction', (db) => {
  db.recordDevices('a', at(200), [
    dev(1, 'Alexa|Unknown'), dev(2, 'Safari|iOS'), dev(3, 'Safari|iOS'),
  ]);
  db.compactDevices(NOW, RETENTION);
  const c = db.getDistinctDevices(['a'], 0, NOW);
  assert.equal(c.devices, 3);
  assert.equal(c.players.Safari, 2);
  assert.equal(c.players.Alexa, 1);
  assert.equal(c.platforms.iOS, 2);
});

// ── Coverage honesty ────────────────────────────────────────────────────────

dbTest('a window longer than the history is flagged partial', (db) => {
  db.recordDevices('a', at(2), [dev(1)]);
  const month = db.getDistinctDevices(['a'], NOW - 30 * DAY, NOW);
  assert.equal(month.devices, 1);
  assert.equal(month.partial, true, 'two hours of data is not a 30-day cume');
});

// ── Durability ──────────────────────────────────────────────────────────────

dbTest('data survives closing and reopening the database', (db) => {
  db.recordDevices('a', at(1), [dev(1), dev(2)]);
  const file = db.file;
  db.close();
  const reopened = new DeviceStore(file);
  try {
    assert.equal(reopened.getDistinctDevices(['a'], NOW - DAY, NOW).devices, 2);
  } finally { reopened.close(); }
});

dbTest('months are reported by name, oldest first', (db) => {
  db.recordDevices('a', '2026-07-15T12:00:00.000Z', [dev(1)]);
  db.recordDevices('a', '2026-08-15T12:00:00.000Z', [dev(2)]);
  const keys = db.monthKeys();
  assert.ok(keys.includes('2026-07') && keys.includes('2026-08'));
  assert.deepEqual([...keys].sort(), keys, 'chronological');
});

dbTest('a multi-month figure is a UNION, never a sum', (db) => {
  // dev2 listened in both months. 2 + 3 would report five people; there were
  // four. This is the property that makes cume un-rollupable.
  db.recordDevices('a', '2026-07-15T12:00:00.000Z', [dev(1), dev(2)]);
  db.recordDevices('a', '2026-08-15T12:00:00.000Z', [dev(2), dev(3), dev(4)]);
  const both = db.getDistinctDevices(
    ['a'], Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'),
  );
  assert.equal(both.devices, 4);
});
