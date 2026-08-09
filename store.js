/* ═══════════════════════════════════════════════════════════════════════════
   KPFT Icecast Monitor — Persistent Store
   ───────────────────────────────────────────────────────────────────────────
   Two independent files, on purpose:

     data/events.json   Every outage, recovery and dead-air event.
                        RETAINED FOREVER. Small (~400 bytes each) — a decade of
                        incidents is a few megabytes.

     data/samples.json  Per-check telemetry powering the uptime bars.
                        Raw samples kept SAMPLE_RETENTION_DAYS (default 7),
                        then compacted into hourly rollups kept forever.

   Splitting them means a large or corrupted sample file can never take the
   permanent incident record down with it. Both are written atomically
   (temp file + rename) so a crash mid-write cannot truncate them.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SAMPLES_FILE = path.join(DATA_DIR, 'samples.json');
const LEGACY_FILE = path.join(DATA_DIR, 'history.json');
// Optional one-time historical backfill, applied at most once per seedId.
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, 'seed', 'historical-events.json');

const SAMPLE_RETENTION_DAYS = parseInt(process.env.SAMPLE_RETENTION_DAYS, 10) || 7;
const SAMPLE_RETENTION_MS = SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Safety ceiling. Events are never pruned by age, but an unbounded array would
// eventually be a memory problem — at ~35 events/day this is roughly 8 years.
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS, 10) || 100000;

// Severities for a failure that never reached FAILURE_THRESHOLD. 'blip' is the
// retired name for both and still sits in stored history, so every count has to
// keep recognising it — events are permanent and are never rewritten.
const UNCONFIRMED_SEVERITIES = new Set(['brief_outage', 'probe_error', 'blip']);
const isUnconfirmedSeverity = (s) => UNCONFIRMED_SEVERITIES.has(s);

// ── State ───────────────────────────────────────────────────────────────────
let events = [];             // permanent incident record, oldest → newest
let samples = {};            // { [streamId]: [ sample ] }  raw, rolling window
let rollups = {};            // { [streamId]: [ hourlyRollup ] }  permanent
let streamStatusCache = {};  // last known status, for warm restarts
let appliedSeeds = [];       // seedIds already backfilled — guards against re-import
let dirtyEvents = false;
let dirtySamples = false;

// ── Utilities ───────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Write via temp file + rename so readers never observe a partial file. */
function atomicWrite(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[Store] Failed to read ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

let eventSeq = 0;
function makeEventId(timestamp, streamId) {
  eventSeq = (eventSeq + 1) % 100000;
  return `evt_${new Date(timestamp).getTime()}_${streamId}_${eventSeq}`;
}

function hourKey(ts) {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// ── Load ────────────────────────────────────────────────────────────────────
function load(streamIds) {
  streamIds.forEach((id) => {
    if (!samples[id]) samples[id] = [];
    if (!rollups[id]) rollups[id] = [];
  });

  const ev = readJson(EVENTS_FILE);
  if (ev) {
    events = Array.isArray(ev.events) ? ev.events : [];
    streamStatusCache = ev.streamStatus || {};
    appliedSeeds = Array.isArray(ev.appliedSeeds) ? ev.appliedSeeds : [];
    console.log(`[Store] Loaded ${events.length} permanent event(s)`);
  }

  const sm = readJson(SAMPLES_FILE);
  if (sm) {
    if (sm.samples) {
      for (const id of Object.keys(sm.samples)) {
        samples[id] = Array.isArray(sm.samples[id]) ? sm.samples[id] : [];
      }
    }
    if (sm.rollups) {
      for (const id of Object.keys(sm.rollups)) {
        rollups[id] = Array.isArray(sm.rollups[id]) ? sm.rollups[id] : [];
      }
    }
    const total = Object.values(samples).reduce((a, b) => a + b.length, 0);
    const rollTotal = Object.values(rollups).reduce((a, b) => a + b.length, 0);
    console.log(`[Store] Loaded ${total} raw sample(s), ${rollTotal} hourly rollup(s)`);
  }

  // One-time migration off the old combined history.json. Its incidents are
  // rescued into the permanent record rather than being lost to the old 24h
  // prune the next time it runs.
  if (!ev && !sm) {
    const legacy = readJson(LEGACY_FILE);
    if (legacy) {
      if (Array.isArray(legacy.incidents) && legacy.incidents.length) {
        events = legacy.incidents.map((inc) => ({
          id: makeEventId(inc.timestamp, inc.streamId || 'unknown'),
          timestamp: inc.timestamp,
          streamId: inc.streamId,
          streamName: inc.streamName,
          type: inc.type,
          severity: inc.type === 'down' ? 'outage' : 'recovery',
          confirmed: true,
          message: inc.message,
          migrated: true,
          diagnosis: null,
          email: { attempted: null, sent: null, reason: 'predates delivery tracking' },
        }));
        console.log(`[Store] Migrated ${events.length} incident(s) from legacy history.json`);
      }
      if (legacy.history) {
        for (const id of Object.keys(legacy.history)) {
          if (samples[id]) samples[id] = legacy.history[id];
        }
      }
      if (legacy.streamStatus) streamStatusCache = legacy.streamStatus;
      dirtyEvents = true;
      dirtySamples = true;
    }
  }

  applySeed();
  // Must run BEFORE prune(): compaction destroys the raw samples this reads.
  backfillAudience();
  prune();
}

/**
 * Fills the `audience` block on any resolved failure that predates it.
 *
 * Runs automatically at every startup rather than as a manual step, because the
 * data it needs is perishable: it can only be reconstructed from raw samples,
 * and those compact into hourly rollups after SAMPLE_RETENTION_DAYS. A backfill
 * that depends on someone remembering to open a terminal would silently miss
 * its window on any container that redeploys without one.
 *
 * Safe to run on every boot: events that already carry a measured figure are
 * skipped before any sample lookup, so a fully-populated history costs one
 * cheap property check per event and nothing more.
 */
function backfillAudience() {
  let filled = 0;
  let lost = 0;

  let corrected = 0;
  let relabelled = 0;

  for (const e of events) {
    if (e.type === 'up' || !e.durationMs) continue;

    const impact = deriveListenerImpact(e);

    // Skip only when the stored figure was measured AND still agrees with the
    // current verdict. Checking the verdict too lets a corrected rule repair
    // events written under the old one — a stored number that is wrong is worse
    // than a missing one, because it looks authoritative.
    const stored = e.audience;
    if (stored && stored.confidence === 'measured' && stored.listenerImpact === impact) continue;

    const audience = buildAudienceImpact(e.streamId, e.timestamp, e.durationMs, impact);
    if (audience.confidence === 'unknown') continue;

    if (stored) corrected++; else filled++;
    e.audience = audience;
    lost += audience.listenerMinutesLost || 0;

    // A brief outage that recovery has since cleared of listener impact is a
    // probe anomaly, and should say so. The severity was assigned mid-failure
    // on incomplete evidence; leaving it overstates a fault that cost nobody
    // anything. Legacy 'blip' events keep their retired label — rewriting the
    // name they were recorded under would be revisionist rather than corrective.
    if (e.severity === 'brief_outage' && impact === 'none') {
      e.severity = 'probe_error';
      relabelled++;
    }

    dirtyEvents = true;
  }

  if (filled || corrected) {
    console.log(
      `[Store] Audience impact: ${filled} filled, ${corrected} corrected` +
      (relabelled ? `, ${relabelled} relabelled as probe anomalies` : '') +
      ` — ${lost.toLocaleString()} listener-minutes touched`,
    );
    saveEvents();
  }
}

/**
 * One-time historical backfill. Restores events that predate this storage
 * layer — telemetry that was captured before the migration and would otherwise
 * be unrecoverable. Applied at most once per seedId, tracked in events.json, so
 * redeploys never duplicate it. Seeded events keep their `reconstructed: true`
 * flag so they are never mistaken for live observations.
 */
function applySeed() {
  const seed = readJson(SEED_FILE);
  if (!seed || !seed.seedId || !Array.isArray(seed.events)) return;

  if (appliedSeeds.includes(seed.seedId)) {
    console.log(`[Store] Seed '${seed.seedId}' already applied — skipping`);
    return;
  }

  const existing = new Set(events.map((e) => e.id));
  const added = seed.events.filter((e) => e && e.id && !existing.has(e.id));

  events.push(...added);
  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Raw telemetry drives every availability figure — uptime percentages and the
  // 24h bars read samples, not events. Restoring events without their samples
  // leaves an outage recorded in the log yet invisible to uptime, reporting a
  // reassuring 100% for a day that had real downtime.
  let samplesAdded = 0;
  if (seed.samples && typeof seed.samples === 'object') {
    for (const [streamId, arr] of Object.entries(seed.samples)) {
      if (!Array.isArray(arr)) continue;
      if (!samples[streamId]) samples[streamId] = [];
      const seen = new Set(samples[streamId].map((s) => s.timestamp));
      const fresh = arr.filter((s) => s && s.timestamp && !seen.has(s.timestamp));
      samples[streamId].push(...fresh);
      samples[streamId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      samplesAdded += fresh.length;
    }
    if (samplesAdded) dirtySamples = true;
  }

  // Corrections repair fields on events an earlier seed already backfilled —
  // alert delivery the previous build performed but never recorded, say. Only
  // events still flagged `reconstructed` are eligible, so a live observation
  // can never be rewritten by a seed file.
  let corrected = 0;
  if (Array.isArray(seed.corrections)) {
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const fix of seed.corrections) {
      if (!fix || !fix.id) continue;
      const target = byId.get(fix.id);
      if (!target || target.reconstructed !== true) continue;
      const { id, ...patch } = fix;
      Object.assign(target, patch);
      corrected++;
    }
  }

  appliedSeeds.push(seed.seedId);
  dirtyEvents = true;

  console.log(`[Store] Applied seed '${seed.seedId}': backfilled ${added.length} event(s), ${samplesAdded} sample(s), corrected ${corrected} event(s)`);
  if (added.length !== seed.events.length) {
    console.log(`[Store]   (${seed.events.length - added.length} event(s) already present, skipped)`);
  }
}

// ── Events (permanent) ──────────────────────────────────────────────────────
function addEvent(evt) {
  const event = {
    id: makeEventId(evt.timestamp, evt.streamId || 'all'),
    ...evt,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  dirtyEvents = true;
  return event;
}

function updateEvent(id, patch) {
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], ...patch };
  dirtyEvents = true;
  return events[idx];
}

/** Most recent unresolved 'down'-family event for a stream, if any. */
function findOpenOutage(streamId) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.streamId !== streamId) continue;
    if (e.type === 'up') return null;          // already recovered
    if (e.type === 'down' && !e.resolvedAt) return e;
    if (e.type === 'dead_air' && !e.resolvedAt) return e;
  }
  return null;
}

function getEvents(opts = {}) {
  const {
    streamId, type, severity, cause, scope,
    since, until, emailed, limit, offset = 0, order = 'desc',
  } = opts;

  let out = events;

  if (streamId) out = out.filter((e) => e.streamId === streamId);
  if (type) out = out.filter((e) => e.type === type);
  if (severity) out = out.filter((e) => e.severity === severity);
  if (cause) out = out.filter((e) => e.diagnosis?.cause === cause);
  if (scope) out = out.filter((e) => e.diagnosis?.scope === scope);
  if (emailed === true) out = out.filter((e) => e.email?.sent === true);
  if (emailed === false) out = out.filter((e) => e.email?.sent !== true);
  if (since) {
    const t = new Date(since).getTime();
    out = out.filter((e) => new Date(e.timestamp).getTime() >= t);
  }
  if (until) {
    const t = new Date(until).getTime();
    out = out.filter((e) => new Date(e.timestamp).getTime() <= t);
  }

  const total = out.length;
  out = [...out].sort((a, b) =>
    order === 'asc'
      ? new Date(a.timestamp) - new Date(b.timestamp)
      : new Date(b.timestamp) - new Date(a.timestamp),
  );

  if (offset) out = out.slice(offset);
  if (limit) out = out.slice(0, limit);

  return { events: out, total, offset, limit: limit || total };
}

// ── Samples (rolling) + Rollups (permanent) ─────────────────────────────────
function addSample(streamId, sample) {
  if (!samples[streamId]) samples[streamId] = [];
  samples[streamId].push(sample);
  dirtySamples = true;
}

function getSamples(streamId, sinceMs) {
  const arr = samples[streamId] || [];
  if (!sinceMs) return arr;
  const cutoff = Date.now() - sinceMs;
  return arr.filter((s) => new Date(s.timestamp).getTime() > cutoff);
}

function getAllSamples(sinceMs) {
  const out = {};
  for (const id of Object.keys(samples)) out[id] = getSamples(id, sinceMs);
  return out;
}

function getRollups(streamId) {
  return rollups[streamId] || [];
}

// ── Audience measurement ────────────────────────────────────────────────────
/**
 * Average listeners by hour of day (UTC), built from every retained source.
 *
 * Counts ONLY samples where the stream was up. During an outage Icecast reports
 * zero listeners — not because nobody was listening, but because the mount no
 * longer exists to have an audience. Averaging those zeros in would let the very
 * outages we are measuring drag down the baseline we measure them against.
 */
function getHourOfDayProfile(streamId) {
  const sum = new Array(24).fill(0);
  const count = new Array(24).fill(0);

  for (const s of samples[streamId] || []) {
    if (s.status !== 'up' || s.listeners == null) continue;
    const h = new Date(s.timestamp).getUTCHours();
    sum[h] += s.listeners;
    count[h]++;
  }

  for (const r of rollups[streamId] || []) {
    if (r.avgListeners == null) continue;
    const h = new Date(r.hour).getUTCHours();
    if (!isFinite(h)) continue;
    const n = r.listenerCount ?? r.up ?? r.checks ?? 1;
    sum[h] += r.avgListeners * n;
    count[h] += n;
  }

  return sum.map((v, h) => (count[h] ? v / count[h] : null));
}

/**
 * What the audience looked like immediately before a failure began.
 *
 * This is the one measurement that cannot be recovered later: Icecast only
 * reports listeners while the mount exists, and raw samples are compacted after
 * SAMPLE_RETENTION_DAYS. So it has to be captured at resolution time and frozen
 * onto the permanent event record.
 *
 *   confidence 'measured' → a real pre-outage sample was found
 *   confidence 'modelled' → estimated from this stream's hour-of-day profile
 *   confidence 'unknown'  → no basis at all
 */
function getAudienceContext(streamId, atIso, lookbackMs = 60 * 60 * 1000) {
  const at = new Date(atIso).getTime();
  if (!isFinite(at)) return { listenersBefore: null, peakBefore: null, confidence: 'unknown', basis: 'invalid timestamp' };

  // Samples are appended in chronological order, so walk backwards from the
  // failure instead of scanning the whole array. The answer is almost always
  // the immediately preceding check, which makes this O(1) in practice — and
  // that matters because the startup backfill calls this once per unmeasured
  // event, and a full scan per event would be quadratic on a long history.
  const arr = samples[streamId] || [];
  let idx = arr.length - 1;
  while (idx >= 0 && new Date(arr[idx].timestamp).getTime() >= at) idx--;

  let last = null;
  let peak = null;
  const peakFloor = at - lookbackMs;

  for (let i = idx; i >= 0; i--) {
    const s = arr[i];
    const t = new Date(s.timestamp).getTime();
    if (!isFinite(t)) continue;
    if (s.status === 'up' && s.listeners != null) {
      if (!last) last = s;
      if (t >= peakFloor) peak = peak == null ? s.listeners : Math.max(peak, s.listeners);
    }
    // Once we are past the peak window AND have the preceding reading, there is
    // nothing further back that can change the answer.
    if (t < peakFloor && last) break;
  }

  if (last) {
    return {
      listenersBefore: last.listeners,
      peakBefore: peak ?? last.listeners,
      confidence: 'measured',
      basis: `last healthy check at ${last.timestamp}`,
    };
  }

  const profile = getHourOfDayProfile(streamId);
  const hour = new Date(at).getUTCHours();
  if (profile[hour] != null) {
    return {
      listenersBefore: Math.round(profile[hour]),
      peakBefore: null,
      confidence: 'modelled',
      basis: `hour-of-day average for ${String(hour).padStart(2, '0')}:00 UTC`,
    };
  }

  return { listenersBefore: null, peakBefore: null, confidence: 'unknown', basis: 'no audience data retained' };
}

/**
 * Freezes the audience cost of one failure onto the event.
 *
 * Listener-minutes is the honest unit: it combines how many people were cut off
 * with how long they stayed cut off, which neither figure conveys alone.
 *
 * Crucially it is gated on `listenerImpact`. A probe anomaly — Icecast reachable,
 * mount still listed — cost nobody a second of audio, and multiplying the
 * audience by its duration would invent losses that never happened. Those events
 * still record what the audience WAS, for context, but their loss is zero.
 */
function buildAudienceImpact(streamId, startedAtIso, durationMs, listenerImpact) {
  const ctx = getAudienceContext(streamId, startedAtIso);
  const minutes = (durationMs || 0) / 60000;
  const harmless = listenerImpact === 'none';

  return {
    listenersBefore: ctx.listenersBefore,
    peakBefore: ctx.peakBefore,
    listenerMinutesLost: harmless
      ? 0
      : ctx.listenersBefore == null
      ? null
      : Math.round(ctx.listenersBefore * minutes),
    listenerImpact: listenerImpact ?? null,
    confidence: ctx.confidence,
    basis: harmless
      ? 'no loss charged — Icecast reachable and mount still serving'
      : ctx.basis,
  };
}

/**
 * Recovers the listener-impact verdict from a stored event.
 *
 * Events written before the verdict existed still carry the Icecast evidence it
 * was derived from, so it can be reconstructed rather than guessed. Mirrors
 * diagnose.assessListenerImpact() — note that `mountPresent` was recorded as
 * `false` by older builds when Icecast was simply unreachable, so reachability
 * is checked first.
 */
function deriveListenerImpact(event) {
  const d = event?.diagnosis;
  if (!d) return 'unknown';

  if (d.cause === 'dead_air') return 'confirmed';
  if (!d.cause) return 'none';

  const ice = d.icecast || {};

  // Direct observation first. When Icecast answered, its own mount inventory is
  // the last word — present means the audience kept listening, absent means the
  // mount could not serve anyone. Older builds recorded mountPresent as `false`
  // when they simply failed to reach Icecast, so reachability is checked first.
  if (ice.reachable) return ice.mountPresent ? 'none' : 'confirmed';

  // Icecast was unreachable, so the failure itself proves nothing either way —
  // but the recovery can settle it. `sourceOutage` is written only when Icecast
  // reports the source reconnecting DURING the episode. A resolved failure
  // without one means the source stayed connected throughout: the mount never
  // vanished and nobody lost audio. Our probe broke, not the stream.
  //
  // Without this, three 60-second probe resets were charged 55 listener-minutes
  // against an audience whose count never dipped.
  if (event.resolvedAt) return event.sourceOutage ? 'confirmed' : 'none';

  return 'unknown';
}

/**
 * Compacts raw samples older than the retention window into hourly rollups,
 * preserving uptime accuracy indefinitely at ~1/60th the storage cost.
 */
function prune() {
  const cutoff = Date.now() - SAMPLE_RETENTION_MS;

  for (const id of Object.keys(samples)) {
    const arr = samples[id] || [];
    const keep = [];
    const expire = [];

    for (const s of arr) {
      const t = new Date(s.timestamp).getTime();
      if (!isFinite(t)) continue;
      (t > cutoff ? keep : expire).push(s);
    }

    if (expire.length) {
      const buckets = new Map();
      for (const s of expire) {
        const key = hourKey(s.timestamp);
        if (!buckets.has(key)) {
          buckets.set(key, {
            hour: key, checks: 0, up: 0, down: 0, silent: 0,
            responseSum: 0, responseCount: 0, minResponse: null, maxResponse: null,
            listenerSum: 0, listenerCount: 0, listenerPeak: 0,
          });
        }
        const b = buckets.get(key);
        b.checks++;
        if (s.status === 'up') b.up++;
        else if (s.status === 'down') b.down++;
        if (s.isSilent) b.silent++;
        if (s.responseTime != null) {
          b.responseSum += s.responseTime;
          b.responseCount++;
          b.minResponse = b.minResponse == null ? s.responseTime : Math.min(b.minResponse, s.responseTime);
          b.maxResponse = b.maxResponse == null ? s.responseTime : Math.max(b.maxResponse, s.responseTime);
        }
        // Only count the audience while the stream was actually up. A down
        // sample reports zero listeners because the mount is gone, not because
        // nobody was listening — folding those zeros in would permanently
        // understate the baseline audience in exactly the hours we care about.
        if (s.status === 'up' && s.listeners != null) {
          b.listenerSum += s.listeners;
          b.listenerCount++;
          b.listenerPeak = Math.max(b.listenerPeak, s.listeners);
        }
      }

      const existing = new Map((rollups[id] || []).map((r) => [r.hour, r]));
      for (const [key, b] of buckets) {
        // Merge rather than overwrite, in case a prune already wrote this hour.
        const prevRoll = existing.get(key);
        // An average can only be merged against the count it was taken over.
        // Weighting a previous average by total `checks` while dividing by a
        // sample count skewed every hour that two prunes both touched, so the
        // counts are now stored alongside the averages and carried forward.
        // (`?? prevRoll.checks` keeps rollups written before this change usable.)
        const merged = prevRoll
          ? (() => {
              const prevRespN = prevRoll.responseCount ?? prevRoll.checks ?? 0;
              const prevListN = prevRoll.listenerCount ?? prevRoll.checks ?? 0;
              const respN = prevRespN + b.responseCount;
              const listN = prevListN + b.listenerCount;
              return {
                hour: key,
                checks: prevRoll.checks + b.checks,
                up: prevRoll.up + b.up,
                down: prevRoll.down + b.down,
                silent: prevRoll.silent + b.silent,
                responseCount: respN,
                avgResponse: respN
                  ? Math.round(((prevRoll.avgResponse || 0) * prevRespN + b.responseSum) / respN)
                  : null,
                minResponse: Math.min(prevRoll.minResponse ?? Infinity, b.minResponse ?? Infinity),
                maxResponse: Math.max(prevRoll.maxResponse ?? 0, b.maxResponse ?? 0),
                listenerCount: listN,
                avgListeners: listN
                  ? Math.round(((prevRoll.avgListeners || 0) * prevListN + b.listenerSum) / listN)
                  : null,
                listenerPeak: Math.max(prevRoll.listenerPeak || 0, b.listenerPeak),
              };
            })()
          : {
              hour: key,
              checks: b.checks,
              up: b.up,
              down: b.down,
              silent: b.silent,
              responseCount: b.responseCount,
              avgResponse: b.responseCount ? Math.round(b.responseSum / b.responseCount) : null,
              minResponse: b.minResponse,
              maxResponse: b.maxResponse,
              listenerCount: b.listenerCount,
              avgListeners: b.listenerCount ? Math.round(b.listenerSum / b.listenerCount) : null,
              listenerPeak: b.listenerPeak,
            };
        if (merged.minResponse === Infinity) merged.minResponse = null;
        existing.set(key, merged);
      }

      rollups[id] = [...existing.values()].sort((a, b) => a.hour.localeCompare(b.hour));
      samples[id] = keep;
      dirtySamples = true;
    }
  }
}

// ── Listener analytics ──────────────────────────────────────────────────────
/**
 * Picks a bucket size that keeps a chart readable without lying about
 * resolution. Raw samples are per-minute and rollups are hourly, so anything
 * reaching past the raw-retention window is bucketed at an hour or coarser —
 * there is no finer truth to draw back there.
 */
function chooseBucketMs(windowMs) {
  const H = HOUR_MS;
  if (windowMs <= 6 * H) return 5 * 60 * 1000;
  if (windowMs <= 48 * H) return 15 * 60 * 1000;
  if (windowMs <= 7 * 24 * H) return H;
  if (windowMs <= 60 * 24 * H) return 6 * H;
  return 24 * H;
}

/**
 * Audience over time for one stream, stitching raw samples and hourly rollups
 * exactly the way getUptime() does — so a long range spans both storage tiers
 * without the caller knowing which is which.
 *
 * `avg` counts only checks where the stream was up, for the same reason the
 * rollups do: a zero reported during an outage means the mount was gone, not
 * that the audience left, and averaging it in would flatten the very dips the
 * chart exists to show. `down` is reported alongside so the gap stays visible.
 */
function getListenerSeries(streamId, windowMs, bucketMs) {
  const bucket = bucketMs || chooseBucketMs(windowMs);
  const cutoff = Date.now() - windowMs;
  const out = new Map();

  const slot = (t) => {
    const key = Math.floor(t / bucket) * bucket;
    if (!out.has(key)) {
      out.set(key, { t: key, sum: 0, count: 0, peak: null, up: 0, down: 0, checks: 0 });
    }
    return out.get(key);
  };

  for (const s of samples[streamId] || []) {
    const t = new Date(s.timestamp).getTime();
    if (!isFinite(t) || t <= cutoff) continue;
    const b = slot(t);
    b.checks++;
    if (s.status === 'up') {
      b.up++;
      if (s.listeners != null) {
        b.sum += s.listeners;
        b.count++;
        b.peak = b.peak == null ? s.listeners : Math.max(b.peak, s.listeners);
      }
    } else if (s.status === 'down') {
      b.down++;
    }
  }

  for (const r of rollups[streamId] || []) {
    const t = new Date(r.hour).getTime();
    if (!isFinite(t) || t + HOUR_MS <= cutoff) continue;
    const b = slot(t);
    b.checks += r.checks || 0;
    b.up += r.up || 0;
    b.down += r.down || 0;
    const n = r.listenerCount ?? r.up ?? 0;
    if (r.avgListeners != null && n > 0) {
      b.sum += r.avgListeners * n;
      b.count += n;
    }
    if (r.listenerPeak != null) {
      b.peak = b.peak == null ? r.listenerPeak : Math.max(b.peak, r.listenerPeak);
    }
  }

  return [...out.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => ({
      t: new Date(b.t).toISOString(),
      avg: b.count ? Math.round((b.sum / b.count) * 10) / 10 : null,
      peak: b.peak,
      up: b.up,
      down: b.down,
      checks: b.checks,
    }));
}

/**
 * Audience headline figures for a window, including the cost of every failure
 * in it. Listener-minutes come from the `audience` block frozen onto each event
 * at resolution time — they cannot be recomputed here once raw samples expire.
 */
function getAudienceSummary(streamIds, windowMs) {
  const cutoff = Date.now() - windowMs;
  const perStream = {};
  let lost = 0;
  let lostMeasured = 0;
  let eventsWithAudience = 0;
  let eventsMissingAudience = 0;

  for (const id of streamIds) {
    let sum = 0;
    let count = 0;
    let peak = null;

    for (const s of samples[id] || []) {
      const t = new Date(s.timestamp).getTime();
      if (!isFinite(t) || t <= cutoff) continue;
      if (s.status !== 'up' || s.listeners == null) continue;
      sum += s.listeners;
      count++;
      peak = peak == null ? s.listeners : Math.max(peak, s.listeners);
    }
    for (const r of rollups[id] || []) {
      const t = new Date(r.hour).getTime();
      if (!isFinite(t) || t + HOUR_MS <= cutoff) continue;
      const n = r.listenerCount ?? r.up ?? 0;
      if (r.avgListeners != null && n > 0) { sum += r.avgListeners * n; count += n; }
      if (r.listenerPeak != null) peak = peak == null ? r.listenerPeak : Math.max(peak, r.listenerPeak);
    }

    perStream[id] = {
      avgListeners: count ? Math.round((sum / count) * 10) / 10 : null,
      peakListeners: peak,
      listenerMinutesLost: 0,
    };
  }

  for (const e of events) {
    if (e.type === 'up') continue;
    const t = new Date(e.timestamp).getTime();
    if (!isFinite(t) || t <= cutoff) continue;
    if (!perStream[e.streamId]) continue;

    const a = e.audience;
    if (!a || a.listenerMinutesLost == null) {
      if (e.durationMs) eventsMissingAudience++;
      continue;
    }
    eventsWithAudience++;
    lost += a.listenerMinutesLost;
    if (a.confidence === 'measured') lostMeasured += a.listenerMinutesLost;
    perStream[e.streamId].listenerMinutesLost += a.listenerMinutesLost;
  }

  return {
    perStream,
    listenerMinutesLost: lost,
    listenerHoursLost: Math.round((lost / 60) * 10) / 10,
    listenerMinutesLostMeasured: lostMeasured,
    eventsWithAudience,
    // Surfaced rather than hidden: a non-zero count here means the figure above
    // is an undercount, and that the backfill has not been run.
    eventsMissingAudience,
  };
}

// ── Aggregate Stats ─────────────────────────────────────────────────────────
/**
 * Uptime across a window, combining raw samples and hourly rollups so figures
 * stay correct even for periods that have already been compacted.
 */
function getUptime(streamId, windowMs) {
  const cutoff = Date.now() - windowMs;
  let total = 0;
  let up = 0;

  for (const s of samples[streamId] || []) {
    if (new Date(s.timestamp).getTime() <= cutoff) continue;
    total++;
    if (s.status === 'up') up++;
  }
  for (const r of rollups[streamId] || []) {
    if (new Date(r.hour).getTime() + HOUR_MS <= cutoff) continue;
    total += r.checks;
    up += r.up;
  }

  if (total === 0) return null;
  return Math.round((up / total) * 10000) / 100;
}

/**
 * Uptime across a window, combined over every given stream (not averaged
 * per-stream percentages) — the figure behind the dashboard's single
 * top-line "Uptime" tile.
 */
function getOverallUptime(streamIds, windowMs) {
  const cutoff = Date.now() - windowMs;
  let total = 0;
  let up = 0;

  for (const id of streamIds) {
    for (const s of samples[id] || []) {
      if (new Date(s.timestamp).getTime() <= cutoff) continue;
      total++;
      if (s.status === 'up') up++;
    }
    for (const r of rollups[id] || []) {
      if (new Date(r.hour).getTime() + HOUR_MS <= cutoff) continue;
      total += r.checks;
      up += r.up;
    }
  }

  if (total === 0) return null;
  return Math.round((up / total) * 10000) / 100;
}

/**
 * Earliest telemetry timestamp across the given streams — how far back
 * uptime figures can actually reach. Lets the UI tell a real 30-day figure
 * apart from one padded out by a monitor that only started a few days ago.
 */
function getCoverageStart(streamIds) {
  let earliest = null;
  for (const id of streamIds) {
    const r = rollups[id] || [];
    if (r.length) {
      const t = new Date(r[0].hour).getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
    const s = samples[id] || [];
    if (s.length) {
      const t = new Date(s[0].timestamp).getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

function getSummary(streamIds, windowMs) {
  const out = {};
  for (const id of streamIds) {
    const evts = events.filter(
      (e) => e.streamId === id && Date.now() - new Date(e.timestamp).getTime() <= windowMs,
    );
    out[id] = {
      uptime: getUptime(id, windowMs),
      outages: evts.filter((e) => e.severity === 'outage').length,
      briefOutages: evts.filter((e) => e.severity === 'brief_outage').length,
      probeErrors: evts.filter((e) => e.severity === 'probe_error').length,
      // Every unconfirmed failure, whatever it was called when it was written.
      blips: evts.filter((e) => isUnconfirmedSeverity(e.severity)).length,
      deadAir: evts.filter((e) => e.severity === 'dead_air').length,
      sampleCount: (samples[id] || []).length,
      rollupCount: (rollups[id] || []).length,
    };
  }
  return out;
}

/** Per-day outage counts for the calendar heatmap. */
function getDailyBuckets(days) {
  const out = new Map();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  for (const e of events) {
    const t = new Date(e.timestamp).getTime();
    if (t < cutoff) continue;
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    if (!out.has(day)) {
      out.set(day, { day, outages: 0, blips: 0, briefOutages: 0, probeErrors: 0, deadAir: 0, recoveries: 0, total: 0 });
    }
    const b = out.get(day);
    b.total++;
    if (e.severity === 'outage') b.outages++;
    else if (e.severity === 'dead_air') b.deadAir++;
    else if (e.severity === 'recovery') b.recoveries++;
    else if (isUnconfirmedSeverity(e.severity)) {
      b.blips++;
      if (e.severity === 'probe_error') b.probeErrors++;
      else b.briefOutages++;
    }
  }

  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function getCauseBreakdown(windowMs) {
  const cutoff = Date.now() - windowMs;
  const counts = {};
  for (const e of events) {
    if (new Date(e.timestamp).getTime() < cutoff) continue;
    const c = e.diagnosis?.cause;
    if (!c) continue;
    if (!counts[c]) counts[c] = { cause: c, label: e.diagnosis.causeLabel, count: 0 };
    counts[c].count++;
  }
  return Object.values(counts).sort((a, b) => b.count - a.count);
}

// ── Status cache ────────────────────────────────────────────────────────────
function getStatusCache() { return streamStatusCache; }
function setStatusCache(s) { streamStatusCache = s; dirtyEvents = true; }

// ── Persistence ─────────────────────────────────────────────────────────────
function saveEvents(force = false) {
  if (!dirtyEvents && !force) return;
  try {
    atomicWrite(
      EVENTS_FILE,
      JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        appliedSeeds,
        events,
        streamStatus: streamStatusCache,
      }, null, 1),
    );
    dirtyEvents = false;
  } catch (err) {
    console.error('[Store] Failed to save events:', err.message);
  }
}

function saveSamples(force = false) {
  if (!dirtySamples && !force) return;
  try {
    // No pretty-printing here — this is the large file and indentation would
    // roughly triple it for no operator benefit.
    atomicWrite(
      SAMPLES_FILE,
      JSON.stringify({ version: 2, savedAt: new Date().toISOString(), samples, rollups }),
    );
    dirtySamples = false;
  } catch (err) {
    console.error('[Store] Failed to save samples:', err.message);
  }
}

function save(force = false) {
  saveEvents(force);
  saveSamples(force);
}

function getStorageInfo() {
  const stat = (f) => {
    try { return fs.existsSync(f) ? fs.statSync(f).size : 0; } catch { return 0; }
  };
  return {
    dataDir: DATA_DIR,
    eventsBytes: stat(EVENTS_FILE),
    samplesBytes: stat(SAMPLES_FILE),
    eventCount: events.length,
    sampleCount: Object.values(samples).reduce((a, b) => a + b.length, 0),
    rollupCount: Object.values(rollups).reduce((a, b) => a + b.length, 0),
    sampleRetentionDays: SAMPLE_RETENTION_DAYS,
    oldestEvent: events.length ? events[0].timestamp : null,
    newestEvent: events.length ? events[events.length - 1].timestamp : null,
  };
}

module.exports = {
  load, save, saveEvents, saveSamples, prune,
  addEvent, updateEvent, getEvents, findOpenOutage,
  addSample, getSamples, getAllSamples, getRollups,
  getUptime, getOverallUptime, getCoverageStart, getSummary, getDailyBuckets, getCauseBreakdown,
  getStatusCache, setStatusCache, getStorageInfo,
  isUnconfirmedSeverity,
  getAudienceContext, getHourOfDayProfile, buildAudienceImpact, deriveListenerImpact,
  getListenerSeries, getAudienceSummary, chooseBucketMs,
  SAMPLE_RETENTION_DAYS,
};
