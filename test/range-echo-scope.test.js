/* ═══════════════════════════════════════════════════════════════════════════
   The range chip must only appear on sections the range actually governs

   THE CLASS THIS FILE EXISTS TO PREVENT: a panel reading one clock while the
   page labels it with another.

   The Audience page puts "Range for everything below" above eight sections and
   stamps each section title with the selected range. "Where They Listen" is the
   one that does not obey it: geography comes from the live Icecast snapshot,
   which reports who is connected THIS MOMENT and keeps no history — there is no
   stored region or country anywhere in device-store.js, so a 7-day map cannot
   exist. Stamped "Last 7 days", its ~77 current connections sat under a heading
   claiming a week, next to a 7-day peak of 1,060, and read as missing data.

   `syncRangeEcho` already skipped sections marked `data-live-section`. Nothing
   in the markup carried the attribute, so the guard never once ran.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'listeners.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'listeners.js'), 'utf8');

/* Sections whose figures come from the live snapshot rather than the selected
   range. Adding one here without marking the markup is what this file catches. */
const LIVE_ONLY = ['Where They Listen'];

/* The heading is the bare text between the icon span and whatever follows it —
   a help popover, a hint span, or the end of the line. Matching to the closing
   </div> instead would swallow the nested popover and its whole help body. */
function sectionTitles() {
  const out = [];
  const re = /<div class="section-title"([^>]*)>\s*<span class="material-symbols-outlined">[^<]*<\/span>\s*([^<]*)/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const text = m[2].replace(/\s+/g, ' ').trim();
    out.push({ attrs, text, live: /data-live-section/.test(attrs) });
  }
  return out;
}

test('every live-only section is marked, so the range chip skips it', () => {
  const titles = sectionTitles();
  assert.ok(titles.length >= 8, `expected the page's sections, found ${titles.length}`);

  for (const name of LIVE_ONLY) {
    const found = titles.find((t) => t.text.startsWith(name));
    assert.ok(found, `section "${name}" is missing from listeners.html`);
    assert.ok(
      found.live,
      `"${name}" reads the live snapshot but is not marked data-live-section, ` +
      'so it will be stamped with the selected range it does not obey',
    );
  }
});

test('range-governed sections are NOT marked, or the chip disappears everywhere', () => {
  const titles = sectionTitles();
  const marked = titles.filter((t) => t.live).map((t) => t.text);
  const expected = LIVE_ONLY.length;
  assert.equal(
    marked.length, expected,
    `exactly ${expected} section(s) should be live-only; marked: ${JSON.stringify(marked)}`,
  );
});

test('syncRangeEcho skips marked sections and labels the rest', () => {
  const loader = js.slice(js.indexOf('  function rangeLabelFor(d) {'), js.indexOf('  /* ── Boot'));

  const make = (text, live) => {
    const el = { text, children: [], attrs: live ? { 'data-live-section': '' } : {} };
    el.hasAttribute = (a) => a in el.attrs;
    el.querySelector = () => el.children[0] || null;
    el.appendChild = (c) => el.children.push(c);
    return el;
  };
  const governed = make('Audience Over Time', false);
  const liveOnly = make('Where They Listen', true);
  const bar = { compareDocumentPosition: () => 4 };   // everything is below it

  const ctx = {
    days: 7,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    document: {
      querySelector: (s) => (s === '.range-bar' ? bar : null),
      querySelectorAll: () => [governed, liveOnly],
      createElement: () => ({ className: '', textContent: '' }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(loader, ctx);
  ctx.syncRangeEcho();

  assert.equal(governed.children.length, 1, 'a range-governed section must get the chip');
  assert.equal(governed.children[0].textContent, 'Last 7 days');
  assert.equal(liveOnly.children.length, 0, 'a live-only section must NOT get the chip');
});

test('the geo panel names its own clock rather than relying on the heading', () => {
  /* Scoped to renderGeo. The phrase already appears elsewhere on the page, so a
     match against the whole file passes without the geo hint saying anything. */
  const start = js.indexOf('  async function renderGeo(d) {');
  assert.ok(start > -1, 'renderGeo not found');
  const body = js.slice(start, js.indexOf('  /* ── Range echo'));
  const hint = body.slice(body.indexOf('hint.textContent'));
  assert.match(
    hint, /connected right now/,
    'the geo hint must say which clock it reads, not only when it was read',
  );
});
