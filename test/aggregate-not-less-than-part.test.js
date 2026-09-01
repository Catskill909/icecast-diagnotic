/* ═══════════════════════════════════════════════════════════════════════════
   An aggregate is never smaller than one of its parts

   "All stations · This month: 805" sat on screen beside "KPFT Houston · This
   month: 10,560". One station reported thirteen times the network it belongs to.

   Neither number was miscomputed. Each was measured over a DIFFERENT CALENDAR.
   The per-station page used the station's own timezone; the all-stations page
   fell back to UTC whenever the scope spanned more than one. At 00:38 UTC on the
   1st, Houston was three weeks into its month and UTC was thirty-eight minutes
   into its own — so "this month" for the network meant thirty-eight minutes,
   presented next to a real month.

   THE CAUSE IS NOW GONE RATHER THAN CORRECTED. These windows are rolling: they
   end at `now` and count backwards, so the last 30 days is the same 30 days in
   Houston, New York and Los Angeles. There is no longer a per-station boundary
   for two scopes to disagree about, and the invariant holds by construction.

   These cases keep it that way. They still place `now` just past UTC midnight on
   the 1st — the moment the calendars disagreed most and the only moment the old
   bug was visible — because a fixture at 3pm Houston time would prove nothing
   about the thing that actually broke.
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
// 00:38 UTC on 1 September — still 19:38 on 31 August in Houston. Under the old
// calendar windows the UTC month was 38 minutes old and the Houston month was
// three weeks old. Under rolling windows both are the same 30 days.
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

test('the network total is never below a member station, on any window', () => {
  // Three weeks of audience, spanning the moment the calendars used to disagree.
  const houston = bigChannel();
  const newYork = smallChannel();

  const groups = [
    { streamIds: [houston], timeZone: 'America/Chicago' },
    { streamIds: [newYork], timeZone: 'America/New_York' },
  ];

  const all = store.getListenerCountsAcross(groups, NOW);
  const kpft = store.getListenerCounts([houston], 'America/Chicago', NOW);
  const wpfw = store.getListenerCounts([newYork], 'America/New_York', NOW);

  for (const window of ['day', 'week', 'month']) {
    for (const [name, part] of [['Houston', kpft], ['New York', wpfw]]) {
      assert.ok(
        all[window].totalListeners >= part[window].totalListeners,
        `${window}: network total ${all[window].totalListeners} is below ${name}'s `
        + `${part[window].totalListeners} — a total cannot be less than a part`,
      );
      // "At once" is a claim about one instant, so it does not sum — but the
      // network's busiest moment still cannot be quieter than one member's.
      assert.ok(
        all[window].peak >= part[window].peak,
        `${window}: network peak ${all[window].peak} is below ${name}'s ${part[window].peak}`,
      );
    }
  }
});

test('reach adds up across stations rather than being measured on one clock', () => {
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
    'every station is measured over the same 30 days, and arrivals sum',
  );
});

test('the window no longer depends on which clock is named', () => {
  // What the old bug REQUIRED in order to exist: a period that starts at a
  // different instant in every timezone. Remove that and it cannot come back —
  // so this asserts the absence of the boundary rather than a correction to it.
  const houston = bigChannel();
  const newYork = smallChannel();

  const asUtc = store.getListenerCounts([houston, newYork], 'UTC', NOW);
  const asChicago = store.getListenerCounts([houston, newYork], 'America/Chicago', NOW);
  const kpft = store.getListenerCounts([houston], 'America/Chicago', NOW);

  assert.equal(
    asUtc.month.totalListeners,
    asChicago.month.totalListeners,
    'the same streams over the same span, whatever zone is named',
  );
  // The old single-clock rollup returned LESS than one of its own members here.
  assert.ok(
    asUtc.month.totalListeners >= kpft.month.totalListeners,
    'and the pair is never below one of its members',
  );

  const across = store.getListenerCountsAcross([
    { streamIds: [houston], timeZone: 'America/Chicago' },
    { streamIds: [newYork], timeZone: 'America/New_York' },
  ], NOW);
  assert.equal(
    across.month.totalListeners,
    asUtc.month.totalListeners,
    'and grouping the same streams by station changes nothing either',
  );
});

test('a scope on one clock still names it; a mixed scope refuses to', () => {
  // The zone no longer bounds these windows, but it still names the clock the
  // chart below them is drawn on, so the same honesty rule applies.
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
  assert.equal(mixed.timeZone, null, 'no single clock may be claimed');
  assert.deepEqual(mixed.timeZones.sort(), ['America/Chicago', 'America/New_York']);
});
