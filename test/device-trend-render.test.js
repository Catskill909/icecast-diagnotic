/* ═══════════════════════════════════════════════════════════════════════════
   The trend block renders what the data says, and nothing it does not

   This panel makes a CLAIM in words — "smart speakers went from 8% to 22%" —
   and a claim is worth testing in a way a chart alone is not. The three ways it
   could lie, all of them plausible-looking:

     · counting the period still in progress, so the last column falls off a
       cliff and the headline reports a collapse that has not happened;
     · drawing a trend from two points, which is not a trend;
     · leading with the BIGGEST category rather than the one that MOVED, which
       reports "phone apps are 61% of listeners" every week for ever.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/listeners.js'), 'utf8');
const start = src.indexOf('  const KIND_LABELS = {');
const slice = src.slice(start, src.indexOf('  async function renderDeep(version) {', start));

function render(trend) {
  const ctx = {
    Date, Math, Object, Array, Number, JSON,
    esc: (x) => String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    plural: (n, one, many) => `${n} ${n === 1 ? one : many}`,
  };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx.trendBlock({ trend });
}

/* The rendered sentence, with markup and template indentation removed. Matching
   the raw HTML means a regex fails the moment a line wraps differently, which
   tests formatting rather than the claim being made. */
function text(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const bucket = (key, kinds, complete = true) => ({
  key, complete,
  start: `${key}T00:00:00.000Z`,
  devices: Object.values(kinds).reduce((a, n) => a + n, 0),
  kinds,
});

test('a period still running is excluded from the chart and the claim', () => {
  const html = render({
    granularity: 'day',
    buckets: [
      bucket('2026-09-01', { app: 50, 'smart-speaker': 50 }),
      bucket('2026-09-02', { app: 50, 'smart-speaker': 50 }),
      bucket('2026-09-03', { app: 50, 'smart-speaker': 50 }),
      // Today, two hours in: almost nobody has listened yet.
      bucket('2026-09-04', { app: 1 }, false),
    ],
  });
  assert.doesNotMatch(text(html), /Sep 4/, 'the unfinished period must not be drawn');
  assert.match(text(html), /held steady/, 'and must not be read as a collapse');
});

test('fewer than three finished periods says so instead of drawing a trend', () => {
  const html = render({
    granularity: 'day',
    buckets: [
      bucket('2026-09-01', { app: 10 }),
      bucket('2026-09-02', { app: 10 }),
    ],
  });
  assert.match(text(html), /Not enough finished days/);
  assert.doesNotMatch(html, /trend-cols/, 'two points is not a trend');
});

test('the headline names the kind that MOVED, not the biggest one', () => {
  const html = render({
    granularity: 'day',
    buckets: [
      // Phone apps dominate throughout and barely move. Speakers treble.
      bucket('2026-09-01', { app: 90, 'smart-speaker': 10 }),
      bucket('2026-09-02', { app: 80, 'smart-speaker': 20 }),
      bucket('2026-09-03', { app: 70, 'smart-speaker': 30 }),
    ],
  });
  assert.match(text(html), /Smart speaker/, 'the mover is the news');
  assert.match(text(html), /went from 10% to 30%/);
});

test('a steady mix is reported as steady rather than as a spurious move', () => {
  const html = render({
    granularity: 'day',
    buckets: [
      bucket('2026-09-01', { app: 60, 'smart-speaker': 40 }),
      bucket('2026-09-02', { app: 60, 'smart-speaker': 40 }),
      bucket('2026-09-03', { app: 60, 'smart-speaker': 40 }),
    ],
  });
  assert.match(text(html), /held steady/);
});

test('monthly granularity says why it is monthly', () => {
  const html = render({
    granularity: 'month',
    buckets: [
      bucket('2026-06-01', { app: 10 }),
      bucket('2026-07-01', { app: 10 }),
      bucket('2026-08-01', { app: 10 }),
    ],
  });
  assert.match(text(html), /kept by calendar month/, 'the reader is told why the bars got wider');
  assert.match(text(html), /Jun 2026/);
});

test('every column is drawn, one per finished period', () => {
  const html = render({
    granularity: 'day',
    buckets: ['01', '02', '03', '04'].map((d) => bucket(`2026-09-${d}`, { app: 5, tv: 5 })),
  });
  assert.equal((html.match(/class="trend-col"/g) || []).length, 4);
});

test('a kind with no listeners in a period draws no segment there', () => {
  const html = render({
    granularity: 'day',
    buckets: [
      bucket('2026-09-01', { app: 10 }),
      bucket('2026-09-02', { app: 10 }),
      bucket('2026-09-03', { app: 5, tv: 5 }),
    ],
  });
  // Three columns, but TV appears in only one of them.
  assert.equal((html.match(/kind-tv"/g) || []).length, 2, 'one segment plus one legend swatch');
});

test('an empty or absent trend renders nothing rather than an empty frame', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
  assert.match(text(render({ granularity: 'day', buckets: [] })), /Not enough finished/);
});

test('a bucket with no listeners does not divide by zero', () => {
  const html = render({
    granularity: 'day',
    buckets: [
      bucket('2026-09-01', { app: 10 }),
      { key: '2026-09-02', complete: true, start: '2026-09-02T00:00:00.000Z', devices: 0, kinds: {} },
      bucket('2026-09-03', { app: 10 }),
    ],
  });
  assert.doesNotMatch(text(html), /NaN/, 'an empty day is a real thing and must not poison the chart');
});
