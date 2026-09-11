/* ═══════════════════════════════════════════════════════════════════════════
   Metro-level geography, and why the gate is tighter than the state's

   THE NUMBER THIS CORRECTS. A broadcast licence covers a METRO; the state map
   counts a whole state. So "in market" reports Greater Houston's audience as
   all of Texas — reading high — and "outside our signal area", the figure that
   justifies streaming to a board, reads low. The metro list is what tells them
   apart.

   THE ARTEFACT IT MUST NOT CREATE. Geolocation fails by returning something
   plausible: an unresolvable address comes back as a regional centroid, in a
   real city, and reads as a finding. 200 km is sound evidence for a STATE — it
   is inside one. It is worthless for a CITY: 200 km from Houston reaches
   Austin. So the city gate is tighter, and a record that clears the state gate
   but not the city one keeps its state and loses only its city.

   This file covers the whole path: the lookup rule, the stored token, and the
   aggregate read back out of it.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const geo = require('../geo');
const listenerDetail = require('../listener-detail');
const { DeviceStore } = require('../device-store');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const at = (h) => new Date(NOW - h * HOUR).toISOString();

let seq = 0;
const freshStore = () => new DeviceStore(
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'city-')), `d${seq++}.db`),
);

/** geo stub shaped like the real lookups. */
const stub = (place) => ({
  lookupNetwork: () => ({ resolved: true, network: 'residential', asn: 1, org: 'ISP' }),
  lookupPlace: () => ({
    resolved: true, countryCode: 'US', region: 'TX', city: 'Houston',
    cityWithheld: null, regionWithheld: null, isEU: false, accuracyRadius: 10, ...place,
  }),
});
const row = { ip: '1.2.3.4', userAgent: 'VLC/3.0', connectedSec: 60 };

// ── The token ───────────────────────────────────────────────────────────────

test('a precise US record stores country, state AND city', () => {
  const [d] = listenerDetail.deviceIdentities([row], 'salt', stub());
  assert.equal(d.place, 'US:TX:Houston');
});

test('a record too coarse for a city keeps its state', () => {
  const [d] = listenerDetail.deviceIdentities([row], 'salt',
    stub({ city: null, cityWithheld: 'radius' }));
  assert.equal(d.place, 'US:TX', 'the state survives; only the smaller claim is dropped');
});

test('a colon in a city name cannot shift every reader\'s parse', () => {
  const [d] = listenerDetail.deviceIdentities([row], 'salt', stub({ city: 'Foo:Bar' }));
  assert.equal(d.place.split(':').length, 3, 'still three segments');
  assert.equal(d.place, 'US:TX:Foo Bar');
});

test('outside the US the token is unchanged — country and stop', () => {
  const [d] = listenerDetail.deviceIdentities([row], 'salt',
    stub({ countryCode: 'GB', region: null, city: null, cityWithheld: 'non-us' }));
  assert.equal(d.place, 'GB:');
});

test('an old two-segment token still reads correctly', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(1), [{ id: 'old', cls: 'Safari|iOS', place: 'US:TX' }]);
  const r = s.getDistinctDevices(['kpft-main'], NOW - 6 * HOUR, NOW);
  assert.deepEqual(r.places.usStates, { TX: 1 });
  assert.deepEqual(r.places.usCities, {}, 'no city, and no invented one');
  assert.equal(r.places.cityWithheld, 1);
});

test('MAX(place) still prefers the MORE informative token', () => {
  const s = freshStore();
  // The same person on two channels, one row written before cities existed.
  s.recordDevices('kpft-main', at(1), [{ id: 'dual', cls: 'Safari|iOS', place: 'US:TX' }]);
  s.recordDevices('kpft-hd2', at(1), [{ id: 'dual', cls: 'Safari|iOS', place: 'US:TX:Houston' }]);

  const r = s.getDistinctDevices(['kpft-main', 'kpft-hd2'], NOW - 6 * HOUR, NOW);
  assert.equal(r.devices, 1);
  assert.deepEqual(r.places.usCities, { 'TX/Houston': 1 });
});

// ── The aggregate ───────────────────────────────────────────────────────────

test('cities are keyed by STATE and city, never by bare name', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(1), [
    { id: 'a', cls: 'c', place: 'US:TX:Houston' },
    { id: 'b', cls: 'c', place: 'US:AK:Houston' },
  ]);
  const r = s.getDistinctDevices(['kpft-main'], NOW - 6 * HOUR, NOW);
  assert.deepEqual(
    r.places.usCities, { 'TX/Houston': 1, 'AK/Houston': 1 },
    'there is a Houston in Alaska; a bare name would add them together',
  );
});

test('a metro count never exceeds its state count', () => {
  const s = freshStore();
  s.recordDevices('kpft-main', at(1), [
    { id: 'a', cls: 'c', place: 'US:TX:Houston' },
    { id: 'b', cls: 'c', place: 'US:TX:Houston' },
    { id: 'c', cls: 'c', place: 'US:TX' },
  ]);
  const r = s.getDistinctDevices(['kpft-main'], NOW - 6 * HOUR, NOW);
  assert.equal(r.places.usStates.TX, 3);
  assert.equal(r.places.usCities['TX/Houston'], 2);
  assert.equal(r.places.cityWithheld, 1, 'the third is in the state map and not the metro list');
  assert.ok(r.places.usCities['TX/Houston'] <= r.places.usStates.TX);
});

test('merging mounts sums cities like every other place count', () => {
  const merged = listenerDetail.mergeAggregates([
    { places: { usCities: { 'TX/Houston': 3 }, usStates: { TX: 3 }, cityWithheld: 1 } },
    { places: { usCities: { 'TX/Houston': 2, 'TX/Austin': 1 }, usStates: { TX: 3 }, cityWithheld: 0 } },
  ], { host: 'h' });
  assert.deepEqual(merged.places.usCities, { 'TX/Houston': 5, 'TX/Austin': 1 });
  assert.equal(merged.places.cityWithheld, 1);
});

// ── The gate itself ─────────────────────────────────────────────────────────

test('the city gate is tighter than the state gate', () => {
  assert.ok(
    geo.MAX_CITY_ACCURACY_RADIUS_KM < geo.MAX_ACCURACY_RADIUS_KM,
    'a smaller claim needs better evidence, not the same evidence',
  );
});

test('the gate is exactly at the configured radius, not near it', () => {
  const rec = (r) => geo.placeFromRecord({
    country: { iso_code: 'US' },
    subdivisions: [{ iso_code: 'TX' }],
    city: { names: { en: 'Houston' } },
    location: { accuracy_radius: r },
  });
  assert.equal(rec(geo.MAX_CITY_ACCURACY_RADIUS_KM).city, 'Houston');
  assert.equal(rec(geo.MAX_CITY_ACCURACY_RADIUS_KM + 1).city, null);
  assert.equal(rec(geo.MAX_CITY_ACCURACY_RADIUS_KM + 1).region, 'TX', 'the state is unaffected');
});
