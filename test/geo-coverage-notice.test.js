/* ═══════════════════════════════════════════════════════════════════════════
   The "still collecting" notice must retire itself — and must not argue
   with itself while it is up

   Geography is written down from the day it ships and cannot be backfilled, so
   the period map is honestly incomplete at first. The obvious way to say so is
   a banner someone deletes later — and the way that fails is that nobody does,
   so a network of stations reads "still collecting" over a mature figure for
   years and learns to distrust the number. So the notice is DERIVED.

   THE BUG THIS FILE EXISTS TO PREVENT, shipped and seen in production:
   `period.coveredFrom` is when DEVICE recording began; `places.coveredFrom` is
   when LOCATION recording began. The first was read as the second, so the panel
   announced "Location has been recorded for 7 days of the last 7 days, so this
   map covers part of the period rather than all of it" — a sentence that states
   full coverage and partial coverage in the same breath, on the one panel whose
   whole job that week was explaining why a number looked small.

   The lesson is in the shape of the fix: the notice is driven by COUNTS of
   listeners with and without a location, not by date arithmetic. A count cannot
   contradict itself, and it reaches zero on its own as old rows age out.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/listeners.js'), 'utf8');
/* Anchored to the function that FOLLOWS geoCoverage, not to whichever small
   helper happened to sit between them — moving an unrelated one-line const
   otherwise breaks seven tests that have nothing to do with it. */
const start = src.indexOf('  function geoCoverage(d) {');
const slice = src.slice(start, src.indexOf('  async function renderGeo(d) {', start));

const DAY = 24 * 60 * 60 * 1000;

function coverage(d, days = 7) {
  const ctx = { days, Date };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx.geoCoverage(d);
}

/** `locatedDaysAgo` is when LOCATION recording began — the field that matters. */
const payload = ({ locatedDaysAgo = null, placed = 0, unrecorded = 0, relays = 0, unplaced = 0, days = 7 }) => ({
  period: {
    days,
    // Device recording is old. It is deliberately set far back in every case
    // here: if this value ever leaks into the notice again, the tests break.
    coveredFrom: new Date(Date.now() - 400 * DAY).toISOString(),
    places: {
      placed, unrecorded, relays, unplaced,
      coveredFrom: locatedDaysAgo == null ? null : new Date(Date.now() - locatedDaysAgo * DAY).toISOString(),
    },
  },
});

test('before any location is recorded the window map is empty, not wrong', () => {
  const c = coverage(payload({ locatedDaysAgo: null, placed: 0, unrecorded: 40 }));
  assert.equal(c.empty, true, 'nothing to draw — the page must fall back to the live map');
  assert.equal(c.partial, false, '"partial" would imply some of it is there');
});

test('an old device record cannot be mistaken for an old location record', () => {
  // Device recording 400 days old, location recording 2 hours old: the exact
  // shape that produced the contradictory sentence in production.
  const c = coverage(payload({ locatedDaysAgo: 2 / 24, placed: 2, unrecorded: 380 }));
  assert.equal(c.partial, true);
  assert.ok(
    c.daysLocated < 1,
    `location recording is hours old, not days — got ${c.daysLocated} days`,
  );
  assert.equal(c.located, 2);
  assert.equal(c.unrecorded, 380, 'the people counted before location existed must stay visible');
});

test('coverage is stated as a count of people, never as a span of days', () => {
  const c = coverage(payload({ locatedDaysAgo: 3, placed: 10, relays: 2, unplaced: 1, unrecorded: 87 }));
  assert.equal(c.known, 13, 'located + relays + unplaced all have a location behind them');
  assert.equal(c.total, 100);
  assert.equal(c.partial, true);
});

test('THE NOTICE RETIRES ITSELF once every listener in the range has a location', () => {
  const c = coverage(payload({ locatedDaysAgo: 9, placed: 400, unrecorded: 0 }));
  assert.equal(c.empty, false);
  assert.equal(
    c.partial, false,
    'no device in the window predates the location record — there is nothing left to explain',
  );
});

test('it retires on the devices, not on a clock', () => {
  // Location recording is younger than the window, but every listener still in
  // the range arrived after it started. That map is complete; say nothing.
  const c = coverage(payload({ locatedDaysAgo: 2, placed: 50, unrecorded: 0 }), 7);
  assert.equal(c.partial, false, 'a short record that covers everyone present is not partial');
});

test('one listener without a location is enough to keep the notice up', () => {
  const c = coverage(payload({ locatedDaysAgo: 9, placed: 400, unrecorded: 1 }));
  assert.equal(c.partial, true);
});

test('the range comes from the payload, so the panel tracks the pills', () => {
  const c = coverage(payload({ locatedDaysAgo: 9, placed: 400, unrecorded: 0, days: 30 }), 30);
  assert.equal(c.windowDays, 30);
});
