/* ═══════════════════════════════════════════════════════════════════════════
   Where They Listen — the state cartogram and country list

   Separate from the page for the same reason as audience-stats.js and
   preview-player.js: so Node can test the arithmetic. Loads as window.GeoMap in
   the browser and require()s in tests.

   ── Why a TILE GRID and not a shaped map of the United States ───────────────

   `ADMIN-ACCESS-SCOPE.md` §2 specifies "an inline SVG choropleth — US states".
   This is that, with one deliberate change of geometry, for three reasons:

   1. AREA IS NOT AUDIENCE. On a geographic map Montana is 60 times the size of
      Rhode Island and reads as 60 times more important. The quantity here is
      listeners per state, and a shaped map systematically over-weights empty
      land — the single best-documented failure of the choropleth form.

   2. SMALL STATES DISAPPEAR. Rhode Island, Delaware and DC are close to
      invisible at any width this page can give a map, and the north-east is
      exactly where a Pacifica network audience concentrates. A form that hides
      WBAI's home states is the wrong form for this network.

   3. IT MATCHES OUR RESOLUTION. We publish STATE, gated on accuracy radius.
      A precisely drawn coastline implies a precision the data does not have;
      equal tiles say "this is a per-state figure" and nothing more.

   A shaped map also needs ~120 KB of path data, which this page would have to
   ship for a picture that says less.

   ── The layout ─────────────────────────────────────────────────────────────

   The standard 11x8 US tile grid. It preserves adjacency and rough compass
   position — the north-east is up and right, the west coast is left — so it
   reads as the United States without claiming to be a survey.
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoMap = api;
}(typeof self !== 'undefined' ? self : this, () => {
  /* [code, column, row]. 50 states plus DC. Alaska and Hawaii are placed at the
     outer corners by convention rather than by geography, which is what every
     tile grid does and what readers expect. */
  const GRID = [
    ['AK', 0, 0], ['ME', 10, 0],
    ['VT', 9, 1], ['NH', 10, 1],
    ['WA', 0, 2], ['ID', 1, 2], ['MT', 2, 2], ['ND', 3, 2], ['MN', 4, 2],
    ['IL', 5, 2], ['WI', 6, 2], ['MI', 7, 2], ['NY', 8, 2], ['RI', 9, 2], ['MA', 10, 2],
    ['OR', 0, 3], ['NV', 1, 3], ['WY', 2, 3], ['SD', 3, 3], ['IA', 4, 3],
    ['IN', 5, 3], ['OH', 6, 3], ['PA', 7, 3], ['NJ', 8, 3], ['CT', 9, 3],
    ['CA', 0, 4], ['UT', 1, 4], ['CO', 2, 4], ['NE', 3, 4], ['MO', 4, 4],
    ['KY', 5, 4], ['WV', 6, 4], ['VA', 7, 4], ['MD', 8, 4], ['DE', 9, 4],
    ['AZ', 1, 5], ['NM', 2, 5], ['KS', 3, 5], ['AR', 4, 5], ['TN', 5, 5],
    ['NC', 6, 5], ['SC', 7, 5], ['DC', 8, 5],
    ['OK', 3, 6], ['LA', 4, 6], ['MS', 5, 6], ['AL', 6, 6], ['GA', 7, 6],
    ['HI', 0, 7], ['TX', 3, 7], ['FL', 8, 7],
  ];

  const STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
    MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
    WY: 'Wyoming', DC: 'Washington DC',
  };

  /**
   * The in-market figure — the one a station manager actually asks for.
   *
   * THE UNIT IS US-PLACED CONNECTIONS, NOT ALL CONNECTIONS. Dividing by every
   * connection would mix a geography question with the separate questions of
   * how many listeners are abroad and how many could not be placed at all,
   * producing a number that falls when the database gets worse.
   *
   * IT IS A STATE, NOT A SIGNAL AREA, AND THAT GAP IS REAL. KPFT's licence
   * covers Greater Houston; this counts everyone in Texas, so a listener in
   * Dallas counts as in-market. The figure therefore OVERSTATES the audience
   * inside the broadcast footprint and is labelled as a state share, never as
   * "in our coverage area". Metro resolution is not published, so the honest
   * move is to name the state rather than to imply the licence area.
   */
  function inMarket(places) {
    const home = places?.homeRegion || null;
    const states = places?.usStates || {};
    const usPlaced = Object.values(states).reduce((a, b) => a + b, 0);
    if (!home || !usPlaced) {
      return { available: false, reason: !home ? 'no-home-region' : 'no-us-states', home, usPlaced };
    }
    const inside = states[home] || 0;
    return {
      available: true,
      home,
      homeName: STATE_NAMES[home] || home,
      inside,
      outside: usPlaced - inside,
      usPlaced,
      share: inside / usPlaced,
    };
  }

  /**
   * State counts to tiles, with a colour step each.
   *
   * FIVE STEPS, NOT A CONTINUOUS RAMP. A continuous scale invites reading a
   * shade as a value, which at these audience sizes it cannot support — the
   * difference between 3 listeners and 4 is one person and would be a visible
   * shade. Bands say "more" and "fewer" and stop there.
   *
   * The scale is relative to the BUSIEST state rather than absolute, because
   * an absolute scale calibrated for a network of five stations renders a
   * single-station deployment entirely in the palest band.
   */
  function tiles(places) {
    const states = places?.usStates || {};
    const max = Object.values(states).reduce((a, b) => Math.max(a, b), 0);
    const usPlaced = Object.values(states).reduce((a, b) => a + b, 0);

    return GRID.map(([code, col, row]) => {
      const n = states[code] || 0;
      let step = 0;
      if (n > 0 && max > 0) {
        // 1..5. A state with any listener at all is never blank: "one listener
        // in Wyoming" is a fact, and rounding it to the empty colour deletes it.
        step = Math.max(1, Math.min(5, Math.ceil((n / max) * 5)));
      }
      return {
        code,
        name: STATE_NAMES[code] || code,
        col,
        row,
        listeners: n,
        share: usPlaced ? n / usPlaced : 0,
        step,
      };
    });
  }

  /** Countries ranked, with the US first when present — it is the baseline. */
  function countries(places, limit = 8) {
    const entries = Object.entries(places?.countries || {});
    const total = entries.reduce((a, [, v]) => a + v, 0);
    return entries
      .sort((a, b) => (a[0] === 'US' ? -1 : b[0] === 'US' ? 1 : b[1] - a[1]))
      .slice(0, limit)
      .map(([code, n]) => ({ code, listeners: n, share: total ? n / total : 0 }));
  }

  /**
   * Whether the map can be drawn at all, and why not when it cannot.
   *
   * THREE DIFFERENT ANSWERS, KEPT APART. "No database" is a deployment that
   * never configured one; "wrong database" is one installed that cannot report
   * its own uncertainty, so states are withheld on purpose; "no data yet" is a
   * correct setup that has not collected. Each needs a different sentence and a
   * different action, and an empty map that means all three tells nobody
   * anything.
   */
  function readiness(places, geoStatus) {
    const hasStates = Object.keys(places?.usStates || {}).length > 0;
    if (hasStates) return { ok: true };

    if (!geoStatus?.city?.loaded) {
      return {
        ok: false, code: 'no-city-database',
        title: 'No location database installed',
        note: 'Country and state figures need a city-level database. Set MAXMIND_LICENSE_KEY and the app will download GeoLite2 City on its next start.',
      };
    }
    if ((places?.reasons || {})['no-accuracy-radius']) {
      return {
        ok: false, code: 'no-accuracy-radius',
        title: 'This database cannot report its own accuracy',
        note: 'States are withheld because the installed database ships no accuracy radius, so a real place cannot be told apart from a region centroid. Countries below are still correct. GeoLite2 City provides the missing field.',
      };
    }
    if (!places?.placed) {
      return {
        ok: false, code: 'no-data',
        title: 'No located connections yet',
        note: 'The first collection pass runs within a few minutes of startup.',
      };
    }
    return {
      ok: false, code: 'no-us-listeners',
      title: 'No US listeners located in this window',
      note: 'Countries are listed below.',
    };
  }

  return { GRID, STATE_NAMES, inMarket, tiles, countries, readiness };
}));
