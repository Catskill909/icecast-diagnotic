/* ═══════════════════════════════════════════════════════════════════════════
   Where the audience is, over a WINDOW rather than at this instant

   THE PROBLEM THIS SOLVES. Icecast reports where its currently connected
   listeners are and keeps no history of it, so the map could only ever answer
   "right now" — 77 connections, sitting under a heading that said seven days,
   beside a 7-day peak of 1,060. A general manager has no use for a snapshot;
   the reportable figure is how many distinct people listened over a period and
   where they were. That map can only exist if the place is written down beside
   the device as it is seen, which is what `devices.place` is.

   THE FAILURE MODE THAT WOULD NOT HAVE BEEN NOTICED: `compactDevices` folds
   hours into days into months. Had the fold not carried `place`, the map would
   have worked perfectly for 24 hours, then quietly emptied at 30 days — with
   every test passing, because nothing exercised a window that crossed a tier.

   THE OTHER ONE: a deployment already has a permanent `devices` table with no
   `place` column and rows that cannot be re-collected. Those listeners were
   real and their location was never recorded, which is NOT the same as being
   unplaceable — averaged together they would understate located share for ever.
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
const NOW = Date.UTC(2026, 8, 2, 18, 0, 0);
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const RETENTION = { hourRetentionH: 48, dayRetentionDays: 90, monthRetention: 0 };

let seq = 0;
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devgeo-'));
  return new DeviceStore(path.join(dir, `d${seq++}.db`));
}
const dev = (n, place) => ({ id: `dev${n}`, cls: 'Safari|iOS', place });
const since = (hoursAgo) => NOW - hoursAgo * HOUR;

// ── Storage ────────────────────────────────────────────────────────────────

test('a window reports distinct people per state, not connections per moment', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(2), [dev(1, 'US:TX'), dev(2, 'US:TX'), dev(3, 'US:CA')]);
  // The same person, seen again an hour later, is still one person.
  s.recordDevices('kpft-main', at(1), [dev(1, 'US:TX')]);

  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.equal(r.devices, 3);
  assert.deepEqual(r.places.usStates, { TX: 2, CA: 1 });
  assert.equal(r.places.placed, 3);
});

test('place survives the fold from hours into days into months', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(200), [dev(1, 'US:TX'), dev(2, 'US:NY')]);
  s.recordDevices('kpft-main', at(100), [dev(3, 'US:TX')]);

  // Everything here is older than the 48-hour tier, so all of it gets folded.
  s.compactDevices(NOW, RETENTION);

  const r = s.getDistinctDevices(['kpft-main'], since(300), NOW);
  assert.equal(r.devices, 3, 'the fold must not lose devices');
  assert.deepEqual(
    r.places.usStates, { TX: 2, NY: 1 },
    'geography must travel with the device through every tier, or the 30-day map empties silently',
  );
  assert.equal(r.places.unrecorded, 0, 'a folded row must not read as never having been recorded');
});

test('relays and unplaceable addresses are held apart from each other', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(1), [
    dev(1, 'US:TX'), dev(2, '-'), dev(3, '?'), dev(4, 'US:'), dev(5, 'GB:'),
  ]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);

  assert.equal(r.places.relays, 1, 'a relay is excluded, exactly as the live panel excludes it');
  assert.equal(r.places.unplaced, 1);
  assert.equal(r.places.placed, 3, 'US with a state, US withheld, and non-US are all placed');
  assert.equal(r.places.stateWithheld, 1, 'a US record that failed the centroid guard has no state');
  assert.deepEqual(r.places.countries, { US: 2, GB: 1 });
  assert.deepEqual(r.places.usStates, { TX: 1 }, 'a withheld state must never be guessed onto the map');
});

test('rows written before geography existed read as unrecorded, never as unplaceable', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(1), [{ id: 'old', cls: 'Safari|iOS' }]);   // no place
  s.recordDevices('kpft-main', at(1), [dev(2, 'US:TX')]);

  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.equal(r.places.unrecorded, 1);
  assert.equal(r.places.unplaced, 0, '"we never wrote it down" is not "we could not place them"');
  assert.equal(r.places.placed, 1);
});

test('a device placed on any one channel is placed, not averaged away', () => {
  const s = freshStore();
  // Same person on two of the station's channels; one row predates geography.
  s.recordDevices('kpft-main', at(1), [{ id: 'devdual', cls: 'Safari|iOS' }]);
  s.recordDevices('kpft-hd2', at(1), [dev('dual', 'US:TX')]);   // dev() prefixes 'dev'

  const r = s.getDistinctDevices(['kpft-main', 'kpft-hd2'], since(6), NOW);
  assert.equal(r.devices, 1, 'one person listening to two channels is one person');
  assert.deepEqual(r.places.usStates, { TX: 1 });
  assert.equal(r.places.unrecorded, 0);
});

test('an existing database with no place column is migrated, keeping its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devgeo-mig-'));
  const file = path.join(dir, 'legacy.db');

  // Build the pre-feature table by hand, exactly as it shipped.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE devices (
      stream_id TEXT NOT NULL, tier INTEGER NOT NULL,
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      device TEXT NOT NULL, cls TEXT NOT NULL,
      PRIMARY KEY (stream_id, tier, start_ms, device)
    ) WITHOUT ROWID;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  raw.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?)')
    .run('kpft-main', 0, NOW - 2 * HOUR, NOW - HOUR, 'legacy1', 'Safari|iOS');
  raw.close();

  const s = new DeviceStore(file);
  s.recordDevices('kpft-main', at(1), [dev(2, 'US:TX')]);

  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.equal(r.devices, 2, 'the permanent record must survive the migration');
  assert.equal(r.places.unrecorded, 1, 'the legacy row has no location and must say so');
  assert.deepEqual(r.places.usStates, { TX: 1 });
});

// ── The token, which must follow the live panel's rules exactly ─────────────

const geoStub = ({ network = 'direct', place = {} } = {}) => ({
  lookupNetwork: () => ({ resolved: true, network, asn: 1, org: 'Org' }),
  lookupPlace: () => ({ resolved: true, countryCode: 'US', region: 'TX', isEU: false,
    accuracyRadius: 10, regionWithheld: null, ...place }),
});

test('a relay is stored as excluded, by the same rule the live map uses', () => {
  const rows = [{ ip: '1.2.3.4', userAgent: 'VLC/3.0', connectedSec: 60 }];
  const ids = listenerDetail.deviceIdentities(rows, 'salt', geoStub({ network: 'hosting' }));
  assert.equal(ids.length, 1);
  assert.equal(ids[0].place, '-', 'a datacenter connection geolocates to the datacenter, not an audience');
});

test('a US state is stored only when it clears the centroid guard', () => {
  const rows = [{ ip: '1.2.3.4', userAgent: 'VLC/3.0', connectedSec: 60 }];

  const ok = listenerDetail.deviceIdentities(rows, 'salt', geoStub());
  assert.equal(ok[0].place, 'US:TX');

  const withheld = listenerDetail.deviceIdentities(rows, 'salt',
    geoStub({ place: { region: null, regionWithheld: 'centroid' } }));
  assert.equal(withheld[0].place, 'US:', 'the country stands alone when the state cannot be trusted');
});

test('outside the US the country is stored and nothing finer', () => {
  const rows = [{ ip: '1.2.3.4', userAgent: 'VLC/3.0', connectedSec: 60 }];
  const ids = listenerDetail.deviceIdentities(rows, 'salt',
    geoStub({ place: { countryCode: 'GB', region: 'ENG' } }));
  assert.equal(ids[0].place, 'GB:', 'sub-national accuracy varies too much to publish');
});

test('with no geo databases every listener is unplaced, not silently absent', () => {
  const rows = [{ ip: '1.2.3.4', userAgent: 'VLC/3.0', connectedSec: 60 }];
  const ids = listenerDetail.deviceIdentities(rows, 'salt');
  assert.equal(ids.length, 1, 'the listener is still counted');
  assert.equal(ids[0].place, '?');
});

test('a bot is still excluded from the device record entirely', () => {
  const rows = [{ ip: '1.2.3.4', userAgent: 'Icecast 2.4.3', connectedSec: 60 }];
  assert.equal(listenerDetail.deviceIdentities(rows, 'salt', geoStub()).length, 0);
});

// ── When location recording began ──────────────────────────────────────────

test('places.coveredFrom is when LOCATION began, not when the device record did', () => {
  const s = freshStore();
  // A long-standing device record with no geography behind it...
  s.recordDevices('kpft-main', at(120), [{ id: 'old1', cls: 'Safari|iOS' }]);
  s.recordDevices('kpft-main', at(90), [{ id: 'old2', cls: 'Safari|iOS' }]);
  // ...and location recording starting only an hour ago.
  s.recordDevices('kpft-main', at(1), [dev(9, 'US:TX')]);

  const r = s.getDistinctDevices(['kpft-main'], since(300), NOW);

  assert.ok(r.coveredFrom, 'the device record still reports its own start');
  assert.ok(
    new Date(r.coveredFrom).getTime() <= NOW - 100 * HOUR,
    'device recording is old',
  );
  assert.ok(
    new Date(r.places.coveredFrom).getTime() >= NOW - 2 * HOUR,
    'location recording is an hour old and must not inherit the device record\'s age',
  );
  assert.equal(r.places.unrecorded, 2);
  assert.equal(r.places.placed, 1);
});

test('with no located rows at all, places.coveredFrom is null rather than a guess', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(2), [{ id: 'old1', cls: 'Safari|iOS' }]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.equal(r.places.coveredFrom, null);
  assert.equal(r.places.placed, 0);
});

test('a relay still counts as a located row: we know where it was, and excluded it', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(1), [dev(1, '-')]);
  const r = s.getDistinctDevices(['kpft-main'], since(6), NOW);
  assert.ok(r.places.coveredFrom, 'the lookup ran; the result was "exclude this one"');
  assert.equal(r.places.unrecorded, 0, 'an excluded relay is not an unrecorded listener');
});
