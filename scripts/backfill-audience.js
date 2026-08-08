#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   BACKFILL AUDIENCE IMPACT ONTO HISTORICAL EVENTS

   Events are permanent; raw samples are not. Once samples older than
   SAMPLE_RETENTION_DAYS compact into hourly rollups, the per-minute audience
   reading that sat immediately before an outage is gone for good — and with it
   any chance of saying how many listeners that specific outage actually cost.

   The monitor now stamps this at resolution time, but events recorded before
   that change carry no `audience` block. This script fills them in from the
   raw samples that are still on disk, and is safe to run repeatedly: events
   that already have a measured figure are left alone.

     node scripts/backfill-audience.js           # report only, writes nothing
     node scripts/backfill-audience.js --apply   # write the results

   Run it against the live data directory:
     DATA_DIR=/app/data node scripts/backfill-audience.js --apply
   ═══════════════════════════════════════════════════════════════════════════ */

const store = require('../store');

const APPLY = process.argv.includes('--apply');

function main() {
  const streamIds = ['kpft-main', 'kpft-hd2', 'kpft-hd3'];
  store.load(streamIds);

  const events = store.getEvents({ limit: Number.MAX_SAFE_INTEGER }).events || [];
  const failures = events.filter((e) => e.type !== 'up' && e.durationMs);

  console.log(`Scanned ${events.length} events — ${failures.length} resolved failures.\n`);

  let filled = 0;
  let upgraded = 0;
  let skipped = 0;
  let totalLost = 0;

  for (const e of failures) {
    const existing = e.audience;
    // Never overwrite a measured figure — the live monitor captured it with
    // better data than we can reconstruct here.
    if (existing && existing.confidence === 'measured') {
      skipped++;
      if (existing.listenerMinutesLost) totalLost += existing.listenerMinutesLost;
      continue;
    }

    const audience = store.buildAudienceImpact(e.streamId, e.timestamp, e.durationMs);
    if (audience.confidence === 'unknown') {
      skipped++;
      continue;
    }

    if (existing) upgraded++;
    else filled++;
    if (audience.listenerMinutesLost) totalLost += audience.listenerMinutesLost;

    const tag = audience.confidence === 'measured' ? 'MEASURED' : 'modelled';
    console.log(
      `  ${e.timestamp}  ${String(e.streamName).padEnd(10)} ${String(e.durationLabel).padEnd(7)}` +
      `  ~${String(audience.listenersBefore).padStart(4)} listeners` +
      `  ${String(audience.listenerMinutesLost).padStart(5)} listener-min  [${tag}]`,
    );

    if (APPLY) store.updateEvent(e.id, { audience });
  }

  console.log(
    `\n${filled} event(s) filled, ${upgraded} upgraded, ${skipped} skipped.` +
    `\nTotal listener-minutes lost across all resolved failures: ${totalLost.toLocaleString()}` +
    ` (${(totalLost / 60).toFixed(1)} listener-hours)`,
  );

  if (APPLY) {
    store.saveEvents();
    console.log('\nWritten to disk.');
  } else {
    console.log('\nDry run — nothing written. Re-run with --apply to save.');
  }
}

main();
