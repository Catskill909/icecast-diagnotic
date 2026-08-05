/* ═══════════════════════════════════════════════════════════════════════════
   KPFT Icecast Monitor — Persistent Store
   ───────────────────────────────────────────────────────────────────────────
   Two independent files, on purpose:

     data/events.json   Every outage, blip, recovery and dead-air event.
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
  prune();
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
  appliedSeeds.push(seed.seedId);
  dirtyEvents = true;

  console.log(`[Store] Applied seed '${seed.seedId}': backfilled ${added.length} historical event(s)`);
  if (added.length !== seed.events.length) {
    console.log(`[Store]   (${seed.events.length - added.length} already present, skipped)`);
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
        if (s.listeners != null) {
          b.listenerSum += s.listeners;
          b.listenerCount++;
          b.listenerPeak = Math.max(b.listenerPeak, s.listeners);
        }
      }

      const existing = new Map((rollups[id] || []).map((r) => [r.hour, r]));
      for (const [key, b] of buckets) {
        // Merge rather than overwrite, in case a prune already wrote this hour.
        const prevRoll = existing.get(key);
        const merged = prevRoll
          ? {
              hour: key,
              checks: prevRoll.checks + b.checks,
              up: prevRoll.up + b.up,
              down: prevRoll.down + b.down,
              silent: prevRoll.silent + b.silent,
              avgResponse: Math.round(
                ((prevRoll.avgResponse || 0) * prevRoll.checks + b.responseSum) /
                  Math.max(1, prevRoll.checks + b.responseCount),
              ),
              minResponse: Math.min(prevRoll.minResponse ?? Infinity, b.minResponse ?? Infinity),
              maxResponse: Math.max(prevRoll.maxResponse ?? 0, b.maxResponse ?? 0),
              avgListeners: Math.round(
                ((prevRoll.avgListeners || 0) * prevRoll.checks + b.listenerSum) /
                  Math.max(1, prevRoll.checks + b.listenerCount),
              ),
              listenerPeak: Math.max(prevRoll.listenerPeak || 0, b.listenerPeak),
            }
          : {
              hour: key,
              checks: b.checks,
              up: b.up,
              down: b.down,
              silent: b.silent,
              avgResponse: b.responseCount ? Math.round(b.responseSum / b.responseCount) : null,
              minResponse: b.minResponse,
              maxResponse: b.maxResponse,
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

function getSummary(streamIds, windowMs) {
  const out = {};
  for (const id of streamIds) {
    const evts = events.filter(
      (e) => e.streamId === id && Date.now() - new Date(e.timestamp).getTime() <= windowMs,
    );
    out[id] = {
      uptime: getUptime(id, windowMs),
      outages: evts.filter((e) => e.severity === 'outage').length,
      blips: evts.filter((e) => e.severity === 'blip').length,
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
    if (!out.has(day)) out.set(day, { day, outages: 0, blips: 0, deadAir: 0, recoveries: 0, total: 0 });
    const b = out.get(day);
    b.total++;
    if (e.severity === 'outage') b.outages++;
    else if (e.severity === 'blip') b.blips++;
    else if (e.severity === 'dead_air') b.deadAir++;
    else if (e.severity === 'recovery') b.recoveries++;
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
  getUptime, getSummary, getDailyBuckets, getCauseBreakdown,
  getStatusCache, setStatusCache, getStorageInfo,
  SAMPLE_RETENTION_DAYS,
};
