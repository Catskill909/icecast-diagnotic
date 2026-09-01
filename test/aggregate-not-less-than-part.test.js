/* ═══════════════════════════════════════════════════════════════════════════
   An aggregate is never smaller than one of its parts

   "All stations · This month: 805" sat on screen beside "KPFT Houston · This
   month: 10,560". One station reported thirteen times the network it belongs
   to.

   Neither number was miscomputed. Each was measured over a DIFFERENT CALENDAR.
   The per-station page uses the station's own timezone; the all-stations page
   fell back to UTC whenever the scope spanned more than one. At 00:38 UTC on
   the 1st, Houston was three weeks into its month and UTC was thirty-eight
   minutes into its own — so "this month" for the network meant thirty-eight
   minutes, presented next to a real month.

   THE INVARIANT: for every period, the aggregate's reach must be at least the
   reach of any station inside it. That is what "total" means, and it holds only
   if each station's window is bounded on its own clock and the totals summed.

   The cases below place `now` at a moment where the calendars genuinely
   disagree — just past UTC midnight on the 1st — because that is the only time
   the bug is visible. At 3pm Houston time every clock agrees and a test proves
   nothing.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aggregate-'));
process.env.SEED_FILE = '/nonexistent';
process.env.SAMPLE_RETENTION_DAYS = '30';

const store = require('../store');

const MIN = 60e3;
// 00:38 UTC on 1 September — still 19:38 on 31 August in Houston. The UTC month
// is 38 minutes old; the Houston month is three weeks old.
const NOW = Date.parse('2026-09-01T00:38:00.000Z');

let n = 0;
const freshId = () => `s${++n}`;

/**
 * A channel whose audience TURNS OVER for `minutes` before NOW.
 *
 * The churn is the point. A steady audience yields the same reach whether it is
 * measured over thirty-eight minutes or three weeks — everyone connected when
 * the window opened counts once and nobody else arrives — so a flat fixture
 * hides exactly the bug under test. Arrivals must accumulate with the length of
 * the window, as a real audience's do.
 *
 * Sampled every four minutes: getTuneIns() discards a rise across a gap wider
 * than five, so anything sparser would be read as monitoring downtime instead
 * of churn.
 */
function audience(id, low, peak, minutes) {
  for (let i = Math.floor(minutes / 4); i >= 1; i--) {
    store.addSample(id, {
      timestamp: new Date(NOW - i * 4 * MIN).toISOString(),
      status: 'up',
      listeners: i % 2 === 0 ? low : peak,
      responseTime: 100,
    });
  }
  return id;
}

/** Houston-sized and New-York-sized audiences, three weeks deep. */
const bigChannel = () => audience(freshId(), 20, 60, 21 * 24 * 60);
const smallChannel = () => audience(freshId(), 5, 15, 21 * 24 * 60);

test('the network total is never below a member station, on any period', () => {
  // Three weeks of audience, so the Houston month is substantial and the UTC
  // month is a rounding error.
  const houston = bigChannel();
  const newYork = smallChannel();

  const groups = [
    { streamIds: [houston], timeZone: 'America/Chicago' },
    { streamIds: [newYork], timeZone: 'America/New_York' },
  ];

  const all = store.getListenerCountsAcross(groups, NOW);
  const kpft = store.getListenerCounts([houston], 'America/Chicago', NOW);
  const wpfw = store.getListenerCounts([newYork], 'America/New_York', NOW);

  for (const period of ['today', 'week', 'month']) {
    for (const [name, part] of [['Houston', kpft], ['New York', wpfw]]) {
      assert.ok(
        all[period].totalListeners >= part[period].totalListeners,
        `${period}: network total ${all[period].totalListeners} is below ${name}'s `
        + `${part[period].totalListeners} — a total cannot be less than a part`,
      );
      // "At once" is a claim about one instant, so it does not sum — but the
      // network's busiest moment still cannot be quieter than one member's.
      assert.ok(
        all[period].peak >= part[period].peak,
        `${period}: network peak ${all[period].peak} is below ${name}'s ${part[period].peak}`,
      );
    }
  }
});

test('reach adds up across clocks rather than being measured on one', () => {
  const houston = bigChannel();
  const newYork = smallChannel();

  const all = store.getListenerCountsAcross([
    { streamIds: [houston], timeZone: 'America/Chicago' },
    { streamIds: [newYork], timeZone: 'America/New_York' },
  ], NOW);

  const kpft = store.getListenerCounts([houston], 'America/Chicago', NOW);
  const wpfw = store.getListenerCounts([newYork], 'America/New_York', NOW);

  assert.equal(
    all.month.totalListeners,
    kpft.month.totalListeners + wpfw.month.totalListeners,
    'each station contributes its OWN calendar month, and those sum',
  );
});

test('the old UTC rollup is what this replaces, and it really was smaller', () => {
  const houston = bigChannel();
  const newYork = smallChannel();

  // The previous behaviour, reproduced exactly: both stations forced onto UTC.
  const onOneClock = store.getListenerCounts([houston, newYork], 'UTC', NOW);
  const kpft = store.getListenerCounts([houston], 'America/Chicago', NOW);

  assert.ok(
    onOneClock.month.totalListeners < kpft.month.totalListeners,
    'the bug should reproduce under the old single-clock rollup',
  );

  const fixed = store.getListenerCountsAcross([
    { streamIds: [houston], timeZone: 'America/Chicago' },
    { streamIds: [newYork], timeZone: 'America/New_York' },
  ], NOW);
  assert.ok(fixed.month.totalListeners > onOneClock.month.totalListeners);
});

test('a scope on one clock still names it; a mixed scope refuses to', () => {
  const a = audience(freshId(), 5, 15, 120);
  const b = audience(freshId(), 5, 15, 120);

  const same = store.getListenerCountsAcross([
    { streamIds: [a], timeZone: 'America/Chicago' },
    { streamIds: [b], timeZone: 'America/Chicago' },
  ], NOW);
  assert.equal(same.timeZone, 'America/Chicago');

  const mixed = store.getListenerCountsAcross([
    { streamIds: [a], timeZone: 'America/Chicago' },
    { streamIds: [b], timeZone: 'America/New_York' },
  ], NOW);
  // Naming one station's midnight would misdescribe every other station's day.
  assert.equal(mixed.timeZone, null, 'no single clock may be claimed');
  assert.deepEqual(mixed.timeZones.sort(), ['America/Chicago', 'America/New_York']);
});
