/* ═══════════════════════════════════════════════════════════════════════════
   The "still collecting" notice must retire itself

   Geography is written down from the day it ships and cannot be backfilled, so
   the period map is honestly incomplete at first. The obvious way to say so is
   a banner someone deletes later — and the way that fails is that nobody does,
   so a network of stations reads "still collecting" over a mature figure for
   years, and learns to distrust the number.

   So the notice is DERIVED. These tests pin the three states it moves through
   and, most importantly, that it reaches the third on its own.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/listeners.js'), 'utf8');
const slice = src.slice(src.indexOf('  function geoCoverage(d) {'), src.indexOf('  const plural ='));

const DAY = 24 * 60 * 60 * 1000;

function coverage(d, days = 7) {
  const ctx = { days, Date };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx.geoCoverage(d);
}

const payload = ({ daysAgo = null, placed = 0, unrecorded = 0, days = 7 }) => ({
  period: {
    days,
    coveredFrom: daysAgo == null ? null : new Date(Date.now() - daysAgo * DAY).toISOString(),
    places: { placed, unrecorded },
  },
});

test('before anything is recorded the window map is empty, not wrong', () => {
  const c = coverage(payload({ daysAgo: null, placed: 0, unrecorded: 40 }));
  assert.equal(c.empty, true, 'nothing to draw — the page must fall back to the live map');
  assert.equal(c.partial, false, '"partial" would imply some of it is there');
});

test('a record shorter than the range is reported as still filling in', () => {
  const c = coverage(payload({ daysAgo: 2, placed: 30, unrecorded: 5 }));
  assert.equal(c.empty, false);
  assert.equal(c.partial, true);
  assert.ok(c.daysCovered >= 1.9 && c.daysCovered <= 2.1, `two days covered, got ${c.daysCovered}`);
});

test('THE NOTICE RETIRES ITSELF once the record covers the whole range', () => {
  const c = coverage(payload({ daysAgo: 9, placed: 400, unrecorded: 0 }));
  assert.equal(c.empty, false);
  assert.equal(
    c.partial, false,
    'a record reaching back past the window with no unrecorded device has nothing left to explain',
  );
});

test('a device older than the record keeps the notice up even at full coverage', () => {
  const c = coverage(payload({ daysAgo: 9, placed: 400, unrecorded: 12 }));
  assert.equal(c.partial, true, 'part of this window genuinely has no location behind it');
});

test('a window covered to the minute does not flicker the notice on rounding', () => {
  // Exactly the window length, which floating-point drift would otherwise push
  // a hair under and render "still filling in" at a reader for ever.
  const c = coverage(payload({ daysAgo: 7, placed: 400, unrecorded: 0 }));
  assert.equal(c.partial, false);
});

test('the range comes from the payload, so the notice tracks the pills', () => {
  const c = coverage(payload({ daysAgo: 9, placed: 400, unrecorded: 0, days: 30 }), 30);
  assert.equal(c.windowDays, 30);
  assert.equal(c.partial, true, 'nine days of record does not cover a thirty-day window');
});
