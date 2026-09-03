/* ═══════════════════════════════════════════════════════════════════════════
   Where They Listen — the cartogram and the in-market figure

   THE CLASS THIS FILE EXISTS TO PREVENT: a map that looks fine and means
   something else.

   Two specific ways that happens here.

   1. A WRONG DENOMINATOR. "68% of our audience is in Texas" is a different
      claim depending on whether the denominator is US-located connections, all
      located connections, or every connection including relays and failures.
      The last is the tempting one and it FALLS when the database gets worse,
      so a station would read a data-quality problem as an audience shift.

   2. A BLANK MAP THAT MEANS THREE DIFFERENT THINGS. No database, wrong
      database, and no listeners yet all render as an empty grid unless they
      are kept apart. Each needs a different action from a different person.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');

const GeoMap = require('../public/geo-map');

// ── The grid itself ─────────────────────────────────────────────────────────

test('the grid holds all 50 states plus DC, each exactly once', () => {
  assert.equal(GeoMap.GRID.length, 51);
  assert.equal(new Set(GeoMap.GRID.map(([c]) => c)).size, 51);
});

test('NO TWO STATES SHARE A CELL', () => {
  /* Two tiles at one grid position stack invisibly: the second silently
     replaces the first, and a state vanishes from the map with nothing to
     show that it did. */
  const positions = GeoMap.GRID.map(([, col, row]) => `${col},${row}`);
  assert.equal(new Set(positions).size, GeoMap.GRID.length);
});

test('every tile has a full state name for its tooltip', () => {
  const unnamed = GeoMap.GRID.filter(([c]) => !GeoMap.STATE_NAMES[c]);
  assert.deepEqual(unnamed, [], 'a tile with no name renders a bare code on hover');
});

test('the grid fits the CSS it is drawn into: 11 columns, 8 rows', () => {
  // The stylesheet declares a fixed 11x8 grid. A tile outside it is dropped by
  // the browser without error.
  for (const [code, col, row] of GeoMap.GRID) {
    assert.ok(col >= 0 && col <= 10, `${code} column ${col} is outside the grid`);
    assert.ok(row >= 0 && row <= 7, `${code} row ${row} is outside the grid`);
  }
});

// ── The in-market share ─────────────────────────────────────────────────────

const PLACES = {
  usStates: { TX: 80, CA: 20, NY: 10, WY: 1 },
  countries: { US: 111, CA: 4, GB: 2 },
  homeRegion: 'TX',
  placed: 117, relays: 9, unplaced: 3, stateWithheld: 0, reasons: {},
};

test('the in-market share is measured against US-LOCATED connections', () => {
  /* THE DENOMINATOR IS THE WHOLE POINT. 80 of 111 located US connections is
     72%. Dividing by `placed` (117, which includes other countries) or by every
     connection (129, which adds relays and failures) would give 68% or 62% —
     both plausible-looking, both answering a different question, and both
     moving when the DATABASE changes rather than when the audience does. */
  const m = GeoMap.inMarket(PLACES);
  assert.equal(m.usPlaced, 111);
  assert.equal(m.inside, 80);
  assert.equal(m.outside, 31);
  assert.equal(Math.round(m.share * 100), 72);
});

test('the home state is named in full, so the label cannot be misread', () => {
  const m = GeoMap.inMarket(PLACES);
  assert.equal(m.home, 'TX');
  assert.equal(m.homeName, 'Texas');
});

test('with no home region configured the figure is WITHHELD, not guessed', () => {
  /* The tempting shortcut is to assume the largest state is the home state.
     That is usually true, and the one station where it is false gets a
     confidently wrong headline. */
  const m = GeoMap.inMarket({ ...PLACES, homeRegion: null });
  assert.equal(m.available, false);
  assert.equal(m.reason, 'no-home-region');
  assert.equal(m.share, undefined);
});

test('with no located US states the figure is withheld rather than zero', () => {
  // 0% would assert that nobody is in Texas. Nobody was placed at all.
  const m = GeoMap.inMarket({ usStates: {}, homeRegion: 'TX' });
  assert.equal(m.available, false);
  assert.equal(m.reason, 'no-us-states');
});

test('a home state with no listeners is 0%, which is a real answer', () => {
  // Distinct from the case above: states WERE located, just not this one.
  const m = GeoMap.inMarket({ usStates: { CA: 5 }, homeRegion: 'TX' });
  assert.equal(m.available, true);
  assert.equal(m.inside, 0);
  assert.equal(m.share, 0);
});

// ── Colour banding ──────────────────────────────────────────────────────────

test('a state with any listener at all is never left blank', () => {
  /* Wyoming's single listener against Texas's 80 rounds to zero on a
     proportional scale. One listener in Wyoming is a fact, and painting it as
     the empty colour deletes it from the map. */
  const wy = GeoMap.tiles(PLACES).find((t) => t.code === 'WY');
  assert.equal(wy.listeners, 1);
  assert.ok(wy.step >= 1, 'a state with a listener must be visible');
});

test('states with no listeners are step 0, and the busiest is step 5', () => {
  const t = GeoMap.tiles(PLACES);
  assert.equal(t.find((x) => x.code === 'TX').step, 5);
  assert.equal(t.find((x) => x.code === 'MT').step, 0);
});

test('the scale is relative, so one station does not render entirely pale', () => {
  /* An absolute scale calibrated for a five-station network would put a single
     small station's whole map in the palest band. */
  const small = GeoMap.tiles({ usStates: { TX: 3, CA: 1 } });
  assert.equal(small.find((x) => x.code === 'TX').step, 5);
  assert.ok(small.find((x) => x.code === 'CA').step >= 1);
});

test('no tile is emitted outside the five bands', () => {
  for (const t of GeoMap.tiles(PLACES)) {
    assert.ok(t.step >= 0 && t.step <= 5, `${t.code} has step ${t.step}`);
  }
});

test('empty input produces a full grid of empty tiles, not an error', () => {
  const t = GeoMap.tiles({});
  assert.equal(t.length, 51);
  assert.ok(t.every((x) => x.step === 0 && x.listeners === 0));
});

// ── Countries ───────────────────────────────────────────────────────────────

test('the US sorts first as the baseline, then by size', () => {
  const c = GeoMap.countries({ countries: { GB: 2, US: 111, CA: 4 } });
  assert.deepEqual(c.map((x) => x.code), ['US', 'CA', 'GB']);
});

test('country shares are of all located connections', () => {
  const c = GeoMap.countries(PLACES);
  assert.equal(Math.round(c[0].share * 100), 95);
});

// ── Readiness: three different blanks ───────────────────────────────────────

test('NO DATABASE and WRONG DATABASE are different messages', () => {
  /* The one that matters most. A deployment with no database and a deployment
     with DB-IP City installed both show no states — but one operator needs to
     configure something and the other has already configured the wrong thing,
     and the fix differs. */
  const none = GeoMap.readiness({ usStates: {} }, { city: { loaded: false } });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no-city-database');

  const wrong = GeoMap.readiness(
    { usStates: {}, placed: 40, reasons: { 'no-accuracy-radius': 40 } },
    { city: { loaded: true } },
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'no-accuracy-radius');
  assert.notEqual(wrong.title, none.title);
});

test('a correct setup with no data yet says so', () => {
  const r = GeoMap.readiness({ usStates: {}, placed: 0, reasons: {} }, { city: { loaded: true } });
  assert.equal(r.code, 'no-data');
});

test('a working database with only non-US listeners is not an error', () => {
  const r = GeoMap.readiness({ usStates: {}, placed: 12, reasons: {} }, { city: { loaded: true } });
  assert.equal(r.code, 'no-us-listeners');
});

test('states present means ready, whatever else is missing', () => {
  assert.equal(GeoMap.readiness(PLACES, { city: { loaded: true } }).ok, true);
});

test('every blocked state carries a title AND an action', () => {
  // A message that says something is wrong without saying what to do is a
  // dead end for whoever is reading the page.
  for (const [places, geo] of [
    [{ usStates: {} }, { city: { loaded: false } }],
    [{ usStates: {}, placed: 40, reasons: { 'no-accuracy-radius': 40 } }, { city: { loaded: true } }],
    [{ usStates: {}, placed: 0, reasons: {} }, { city: { loaded: true } }],
  ]) {
    const r = GeoMap.readiness(places, geo);
    assert.ok(r.title && r.title.length > 5, 'needs a title');
    assert.ok(r.note && r.note.length > 20, 'needs an explanation');
  }
});

// ── The privacy boundary, again at this layer ───────────────────────────────

test('THE BOUNDARY: nothing the map renders can carry a coordinate or an address', () => {
  /* geo.js drops coordinates at the read and listener-detail.js aggregates
     before anything leaves the server, so this layer only ever sees counts.
     Asserted here too because this is the layer someone would edit to "just
     add a dot". */
  const rendered = JSON.stringify({
    tiles: GeoMap.tiles(PLACES),
    countries: GeoMap.countries(PLACES),
    market: GeoMap.inMarket(PLACES),
  });
  assert.ok(!/latitude|longitude|"lat"|"lon"/i.test(rendered), 'coordinates must never reach the page');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(rendered), 'no IP address may appear');
});
