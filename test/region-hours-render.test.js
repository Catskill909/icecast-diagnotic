/* ═══════════════════════════════════════════════════════════════════════════
   The daypart panel says when, and must not quietly say something else

   Two ways a heatmap like this misleads, both of which look fine on screen:

     · drawn on a SHARED scale, the home state fills every row and every other
       region renders as an empty strip — so the panel silently answers "who is
       biggest", which the map above already answers, and hides the question it
       exists for;
     · a peak hour is a claim. Reading it off an un-normalised row, or off the
       wrong index, produces a confident and specific wrong answer that a
       schedule could be built on.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/listeners.js'), 'utf8');
const start = src.indexOf('  const hourLabel = (h) =>');
const slice = src.slice(start, src.indexOf('  async function renderDeep(version) {', start));

function render(regionHours) {
  const ctx = {
    Date, Math, Object, Array, Number,
    window: { GeoMap: { STATE_NAMES: { TX: 'Texas', NY: 'New York' } } },
    esc: (x) => String(x == null ? '' : x),
    plural: (n, one, many) => `${n} ${n === 1 ? one : many}`,
  };
  ctx.GeoMap = ctx.window.GeoMap;
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx.regionHoursBlock({ regionHours });
}
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** A 24-hour curve peaking at `peak`. */
function curve(peak, height = 100) {
  const hours = new Array(24).fill(1);
  hours[peak] = height;
  return hours;
}
const region = (key, hours, total) => ({
  key,
  country: key.split(':')[0],
  region: key.split(':')[1] || null,
  hours,
  total: total ?? hours.reduce((a, n) => a + n, 0),
});

test('each region is shaded against its OWN peak, not the largest region', () => {
  const html = render({
    timeZone: 'America/Chicago',
    regions: [
      region('US:TX', curve(7, 1000)),
      // A hundredth of the size. On a shared scale this row would be blank.
      region('US:NY', curve(18, 10)),
    ],
  });
  const rows = html.split('rh-row').slice(2);   // drop the header row
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /step-5/, 'every region must reach full intensity at its own peak');
  }
});

test('the peak hour named is the region\'s actual busiest hour', () => {
  const html = render({
    timeZone: 'UTC',
    regions: [region('US:TX', curve(7)), region('US:NY', curve(18))],
  });
  const t = text(html);
  assert.match(t, /Texas .*peak 7a/);
  assert.match(t, /New York .*peak 6p/);
});

test('midnight and noon are named as such, not as 0 and 12', () => {
  assert.match(text(render({ timeZone: 'UTC', regions: [region('US:TX', curve(0))] })), /peak 12a/);
  assert.match(text(render({ timeZone: 'UTC', regions: [region('US:TX', curve(12))] })), /peak 12p/);
});

test('the station\'s zone is named, so the hours are not read as the reader\'s own', () => {
  const html = render({ timeZone: 'America/Los_Angeles', regions: [region('US:TX', curve(9))] });
  assert.match(text(html), /Los Angeles time/);
});

test('all-stations falls back to UTC and says so rather than picking a zone', () => {
  const html = render({ timeZone: 'UTC', regions: [region('US:TX', curve(9))] });
  assert.match(text(html), /UTC time/);
});

test('a non-US region is labelled by country, with no invented state', () => {
  const html = render({ timeZone: 'UTC', regions: [region('GB:', curve(20))] });
  assert.match(text(html), /GB/);
  assert.doesNotMatch(text(html), /undefined/);
});

test('an unrecognised state code is shown as the code, not as blank', () => {
  const html = render({ timeZone: 'UTC', regions: [region('US:ZZ', curve(3))] });
  assert.match(text(html), /ZZ/);
});

test('nothing recorded says why, and does not draw an empty grid', () => {
  for (const empty of [null, undefined, { regions: [] }]) {
    const t = text(render(empty));
    assert.match(t, /No hour-of-day record/);
    assert.match(t, /cannot be filled in backwards/);
  }
});

test('it states that this measures when listening happens, not how many people', () => {
  const html = render({ timeZone: 'UTC', regions: [region('US:TX', curve(7))] });
  assert.match(text(html), /not a count of people/);
});

test('at most eight regions are drawn, so the panel stays readable', () => {
  const many = Array.from({ length: 20 }, (_, i) => region(`US:R${i}`, curve(i % 24)));
  const html = render({ timeZone: 'UTC', regions: many });
  const rows = html.split('rh-row').length - 1;
  assert.equal(rows, 9, 'eight regions plus the header');
});

test('a region with a flat curve still renders and names one hour', () => {
  const flat = new Array(24).fill(5);
  const t = text(render({ timeZone: 'UTC', regions: [region('US:TX', flat)] }));
  assert.match(t, /peak 12a/, 'the first of equal maxima, not a crash');
});

test('an all-zero row does not divide by zero or claim a peak intensity', () => {
  const zero = new Array(24).fill(0);
  const html = render({ timeZone: 'UTC', regions: [region('US:TX', zero, 0)] });
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /step-5/, 'no hour stands out when nothing was recorded');
});
