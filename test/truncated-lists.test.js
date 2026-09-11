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

test('EXPANDING reveals the entry that was missing, rather than only counting it', () => {
  // The reported case: iOS app was tenth on a list of nine.
  const { bars } = load();
  const { visible, collapsed } = halves(bars(TEN_PLAYERS, TOTAL, 9));
  assert.doesNotMatch(visible, /iOS app/, 'still not in the default view — the list is a top N');
  assert.match(collapsed, /iOS app/, 'but one click away, not gone');
});

test('the expander is keyboard reachable and announces its state', () => {
  const { bars } = load();
  const html = bars(TEN_PLAYERS, TOTAL, 9);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-expanded="false"/, 'collapsed by default, and says so');
  assert.match(html, /aria-controls="bar-rest-/);
  assert.match(html, /<div class="deep-bar-hidden" id="bar-rest-[^"]+" hidden>/);
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

test('many hidden entries are summed into one row, not listed', () => {
  const { bars } = load();
  const many = {};
  for (let i = 0; i < 30; i += 1) many[`P${i}`] = 30 - i;
  const total = Object.values(many).reduce((a, n) => a + n, 0);
  const html = bars(many, total, 9);
  assert.equal((html.match(/deep-bar-rest/g) || []).length, 1, 'one remainder row');
  assert.match(text(html), /21 more/);
});

test('the remainder is muted, because it is not a category', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/listeners.css'), 'utf8');
  assert.match(css, /\.deep-bar-rest/, 'it must be styled apart from a real row');
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
