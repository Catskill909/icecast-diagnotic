/* ═══════════════════════════════════════════════════════════════════════════
   Fault sides are named for ROLES, not for one customer's stations

   `faultSplit` answers "which side of the handoff needs attention" — the single
   most useful field in the record, because it decides who gets called. Its two
   values were `kpft` and `pacifica`.

   Those are station names used as a generic enum. On production this reported
   **WBAI New York's outages with `side: 'kpft'`** — a New York station's faults
   filed under a Houston station's name, in the API and on the page.

   Every Icecast station has these two sides: its own source/feed path, and the
   server it hands off to. The vocabulary has to be `source` and `server`.

   THE RULE THIS PINS: station-specific vocabulary never becomes a wire format.
   An enum named after one customer is invisible until a second one exists, and
   expensive by then.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'faultside-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');

const HOUR = 3600e3;
const now = Date.now();

/** A resolved, listener-affecting outage on one stream. */
function outage(streamId, reachable, at) {
  return {
    timestamp: new Date(at).toISOString(),
    streamId,
    streamName: streamId,
    type: 'down',
    severity: 'outage',
    confirmed: true,
    resolvedAt: new Date(at + 10 * 60e3).toISOString(),
    durationMs: 10 * 60e3,
    diagnosis: { cause: 'source_disconnected', icecast: { reachable } },
    audience: { listenersBefore: 40, listenerImpact: 'confirmed', listenerMinutesLost: 400 },
  };
}

store.load();
store.addEvent(outage('wbai-verizon', true, now - 3 * HOUR));   // Icecast answered -> source side
store.addEvent(outage('wbai-spectrum', false, now - 2 * HOUR)); // Icecast unreachable -> server side

const sides = () =>
  store.getPeriodRollup(['wbai-verizon', 'wbai-spectrum'], 24 * HOUR).faultSplit.map((s) => s.side);

test('a station that is not KPFT is never labelled "kpft"', () => {
  // The exact production symptom: WBAI New York reporting side 'kpft'.
  const s = sides();
  assert.equal(s.includes('kpft'), false, `WBAI reported side "kpft": ${s.join(', ')}`);
  assert.equal(s.includes('pacifica'), false, `WBAI reported side "pacifica": ${s.join(', ')}`);
});

test('the sides are named for the roles every station has', () => {
  const s = sides();
  assert.ok(s.includes('source'), 'Icecast reachable, mount absent -> source');
  assert.ok(s.includes('server'), 'Icecast unreachable -> server');
});

test('reachability still decides which side, unchanged', () => {
  // The rename must not alter the classification, only its name.
  const split = store.getPeriodRollup(['wbai-verizon', 'wbai-spectrum'], 24 * HOUR).faultSplit;
  const bySide = Object.fromEntries(split.map((s) => [s.side, s]));
  assert.equal(bySide.source.streamRecords, 1);
  assert.equal(bySide.server.streamRecords, 1);
  assert.equal(bySide.source.listenersCutOff, 40);
});

test('no station name appears anywhere in the rollup as a category', () => {
  // Written against the CLASS: any future enum named after a customer fails here.
  const rollup = store.getPeriodRollup(['wbai-verizon', 'wbai-spectrum'], 24 * HOUR);
  const categories = JSON.stringify(rollup.faultSplit).toLowerCase();
  for (const name of ['kpft', 'pacifica', 'wpfw', 'kpfk', 'wbai']) {
    assert.equal(categories.includes(`"${name}"`), false,
      `"${name}" is a station name being used as a category value`);
  }
});
