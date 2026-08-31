/* ═══════════════════════════════════════════════════════════════════════════
   Tune-ins survive compaction unchanged

   Raw samples carry churn; an hourly average cannot show that forty listeners
   left as forty arrived. So each hour's tune-ins are computed from the raw
   samples and frozen onto its rollup when they compact — and once the samples
   are gone that figure is all there is.

   IT WAS WRONG BY ROUGHLY 60x, AND FOR TWO MONTHS NOBODY COULD SEE IT.

   prune() runs every check cycle, so samples expire a handful at a time —
   usually one. The first sample of each batch was treated as "everyone already
   connected" and its whole listener count added. Once per period that is right.
   Once per MINUTE it stops being tune-ins altogether and becomes the sum of
   every reading, which is listener-minutes wearing the wrong name.

   Measured on production: one KPFT Main hour with avgListeners=50, peak=57 and
   60 checks carried tuneIns=2956 — 2,956 arrivals on a channel that never held
   more than 57 people, and almost exactly 50 x 60.

   THE INVARIANT: compacting in N batches must give the same answer as compacting
   in one. Every case here drives prune() the way production does — repeatedly,
   a sample at a time — because a single-batch test passes against the bug.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tunein-'));
process.env.SEED_FILE = '/nonexistent';
process.env.SAMPLE_RETENTION_DAYS = '7';

const store = require('../store');

let n = 0;
/** A fresh stream id per case, so nothing leaks between tests. */
const freshId = () => `s${++n}`;

const HOUR = 3600e3;
const MIN = 60e3;

/** A steady audience: nobody arrives or leaves after the first reading. */
function steady(count, minutes, startMs) {
  return Array.from({ length: minutes }, (_, i) => ({
    timestamp: new Date(startMs + i * MIN).toISOString(),
    status: 'up',
    listeners: count,
  }));
}

/**
 * Compacts the way production does: add a sample, prune, repeat.
 *
 * This is the whole point. prune() runs every check cycle, so it almost always
 * sees a single expiring sample — and a test that hands it the whole hour at
 * once passes against the bug.
 */
function compactOneAtATime(streamId, samples) {
  for (const s of samples) {
    store.addSample(streamId, s);
    store.prune();
  }
}

const tuneInTotal = (id) => store.getRollups(id).reduce((sum, r) => sum + (r.tuneIns || 0), 0);

test('a steady audience produces ONE tune-in count, not one per reading', () => {
  // 40 people connected, nobody joins or leaves, for a full hour. The honest
  // answer is 40 — they were all listening. The bug answered 40 x 60 = 2400.
  const start = Date.now() - 30 * 24 * HOUR;
  const id = freshId();
  compactOneAtATime(id, steady(40, 60, start));
  const total = tuneInTotal(id);

  assert.equal(total, 40,
    `a steady 40-listener hour must record 40 tune-ins, not ${total}`);
});

test('the total is nowhere near the sum of the readings', () => {
  // The signature of the bug, stated as its own assertion: the stored figure
  // must not be listener-minutes. 60 readings of 50 listeners summed is 3000.
  const start = Date.now() - 30 * 24 * HOUR;
  const id = freshId();
  compactOneAtATime(id, steady(50, 60, start));
  const total = tuneInTotal(id);
  assert.ok(total < 3000 / 10,
    `tuneIns=${total} is listener-minutes (${50 * 60}), not arrivals`);
});

test('real arrivals ARE counted', () => {
  // Not a test that the number is small — a test that it is right. Ten
  // listeners at the start, then one more arriving every minute for ten
  // minutes, is twenty.
  const start = Date.now() - 30 * 24 * HOUR;
  const id = freshId();
  compactOneAtATime(id, Array.from({ length: 11 }, (_, i) => ({
    timestamp: new Date(start + i * MIN).toISOString(),
    status: 'up',
    listeners: 10 + i,
  })));
  assert.equal(tuneInTotal(id), 20, 'ten already listening plus ten arrivals');
});

test('churn is counted, and departures are not', () => {
  // Forty leave and forty arrive across the hour. An hourly average cannot see
  // this at all — it is the entire reason the figure is frozen at compaction.
  const start = Date.now() - 30 * 24 * HOUR;
  const id = freshId();
  compactOneAtATime(id, [40, 40, 20, 20, 40, 40, 10, 10, 50, 50].map((v, i) => ({
    timestamp: new Date(start + i * MIN).toISOString(),
    status: 'up',
    listeners: v,
  })));
  // 40 present, then +20 (20->40), then +40 (10->50) = 100.
  assert.equal(tuneInTotal(id), 100);
});

test('compacting one at a time equals compacting all at once', () => {
  // The invariant, directly. Batch size is an accident of when prune() happens
  // to run; it must never change the answer.
  const start = Date.now() - 30 * 24 * HOUR;
  const data = [12, 15, 15, 11, 30, 30, 28, 44].map((v, i) => ({
    timestamp: new Date(start + i * MIN).toISOString(),
    status: 'up',
    listeners: v,
  }));

  const a = freshId();
  compactOneAtATime(a, data);
  const oneAtATime = tuneInTotal(a);

  const b = freshId();
  for (const s of data) store.addSample(b, s);
  store.prune();
  const allAtOnce = tuneInTotal(b);

  assert.equal(oneAtATime, allAtOnce,
    `${oneAtATime} in single-sample batches vs ${allAtOnce} in one batch`);
});

test('a long gap is not read as everyone arriving at once', () => {
  // The monitor was down for an hour. The audience on its return did not all
  // tune in at that instant, and counting them as arrivals would invent a surge.
  const start = Date.now() - 30 * 24 * HOUR;
  const id = freshId();
  compactOneAtATime(id, [
    { timestamp: new Date(start).toISOString(), status: 'up', listeners: 30 },
    { timestamp: new Date(start + 90 * MIN).toISOString(), status: 'up', listeners: 80 },
  ]);
  assert.equal(tuneInTotal(id), 30, 'the 80 after the gap contribute nothing');
});
