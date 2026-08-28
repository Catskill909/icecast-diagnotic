/* ═══════════════════════════════════════════════════════════════════════════
   Pacifica Stream Monitor — Check Engine
   ───────────────────────────────────────────────────────────────────────────
   EVENT MODEL

   Every failed check enters the long-term record. Notification is decoupled from
   recording, which is what fixes the old behaviour where an isolated failure
   painted a red mark on the dashboard but left no trace anywhere else.

   An "episode" spans from a stream's first failed check to its recovery.
   Within one episode we record continuously but email at most twice — once
   when it becomes notable, once when it recovers:

     failure #1              → event recorded, unconfirmed          (silent)
     failure #FAILURE_THRESHOLD → promoted to 'outage'   (emails, IF listeners hit)
     recovery                → event resolved with true duration (emails, if alerted)

   WHAT EARNS AN EMAIL. The bar is listener impact, not probe failure. The
   monitor watches from outside the network, so a failed probe on its own proves
   only that OUR connection broke. Icecast is the witness: when it is reachable
   and still lists the mount, the mount kept serving its audience and nothing
   worth waking anyone for happened. Four days of production data made the case —
   of 21 alerts sent under the old rules, 12 were 60-second probe resets in which
   the mounts never dropped a listener, and they trained the recipients to ignore
   the alerts that mattered.

   So an outage emails only when the diagnosis carries listenerImpact of
   'confirmed' (Icecast reachable, mount gone — every connected player dropped)
   or 'unknown' (Icecast unreachable, so we cannot clear it). An outage proven
   harmless is recorded in full and stays silent. Dead air always emails: the
   transport is fine, which is exactly why nobody else would catch it.
   ═══════════════════════════════════════════════════════════════════════════ */

const nodemailer = require('nodemailer');
const diagnose = require('./diagnose');
const store = require('./store');

// ── Default Streams ─────────────────────────────────────────────────────────
const DEFAULT_STREAMS = [
  {
    id: 'kpft-main',
    name: 'KPFT Main',
    url: 'https://streams.pacifica.org:9000/live_128',
    // Every bitrate variant of this channel. Listener counts are summed across
    // them; the probe still runs against `url` alone.
    mounts: ['/live_128', '/live_64'],
    m3u: 'https://docs.pacifica.org/kpft/kpft.m3u',
  },
  {
    id: 'kpft-hd2',
    name: 'KPFT HD2',
    url: 'https://streams.pacifica.org:9000/HD3_128',
    mounts: ['/HD3_128', '/HD3', '/HD3_64'],
    m3u: 'https://docs.pacifica.org/kpft/kpft_hd2.m3u',
  },
  {
    id: 'kpft-hd3',
    name: 'KPFT HD3',
    url: 'https://streams.pacifica.org:9000/classic_country',
    mounts: ['/classic_country'],
    m3u: 'https://docs.pacifica.org/kpft/kpft_hd3.m3u',
  },
];

// ── Configuration ───────────────────────────────────────────────────────────
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 60000;
// How often the NON-primary mounts get probed, counted in check cycles.
//
// Every cycle would be simplest and is wrong twice over. Each probe pulls audio
// (8 KB per mount), so probing every variant every minute roughly doubles the
// monitor's bandwidth against the station's own server. And Icecast counts every
// connection as a listener — measured: one connection took /kpfk from 1 to 2 —
// so a probe on a mount with a handful of listeners is a large fraction of its
// reported audience. At 5 it costs about a fifth of that on both counts and
// still catches a stalled variant inside five minutes.
// Floored at 1 so a stray 0 or negative value means "every cycle" rather than
// a modulo that fires on an arbitrary pattern.
const VARIANT_PROBE_EVERY = Math.max(1, parseInt(process.env.VARIANT_PROBE_EVERY, 10) || 5);
// Consecutive silent variant probes before a mount is called stalled. The
// primary mount has a whole verification engine for this; a variant checked
// every five minutes gets a cheaper version of the same caution, because one
// quiet 8 KB read is a quiet passage at least as often as it is a fault.
const VARIANT_SILENCE_STREAK = 2;
// How long a degraded channel must stay degraded before anyone is emailed.
//
// A degradation is not an outage: the channel keeps playing for most of its
// audience, so it does not warrant the 3am treatment a dead channel gets. But a
// variant that has been dead for half an hour with listeners on it is a real
// loss that nobody would otherwise find out about — the dashboard would show it
// and no one is watching the dashboard at 4am. Sustained AND costing listeners
// is the bar; either one alone stays silent and recorded.
// Set to 0 to disable degraded alerting entirely.
const DEGRADED_ALERT_AFTER_MS = Math.max(0, parseInt(process.env.DEGRADED_ALERT_AFTER_MS, 10) || 30 * 60 * 1000);
const FAILURE_THRESHOLD = parseInt(process.env.FAILURE_THRESHOLD, 10) || 2;
const SILENCE_PROBE_INTERVAL_MS = parseInt(process.env.SILENCE_PROBE_INTERVAL_MS, 10) || 5000;
const SILENCE_FAILURE_THRESHOLD = parseInt(process.env.SILENCE_FAILURE_THRESHOLD, 10) || 3;
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL_MS, 10) || 60 * 1000;
// Escape hatch: alert on every confirmed outage, even ones Icecast proves did
// not touch a single listener. Off by default — that behaviour is what buried
// the real alerts in noise. Tolerant of case and stray whitespace, because this
// gets typed into a hosting-panel text field where a capitalised value or a
// pasted tab would otherwise leave alerts silently switched on.
// Which stations may send email. Empty means all of them, which is what a
// single-station deployment has always had.
//
// Recipients are still one global list, so every station's alerts reach the same
// inbox. Until they are per-station, adding a station to the panel silently
// signs KPFT's recipients up for its outages — a GM paged at 3am about a station
// in another city.
//
// This is the stopgap and it is also a real setting: a station being trialled,
// or one whose staff have not been onboarded yet, should be recorded in full and
// email nobody.
const ALERT_STATIONS = (process.env.ALERT_STATIONS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ALERT_ON_HARMLESS_OUTAGE =
  String(process.env.ALERT_ON_HARMLESS_OUTAGE ?? '').trim().toLowerCase() === 'true';

// ── Weekly roundup schedule ─────────────────────────────────────────────────
// Every timestamp a human reads is in the station's own timezone, so the report
// covers the week they lived through rather than a UTC one.
const STATION_TZ = process.env.STATION_TZ || 'America/Chicago';
const WEEKLY_ROUNDUP_ENABLED =
  String(process.env.WEEKLY_ROUNDUP ?? 'true').trim().toLowerCase() !== 'false';
// 0 = Sunday. Monday morning by default: the week it reports on is complete.
const WEEKLY_ROUNDUP_DAY = clampInt(process.env.WEEKLY_ROUNDUP_DAY, 1, 0, 6);
const WEEKLY_ROUNDUP_HOUR = clampInt(process.env.WEEKLY_ROUNDUP_HOUR, 9, 0, 23);
const WEEKLY_ROUNDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROUNDUP_TICK_MS = 5 * 60 * 1000;
const ROUNDUP_MAX_ATTEMPTS = 4;

function clampInt(raw, fallback, min, max) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Severity for a failure that has not yet reached FAILURE_THRESHOLD. Split in
// two because one label cannot honestly cover both: a vanished mount really did
// cut listeners off mid-song, while a probe reset against a healthy mount cost
// nobody anything. Calling both a "blip" made the first sound trivial and the
// second sound alarming.
const BRIEF_OUTAGE = 'brief_outage';  // real gap, cleared before confirmation
const PROBE_ERROR = 'probe_error';    // our probe failed; Icecast served on

/**
 * May this stream's station send email?
 *
 * Recording is unaffected — every failure still enters the permanent record,
 * because a station that does not email is not a station nobody is watching.
 * Only the notification is withheld, and the event says so.
 */
function alertsEnabledFor(stream) {
  if (!ALERT_STATIONS.length) return true;
  return ALERT_STATIONS.includes(String(stream?.stationId || '').toLowerCase());
}

function unconfirmedSeverity(diagnosisResult) {
  return diagnosisResult?.listenerImpact === 'none' ? PROBE_ERROR : BRIEF_OUTAGE;
}

// An outage is worth an email unless Icecast positively cleared it.
function warrantsAlert(diagnosisResult) {
  if (ALERT_ON_HARMLESS_OUTAGE) return true;
  return diagnosisResult?.listenerImpact !== 'none';
}

// Worst verdict seen across an episode. An episode is judged by its most severe
// moment: one check that caught the mount missing means listeners were dropped,
// regardless of what the checks either side of it saw.
const IMPACT_RANK = { confirmed: 2, unknown: 1, none: 0 };
function worstImpact(a, b) {
  return (IMPACT_RANK[b] ?? 0) > (IMPACT_RANK[a] ?? 0) ? b : (a ?? 'none');
}

// ── State ───────────────────────────────────────────────────────────────────
let streams = [];
let streamStatus = {};
let silenceState = {};
let episodes = {};        // { [streamId]: { eventId, startedAt, alerted, severity } }
// Kept apart from `episodes` deliberately. A degraded channel is still
// playing, so it must not close, reopen, or otherwise disturb the outage
// episode for the same stream — the two can legitimately overlap.
let degradedEpisodes = {};  // { [streamId]: { eventId, startedAt, impaired, listenersBefore } }
// Per-mount probe verdicts, held BETWEEN variant-probe cycles. Recomputing
// degradation from an empty map on the four cycles in between would make a
// stalled variant look healthy again and flap the episode open and closed
// every minute.
let variantHealth = {};   // { [streamId]: { [mountPath]: { ok, reason, silentStreak } } }
let cycleCount = 0;
let snapshot = null;      // latest Icecast snapshot
let prevSnapshot = null;
let intervalHandle = null;
let checkInFlight = false;   // guards against overlapping check cycles
let flushHandle = null;
let roundupHandle = null;
let roundupAttempts = { day: null, count: 0 };  // send retries for today's slot
let transporter = null;

// ── Initialize ──────────────────────────────────────────────────────────────
/**
 * Normalises one stream definition from configuration.
 *
 * Spreads the source object rather than rebuilding it from a fixed list of
 * fields. The old whitelist silently dropped anything it did not name, which is
 * how an env-configured station lost its `mounts` list — and with it the
 * channel grouping that makes listener counts correct. Any field added later
 * would have vanished the same way, so the shape is preserved by default and
 * only the fields with defaults or validation are overridden.
 */
function normaliseStream(s, i) {
  return {
    ...s,
    id: s.id || `stream-${i}`,
    name: s.name || `Stream ${i + 1}`,
    url: s.url,
    m3u: s.m3u || '',
    mounts: normaliseMounts(s.mounts),
  };
}

/**
 * Mount lists reduce to Icecast pathnames, because that is how the snapshot is
 * keyed. Full URLs are accepted and reduced, so a station configured by pasting
 * stream URLs — which is exactly what an admin UI will produce — still groups.
 * Returns undefined when nothing usable was given, leaving the stream to fall
 * back to its probed URL alone.
 */
function normaliseMounts(raw) {
  if (!Array.isArray(raw)) return undefined;
  const paths = raw
    .map((m) => {
      if (typeof m !== 'string') return null;
      const t = m.trim();
      if (!t) return null;
      if (t.startsWith('/')) return t;
      try { return new URL(t).pathname; } catch { return null; }
    })
    .filter(Boolean);
  return paths.length ? [...new Set(paths)] : undefined;
}

function normaliseStreams(parsed) {
  if (!Array.isArray(parsed)) throw new Error('STREAMS must be a JSON array');
  return parsed.map(normaliseStream);
}

/** Streams from the STREAMS env var, or null when it is unset or unusable. */
function readStreamsFromEnv() {
  if (!process.env.STREAMS) return null;
  try {
    return normaliseStreams(JSON.parse(process.env.STREAMS));
  } catch (e) {
    console.error('[Monitor] Failed to parse STREAMS env var, ignoring it:', e.message);
    return null;
  }
}

/**
 * Builds the initial station configuration from a flat list of streams.
 *
 * Hosts are derived from the stream URLs and kept as a top-level pool rather
 * than a property of the station. Many stations share one Icecast server — all
 * five Pacifica sister stations are on one, ~28 affiliates on another — so the
 * check cycle must be able to fetch each host's inventory once and serve every
 * station on it. A minority of stations also span more than one host, which a
 * station-owns-its-server shape could not represent at all.
 */
function buildDefaultConfig(streamList) {
  const hosts = {};
  for (const s of streamList) {
    let u;
    try { u = new URL(s.url); } catch { continue; }
    if (hosts[u.host]) continue;
    hosts[u.host] = {
      id: u.host.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      host: u.host,
      // Honour an explicit status URL when one is configured; otherwise the
      // conventional Icecast path on the same origin.
      statusUrl: process.env.ICECAST_STATUS_URL || `${u.protocol}//${u.host}/status-json.xsl`,
    };
  }

  return {
    version: 1,
    seededAt: new Date().toISOString(),
    hosts: Object.values(hosts),
    stations: [{
      id: process.env.STATION_ID || 'kpft',
      name: process.env.STATION_NAME || process.env.STATION_LABEL || 'KPFT Houston',
      timezone: STATION_TZ,
      channels: streamList,
    }],
  };
}

/**
 * Flattens the station/channel tree into the flat stream list the check engine
 * works on. Channel ids become stream ids unchanged, which is what keeps the
 * stored samples, rollups and events attached to their history across this
 * change.
 */
function flattenChannels(cfg) {
  const out = [];
  for (const station of cfg?.stations || []) {
    for (const channel of station.channels || []) {
      out.push({ ...channel, stationId: station.id, stationName: station.name });
    }
  }
  return out;
}

/** Fresh per-stream state. Shared by init() and reloadConfig() so they cannot drift. */
function initStreamState(s) {
  streamStatus[s.id] = {
    status: 'unknown',
    responseTime: null,
    lastChecked: null,
    consecutiveFailures: 0,
    error: null,
  };
  silenceState[s.id] = { streak: 0, state: 'normal', timer: null };
}

/**
 * Applies the stored configuration to a RUNNING monitor.
 *
 * Without this, adding a station through the admin panel would write to the
 * store and change nothing until someone redeployed — "please restart the
 * service to finish adding your station" being a poor answer from a system
 * whose entire job is not stopping.
 *
 * Three things have to be handled, and only the first is obvious:
 *
 *   1. New channels need their per-stream state and their sample arrays.
 *   2. Removed channels leave a pending silence-probe timer behind, which would
 *      fire against a stream no longer being monitored.
 *   3. Removed channels may have an OPEN episode. Leaving it open would count as
 *      an ongoing failure forever in every rollup; inventing a recovery event
 *      would claim an observation nobody made. It is closed as an abandoned
 *      episode instead, which is what actually happened.
 *
 * Stored history for a removed channel is left untouched. Configuration says
 * what to watch from now on; it is not a statement about the past.
 */
/**
 * Closes an episode that was still open when its channel stopped being monitored.
 *
 * Neither obvious option is honest. Leaving it open counts as an ongoing failure
 * in every rollup, forever. Writing a recovery event claims an observation
 * nobody made — the stream may well still be down.
 *
 * So it is resolved, but marked `abandoned` with the reason recorded, which is
 * what actually happened: watching stopped while it was still failing.
 */
function abandonEpisode(streamId, episode, timestamp = new Date().toISOString()) {
  const startedMs = new Date(episode?.startedAt).getTime();
  const durationMs = Number.isFinite(startedMs) ? Date.parse(timestamp) - startedMs : null;
  const updated = store.updateEvent(episode.eventId, {
    resolvedAt: timestamp,
    durationMs,
    durationLabel: durationMs != null ? diagnose.fmtDuration(durationMs) : null,
    abandoned: true,
    resolutionNote:
      'Monitoring stopped — channel removed from configuration while still failing. ' +
      'Recovery was never observed.',
  });
  console.log('[Monitor] Closed open episode for removed channel ' + streamId + ' as abandoned');
  return updated;
}

function reloadConfig() {
  const cfg = store.getStationConfig();
  if (!cfg) return { changed: false, added: [], removed: [], reason: 'no configuration stored' };

  const next = normaliseStreams(flattenChannels(cfg));
  if (!next.length) {
    // Refuse rather than silently monitor nothing.
    return { changed: false, added: [], removed: [], reason: 'configuration contains no channels' };
  }

  const prevById = new Map(streams.map((s) => [s.id, s]));
  const nextIds = new Set(next.map((s) => s.id));

  const added = next.filter((s) => !prevById.has(s.id));
  const removed = streams.filter((s) => !nextIds.has(s.id));
  const timestamp = new Date().toISOString();

  added.forEach(initStreamState);
  if (added.length) store.ensureStreams(added.map((s) => s.id));

  for (const s of removed) {
    const st = silenceState[s.id];
    if (st && st.timer) clearTimeout(st.timer);
    delete silenceState[s.id];
    delete streamStatus[s.id];

    const ep = episodes[s.id];
    if (ep) {
      abandonEpisode(s.id, ep, timestamp);
      delete episodes[s.id];
    }

    // A degradation episode is an open, unresolved event exactly like an outage
    // one. Left behind, it stays open forever and is counted as an ongoing fault
    // on a channel nobody is watching any more.
    const dep = degradedEpisodes[s.id];
    if (dep) {
      abandonEpisode(s.id, dep, timestamp);
      delete degradedEpisodes[s.id];
    }
    delete variantHealth[s.id];
  }

  // Definitions of surviving channels are replaced, so an edited mount list or a
  // renamed channel takes effect without a restart.
  streams = next;

  // Drop per-mount verdicts for mounts a surviving channel no longer publishes.
  // Kept, they would hold a degradation open against a mount the operator has
  // deliberately removed, which cannot recover because nothing probes it now.
  for (const s of streams) {
    const health = variantHealth[s.id];
    if (!health) continue;
    const live = new Set(diagnose.channelMountPaths(s));
    for (const path of Object.keys(health)) {
      if (!live.has(path)) delete health[path];
    }
  }
  store.setStatusCache(streamStatus);

  const changed = added.length > 0 || removed.length > 0;
  if (changed) {
    console.log(
      '[Monitor] Configuration reloaded — ' + next.length + ' channel(s): +' +
      added.length + ' added, -' + removed.length + ' removed',
    );
  }
  return { changed, added: added.map((s) => s.id), removed: removed.map((s) => s.id), total: next.length };
}

/**
 * Writes configuration and applies it in one step.
 *
 * Kept together so the invariant cannot drift: configuration that has been saved
 * but not reloaded is configuration the operator believes is live and is not.
 *
 * Saved synchronously rather than waiting for the periodic flush. Configuration
 * changes are rare and deliberate; losing a station somebody just added because
 * the container restarted within the flush window would be a genuinely
 * infuriating way to lose work.
 */
function saveStationConfig(next) {
  store.setStationConfig(next);
  const result = reloadConfig();
  store.save(true);

  // Probe straight away. Otherwise a station added at second 5 of a cycle reads
  // 'unknown' for the next 55, which looks like something went wrong at exactly
  // the moment someone is watching to see whether it worked.
  if (result.added && result.added.length) {
    runChecks().catch((err) => console.error('[Monitor] Post-add check failed:', err.message));
  }
  return result;
}

function init() {
  // Read the store first: the configuration lives in it, so what to monitor is
  // not known until this returns.
  store.load();

  let cfg = store.getStationConfig();
  const reseed = String(process.env.CONFIG_RESEED ?? '').trim().toLowerCase() === 'true';

  if (!cfg || reseed) {
    // First boot on this volume (or an explicit reseed). Env vars seed the
    // configuration once; from then on the store is authoritative and changes
    // to STREAMS are ignored. Set CONFIG_RESEED=true to overwrite it.
    const seed = readStreamsFromEnv() || DEFAULT_STREAMS;
    cfg = buildDefaultConfig(seed);
    store.setStationConfig(cfg);
    console.log(
      `[Monitor] ${reseed ? 'RESEEDED' : 'Seeded'} configuration from ` +
      `${process.env.STREAMS ? 'STREAMS env var' : 'built-in defaults'} — ` +
      `${cfg.stations.length} station(s), ${flattenChannels(cfg).length} channel(s)`,
    );
  }

  streams = normaliseStreams(flattenChannels(cfg));
  store.ensureStreams(streams.map((s) => s.id));

  streams.forEach(initStreamState);

  // Restore last known status, but never carry a failure streak across a
  // restart — that would let a stale count trigger a spurious alert.
  const cached = store.getStatusCache();
  for (const id of Object.keys(cached || {})) {
    if (streamStatus[id]) {
      streamStatus[id] = { ...cached[id], consecutiveFailures: 0, status: 'unknown' };
    }
  }

  setupMailer();

  console.log(`[Monitor] Initialized with ${streams.length} streams`);
  console.log(`[Monitor] Check interval: ${CHECK_INTERVAL}ms, Failure threshold: ${FAILURE_THRESHOLD}`);
  console.log(`[Monitor] Email alerts: ${ALERT_STATIONS.length ? 'only ' + ALERT_STATIONS.join(', ') : 'every station'}`);
  console.log(`[Monitor] Retention: newest ${store.MAX_EVENTS} events, raw samples ${store.SAMPLE_RETENTION_DAYS}d then hourly rollups`);
}

// ── SMTP Setup ──────────────────────────────────────────────────────────────
function setupMailer() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT, 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[Monitor] SMTP not configured — email alerts disabled');
    return;
  }

  transporter = nodemailer.createTransport({
    host,
    port: port || 587,
    secure: port === 465,
    auth: { user, pass },
  });

  transporter.verify()
    .then(() => console.log('[Monitor] SMTP connection verified'))
    .catch((err) => console.error('[Monitor] SMTP verification failed:', err.message));
}

// ── Aggressive Silence Verification Engine ──────────────────────────────────
function scheduleAggressiveProbe(stream) {
  const st = silenceState[stream.id];
  if (st.timer) clearTimeout(st.timer);

  st.timer = setTimeout(async () => {
    st.timer = null;
    const probeNum = st.streak + 1;
    console.log(`[Silence Engine] Aggressive verification probe for ${stream.name} (Probe ${probeNum}/${SILENCE_FAILURE_THRESHOLD})`);

    // ~32KB ≈ 2s of audio — enough to survive a natural speech pause.
    const result = await diagnose.probeStream(stream, 32768);
    const timestamp = new Date().toISOString();

    if (result.status === 'down') return; // connection failure owned by the main cycle

    if (!result.isSilent) {
      const wasDeadAir = st.state === 'dead_air';
      console.log(`[Silence Engine] 🟢 Audio detected on ${stream.name} (energy ${result.audioEnergy}) — resetting streak.`);

      st.streak = 0;
      st.state = 'normal';

      if (streamStatus[stream.id]) {
        Object.assign(streamStatus[stream.id], {
          isSilent: false,
          audioEnergy: result.audioEnergy,
          silenceState: 'normal',
          silenceStreak: 0,
        });
      }

      if (wasDeadAir) await resolveDeadAir(stream, result, timestamp);
      return;
    }

    st.streak += 1;

    if (st.streak < SILENCE_FAILURE_THRESHOLD) {
      st.state = 'evaluating';
      if (streamStatus[stream.id]) {
        streamStatus[stream.id].silenceState = 'evaluating';
        streamStatus[stream.id].silenceStreak = st.streak;
      }
      console.warn(`[Silence Engine] 🟡 Silence probe ${st.streak}/${SILENCE_FAILURE_THRESHOLD} on ${stream.name}.`);
      scheduleAggressiveProbe(stream);
    } else {
      st.state = 'dead_air';
      if (streamStatus[stream.id]) {
        streamStatus[stream.id].silenceState = 'dead_air';
        streamStatus[stream.id].silenceStreak = st.streak;
      }
      const durationSec = Math.round((st.streak * SILENCE_PROBE_INTERVAL_MS) / 1000);
      console.error(`[Silence Engine] 🔴 DEAD AIR confirmed on ${stream.name} (~${durationSec}s of continuous silence).`);

      const dg = diagnose.classify({
        stream, result, snapshot, prevSnapshot,
        cycle: [{ stream, result }], deadAir: true,
      });

      const event = store.addEvent({
        timestamp,
        streamId: stream.id,
        streamName: stream.name,
        type: 'dead_air',
        severity: 'dead_air',
        confirmed: true,
        scope: 'stream',
        message: `${stream.name} has DEAD AIR — continuous silence confirmed for ${durationSec}s+`,
        detail: { audioEnergy: result.audioEnergy, silenceStreak: st.streak, durationSec },
        diagnosis: dg,
        email: { attempted: false, sent: null },
      });

      episodes[stream.id] = {
        eventId: event.id, startedAt: timestamp, alerted: true, severity: 'dead_air',
      };

      const emailResult = await sendAlert({
        kind: 'dead_air',
        entries: [{
          stream, result, diagnosis: dg,
          // Dead air keeps listeners connected to silence, so the whole current
          // audience is exposed to it — the same reach figure applies.
          audience: store.getAudienceContext(stream.id, timestamp),
        }],
        scope: 'stream',
      });
      store.updateEvent(event.id, { email: emailResult });
      store.saveEvents();
    }
  }, SILENCE_PROBE_INTERVAL_MS);
}

async function resolveDeadAir(stream, result, timestamp) {
  const episode = episodes[stream.id];
  const dg = diagnose.classify({
    stream, result, snapshot, prevSnapshot, cycle: [{ stream, result }],
  });

  let audience = null;
  let deadAirMs = null;
  if (episode?.eventId) {
    deadAirMs = new Date(timestamp) - new Date(episode.startedAt);
    // Dead air keeps listeners connected — they are hearing silence rather than
    // being disconnected — so the audience is still fully exposed to it and the
    // same listener-minutes unit applies.
    audience = store.buildAudienceImpact(stream.id, episode.startedAt, deadAirMs, 'confirmed');
    store.updateEvent(episode.eventId, {
      resolvedAt: timestamp,
      durationMs: deadAirMs,
      durationLabel: diagnose.fmtDuration(deadAirMs),
      audience,
    });
  }

  const event = store.addEvent({
    timestamp,
    streamId: stream.id,
    streamName: stream.name,
    type: 'up',
    severity: 'recovery',
    confirmed: true,
    scope: 'stream',
    message: `${stream.name} audio output restored — dead air cleared`,
    relatedTo: episode?.eventId || null,
    durationMs: deadAirMs,
    durationLabel: deadAirMs != null ? diagnose.fmtDuration(deadAirMs) : null,
    audience,
    diagnosis: dg,
    email: { attempted: false, sent: null },
  });

  delete episodes[stream.id];

  const emailResult = await sendAlert({
    kind: 'recovery',
    entries: [{ stream, result, diagnosis: dg, audience, durationMs: deadAirMs }],
    scope: 'stream',
    recoveredFrom: 'dead air',
  });
  store.updateEvent(event.id, { email: emailResult });
  store.saveEvents();
}

/**
 * Probes the non-primary mounts of every channel.
 *
 * Only mounts Icecast currently lists are probed. One it has already dropped is
 * MISSING, which the inventory reports for free — spending a connection to
 * rediscover that would cost bandwidth to learn nothing.
 *
 * A failed connection is conclusive on its own: Icecast advertised the mount and
 * would not serve it. Silence is not, so it has to repeat before it counts —
 * one quiet 8 KB read is a quiet passage at least as often as it is dead air.
 */
async function probeVariants(snap) {
  const jobs = [];
  for (const stream of streams) {
    const paths = diagnose.channelMountPaths(stream);
    // Skip paths[0]: that is the primary, probed every cycle by the main loop.
    for (const path of paths.slice(1)) {
      if (!snap?.mounts?.[path]) continue;
      jobs.push({ stream, path });
    }
  }
  if (!jobs.length) return;

  const results = await Promise.all(
    jobs.map((j) => diagnose.probeStream({ ...j.stream, url: diagnose.mountUrl(j.stream, j.path) })),
  );

  jobs.forEach((job, i) => {
    const result = results[i];
    const byStream = (variantHealth[job.stream.id] ||= {});
    const prev = byStream[job.path] || { silentStreak: 0 };

    if (result.status === 'down') {
      byStream[job.path] = {
        ok: false,
        reason: result.error || result.errorCode || 'not serving',
        silentStreak: 0,
      };
      console.warn(`[Monitor] ◐ ${job.stream.name} variant ${job.path} is listed but not serving — ${result.error || result.errorCode}`);
      return;
    }

    if (result.isSilent) {
      const silentStreak = (prev.silentStreak || 0) + 1;
      const ok = silentStreak < VARIANT_SILENCE_STREAK;
      byStream[job.path] = { ok, reason: ok ? null : 'serving silence', silentStreak };
      if (!ok) {
        console.warn(`[Monitor] ◐ ${job.stream.name} variant ${job.path} is serving silence (${silentStreak} consecutive probes)`);
      }
      return;
    }

    byStream[job.path] = { ok: true, reason: null, silentStreak: 0 };
  });
}

/**
 * Opens, holds, and closes the degradation episode for one channel.
 *
 * A degradation is recorded whenever Icecast stops listing one of a channel's
 * mounts while still listing the others. Recording is decoupled from notifying,
 * exactly as it is for outages: the event is always written, and the
 * listener-impact verdict on it decides whether anyone should be told. A
 * variant nobody was listening to is a real fact about the encoder and a
 * non-event for the audience, and the record should be able to say both.
 *
 * No email is sent from here. A missing variant leaves the channel playing for
 * most of its audience, which does not meet the bar the alert policy sets for
 * waking someone up — see the listener-impact gate at the top of this file.
 *
 * One event spans the whole episode. A variant that has been down for a week is
 * one degradation that has not ended yet, not ten thousand check cycles' worth
 * of them.
 */
function trackVariantDegradation(stream, degradation, timestamp, notices = null) {
  const open = degradedEpisodes[stream.id];

  if (degradation.degraded) {
    if (open) {
      // Held open, and widened if the fault spreads. The recorded set is the
      // UNION over the episode, not a snapshot of this instant: a second variant
      // dropping is the same degradation getting worse, and a variant that comes
      // back mid-episode was still down for part of it. An event that only
      // described the current instant would end up describing the last cycle
      // rather than what happened.
      const known = new Set(open.impaired.map((m) => m.path));
      const added = degradation.impaired.filter((m) => !known.has(m.path));
      if (added.length) {
        open.impaired = [...open.impaired, ...added.map(summariseImpaired)];
        open.listenersBefore += added.reduce((sum, m) => sum + (m.listenersBefore || 0), 0);
        store.updateEvent(open.eventId, {
          message: degradationMessage(stream, open.impaired, degradation.total),
          detail: { ...open.detail, impaired: open.impaired, listenersBefore: open.listenersBefore },
          lastCheckAt: timestamp,
        });
      }

      // Sustained, and it cost listeners. Escalate once — never per cycle.
      const heldMs = new Date(timestamp) - new Date(open.startedAt);
      if (
        notices
        && !open.alerted
        && DEGRADED_ALERT_AFTER_MS > 0
        && heldMs >= DEGRADED_ALERT_AFTER_MS
        && open.listenersBefore > 0
      ) {
        open.alerted = true;
        notices.alerts.push({ stream, episode: open, heldMs });
      }
      return;
    }

    const impaired = degradation.impaired.map(summariseImpaired);
    // Frozen now. For a missing mount the previous snapshot is the last place
    // its audience is recorded at all — see channelDegradation().
    const listenersBefore = degradation.listenersBefore;
    const impact = degradation.listenersKnown
      ? (listenersBefore > 0 ? 'confirmed' : 'none')
      // The variant was already failing when we started watching, so no listener
      // count for it was ever observed. 'unknown' is the honest answer and, per
      // the convention throughout this codebase, groups with 'confirmed' rather
      // than being quietly written off.
      : 'unknown';

    const detail = {
      present: degradation.present,
      total: degradation.total,
      impaired,
      listenersBefore,
      listenersKnown: degradation.listenersKnown,
    };

    const event = store.addEvent({
      timestamp,
      streamId: stream.id,
      streamName: stream.name,
      type: 'degraded',
      severity: 'degraded',
      confirmed: true,   // Icecast's inventory, or a direct probe. No threshold to pass.
      scope: 'stream',
      message: degradationMessage(stream, impaired, degradation.total),
      detail,
      diagnosis: {
        causeLabel: impaired.every((m) => m.reason === 'stalled')
          ? 'Mount listed but not serving'
          : 'Mount missing from Icecast',
        listenerImpact: impact,
        scope: 'stream',
      },
      email: {
        attempted: false,
        sent: null,
        reason: 'channel still serving its remaining mounts — recorded, not alerted',
      },
    });

    degradedEpisodes[stream.id] = {
      eventId: event.id,
      startedAt: timestamp,
      impaired,
      listenersBefore,
      detail,
    };

    console.warn(
      `[Monitor] ◐ ${stream.name} degraded — ${degradation.working}/${degradation.total} mounts serving, ` +
      `${impaired.map((m) => `${m.path} (${m.reason})`).join(' ')}` +
      (degradation.listenersKnown ? ` — ${listenersBefore} listener(s) affected` : ' — prior audience unknown'),
    );
    return;
  }

  // Not degraded. Close any open episode — including when the channel has gone
  // fully down, where the outage event is the truthful record of what happened
  // and a still-open degradation alongside it would double-count the fault.
  if (open) {
    const durationMs = new Date(timestamp) - new Date(open.startedAt);
    store.updateEvent(open.eventId, {
      resolvedAt: timestamp,
      durationMs,
      durationLabel: diagnose.fmtDuration(durationMs),
    });
    delete degradedEpisodes[stream.id];
    console.log(`[Monitor] ✓ ${stream.name} serving all mounts again after ${diagnose.fmtDuration(durationMs)}`);

    // An alert that never gets an all-clear trains people to ignore the next
    // one. Only episodes that actually emailed produce one — a degradation
    // nobody was told about needs no announcement that it ended.
    if (notices && open.alerted) {
      notices.recoveries.push({ stream, episode: open, durationMs });
    }
  }
}

/**
 * Sends at most one degradation email and one all-clear per cycle.
 *
 * Separate from dispatchNotifications() on purpose. That function consolidates
 * OUTAGES, and folding a degraded channel into an outage message would tell a
 * station its stream is down when it is playing — the single most damaging thing
 * an alert can get wrong.
 */
async function dispatchDegradedNotices({ alerts, recoveries }) {
  if (alerts.length) {
    const entries = alerts.map(({ stream, episode, heldMs }) => ({
      stream,
      // The probe never failed — that is the whole point of a degradation — so
      // there is no result to report. Synthesised the same way
      // previewAlertForEvent() does it, from what the episode knows.
      result: { httpStatus: null, error: null, errorCode: null, responseTime: 0, timings: {} },
      diagnosis: {
        causeLabel: degradationCauseLabel(episode.impaired),
        listenerImpact: 'confirmed',
        scope: 'stream',
        evidence: [
          `${episode.impaired.map((m) => `${m.path} (${m.reason})`).join(', ')} — unserved for ${diagnose.fmtDuration(heldMs)}.`,
          'The channel is still playing on its remaining mounts, so most listeners are unaffected.',
        ],
      },
      audience: { listenersBefore: episode.listenersBefore },
    }));

    const emailResult = await sendAlert({
      kind: 'degraded',
      entries,
      scope: 'stream',
      consolidated: entries.length > 1,
    });
    for (const { episode } of alerts) store.updateEvent(episode.eventId, { email: emailResult });
  }

  if (recoveries.length) {
    const entries = recoveries.map(({ stream, episode, durationMs }) => ({
      stream,
      result: { httpStatus: null, error: null, errorCode: null, responseTime: 0, timings: {} },
      diagnosis: { causeLabel: degradationCauseLabel(episode.impaired), scope: 'stream' },
      audience: { listenersBefore: episode.listenersBefore },
      durationMs,
    }));
    await sendAlert({
      kind: 'recovery',
      entries,
      scope: 'stream',
      consolidated: entries.length > 1,
      recoveredFrom: 'a degraded channel',
    });
  }

  if (alerts.length || recoveries.length) store.saveEvents();
}

/** Which of the two variant faults to name, when an episode carries both. */
function degradationCauseLabel(impaired) {
  return (impaired || []).every((m) => m.reason === 'stalled')
    ? 'Mount listed but not serving'
    : 'Mount missing from Icecast';
}

/** The storable form: the path, why it is failing, and the detail if there is one. */
function summariseImpaired(m) {
  return { path: m.path, reason: m.reason, detail: m.detail || null };
}

/** One sentence naming what is failing and how — the message an operator acts on. */
function degradationMessage(stream, impaired, total) {
  const missing = impaired.filter((m) => m.reason === 'missing').map((m) => m.path);
  const stalled = impaired.filter((m) => m.reason === 'stalled').map((m) => m.path);
  const parts = [];
  if (missing.length) parts.push(`Icecast is not listing ${missing.join(', ')}`);
  if (stalled.length) parts.push(`${stalled.join(', ')} listed but not serving audio`);
  return `${stream.name} is serving ${total - impaired.length} of ${total} mounts — ${parts.join('; ')}`;
}

// ── Run Check Cycle ─────────────────────────────────────────────────────────
async function runChecks() {
  // Cycles must not overlap. Each one writes a sample per channel stamped with
  // its start time, so two in flight together would write two samples for the
  // same instant and corrupt the uptime arithmetic that reads them.
  //
  // Harmless at three channels, where a cycle takes under a second. Not harmless
  // at thirty-three, where a slow or unreachable host can push a cycle past the
  // sixty-second interval and the next one starts on top of it.
  if (checkInFlight) {
    console.warn('[Monitor] Previous check cycle still running — skipping this tick');
    return;
  }
  checkInFlight = true;
  try {
    return await runChecksInner();
  } finally {
    checkInFlight = false;
  }
}

async function runChecksInner() {
  const timestamp = new Date().toISOString();

  cycleCount += 1;
  prevSnapshot = snapshot;

  // The snapshot is fetched BEFORE any probe connection is opened, not
  // alongside it.
  //
  // Icecast counts every connection as a listener, ours included — measured
  // directly: opening one connection took /kpfk from 1 listener to 2. These two
  // used to run in the same Promise.all, which put our own probe inside the
  // listener counts we then recorded and stored, on every probed mount. Reading
  // the inventory first means the only connections in it are real ones; ours
  // open afterwards and are gone long before the next cycle reads it again.
  const snap = await diagnose.fetchIcecastSnapshot();
  snapshot = snap;

  const results = await Promise.all(streams.map((s) => diagnose.probeStream(s)));

  // The other bitrate variants, on a slower schedule — see VARIANT_PROBE_EVERY.
  // This is the only thing that can see a mount Icecast still lists but which
  // is not actually serving audio.
  if (cycleCount % VARIANT_PROBE_EVERY === 1 % VARIANT_PROBE_EVERY) {  // cycles 1, 6, 11, … at the default of 5
    await probeVariants(snap);
  }

  const cycle = streams.map((s, i) => ({ stream: s, result: results[i] }));
  const downCount = cycle.filter((c) => c.result.status === 'down').length;
  const allDown = downCount === streams.length && streams.length > 0;

  console.log(
    `[Monitor] Cycle ${timestamp} — ${streams.length - downCount}/${streams.length} up` +
    (snap.reachable ? ` · Icecast OK (${snap.mountCount} mounts)` : ` · Icecast UNREACHABLE (${snap.fetchError})`),
  );

  const newlyNotable = [];   // episodes that just became worth emailing
  const recoveries = [];     // episodes that just ended
  // Degradation alerts are collected rather than sent inline, so several
  // channels degrading together produce one message instead of five.
  const degradedNotices = { alerts: [], recoveries: [] };

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const result = results[i];
    const prev = streamStatus[stream.id] || {};
    const wasDown = prev.status === 'down';
    const isDown = result.status === 'down';
    const mount = diagnose.findMount(snap, stream);
    // The channel as a whole: every bitrate variant, summed.
    const audience = diagnose.channelAudience(snap, stream);
    // Whether the channel is serving all of its variants, which the probe
    // cannot see: it only ever asks the primary mount.
    const degradation = diagnose.channelDegradation(snap, prevSnapshot, stream, variantHealth[stream.id] || {});

    // ── Silence tracking (only meaningful while the stream is reachable) ────
    const st = silenceState[stream.id];
    if (!isDown) {
      if (!result.isSilent) {
        if (st.state !== 'normal') {
          const wasDeadAir = st.state === 'dead_air';
          console.log(`[Silence Engine] 🟢 Routine check found audio on ${stream.name} (energy ${result.audioEnergy}).`);
          if (st.timer) clearTimeout(st.timer);
          st.streak = 0;
          st.state = 'normal';
          st.timer = null;
          if (wasDeadAir) await resolveDeadAir(stream, result, timestamp);
        }
      } else if (st.state === 'normal') {
        st.streak = 1;
        st.state = 'evaluating';
        console.warn(`[Silence Engine] 🟡 Initial silence on ${stream.name} — starting verification probes.`);
        scheduleAggressiveProbe(stream);
      }
    }

    const failures = isDown ? (prev.consecutiveFailures || 0) + 1 : 0;

    // ── Status snapshot ────────────────────────────────────────────────────
    streamStatus[stream.id] = {
      status: result.status,
      responseTime: result.responseTime,
      lastChecked: timestamp,
      consecutiveFailures: failures,
      isSilent: !!result.isSilent,
      audioEnergy: result.audioEnergy || 0,
      silenceState: st.state,
      silenceStreak: st.streak,
      error: result.error,
      httpStatus: result.httpStatus ?? null,
      errorCode: result.errorCode || null,
      timings: result.timings || {},
      // When Icecast is reachable but the mount is gone, the audience is gone
      // with it — the mount cannot serve anyone because it no longer exists.
      // Carrying the last known count forward here made outages read as though
      // listeners had stayed connected, hiding the real audience loss. Only
      // carry forward when Icecast itself is unreachable and the count is
      // genuinely unknown.
      // Summed across every bitrate variant of this channel, not just the
      // probed mount — see diagnose.channelAudience(). Reading one mount
      // reported a fraction of the real audience and understated every
      // listener-loss figure derived from it.
      listeners: audience.present > 0
        ? audience.listeners
        : snap.reachable
        ? 0
        : prev.listeners ?? 0,
      listenerPeak: audience.present > 0 ? audience.peak : prev.listenerPeak ?? 0,
      // How many of the channel's variants Icecast is serving. present === 0 is
      // a channel outage; 0 < present < total is a degraded channel that is
      // still playing for most of its audience.
      variantsPresent: audience.present,
      variantsTotal: audience.total,
      // Live per-mount counts, so the card can show which variant actually
      // carries the audience. Carried forward when Icecast is unreachable for
      // the same reason the summed count is: no reading is not a reading of nil.
      mountListeners: snap.reachable ? audience.perMount : prev.mountListeners || {},
      // The failing paths themselves, each with WHY, so the dashboard can name
      // them rather than leaving an operator to work out which of three mounts
      // "2 of 3" refers to. Only meaningful while Icecast is reachable — see
      // channelDegradation().
      impairedMounts: snap.reachable
        ? degradation.impaired.map((m) => ({ path: m.path, reason: m.reason }))
        : prev.impairedMounts || [],
      degraded: degradation.degraded,
      title: mount?.title || prev.title || '',
      bitrate: mount?.bitrate || prev.bitrate || 128,
      streamStart: mount?.streamStart || prev.streamStart || '',
      mountPresent: !!mount,
      icecastReachable: !!snap.reachable,
    };

    store.addSample(stream.id, {
      timestamp,
      status: result.status,
      responseTime: result.responseTime,
      listeners: streamStatus[stream.id].listeners,
      isSilent: !!result.isSilent,
      silenceState: st.state,
      error: result.error,
      errorCode: result.errorCode || null,
      // The channel's listeners broken out per mount, plus how many of its
      // variants were being served. The summed count above answers "how big was
      // this channel"; only these answer "which variant lost its audience", and
      // a sum can hold steady while one variant collapses inside it. Roughly 90
      // bytes a sample, against a 7-day raw retention — a few MB.
      variantsPresent: audience.present,
      variantsTotal: audience.total,
      mountListeners: audience.perMount,
    });

    // ── Variant degradation ────────────────────────────────────────────────
    // Independent of the outage episode below: a channel can be degraded while
    // it is up, and a channel that goes fully down is an outage, not a
    // degradation. Ordered before the outage block only so that a channel
    // failing outright closes its degradation episode first.
    trackVariantDegradation(stream, degradation, timestamp, degradedNotices);

    // ── Episode transitions ────────────────────────────────────────────────
    if (isDown) {
      const dg = diagnose.classify({ stream, result, snapshot: snap, prevSnapshot, cycle });
      const episode = episodes[stream.id];

      if (!episode) {
        // First failure of a new episode. Always recorded — recording is
        // decoupled from notifying — but never emailed on its own. One failed
        // check cannot distinguish a stream that is going down from a stream
        // that hiccuped, and FAILURE_THRESHOLD exists to make that call.
        const severity = unconfirmedSeverity(dg);
        const event = store.addEvent({
          timestamp,
          streamId: stream.id,
          streamName: stream.name,
          type: 'down',
          severity,
          confirmed: false,
          scope: dg.scope,
          message: `${stream.name} failed a check — ${dg.causeLabel}${result.error ? ` (${result.error})` : ''}`,
          failedChecks: 1,
          diagnosis: dg,
          email: {
            attempted: false,
            sent: null,
            reason: severity === PROBE_ERROR
              ? 'probe-side failure — Icecast reachable and mount still serving'
              : 'unconfirmed single failed check',
          },
        });

        episodes[stream.id] = {
          eventId: event.id,
          startedAt: timestamp,
          alerted: false,
          severity,
          // Judged from the FAILURE, not from the recovery that ends the
          // episode — by then the stream is healthy and every verdict reads
          // 'none'. See the resolution branch.
          listenerImpact: dg.listenerImpact,
        };

        if (severity === PROBE_ERROR) {
          console.warn(`[Monitor] ◦ Probe anomaly — ${stream.name}: ${dg.causeLabel} (mount still serving, no listener impact)`);
        } else {
          console.warn(`[Monitor] ⚠️  Brief outage recorded — ${stream.name}: ${dg.causeLabel} (${result.error})`);
        }
      } else {
        // Ongoing episode: keep the single event up to date rather than
        // creating a new one for every failed check.
        const patch = {
          failedChecks: failures,
          diagnosis: dg,
          lastCheckAt: timestamp,
        };

        const confirmed = failures >= FAILURE_THRESHOLD;
        const alertable = confirmed && warrantsAlert(dg);
        episode.listenerImpact = worstImpact(episode.listenerImpact, dg.listenerImpact);

        if (confirmed && episode.severity !== 'outage') {
          patch.severity = 'outage';
          patch.confirmed = true;
          patch.scope = dg.scope;
          patch.confirmedAt = timestamp;
          patch.message = `${stream.name} is DOWN — ${dg.causeLabel}${result.error ? ` (${result.error})` : ''}`;
          episode.severity = 'outage';
          console.error(`[ALERT] ${stream.name} DOWN confirmed after ${failures} checks — ${dg.causeLabel}`);
        }

        // A confirmed outage that Icecast clears of listener impact is still a
        // real, fully recorded outage — it just does not email. Say so on the
        // event itself, so the history can explain its own silence.
        if (confirmed && !alertable && !episode.alerted) {
          patch.email = {
            attempted: false,
            sent: null,
            reason: 'suppressed — Icecast reachable and mount still serving listeners',
          };
        }

        store.updateEvent(episode.eventId, patch);

        if (alertable && !episode.alerted) {
          newlyNotable.push({
            stream, result, diagnosis: dg,
            eventId: episode.eventId,
            reason: 'confirmed outage',
            // What the audience WAS when this started. The loss cannot be
            // totalled until recovery, but the reach can — and "≈66 listeners
            // were connected" is the line that tells a reader in the first
            // second whether to get out of bed.
            audience: store.getAudienceContext(stream.id, episode.startedAt),
            startedAt: episode.startedAt,
          });
        } else if (confirmed && !alertable && !episode.suppressionLogged) {
          episode.suppressionLogged = true;
          console.log(`[Monitor] 🔕 ${stream.name} outage confirmed but NOT emailed — mount still listed by Icecast, no listener impact`);
        }
      }
    } else if (wasDown || episodes[stream.id]) {
      const episode = episodes[stream.id];
      if (episode && episode.severity !== 'dead_air') {
        const durationMs = new Date(timestamp) - new Date(episode.startedAt);
        const dg = diagnose.classify({ stream, result, snapshot: snap, prevSnapshot, cycle });
        const sourceOutage = diagnose.deriveSourceOutage(snap, stream, episode.startedAt);

        // Recovery settles what the failure could not.
        //
        // While a stream is failing and Icecast is unreachable, the verdict is
        // 'unknown' — we cannot see whether the mount survived. But once the
        // stream is back, Icecast tells us exactly when its source connected. If
        // that moment predates the episode, the source was live throughout: the
        // mount never went away, and nobody lost audio. Our probe broke, not the
        // stream.
        //
        // Without this, three 60-second probe resets overnight were charged 55
        // listener-minutes against an audience whose listener count never even
        // dipped (14 → 13 → 12 across the whole window, where a genuine source
        // drop took Main from 66 to 10).
        const mountNow = diagnose.findMount(snap, stream);
        const sourceHeldThroughout =
          !!mountNow?.streamStart &&
          new Date(mountNow.streamStart).getTime() <= new Date(episode.startedAt).getTime();

        const settledImpact = sourceHeldThroughout ? 'none' : episode.listenerImpact;

        // Freeze the audience cost now. Raw samples expire after a week and
        // Icecast reports no listeners for a mount that no longer exists, so
        // this figure is unrecoverable once the window closes — but the event
        // itself remains in the long-term event record.
        const audience = store.buildAudienceImpact(
          stream.id, episode.startedAt, durationMs, settledImpact,
        );

        const patch = {
          resolvedAt: timestamp,
          durationMs,
          durationLabel: diagnose.fmtDuration(durationMs),
          sourceOutage,
          selfCleared: !episode.alerted,
          audience,
        };

        // An unconfirmed failure recorded as a brief outage on suspicion is a
        // probe anomaly once the source is shown to have held. Relabel it —
        // leaving it as "Brief Outage" overstates a fault that cost nobody
        // anything. Confirmed outages keep their severity: the stream really was
        // unreachable for two checks, it simply cost no listeners.
        if (sourceHeldThroughout && episode.severity === BRIEF_OUTAGE) {
          patch.severity = PROBE_ERROR;
          patch.message = `${stream.name} probe failed — Icecast kept serving the mount throughout`;
        }

        store.updateEvent(episode.eventId, patch);

        if (audience.listenerMinutesLost) {
          console.log(`[Monitor] 📉 ${stream.name} — ${audience.listenersBefore} listener(s) lost audio for ${diagnose.fmtDuration(durationMs)} (${audience.confidence})`);
        }

        if (episode.alerted) {
          recoveries.push({ stream, result, diagnosis: dg, episode, durationMs, sourceOutage, audience });
        } else {
          console.log(`[Monitor] ✓ ${stream.name} self-cleared after ${diagnose.fmtDuration(durationMs)} (no alert was sent)`);
        }
        delete episodes[stream.id];
      }
    }
  }

  // ── Notification pass ─────────────────────────────────────────────────────
  await dispatchNotifications(newlyNotable, recoveries, { allDown, timestamp, snapshot: snap });
  await dispatchDegradedNotices(degradedNotices);

  store.prune();
  store.saveEvents();
  store.setStatusCache(streamStatus);
}

/**
 * Sends at most one outage email and one recovery email per cycle. When
 * several streams fail together the messages are consolidated, so a
 * server-level event produces one email rather than one per mount.
 */
async function dispatchNotifications(newlyNotable, recoveries, ctx) {
  // Split rather than filter: the muted ones still need their event updated, or
  // the record would not say why nothing was sent.
  const mutedDown = newlyNotable.filter((n) => !alertsEnabledFor(n.stream));
  const mutedUp = recoveries.filter((r) => !alertsEnabledFor(r.stream));
  newlyNotable = newlyNotable.filter((n) => alertsEnabledFor(n.stream));
  recoveries = recoveries.filter((r) => alertsEnabledFor(r.stream));

  for (const m of [...mutedDown, ...mutedUp]) {
    if (!m.eventId) continue;
    store.updateEvent(m.eventId, {
      email: {
        attempted: false,
        sent: false,
        reason: `alerts not enabled for station "${m.stream?.stationId || 'unknown'}" (ALERT_STATIONS)`,
      },
    });
    console.log(`[Monitor] 🔕 ${m.stream?.name}: recorded, not emailed — station not in ALERT_STATIONS`);
  }

  if (newlyNotable.length > 0) {
    const serverScope =
      ctx.allDown && streams.length > 1
        ? 'server'
        : newlyNotable[0].diagnosis.scope;

    const consolidated = newlyNotable.length > 1;
    const entries = newlyNotable.map((n) => ({
      stream: n.stream, result: n.result, diagnosis: n.diagnosis, audience: n.audience,
    }));

    const emailResult = await sendAlert({
      kind: 'down',
      entries,
      scope: serverScope,
      consolidated,
    });

    for (const n of newlyNotable) {
      store.updateEvent(n.eventId, {
        email: { ...emailResult, consolidated },
        alertedAt: ctx.timestamp,
      });
      const ep = episodes[n.stream.id];
      if (ep) ep.alerted = true;
    }
  }

  if (recoveries.length > 0) {
    const entries = recoveries.map((r) => ({
      stream: r.stream, result: r.result, diagnosis: r.diagnosis,
      audience: r.audience, durationMs: r.durationMs,
    }));

    const emailResult = await sendAlert({
      kind: 'recovery',
      entries,
      scope: recoveries.length > 1 ? 'server' : recoveries[0].diagnosis.scope,
      consolidated: recoveries.length > 1,
    });

    for (const r of recoveries) {
      const event = store.addEvent({
        timestamp: ctx.timestamp,
        streamId: r.stream.id,
        streamName: r.stream.name,
        type: 'up',
        severity: 'recovery',
        confirmed: true,
        scope: r.diagnosis.scope,
        message: `${r.stream.name} has RECOVERED after ${diagnose.fmtDuration(r.durationMs)} (response ${r.result.responseTime}ms)`,
        relatedTo: r.episode.eventId,
        durationMs: r.durationMs,
        durationLabel: diagnose.fmtDuration(r.durationMs),
        sourceOutage: r.sourceOutage,
        diagnosis: r.diagnosis,
        email: emailResult,
      });
      console.log(`[RECOVERY] ${event.message}`);
    }
  }
}

// ── Bulletproof Cross-Client Dark Mode Email Builder ─────────────────────────
function buildEmailHtml({ title, subtitle, headerBg, contentHtml }) {
  const dashboardUrl = process.env.DASHBOARD_URL || '';
  const dashboardLink = dashboardUrl ? `
    <div style="text-align: center; margin-top: 24px; margin-bottom: 8px;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${dashboardUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="18%" stroke="f" fillcolor="#6c5ce7">
        <w:anchorlock/>
        <center style="color:#ffffff;font-family:sans-serif;font-size:14px;font-weight:bold;">📊 Open Stream Monitor Dashboard</center>
      </v:roundrect>
      <![endif]-->
      <a href="${dashboardUrl}" class="btn-bg" style="mso-hide:all; display: inline-block; background-color: #6c5ce7; background-image: linear-gradient(135deg, #6c5ce7, #8a7bfa); color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.02em; box-shadow: 0 4px 12px rgba(108, 92, 231, 0.35);">
        <span class="btn-text" style="color: #ffffff !important; font-weight: 700;">📊 Open Stream Monitor Dashboard</span>
      </a>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }

    /* Force iOS WebKit Dark Mode Compliance */
    @media (prefers-color-scheme: dark) {
      .body-bg { background-color: #0b0b14 !important; }
      .card-wrap { background-color: #181826 !important; border-color: #2e2e44 !important; }
      .card-header { background: ${headerBg} !important; }
      .card-body { background-color: #181826 !important; color: #ffffff !important; }
      .title-text { color: #ffffff !important; }
      .sub-text { color: #f1f5f9 !important; }
      .section-hdr { color: #cbd5e1 !important; }
      .label-col { color: #94a3b8 !important; }
      .val-col { color: #f8fafc !important; }
      .row-border { border-bottom-color: #28283d !important; }
      .callout-box { background-color: #211e3b !important; border-color: #3d3575 !important; }
      .callout-title { color: #c4b5fd !important; }
      .callout-text { color: #e2e8f0 !important; }
      .diag-box { background-color: #101a2e !important; border-color: #1e3a5f !important; }
      .diag-title { color: #7dd3fc !important; }
      .btn-bg { background-color: #6c5ce7 !important; background-image: none !important; color: #ffffff !important; }
      .btn-text { color: #ffffff !important; }
      .footer-bg { background-color: #0f0f1a !important; border-top-color: #222235 !important; }
      .footer-text { color: #94a3b8 !important; }
    }
  </style>
</head>
<body class="body-bg" style="margin: 0; padding: 20px 0; background-color: #0f0f1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="body-bg" style="background-color: #0f0f1a; width: 100%;">
    <tr>
      <td align="center" style="padding: 10px 8px;">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="card-wrap" style="max-width: 600px; width: 100%; background-color: #181826; border-radius: 12px; overflow: hidden; border: 1px solid #2e2e44; box-shadow: 0 8px 24px rgba(0,0,0,0.4);">
          <!-- Header Banner -->
          <tr>
            <td class="card-header" style="background: ${headerBg}; padding: 24px 28px;">
              <h1 class="title-text" style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff !important; line-height: 1.3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
                <span class="title-text" style="color: #ffffff !important;">${title}</span>
              </h1>
              ${subtitle ? `<p class="sub-text" style="margin: 8px 0 0 0; font-size: 14px; color: #f1f5f9 !important; opacity: 0.95; line-height: 1.5;"><span class="sub-text" style="color: #f1f5f9 !important;">${subtitle}</span></p>` : ''}
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td class="card-body" style="background-color: #181826; padding: 24px 28px; color: #e2e8f0;">
              ${contentHtml}
              ${dashboardLink}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="footer-bg" style="background-color: #0f0f1a; padding: 18px 28px; border-top: 1px solid #222235; text-align: center;">
              <p class="footer-text" style="color: #94a3b8 !important; font-size: 12px; margin: 0; line-height: 1.5;">
                <span class="footer-text" style="color: #94a3b8 !important;">Pacifica Stream Monitor · Pacifica Foundation</span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Email fragments ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label, valueHtml, last = false) {
  const border = last ? '' : 'border-bottom: 1px solid #28283d;';
  return `
      <tr class="${last ? '' : 'row-border'}" style="${border}">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; width: 150px; font-size: 13px; vertical-align: top;"><span class="label-col" style="color: #94a3b8 !important;">${label}</span></td>
        <td style="padding: 8px 0; font-size: 13px;">${valueHtml}</td>
      </tr>`;
}

/** The diagnosis block — the part that tells an operator what to actually do. */
function renderDiagnosis(dg) {
  if (!dg || !dg.cause) return '';

  const scopeLabel = {
    server: '🌐 Server-wide — affects all stations on this Icecast host',
    station: '📻 Station-wide — affects every mount of this station',
    stream: '🎚️ Single stream',
  }[dg.scope] || dg.scope;

  const confidenceBadge = {
    high: '<span style="color:#4ade80 !important; font-weight:600;">High confidence</span>',
    medium: '<span style="color:#fbbf24 !important; font-weight:600;">Medium confidence</span>',
    low: '<span style="color:#94a3b8 !important; font-weight:600;">Low confidence</span>',
  }[dg.confidence] || dg.confidence;

  const evidence = (dg.evidence || []).map((e) =>
    `<li style="color:#e2e8f0 !important; margin-bottom:5px;"><span style="color:#e2e8f0 !important;">${esc(e)}</span></li>`,
  ).join('');

  const steps = (dg.remediation || []).map((r) =>
    `<li style="color:#e2e8f0 !important; margin-bottom:5px;"><span style="color:#e2e8f0 !important;">${esc(r)}</span></li>`,
  ).join('');

  const t = dg.timings || {};
  const timingParts = [];
  if (t.dns != null) timingParts.push(`DNS ${t.dns}ms`);
  if (t.tcp != null) timingParts.push(`TCP ${t.tcp}ms`);
  if (t.tls != null) timingParts.push(`TLS ${t.tls}ms`);
  if (t.ttfb != null) timingParts.push(`First byte ${t.ttfb}ms`);
  const timingLine = timingParts.length
    ? `<p style="margin:12px 0 0 0; font-size:12px; color:#94a3b8 !important;"><span style="color:#94a3b8 !important;">⏱ Connection breakdown: ${timingParts.join(' · ')}</span></p>`
    : '';

  const ice = dg.icecast || {};
  const iceLines = [];
  if (ice.reachable) {
    iceLines.push(`Icecast status endpoint responded — ${ice.mountCount} mount(s) listed${ice.serverId ? ` on ${esc(ice.serverId)}` : ''}.`);
    iceLines.push(`Mount <code style="background:#28283d;color:#a78bfa !important;padding:1px 4px;border-radius:3px;">${esc(ice.mountPath || '?')}</code> is <strong style="color:${ice.mountPresent ? '#4ade80' : '#f87171'} !important;">${ice.mountPresent ? 'PRESENT' : 'ABSENT'}</strong>.`);
    if (ice.sourceConnectedSince) {
      iceLines.push(`Source connected since ${esc(ice.sourceConnectedSince)}.`);
    }
  } else {
    iceLines.push(`<strong style="color:#f87171 !important;">Icecast status endpoint is UNREACHABLE</strong>${ice.statusError ? ` — ${esc(ice.statusError)}` : ''}.`);
  }
  if (ice.serverRestarted) {
    iceLines.push('<strong style="color:#fbbf24 !important;">Icecast server start time changed — the server was restarted.</strong>');
  }

  return `
    <div class="diag-box" style="background-color:#101a2e; border:1px solid #1e3a5f; border-radius:8px; padding:16px; margin-top:16px;">
      <p class="diag-title" style="font-weight:700; color:#7dd3fc !important; margin:0 0 4px 0; font-size:15px;"><span class="diag-title" style="color:#7dd3fc !important;">🔎 Diagnosis: ${esc(dg.causeLabel)}</span></p>
      <p style="margin:0 0 12px 0; font-size:12px; color:#94a3b8 !important;"><span style="color:#94a3b8 !important;">${esc(scopeLabel)} · ${confidenceBadge}</span></p>

      <p style="margin:0 0 6px 0; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8 !important;"><span style="color:#94a3b8 !important;">Evidence</span></p>
      <ul style="margin:0 0 14px 0; padding-left:18px; font-size:13px; line-height:1.6;">${evidence}</ul>

      <p style="margin:0 0 6px 0; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8 !important;"><span style="color:#94a3b8 !important;">Icecast server state</span></p>
      <ul style="margin:0 0 14px 0; padding-left:18px; font-size:13px; line-height:1.6;">
        ${iceLines.map((l) => `<li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">${l}</span></li>`).join('')}
      </ul>

      <p style="margin:0 0 6px 0; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8 !important;"><span style="color:#94a3b8 !important;">What to do</span></p>
      <ol style="margin:0; padding-left:18px; font-size:13px; line-height:1.6;">${steps}</ol>
      ${timingLine}
    </div>`;
}

/** Plain-language qualifier for how an audience figure was arrived at. */
function audienceBasisNote(confidence) {
  return {
    measured: 'measured from listener counts recorded just before the failure',
    modelled: 'estimated from this hour’s typical audience — no live count was retained',
  }[confidence] || null;
}

/**
 * The audience cost of one failure, as email table rows.
 *
 * Accepts both shapes the monitor produces: the context taken when a failure is
 * first confirmed (reach only — the loss is still accruing) and the frozen
 * impact block written at recovery (reach × duration). An outage report without
 * this is a technical notice; with it, it is a statement of what it cost.
 */
function renderAudienceRows(audience, durationMs) {
  if (!audience) return '';
  const rows = [];
  const note = audienceBasisNote(audience.confidence);

  if (audience.listenersBefore != null) {
    const resolved = audience.listenerMinutesLost != null;
    const label = resolved ? 'Listeners Cut Off' : 'Listeners At Risk';
    const peak = audience.peakBefore != null && audience.peakBefore > audience.listenersBefore
      ? ` <span class="label-col" style="color:#94a3b8 !important;">(peak ${audience.peakBefore})</span>`
      : '';
    rows.push(row(label,
      `<span class="val-col" style="color:#fbbf24 !important; font-weight:700;">≈ ${audience.listenersBefore}</span>${peak}` +
      (note ? `<br><span class="label-col" style="color:#94a3b8 !important; font-size:11px;">${esc(note)}</span>` : ''),
    ));
  }

  if (audience.listenerMinutesLost != null) {
    // Listener impact stated as a headcount and a duration only. A derived
    // "listener-hours" figure was several times larger than the outage that
    // caused it and carried the word "hours", so it read as days of downtime.
    rows.push(row('Listener Impact',
      audience.listenerMinutesLost > 0
        ? `<span class="val-col" style="color:#f87171 !important; font-weight:700;">${audience.listenersBefore ?? '?'} listener(s) lost audio</span>` +
          `<br><span class="label-col" style="color:#94a3b8 !important; font-size:11px;">for the ${esc(diagnose.fmtDuration(durationMs || 0))} the stream was off air</span>`
        : `<span class="val-col" style="color:#4ade80 !important; font-weight:600;">None</span>` +
          `<br><span class="label-col" style="color:#94a3b8 !important; font-size:11px;">${esc(audience.basis || 'no listener impact')}</span>`,
    ));
  } else if (audience.listenersBefore == null) {
    rows.push(row('Listener Impact',
      '<span class="label-col" style="color:#94a3b8 !important;">Not measurable — no audience data retained for this period</span>'));
  }

  return rows.join('');
}

function renderStreamBlock(entry, index, total) {
  const { stream, result, diagnosis } = entry;
  const heading = total > 1
    ? `<h3 class="section-hdr" style="margin:${index === 0 ? '0' : '24px'} 0 12px 0; font-size:14px; color:#f8fafc !important; letter-spacing:0.02em;"><span style="color:#f8fafc !important;">${index + 1}. ${esc(stream.name)}</span></h3>`
    : `<h3 class="section-hdr" style="margin:0 0 12px 0; font-size:13px; color:#cbd5e1 !important; text-transform:uppercase; letter-spacing:0.05em;"><span class="section-hdr" style="color:#cbd5e1 !important;">Affected Stream</span></h3>`;

  const audienceRows = renderAudienceRows(entry.audience, entry.durationMs);

  const rows = [
    row('Stream Name', `<span class="val-col" style="color:#f8fafc !important; font-weight:600;">${esc(stream.name)}</span>`),
    row('Stream URL', `<code style="background:#28283d; color:#a78bfa !important; padding:3px 6px; border-radius:4px; font-size:12px;">${esc(stream.url)}</code>`),
    result.httpStatus != null
      ? row('HTTP Status', `<span class="val-col" style="color:${result.httpStatus === 200 ? '#4ade80' : '#f87171'} !important; font-weight:600;">${result.httpStatus}</span>`)
      : '',
    result.error
      ? row('Error', `<code style="background:rgba(239,68,68,0.15); color:#f87171 !important; padding:3px 6px; border-radius:4px; font-size:12px;">${esc(result.error)}</code>`)
      : '',
    result.errorCode
      ? row('Error Code', `<code style="background:#28283d; color:#fbbf24 !important; padding:3px 6px; border-radius:4px; font-size:12px;">${esc(result.errorCode)}</code>`)
      : '',
    entry.durationMs != null
      ? row('Outage Length', `<span class="val-col" style="color:#f8fafc !important; font-weight:600;">${esc(diagnose.fmtDuration(entry.durationMs))}</span>`)
      : '',
    row('Response Time', `<span class="val-col" style="color:#f8fafc !important;">${result.responseTime}ms</span>`, !audienceRows),
    audienceRows,
  ].filter(Boolean).join('');

  return `${heading}
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom:8px;">${rows}</table>
    ${renderDiagnosis(diagnosis)}`;
}

function renderAllStreamsTable() {
  const rows = streams.map((s) => {
    const st = streamStatus[s.id] || {};
    const isDeadAir = st.silenceState === 'dead_air';
    const dot = isDeadAir ? '🔇' : st.status === 'up' ? '🟢' : st.status === 'down' ? '🔴' : '⚪';
    const text = isDeadAir ? 'Dead Air' : st.status === 'up' ? 'Online' : st.status === 'down' ? 'Offline' : 'Unknown';
    const color = isDeadAir ? '#f59e0b' : st.status === 'up' ? '#4ade80' : '#f87171';
    const rt = st.responseTime != null ? `${st.responseTime}ms` : '—';
    return `
          <tr class="row-border" style="border-bottom: 1px solid #28283d;">
            <td class="val-col" style="padding: 8px; color: #f8fafc !important; font-size: 13px;"><span class="val-col" style="color: #f8fafc !important;">${dot} ${esc(s.name)}</span></td>
            <td style="padding: 8px; color: ${color} !important; font-weight: 600; font-size: 13px;"><span style="color: ${color} !important;">${text}</span></td>
            <td class="label-col" style="padding: 8px; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">${rt}</span></td>
            <td class="label-col" style="padding: 8px; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">${st.listeners ?? '—'}</span></td>
          </tr>`;
  }).join('');

  return `
    <h3 class="section-hdr" style="margin: 0 0 12px 0; font-size: 13px; color: #cbd5e1 !important; text-transform: uppercase; letter-spacing: 0.05em;"><span class="section-hdr" style="color: #cbd5e1 !important;">All Streams Overview</span></h3>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
      <tr style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Stream</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Status</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Response</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Listeners</span></td>
      </tr>
      ${rows}
    </table>`;
}

// ── Email Alerts ────────────────────────────────────────────────────────────
/**
 * Sends an alert and RETURNS the delivery outcome, so every event carries a
 * verifiable record of whether an email actually went out. Previously an SMTP
 * failure was logged and forgotten, leaving no way to tell a delivered alert
 * from a silently dropped one.
 */
async function sendAlert(opts) {
  const attemptedAt = new Date().toISOString();

  if (!transporter) {
    return { attempted: false, sent: false, reason: 'SMTP not configured', attemptedAt };
  }

  const recipients = (process.env.ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    console.warn('[Monitor] No ALERT_EMAILS configured');
    return { attempted: false, sent: false, reason: 'no recipients configured', attemptedAt };
  }

  const ccRecipients = (process.env.ALERT_CC || '').split(',').map((e) => e.trim()).filter(Boolean);
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  const { subject, html } = composeAlert(opts);

  try {
    const mailOptions = { from: fromAddr, to: recipients.join(', '), subject, html };
    if (ccRecipients.length > 0) mailOptions.cc = ccRecipients.join(', ');

    const info = await transporter.sendMail(mailOptions);

    console.log(`[Monitor] ✉️  Alert sent to ${recipients.length} recipient(s)${ccRecipients.length ? ` + ${ccRecipients.length} CC` : ''} — ${subject}`);
    return {
      attempted: true,
      sent: true,
      attemptedAt,
      sentAt: new Date().toISOString(),
      recipients,
      cc: ccRecipients,
      subject,
      messageId: info?.messageId || null,
      accepted: info?.accepted?.length ?? recipients.length,
      rejected: info?.rejected || [],
      error: null,
    };
  } catch (err) {
    console.error('[Monitor] ✉️  FAILED to send alert email:', err.message);
    return {
      attempted: true,
      sent: false,
      attemptedAt,
      recipients,
      cc: ccRecipients,
      subject,
      error: err.message,
      errorCode: err.code || null,
    };
  }
}

/**
 * Builds the alert's subject and body. Split out from sending so the exact
 * message can be rendered for inspection without an outage to trigger it —
 * an email template that can only be seen in production is one nobody checks.
 */
function composeAlert({ kind, entries, scope, consolidated = false, recoveredFrom = null }) {
  const isDeadAir = kind === 'dead_air';
  const isRecovery = kind === 'recovery';
  // A degraded channel is NOT down, and must never be described as though it
  // were. It is its own state: playing, on fewer mounts than it publishes.
  const isDegraded = kind === 'degraded';
  const isDown = !isRecovery && !isDegraded;

  const emoji = isDeadAir ? '🔇' : isDegraded ? '🟠' : isDown ? '🔴' : '🟢';
  const statusText = isDeadAir ? 'DEAD AIR (SILENCE)'
    : isDegraded ? 'DEGRADED'
    : isDown ? 'DOWN' : 'RECOVERED';

  const names = entries.map((e) => e.stream.name);
  const nameList = names.length > 2
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : names.join(' and ');

  const primaryCause = entries[0]?.diagnosis?.causeLabel || '';

  // Audience cost across every stream in this message. On a down alert it is
  // reach ("how many people this is happening to"); on a recovery it is the
  // settled loss. Either way it belongs in the subject — that is the part read
  // on a phone screen at 3am, and "≈66 listeners" is what makes it actionable.
  const reach = entries.reduce((a, e) => a + (e.audience?.listenersBefore || 0), 0);
  const subjectCost = reach > 0
    ? ` · ${reach} listener${reach === 1 ? '' : 's'} affected`
    : '';

  // Which station is this about? The subject used to say "KPFT Alert" whatever
  // had failed, so an outage at WPFW arrived headed with another station's call
  // sign — the one line that gets read on a phone at 3am, naming the wrong
  // station.
  const stationNames = [...new Set(entries.map((e) => e.stream?.stationName).filter(Boolean))];
  const alertOwner = stationNames.length === 1 ? stationNames[0]
    : stationNames.length > 1 ? 'Multiple stations'
    : 'Stream';

  // Subject leads with the root cause, so the inbox itself is diagnostic.
  let subject;
  if (consolidated) {
    subject = `${emoji} ${alertOwner} Alert: ${entries.length} streams ${statusText}${primaryCause ? ` — ${primaryCause}` : ''}${subjectCost}`;
  } else {
    subject = `${emoji} ${alertOwner} Alert: ${nameList} — ${statusText}${primaryCause && (isDown || isDegraded) ? ` (${primaryCause})` : ''}${subjectCost}`;
  }

  const headerBg = isDeadAir || isDegraded
    ? 'linear-gradient(135deg, #d97706, #b45309)'
    : isDown
    ? 'linear-gradient(135deg, #dc2626, #991b1b)'
    : 'linear-gradient(135deg, #16a34a, #15803d)';

  const scopeNote = scope === 'server'
    ? ' This is a SERVER-LEVEL event affecting every monitored stream.'
    : scope === 'station'
    ? ` This affects every mount of ${stationNames.length === 1 ? stationNames[0] : 'this station'}.`
    : '';

  const audienceNote = reach > 0
    ? ` ${reach} listener${reach === 1 ? ' was' : 's were'} tuned in${isRecovery ? ' when it started' : ''}.`
    : '';

  const subtitle = isDeadAir
    ? `${nameList} is connected but silent — dead air confirmed across ${SILENCE_FAILURE_THRESHOLD} consecutive probes.${audienceNote}`
    : isDegraded
    ? `${nameList} ${entries.length > 1 ? 'are' : 'is'} still on air, but not on every mount published. `
      + `Listeners on the affected mount lost audio; everyone else is unaffected.${audienceNote}`
    : isDown
    ? `${nameList} ${entries.length > 1 ? 'have' : 'has'} gone offline.${scopeNote}${audienceNote}`
    : `${nameList} ${entries.length > 1 ? 'are' : 'is'} back online${recoveredFrom ? ` (recovered from ${recoveredFrom})` : ''}.${audienceNote}`;

  const detectedAt = new Date().toLocaleString('en-US', {
    timeZone: STATION_TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });

  const blocks = entries.map((e, i) => renderStreamBlock(e, i, entries.length)).join('');

  const contentHtml = `
    ${blocks}
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-top:16px;">
      ${row('Detected At', `<span class="val-col" style="color:#f8fafc !important;">${detectedAt} CT</span>`, true)}
    </table>
    <hr style="border: none; border-top: 1px solid #28283d; margin: 20px 0;">
    ${renderAllStreamsTable()}`;

  const html = buildEmailHtml({
    title: `${emoji} Stream ${statusText}`,
    subtitle,
    headerBg,
    contentHtml,
  });

  return { subject, html };
}

/**
 * Re-renders the alert email for a stored event, exactly as the mailer would
 * have built it from that event's own diagnosis and audience figures.
 */
function previewAlertForEvent(eventId) {
  const event = store.getEvents({ limit: Number.MAX_SAFE_INTEGER })
    .events.find((e) => e.id === eventId);
  if (!event) return null;

  const stream = streams.find((s) => s.id === event.streamId)
    || { id: event.streamId, name: event.streamName, url: '' };

  // The probe result is not kept on the event, so the parts of it the email
  // shows are recovered from the diagnosis instead of invented.
  const dg = event.diagnosis || {};
  const result = {
    httpStatus: dg.httpStatus ?? null,
    error: dg.errorMessage || null,
    errorCode: dg.errorCode || null,
    responseTime: dg.timings?.ttfb ?? dg.responseTime ?? 0,
  };

  return composeAlert({
    kind: event.severity === 'dead_air' ? 'dead_air'
      // Degraded events can email now, so previewing one as a DOWN alert would
      // show a red "stream offline" message for a channel that was playing.
      : event.type === 'degraded' ? 'degraded'
      : event.type === 'up' ? 'recovery' : 'down',
    entries: [{
      stream, result, diagnosis: event.diagnosis,
      audience: event.audience, durationMs: event.durationMs,
    }],
    scope: event.diagnosis?.scope || event.scope,
    recoveredFrom: event.severity === 'recovery' && event.relatedTo ? 'the outage above' : null,
  });
}

// ── Public API ──────────────────────────────────────────────────────────────
function start() {
  init();
  runChecks().catch((err) => console.error('[Monitor] Check cycle failed:', err));

  intervalHandle = setInterval(() => {
    runChecks().catch((err) => console.error('[Monitor] Check cycle failed:', err));
  }, CHECK_INTERVAL);

  flushHandle = setInterval(() => store.save(), SAVE_INTERVAL);

  if (WEEKLY_ROUNDUP_ENABLED) {
    // Polled rather than scheduled with one long timeout: a five-minute tick
    // survives clock changes, DST shifts and container restarts, none of which a
    // days-long setTimeout does.
    roundupHandle = setInterval(checkWeeklyRoundup, ROUNDUP_TICK_MS);
    checkWeeklyRoundup();
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    console.log(`[Monitor] Weekly roundup: ${DAYS[WEEKLY_ROUNDUP_DAY]}s at ${String(WEEKLY_ROUNDUP_HOUR).padStart(2, '0')}:00 ${STATION_TZ}`);
  }

  const shutdown = () => { store.save(true); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('[Monitor] Started');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  if (flushHandle) clearInterval(flushHandle);
  if (roundupHandle) clearInterval(roundupHandle);
  Object.values(silenceState).forEach((st) => { if (st.timer) clearTimeout(st.timer); });
  store.save(true);
  console.log('[Monitor] Stopped');
}

function getStreams() { return streams; }

function getStatus() {
  return streams.map((s) => ({ ...s, ...streamStatus[s.id] }));
}

/** Back-compatible shape for the existing dashboard. */
function getHistory() {
  return store.getAllSamples(24 * 60 * 60 * 1000);
}

function getIncidents() {
  return store.getEvents({ since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }).events;
}

function getEvents(opts) { return store.getEvents(opts); }
function getSamples(streamId, sinceMs) { return store.getSamples(streamId, sinceMs); }
function getRollups(streamId) { return store.getRollups(streamId); }

/**
 * Audience over time for every stream, plus the outage windows to draw over it.
 * Both come from one call so a chart can never render a series and its overlay
 * from two different moments in time.
 */
function getListeners(windowMs, bucketMs, stationId) {
  const ids = streamIdsFor(stationId);
  const inScope = new Set(ids);
  const scoped = streams.filter((s) => inScope.has(s.id));
  const cutoff = Date.now() - windowMs;

  const series = {};
  for (const s of scoped) series[s.id] = store.getListenerSeries(s.id, windowMs, bucketMs);

  const outages = store
    .getEvents({ limit: Number.MAX_SAFE_INTEGER })
    .events.filter((e) => {
      // Failures only. A degraded channel kept playing, so drawing an outage
      // band across the audience chart for it would show a dip that never
      // happened on a channel that never went off air.
      if (!store.isFailureEvent(e) || !e.durationMs) return false;
      // Scoped too: an outage overlay from another station drawn across this
      // station's audience would be worse than no overlay at all.
      if (!inScope.has(e.streamId)) return false;
      return new Date(e.timestamp).getTime() > cutoff;
    })
    .map((e) => ({
      id: e.id,
      streamId: e.streamId,
      streamName: e.streamName,
      severity: e.severity,
      start: e.timestamp,
      end: e.resolvedAt || null,
      durationMs: e.durationMs,
      durationLabel: e.durationLabel,
      cause: e.diagnosis?.cause || null,
      causeLabel: e.diagnosis?.causeLabel || null,
      listenerImpact: e.diagnosis?.listenerImpact || null,
      audience: e.audience || null,
    }));

  return {
    windowMs,
    bucketMs: bucketMs || store.chooseBucketMs(windowMs),
    streams: streams.map((s) => ({ id: s.id, name: s.name })),
    series,
    outages,
    summary: store.getAudienceSummary(ids, windowMs),
    generatedAt: new Date().toISOString(),
  };
}
/**
 * Period totals for the Overview line and the weekly roundup, with stream names
 * attached — the store keys everything by id and has no idea what they are called.
 */
/**
 * The stream ids an aggregate should be computed over.
 *
 * With one station this was always "all of them", and every figure hardcoded
 * that. With two it stopped being true, quietly: uptime blended both stations,
 * so a GM's number included another station's outages and nothing said so.
 *
 * An unknown station id returns nothing rather than everything. Falling back to
 * the full set would answer a question about one station with a figure covering
 * all of them — the exact failure this exists to prevent.
 */
function streamIdsFor(stationId) {
  if (!stationId) return streams.map((s) => s.id);
  return streams.filter((s) => s.stationId === stationId).map((s) => s.id);
}

/** The stations currently configured, for a station picker. */
function getStations() {
  const seen = new Map();
  for (const s of streams) {
    if (!s.stationId || seen.has(s.stationId)) continue;
    seen.set(s.stationId, { id: s.stationId, name: s.stationName || s.stationId });
  }
  return [...seen.values()];
}

function getPeriodRollup(windowMs, stationId) {
  const rollup = store.getPeriodRollup(streamIdsFor(stationId), windowMs);
  const nameOf = (id) => streams.find((s) => s.id === id)?.name || id;
  return {
    ...rollup,
    perStream: rollup.perStream.map((s) => ({ ...s, name: nameOf(s.id) })),
    downtime: {
      ...rollup.downtime,
      worstStream: rollup.downtime.worstStream
        ? { ...rollup.downtime.worstStream, name: nameOf(rollup.downtime.worstStream.id) }
        : null,
    },
  };
}

function getSummary(windowMs, stationId) { return store.getSummary(streamIdsFor(stationId), windowMs); }
function getOverallUptime(windowMs, stationId) { return store.getOverallUptime(streamIdsFor(stationId), windowMs); }
/** Uptime as the audience experienced it — probe-only failures excluded. */
function getAudioUptime(windowMs, stationId) { return store.getAudioUptime(streamIdsFor(stationId), windowMs); }
function getCoverageStart(stationId) { return store.getCoverageStart(streamIdsFor(stationId)); }
function getDailyBuckets(days, stationId) { return store.getDailyBuckets(days, STATION_TZ, streamIdsFor(stationId)); }
function getCauseBreakdown(windowMs, stationId) { return store.getCauseBreakdown(windowMs, streamIdsFor(stationId)); }
function getStorageInfo() { return store.getStorageInfo(); }
function getSnapshot() { return snapshot; }

function getConfig() {
  return {
    checkInterval: CHECK_INTERVAL,
    failureThreshold: FAILURE_THRESHOLD,
    silenceProbeInterval: SILENCE_PROBE_INTERVAL_MS,
    silenceFailureThreshold: SILENCE_FAILURE_THRESHOLD,
    emailConfigured: !!transporter,
    alertRecipients: (process.env.ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean).length,
    alertPolicy: ALERT_ON_HARMLESS_OUTAGE ? 'all confirmed outages' : 'confirmed outages with listener impact',
    alertStations: ALERT_STATIONS.length ? ALERT_STATIONS : 'all',
    alertOnHarmlessOutage: ALERT_ON_HARMLESS_OUTAGE,
    weeklyRoundup: {
      enabled: WEEKLY_ROUNDUP_ENABLED,
      day: WEEKLY_ROUNDUP_DAY,
      hour: WEEKLY_ROUNDUP_HOUR,
      timezone: STATION_TZ,
      lastSent: store.getMeta('lastWeeklyRoundup')?.sentAt || null,
    },
    sampleRetentionDays: store.SAMPLE_RETENTION_DAYS,
    eventRetention: 'not-pruned-by-age',
    maxEvents: store.MAX_EVENTS,
    streams: streams.map((s) => ({ id: s.id, name: s.name })),
  };
}

async function sendTestAlert(toEmail) {
  if (!transporter) throw new Error('SMTP not configured');

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  const storage = store.getStorageInfo();

  const contentHtml = `
    ${renderAllStreamsTable()}

    <div class="callout-box" style="background-color: #1e1b38; border: 1px solid #3d3575; border-radius: 8px; padding: 16px; margin-top: 20px;">
      <p class="callout-title" style="font-weight: 600; color: #c4b5fd !important; margin: 0 0 8px 0; font-size: 14px;"><span class="callout-title" style="color: #c4b5fd !important;">ℹ️ What to expect</span></p>
      <ul class="callout-text" style="margin: 0; padding-left: 20px; color: #e2e8f0 !important; font-size: 13px; line-height: 1.8;">
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🔴 <strong>Down alert</strong> after ${FAILURE_THRESHOLD} consecutive failed checks — with a root-cause diagnosis</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🌐 <strong>Server-level alert</strong> immediately if a single failure hits every stream at once</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🔇 <strong>Dead Air alert</strong> when silence persists across ${SILENCE_FAILURE_THRESHOLD} probes spaced ${diagnose.fmtDuration(SILENCE_PROBE_INTERVAL_MS)} apart</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🟢 <strong>Recovery alert</strong> with the true outage duration</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Checks run every ${Math.round(CHECK_INTERVAL / 1000)} seconds</span></li>
      </ul>
    </div>

    <div class="diag-box" style="background-color:#101a2e; border:1px solid #1e3a5f; border-radius:8px; padding:16px; margin-top:16px;">
      <p class="diag-title" style="font-weight:600; color:#7dd3fc !important; margin:0 0 8px 0; font-size:14px;"><span class="diag-title" style="color:#7dd3fc !important;">📚 Incident history</span></p>
      <ul style="margin:0; padding-left:20px; font-size:13px; line-height:1.8;">
        <li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">Every failed check enters the long-term record — including brief ones that do not trigger an email</span></li>
        <li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">${storage.eventCount} event(s) currently on record${storage.oldestEvent ? `, back to ${new Date(storage.oldestEvent).toLocaleDateString('en-US')}` : ''}</span></li>
        <li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">The newest ${storage.maxEvents.toLocaleString()} events are retained; per-minute telemetry is kept ${storage.sampleRetentionDays} days, then compacted to hourly summaries</span></li>
      </ul>
    </div>`;

  const html = buildEmailHtml({
    title: '🧪 Test Alert — Email Working!',
    subtitle: 'This is a test alert from the Pacifica Stream Monitor. Email alerts are configured correctly.',
    headerBg: 'linear-gradient(135deg, #6c5ce7, #5a49c9)',
    contentHtml,
  });

  await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject: '🧪 Pacifica Stream Monitor — Test Alert',
    html,
  });
  console.log(`[Monitor] Test alert sent to ${toEmail}`);
}

// ── Weekly Roundup ──────────────────────────────────────────────────────────
/**
 * A scheduled digest, deliberately unlike an alert.
 *
 * Alerts answer "is something broken right now" and are read in a hurry. This
 * answers "how did the week go" — it is the only message that arrives when
 * nothing is wrong, which is exactly what makes a quiet week visible instead of
 * indistinguishable from a monitor that has silently died. Its subject says so
 * in the first three words, so it never reads as an emergency.
 *
 * Every figure comes from store.getPeriodRollup — the same call behind the
 * history page's Overview line, so the two cannot disagree.
 */
function statCell(label, value, color, note) {
  return `
    <td width="50%" style="padding:6px;" valign="top">
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="callout-box" style="background-color:#1e1b38; border:1px solid #3d3575; border-radius:8px;">
        <tr><td style="padding:12px 14px;">
          <p class="label-col" style="margin:0 0 4px 0; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8 !important;"><span class="label-col" style="color:#94a3b8 !important;">${esc(label)}</span></p>
          <p style="margin:0; font-size:22px; font-weight:700; color:${color} !important; line-height:1.2;"><span style="color:${color} !important;">${value}</span></p>
          ${note ? `<p class="label-col" style="margin:4px 0 0 0; font-size:11px; color:#94a3b8 !important;"><span class="label-col" style="color:#94a3b8 !important;">${esc(note)}</span></p>` : ''}
        </td></tr>
      </table>
    </td>`;
}

function statGrid(cells) {
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<tr>${cells[i]}${cells[i + 1] || '<td width="50%"></td>'}</tr>`);
  }
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0 -6px 4px -6px;">${rows.join('')}</table>`;
}

function fmtStationDate(iso, opts = {}) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: STATION_TZ, month: 'short', day: 'numeric', ...opts,
  });
}

function buildWeeklyRoundup(rollup) {
  const { counts: c, audience: a, alerts, narrative } = rollup;
  const rangeLabel = `${fmtStationDate(rollup.since)} – ${fmtStationDate(rollup.until, { year: 'numeric' })}`;
  // "Clean" means no listener heard a break — not that our probe never tripped.
  const clean = c.listenerAffecting === 0;

  // The subject has to identify itself as a periodic report at a glance, and
  // never be mistaken for an outage alert — hence the leading label and the
  // deliberately un-alarming emoji, even in a bad week.
  // Audience cost leads the subject line too — it is the part read on a phone
  // without opening anything.
  // Proportion first — an absolute listener-hours figure in a subject line
  // reads as a catastrophe whatever the scale behind it.
  const deliveredPct = a.lostSharePercent != null
    ? Math.round((100 - a.lostSharePercent) * 10) / 10
    : null;
  const subjectFacts = [
    deliveredPct != null ? `${deliveredPct}% of listening delivered` : null,
    clean
      ? 'no outages'
      : `${c.significant} significant outage${c.significant === 1 ? '' : 's'}`,
    rollup.downtimeMs ? `${diagnose.fmtDuration(rollup.downtimeMs)} elapsed off-air window` : null,
  ].filter(Boolean);
  const subject = `📊 Pacifica Weekly Stream Report — ${rangeLabel}: ${subjectFacts.join(', ')}`;

  const uptimeColor = rollup.uptime == null ? '#94a3b8'
    : rollup.uptime >= 99.5 ? '#4ade80' : rollup.uptime >= 98 ? '#fbbf24' : '#f87171';

  // Ordered by what the station actually needs to know, not by what is easiest
  // to measure: the audience cost first, the technical detail underneath it.
  // WHO HAS TO FIX IT — the first block after the summary, because it is the
  // reason this email gets forwarded. An 18-hour dropout with Icecast serving
  // other stations throughout is a studio problem, and the report has to say so
  // before anyone starts a conversation with the wrong department.
  const FAULT_META = {
    kpft: { label: 'Station source/feed path', sub: 'Icecast answered; the monitored source or mount was absent', color: '#fbbf24' },
    pacifica: { label: 'Pacifica/Icecast path', sub: 'Icecast was unreachable; check server, network, DNS, and TLS path', color: '#7dd3fc' },
    unknown: { label: 'Path unclear', sub: 'not enough evidence to assign the handoff', color: '#94a3b8' },
  };

  const faultRows = (rollup.faultSplit || []).map((s) => {
    const m = FAULT_META[s.side] || FAULT_META.unknown;
    const recordCount = s.streamRecords ?? s.outages;
    return `
      <tr class="row-border" style="border-bottom:1px solid #28283d;">
        <td style="padding:10px 8px; font-size:13px;">
          <span style="color:${m.color} !important; font-weight:700;">${esc(m.label)}</span>
          <br><span class="label-col" style="color:#94a3b8 !important; font-size:11px;">${esc(m.sub)}</span>
        </td>
        <td style="padding:10px 8px; font-size:15px; font-weight:700; color:${m.color} !important; white-space:nowrap;">
          <span style="color:${m.color} !important;">${recordCount} of ${c.listenerAffecting}</span>
          <br><span class="label-col" style="color:#94a3b8 !important; font-size:11px; font-weight:400;">stream records</span>
        </td>
        <td class="label-col" style="padding:10px 8px; color:#94a3b8 !important; font-size:12px;">
          <span class="label-col" style="color:#94a3b8 !important;">${s.listenersCutOff.toLocaleString()} listener interruption(s)<br>longest single interruption ${esc(diagnose.fmtDuration(s.longestMs))}</span>
        </td>
      </tr>`;
  }).join('');

  const faultBlock = faultRows ? `
    <h3 class="section-hdr" style="margin:22px 0 6px 0; font-size:13px; color:#cbd5e1 !important; text-transform:uppercase; letter-spacing:0.05em;"><span class="section-hdr" style="color:#cbd5e1 !important;">Which path needs attention?</span></h3>
    <p class="label-col" style="margin:0 0 10px 0; font-size:11px; line-height:1.5; color:#94a3b8 !important;"><span class="label-col" style="color:#94a3b8 !important;">These cards divide the ${c.listenerAffecting} listener-impacting stream records by the path that needs investigation. They do not claim a particular device failed.</span></p>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${faultRows}</table>` : '';

  const cells = [
    // A volume, not a duration — so it is NOT shown with an "h" suffix beside a
    // downtime tile that is one. The share is what makes it legible: "214" means
    // nothing on its own, "2.2% of all listening" is actionable.
    // Headline: people. Subheadline: their listening time, with the sentence
    // that stops it being read as clock hours.
    statCell('Listener Interruptions',
      a.listenersCutOff ? a.listenersCutOff.toLocaleString() : '0',
      a.listenersCutOff ? '#f87171' : '#4ade80',
      `across ${c.listenerAffecting} stream record(s) — the same listener interrupted twice counts twice`),
    statCell('Listening Lost',
      a.listenerHoursLost ? `${a.listenerHoursLost} listener-hours` : 'None',
      a.listenerHoursLost ? '#fbbf24' : '#4ade80',
      a.lostSharePercent != null
        ? `${a.lostSharePercent}% of all listening · person-hours, not clock time`
        : 'person-hours, not clock time'),
    statCell('Stream Interruptions', String(c.listenerAffecting),
      c.significant ? '#f87171' : '#4ade80',
      `${c.significant} sustained (${diagnose.fmtDuration(rollup.significantThresholdMs)}+) + ${c.brief} brief · per-stream records`),
    statCell('Elapsed Off-Air Window', diagnose.fmtDuration(rollup.downtime.wallClockMs || 0),
      rollup.downtime.wallClockMs ? '#fbbf24' : '#4ade80',
      rollup.downtime.streamMs > rollup.downtime.wallClockMs
        ? `at least one of ${rollup.perStream.length} monitored streams down; overlaps merged · ${diagnose.fmtDuration(rollup.downtime.streamMs)} summed stream-time`
        : `at least one of ${rollup.perStream.length} monitored streams down; elapsed clock time`),
    statCell('Audio Uptime', rollup.uptime != null ? `${rollup.uptime}%` : '—', uptimeColor,
      'share of monitored stream-time serving audio'),
    statCell('Alert Emails Sent', String(alerts.messages), '#a78bfa',
      alerts.eventsAlerted > alerts.messages
        ? `covering ${alerts.eventsAlerted} events`
        : alerts.suppressed ? `${alerts.suppressed} suppressed as harmless` : 'one per notifiable event'),
  ];

  const streamRows = rollup.perStream.map((s) => {
    const up = s.uptime == null ? '—' : `${s.uptime}%`;
    const upColor = s.uptime == null ? '#94a3b8' : s.uptime >= 99.5 ? '#4ade80' : s.uptime >= 98 ? '#fbbf24' : '#f87171';
    return `
      <tr class="row-border" style="border-bottom:1px solid #28283d;">
        <td class="val-col" style="padding:8px; color:#f8fafc !important; font-size:13px;"><span class="val-col" style="color:#f8fafc !important;">${esc(s.name)}</span></td>
        <td style="padding:8px; font-size:13px; font-weight:600; color:${upColor} !important;"><span style="color:${upColor} !important;">${up}</span></td>
        <td class="label-col" style="padding:8px; color:#94a3b8 !important; font-size:13px;"><span class="label-col" style="color:#94a3b8 !important;">${s.listenerAffecting}</span></td>
        <td class="label-col" style="padding:8px; color:#94a3b8 !important; font-size:13px;"><span class="label-col" style="color:#94a3b8 !important;">${s.downtimeMs ? esc(diagnose.fmtDuration(s.downtimeMs)) : '—'}</span></td>
        <td class="label-col" style="padding:8px; color:#94a3b8 !important; font-size:13px;"><span class="label-col" style="color:#94a3b8 !important;">${s.avgListeners ?? '—'}</span></td>
        <td class="label-col" style="padding:8px; color:#94a3b8 !important; font-size:13px;"><span class="label-col" style="color:#94a3b8 !important;">${s.peakListeners ?? '—'}</span></td>
      </tr>`;
  }).join('');

  const causeRows = (rollup.causes || []).slice(0, 5).map((c2) => `
      <tr class="row-border" style="border-bottom:1px solid #28283d;">
        <td class="val-col" style="padding:7px 8px; color:#f8fafc !important; font-size:13px;"><span class="val-col" style="color:#f8fafc !important;">${esc(c2.label || c2.cause)}</span></td>
        <td class="label-col" style="padding:7px 8px; color:#94a3b8 !important; font-size:13px; text-align:right;"><span class="label-col" style="color:#94a3b8 !important;">${c2.count}</span></td>
      </tr>`).join('');

  const notable = [rollup.longestOutage, rollup.worstIncident]
    .filter((e, i, arr) => e && arr.findIndex((x) => x && x.id === e.id) === i)
    .map((e) => {
      const when = new Date(e.timestamp).toLocaleString('en-US', {
        timeZone: STATION_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const cost = e.listenersBefore ? ` — ${e.listenersBefore} listener(s) were tuned in` : '';
      return `<li style="color:#e2e8f0 !important; margin-bottom:6px;"><span style="color:#e2e8f0 !important;"><strong>${esc(e.streamName)}</strong> · ${when} CT · ${esc(e.durationLabel || '—')}${e.causeLabel ? ` · ${esc(e.causeLabel)}` : ''}${cost}${e.emailed ? '' : ' <em>(no alert was emailed)</em>'}</span></li>`;
    }).join('');

  // A monitor that only started midway through the period cannot speak for all
  // of it. Say so rather than presenting a partial week as a full one.
  const partial = rollup.coverageMs < rollup.windowMs * 0.95;
  const coverageNote = partial
    ? `<p style="margin:12px 0 0 0; font-size:12px; color:#fbbf24 !important;"><span style="color:#fbbf24 !important;">⚠️ Monitoring covered only ${diagnose.fmtDuration(rollup.coverageMs)} of this ${Math.round(rollup.days)}-day period — figures describe the monitored part.</span></p>`
    : '';

  const contentHtml = `
    <div class="callout-box" style="background-color:#1e1b38; border:1px solid #3d3575; border-radius:8px; padding:16px; margin-bottom:18px;">
      <p class="callout-text" style="margin:0; font-size:15px; line-height:1.6; color:#f8fafc !important;"><span style="color:#f8fafc !important;">${clean ? '✅' : '📉'} ${esc(narrative.headline)}</span></p>
      <p class="label-col" style="margin:8px 0 0 0; font-size:12px; line-height:1.6; color:#94a3b8 !important;"><span class="label-col" style="color:#94a3b8 !important;">${esc(narrative.detail)}</span></p>
      ${coverageNote}
    </div>

    ${statGrid(cells)}

    ${faultBlock}

    <h3 class="section-hdr" style="margin:22px 0 10px 0; font-size:13px; color:#cbd5e1 !important; text-transform:uppercase; letter-spacing:0.05em;"><span class="section-hdr" style="color:#cbd5e1 !important;">Per Stream</span></h3>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
      <tr>
        <td class="label-col" style="padding:6px 8px; border-bottom:1px solid #28283d; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;"><span class="label-col" style="color:#94a3b8 !important;">Stream</span></td>
        <td class="label-col" style="padding:6px 8px; border-bottom:1px solid #28283d; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;"><span class="label-col" style="color:#94a3b8 !important;">Uptime</span></td>
        <td class="label-col" style="padding:6px 8px; border-bottom:1px solid #28283d; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;"><span class="label-col" style="color:#94a3b8 !important;">Stream records</span></td>
        <td class="label-col" style="padding:6px 8px; border-bottom:1px solid #28283d; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;"><span class="label-col" style="color:#94a3b8 !important;">Stream-time lost</span></td>
        <td class="label-col" style="padding:6px 8px; border-bottom:1px solid #28283d; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;"><span class="label-col" style="color:#94a3b8 !important;">Avg listeners</span></td>
        <td class="label-col" style="padding:6px 8px; border-bottom:1px solid #28283d; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;"><span class="label-col" style="color:#94a3b8 !important;">Peak listeners</span></td>
      </tr>
      ${streamRows}
    </table>

    ${causeRows ? `
    <h3 class="section-hdr" style="margin:22px 0 10px 0; font-size:13px; color:#cbd5e1 !important; text-transform:uppercase; letter-spacing:0.05em;"><span class="section-hdr" style="color:#cbd5e1 !important;">Why It Failed</span></h3>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${causeRows}</table>` : ''}

    ${notable ? `
    <div class="diag-box" style="background-color:#101a2e; border:1px solid #1e3a5f; border-radius:8px; padding:16px; margin-top:22px;">
      <p class="diag-title" style="font-weight:700; color:#7dd3fc !important; margin:0 0 10px 0; font-size:14px;"><span class="diag-title" style="color:#7dd3fc !important;">🔎 Worth a look</span></p>
      <ul style="margin:0; padding-left:18px; font-size:13px; line-height:1.6;">${notable}</ul>
    </div>` : ''}

    <p class="label-col" style="margin:20px 0 0 0; font-size:11px; line-height:1.6; color:#94a3b8 !important;"><span class="label-col" style="color:#94a3b8 !important;">This is a scheduled weekly summary, not an alert — it arrives whether or not anything went wrong.<br><br><strong>Listener interruptions</strong> is a headcount taken as each outage began; someone interrupted by two separate outages counts twice.<br><br><strong>Listening lost</strong> is audience multiplied by outage duration — 50 people for one hour is 50 listener-hours. It is not clock time.<br><br><strong>Elapsed off-air window</strong> is clock time with at least one of the ${rollup.perStream.length} monitored audio streams down; simultaneous stream outages count once. These are streams on the Icecast service, not ${rollup.perStream.length} separate servers. <strong>Summed stream-time</strong> adds each affected stream separately and is the basis of uptime. The path cards divide interruption records; they are not downtime totals.</span></p>`;

  const html = buildEmailHtml({
    title: '📊 Pacifica Weekly Stream Report',
    subtitle: `${rangeLabel} · ${rollup.perStream.length} streams monitored · scheduled summary`,
    headerBg: clean
      ? 'linear-gradient(135deg, #0f766e, #115e59)'
      : 'linear-gradient(135deg, #4f46e5, #3730a3)',
    contentHtml,
  });

  return { subject, html };
}

/** The roundup as it would be sent, without sending it. */
function previewWeeklyRoundup(windowMs = WEEKLY_ROUNDUP_WINDOW_MS) {
  // Preview what would actually be sent, scope included.
  const station = ALERT_STATIONS.length === 1 ? ALERT_STATIONS[0] : undefined;
  return buildWeeklyRoundup(getPeriodRollup(windowMs, station));
}

/**
 * Builds and sends the roundup. Returns the same delivery-outcome shape as
 * sendAlert, so a failure is reported rather than logged and forgotten.
 */
async function sendWeeklyRoundup({ to, windowMs = WEEKLY_ROUNDUP_WINDOW_MS } = {}) {
  const attemptedAt = new Date().toISOString();
  if (!transporter) return { attempted: false, sent: false, reason: 'SMTP not configured', attemptedAt };

  const recipients = to
    ? [to]
    : (process.env.WEEKLY_ROUNDUP_EMAILS || process.env.ALERT_EMAILS || '')
      .split(',').map((e) => e.trim()).filter(Boolean);
  if (!recipients.length) {
    return { attempted: false, sent: false, reason: 'no recipients configured', attemptedAt };
  }

  // The roundup covers exactly what alerts cover. Recipients are one global list,
  // so a report spanning every station would tell KPFT's staff about outages at
  // stations in other cities — and, worse, fold those figures into the uptime
  // number they read as their own.
  const roundupStation = ALERT_STATIONS.length === 1 ? ALERT_STATIONS[0] : undefined;

  const rollup = getPeriodRollup(windowMs, roundupStation);
  const { subject, html } = buildWeeklyRoundup(rollup);

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(', '),
      subject,
      html,
    });
    console.log(`[Monitor] 📊 Weekly roundup sent to ${recipients.length} recipient(s) — ${subject}`);
    return {
      attempted: true, sent: true, attemptedAt, sentAt: new Date().toISOString(),
      recipients, subject, messageId: info?.messageId || null,
    };
  } catch (err) {
    console.error('[Monitor] 📊 FAILED to send weekly roundup:', err.message);
    return { attempted: true, sent: false, attemptedAt, recipients, subject, error: err.message };
  }
}

/** Calendar fields for an instant in the station's timezone. */
function zonedParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,   // some locales render midnight as 24
    weekday: WEEKDAYS[parts.weekday],
  };
}

/**
 * Fires the roundup on its scheduled day, at most once per week.
 *
 * The last send is keyed by its station-local DATE and persisted, which is what
 * makes this safe on a container that redeploys several times a day: a restart
 * an hour after Monday's send finds Monday already recorded and stays quiet,
 * and a monitor that was down at the scheduled hour still sends when it comes
 * back later that same day rather than skipping the week entirely.
 */
function checkWeeklyRoundup() {
  if (!WEEKLY_ROUNDUP_ENABLED || !transporter) return;

  const now = zonedParts(new Date(), STATION_TZ);
  if (now.weekday !== WEEKLY_ROUNDUP_DAY || now.hour < WEEKLY_ROUNDUP_HOUR) return;
  if (store.getMeta('lastWeeklyRoundupDay') === now.day) return;

  // A monitor with almost no history for the period would report a week of
  // silence it never actually watched. Claim the slot anyway so it does not
  // retry every five minutes for the rest of the day.
  // Coverage is measured over the same scope the roundup reports on, or a
  // station with weeks of history would vouch for one added yesterday.
  const rollup = getPeriodRollup(WEEKLY_ROUNDUP_WINDOW_MS,
    ALERT_STATIONS.length === 1 ? ALERT_STATIONS[0] : undefined);
  if (rollup.coverageMs < 12 * 60 * 60 * 1000) {
    console.log('[Monitor] 📊 Weekly roundup skipped — under 12h of monitoring data for the period');
    store.setMeta('lastWeeklyRoundupDay', now.day);
    store.saveEvents();
    return;
  }

  // Claim the slot BEFORE sending, so a send that takes longer than the tick
  // interval cannot be started twice.
  store.setMeta('lastWeeklyRoundupDay', now.day);
  roundupAttempts = roundupAttempts.day === now.day
    ? { day: now.day, count: roundupAttempts.count + 1 }
    : { day: now.day, count: 1 };

  sendWeeklyRoundup()
    .then((res) => {
      store.setMeta('lastWeeklyRoundup', res);
      // A refused SMTP connection should not cost the whole week's report, but
      // nor should a broken mail server be retried 288 times before midnight.
      // Release the slot for a few more attempts, then leave it claimed.
      if (!res.sent && res.attempted && roundupAttempts.count < ROUNDUP_MAX_ATTEMPTS) {
        store.setMeta('lastWeeklyRoundupDay', null);
        console.warn(`[Monitor] 📊 Weekly roundup send failed — retrying in ${ROUNDUP_TICK_MS / 60000} min (attempt ${roundupAttempts.count}/${ROUNDUP_MAX_ATTEMPTS})`);
      }
      store.saveEvents();
    })
    .catch((err) => console.error('[Monitor] 📊 Weekly roundup failed:', err.message));
}

module.exports = {
  start, stop, getStreams, getStatus, getHistory, getIncidents, getConfig, sendTestAlert,
  getPeriodRollup, sendWeeklyRoundup, previewWeeklyRoundup, previewAlertForEvent,
  getEvents, getSamples, getRollups, getListeners, getSummary, getOverallUptime, getAudioUptime, getCoverageStart,
  getDailyBuckets, getCauseBreakdown, getStorageInfo, getSnapshot,
  getStationConfig: () => store.getStationConfig(),
  getStations, streamIdsFor,
  reloadConfig,
  alertsEnabledFor,
  saveStationConfig,
  abandonEpisode,
  // Exported for tests.
  normaliseStreams, normaliseMounts, buildDefaultConfig, flattenChannels,
  trackVariantDegradation, runChecks, probeVariants,
  getVariantHealth: (streamId) => variantHealth[streamId] || {},
};
