/* ═══════════════════════════════════════════════════════════════════════════
   A ranked list that shows a top N must SAY it is a top N

   REPORTED: "on the listener page for KPFK, Player/App is not showing iOS app —
   other Pacifica stations are showing it." It was there. The list drew the top
   nine and dropped the rest without a word, so a station whose audience uses
   ten kinds of app simply did not have the tenth.

   This is the failure this page keeps having to fix in different clothes: an
   absent figure is indistinguishable from a zero one, and the reader concludes
   something about their audience rather than about the list.

   It also breaks the arithmetic ON SCREEN. The percentages are shares of the
   whole audience, so the visible rows fall short of 100% with nothing to
   explain the gap — which reads as a bug in the numbers.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/listeners.js'), 'utf8');
// From the counter the helper uses, not from the function itself — slicing
// below a declaration it closes over is how this file ReferenceErrors.
const start = src.indexOf('  let barSeq = 0;');
const slice = src.slice(start, src.indexOf('  /* Returning vs new listeners.', start));

function load() {
  const ctx = { Math, Object, esc: (x) => String(x == null ? '' : x) };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx;
}
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/* Ten players, which is one more than the Player/App list shows. */
const TEN_PLAYERS = {
  Safari: 400, Chrome: 300, VLC: 120, Sonos: 90, Alexa: 60,
  Firefox: 40, Roku: 30, Winamp: 20, foobar2000: 10, 'iOS app': 8,
};
const TOTAL = Object.values(TEN_PLAYERS).reduce((a, n) => a + n, 0);

test('THE REPORTED BUG: the tenth player is no longer silently dropped', () => {
  const { bars } = load();
  const html = bars(TEN_PLAYERS, TOTAL, 9);
  const t = text(html);
  assert.match(t, /1 more/, 'the reader must be told something was left out');
  assert.match(t, /\b8\b/, 'and how many listeners it accounts for');
});

/** The markup split into what is on screen and what is behind the expander. */
function halves(html) {
  const at = html.indexOf('<div class="deep-bar-hidden"');
  const visible = at === -1 ? html : html.slice(0, at);
  const collapsed = at === -1 ? '' : html.slice(at);
  const vals = (part) => [...part.matchAll(/deep-bar-val">(\d+)</g)].map((m) => Number(m[1]));
  return { visible, collapsed, visibleVals: vals(visible), hiddenVals: vals(collapsed) };
}

test('the VISIBLE column sums to the total — the remainder closes the gap', () => {
  const { bars } = load();
  const { visibleVals } = halves(bars(TEN_PLAYERS, TOTAL, 9));
  assert.equal(
    visibleVals.reduce((a, n) => a + n, 0), TOTAL,
    'a reader adding what is on screen must reach the total, or the page looks broken',
  );
});

test('the collapsed rows sum to exactly what the remainder row claims', () => {
  const { bars } = load();
  const { visibleVals, hiddenVals } = halves(bars(TEN_PLAYERS, TOTAL, 9));
  const remainder = visibleVals[visibleVals.length - 1];
  assert.equal(
    hiddenVals.reduce((a, n) => a + n, 0), remainder,
    'expanding must reveal exactly the listeners the summary promised',
  );
});

test('THE TAIL IS ON SCREEN, not behind a control the reader has to find', () => {
  /* The class of bug, not the instance. The reported failure was "iOS app is
     not showing" — an entry that existed and was silently cut. Putting it
     behind a collapsed expander drawn in tertiary italic fixed the arithmetic
     and left the entry just as unfindable: nothing on the row read as
     clickable, so nobody clicked. A remainder group that ships collapsed is the
     same bug wearing a caret. */
  const { bars } = load();
  const html = bars(TEN_PLAYERS, TOTAL, 9);
  assert.match(html, /iOS app/, 'the tenth entry is rendered, not merely counted');
  assert.doesNotMatch(
    html, /<div class="deep-bar-hidden"[^>]*\shidden[\s>]/,
    'and it is VISIBLE on load — no click required to reach it',
  );
  assert.match(html, /aria-expanded="true"/, 'the control agrees with what is drawn');
});

test('the remainder group is still ordered AFTER the ranked rows', () => {
  // Open by default must not mean mixed in: the top N is still the top N.
  const { bars } = load();
  const { visible, collapsed } = halves(bars(TEN_PLAYERS, TOTAL, 9));
  assert.doesNotMatch(visible, /iOS app/, 'the ranked list above is unchanged');
  assert.match(collapsed, /iOS app/, 'the tail is its own group below the summary row');
});

test('the expander is keyboard reachable and announces its state', () => {
  const { bars } = load();
  const html = bars(TEN_PLAYERS, TOTAL, 9);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-expanded="true"/, 'open by default, and says so');
  assert.match(html, /aria-controls="bar-rest-/);
  assert.match(html, /<div class="deep-bar-hidden" id="bar-rest-[^"]+">/);
  assert.match(html, /title="Hide the remaining 1"/, 'the title says what a click DOES');
});

test('each list on a page gets its own toggle id', () => {
  // Four lists render at once; a shared id would make one caret open another.
  const { bars } = load();
  const a = bars(TEN_PLAYERS, TOTAL, 9).match(/id="(bar-rest-[^"]+)"/)[1];
  const b = bars(TEN_PLAYERS, TOTAL, 9).match(/id="(bar-rest-[^"]+)"/)[1];
  assert.notEqual(a, b);
});

test('a complete list does not imply there is more', () => {
  const { bars } = load();
  const html = bars({ Safari: 10, Chrome: 5 }, 15, 9);
  assert.doesNotMatch(html, /deep-bar-rest/);
  assert.doesNotMatch(text(html), /more/);
});

test('exactly at the limit is complete, not truncated', () => {
  const { bars } = load();
  const nine = Object.fromEntries(Object.entries(TEN_PLAYERS).slice(0, 9));
  assert.doesNotMatch(bars(nine, 1000, 9), /deep-bar-rest/, 'off-by-one here invents a phantom row');
});

test('many hidden entries are summed into ONE row, not listed', () => {
  const { bars } = load();
  // A long flat tail, all of it individually tiny.
  const many = {};
  for (let i = 0; i < 60; i += 1) many[`P${i}`] = 60 - i;
  const total = Object.values(many).reduce((a, n) => a + n, 0);
  const html = bars(many, total, 9);
  assert.equal((html.match(/deep-bar-rest/g) || []).length, 1, 'one remainder row, however long the tail');
  assert.match(text(html), /\d+ more/);
});

/* ── Where the cut falls ────────────────────────────────────────────────────
   A fixed count lands in the wrong place for some stations and not others. On
   KPFK the twelfth row was 1% and the collapsed tail was 6%, so the hidden
   group outranked three rows above it — which is a fair thing for a reader to
   query, and the reason the cut is now by SHARE. */

test('the cut is by SHARE, so everything worth a percent is on the page', () => {
  const { bars } = load();
  const players = { A: 500, B: 300, C: 100, D: 60, E: 25, F: 10, G: 4, H: 1 };
  const total = Object.values(players).reduce((a, n) => a + n, 0);   // 1000
  const { visible, collapsed } = halves(bars(players, total, 0));

  // Everything at or above 1% — F is exactly ten in a thousand, so it stays.
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
    assert.match(visible, new RegExp(`>${name}<`), `${name} is at or above 1% and must be visible`);
  }
  // Below the line, and therefore behind the expander rather than gone.
  for (const name of ['G', 'H']) {
    assert.doesNotMatch(visible, new RegExp(`>${name}<`), `${name} is under 1% and belongs in the tail`);
    assert.match(collapsed, new RegExp(`>${name}<`), `${name} must still be one click away`);
  }
});

test('the remainder says WHY those entries are hidden', () => {
  const { bars } = load();
  const players = { A: 900, B: 50, C: 9, D: 8, E: 7 };
  const t = text(bars(players, 974, 0));
  assert.match(t, /each under 1%/,
    'it answers the question the row provokes: is there anything in there I should have seen?');
});

test('a station with three players shows three, and offers no expander', () => {
  const { bars } = load();
  const html = bars({ Chrome: 50, Safari: 30, VLC: 20 }, 100, 12);
  assert.equal((html.match(/deep-bar-row/g) || []).length, 3);
  assert.doesNotMatch(html, /deep-bar-rest/, 'nothing hidden means no control at all');
});

test('a pathological tail cannot fill the panel', () => {
  const { bars } = load();
  // Forty entries each at exactly 2.5% — all "significant", none droppable.
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`P${i}`] = 25;
  const { visible } = halves(bars(many, 1000, 0));
  const rows = (visible.match(/deep-bar-row/g) || []).length;
  assert.ok(rows <= 21, `a ceiling must apply; got ${rows} visible rows`);
  assert.match(visible, /deep-bar-rest/, 'and the overflow is still counted');
});

test('a numeric limit still guarantees a minimum, never a maximum', () => {
  const { bars } = load();
  // Only two clear 1%, but the platform list asks for six.
  const obj = { A: 700, B: 200, C: 30, D: 25, E: 20, F: 15, G: 10 };
  const { visible } = halves(bars(obj, 1000, 6));
  assert.equal((visible.match(/deep-bar-row/g) || []).length, 7, 'six rows plus the remainder');
});

test('the remainder is muted, because it is not a category', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/listeners.css'), 'utf8');
  assert.match(css, /\.deep-bar-rest/, 'it must be styled apart from a real row');
});

/** The declarations inside the rule whose selector list mentions `sel`. */
function ruleFor(css, sel) {
  const at = css.indexOf(sel);
  assert.notEqual(at, -1, `no rule for ${sel}`);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

test('MUTED IS NOT INVISIBLE: the remainder rows stay readable', () => {
  /* The class of bug. Both remainder summaries were drawn in --text-tertiary
     (#606078 on a near-black panel) AND italicised, which is how a row that
     exists to say "something was left out" became a row nobody could read —
     and, for the bar list, a control nobody could tell was one. Muting the
     remainder is right; muting it below legibility reinstates the original
     bug. Any future remainder row is covered by the same assertion. */
  const css = fs.readFileSync(path.join(__dirname, '../public/listeners.css'), 'utf8');
  for (const sel of ['.deep-bar-rest .deep-bar-label', '.rh-rest .rh-name']) {
    const rule = ruleFor(css, sel);
    assert.doesNotMatch(rule, /--text-tertiary/, `${sel} must not be the faintest token`);
    assert.doesNotMatch(rule, /font-style:\s*italic/, `${sel} must not be italicised as well`);
  }
});

test('the expander LOOKS like one — the row carries a click affordance', () => {
  // Nothing but the caret said "clickable", and a caret alone did not read as
  // one. The label is underlined so the row is recognisable as a control.
  const css = fs.readFileSync(path.join(__dirname, '../public/listeners.css'), 'utf8');
  const rule = ruleFor(css, '.deep-bar-rest.is-toggle .deep-bar-label');
  assert.match(rule, /text-decoration/, 'the toggle must be visibly a toggle');
  assert.match(css, /\.deep-bar-rest\.is-toggle\s*\{[^}]*cursor:\s*pointer/);
});

test('moreRow renders nothing when nothing is hidden', () => {
  const { moreRow } = load();
  assert.equal(moreRow(0, 0, 100), '');
  assert.equal(moreRow(-1, 0, 100), '');
});

test('a zero total does not produce NaN percentages', () => {
  const { moreRow, bars } = load();
  assert.doesNotMatch(moreRow(3, 0, 0), /NaN/);
  assert.doesNotMatch(bars({ A: 0, B: 0 }, 0, 1), /NaN/);
});

test('an empty set still says "No data" rather than an empty frame', () => {
  const { bars } = load();
  assert.match(bars({}, 100, 9), /No data/);
  assert.match(bars(null, 100, 9), /No data/);
});

/* ── The same mechanism, everywhere it is used ──────────────────────────── */

test('every ranked list on the page reports its remainder', () => {
  /* Four lists truncate: players, platforms, metros and countries all go
     through bars() or moreRow(). Named here so a fifth added later is caught by
     a failing count rather than by a reader noticing an entry missing. */
  const uses = (src.match(/moreRow\(/g) || []).length;
  assert.ok(uses >= 4, `expected every truncating list to call moreRow, found ${uses} call(s)`);
  assert.ok(src.includes('function moreRow('), 'one helper, not four spellings');
});
