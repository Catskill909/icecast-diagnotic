/* ═══════════════════════════════════════════════════════════════════════════
   Pacifica Stream Monitor — Persistent Store
   ───────────────────────────────────────────────────────────────────────────
   Two independent files, on purpose:

     data/events.json   Every outage, recovery and dead-air event. Events are
                        not pruned by age; the newest MAX_EVENTS are retained.

     data/samples.json  Per-check telemetry powering the uptime bars.
                        Raw samples kept SAMPLE_RETENTION_DAYS (default 7),
                        then compacted into long-term hourly rollups.

   Splitting them means a large or corrupted sample file can never take the
   long-term incident record down with it. Both are written atomically
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
// keep recognising it — retained events are never rewritten.
const UNCONFIRMED_SEVERITIES = new Set(['brief_outage', 'probe_error', 'blip']);
const isUnconfirmedSeverity = (s) => UNCONFIRMED_SEVERITIES.has(s);

// ── State ───────────────────────────────────────────────────────────────────
let events = [];             // long-term incident record, oldest → newest
let samples = {};            // { [streamId]: [ sample ] }  raw, rolling window
let rollups = {};            // { [streamId]: [ hourlyRollup ] }  permanent
let streamStatusCache = {};  // last known status, for warm restarts
let appliedSeeds = [];       // seedIds already backfilled — guards against re-import
let meta = {};               // small persisted scalars (e.g. last weekly roundup sent)
let config = null;           // station/channel/host configuration; null until seeded
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
function load(streamIds = []) {
  ensureStreams(streamIds);

  const ev = readJson(EVENTS_FILE);
  if (ev) {
    events = Array.isArray(ev.events) ? ev.events : [];
    streamStatusCache = ev.streamStatus || {};
    appliedSeeds = Array.isArray(ev.appliedSeeds) ? ev.appliedSeeds : [];
    meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
    config = ev.config && typeof ev.config === 'object' ? ev.config : null;
    console.log(`[Store] Loaded ${events.length} retained event(s)`);
    if (config) {
      const n = (config.stations || []).length;
      const c = (config.stations || []).reduce((a, s) => a + (s.channels || []).length, 0);
      console.log(`[Store] Loaded configuration: ${n} station(s), ${c} channel(s)`);
    }
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
  // rescued into the long-term record rather than being lost to the old 24h
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
  repairTuneIns();
  // Must run BEFORE prune(): compaction destroys the raw samples this reads.
  backfillAudience();
  prune();
}

/**
 * Discards tune-in figures that were never tune-ins.
 *
 * Until 2026-08-31, prune() added a channel's whole listener count once per
 * expiring BATCH, and prune runs every check cycle — so it added it roughly once
 * per minute. The stored figure therefore was not arrivals at all: it was the
 * sum of every reading in the hour, which is listener-minutes. Measured on
 * production, one KPFT Main hour with avgListeners=50 and peak=57 carried
 * tuneIns=2956, and the month-to-date reach read 270,436 against a week of 520.
 *
 * THE TRUE VALUE CANNOT BE RECOVERED. Tune-ins are computed from raw samples at
 * compaction precisely because the samples are then destroyed, so there is
 * nothing left to recompute from. The only honest repair is to erase the wrong
 * number: `null` means "not recorded", which every reader already handles —
 * getTuneIns() counts those hours as `hoursMissing` and the UI says the period
 * is only partly counted. Leaving them would keep publishing a figure that is
 * wrong by about sixty times, which is worse than publishing none.
 *
 * Runs once, guarded by a marker, so it cannot erase correct figures written
 * after the fix.
 */
function repairTuneIns() {
  if (getMeta('tuneInsRepaired')) return;

  let cleared = 0;
  for (const id of Object.keys(rollups)) {
    for (const r of rollups[id] || []) {
      if (r.tuneIns == null) continue;
      delete r.tuneIns;
      cleared++;
    }
  }

  setMeta('tuneInsRepaired', new Date().toISOString());
  // The carry starts empty: there is no trustworthy previous reading to resume
  // from, and seeding it wrongly would put one bad hour at the boundary.
  setMeta('compactCarry', {});
  dirtySamples = true;
  dirtyEvents = true;

  if (cleared) {
    console.warn(
      `[Store] Cleared ${cleared} tune-in figure(s) recorded before 2026-08-31 — ` +
      'they were listener-minutes, not arrivals, and cannot be recomputed. ' +
      'Those hours now report as unrecorded rather than wrong.',
    );
  }
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

  let recosted = 0;
  let recostDelta = 0;

  for (const e of events) {
    // Failures only. A 'degraded' event is a channel that kept playing while one
    // of its bitrate variants failed, and this reconstructs loss from the
    // CHANNEL's sample history — which would charge every listener of a healthy
    // channel to a fault that only touched one variant, and write the result out
    // as a measured figure. The variant-scoped count already lives on the
    // event's own `detail.listenersBefore`, taken while it was still knowable.
    if (!isFailureEvent(e) || !e.durationMs) continue;

    const impact = deriveListenerImpact(e);

    // Skip only when the stored figure was measured AND still agrees with the
    // current verdict. Checking the verdict too lets a corrected rule repair
    // events written under the old one — a stored number that is wrong is worse
    // than a missing one, because it looks authoritative.
    const stored = e.audience;
    if (stored && stored.confidence === 'measured' && stored.listenerImpact === impact) {
      // …with one exception: a block written before the loss model existed
      // carries no `model` field, and a long outage costed flat is overstated.
      // Re-cost it from the STORED context rather than a fresh one — the raw
      // samples behind its measured headcount may have been compacted away by
      // now, and re-deriving would downgrade a real measurement to an estimate.
      if (stored.model === undefined && e.durationMs > LONG_OUTAGE_MS) {
        const was = stored.listenerMinutesLost;
        e.audience = applyLossModel(stored, e.streamId, e.timestamp, e.durationMs, impact);
        if (e.audience.listenerMinutesLost !== was) {
          recosted++;
          recostDelta += e.audience.listenerMinutesLost - was;
        }
        dirtyEvents = true;
      }
      continue;
    }

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

  if (filled || corrected || recosted) {
    console.log(
      `[Store] Audience impact: ${filled} filled, ${corrected} corrected` +
      (recosted
        ? `, ${recosted} long outage(s) re-costed along the audience curve (${
          recostDelta > 0 ? '+' : ''}${recostDelta.toLocaleString()} listener-minutes)`
        : '') +
      (relabelled ? `, ${relabelled} relabelled as probe anomalies` : '') +
      ` — ${lost.toLocaleString()} listener-minutes newly measured`,
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

// ── Events (long-term, bounded by MAX_EVENTS) ───────────────────────────────
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
    streamId, streamIds, type, severity, cause, scope,
    since, until, emailed, limit, offset = 0, order = 'desc',
  } = opts;

  let out = events;

  if (streamId) out = out.filter((e) => e.streamId === streamId);
  // A whole station's worth of streams. Filtered here rather than by the caller
  // so limit and offset still paginate over the right set — trimming afterwards
  // would page through everyone's events and show a short page of one station's.
  if (Array.isArray(streamIds)) {
    const keep = new Set(streamIds);
    out = out.filter((e) => keep.has(e.streamId));
  }
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
 * onto the long-term event record.
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

// Below this, a flat multiplier and a modelled curve differ by noise, so the
// simpler calculation wins. Above it, holding the audience constant for hours
// is the dominant source of error in the headline figure.
const LONG_OUTAGE_MS = 60 * 60 * 1000;
// A profile built from a handful of hours has no usable shape — extrapolating
// along it would be inventing a daypart curve rather than following one.
const PROFILE_MIN_HOURS = 12;
// The anchor rescales the whole curve, so one freak reading at the moment of
// failure must not be allowed to multiply an 18-hour extrapolation.
const ANCHOR_MIN = 0.2;
const ANCHOR_MAX = 5;

/**
 * Listener-minutes for a long outage, following the audience curve instead of a
 * flat line.
 *
 * A flat multiplier says: whoever was listening when it broke would have kept
 * listening, at that exact headcount, for every minute it stayed broken. Over
 * four minutes that is fine. Over the 3h35m server outage that began at 8:12pm
 * — or the 18h24m HD2 dropout spanning a whole day and night — it charges a
 * primetime audience for the small hours, and those two events alone carried
 * 88% of the reported loss.
 *
 * So the shape comes from the stream's own hour-of-day profile and the LEVEL
 * comes from the measurement taken just before the failure: the profile is
 * rescaled so it passes exactly through the observed starting point, then
 * integrated across the outage. A real 32-listener start stays 32 at the start
 * and follows that stream's normal overnight decline from there.
 *
 * Returns null when there is not enough profile to trust, leaving the caller to
 * fall back to the flat figure rather than guess.
 */
function modelledListenerMinutes(streamId, startMs, durationMs, listenersBefore) {
  const profile = getHourOfDayProfile(streamId);
  if (profile.filter((v) => v != null && v > 0).length < PROFILE_MIN_HOURS) return null;

  const anchor = profile[new Date(startMs).getUTCHours()];
  if (!anchor || anchor <= 0) return null;

  const scale = Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, listenersBefore / anchor));

  let minutes = 0;
  let t = startMs;
  const end = startMs + durationMs;

  while (t < end) {
    const d = new Date(t);
    // Advance to the top of the next UTC hour, so each segment sits in exactly
    // one profile bucket and partial hours at both ends are handled correctly.
    const nextHour = Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1,
    );
    const segEnd = Math.min(nextHour, end);
    const level = profile[d.getUTCHours()];
    // An unpopulated hour falls back to the observed level rather than to zero:
    // no data about an hour is not evidence that nobody was listening in it.
    minutes += ((segEnd - t) / 60000) * (level != null ? level * scale : listenersBefore);
    t = segEnd;
  }

  return Math.round(minutes);
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
  return applyLossModel(ctx, streamId, startedAtIso, durationMs, listenerImpact);
}

/**
 * Turns an audience context into the frozen impact block, choosing the loss
 * model that fits the outage length.
 *
 * Split out from buildAudienceImpact so the startup backfill can re-cost a
 * stored event under a corrected model WITHOUT re-deriving its context — the
 * raw samples behind a measured `listenersBefore` expire after a week, so
 * re-deriving would silently downgrade a real measurement to an estimate.
 */
function applyLossModel(ctx, streamId, startedAtIso, durationMs, listenerImpact) {
  const harmless = listenerImpact === 'none';
  const startMs = new Date(startedAtIso).getTime();
  const minutes = (durationMs || 0) / 60000;
  const flat = ctx.listenersBefore == null ? null : Math.round(ctx.listenersBefore * minutes);

  let lost = flat;
  let model = 'flat';

  if (harmless) {
    lost = 0;
    model = 'none';
  } else if (ctx.listenersBefore != null && durationMs > LONG_OUTAGE_MS && isFinite(startMs)) {
    const curved = modelledListenerMinutes(streamId, startMs, durationMs, ctx.listenersBefore);
    if (curved != null) {
      lost = curved;
      model = 'hour-of-day';
    }
  }

  return {
    listenersBefore: ctx.listenersBefore,
    peakBefore: ctx.peakBefore,
    listenerMinutesLost: lost,
    listenerImpact: listenerImpact ?? null,
    confidence: ctx.confidence,
    // Which model produced the figure, and — when it was not the naive one —
    // what the naive one would have said. Anyone comparing this month's total
    // against an older screenshot can see exactly where the difference came
    // from instead of assuming the data changed underneath them.
    model,
    flatEquivalent: model === 'hour-of-day' ? flat : undefined,
    basis: harmless
      ? 'no loss charged — Icecast reachable and mount still serving'
      : model === 'hour-of-day'
      ? `${ctx.basis}, projected along this stream's hour-of-day audience curve`
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
      // Tune-ins must be counted NOW, from the raw samples, because an hourly
      // average cannot show that forty listeners left as forty arrived. Once
      // these samples are gone the churn is unrecoverable, so the figure is
      // frozen onto the rollup the same way audience impact is frozen onto an
      // event at recovery.
      const tuneInsByHour = new Map();
      {
        const ordered = [...expire]
          .filter((s) => s.status === 'up' && s.listeners != null)
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // THE PREVIOUS SAMPLE MUST CARRY ACROSS PRUNE CALLS.
        //
        // prune() runs every check cycle, so samples expire a handful at a time
        // — usually ONE. Treating the first sample of each batch as "everyone
        // already connected" then adds the channel's whole listener count once
        // per minute instead of once per period, and the stored figure stops
        // being tune-ins at all: it becomes the sum of every reading, which is
        // listener-MINUTES. Measured on production before this was fixed, one
        // KPFT Main hour averaging 50 listeners and peaking at 57 carried
        // tuneIns=2956 — almost exactly 50 x 60 readings.
        //
        // The carry is persisted, so a restart between two prunes does not
        // reintroduce it once per deploy.
        const carry = getMeta('compactCarry') || {};
        const carried = carry[id];
        let prev = carried && isFinite(carried.t) ? carried : null;

        for (const cur of ordered) {
          const t = new Date(cur.timestamp).getTime();
          const key = hourKey(cur.timestamp);
          let add;
          if (!prev) {
            add = cur.listeners;              // genuinely the first ever reading
          } else if (t - prev.t > 5 * 60 * 1000) {
            add = 0;                          // a gap is not a surge of listeners
          } else {
            add = Math.max(0, cur.listeners - prev.listeners);
          }
          tuneInsByHour.set(key, (tuneInsByHour.get(key) || 0) + add);
          prev = { t, listeners: cur.listeners };
        }

        if (prev) setMeta('compactCarry', { ...carry, [id]: prev });
      }
      for (const s of expire) {
        const key = hourKey(s.timestamp);
        if (!buckets.has(key)) {
          buckets.set(key, {
            hour: key, checks: 0, up: 0, down: 0, silent: 0,
            responseSum: 0, responseCount: 0, minResponse: null, maxResponse: null,
            listenerSum: 0, listenerCount: 0, listenerPeak: 0,
            tuneIns: Math.round(tuneInsByHour.get(key) || 0),
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
                // Additive: two prunes touching one hour each counted part of
                // its churn. Absent on rollups written before tune-ins existed,
                // and left absent rather than defaulted to 0 — "not recorded"
                // and "nobody tuned in" are different facts.
                tuneIns: prevRoll.tuneIns == null && b.tuneIns == null
                  ? undefined
                  : (prevRoll.tuneIns || 0) + (b.tuneIns || 0),
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
              tuneIns: b.tuneIns,
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
      // `mounts` is per-bitrate-variant. It exists only for buckets built from
      // RAW samples: hourly rollups compact the per-mount breakdown away, so
      // per-mount audience history reaches back exactly as far as
      // SAMPLE_RETENTION_DAYS and no further. The UI must say so rather than
      // silently drawing a shorter line than the one beside it.
      out.set(key, { t: key, sum: 0, count: 0, peak: null, up: 0, down: 0, checks: 0, mounts: new Map() });
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
      if (s.mountListeners) {
        for (const [path, n] of Object.entries(s.mountListeners)) {
          if (typeof n !== 'number') continue;
          const m = b.mounts.get(path) || { sum: 0, count: 0 };
          m.sum += n;
          m.count += 1;
          b.mounts.set(path, m);
        }
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
      // Absent rather than empty on buckets with no per-mount data, so a caller
      // can tell "before we recorded this" from "every mount had zero".
      byMount: b.mounts.size
        ? Object.fromEntries(
          [...b.mounts].map(([path, m]) => [path, Math.round((m.sum / m.count) * 10) / 10]),
        )
        : undefined,
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
    // Failures only, and stated explicitly rather than relying on degraded
    // events happening to carry no `audience` block. That is true today because
    // backfillAudience() skips them, but a listener-minutes total that is
    // correct only because of a guard in another function is one edit away from
    // being wrong.
    if (!isFailureEvent(e)) continue;
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
 * Uptime as the AUDIENCE experienced it: the share of monitored time the
 * streams were actually serving audio.
 *
 * The sample-based figure counts every failed probe as downtime, which charges
 * the station for the monitor's own network hiccups — 86 events across the
 * first production week, none of which cost a listener a second of audio. A
 * station's uptime should describe its transmission, not our connectivity.
 *
 * Derived from events rather than samples, because only an event carries the
 * settled listener-impact verdict that decides whether a failure counted.
 * Returns null when there is no coverage to divide by.
 */
function getAudioUptime(streamIds, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let coveredMs = 0;
  let downMs = 0;

  for (const id of streamIds) {
    const start = getCoverageStart([id]);
    if (!start) continue;
    // A stream only counts for the part of the window we were actually watching.
    const covered = Math.min(windowMs, now - new Date(start).getTime());
    if (covered <= 0) continue;
    coveredMs += covered;

    for (const e of events) {
      // Failures only. A degraded channel was PLAYING — on fewer mounts than it
      // publishes, but playing — so charging its duration here would report a
      // channel that never stopped as having been off air for hours.
      if (e.streamId !== id || !isFailureEvent(e) || !e.durationMs) continue;
      const t = new Date(e.timestamp).getTime();
      if (!isFinite(t) || t + e.durationMs <= cutoff) continue;
      if (!costListeners(e)) continue;
      // Clip to the window so an outage that began before it does not borrow
      // downtime from a period this figure does not cover.
      downMs += Math.min(t + e.durationMs, now) - Math.max(t, cutoff);
    }
  }

  if (coveredMs <= 0) return null;
  const pct = 100 - (downMs / coveredMs) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 100) / 100;
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

const dayFormatters = new Map();

function zonedDayKey(ms, timeZone) {
  let fmt = dayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    dayFormatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function addCalendarDay(day, amount = 1) {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + amount));
  return next.toISOString().slice(0, 10);
}

/** Convert station-local midnight to an instant, including DST transitions. */
function zonedMidnightMs(day, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d);
  let guess = wanted;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += wanted - represented;
  }
  return guess;
}

/** Per-day counts plus elapsed listener-impacting off-air time for the heatmap. */
function getDailyBuckets(days, timeZone = 'UTC', streamIds) {
  const out = new Map();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // Scoped like every other aggregate. Left unscoped, the heatmap paints one
  // station's off-air days onto another's calendar.
  const keep = Array.isArray(streamIds) ? new Set(streamIds) : null;

  const bucket = (day) => {
    if (!out.has(day)) {
      const startMs = zonedMidnightMs(day, timeZone);
      const endMs = zonedMidnightMs(addCalendarDay(day), timeZone);
      out.set(day, {
        day, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
        outages: 0, blips: 0, briefOutages: 0, probeErrors: 0,
        deadAir: 0, recoveries: 0, total: 0, impactStarts: 0, impactMs: 0, streamMs: 0,
        _impactIntervals: [],
      });
    }
    return out.get(day);
  };

  for (const e of events) {
    const t = new Date(e.timestamp).getTime();
    if (!isFinite(t)) continue;
    if (keep && !keep.has(e.streamId)) continue;

    if (t >= cutoff) {
      const b = bucket(zonedDayKey(t, timeZone));
      b.total++;
      if (e.severity === 'outage') b.outages++;
      else if (e.severity === 'dead_air') b.deadAir++;
      else if (e.severity === 'recovery') b.recoveries++;
      else if (isUnconfirmedSeverity(e.severity)) {
        b.blips++;
        if (e.severity === 'probe_error') b.probeErrors++;
        else b.briefOutages++;
      }
      if (isFailureEvent(e) && costListeners(e)) b.impactStarts++;
    }

    // Spread real off-air time across every station-local date it touched.
    // `impactMs` merges simultaneous streams; `streamMs` adds them separately.
    if (!isFailureEvent(e) || !e.durationMs || !costListeners(e)) continue;
    let cursor = Math.max(t, cutoff);
    const eventEnd = Math.min(Date.now(), t + e.durationMs);
    if (eventEnd <= cursor) continue;
    while (cursor < eventEnd) {
      const day = zonedDayKey(cursor, timeZone);
      const b = bucket(day);
      const next = zonedMidnightMs(addCalendarDay(day), timeZone);
      const end = Math.min(eventEnd, next);
      b.streamMs += end - cursor;
      b._impactIntervals.push([cursor, end]);
      cursor = end;
    }
  }

  for (const b of out.values()) {
    b._impactIntervals.sort((a, z) => a[0] - z[0]);
    let start = null;
    let end = null;
    for (const [s, e] of b._impactIntervals) {
      if (start === null) { start = s; end = e; }
      else if (s <= end) end = Math.max(end, e);
      else { b.impactMs += end - start; start = s; end = e; }
    }
    if (start !== null) b.impactMs += end - start;
    delete b._impactIntervals;
  }

  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function getCauseBreakdown(windowMs, streamIds) {
  const cutoff = Date.now() - windowMs;
  // Scoped: an unfiltered breakdown attributes one station's encoder failures
  // to whichever station is being looked at.
  const keep = Array.isArray(streamIds) ? new Set(streamIds) : null;
  const counts = {};
  for (const e of events) {
    if (new Date(e.timestamp).getTime() < cutoff) continue;
    if (keep && !keep.has(e.streamId)) continue;
    const c = e.diagnosis?.cause;
    if (!c) continue;
    if (!counts[c]) counts[c] = { cause: c, label: e.diagnosis.causeLabel, count: 0 };
    counts[c].count++;
  }
  return Object.values(counts).sort((a, b) => b.count - a.count);
}

/**
 * Wall-clock time covered by a set of failures, with overlaps merged.
 *
 * Summing per-event durations answers "how many stream-hours were lost", which
 * is the right input to an uptime percentage but the wrong answer to "how long
 * were we down". When one server fault took Main and HD3 out together for
 * 3h35m, the sum reported 7h10m — nobody experienced seven hours. This merges
 * concurrent failures so the figure is elapsed time a listener could have
 * noticed something wrong.
 */
function mergedDowntimeMs(list) {
  const iv = list
    .filter((e) => e.durationMs > 0)
    .map((e) => {
      const s = new Date(e.timestamp).getTime();
      return [s, s + e.durationMs];
    })
    .filter(([s]) => isFinite(s))
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of iv) {
    if (curStart === null) { curStart = s; curEnd = e; }
    else if (s <= curEnd) { curEnd = Math.max(curEnd, e); }
    else { total += curEnd - curStart; curStart = s; curEnd = e; }
  }
  if (curStart !== null) total += curEnd - curStart;
  return total;
}

/**
 * Listening actually delivered in a window, in listener-minutes.
 *
 * The denominator that makes a loss figure mean something: "214 listener-hours
 * lost" is unreadable on its own, but "214 lost out of 9,000 delivered — 2.3%"
 * is a number a station manager can act on.
 *
 * Sample spacing is derived rather than assumed, because CHECK_INTERVAL_MS is
 * configurable and a hard-coded one-minute assumption would silently mis-scale
 * the whole figure if it were ever changed.
 */
function getListeningDelivered(streamIds, windowMs) {
  const cutoff = Date.now() - windowMs;
  let listenerMinutes = 0;

  for (const id of streamIds) {
    const arr = (samples[id] || []).filter((s) => {
      const t = new Date(s.timestamp).getTime();
      return isFinite(t) && t > cutoff && s.status === 'up' && s.listeners != null;
    });

    if (arr.length > 1) {
      const gaps = [];
      for (let i = 1; i < arr.length; i++) {
        const g = new Date(arr[i].timestamp) - new Date(arr[i - 1].timestamp);
        if (g > 0) gaps.push(g);
      }
      gaps.sort((a, b) => a - b);
      // Median, not mean: a restart gap of several hours would otherwise inflate
      // every sample's weight across the whole window.
      const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 60000;
      const perSampleMin = Math.min(15, Math.max(0.25, median / 60000));
      listenerMinutes += arr.reduce((a, s) => a + s.listeners, 0) * perSampleMin;
    } else if (arr.length === 1) {
      listenerMinutes += arr[0].listeners;
    }

    for (const r of rollups[id] || []) {
      const t = new Date(r.hour).getTime();
      if (!isFinite(t) || t + HOUR_MS <= cutoff || r.avgListeners == null) continue;
      listenerMinutes += r.avgListeners * 60;
    }
  }

  return Math.round(listenerMinutes);
}

/* ── Total listeners (tune-ins) ─────────────────────────────────────────────
   THE headline figure for a listener-supported station.

   "178 listening" is a concurrent count — an engineering number about server
   load. What a station puts in a pledge drive, a CPB report or an underwriting
   pitch is REACH: how many people listened at all. On this record those differ
   by six to nine times, so quoting the concurrent figure makes a station look an
   order of magnitude smaller than it is, to exactly the audiences whose money
   depends on the number.

   Every time the listener count RISES, someone tuned in. Summing those rises
   over a period counts tune-ins without needing to know who anybody is.

   Two honest limits, and both must travel with the figure:

     · It is a FLOOR. Within one 60-second cycle, three people leaving as three
       arrive is a net change of zero and is invisible. The real number is
       higher, never lower.

     · It counts TUNE-INS, not people. Someone who listens twice counts twice.
       Distinguishing them needs per-listener identity — see AUDIENCE-ROADMAP.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Tune-ins for one stream between two instants, from raw samples.
 *
 * A rise across a monitoring GAP is not a rise in the audience — it is the
 * audience we could not see becoming visible again. Counting it would turn every
 * restart and every outage recovery into a phantom surge of listeners, which is
 * worst precisely when a station is already looking at a bad day. Deltas across
 * a gap longer than `maxGapMs` are therefore skipped and reported.
 */
function tuneInsFromSamples(streamId, startMs, endMs, maxGapMs) {
  const arr = (samples[streamId] || [])
    .filter((s) => {
      const t = new Date(s.timestamp).getTime();
      return isFinite(t) && t >= startMs && t < endMs && s.status === 'up' && s.listeners != null;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (!arr.length) return { tuneIns: 0, gaps: 0, covered: false };

  // Everyone already connected when the period opened listened during it, so
  // they belong in "who listened today" even though they tuned in yesterday.
  let tuneIns = arr[0].listeners;
  let gaps = 0;

  for (let i = 1; i < arr.length; i++) {
    const dt = new Date(arr[i].timestamp) - new Date(arr[i - 1].timestamp);
    if (dt > maxGapMs) { gaps++; continue; }
    const delta = arr[i].listeners - arr[i - 1].listeners;
    if (delta > 0) tuneIns += delta;
  }

  return { tuneIns, gaps, covered: true };
}

/**
 * Tune-ins over a period, per stream, summed.
 *
 * Raw samples carry the churn; hourly rollups do not — an average cannot show
 * that forty people left and forty arrived. So each hour's tune-ins are computed
 * and frozen onto its rollup when the samples compact (see prune), and this
 * reads raw where it exists and the stored figure where it does not. Hours older
 * than the raw window that were rolled up BEFORE this existed carry no figure,
 * and are reported as uncovered rather than as zero.
 */
function getTuneIns(streamIds, startMs, endMs) {
  const maxGapMs = 5 * 60 * 1000;   // five minutes: generous against a slow cycle
  let total = 0;
  let gaps = 0;
  let hoursFromRollup = 0;
  let hoursMissing = 0;

  for (const id of streamIds) {
    const raw = tuneInsFromSamples(id, startMs, endMs, maxGapMs);
    total += raw.tuneIns;
    gaps += raw.gaps;

    // Hours the raw samples do not reach, filled from what prune() froze.
    const rawFrom = raw.covered
      ? Math.min(...(samples[id] || [])
        .map((s) => new Date(s.timestamp).getTime())
        .filter((t) => isFinite(t) && t >= startMs && t < endMs))
      : endMs;

    for (const r of rollups[id] || []) {
      const t = new Date(r.hour).getTime();
      if (!isFinite(t) || t < startMs || t >= endMs || t >= rawFrom) continue;
      if (r.tuneIns == null) { hoursMissing++; continue; }
      total += r.tuneIns;
      hoursFromRollup++;
    }
  }

  return {
    total: Math.round(total),
    gaps,
    hoursFromRollup,
    // Whole hours in range for which no tune-in figure was ever recorded. The
    // total is a floor for the period AND misses these entirely, so a UI must be
    // able to say the period is only partly counted.
    hoursMissing,
    estimated: true,
    floor: true,
  };
}

/* ── Listener counts ────────────────────────────────────────────────────────
   HEADCOUNTS, not hours. "How many people are listening" is the question a
   station actually asks, and listening-hours answers a different one.

   Two figures, and the difference matters:

     PEAK      the most people connected at one moment. A real instant.
     AVERAGE   how many are typically connected across the period.

   Neither is a count of distinct PEOPLE. Icecast's status endpoint reports how
   many connections exist right now, not who they are, so "1,800 different
   people listened this week" cannot be derived from it at any polling rate —
   that needs per-listener records from the admin API. Nothing here should ever
   be labelled "unique listeners".
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * The station as one audience, over a time range: every channel's listeners
 * summed at each moment.
 *
 * Summing per channel FIRST and taking maxima second is the whole point. Two
 * channels peaking an hour apart do not add up to a moment, and taking each
 * channel's own maximum then adding them reports a total the station never
 * reached — measured on production, that overstated the real peak by 18%.
 *
 * Resolution follows the data: raw samples are per-minute, and once they
 * compact the finest truth available is the hourly rollup. `resolution` says
 * which, because a peak drawn from hourly averages is a peak HOUR, not a peak
 * minute, and quoting the two as though they were the same figure is wrong.
 */
function concurrentBetween(streamIds, startMs, endMs) {
  const byMinute = new Map();
  const byHour = new Map();

  for (const id of streamIds) {
    for (const s of samples[id] || []) {
      const t = new Date(s.timestamp).getTime();
      if (!isFinite(t) || t < startMs || t >= endMs) continue;
      // Down samples report zero listeners because the mount is gone, not
      // because nobody was listening. Counting them would drag the average
      // toward zero in exactly the periods a station is already unhappy about.
      if (s.status !== 'up' || s.listeners == null) continue;
      byMinute.set(t, (byMinute.get(t) || 0) + s.listeners);
    }

    for (const r of rollups[id] || []) {
      const t = new Date(r.hour).getTime();
      if (!isFinite(t) || t < startMs || t >= endMs) continue;
      if (r.avgListeners == null) continue;
      byHour.set(t, (byHour.get(t) || 0) + r.avgListeners);
    }
  }

  // Prefer raw where it exists; fall back to rollups for older stretches. An
  // hour holding both would be double counted, so raw wins for its own hour.
  const rawHours = new Set([...byMinute.keys()].map((t) => Math.floor(t / HOUR_MS) * HOUR_MS));
  const points = [...byMinute.values()];
  let usedRollup = false;
  for (const [t, v] of byHour) {
    if (rawHours.has(Math.floor(t / HOUR_MS) * HOUR_MS)) continue;
    points.push(v);
    usedRollup = true;
  }

  if (!points.length) return { peak: null, avg: null, low: null, readings: 0, resolution: null };

  let peak = -Infinity;
  let low = Infinity;
  let sum = 0;
  for (const v of points) {
    if (v > peak) peak = v;
    if (v < low) low = v;
    sum += v;
  }

  return {
    peak: Math.round(peak),
    avg: Math.round((sum / points.length) * 10) / 10,
    low: Math.round(low),
    readings: points.length,
    resolution: byMinute.size && !usedRollup ? 'minute' : byMinute.size ? 'mixed' : 'hour',
  };
}

/** Start of today, this week (Monday) and this month, on the station clock. */
function periodBounds(timeZone, now = Date.now()) {
  const today = zonedDayKey(now, timeZone);
  const todayStart = zonedMidnightMs(today, timeZone);

  // Week starts Monday: a community station's schedule runs Monday to Sunday,
  // and a week that splits the weekend down the middle compares two halves of
  // different things.
  const dow = new Date(todayStart).getUTCDay();
  const backToMonday = (dow + 6) % 7;
  const weekStart = zonedMidnightMs(addCalendarDay(today, -backToMonday), timeZone);

  return {
    today: todayStart,
    week: weekStart,
    month: monthStartMs(timeZone, now),
  };
}

/**
 * Headline listener counts for today, this week and this month — each against
 * the equivalent previous period.
 *
 * "Down 10% on last month" is the sentence a station wants, and it is only
 * honest if the two periods are comparable. So the comparison is like-for-like:
 * today against the same elapsed hours of yesterday, this week against the same
 * elapsed part of last week, this month against the same elapsed part of last
 * month. Comparing nine days of this month against all thirty-one of last month
 * would report a collapse every single month.
 */
function getListenerCounts(streamIds, timeZone = 'UTC', now = Date.now()) {
  const b = periodBounds(timeZone, now);

  const pct = (a, bb) => (bb > 0 && a != null && bb != null
    ? Math.round(((a - bb) / bb) * 1000) / 10
    : null);

  const build = (startMs, prevStartMs) => {
    const elapsed = now - startMs;
    const current = concurrentBetween(streamIds, startMs, now);
    // Same elapsed span, one period earlier — not the whole previous period.
    const previous = concurrentBetween(streamIds, prevStartMs, prevStartMs + elapsed);

    // THE headline. How many people listened at all, versus how many were
    // listening at once — on this record they differ by six to nine times.
    const tuneIns = getTuneIns(streamIds, startMs, now);
    const prevTuneIns = getTuneIns(streamIds, prevStartMs, prevStartMs + elapsed);

    // A comparison is only honest if BOTH windows were fully counted.
    //
    // Tune-ins live in raw samples for the retention window, and in each hour's
    // rollup after that — but only for hours compacted since tune-in recording
    // began. An earlier window that predates it returns a partial total, and
    // dividing by it manufactures a percentage: on the first day this shipped,
    // last week came back 1,339 against this week's 5,813 and the page read
    // "+376%", which was entirely an artefact of the older window being
    // half-recorded. Withheld, exactly as the ATH trend is.
    const comparable = prevTuneIns.hoursMissing === 0 && prevTuneIns.total > 0;

    return {
      start: new Date(startMs).toISOString(),
      elapsedMs: elapsed,
      ...current,
      totalListeners: tuneIns.total || null,
      totalListenersMeta: tuneIns,
      previous: {
        ...previous,
        totalListeners: prevTuneIns.total || null,
        totalListenersMeta: prevTuneIns,
      },
      changePct: {
        peak: pct(current.peak, previous.peak),
        avg: pct(current.avg, previous.avg),
        totalListeners: comparable ? pct(tuneIns.total, prevTuneIns.total) : null,
      },
      // Why the reach comparison is absent, when it is. The UI says "not enough
      // history yet" rather than leaving a bare dash that reads as a fault.
      totalListenersComparable: comparable,
    };
  };

  const dayMs = 24 * 60 * 60 * 1000;
  const todayKey = zonedDayKey(now, timeZone);
  const monthPrevStart = monthStartMs(timeZone, b.month - 1);

  return {
    timeZone,
    today: build(b.today, zonedMidnightMs(addCalendarDay(todayKey, -1), timeZone)),
    week: build(b.week, b.week - 7 * dayMs),
    month: build(b.month, monthPrevStart),
    // THREE different questions, and only the first is answerable from a
    // connection count. Carried in the payload as explicit nulls with reasons so
    // the UI has something honest to render and nobody can later fill one in
    // with a concurrent figure under a name that misdescribes it.
    // `totalListeners` above answers "how many times did someone start
    // listening". This is its pair: how many different PEOPLE that was. One
    // person who tunes in ten times is ten total listeners and one individual
    // listener, and a station needs both figures — so this is a headline slot
    // showing why it is empty, not a hidden feature.
    unavailable: {
      individualListeners: {
        value: null,
        label: 'Total individual listeners',
        detail: 'How many different people, however many times each of them tuned in.',
        reason: 'needs Icecast admin access — telling one listener from another requires per-connection detail the public status page does not carry',
      },
    },
  };
}

/* ── Aggregate Tuning Hours ─────────────────────────────────────────────────
   ATH — one person listening for one hour — is the metric a US noncommercial
   webcaster's royalty rate is computed from, not merely an engagement figure.
   The SoundExchange noncommercial rate covers each channel's first 159,140 ATH
   per month; above that, more is owed. So this is a number with a threshold and
   dollars attached, and the station has no other way to see it.

   IT IS AN ESTIMATE, and every caller must say so. It is derived from polling
   listener COUNTS once a minute, not from a census of connections: see
   getListeningDelivered(). A real figure needs per-connection data, which needs
   Icecast admin credentials. This is an early-warning indicator — "you are
   approaching the threshold, go and get the real number" — and must never be
   presented as filing-grade.
   ─────────────────────────────────────────────────────────────────────────── */

/** The SoundExchange noncommercial allowance, per channel per month. */
const ATH_MONTHLY_ALLOWANCE = parseInt(process.env.ATH_MONTHLY_ALLOWANCE, 10) || 159140;

/** "2026-08-14" → "2026-09-01". */
function firstOfNextMonth(day) {
  const [y, m] = day.split('-').map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Start of the current calendar month, in the station's own timezone. */
function monthStartMs(timeZone, now = Date.now()) {
  return zonedMidnightMs(zonedDayKey(now, timeZone).slice(0, 8) + '01', timeZone);
}

/** Listening hours over a window. The unit ATH is quoted in. */
function getAth(streamIds, windowMs) {
  return getListeningDelivered(streamIds, windowMs) / 60;
}

/**
 * Month-to-date ATH for one channel, with a projection to month end.
 *
 * The projection is rated over what we actually WATCHED, not over the elapsed
 * month. A monitor that started on the 20th has ten days of silence in its
 * sample record that were not ten days of no listeners, and rating over elapsed
 * time would project a figure roughly two-thirds too low — on a number whose
 * whole purpose is warning about a threshold. `partial` says when that applies
 * so the UI can mark the figure rather than quietly showing a smaller one.
 */
function getMonthToDateAth(streamIds, timeZone = 'UTC') {
  const now = Date.now();
  const startMs = monthStartMs(timeZone, now);
  const endMs = zonedMidnightMs(firstOfNextMonth(zonedDayKey(now, timeZone)), timeZone);

  const elapsedMs = Math.max(1, now - startMs);
  const ath = getAth(streamIds, elapsedMs);

  const coverageStart = getCoverageStart(streamIds);
  const coveredFromMs = coverageStart
    ? Math.max(startMs, new Date(coverageStart).getTime())
    : startMs;
  const coveredMs = Math.max(1, now - coveredFromMs);

  return {
    ath: Math.round(ath),
    allowance: ATH_MONTHLY_ALLOWANCE,
    pctOfAllowance: Math.round((ath / ATH_MONTHLY_ALLOWANCE) * 1000) / 10,
    projected: Math.round((ath / coveredMs) * (endMs - startMs)),
    monthStart: new Date(startMs).toISOString(),
    monthEnd: new Date(endMs).toISOString(),
    elapsedMs,
    coveredMs,
    // True when the month began before we were watching, so the figure is a
    // floor rather than a total.
    partial: coveredMs < elapsedMs - 60000,
    timeZone,
    // Never let a caller forget. Nothing here is a connection census.
    estimated: true,
  };
}

/**
 * The authoritative listener-impact verdict for a stored event.
 *
 * There are two on every event and they routinely disagree. `diagnosis.
 * listenerImpact` is what we believed while the stream was still failing, taken
 * when Icecast was often unreachable and the honest answer was 'unknown'.
 * `audience.listenerImpact` is what recovery SETTLED it to, once Icecast could
 * be asked whether the mount had actually gone away.
 *
 * The settled one wins. Reading the failure-time guess instead counted 49
 * harmless probe resets as downtime on the production record, which is the
 * whole reason the recovery-settling logic exists.
 *
 * 'unknown' deliberately groups with 'confirmed' at every call site: an outage
 * we could not clear is treated as real, never quietly written off.
 */
function settledImpact(e) {
  return e?.audience?.listenerImpact ?? e?.diagnosis?.listenerImpact ?? 'unknown';
}

/**
 * Is this event a failure of the channel itself?
 *
 * 'up' is a recovery. 'degraded' is a channel that kept playing while one of
 * its bitrate variants went missing — a real fault, recorded as one, but NOT
 * downtime: the mount the probe watches never stopped serving, and folding it
 * into the failure totals would charge the station off-air time it did not have
 * and downtime minutes its listeners did not experience.
 *
 * Every "what went wrong this period" total funnels through here so that the
 * question is answered the same way twice.
 */
function isFailureEvent(e) {
  return e?.type !== 'up' && e?.type !== 'degraded';
}

/** Did this failure actually cost the audience audio? */
function costListeners(e) {
  return settledImpact(e) !== 'none';
}

/**
 * An event the monitor deliberately chose not to email, because Icecast proved
 * the mount kept serving. Distinct from an event with no delivery record: this
 * one has a known, intended outcome.
 */
function isSuppressed(e) {
  return typeof e.email?.reason === 'string' && e.email.reason.startsWith('suppressed');
}

/**
 * The line between an interruption and a lost listener.
 *
 * Below this, a stream client has usually rebuffered and carried on: the
 * listener heard a gap. Above it, the audience has tuned out or switched away.
 * Both are recorded identically — the threshold only decides which number a
 * station manager sees first, because a count that weighs a 60-second reconnect
 * the same as an 18-hour dropout tells nobody anything. On the first production
 * week this split 45 undifferentiated "outages" into 9 real ones and 36 blips.
 */
const SIGNIFICANT_OUTAGE_MS = 5 * 60 * 1000;

/**
 * Collapses concurrent failures into the single incident they actually were.
 *
 * One Icecast fault takes three mounts down at the same second and the record
 * stores three events, correctly — but reporting it as three outages misleads.
 * Failures that begin within a couple of minutes of each other with the same
 * diagnosed cause are one incident affecting several streams, which is how the
 * engineer who has to fix it thinks about it too.
 */
function groupIncidents(list) {
  const GROUP_WINDOW_MS = 2 * 60 * 1000;
  const sorted = [...list].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const groups = [];

  for (const e of sorted) {
    const t = new Date(e.timestamp).getTime();
    if (!isFinite(t)) continue;
    const cause = e.diagnosis?.causeLabel || null;
    const g = groups.find((x) => x.cause === cause && Math.abs(x.startMs - t) <= GROUP_WINDOW_MS);

    if (g) {
      g.streams.push(e.streamName || e.streamId);
      g.eventIds.push(e.id);
      g.durationMs = Math.max(g.durationMs, e.durationMs || 0);
      // A headcount, summed across the streams this incident took out. Real
      // people who could not hear anything — nothing multiplied by anything.
      g.listenersTunedIn += e.audience?.listenersBefore || 0;
      g.events++;
    } else {
      groups.push({
        startMs: t,
        timestamp: e.timestamp,
        cause,
        severity: e.severity,
        fault: faultSide(e),
        streams: [e.streamName || e.streamId],
        // Carried so the summary row can open the full drill-down for this
        // incident rather than duplicating evidence and remediation into a
        // second view that would then have to be kept in step.
        eventIds: [e.id],
        durationMs: e.durationMs || 0,
        listenersTunedIn: e.audience?.listenersBefore || 0,
        events: 1,
      });
    }
  }

  // Longest first: the incident that kept listeners off the air longest is the
  // one that matters, not the one with the biggest derived score.
  return groups.sort((a, b) => b.durationMs - a.durationMs);
}

/**
 * Which side of the station-to-Icecast handoff the evidence points to.
 *
 * The single most important fact when this record is sent to Pacifica: an
 * Reachability can identify the path that needs attention, but it cannot prove
 * which physical device, network hop, or service failed.
 */
function faultSide(e) {
  const ice = e.diagnosis?.icecast || {};
  if (ice.reachable === false) return 'pacifica';   // Pacifica/Icecast path unreachable
  if (ice.reachable === true) return 'kpft';        // Icecast answered; our mount/source absent
  return 'unknown';
}

/** Compact duration for narrative text — "41m", "2h 5m", "3d 4h". */
function fmtMs(ms) {
  if (!ms || ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const PERIOD_LABELS = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last year' };

/**
 * The rollup stated as English for the weekly email and API consumers. It is
 * built here, beside the numeric contract, so no second implementation can
 * quietly redefine the same period.
 */
function narrate(r) {
  const c = r.counts;
  const a = r.audience;
  const period = PERIOD_LABELS[Math.round(r.days)] || `Last ${Math.round(r.days)} days`;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Lead with the proportion delivered, then name the incidents that explain
  // the rest. An aggregate like "214 listener-hours lost" is arithmetically
  // true and reads as a catastrophe: the unit multiplies, so it is always a big
  // number, and on the production record 89% of it came from two incidents on a
  // single day. A station's first sentence should say how the service did, and
  // its second should say what went wrong — not shout a total.
  const delivered = a.lostSharePercent != null
    ? Math.round((100 - a.lostSharePercent) * 10) / 10
    : null;

  let headline;
  if (c.listenerAffecting === 0) {
    headline = c.noListenerImpact
      ? `No listener heard a break. ${c.noListenerImpact} monitoring ${c.noListenerImpact === 1 ? 'anomaly was' : 'anomalies were'} recorded, none of which interrupted the stream.`
      : 'No outages at all — every stream held for the whole period.';
  } else if (r.topIncidents.length) {
    const top = r.topIncidents[0];
    headline = `At least one monitored stream was off air for ${fmtMs(r.downtimeMs)} elapsed time (overlaps counted once). `
      + `The longest was ${top.streams.join(' and ')}, off air ${fmtMs(top.durationMs)}`
      + (top.cause ? ` — ${top.cause.toLowerCase()}` : '') + '.';
  } else {
    headline = `${plural(c.brief, 'brief interruption')} reached listeners, none lasting more than ${fmtMs(r.otherIncidents.longestMs)}.`;
  }

  const bits = [];
  if (r.uptime != null) bits.push(`${r.uptime}% of monitored stream-time delivered audio`);
  if (delivered != null) bits.push(`${delivered}% of listening delivered`);
  // Stated as what it is — a monitoring artefact — rather than as "unconfirmed
  // blips", which sounds like outages we failed to pin down.
  if (c.noListenerImpact && c.listenerAffecting) {
    bits.push(`${c.noListenerImpact} anomal${c.noListenerImpact === 1 ? 'y' : 'ies'} with no listener impact`);
  }
  // Messages, not events — one consolidated email can cover three streams.
  bits.push(r.alerts.messages
    ? `${plural(r.alerts.messages, 'alert email')} sent${
      r.alerts.eventsAlerted > r.alerts.messages ? ` (covering ${r.alerts.eventsAlerted} events)` : ''}`
    : 'no alert emails sent');
  if (r.alerts.failed) bits.push(`${plural(r.alerts.failed, 'alert')} FAILED to send`);
  if (r.alerts.suppressed) bits.push(`${r.alerts.suppressed} suppressed as harmless`);
  if (c.ongoing) bits.push(`${plural(c.ongoing, 'incident')} still open`);
  if (a.eventsMissingAudience) bits.push(`${a.eventsMissingAudience} event(s) not yet measured — the loss figure is a floor`);
  // A period the monitor only watched part of must not be quoted as a whole one.
  if (r.coverageMs < r.windowMs * 0.95) {
    bits.push(`monitoring covered only ${fmtMs(r.coverageMs)} of this period`);
  }

  return { period, headline, detail: `${bits.join(' · ')}.` };
}

/**
 * Everything needed to state "what happened over this period" in one sentence.
 *
 * ONE function, deliberately, because the History metrics, weekly roundup, and
 * future consumers must all derive from the same totals. Two implementations
 * of "how many outages last week" is two different answers waiting to happen.
 *
 * Two counting subtleties are surfaced rather than smoothed over:
 *
 *  · `alerts.messages` counts EMAILS, `alerts.eventsAlerted` counts events. One
 *    server-wide failure consolidates three streams into a single message, so
 *    these legitimately differ and calling either "alerts sent" alone is wrong.
 *
 *  · `listenersCutOff` sums each incident's audience. Someone cut off by three
 *    separate outages is counted three times — it is a count of interruptions
 *    suffered, not of distinct people, and the label must say so wherever it is
 *    shown. `listenerMinutesLost` is the figure that combines reach with
 *    duration, and is the one to lead with.
 */
function getPeriodRollup(streamIds, windowMs) {
  const until = Date.now();
  const since = until - windowMs;
  const ids = new Set(streamIds);

  const inWindow = events.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return isFinite(t) && t > since && ids.has(e.streamId);
  });

  const failures = inWindow.filter(isFailureEvent);
  const outages = failures.filter((e) => e.severity === 'outage');
  const deadAir = failures.filter((e) => e.severity === 'dead_air');
  const unconfirmed = failures.filter((e) => isUnconfirmedSeverity(e.severity));

  // An event that emailed is notifiable whatever its severity: the retired
  // server-blip rule did email unconfirmed events, and excluding them yields a
  // denominator smaller than its own numerator.
  const notifiable = inWindow.filter(
    (e) => !isUnconfirmedSeverity(e.severity) || e.email?.sent === true,
  );
  const alerted = inWindow.filter((e) => e.email?.sent === true);

  // Distinct messages, not distinct events — see the note above. messageId is
  // absent on reconstructed history, so the subject+timestamp pair stands in.
  const messages = new Set(
    alerted.map((e) => e.email.messageId || `${e.email.subject}|${e.email.sentAt || e.timestamp}`),
  );

  // The split that actually matters to a station: did the audience lose audio?
  //
  // NOT severity. Severity records whether a failure lasted long enough to pass
  // our confirmation threshold, which is a fact about the monitor, not about
  // listeners. On the production record those two groupings disagree badly — of
  // 36 events severity called "confirmed outages", 10 cost nobody anything;
  // while 19 events filed under "unconfirmed" really did drop every listener.
  // Leading with severity therefore alarms the station about probe resets and
  // buries real outages in a bucket whose name invites ignoring them.
  const harmless = failures.filter((e) => !costListeners(e));
  const impactful = failures.filter(costListeners);

  // Sustained enough that the audience is gone, vs a gap the player rode out.
  const significant = impactful.filter((e) => (e.durationMs || 0) >= SIGNIFICANT_OUTAGE_MS);
  const brief = impactful.filter((e) => (e.durationMs || 0) < SIGNIFICANT_OUTAGE_MS);

  // The few incidents that actually explain the period. On the production
  // record three of them carried 89% of all lost listening, so a page that
  // leads with totals instead of naming these is hiding its own answer.
  const incidents = groupIncidents(significant);

  // WHO HAS TO ACT. Reachability at the moment of failure separates the KPFT
  // source/feed path from the Pacifica/Icecast path. It does not prove which
  // individual device or network hop failed, so callers must retain that
  // narrower wording.
  const faultSplit = ['kpft', 'pacifica', 'unknown'].map((side) => {
    const mine = impactful.filter((e) => faultSide(e) === side);
    return {
      side,
      streamRecords: mine.length,
      // Back-compatible alias; these are per-stream records, not grouped incidents.
      outages: mine.length,
      wallClockMs: mergedDowntimeMs(mine),
      listenersCutOff: mine.reduce((a, e) => a + (e.audience?.listenersBefore || 0), 0),
      longestMs: mine.reduce((a, e) => Math.max(a, e.durationMs || 0), 0),
    };
  }).filter((s) => s.outages > 0);

  const peakEvent = impactful.reduce(
    (best, e) => ((e.audience?.listenersBefore || 0) > (best?.audience?.listenersBefore || 0) ? e : best),
    null,
  );

  const wallClockMs = mergedDowntimeMs(impactful);
  const streamMs = impactful.reduce((a, e) => a + (e.durationMs || 0), 0);
  const ongoing = failures.filter((e) => !e.resolvedAt).length;

  // Which stream carried it. One mount's long dropout can be two thirds of the
  // total, and a single combined figure hides that completely.
  const worstStream = streamIds
    .map((id) => ({
      id,
      ms: impactful.filter((e) => e.streamId === id).reduce((a, e) => a + (e.durationMs || 0), 0),
    }))
    .sort((a, b) => b.ms - a.ms)[0] || null;

  const audience = getAudienceSummary(streamIds, windowMs);
  const delivered = getListeningDelivered(streamIds, windowMs);

  let listenersCutOff = 0;
  let worstIncident = null;
  let longest = null;
  for (const e of failures) {
    const a = e.audience;
    if (a?.listenerMinutesLost) {
      listenersCutOff += a.listenersBefore || 0;
      if (!worstIncident || a.listenerMinutesLost > worstIncident.audience.listenerMinutesLost) {
        worstIncident = e;
      }
    }
    if (e.durationMs && (!longest || e.durationMs > longest.durationMs)) longest = e;
  }

  const perStream = streamIds.map((id) => {
    const mine = failures.filter((e) => e.streamId === id);
    const aud = audience.perStream[id] || {};
    return {
      id,
      uptime: getAudioUptime([id], windowMs),
      probeUptime: getUptime(id, windowMs),
      listenerAffecting: mine.filter(costListeners).length,
      noListenerImpact: mine.filter((e) => !costListeners(e)).length,
      outages: mine.filter((e) => e.severity === 'outage').length,
      deadAir: mine.filter((e) => e.severity === 'dead_air').length,
      unconfirmed: mine.filter((e) => isUnconfirmedSeverity(e.severity)).length,
      // Same exclusion as the totals — otherwise these columns would not add up
      // to the figure they sit beneath. No merge needed: one stream cannot be
      // down concurrently with itself.
      downtimeMs: impactful
        .filter((e) => e.streamId === id)
        .reduce((a, e) => a + (e.durationMs || 0), 0),
      listenerMinutesLost: aud.listenerMinutesLost || 0,
      listenersCutOff: mine.reduce(
        (a, e) => a + (e.audience?.listenerMinutesLost ? e.audience.listenersBefore || 0 : 0), 0,
      ),
      avgListeners: aud.avgListeners ?? null,
      peakListeners: aud.peakListeners ?? null,
    };
  });

  const summarise = (e) => (e && {
    id: e.id,
    timestamp: e.timestamp,
    streamId: e.streamId,
    streamName: e.streamName,
    severity: e.severity,
    durationMs: e.durationMs || null,
    durationLabel: e.durationLabel || null,
    causeLabel: e.diagnosis?.causeLabel || null,
    listenersBefore: e.audience?.listenersBefore ?? null,
    listenerMinutesLost: e.audience?.listenerMinutesLost ?? null,
    emailed: e.email?.sent === true,
  }) || null;

  const coverageStart = getCoverageStart(streamIds);

  const rollup = {
    windowMs,
    days: Math.round((windowMs / 86400000) * 100) / 100,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    // What the audience experienced. Leads everywhere it is shown.
    uptime: getAudioUptime(streamIds, windowMs),
    // The probe-level figure, kept so the two can be compared and so nothing
    // that reported it before silently changes meaning.
    probeUptime: getOverallUptime(streamIds, windowMs),
    coverageStart,
    // A monitor that has only been running two days cannot speak for a week.
    coverageMs: coverageStart ? Math.min(windowMs, until - new Date(coverageStart).getTime()) : 0,
    counts: {
      total: inWindow.length,
      failures: failures.length,
      // Grouped by what the audience experienced — the headline figures.
      listenerAffecting: impactful.length,
      significant: significant.length,
      brief: brief.length,
      incidents: incidents.length,
      noListenerImpact: harmless.length,
      // Grouped by confirmation threshold — a monitoring detail, kept for the
      // timeline filters and for continuity, not for the headline.
      outages: outages.length,
      deadAir: deadAir.length,
      unconfirmed: unconfirmed.length,
      recoveries: inWindow.filter((e) => e.severity === 'recovery').length,
      ongoing,
      streamsAffected: new Set(impactful.map((e) => e.streamId)).size,
    },
    interruptions: {
      // One record per affected stream. A single incident that drops Main and
      // HD3 therefore contributes two records.
      streamRecords: impactful.length,
      sustainedStreamRecords: significant.length,
      briefStreamRecords: brief.length,
      groupedSustainedIncidents: incidents.length,
    },
    // Elapsed time at least one stream was down — what a person means by "how
    // long were we down". The summed figure is kept alongside it because that
    // is the one that reconciles with the uptime percentage.
    downtimeMs: wallClockMs,
    downtime: {
      wallClockMs,
      streamMs,
      // Clear-name aliases for new consumers. The older keys remain stable.
      elapsedOffAirMs: wallClockMs,
      summedStreamMs: streamMs,
      categoryOverlapMs: Math.max(
        0,
        faultSplit.reduce((sum, side) => sum + side.wallClockMs, 0) - wallClockMs,
      ),
      excludedMs: harmless.reduce((a, e) => a + (e.durationMs || 0), 0),
      excludedEvents: harmless.length,
      worstStream,
    },
    alerts: {
      messages: messages.size,
      eventsAlerted: alerted.length,
      notifiable: notifiable.length,
      failed: inWindow.filter((e) => e.email?.attempted && e.email?.sent === false).length,
      suppressed: inWindow.filter(isSuppressed).length,
      // Backfilled events predate delivery tracking — an alert may well have
      // gone out. Counting them as failures would report an outage in the
      // alerting that never happened. An event we deliberately chose not to
      // email is NOT untracked: we know exactly what happened to it.
      untracked: notifiable.filter(
        (e) => e.email?.sent == null && !e.email?.attempted && !isSuppressed(e),
      ).length,
    },
    audience: {
      listenersCutOff,
      // This is repeatable interruption exposure, not distinct people.
      listenerInterruptions: listenersCutOff,
      listenerMinutesLost: audience.listenerMinutesLost,
      listenerHoursLost: audience.listenerHoursLost,
      // The largest audience any single failure took off the air — a plain
      // headcount at one instant, not a total accumulated over the period.
      // Carries WHICH failure it was: the peak rarely belongs to the longest
      // outage, and attributing it to the wrong one is its own small lie.
      peakListenersAffected: peakEvent?.audience?.listenersBefore || 0,
      peakListenersStream: peakEvent?.streamName || null,
      peakListenersAt: peakEvent?.timestamp || null,
      listenerMinutesDelivered: delivered,
      listenerHoursDelivered: Math.round(delivered / 60),
      // Share of everything that could have been listened to. Null rather than
      // zero when nothing was delivered — no listening is not "0% lost".
      lostSharePercent: delivered + audience.listenerMinutesLost > 0
        ? Math.round((audience.listenerMinutesLost / (delivered + audience.listenerMinutesLost)) * 1000) / 10
        : null,
      listenerMinutesLostMeasured: audience.listenerMinutesLostMeasured,
      eventsMissingAudience: audience.eventsMissingAudience,
    },
    perStream,
    causes: getCauseBreakdown(windowMs),
    longestOutage: summarise(longest),
    worstIncident: summarise(worstIncident),
    faultSplit,
    // EVERY outage that cut listeners off, longest first — not a sample of
    // them. Nine rows is nothing to read, and showing three of nine without
    // saying so is what made this list feel disconnected from the totals.
    topIncidents: incidents,
    // Only the brief ones are summarised away, and they are counted in the
    // same unit as the tile that reports them: events, never mixed with
    // incident groups.
    otherIncidents: {
      count: brief.length,
      longestMs: brief.reduce((a, e) => Math.max(a, e.durationMs || 0), 0),
    },
    significantThresholdMs: SIGNIFICANT_OUTAGE_MS,
    generatedAt: new Date().toISOString(),
  };

  rollup.narrative = narrate(rollup);
  return rollup;
}

// ── Status cache ────────────────────────────────────────────────────────────
function getStatusCache() { return streamStatusCache; }
function setStatusCache(s) { streamStatusCache = s; dirtyEvents = true; }

/**
 * Pre-creates the sample and rollup arrays for a set of stream ids.
 *
 * Split out of load() because configuration now lives in this store, which means
 * the ids are not known until after the file has been read. load() therefore
 * runs first with nothing, and the caller calls this once it knows what it is
 * monitoring.
 */
function ensureStreams(streamIds = []) {
  streamIds.forEach((id) => {
    if (!samples[id]) samples[id] = [];
    if (!rollups[id]) rollups[id] = [];
  });
}

// ── Station configuration ───────────────────────────────────────────────────
/**
 * The station/channel/host configuration, or null when none has been stored.
 *
 * Rides in events.json beside `meta` rather than taking a file of its own: it is
 * small, it changes rarely, and it must survive a redeploy on the same
 * persistent volume that already protects the event record.
 *
 * Returns a deep copy. Callers mutate what they are given — an admin panel most
 * of all — and handing out the live object would let an edit take effect without
 * ever being saved, producing configuration that vanishes on the next restart.
 */
function getStationConfig() {
  return config ? JSON.parse(JSON.stringify(config)) : null;
}

function setStationConfig(next) {
  if (!next || typeof next !== 'object') throw new Error('config must be an object');
  config = JSON.parse(JSON.stringify(next));
  dirtyEvents = true;
  return getStationConfig();
}

// ── Small persisted scalars ─────────────────────────────────────────────────
/**
 * Rides along in events.json rather than getting a file of its own. It holds
 * things the monitor must not forget across a redeploy — chiefly when the last
 * weekly roundup went out, without which every container restart would either
 * re-send it or skip it.
 */
function getMeta(key) { return key === undefined ? { ...meta } : meta[key]; }
function setMeta(key, value) {
  meta[key] = value;
  dirtyEvents = true;
  return value;
}

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
        meta,
        config,
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
    maxEvents: MAX_EVENTS,
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
  getUptime, getOverallUptime, getAudioUptime, getCoverageStart, getSummary, getDailyBuckets, getCauseBreakdown,
  getPeriodRollup,
  getStatusCache, setStatusCache, getStorageInfo, getMeta, setMeta,
  ensureStreams, getStationConfig, setStationConfig,
  backfillAudience,
  isUnconfirmedSeverity, settledImpact, costListeners, isFailureEvent,
  getAudienceContext, getHourOfDayProfile, buildAudienceImpact, deriveListenerImpact,
  getListenerSeries, getAudienceSummary, chooseBucketMs,
  getListeningDelivered, getAth, getMonthToDateAth, ATH_MONTHLY_ALLOWANCE,
  getListenerCounts, concurrentBetween, periodBounds,
  getTuneIns, tuneInsFromSamples,
  SAMPLE_RETENTION_DAYS,
  MAX_EVENTS,
};
