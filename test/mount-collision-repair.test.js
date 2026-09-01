/* ═══════════════════════════════════════════════════════════════════════════
   A mount's listeners belong to its own server

   Until 2026-08-29T17:09Z the host inventory was keyed by mount PATH alone.
   Three paths exist on more than one monitored host, so for a channel on the
   losing host every stored `listeners` reading was a different server's
   audience. WBAI's /wpfw_128 relay really carries about 2 listeners; it was
   recorded holding ~780 — Pacifica's WPFW audience, counted a second time
   under WBAI's name — and the all-station peak read 1,951 instead of 1,335.

   Keying by host+path closed the fault. It did not touch what had already been
   written, and the store keeps raw samples for a week, so the wrong figures
   went on being served long after the code was right.

   THE INVARIANT, and why it is not "19 samples are null": a contaminated
   reading must stop reaching EVERY aggregate — station peak, average, tune-ins
   — while the uptime record it shares a sample with survives untouched. The
   probe connected to the right URL; only the count came from the wrong mount.
   Asserting the null alone would pass against a repair that erased the sample
   whole and quietly destroyed the outage history with it.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SEED_FILE = '/nonexistent';
process.env.SAMPLE_RETENTION_DAYS = '7';

// The window the repair carries, and the channel it names.
const VICTIM = 'wbai-wpfw';
const CUTOFF = Date.parse('2026-08-29T17:11:00.000Z');
const MIN = 60e3;

/** A sample in the shape the monitor writes, uptime fields and all. */
const sample = (t, listeners, extra = {}) => ({
  timestamp: new Date(t).toISOString(),
  status: 'up',
  listeners,
  mountListeners: { '/wpfw_128': listeners },
  responseTime: 120,
  isSilent: false,
  ...extra,
});

/**
 * Production's shape: the losing channel reads the winner's audience until the
 * fix restarts the process, then its own. The winning channel is included
 * because a repair that swept by mount path would wreck its correct history.
 */
function writeFixture() {
  const contaminated = [];
  for (let i = 19; i >= 1; i--) contaminated.push(sample(CUTOFF - i * MIN, 780));
  const clean = [];
  for (let i = 0; i < 20; i++) clean.push(sample(CUTOFF + i * MIN, 2));

  const winner = [];
  for (let i = 19; i >= 1; i--) winner.push(sample(CUTOFF - i * MIN, 800));
  for (let i = 0; i < 20; i++) winner.push(sample(CUTOFF + i * MIN, 800));

  fs.writeFileSync(path.join(DATA_DIR, 'samples.json'), JSON.stringify({
    samples: { [VICTIM]: [...contaminated, ...clean], wpfw: winner },
    rollups: {
      // An hour that merely touches the window: its average was taken over
      // poisoned and clean readings together and cannot be unmixed.
      [VICTIM]: [{
        hour: '2026-08-29T16:00:00.000Z',
        checks: 60, up: 60, down: 0,
        avgListeners: 777, peakListeners: 782, listenerCount: 60, tuneIns: 777,
      }],
    },
  }));

  fs.writeFileSync(path.join(DATA_DIR, 'events.json'), JSON.stringify({ events: [] }));
}

writeFixture();
const store = require('../store');
store.load([VICTIM, 'wpfw']);

test('the contaminated readings stop counting, and the uptime record survives', () => {
  const all = store.getAllSamples()[VICTIM];
  const before = all.filter((s) => Date.parse(s.timestamp) < CUTOFF);
  const after = all.filter((s) => Date.parse(s.timestamp) >= CUTOFF);

  assert.equal(before.length, 19, 'the contaminated samples are kept, not deleted');
  for (const s of before) {
    assert.equal(s.listeners, null, 'another server\'s count must not survive as a number');
    assert.equal(s.mountListeners, undefined, 'nor as a per-mount breakdown');
    // The probe reached the right URL. Erasing this would turn a data repair
    // into a fabricated outage.
    assert.equal(s.status, 'up');
    assert.equal(s.responseTime, 120);
  }

  assert.equal(after.length, 20);
  for (const s of after) assert.equal(s.listeners, 2, 'readings after the fix are correct and stay');
});

test('the channel that read its own mount is untouched', () => {
  for (const s of store.getAllSamples().wpfw) {
    assert.equal(s.listeners, 800, 'a sweep by mount path would have erased this');
  }
});

test('an hourly average that touches the window is cleared, not left averaged', () => {
  const [r] = store.getRollups(VICTIM);
  assert.equal(r.avgListeners, null);
  assert.equal(r.peakListeners, null);
  assert.equal(r.tuneIns, undefined, 'tune-ins derived from the wrong counts go too');
});

test('the phantom audience is gone from the station-wide peak', () => {
  const from = CUTOFF - 30 * MIN;
  const to = CUTOFF + 30 * MIN;
  const both = store.concurrentBetween([VICTIM, 'wpfw'], from, to);

  // Before the repair the two channels summed to 1,580 at one instant; the 780
  // was Pacifica's audience wearing WBAI's name. Only 800 was ever there.
  assert.equal(both.peak, 802, `station peak still carries the phantom: ${both.peak}`);
  assert.ok(both.avg < 810, `station average still inflated: ${both.avg}`);
});

test('the phantom audience is gone from tune-ins', () => {
  const from = CUTOFF - 30 * MIN;
  const to = CUTOFF + 30 * MIN;
  const t = store.getTuneIns([VICTIM], from, to);

  // Everyone connected when the window opened counts once: that is 2, the
  // relay's real audience — not 780 from a mount we were never reading.
  assert.equal(t.total, 2, `tune-ins still carry the phantom arrival: ${t.total}`);
});

test('the repair runs once and cannot erase counts recorded after it', () => {
  assert.ok(store.getMeta('mountCollisionRepaired'), 'the marker is set');

  store.saveEvents();
  store.saveSamples();

  // A reading written into the window AFTER the repair has run is real data —
  // a re-import, a backfill — and a migration that fired twice would eat it.
  const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'samples.json')));
  persisted.samples[VICTIM].unshift(sample(CUTOFF - 5 * MIN, 42));
  fs.writeFileSync(path.join(DATA_DIR, 'samples.json'), JSON.stringify(persisted));

  delete require.cache[require.resolve('../store')];
  const reloaded = require('../store');
  reloaded.load([VICTIM, 'wpfw']);

  const survivor = reloaded.getAllSamples()[VICTIM]
    .find((s) => Date.parse(s.timestamp) === CUTOFF - 5 * MIN && s.listeners === 42);
  assert.ok(survivor, 'the guarded migration re-ran and erased data recorded after the fix');
});
