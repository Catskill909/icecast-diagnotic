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

   A REPEATING FAULT IS ONE FAULT. The gate above judges a single episode, and
   judges it correctly — which is why a flapping source encoder walked straight
   through it fourteen times in an hour on 2026-09-02, every alert true and the
   set of them worthless. A second confirmed outage on the same stream inside
   STORM_WINDOW_MS declares a storm: one further email saying the stream is
   unstable, then silence for that stream, then a single summary once it has
   stayed on air for STORM_CLEAR_AFTER_MS. Every flap in between is recorded in
   full. See the storm-suppression block below the configuration constants.
   ═══════════════════════════════════════════════════════════════════════════ */

const nodemailer = require('nodemailer');
const diagnose = require('./diagnose');
const store = require('./store');
const listenerDetailModule = require('./listener-detail');
/* Local geo/ASN databases, both optional. With neither configured every lookup
   returns `unknown` and the distribution-channel figures fall back to the
   user-agent signal alone, labelled as a floor. Nothing here requires it. */
const geo = require('./geo');

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

/* ── Storm suppression ───────────────────────────────────────────────────────
   Every other gate in this file asks the same question: is THIS outage real,
   and did it cost listeners? A flapping source encoder answers yes every time,
   truthfully — each disconnect really does drop every connected player. So
   nothing suppressed it, and on 2026-09-02 a KPFT encoder cycling every few
   minutes produced fourteen emails in one hour, alternating DOWN and RECOVERED.

   The consolidation that already exists is SPATIAL: several streams failing at
   once become one message. What was missing is TEMPORAL — several episodes of
   the same fault over an hour are still one fault, and the sixth email about it
   carries no information the first did not.

   So: the first outage emails immediately, exactly as before — the latency of
   the alert that matters is not the thing to pay with. A second confirmed
   outage on the same stream inside STORM_WINDOW_MS declares a storm, which
   sends ONE more email saying the stream is unstable, and then goes quiet for
   that stream. Every subsequent flap is still recorded in full — recording has
   always been decoupled from notifying — and emails nobody. When the stream has
   been healthy for STORM_CLEAR_AFTER_MS without interruption, one summary goes
   out with the totals, and normal alerting resumes.

   Set STORM_WINDOW_MS=0 to disable this entirely and alert on every episode. */
// Confirmed outages on one stream, inside the window, that declare a storm.
// Floored at 2: at 1 the very first outage of an isolated fault would be
// declared a storm and the all-clear would never be more than noise.
const STORM_OUTAGE_COUNT = Math.max(2, parseInt(process.env.STORM_OUTAGE_COUNT, 10) || 2);
const STORM_WINDOW_MS = Math.max(0, parseInt(process.env.STORM_WINDOW_MS, 10) || 45 * 60 * 1000);
// How long a stream must stay healthy before a storm is called over. Long
// enough to outlast the gap between flaps — an encoder that drops every ten
// minutes must not be declared stable in the eleventh.
const STORM_CLEAR_AFTER_MS = Math.max(60 * 1000, parseInt(process.env.STORM_CLEAR_AFTER_MS, 10) || 30 * 60 * 1000);
// A storm suppresses REPETITION. It must never suppress DURATION.
//
// The clear-down above can only be reached by a stream going healthy, and a
// stream that flaps and then stays down never does: its episode stays open, so
// `resolveStorms()` skips it every cycle, so the storm stays active and every
// further outage is silenced — for ever, and the longer the outage runs the more
// certain the silence. Observed on KPFT 2026-09-02: 52 alerts up to 13:47, then
// a permanent DOWN at 15:44 that nobody was told about because the flapping that
// preceded it had already declared a storm.
//
// So a suppressed outage that has now run this long escalates ONCE, on duration
// alone, and says it is a continuing outage rather than a new one. 0 disables.
const STORM_SUSTAINED_MS = (() => {
  const raw = parseInt(process.env.STORM_SUSTAINED_MS, 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 15 * 60 * 1000;
})();
// Escape hatch: alert on every confirmed outage, even ones Icecast proves did
// not touch a single listener. Off by default — that behaviour is what buried
// the real alerts in noise. Tolerant of case and stray whitespace, because this
// gets typed into a hosting-panel text field where a capitalised value or a
// pasted tab would otherwise leave alerts silently switched on.
// Which stations may send email, for stations that have NOT been configured in
// the admin panel. Empty means all of them, which is what a single-station
// deployment has always had.
//
// This was written as a stopgap: recipients were one global list, so any station
// added to the panel would have signed the first station's staff up for its
// outages — a GM paged at 3am about a station in another city. Recipients are
// now per-station, and a station configured there answers for itself and
// overrides this variable entirely (see alertsEnabledFor).
//
// It remains as the DEFAULT for stations nobody has configured yet, which is the
// right default: a station being trialled, or one whose staff have not been
// onboarded, should be recorded in full and email nobody.
const ALERT_STATIONS = (process.env.ALERT_STATIONS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ALERT_ON_HARMLESS_OUTAGE =
  String(process.env.ALERT_ON_HARMLESS_OUTAGE ?? '').trim().toLowerCase() === 'true';

// ── Weekly roundup schedule ─────────────────────────────────────────────────
// Every timestamp a human reads is in the station's own timezone, so the report
// covers the week they lived through rather than a UTC one.
const STATION_TZ = process.env.STATION_TZ || 'America/Chicago';

// The product's own name, as it appears to recipients — the email footer, the
// test alert, the sign-in page.
//
// A single switch rather than a string repeated across the codebase, because the
// destination is undecided: Pacifica is the goal now, and the same code may
// later be deployed elsewhere or under another name. Debranding should be a
// configuration change, not a search-and-replace through the mailer.
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Pacifica Stream Monitor';
const PRODUCT_OWNER = process.env.PRODUCT_OWNER || 'Pacifica Foundation';
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
  // The store is the only authority. ALERT_STATIONS seeded this at migration and
  // is not consulted again — reading it here as well would mean a station could
  // be switched on in the panel and still send nothing because of a variable
  // typed into a hosting panel weeks earlier that no screen displays. A silent
  // no-op is the one failure a screen like this must not have.
  //
  // A station with no block at all — added since the migration — is ON with an
  // empty list, so nothing is sent and describeAlertRouting() says exactly why:
  // "no recipients have been added yet". That is a to-do an operator can act on,
  // where a silent mute is not.
  return stream?.stationAlerts?.enabled !== false;
}

/**
 * One-time migration: environment recipient lists become each station's own.
 *
 * Recipients were the last piece of configuration still read from the
 * environment at send time, which is why the admin panel could show a station
 * "2 recipients" in one line and "none set" in the next: the two addresses that
 * actually received KPFT's alerts lived in a variable no screen could display or
 * edit. Every other setting in this system follows "env seeds once, the store
 * owns" — this brings recipients into line with that, and the panel becomes
 * ordinary as a result.
 *
 * THE ONE THING THIS MUST NOT DO IS CHANGE WHO RECEIVES EMAIL.
 *
 * `ALERT_STATIONS` currently names the only station permitted to email. Copying
 * ALERT_EMAILS onto every station would sign that station's staff up for three
 * others in three different cities — the exact 3am failure per-station
 * recipients exist to prevent. So a station is seeded with the addresses only if
 * it may email today; every other station is seeded explicitly empty and
 * disabled, which is what it already effectively is.
 *
 * ALERT_CC is merged into the same single list rather than seeded separately.
 * To/CC distinguishes people, not automated alerts, and it has a real member
 * today whose loss would silently stop the monitor owner receiving anything.
 *
 * Pure and exported so the before/after equivalence can be tested against the
 * real production shape without booting anything.
 */
function seedAlertsFromEnv(config, env = {}) {
  const emails = (env.alertEmails ?? process.env.ALERT_EMAILS ?? '')
    .split(',').map((e) => e.trim()).filter(Boolean);
  const cc = (env.alertCc ?? process.env.ALERT_CC ?? '')
    .split(',').map((e) => e.trim()).filter(Boolean);
  const stations = (env.alertStations ?? process.env.ALERT_STATIONS ?? '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

  // Merged and deduplicated case-insensitively, keeping the form as typed.
  const merged = [];
  const seen = new Set();
  for (const addr of [...emails, ...cc]) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(addr);
  }

  const next = JSON.parse(JSON.stringify(config));
  next.stations = (next.stations || []).map((station) => {
    // A station already configured in the panel is never overwritten. The store
    // is authoritative; this only fills in what was never set.
    if (station.alerts && Object.keys(station.alerts).length) return station;

    const permitted = !stations.length || stations.includes(String(station.id).toLowerCase());
    return {
      ...station,
      alerts: permitted
        ? { enabled: true, recipients: merged }
        // Explicitly empty and off, rather than absent. "Nobody has set this up"
        // and "this was switched off" must not be the same state, and today's
        // answer for these stations is genuinely the second one.
        : { enabled: false, recipients: [] },
    };
  });
  return next;
}

/** Why nothing was sent, in the words of whichever rule actually withheld it. */
/**
 * Did this episode clear before it was ever confirmed as an outage?
 *
 * A predicate rather than an expression at the call site because it was written
 * there as `!episode.alerted` — "nobody was emailed" — which is a different
 * question with a different answer. A confirmed outage on a station with alerts
 * switched off answered TRUE to that one, so the history called a four-minute
 * confirmed outage "self-cleared before confirmation" while carrying
 * `confirmed: true` on the same event.
 *
 * An episode reaches severity 'outage' only at confirmation (FAILURE_THRESHOLD
 * consecutive failures); it starts as a brief outage or a probe anomaly.
 */
function isSelfCleared(episode) {
  return episode?.severity !== 'outage';
}

function mutedReasonFor(stream) {
  return `alerts are switched off for station "${stream?.stationId || 'unknown'}"`;
}

/**
 * Who this stream's alerts go to.
 *
 * There is no fallback. `ALERT_EMAILS` seeded these lists once at migration and
 * is never read again — the panel would otherwise be able to display a list that
 * is not the list being emailed, which is exactly the confusion this replaced.
 */
function recipientsFor(stream) {
  const own = stream?.stationAlerts || {};
  return {
    recipients: Array.isArray(own.recipients) ? [...own.recipients] : [],
    // Retained only so a value stored before CC was retired is still honoured
    // rather than silently dropped. Nothing writes it any more and the panel
    // does not offer it.
    cc: Array.isArray(own.cc) ? [...own.cc] : [],
    source: 'station',
  };
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

/* ── Storm suppression ───────────────────────────────────────────────────────
   See the constants at the top of this file for why this exists. Three entry
   points, all called from the check cycle:

     noteStormEpisode()    at the moment an outage becomes alertable
     noteStormClear()  when it ends, to total the cost and start the clock
     resolveStorms()      every cycle, to notice a storm has ended            */

function blankStorm() {
  return { active: false, since: null, declaredAt: null, healthySince: null, outages: [] };
}

/** Storm state is meaningful across a redeploy, so it lives in the store. */
function saveStorms() {
  store.setMeta('storms', storms);
}

function loadStorms() {
  const saved = store.getMeta('storms');
  storms = saved && typeof saved === 'object' ? saved : {};
  // A storm that has been sitting in the store since before the last restart
  // may already have outlived its own clear window while nothing was watching.
  // resolveStorms() settles that on the first cycle; it is not decided here,
  // because ending a storm sends mail and init() must not send mail.
  const active = Object.keys(storms).filter((id) => storms[id]?.active);
  if (active.length) {
    console.log(`[Monitor] Restored storm suppression for ${active.join(', ')}`);
  }
}

/**
 * Records a confirmed, alertable FAILURE and says what to do about the email.
 *
 * Outages and dead air share one storm per stream deliberately. An encoder
 * fault that alternates between dropping its connection and feeding silence is
 * one fault with two symptoms, and two independent suppressors would let it
 * send twice as much mail by alternating between them.
 *
 *   'alert'    — send it normally. Nothing unusual is happening.
 *   'declare'  — send it, marked as a storm: this stream is now suppressed.
 *   'suppress' — send nothing. The stream is already known to be flapping.
 *
 * Called once per episode, never per cycle: the caller gates on the episode's
 * own alerted/stormSuppressed flags.
 */
function noteStormEpisode(stream, startedAt) {
  if (STORM_WINDOW_MS <= 0) return 'alert';

  const at = new Date(startedAt).getTime();
  const st = storms[stream.id] || (storms[stream.id] = blankStorm());

  // A new outage ends any run of good health, so the clear clock restarts from
  // the recovery that ends THIS outage rather than from the last one.
  st.healthySince = null;
  st.outages.push({ at, durationMs: null, listenersBefore: 0, listenerMinutesLost: 0 });

  if (st.active) {
    saveStorms();
    return 'suppress';
  }

  // Only outages inside the window count toward declaring one. An outage last
  // Tuesday and an outage today are two faults, not a storm.
  st.outages = st.outages.filter((o) => at - o.at < STORM_WINDOW_MS);

  if (st.outages.length >= STORM_OUTAGE_COUNT) {
    st.active = true;
    st.since = new Date(st.outages[0].at).toISOString();
    st.declaredAt = new Date(at).toISOString();
    saveStorms();
    return 'declare';
  }

  saveStorms();
  return 'alert';
}

/**
 * Closes out the current outage and starts the clock on the stream being well.
 *
 * The audience cost is taken from the settled figure the recovery branch
 * computes, because listener-minutes are unrecoverable once the sample window
 * closes — and the summary email exists to report exactly that total.
 */
function noteStormClear(stream, { durationMs, audience, timestamp }) {
  const st = storms[stream.id];
  if (!st) return;

  // The last outage without a duration is the one that just ended. Searching
  // backwards rather than taking the last element, so a record completed out of
  // order cannot make a finished outage look open forever.
  for (let i = st.outages.length - 1; i >= 0; i--) {
    if (st.outages[i].durationMs == null) {
      st.outages[i].durationMs = durationMs;
      st.outages[i].listenersBefore = audience?.listenersBefore || 0;
      st.outages[i].listenerMinutesLost = audience?.listenerMinutesLost || 0;
      break;
    }
  }

  st.healthySince = new Date(timestamp).getTime();
  saveStorms();
}

/** Totals for the summary email, over every outage the storm covered. */
function stormTotals(st) {
  const done = st.outages.filter((o) => o.durationMs != null);
  return {
    outages: st.outages.length,
    downtimeMs: done.reduce((a, o) => a + o.durationMs, 0),
    listenerMinutesLost: done.reduce((a, o) => a + (o.listenerMinutesLost || 0), 0),
    peakListeners: st.outages.reduce((a, o) => Math.max(a, o.listenersBefore || 0), 0),
    spanMs: st.outages.length
      ? (st.healthySince || Date.now()) - st.outages[0].at
      : 0,
  };
}

/**
 * Ends storms whose stream has been well long enough, and forgets stale state.
 *
 * Runs every cycle, including cycles where nothing failed — a storm ends by
 * NOTHING happening, so it can never be noticed from inside a failure branch.
 */
/**
 * Whether a storm-suppressed outage has now run long enough that the suppression
 * is doing the wrong thing, and this one episode must be escalated.
 *
 * Pure so the sequence can be replayed without a clock or an encoder. Returns
 * null when nothing should be sent, which is the overwhelmingly common case.
 */
function sustainedEscalation(episode, nowMs) {
  if (!episode || !episode.stormSuppressed || episode.sustainedAlerted) return null;
  if (!(STORM_SUSTAINED_MS > 0)) return null;               // explicitly disabled
  const startedMs = new Date(episode.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const downMs = nowMs - startedMs;
  if (downMs < STORM_SUSTAINED_MS) return null;
  return { downMs, since: episode.startedAt };
}

async function resolveStorms(timestamp) {
  const now = new Date(timestamp).getTime();
  let dirty = false;

  for (const streamId of Object.keys(storms)) {
    const st = storms[streamId];

    if (!st.active) {
      // Not a storm and not on its way to being one — let the record age out
      // so an outage a month from now starts from a clean count.
      const before = st.outages.length;
      st.outages = st.outages.filter((o) => now - o.at < STORM_WINDOW_MS);
      if (st.outages.length !== before) dirty = true;
      if (!st.outages.length) { delete storms[streamId]; dirty = true; }
      continue;
    }

    // Down again, or failing a check right now. Not stable by any reading.
    if (episodes[streamId]) continue;
    if (!st.healthySince) continue;
    if (now - st.healthySince < STORM_CLEAR_AFTER_MS) continue;

    const stream = streams.find((x) => x.id === streamId);
    if (!stream) { delete storms[streamId]; dirty = true; continue; }

    const totals = stormTotals(st);
    const steadyMs = now - st.healthySince;

    // Recorded whether or not it is emailed, for the same reason recoveries
    // are: the history has to be able to explain its own silence.
    const event = store.addEvent({
      timestamp,
      streamId: stream.id,
      streamName: stream.name,
      type: 'up',
      severity: 'recovery',
      confirmed: true,
      scope: 'stream',
      message:
        `${stream.name} has been stable for ${diagnose.fmtDuration(steadyMs)} — ` +
        `${totals.outages} outage${totals.outages === 1 ? '' : 's'} over ${diagnose.fmtDuration(totals.spanMs)}`,
      detail: { storm: { ...totals, since: st.since, steadyMs } },
      email: { attempted: false, sent: null, reason: 'pending' },
    });

    let email;
    if (!alertsEnabledFor(stream)) {
      email = { attempted: false, sent: false, reason: mutedReasonFor(stream) };
    } else {
      const byStream = await sendGroupedAlert({
        kind: 'storm_cleared',
        entries: [{ stream, storm: { ...totals, since: st.since, steadyMs } }],
        scope: 'stream',
      });
      email = byStream.get(stream.id) || { attempted: false, sent: false, reason: 'no message covered this stream' };
    }
    store.updateEvent(event.id, { email });

    console.log(
      `[Monitor] 🌤  ${stream.name} storm over — stable ${diagnose.fmtDuration(steadyMs)} after ` +
      `${totals.outages} outage(s), ${diagnose.fmtDuration(totals.downtimeMs)} down, ` +
      `${Math.round(totals.listenerMinutesLost)} listener-minutes lost`,
    );

    delete storms[streamId];
    dirty = true;
  }

  if (dirty) saveStorms();
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
// Repeated-outage state, one entry per stream. Persisted through store meta:
// a redeploy in the middle of a storm would otherwise forget it was suppressing
// and start the flood over from the first email, which is precisely the hour
// this mechanism exists to prevent.
let storms = {};          // { [streamId]: { active, since, healthySince, outages: [...] } }
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
let roundupAttempts = {};  // send retries for today's slot, keyed by station id
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
      // The station's timezone travels with the channel because ATH is a
      // CALENDAR-MONTH figure and a month boundary is only meaningful in a
      // timezone. Reading it back off the config at every call site is how two
      // figures for the same month end up an hour apart.
      out.push({
        ...channel,
        stationId: station.id,
        stationName: station.name,
        stationTimezone: station.timezone || 'UTC',
        // Who to tell when this channel breaks, carried on the channel for the
        // same reason the timezone is: reading it back off the config at the
        // moment of sending is how an alert ends up addressed from a different
        // configuration than the one that raised it. undefined when the station
        // has no block of its own, which is what selects the env-var fallback.
        stationAlerts: station.alerts,
      });
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

  // Recipients move out of the environment and into the store, once. Guarded by
  // a marker rather than by "does any station have alerts", because an operator
  // clearing the last address from every station must not look like a fresh
  // volume and get the env list written back underneath them.
  if (!store.getMeta('alertRecipientsSeeded')) {
    const before = JSON.stringify(cfg.stations.map((st) => st.alerts || null));
    cfg = seedAlertsFromEnv(cfg);
    store.setStationConfig(cfg);
    store.setMeta('alertRecipientsSeeded', new Date().toISOString());
    store.saveEvents();

    // The weekly roundup's one shared "sent this week" marker becomes one per
    // station. Copied rather than dropped: dropped, a container that redeploys
    // after a Monday send would send the same report a second time.
    const legacyDay = store.getMeta('lastWeeklyRoundupDay');
    if (legacyDay) {
      for (const st of cfg.stations) {
        if (store.getMeta(`lastWeeklyRoundupDay:${st.id}`)) continue;
        store.setMeta(`lastWeeklyRoundupDay:${st.id}`, legacyDay);
      }
    }

    if (JSON.stringify(cfg.stations.map((st) => st.alerts || null)) !== before) {
      const summary = cfg.stations
        .map((st) => `${st.id}=${st.alerts?.enabled === false ? 'off' : (st.alerts?.recipients || []).length}`)
        .join(' ');
      console.log(`[Monitor] Seeded alert recipients from environment — ${summary}`);
    }
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

  loadStorms();

  setupMailer();

  console.log(`[Monitor] Initialized with ${streams.length} streams`);
  console.log(`[Monitor] Check interval: ${CHECK_INTERVAL}ms, Failure threshold: ${FAILURE_THRESHOLD}`);
  // Reports what the STORE says, not what the env says. ALERT_STATIONS no longer
  // routes anything — a log line quoting it would describe a rule that is not
  // running, which is worse than no log line at all.
  const routing = (cfg.stations || [])
    .map((st) => {
      const n = (st.alerts?.recipients || []).length;
      return `${st.id}: ${st.alerts?.enabled === false ? 'off' : `${n} recipient(s)`}`;
    })
    .join(' · ');
  console.log(`[Monitor] Email alerts — ${routing || 'no stations configured'}`);
  console.log(`[Monitor] Retention: newest ${store.MAX_EVENTS} events, raw samples ${store.SAMPLE_RETENTION_DAYS}d then hourly rollups`);

  /* SAY WHETHER DEEP ANALYTICS IS ON, AND IF NOT, WHY.
     Without a credential this whole subsystem returns early and records
     nothing — correctly, but SILENTLY, and the only symptom is an audience
     figure that stays empty for ever. An operator who has typed two of the
     three settings into a hosting panel has no way to discover the third from
     outside the container, because the credential state is redacted from every
     public response (rightly). So it is stated at startup, where they look. */
  if (!LISTENER_DETAIL_ENABLED) {
    console.log('[Monitor] Listener detail: DISABLED (LISTENER_DETAIL_ENABLED=false)');
  } else {
    const host = adminHost();
    const hasUser = Boolean((process.env.ICECAST_ADMIN_USER || '').trim());
    const hasPass = Boolean(process.env.ICECAST_ADMIN_PASSWORD);
    if (host && hasUser && hasPass) {
      console.log(
        `[Monitor] Listener detail: ON for ${host} — individual listeners (cume), ` +
        `device and session detail, every ${LISTENER_DETAIL_EVERY} cycle(s)`,
      );
    } else {
      const missing = [
        !host && 'a monitored stream to derive the host from',
        !hasUser && 'ICECAST_ADMIN_USER',
        !hasPass && 'ICECAST_ADMIN_PASSWORD',
      ].filter(Boolean);
      console.warn(
        `[Monitor] Listener detail: OFF — missing ${missing.join(', ')}. ` +
        'Individual listeners (cume), device and session breakdowns will stay empty. ' +
        'Everything else is unaffected.',
      );
    }
  }
}

// ── May this process send email? ────────────────────────────────────────────
/**
 * Whether this is the DEPLOYED monitor, and may therefore mail the station's
 * real recipient list.
 *
 * WHY THIS EXISTS. Configuration lives in one .env, and a developer's copy of it
 * carries the production SMTP credentials and the real ALERT_EMAILS. So running
 * `node server.js` on a laptop mailed the station's General Manager — three
 * times, about a test fixture named "Seq" pointing at stream.example.org. The
 * recipients cannot tell a development alert from a real outage, and an alert
 * channel that cries wolf is worth less than no alert channel.
 *
 * THE ORDER OF THESE CHECKS IS THE WHOLE DESIGN. The guard must never silence a
 * real deployment, so it recognises production by several independent signals
 * and errs toward sending:
 *
 *   ALERTS_FORCE       explicit opt-in, for testing the mail path deliberately.
 *   MONITOR_CONTAINER  set by the Dockerfile — true for any build of this image.
 *   NODE_ENV           the conventional signal, when a platform sets it.
 *   /.dockerenv        present inside any Docker container. This one matters
 *                      most: it is true for the ALREADY-RUNNING production
 *                      container, so deploying this change cannot make a live
 *                      monitor go quiet while waiting for a rebuild.
 *
 * A laptop matches none of them. A deployment matches at least one.
 */
function isDeployedInstance() {
  if (String(process.env.ALERTS_FORCE || '').trim().toLowerCase() === 'true') return true;
  if (String(process.env.MONITOR_CONTAINER || '').trim()) return true;
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return true;
  // Cheap and synchronous, and only read at startup.
  try { return require('fs').existsSync('/.dockerenv'); } catch { return false; }
}

// Set when the guard withholds the mailer, so sendAlert() can report the real
// reason rather than the misleading "SMTP not configured".
let alertsSuppressedReason = null;

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

  // Checked BEFORE the transporter is built, so a development machine never
  // even authenticates against the station's SMTP account.
  if (!isDeployedInstance()) {
    alertsSuppressedReason =
      'not a deployed instance — alerts suppressed to protect the real recipient list';
    console.warn(
      '\n' +
      '  ┌──────────────────────────────────────────────────────────────┐\n' +
      '  │  EMAIL ALERTS ARE SUPPRESSED                                 │\n' +
      '  │                                                              │\n' +
      '  │  This process is not a deployed instance, and SMTP here is   │\n' +
      '  │  the station\'s real account. Alerts would reach real people. │\n' +
      '  │                                                              │\n' +
      '  │  To send anyway (it WILL email them): ALERTS_FORCE=true      │\n' +
      '  └──────────────────────────────────────────────────────────────┘\n',
    );
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

      // Dead air always emails — the transport is fine, so nobody else would
      // catch it — but a source feeding intermittent silence repeats like any
      // other encoder fault, and the sixth identical message is as worthless
      // here as it is for an outage.
      const verdict = noteStormEpisode(stream, timestamp);
      const st2 = storms[stream.id];

      let emailResult;
      if (!alertsEnabledFor(stream)) {
        // This path called sendAlert() directly and so never consulted the
        // station's mute at all: a station with alerts switched off was emailed
        // its dead air and its all-clear, because recipientsFor() answers with
        // the stored list whether or not the station is enabled. Every other
        // sender in this file checks; these two did not.
        emailResult = { attempted: false, sent: false, reason: mutedReasonFor(stream) };
        console.log(`[Monitor] 🔕 ${stream.name} dead air: recorded, not emailed — ${mutedReasonFor(stream)}`);
      } else if (verdict === 'suppress') {
        emailResult = {
          attempted: false,
          sent: false,
          reason: `suppressed — ${stream.name} is failing repeatedly; alerts resume when it stabilises`,
        };
        console.log(`[Monitor] 🌩  ${stream.name} dead air #${st2.outages.length} of an active storm — recorded, not emailed`);
      } else {
        emailResult = await sendAlert({
          kind: 'dead_air',
          entries: [{
            stream, result, diagnosis: dg,
            // Dead air keeps listeners connected to silence, so the whole current
            // audience is exposed to it — the same reach figure applies.
            audience: store.getAudienceContext(stream.id, timestamp),
            storm: verdict === 'declare' ? { ...stormTotals(st2), since: st2.since } : null,
          }],
          scope: 'stream',
        });
      }

      episodes[stream.id] = {
        eventId: event.id, startedAt: timestamp, severity: 'dead_air',
        // Whether the all-clear is owed. Hardcoded true until 2026-09-02, which
        // sent an "audio restored" to stations that were never told it stopped.
        alerted: emailResult.sent === true,
      };

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
  noteStormClear(stream, { durationMs: deadAirMs, audience, timestamp });

  // The same three silences the outage all-clear observes, for the same
  // reasons — see dispatchNotifications(). The event above is written whatever
  // this decides; only the mail is in question.
  let emailResult;
  if (!alertsEnabledFor(stream)) {
    emailResult = { attempted: false, sent: false, reason: mutedReasonFor(stream) };
  } else if (!episode?.alerted) {
    emailResult = {
      attempted: false, sent: false,
      reason: 'no all-clear sent — the dead air it ends was not emailed',
    };
  } else if (storms[stream.id]?.active) {
    emailResult = {
      attempted: false, sent: false,
      reason: `no all-clear sent — ${stream.name} is failing repeatedly; one summary follows when it stabilises`,
    };
  } else {
    emailResult = await sendAlert({
      kind: 'recovery',
      entries: [{ stream, result, diagnosis: dg, audience, durationMs: deadAirMs }],
      scope: 'stream',
      recoveredFrom: 'dead air',
    });
  }
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
    // This stream's own server: a variant is only "listed" if the host it lives
    // on lists it.
    const hostSnap = diagnose.snapshotForStream(snap, stream);
    // Skip paths[0]: that is the primary, probed every cycle by the main loop.
    for (const path of paths.slice(1)) {
      if (!hostSnap?.mounts?.[path]) continue;
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

    const byStream = await sendGroupedAlert({
      kind: 'degraded',
      entries,
      scope: 'stream',
    });
    for (const { stream, episode } of alerts) {
      store.updateEvent(episode.eventId, {
        email: byStream.get(stream.id) || { attempted: false, sent: false, reason: 'no message covered this stream' },
      });
    }
  }

  if (recoveries.length) {
    const entries = recoveries.map(({ stream, episode, durationMs }) => ({
      stream,
      result: { httpStatus: null, error: null, errorCode: null, responseTime: 0, timings: {} },
      diagnosis: { causeLabel: degradationCauseLabel(episode.impaired), scope: 'stream' },
      audience: { listenersBefore: episode.listenersBefore },
      durationMs,
    }));
    await sendGroupedAlert({
      kind: 'recovery',
      entries,
      scope: 'stream',
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

/**
 * The distinct Icecast servers currently being monitored, as
 * [{ host, statusUrl }].
 *
 * Derived from the live stream list rather than read from config.hosts, so a
 * station added while hosts[] was not rewritten still gets its own inventory
 * fetched instead of being looked up in some other server's. A configured
 * statusUrl for a host still wins — that is the only way to point at a status
 * document that is not at the conventional path.
 */
/* ── Icecast admin credentials ───────────────────────────────────────────────
   BOUND TO ONE HOST, DELIBERATELY.

   Several monitored stations run their own Icecast — KPFA is on both Pacifica's
   shared server and its own. Applying one admin credential to "every monitored
   host" would send Pacifica's admin password to streams.kpfa.org, which is a
   third party's machine. A credential is therefore attached to exactly the host
   it was issued for and to nothing else.

   Env is the supply mechanism until per-host entry exists in the admin panel
   (docs/AUDIENCE-ROADMAP.md §4.1), following the same "env seeds, the store
   owns" rule as the rest of the configuration. */
function adminHost() {
  // An explicit override, for the unusual case: a credential issued for a
  // server that is NOT the one carrying most of the channels.
  const explicit = (process.env.ICECAST_ADMIN_HOST || '').trim();
  if (explicit) return explicit;
  try {
    const fromStatus = new URL(process.env.ICECAST_STATUS_URL || '').host;
    if (fromStatus) return fromStatus;
  } catch { /* not set, or not a URL — fall through to derivation */ }

  /* DERIVED, because a hostname is not a secret and should not be a setting.
     `streams.pacifica.org:9000` is in the README, in STREAMS.md, and is the
     address listeners connect to — making an operator retype it to switch on a
     feature is friction that buys nothing.

     What the setting was ever FOR is scope: an admin password must reach one
     server and no other. KPFA is carried both on Pacifica's shared host and on
     its own at streams.kpfa.org:8443, so attaching one credential to "every
     monitored host" would post Pacifica's password to a third party's machine.

     So it is derived as the host carrying the MOST monitored channels — the
     shared server this monitor was set up against — and the credential still
     goes to exactly that one host. A station on its own server is a minority
     of one and never matches. */
  const tally = new Map();
  for (const st of streams) {
    let u; try { u = new URL(st.url); } catch { continue; }
    tally.set(u.host, (tally.get(u.host) || 0) + 1);
  }
  if (!tally.size) return '';
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return best[0];
}

function adminCredsFor(host) {
  const user = (process.env.ICECAST_ADMIN_USER || '').trim();
  const password = process.env.ICECAST_ADMIN_PASSWORD || '';
  if (!user || !password) return null;
  const scoped = adminHost();
  if (!scoped || host !== scoped) return null;
  return { user, password };
}

/* How often per-listener detail is collected, in check cycles. Session length
   comes from Icecast's own `Connected` counter rather than being inferred from
   polling, so minute resolution buys nothing here — five minutes catches every
   session and cuts the request volume fivefold. */
const LISTENER_DETAIL_EVERY = Math.max(1, parseInt(process.env.LISTENER_DETAIL_EVERY, 10) || 5);
const LISTENER_DETAIL_ENABLED = String(process.env.LISTENER_DETAIL_ENABLED ?? 'true').toLowerCase() !== 'false';

// Latest aggregate per "host+mount". Aggregates only — see listener-detail.js.
let listenerDetail = {};
let listenerDetailMeta = { lastRunAt: null, lastError: null, mounts: 0, host: null, distinctAddresses: null };

/**
 * Collect per-listener aggregates for every mount on a host we hold a
 * credential for.
 *
 * Sequential rather than parallel: this is somebody else's production server
 * and fifteen simultaneous admin requests every five minutes is a burst it has
 * no reason to absorb. The whole pass costs well under a second in practice.
 */
async function collectListenerDetail(hosts) {
  if (!LISTENER_DETAIL_ENABLED) return;
  const withCreds = (hosts || [])
    .map((h) => ({ ...h, creds: adminCredsFor(h.host) }))
    .filter((h) => h.creds);
  if (!withCreds.length) return;

  const next = {};
  let lastError = null;
  let hostDistinct = null;
  for (const h of withCreds) {
    const snap = snapshot?.byHost?.[h.host];
    const mountPaths = Object.keys(snap?.mounts || {});
    const base = h.statusUrl.replace(/\/[^/]*$/, '');

    /* Distinct addresses have to be unioned ACROSS mounts while the rows are in
       hand. Summing each mount's own count would double-count anyone listening
       to two mounts, and the per-mount counts cannot be merged afterwards for
       the same reason a median cannot — the set is gone by then.

       The addresses live in this Set and nowhere else; only its SIZE is kept. */
    const seen = new Set();

    /* Which CHANNEL each mount belongs to. Cume is a station-facing figure, so
       it is recorded against the channel a listener would name — not against
       /live_64, which is an implementation detail of the same channel. A device
       on two bitrates of one channel is one device, and unioning per channel is
       what makes that true. */
    const channelOf = new Map();
    for (const st of streams) {
      let u; try { u = new URL(st.url); } catch { continue; }
      if (u.host !== h.host) continue;
      for (const mp of diagnose.channelMountPaths(st)) channelOf.set(mp, st.id);
    }

    const salt = store.deviceSalt();
    const perChannel = new Map();   // streamId -> [{id, cls}]

    for (const mountPath of mountPaths) {
      const res = await listenerDetailModule.fetchListClients(base, mountPath, h.creds);
      if (!res.ok) { lastError = `${mountPath}: ${res.error}`; continue; }
      for (const r of res.rows) if (r.ip) seen.add(r.ip);

      const streamId = channelOf.get(mountPath);
      if (streamId) {
        const ids = listenerDetailModule.deviceIdentities(res.rows, salt);
        const bag = perChannel.get(streamId) || [];
        bag.push(...ids);
        perChannel.set(streamId, bag);
      }

      next[h.host + mountPath] = {
        ok: true, error: null, errorCode: null, responseTime: res.responseTime,
        ...listenerDetailModule.aggregate(res.rows, { mount: mountPath, host: h.host, geo }),
      };
    }

    // Written once per channel per pass, after every mount on it has been read,
    // so a channel's bitrate variants land in one bucket rather than racing.
    const nowIso = new Date().toISOString();
    for (const [streamId, ids] of perChannel) store.recordDevices(streamId, nowIso, ids);
    hostDistinct = seen.size;
    listenerDetailMeta.host = h.host;
  }

  listenerDetail = next;
  listenerDetailMeta.lastRunAt = new Date().toISOString();
  listenerDetailMeta.lastError = lastError;
  listenerDetailMeta.mounts = Object.keys(next).length;
  listenerDetailMeta.distinctAddresses = hostDistinct;
  // Folds hours past the hourly window into days and drops days past retention.
  // Cheap, and running it here keeps it on the same cadence as collection.
  store.compactDevices();
}

function currentHosts() {
  const configured = new Map();
  const cfg = store.getStationConfig();
  for (const h of cfg?.hosts || []) {
    if (h && h.host && h.statusUrl) configured.set(h.host, h.statusUrl);
  }

  const out = new Map();
  for (const s of streams) {
    let u;
    try { u = new URL(s.url); } catch { continue; }
    if (out.has(u.host)) continue;
    out.set(u.host, {
      host: u.host,
      statusUrl: configured.get(u.host) || `${u.protocol}//${u.host}/status-json.xsl`,
    });
  }
  return [...out.values()];
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
  const snap = await diagnose.fetchHostSnapshots(currentHosts());
  snapshot = snap;

  // Also before the probes, and for a second reason on top of the one above:
  // these are admin requests, not stream connections, so they add nobody to any
  // listener count — but reading the audience BEFORE opening our own probes
  // keeps the detail and the counts describing the same moment.
  if (cycleCount % LISTENER_DETAIL_EVERY === 1 % LISTENER_DETAIL_EVERY) {
    try {
      await collectListenerDetail(currentHosts());
    } catch (e) {
      // Never allowed to break a check cycle: this is an enrichment, and the
      // outage monitoring it sits beside is the part that matters.
      listenerDetailMeta.lastError = e.message;
      console.warn(`[Monitor] listener detail collection failed: ${e.message}`);
    }
  }

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
    (snap.reachable
      ? ` · Icecast OK (${snap.mountCount} mounts across ${snap.hosts.length} host(s))`
      : ` · Icecast PARTIAL/UNREACHABLE (${snap.fetchError})`),
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
    // The inventory of the server THIS stream lives on. "Icecast reachable" is
    // a per-host fact: one station's server being down says nothing about
    // another's, and reading it from the merged snapshot marked every station
    // unknown whenever any single host failed.
    const hostSnap = diagnose.snapshotForStream(snap, stream);
    const hostReachable = !!hostSnap?.reachable;
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
        : hostReachable
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
      mountListeners: hostReachable ? audience.perMount : prev.mountListeners || {},
      // The failing paths themselves, each with WHY, so the dashboard can name
      // them rather than leaving an operator to work out which of three mounts
      // "2 of 3" refers to. Only meaningful while Icecast is reachable — see
      // channelDegradation().
      impairedMounts: hostReachable
        ? degradation.impaired.map((m) => ({ path: m.path, reason: m.reason }))
        : prev.impairedMounts || [],
      degraded: degradation.degraded,
      title: mount?.title || prev.title || '',
      bitrate: mount?.bitrate || prev.bitrate || 128,
      streamStart: mount?.streamStart || prev.streamStart || '',
      mountPresent: !!mount,
      icecastReachable: hostReachable,
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

        const sustained = alertable ? sustainedEscalation(episode, Date.now()) : null;

        if (alertable && !episode.alerted && !episode.stormSuppressed) {
          // A stream flapping on a known fault has already said everything the
          // sixth email would say. The event is written either way; only the
          // mail is in question here.
          const verdict = noteStormEpisode(stream, episode.startedAt);

          if (verdict === 'suppress') {
            episode.stormSuppressed = true;
            const st = storms[stream.id];
            store.updateEvent(episode.eventId, {
              email: {
                attempted: false,
                sent: false,
                reason:
                  `suppressed — ${stream.name} is flapping (${st.outages.length} outages since ` +
                  `${new Date(st.since).toLocaleString('en-US', { timeZone: stream.stationTimezone || STATION_TZ })}); ` +
                  'alerts resume when it stabilises',
              },
            });
            console.log(`[Monitor] 🌩  ${stream.name} outage #${st.outages.length} of an active storm — recorded, not emailed`);
          } else {
            newlyNotable.push({
              stream, result, diagnosis: dg,
              eventId: episode.eventId,
              reason: 'confirmed outage',
              // Present only on the outage that DECLARES a storm, which is the
              // one email that has to explain why the next few will not arrive.
              storm: verdict === 'declare'
                ? { ...stormTotals(storms[stream.id]), since: storms[stream.id].since }
                : null,
              // What the audience WAS when this started. The loss cannot be
              // totalled until recovery, but the reach can — and "≈66 listeners
              // were connected" is the line that tells a reader in the first
              // second whether to get out of bed.
              audience: store.getAudienceContext(stream.id, episode.startedAt),
              startedAt: episode.startedAt,
            });
          }
        } else if (sustained) {
          // Storm suppression has been swallowing this stream's outages because
          // it was flapping. It has now been down continuously long enough that
          // "it keeps flapping" is no longer what is happening, and the storm's
          // own exit condition can never fire while the episode stays open.
          // Escalate exactly once per episode.
          episode.sustainedAlerted = true;
          const downMs = sustained.downMs;
          newlyNotable.push({
            stream, result, diagnosis: dg,
            eventId: episode.eventId,
            reason: 'sustained outage during storm',
            storm: null,
            sustained: { downMs, since: episode.startedAt },
            audience: store.getAudienceContext(stream.id, episode.startedAt),
            startedAt: episode.startedAt,
          });
          console.log(`[Monitor] 🚨 ${stream.name} still down after ${diagnose.fmtDuration(downMs)} during a storm — escalating past suppression`);
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
          selfCleared: isSelfCleared(episode),
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

        // Every CONFIRMED outage records its recovery. Whether an all-clear is
        // emailed is decided in dispatchNotifications(), and is not a condition
        // for writing the event.
        //
        // This was gated on `episode.alerted` until 2026-09-02, which tied the
        // record to the mail: a station with alerts switched off recorded going
        // down and never recorded coming back, and so did every confirmed outage
        // the listener-impact gate suppressed on a station that does email.
        // Recording is decoupled from notifying — the failure branch above says
        // so explicitly, and this is the same rule at the other end of an
        // episode.
        //
        // An episode that never reached `outage` is a brief outage or a probe
        // anomaly. Its own event already carries `resolvedAt` and a duration, and
        // it is deliberately given no recovery event: an all-clear for a
        // one-check blip is noise in a feed that has to stay readable.
        if (episode.severity === 'outage') {
          // Totals the cost of this outage against any storm and starts the
          // clock on the stream being well. Only confirmed outages count: a
          // one-check blip is not a flap, and treating it as one would keep a
          // storm alive on a stream that has actually recovered.
          noteStormClear(stream, { durationMs, audience, timestamp });
          recoveries.push({ stream, result, diagnosis: dg, episode, durationMs, sourceOutage, audience });
        } else {
          console.log(`[Monitor] ✓ ${stream.name} cleared after ${diagnose.fmtDuration(durationMs)} — never confirmed as an outage`);
        }
        delete episodes[stream.id];
      }
    }
  }

  // ── Notification pass ─────────────────────────────────────────────────────
  await dispatchNotifications(newlyNotable, recoveries, { allDown, timestamp, snapshot: snap });
  await dispatchDegradedNotices(degradedNotices);

  // A storm ends by nothing happening, so it can only be noticed from out here
  // — no failure branch will ever run on the cycle that proves a stream well.
  try {
    await resolveStorms(timestamp);
  } catch (err) {
    console.error('[Monitor] storm resolution failed:', err.message);
  }

  // Any alert a mail server refused earlier gets another try here. Wrapped
  // because a mail problem must never stop the stream checks — monitoring the
  // streams is the more important of the two jobs.
  try {
    await drainDeliveryRetries();
  } catch (err) {
    console.error('[Monitor] ✉️  delivery retry pass failed:', err.message);
  }

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
  // Split rather than filter: a muted DOWN event already exists by the time it
  // reaches here, and still needs its record updated to say why nothing was
  // sent.
  //
  // Recoveries are deliberately NOT split the same way. Their event has not been
  // written yet — it is written below — so filtering a muted recovery out here
  // did not mute it, it erased it. The muted loop could not have saved one
  // either: a recovery carries its outage's id as `episode.eventId`, never as
  // `eventId`, so it fell straight through the guard on the next line. Every
  // recovery is recorded below; only the mail is decided by muting.
  const mutedDown = newlyNotable.filter((n) => !alertsEnabledFor(n.stream));
  newlyNotable = newlyNotable.filter((n) => alertsEnabledFor(n.stream));

  for (const m of mutedDown) {
    if (!m.eventId) continue;
    store.updateEvent(m.eventId, {
      email: {
        attempted: false,
        sent: false,
        reason: mutedReasonFor(m.stream),
      },
    });
    console.log(`[Monitor] 🔕 ${m.stream?.name}: recorded, not emailed — ${mutedReasonFor(m.stream)}`);
  }

  if (newlyNotable.length > 0) {
    const serverScope =
      ctx.allDown && streams.length > 1
        ? 'server'
        : newlyNotable[0].diagnosis.scope;

    const entries = newlyNotable.map((n) => ({
      stream: n.stream, result: n.result, diagnosis: n.diagnosis, audience: n.audience,
      storm: n.storm, sustained: n.sustained,
    }));

    const byStream = await sendGroupedAlert({
      kind: 'down',
      entries,
      scope: serverScope,
    });

    for (const n of newlyNotable) {
      store.updateEvent(n.eventId, {
        email: byStream.get(n.stream.id) || { attempted: false, sent: false, reason: 'no message covered this stream' },
        alertedAt: ctx.timestamp,
      });
      const ep = episodes[n.stream.id];
      if (ep) ep.alerted = true;
    }
  }

  // Every recovery handed to this function is RECORDED. Emailing is a separate
  // decision with two conditions, and neither may reach the record:
  //
  //   · the outage it ends was itself emailed — an all-clear for an alert nobody
  //     received trains people to ignore the next one, and
  //   · the station has alerts enabled at all.
  //
  // Both used to decide whether the event was written. Muting a station is a
  // statement about who gets mail, never about what happened.
  if (recoveries.length > 0) {
    // A stream in a storm sends no all-clears. The outage that declared the
    // storm was emailed, so it passes the `alerted` test — but its recovery is
    // the second half of a pair this mechanism exists to stop, and the storm's
    // own summary is the all-clear that replaces it.
    const emailable = recoveries.filter(
      (r) => r.episode.alerted && alertsEnabledFor(r.stream) && !storms[r.stream.id]?.active,
    );

    let byStream = new Map();
    if (emailable.length > 0) {
      byStream = await sendGroupedAlert({
        kind: 'recovery',
        entries: emailable.map((r) => ({
          stream: r.stream, result: r.result, diagnosis: r.diagnosis,
          audience: r.audience, durationMs: r.durationMs,
        })),
        scope: emailable.length > 1 ? 'server' : emailable[0].diagnosis.scope,
      });
    }

    for (const r of recoveries) {
      const email = emailable.includes(r)
        ? byStream.get(r.stream.id) || { attempted: false, sent: false, reason: 'no message covered this stream' }
        : {
            attempted: false,
            sent: false,
            // Two different silences, and the record says which. A muted station
            // sends nothing at either end of the episode; an unalerted outage on
            // a station that does email has no all-clear because there was no
            // alarm to clear.
            reason: !alertsEnabledFor(r.stream)
              ? mutedReasonFor(r.stream)
              : storms[r.stream.id]?.active
              ? `no all-clear sent — ${r.stream.name} is flapping; one summary follows when it stabilises`
              : 'no all-clear sent — the outage it ends was not emailed',
          };

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
        email,
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
                <span class="footer-text" style="color: #94a3b8 !important;">${esc(PRODUCT_NAME)}${PRODUCT_OWNER ? ` · ${esc(PRODUCT_OWNER)}` : ''}</span>
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

/**
 * The stream table in an email, scoped to one station.
 *
 * It listed EVERY stream the monitor watches, regardless of who the message was
 * for. Testing an address just added to WPFW therefore sent that person the
 * listener counts for KPFT, KPFK and WBAI as well — four stations in four cities
 * whose figures are not theirs to receive. Absent a station it still renders
 * everything, which is correct for a single-station install and for a message
 * that genuinely covers the whole monitor.
 */
function renderAllStreamsTable(stationId) {
  // Scoped to one station. sendGroupedAlert() guarantees every entry in a
  // message shares a station, so the table can be addressed the same way the
  // message is: KPFT's general manager reading a KPFT outage has no business
  // being shown WPFW, KPFK and WBAI's listener counts, and it is the same
  // cross-station exposure per-station recipients exist to prevent.
  const scoped = stationId ? streams.filter((s) => s.stationId === stationId) : streams;
  const rows = scoped.map((s) => {
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
/**
 * Will this station's outages actually reach anyone, and if not, why not.
 *
 * Four independent things have to be true before an alert lands, and each of
 * them fails silently on its own: SMTP configured, the instance deployed, the
 * station not muted, and a recipient list that is not empty. An operator who has
 * just typed two addresses into a form and saved them is asking one question —
 * "will I be told?" — and no stored field answers it. Answering it from the
 * server means the panel cannot drift from what the sender actually does.
 */
function describeAlertRouting(stationId) {
  const stream = streams.find((s) => s.stationId === stationId);
  if (!stream) return { willSend: false, reason: 'no channels are configured for this station' };

  const resolved = recipientsFor(stream);
  const enabled = alertsEnabledFor(stream);

  const out = {
    recipientCount: resolved.recipients.length,
    ccCount: resolved.cc.length,
    enabled,
  };

  if (!transporter) {
    return { ...out, willSend: false, reason: alertsSuppressedReason || 'SMTP is not configured on this server' };
  }
  if (!enabled) return { ...out, willSend: false, reason: mutedReasonFor(stream) };
  if (!resolved.recipients.length) {
    return { ...out, willSend: false, reason: 'no recipients have been added yet' };
  }

  return { ...out, willSend: true, reason: null };
}

/**
 * Sends one message per STATION, never one message across two.
 *
 * Alerts are consolidated so that an Icecast host taking five mounts down
 * produces one email rather than five. That consolidation was written when the
 * monitor watched one station, and it grouped by NOTHING — every stream failing
 * in the same cycle went into a single message addressed to a single global
 * list. The moment recipients became per-station that became a leak: the host
 * these stations share means a server-side fault fails KPFT, WPFW, KPFK and WBAI
 * in the same second, so the one message would have gone to whichever station
 * happened to sort first, telling them about three stations in other cities and
 * telling the other three nobody.
 *
 * Grouping lives HERE, at the single point every alert passes through, rather
 * than at the four call sites that consolidate — two of which are the degraded
 * paths, where it would have been just as wrong and much less likely to be
 * noticed.
 *
 * Returns the delivery record per stream id, because each stream's event stores
 * its own: two stations now means two different outcomes for one cycle, and one
 * of them can fail while the other succeeds.
 */
function groupEntriesByStation(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    // A stream with no station groups under '' — alone, and never folded in
    // with a real station's message. An unattributed failure is exactly the
    // case where guessing an owner sends it to the wrong people.
    const key = String(entry.stream?.stationId || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()];
}

async function sendGroupedAlert(opts) {
  const byStream = new Map();

  for (const entries of groupEntriesByStation(opts.entries)) {
    const consolidated = entries.length > 1;
    const result = await sendAlert({ ...opts, entries, consolidated });
    // Stored on the event so the history page can still say a message covered
    // several streams — now meaning several streams OF THIS STATION.
    const record = { ...result, consolidated };
    for (const entry of entries) byStream.set(entry.stream.id, record);
  }

  return byStream;
}

/* ── Deferred delivery retries ───────────────────────────────────────────────
   A mail server refusing a recipient is usually TEMPORARY: greylisting, a
   restart, an hourly rate cap, a moment of load. On 2026-09-02 hype.net refused
   one KPFT recipient at 9:44 and again at 9:46, then accepted normally from 9:47
   onward — a roughly three-minute window that cost that recipient the DOWN alert
   for an outage that was still in progress. The message was never retried, so a
   transient refusal became a permanently missing alert.

   This is the same reasoning the Icecast status fetch already runs on: a
   one-second hiccup between two machines must not change the outcome. The
   difference is the timescale — a refused mailbox needs minutes, not seconds, so
   retrying inline would stall the check cycle. Instead the send is queued and
   drained by the cycle that is already running every minute.

   ONLY THE REFUSED RECIPIENTS ARE RETRIED. Re-sending the whole message would
   mail the people who already received it a second copy, and a duplicate outage
   alert is its own kind of noise.

   Permanent refusals (5xx — no such mailbox) are NOT retried: the answer will
   not change, and the event record says so instead.

   The queue is in memory. A redeploy mid-retry drops pending attempts, which is
   acceptable because nothing is lost silently — the event keeps its
   `delivery: 'partial'` verdict and the history page keeps showing it. */
const ALERT_RETRY_SCHEDULE_MS = (process.env.ALERT_RETRY_SCHEDULE_MS || '60000,180000,420000')
  .split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);

const pendingDeliveries = [];
let deliverySeq = 0;

/** Whether a refusal is worth trying again. 4xx is temporary; 5xx is final. */
function isTransientRefusal(responseCode) {
  if (responseCode == null) return true;    // no code — assume temporary rather than give up
  return responseCode >= 400 && responseCode < 500;
}

/**
 * Per-recipient refusal detail from a nodemailer result.
 *
 * `rejectedErrors` carries the SMTP response code for each refused address,
 * which is the only thing that distinguishes "try again in a minute" from
 * "this mailbox does not exist".
 */
function refusalDetail(info) {
  const errors = Array.isArray(info?.rejectedErrors) ? info.rejectedErrors : [];
  const byAddress = new Map();
  for (const e of errors) {
    const addr = e?.recipient || e?.address;
    if (addr) byAddress.set(String(addr).toLowerCase(), { code: e?.responseCode ?? null, message: e?.message || '' });
  }
  return byAddress;
}

/**
 * Reads a nodemailer result honestly.
 *
 * `sendMail` RESOLVES on a PARTIAL delivery failure. The SMTP dialogue can
 * refuse individual RCPT TO addresses and accept the rest; the returned promise
 * only rejects when every recipient is refused. So "it did not throw" means "at
 * least one mailbox took it" — never "it was delivered".
 *
 * All three senders in this file read it as the latter. On 2026-09-02 a KPFT
 * DOWN alert was stored `sent: true` and rendered "Alert sent: Yes" while the
 * same result object carried `rejected: [<an address>]`; the refusal was
 * recorded and read by nothing, so the only evidence the alert never arrived
 * was its intended recipient noticing the silence. Every sender goes through
 * here now, so a fourth cannot reintroduce it by writing `sent: true` inline.
 */
function deliveryOutcome(info, recipients = [], cc = []) {
  const rejected = (Array.isArray(info?.rejected) ? info.rejected : []).map(String);
  // Transports that report neither list (jsonTransport, stubs) leave us with
  // the recipient list we asked for, which is the correct assumption for a
  // transport that cannot refuse anyone.
  const accepted = Array.isArray(info?.accepted)
    ? info.accepted.length
    : Math.max(recipients.length + cc.length - rejected.length, 0);

  const detail = refusalDetail(info);
  const retryable = rejected.filter((a) => isTransientRefusal(detail.get(a.toLowerCase())?.code));
  const permanent = rejected.filter((a) => !retryable.includes(a));

  return {
    accepted,
    rejected,
    rejectedCount: rejected.length,
    // Split so the record says whether the missing recipient can still be
    // reached. "Refused, and it will never work" and "refused, retrying" are
    // different facts and lead to different actions.
    retryableRejections: retryable,
    permanentRejections: permanent,
    // A message every recipient refused is not a send, even where the transport
    // resolves rather than throwing.
    sent: accepted > 0,
    // The verdict every reader must consult before claiming an alert arrived.
    // `sent` alone cannot express "two of the three people were told".
    delivery: accepted === 0 ? 'none' : rejected.length ? 'partial' : 'all',
  };
}

/**
 * Queues the refused recipients of a message for another try.
 *
 * Returns the schedule actually applied, so the delivery record on the event
 * can say a retry is pending rather than leaving a bare "partial".
 */
function queueDeliveryRetry({ deliveryId, from, to, cc, subject, html, reason }) {
  if (!to.length || !ALERT_RETRY_SCHEDULE_MS.length) return null;

  pendingDeliveries.push({
    deliveryId,
    from, to, cc: cc || [], subject, html,
    attempt: 0,
    nextAt: Date.now() + ALERT_RETRY_SCHEDULE_MS[0],
    reason,
  });

  console.warn(
    `[Monitor] ✉️  queued retry for ${to.length} refused recipient(s) — ` +
    `${to.join(', ')} — first retry in ${Math.round(ALERT_RETRY_SCHEDULE_MS[0] / 1000)}s`,
  );
  return { attempts: ALERT_RETRY_SCHEDULE_MS.length, nextAt: new Date(Date.now() + ALERT_RETRY_SCHEDULE_MS[0]).toISOString() };
}

/**
 * Rewrites the delivery record on every event a message covered.
 *
 * The events are found by `email.deliveryId` rather than tracked by id, because
 * a single message covers several events and, for recoveries, the event does not
 * exist yet when the send happens.
 */
function patchDeliveryRecord(deliveryId, patch) {
  if (!deliveryId) return 0;
  let touched = 0;
  // Bounded by the retry schedule rather than scanning the whole record: a job
  // cannot outlive its own backoff, so nothing older than a day can match.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { events } = store.getEvents({ since, limit: 5000 });

  for (const e of events) {
    if (e.email?.deliveryId !== deliveryId) continue;
    store.updateEvent(e.id, { email: { ...e.email, ...patch } });
    touched++;
  }
  if (touched) store.saveEvents();
  return touched;
}

/**
 * Retries whatever is due. Called once per check cycle.
 *
 * Never throws: a failure here must not take down the cycle that is monitoring
 * the streams, which is the more important job of the two.
 */
async function drainDeliveryRetries() {
  if (!pendingDeliveries.length || !transporter) return;
  const now = Date.now();

  for (const job of [...pendingDeliveries]) {
    if (job.nextAt > now) continue;
    job.attempt++;

    try {
      const info = await transporter.sendMail({
        from: job.from,
        to: job.to.join(', '),
        ...(job.cc.length ? { cc: job.cc.join(', ') } : {}),
        subject: job.subject,
        html: job.html,
      });
      const outcome = deliveryOutcome(info, job.to, job.cc);

      if (outcome.rejected.length === 0) {
        pendingDeliveries.splice(pendingDeliveries.indexOf(job), 1);
        console.log(`[Monitor] ✉️  retry ${job.attempt} DELIVERED to ${job.to.join(', ')} — ${job.subject}`);
        patchDeliveryRecord(job.deliveryId, {
          delivery: 'all',
          rejected: [],
          rejectedCount: 0,
          retry: { attempts: job.attempt, deliveredAt: new Date().toISOString(), recovered: true },
        });
        continue;
      }

      // Still refused. Keep only the addresses that are still worth trying.
      job.to = outcome.retryableRejections;
      scheduleNextRetry(job, outcome.rejected);
    } catch (err) {
      // The whole send failed — server down or unreachable. Always temporary
      // enough to be worth another attempt within the schedule.
      console.warn(`[Monitor] ✉️  retry ${job.attempt} failed for ${job.to.join(', ')} — ${err.message}`);
      scheduleNextRetry(job, job.to, err.message);
    }
  }
}

/** Reschedules a job, or gives up and records why. */
function scheduleNextRetry(job, stillRefused, errorMessage) {
  const nextDelay = ALERT_RETRY_SCHEDULE_MS[job.attempt];

  if (!job.to.length || nextDelay == null) {
    pendingDeliveries.splice(pendingDeliveries.indexOf(job), 1);
    console.error(
      `[Monitor] ✉️  GIVING UP after ${job.attempt} retries — ${(stillRefused || []).join(', ')} ` +
      `never received "${job.subject}"${errorMessage ? ` (${errorMessage})` : ''}`,
    );
    patchDeliveryRecord(job.deliveryId, {
      retry: {
        attempts: job.attempt,
        exhausted: true,
        gaveUpAt: new Date().toISOString(),
        stillRefused: stillRefused || [],
        error: errorMessage || null,
      },
    });
    return;
  }

  job.nextAt = Date.now() + nextDelay;
  patchDeliveryRecord(job.deliveryId, {
    retry: { attempts: job.attempt, pending: true, nextAt: new Date(job.nextAt).toISOString() },
  });
}

async function sendAlert(opts) {
  const attemptedAt = new Date().toISOString();

  if (!transporter) {
    return {
      attempted: false,
      sent: false,
      reason: alertsSuppressedReason || 'SMTP not configured',
      attemptedAt,
    };
  }

  // Addressed from the station the entries belong to. Every caller already
  // passes the streams involved, so resolving it HERE rather than asking each
  // one to pass a recipient list means a new alert type cannot be added that
  // silently mails the global fallback — it gets the right list by default.
  //
  // sendGroupedAlert() guarantees the entries share a station; a message that
  // spanned two would be addressed to the first one's staff.
  const audienceFor = opts.entries?.[0]?.stream;
  const resolved = opts.recipients
    ? { recipients: opts.recipients, cc: opts.cc || [], source: 'explicit' }
    : recipientsFor(audienceFor);

  const recipients = resolved.recipients;
  if (recipients.length === 0) {
    console.warn(`[Monitor] No alert recipients configured for station "${audienceFor?.stationId || 'unknown'}"`);
    return {
      attempted: false,
      sent: false,
      reason: resolved.source === 'station'
        ? 'no recipients configured for this station'
        : 'no recipients configured',
      attemptedAt,
    };
  }

  const ccRecipients = resolved.cc;
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  const { subject, html } = composeAlert(opts);

  try {
    const mailOptions = { from: fromAddr, to: recipients.join(', '), subject, html };
    if (ccRecipients.length > 0) mailOptions.cc = ccRecipients.join(', ');

    const info = await transporter.sendMail(mailOptions);

    const outcome = deliveryOutcome(info, recipients, ccRecipients);
    const deliveryId = `d${Date.now().toString(36)}-${++deliverySeq}`;
    let retry = null;

    if (outcome.rejected.length) {
      console.warn(`[Monitor] ✉️  ${outcome.rejected.length} recipient(s) REJECTED by the mail server — ${outcome.rejected.join(', ')} — ${subject}`);
      // A refusal that can still succeed is queued rather than written off. This
      // is the difference between "you were not told" and "you were told a
      // minute late".
      retry = queueDeliveryRetry({
        deliveryId, from: fromAddr,
        to: outcome.retryableRejections,
        cc: [], subject, html,
        reason: 'refused at RCPT TO',
      });
    }

    return {
      attempted: true,
      ...outcome,
      deliveryId,
      ...(retry ? { retry: { attempts: 0, pending: true, nextAt: retry.nextAt } } : {}),
      attemptedAt,
      sentAt: new Date().toISOString(),
      recipients,
      cc: ccRecipients,
      subject,
      messageId: info?.messageId || null,
      error: null,
    };
  } catch (err) {
    console.error('[Monitor] ✉️  FAILED to send alert email:', err.message);
    // The send failed outright — the mail server was unreachable, restarting, or
    // refused the whole envelope. That is exactly the case the recipient never
    // hears about otherwise, so it is queued like a partial refusal. When the
    // envelope carries per-address codes, a permanently dead mailbox is dropped
    // from the retry rather than tried three more times for nothing.
    const detail = refusalDetail(err);
    const refused = Array.isArray(err?.rejected) && err.rejected.length
      ? err.rejected.map(String)
      : recipients;
    const worthRetrying = refused.filter((a) => isTransientRefusal(detail.get(a.toLowerCase())?.code));

    const deliveryId = `d${Date.now().toString(36)}-${++deliverySeq}`;
    const retry = queueDeliveryRetry({
      deliveryId, from: fromAddr, to: worthRetrying, cc: ccRecipients,
      subject, html, reason: err.message,
    });

    return {
      attempted: true,
      sent: false,
      delivery: 'none',
      deliveryId,
      ...(retry ? { retry: { attempts: 0, pending: true, nextAt: retry.nextAt } } : {}),
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
/**
 * The end of a storm: one message covering every outage it suppressed.
 *
 * Written as its own message rather than as a variant of the recovery template,
 * because it answers a different question. A recovery says "the thing that was
 * broken is fixed"; this says "the thing that kept breaking has stopped, and
 * here is what it cost in total" — which is the only email in the sequence that
 * an engineer can act on the morning after.
 */
function composeStormCleared({ entries }) {
  const { stream, storm } = entries[0];
  const tz = stream?.stationTimezone || STATION_TZ;
  const owner = stream?.stationName || 'Stream';

  const steady = diagnose.fmtDuration(storm.steadyMs);
  const cost = Math.round(storm.listenerMinutesLost);

  const subject =
    `🟢 ${owner} Alert: ${stream.name} — STABLE for ${steady} · ` +
    `${storm.outages} outage${storm.outages === 1 ? '' : 's'} in total`;

  const started = new Date(storm.since).toLocaleString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });

  const contentHtml = `
    <div class="callout-box" style="background-color:#211e3b; border:1px solid #3d3575; border-radius:8px; padding:16px; margin-bottom:16px;">
      <p class="callout-title" style="margin:0 0 6px 0; font-weight:700; font-size:15px; color:#c4b5fd !important;"><span class="callout-title" style="color:#c4b5fd !important;">Repeated outages have stopped</span></p>
      <p class="callout-text" style="margin:0; font-size:13px; line-height:1.6; color:#e2e8f0 !important;"><span class="callout-text" style="color:#e2e8f0 !important;">${esc(stream.name)} went down and recovered ${storm.outages} time${storm.outages === 1 ? '' : 's'} and has now been serving without interruption for ${esc(steady)}. Individual alerts were paused after the second outage so this mailbox would not fill with them; every one is recorded on the dashboard. Normal alerting has resumed.</span></p>
    </div>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
      ${row('Stream', `<span class="val-col" style="color:#f8fafc !important;">${esc(stream.name)}</span>`)}
      ${row('Started', `<span class="val-col" style="color:#f8fafc !important;">${esc(started)}</span>`)}
      ${row('Outages', `<span class="val-col" style="color:#f8fafc !important;">${storm.outages} over ${esc(diagnose.fmtDuration(storm.spanMs))}</span>`)}
      ${row('Total downtime', `<span class="val-col" style="color:#f8fafc !important;">${esc(diagnose.fmtDuration(storm.downtimeMs))}</span>`)}
      ${row('Peak audience affected', `<span class="val-col" style="color:#f8fafc !important;">${storm.peakListeners} listener${storm.peakListeners === 1 ? '' : 's'}</span>`)}
      ${row('Audience cost', `<span class="val-col" style="color:#f8fafc !important;">≈${cost} listener-minute${cost === 1 ? '' : 's'} lost</span>`)}
      ${row('Stable since', `<span class="val-col" style="color:#4ade80 !important;">${esc(steady)} ago</span>`, true)}
    </table>
    <hr style="border: none; border-top: 1px solid #28283d; margin: 20px 0;">
    ${renderAllStreamsTable(stream?.stationId)}`;

  return {
    subject,
    html: buildEmailHtml({
      title: '🟢 Stream STABLE',
      subtitle:
        `${stream.name} has been on air without interruption for ${steady}, after ${storm.outages} ` +
        `outage${storm.outages === 1 ? '' : 's'} costing roughly ${cost} listener-minute${cost === 1 ? '' : 's'}.`,
      headerBg: 'linear-gradient(135deg, #16a34a, #15803d)',
      contentHtml,
    }),
  };
}

function composeAlert({ kind, entries, scope, consolidated = false, recoveredFrom = null }) {
  if (kind === 'storm_cleared') return composeStormCleared({ entries });

  const isDeadAir = kind === 'dead_air';
  const isRecovery = kind === 'recovery';
  // A degraded channel is NOT down, and must never be described as though it
  // were. It is its own state: playing, on fewer mounts than it publishes.
  const isDegraded = kind === 'degraded';
  const isDown = !isRecovery && !isDegraded;

  const emoji = isDeadAir ? '🔇' : isDegraded ? '🟠' : isDown ? '🔴' : '🟢';
  let statusText = isDeadAir ? 'DEAD AIR (SILENCE)'
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
  // A storm renames the state outright: "DOWN" for the third time in an hour
  // describes the moment accurately and the situation badly.
  const allStorm = entries.length > 0 && entries.every((e) => e.storm);
  if (allStorm && isDown) statusText = 'UNSTABLE';

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

  // The clock of the station this alert is ABOUT. An engineer reading "2:00 PM"
  // for a Los Angeles outage assumed Los Angeles; the message meant Houston.
  // The zone is now named in the string as well, so it cannot be misread.
  const alertZones = [...new Set(entries.map((e) => e.stream?.stationTimezone).filter(Boolean))];
  const alertTz = alertZones.length === 1 ? alertZones[0] : 'UTC';
  const detectedAt = new Date().toLocaleString('en-US', {
    timeZone: alertTz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    timeZoneName: 'short',
  });

  const blocks = entries.map((e, i) => renderStreamBlock(e, i, entries.length)).join('');

  // An email that goes quiet without saying so reads as a monitor that died.
  // The alert that declares a storm is the one chance to tell the recipient
  // that the silence which follows is deliberate, and what will end it.
  const stormNotice = entries.filter((e) => e.storm).map((e) => `
    <div class="callout-box" style="background-color:#211e3b; border:1px solid #3d3575; border-radius:8px; padding:16px; margin-bottom:16px;">
      <p class="callout-title" style="margin:0 0 6px 0; font-weight:700; font-size:15px; color:#c4b5fd !important;"><span class="callout-title" style="color:#c4b5fd !important;">⏸ Further alerts for ${esc(e.stream.name)} are paused</span></p>
      <p class="callout-text" style="margin:0; font-size:13px; line-height:1.6; color:#e2e8f0 !important;"><span class="callout-text" style="color:#e2e8f0 !important;">This is the ${e.storm.outages}${e.storm.outages === 2 ? 'nd' : e.storm.outages === 3 ? 'rd' : 'th'} time this stream has failed and recovered in ${esc(diagnose.fmtDuration(e.storm.spanMs || 0))}. Repeating like this almost always means the source encoder is dropping its connection, rather than the stream server failing. You will not be emailed about each one. Every outage is still recorded on the dashboard, and one summary will arrive once ${esc(e.stream.name)} has stayed on air for ${esc(diagnose.fmtDuration(STORM_CLEAR_AFTER_MS))}.</span></p>
    </div>`).join('');

  // The counterpart to the storm notice. That one promises silence; this one
  // breaks it, so it has to say plainly that this is the SAME outage continuing
  // rather than a new one, or it reads as the flood the suppression prevents.
  const sustainedNotice = entries.filter((e) => e.sustained).map((e) => `
    <div class="callout-box" style="background-color:#3b1e1e; border:1px solid #7f1d1d; border-radius:8px; padding:16px; margin-bottom:16px;">
      <p class="callout-title" style="margin:0 0 6px 0; font-weight:700; font-size:15px; color:#fca5a5 !important;"><span class="callout-title" style="color:#fca5a5 !important;">\u26a0 ${esc(e.stream.name)} is STILL DOWN \u2014 ${esc(diagnose.fmtDuration(e.sustained.downMs || 0))}</span></p>
      <p class="callout-text" style="margin:0; font-size:13px; line-height:1.6; color:#e2e8f0 !important;"><span class="callout-text" style="color:#e2e8f0 !important;">This is not a new outage. ${esc(e.stream.name)} was flapping, so alerts were paused \u2014 but it has now been off the air continuously for ${esc(diagnose.fmtDuration(e.sustained.downMs || 0))}. That is no longer flapping, so this one message is being sent through the pause. You will not be emailed again about this outage; the all-clear will arrive when it recovers.</span></p>
    </div>`).join('');

  const contentHtml = `
    ${sustainedNotice}
    ${stormNotice}
    ${blocks}
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-top:16px;">
      ${row('Detected At', `<span class="val-col" style="color:#f8fafc !important;">${detectedAt} CT</span>`, true)}
    </table>
    <hr style="border: none; border-top: 1px solid #28283d; margin: 20px 0;">
    ${renderAllStreamsTable(entries?.[0]?.stream?.stationId)}`;

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

/**
 * Live per-channel state, as anything may see it.
 *
 * `stationAlerts` is stripped HERE, at the source, rather than in redact.js.
 *
 * It rides on the flattened stream so the alert path can resolve recipients
 * without re-reading configuration mid-send — but this function feeds
 * /api/status and /api/diagnostics, both of which are public. It shipped
 * publishing every station's recipient list to anyone who loaded the dashboard's
 * own API: `gm@kpft.org`, `omaclay@gmail.com` and two more, live.
 *
 * Removed at the source and not in the projection because there are two public
 * routes reading this and nothing forces a new one through redact.js. A field
 * that must never be published should not leave the module that owns it.
 */
function getStatus() {
  return streams.map((s) => {
    const { stationAlerts, ...publishable } = s;
    return { ...publishable, ...streamStatus[s.id] };
  });
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
 * This window's listening hours against the one before it.
 *
 * "+12% on the previous 7 days" is what makes a number mean something without a
 * second screen. It is withheld — null, not zero — unless we were actually
 * watching for the whole of that earlier window: a monitor that started four
 * days ago comparing week to week would report a collapse in listening that
 * only ever happened to the recording.
 */
function windowTrend(streamId, windowMs) {
  const current = store.getAth([streamId], windowMs);
  const coverage = store.getCoverageStart([streamId]);
  const watchedMs = coverage ? Date.now() - new Date(coverage).getTime() : 0;
  if (watchedMs < windowMs * 2) {
    return { current: Math.round(current), previous: null, changePct: null };
  }
  // The preceding window is everything in twice the span, less this one — no
  // second traversal, and the two figures cannot disagree about the boundary.
  const previous = store.getAth([streamId], windowMs * 2) - current;
  return {
    current: Math.round(current),
    previous: Math.round(previous),
    changePct: previous > 0
      ? Math.round(((current - previous) / previous) * 1000) / 10
      : null,
  };
}

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
    // SCOPED. This used to return every stream the monitor watches regardless of
    // the station asked for. The audience chart filtered them out by checking
    // which ids had a series, so nothing looked wrong — but the payload named
    // other stations' channels to a caller scoped to one, and any future
    // consumer that trusted the list would have reported the wrong station's
    // channels. Every aggregate is scoped; so is this.
    streams: scoped.map((s) => ({
      id: s.id,
      name: s.name,
      stationId: s.stationId,
      // Every mount of the channel, so the audience page can break the series
      // down per bitrate variant rather than only per channel.
      mounts: diagnose.channelMountPaths(s),
      // Where the audience is right now, which no windowed average can show.
      current: streamStatus[s.id]?.listeners ?? null,
      mountListeners: streamStatus[s.id]?.mountListeners || {},
      // Whole retained history, not the selected window — the point of an
      // hour-of-day profile is the shape across every day we have.
      hourProfile: store.getHourOfDayProfile(s.id),
      // Listening hours: this window against the last, and the calendar month
      // against the royalty allowance. Per channel, because the SoundExchange
      // allowance is per channel — and in the STATION's timezone, because a
      // calendar month is only meaningful in one.
      ath: {
        window: windowTrend(s.id, windowMs),
        month: store.getMonthToDateAth([s.id], s.stationTimezone || 'UTC'),
      },
    })),
    series,
    outages,
    // HEADCOUNTS for the last 24 hours / 7 days / 30 days, each against the
    // window of equal length immediately before it.
    //
    // ROLLING, NOT CALENDAR. Month-to-date on the 1st was a few hours old and
    // sat beside a week-to-date card thirty-three hours old, so the dashboard
    // showed a month smaller than the week inside it and read as data loss.
    // Rolling windows always cover their full length and always nest.
    //
    // It also retired a whole class of timezone bug: a calendar month begins at
    // a different instant in every zone, which once measured the network over a
    // window none of its stations kept — "All stations · This month" read 805
    // while KPFT's own month read 10,560. The last 30 days is the same 30 days
    // everywhere, so a total can no longer fall below one of its parts.
    //
    // The per-station grouping stays because the payload still reports which
    // clock the CHART is drawn on, and that is genuinely per station.
    counts: store.getListenerCountsAcross(
      [...new Map(scoped.map((x) => [x.stationId, x.stationTimezone || 'UTC'])).entries()]
        .map(([stationId, timeZone]) => ({
          timeZone,
          streamIds: scoped.filter((x) => x.stationId === stationId).map((x) => x.id),
        })),
    ),
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
/**
 * The clock a station-scoped figure or message belongs in.
 *
 * A calendar day, and the moment an outage began, mean nothing without a
 * timezone — and this monitor now watches stations three timezones apart. The
 * global STATION_TZ dates from the single-station install and is simply wrong
 * for every station but one: it drew Houston's midnight on WPFW's daily chart
 * and stamped Central time on a Los Angeles outage.
 *
 * With several stations in scope there is no single right answer, so UTC is
 * named honestly rather than one station's clock being imposed on the rest.
 * This is the same fault the listener counts carried, in a different place.
 */
function stationTz(stationId) {
  if (!stationId) {
    const zones = [...new Set(streams.map((x) => x.stationTimezone).filter(Boolean))];
    return zones.length === 1 ? zones[0] : 'UTC';
  }
  return streams.find((x) => x.stationId === stationId)?.stationTimezone || STATION_TZ;
}

/**
 * The zone's own abbreviation for that instant — "CDT", "PDT", "EST".
 *
 * Read from the zone rather than written down, because it changes twice a year
 * and differs per station. The roundup used to append a hardcoded "CT" to every
 * outage time, which was a false statement on three of the five stations.
 */
function tzAbbr(iso, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(iso)).find((x) => x.type === 'timeZoneName');
  return part ? part.value : timeZone;
}

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
function getDailyBuckets(days, stationId) { return store.getDailyBuckets(days, stationTz(stationId), streamIdsFor(stationId)); }
function getCauseBreakdown(windowMs, stationId) { return store.getCauseBreakdown(windowMs, streamIdsFor(stationId)); }
function getStorageInfo() { return store.getStorageInfo(); }
function getSnapshot() { return snapshot; }

function getConfig() {
  return {
    product: PRODUCT_NAME,
    checkInterval: CHECK_INTERVAL,
    failureThreshold: FAILURE_THRESHOLD,
    silenceProbeInterval: SILENCE_PROBE_INTERVAL_MS,
    silenceFailureThreshold: SILENCE_FAILURE_THRESHOLD,
    emailConfigured: !!transporter,
    // The LIVE recipient count, summed from what each station actually holds.
    //
    // This read `ALERT_EMAILS` — a seed value the store stopped consulting the
    // moment it was migrated. It reported 2 while the KPFT alerts that morning
    // went to 3 people, so the one endpoint whose job is "what is this monitor
    // configured to do" was answering from a variable nothing sends mail by.
    alertRecipients: getStations()
      .reduce((n, st) => n + (describeAlertRouting(st.id).recipientCount || 0), 0),
    // Per station, because one number across five stations cannot show that a
    // station has nobody listed — which is the case worth seeing.
    alertRecipientsByStation: getStations().map((st) => {
      const routing = describeAlertRouting(st.id);
      return {
        stationId: st.id,
        name: st.name,
        recipientCount: routing.recipientCount || 0,
        enabled: routing.enabled === true,
        willSend: routing.willSend === true,
        reason: routing.reason || null,
      };
    }),
    /* Whether the geo databases are loaded — a CAPABILITY flag, like
       `emailConfigured` above, and the field a deploy is verified against:
       without it, confirming that a build shipped with relay detection means
       signing in, because everything else about it is behind the admin gate.

       PROJECTED, NOT FORWARDED. `available()` also returns the file's basename
       and, on a misconfiguration, an error string containing a filesystem path.
       Neither is a secret, and neither answers a question an anonymous caller
       is asking, so neither is here. The authenticated listener-detail response
       carries the full object for whoever is actually fixing it. */
    geo: (() => {
      const g = geo.available();
      const pub = (x) => ({ loaded: x.loaded, vendor: x.vendor, builtAt: x.builtAt });
      return { asn: pub(g.asn), city: pub(g.city) };
    })(),
    alertPolicy: ALERT_ON_HARMLESS_OUTAGE ? 'all confirmed outages' : 'confirmed outages with listener impact',
    alertStations: ALERT_STATIONS.length ? ALERT_STATIONS : 'all',
    alertOnHarmlessOutage: ALERT_ON_HARMLESS_OUTAGE,
    weeklyRoundup: {
      enabled: WEEKLY_ROUNDUP_ENABLED,
      day: WEEKLY_ROUNDUP_DAY,
      hour: WEEKLY_ROUNDUP_HOUR,
      timezone: STATION_TZ,
      // The most recent send across every station, plus the per-station detail.
    // A single figure alone would read as "the roundup went out" when three of
    // four stations had not received one.
    lastSent: roundupHistory().reduce(
      (latest, r) => (r.sentAt && (!latest || r.sentAt > latest) ? r.sentAt : latest),
      store.getMeta('lastWeeklyRoundup')?.sentAt || null,
    ),
    perStation: roundupHistory().map((r) => ({ stationId: r.stationId, sentAt: r.sentAt || null })),
    },
    sampleRetentionDays: store.SAMPLE_RETENTION_DAYS,
    eventRetention: 'not-pruned-by-age',
    maxEvents: store.MAX_EVENTS,
    streams: streams.map((s) => ({ id: s.id, name: s.name })),
  };
}

async function sendTestAlert(toEmail, stationId) {
  if (!transporter) throw new Error('SMTP not configured');

  // A test is always ABOUT a station — it is sent from that station's recipient
  // list to check one address on it. Defaults to the only station when there is
  // one, so a single-station install needs to say nothing.
  const station = stationId || (getStations().length === 1 ? getStations()[0].id : undefined);
  const stationName = getStations().find((st) => st.id === station)?.name;

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  const storage = store.getStorageInfo();

  const contentHtml = `
    ${renderAllStreamsTable(station)}

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

  // The station is named in the subject and the body. A recipient who is on one
  // station's list should be able to tell, from the message alone, which station
  // just added them — not read a generic test and guess.
  const html = buildEmailHtml({
    title: '🧪 Test Alert — Email Working!',
    subtitle: stationName
      ? `This is a test from the ${stationName} stream monitor. Alerts for ${stationName} will reach this address.`
      : `This is a test alert from the ${PRODUCT_NAME}. Email alerts are configured correctly.`,
    headerBg: 'linear-gradient(135deg, #6c5ce7, #5a49c9)',
    contentHtml,
  });

  const info = await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject: stationName
      ? `🧪 ${stationName} Stream Monitor — Test Alert`
      : `🧪 ${PRODUCT_NAME} — Test Alert`,
    html,
  });

  // This message exists ONLY to prove an address receives mail, so reporting
  // success for one the receiving server refused defeats its entire purpose —
  // and it is the first thing an operator reaches for when an alert did not
  // arrive. Throwing surfaces the refusal in the panel; the route renders it.
  const outcome = deliveryOutcome(info, [toEmail]);
  if (!outcome.sent || outcome.rejected.length) {
    throw new Error(`The mail server refused ${outcome.rejected.join(', ') || toEmail}. The address was not delivered to.`);
  }

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

function fmtStationDate(iso, timeZone, opts = {}) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone, month: 'short', day: 'numeric', ...opts,
  });
}

function buildWeeklyRoundup(rollup, stationId) {
  const { counts: c, audience: a, alerts, narrative } = rollup;
  // Named, because this is now ONE REPORT PER STATION. A recipient on more than
  // one station's list — an engineer covering several — otherwise receives
  // identically-titled reports and cannot tell which is which without opening
  // them. Falls back to the generic title for a single-station install.
  const stationName = getStations().find((st) => st.id === stationId)?.name;
  // Every date and time in this report is on the reported station's clock.
  const tz = stationTz(stationId);
  const rangeLabel = `${fmtStationDate(rollup.since, tz)} – ${fmtStationDate(rollup.until, tz, { year: 'numeric' })}`;
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
  const subject = `📊 ${stationName || PRODUCT_NAME} Weekly Stream Report — ${rangeLabel}: ${subjectFacts.join(', ')}`;

  const uptimeColor = rollup.uptime == null ? '#94a3b8'
    : rollup.uptime >= 99.5 ? '#4ade80' : rollup.uptime >= 98 ? '#fbbf24' : '#f87171';

  // Ordered by what the station actually needs to know, not by what is easiest
  // to measure: the audience cost first, the technical detail underneath it.
  // WHO HAS TO FIX IT — the first block after the summary, because it is the
  // reason this email gets forwarded. An 18-hour dropout with Icecast serving
  // other stations throughout is a studio problem, and the report has to say so
  // before anyone starts a conversation with the wrong department.
  const FAULT_META = {
    source: { label: 'Station source/feed path', sub: 'Icecast answered; the monitored source or mount was absent', color: '#fbbf24' },
    server: { label: 'Icecast server path', sub: 'Icecast was unreachable; check server, network, DNS, and TLS path', color: '#7dd3fc' },
    unknown: { label: 'Path unclear', sub: 'not enough evidence to assign the handoff', color: '#94a3b8' },
    // Recognised on read so a rollup computed by an older build still renders.
    kpft: { label: 'Station source/feed path', sub: 'Icecast answered; the monitored source or mount was absent', color: '#fbbf24' },
    pacifica: { label: 'Icecast server path', sub: 'Icecast was unreachable; check server, network, DNS, and TLS path', color: '#7dd3fc' },
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
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const cost = e.listenersBefore ? ` — ${e.listenersBefore} listener(s) were tuned in` : '';
      return `<li style="color:#e2e8f0 !important; margin-bottom:6px;"><span style="color:#e2e8f0 !important;"><strong>${esc(e.streamName)}</strong> · ${when} ${tzAbbr(e.timestamp, tz)} · ${esc(e.durationLabel || '—')}${e.causeLabel ? ` · ${esc(e.causeLabel)}` : ''}${cost}${e.emailed ? '' : ' <em>(no alert was emailed)</em>'}</span></li>`;
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
    title: `📊 ${stationName || PRODUCT_NAME} Weekly Stream Report`,
    subtitle: `${rangeLabel} · ${rollup.perStream.length} streams monitored · scheduled summary`,
    headerBg: clean
      ? 'linear-gradient(135deg, #0f766e, #115e59)'
      : 'linear-gradient(135deg, #4f46e5, #3730a3)',
    contentHtml,
  });

  return { subject, html };
}

/** Each station's last roundup delivery record, for the config endpoint. */
function roundupHistory() {
  return getStations().map((st) => {
    const rec = store.getMeta(`lastWeeklyRoundup:${st.id}`) || {};
    return { stationId: st.id, sentAt: rec.sentAt || null };
  });
}

/** The roundup as it would be sent, without sending it. */
function previewWeeklyRoundup(windowMs = WEEKLY_ROUNDUP_WINDOW_MS, stationId) {
  // Previews what would ACTUALLY be sent, scope included — a preview drawn from
  // a different scope than the send is worse than no preview, because it is
  // trusted. Defaults to the only station when there is one.
  const station = stationId || (getStations().length === 1 ? getStations()[0].id : undefined);
  return buildWeeklyRoundup(getPeriodRollup(windowMs, station), station);
}

/**
 * Who a station's weekly roundup goes to.
 *
 * The same list its outage alerts go to, because they are the same question
 * asked at different times: who should hear about this station. It read a
 * different list until 2026-08-31 — `ALERT_EMAILS` without `ALERT_CC` — and the
 * consequence was the operator running the monitor receiving every 3am outage
 * alert and, in seven weeks, not one weekly report. That is the worst address to
 * omit: the roundup is the only message that arrives in a quiet week, so it is
 * the only thing that separates "nothing broke" from "the monitor died".
 *
 * An explicit `to` sends to that one address and copies nobody. It exists so a
 * person can check the message, and quietly mailing the whole station every time
 * somebody previews it is the opposite of what it is for.
 */
function roundupRecipients(to, stationId) {
  if (to) return { recipients: [to], cc: [] };

  const stream = streams.find((st) => st.stationId === stationId);
  const own = stream?.stationAlerts || {};
  if (own.enabled === false) return { recipients: [], cc: [] };

  return {
    recipients: Array.isArray(own.recipients) ? [...own.recipients] : [],
    cc: Array.isArray(own.cc) ? [...own.cc] : [],
  };
}

/**
 * Builds and sends the roundup. Returns the same delivery-outcome shape as
 * sendAlert, so a failure is reported rather than logged and forgotten.
 */
async function sendWeeklyRoundup({ to, windowMs = WEEKLY_ROUNDUP_WINDOW_MS, stationId } = {}) {
  const attemptedAt = new Date().toISOString();
  if (!transporter) return { attempted: false, sent: false, reason: 'SMTP not configured', attemptedAt };

  // Defaults to the only station when there is one, so a single-station install
  // and every existing caller keep working without naming it.
  const station = stationId || (getStations().length === 1 ? getStations()[0].id : undefined);

  const { recipients, cc: ccRecipients } = roundupRecipients(to, station);
  if (!recipients.length) {
    return { attempted: false, sent: false, reason: 'no recipients configured', attemptedAt, stationId: station };
  }

  // Scoped to this station's own channels. A report spanning every station would
  // tell one station's staff about outages in other cities and — worse — fold
  // those figures into the uptime number they read as their own.
  const rollup = getPeriodRollup(windowMs, station);
  const { subject, html } = buildWeeklyRoundup(rollup, station);

  try {
    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(', '),
      subject,
      html,
    };
    if (ccRecipients.length) mailOptions.cc = ccRecipients.join(', ');

    const info = await transporter.sendMail(mailOptions);
    const outcome = deliveryOutcome(info, recipients, ccRecipients);

    // The roundup is the only message that arrives in a quiet week, so it is
    // the one whose silent non-delivery is indistinguishable from "nothing
    // broke". A refused recipient must be visible, not logged as a send.
    if (outcome.rejected.length) {
      console.warn(`[Monitor] 📊 ${outcome.rejected.length} roundup recipient(s) REJECTED by the mail server — ${outcome.rejected.join(', ')}`);
    } else {
      console.log(`[Monitor] 📊 Weekly roundup sent to ${recipients.length} recipient(s)${ccRecipients.length ? ` + ${ccRecipients.length} CC` : ''} — ${subject}`);
    }

    return {
      attempted: true, ...outcome, attemptedAt, sentAt: new Date().toISOString(),
      recipients, cc: ccRecipients, subject, stationId: station, messageId: info?.messageId || null,
    };
  } catch (err) {
    console.error('[Monitor] 📊 FAILED to send weekly roundup:', err.message);
    return { attempted: true, sent: false, attemptedAt, recipients, cc: ccRecipients, subject, stationId: station, error: err.message };
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
/**
 * Fires each station's roundup on its scheduled day, at most once per week each.
 *
 * ONE REPORT PER STATION, and three things follow from that which a single
 * global send did not have to think about:
 *
 *   · The hour is read in the STATION'S OWN timezone. WPFW is Eastern, KPFK is
 *     Pacific. A 9am report should arrive at 9am where the person reading it
 *     lives, not at 9am in Houston.
 *   · The once-a-week marker is PER STATION. One shared marker meant the first
 *     station to send declared the week finished for all of them, so three
 *     stations would silently never receive a report.
 *   · Retries are per station too. A refused connection for one must not consume
 *     another's attempts, and must not mark another's week done.
 */
function checkWeeklyRoundup() {
  if (!WEEKLY_ROUNDUP_ENABLED || !transporter) return;

  for (const station of getStations()) {
    const tz = station.timezone || STATION_TZ;
    const now = zonedParts(new Date(), tz);
    if (now.weekday !== WEEKLY_ROUNDUP_DAY || now.hour < WEEKLY_ROUNDUP_HOUR) continue;

    const dayKey = `lastWeeklyRoundupDay:${station.id}`;
    if (store.getMeta(dayKey) === now.day) continue;

    // Nobody to send to is not a failure and not a slot to claim: the day it is
    // configured, it should send that week rather than having been marked done
    // while it had no recipients.
    if (!roundupRecipients(undefined, station.id).recipients.length) continue;

    // A monitor with almost no history for the period would report a week of
    // silence it never actually watched. Claim the slot anyway so it does not
    // retry every five minutes for the rest of the day. Coverage is measured
    // over this station's own scope, or a station with weeks of history would
    // vouch for one added yesterday.
    const rollup = getPeriodRollup(WEEKLY_ROUNDUP_WINDOW_MS, station.id);
    if (rollup.coverageMs < 12 * 60 * 60 * 1000) {
      console.log(`[Monitor] 📊 Weekly roundup for ${station.id} skipped — under 12h of monitoring data`);
      store.setMeta(dayKey, now.day);
      store.saveEvents();
      continue;
    }

    // Claim the slot BEFORE sending, so a send that takes longer than the tick
    // interval cannot be started twice.
    store.setMeta(dayKey, now.day);
    const prev = roundupAttempts[station.id];
    roundupAttempts[station.id] = prev && prev.day === now.day
      ? { day: now.day, count: prev.count + 1 }
      : { day: now.day, count: 1 };
    const attempt = roundupAttempts[station.id].count;

    sendWeeklyRoundup({ stationId: station.id })
      .then((res) => {
        store.setMeta(`lastWeeklyRoundup:${station.id}`, res);
        // A refused SMTP connection should not cost the whole week's report, but
        // nor should a broken mail server be retried 288 times before midnight.
        // Release the slot for a few more attempts, then leave it claimed.
        if (!res.sent && res.attempted && attempt < ROUNDUP_MAX_ATTEMPTS) {
          store.setMeta(dayKey, null);
          console.warn(`[Monitor] 📊 Weekly roundup for ${station.id} failed — retrying in ${ROUNDUP_TICK_MS / 60000} min (attempt ${attempt}/${ROUNDUP_MAX_ATTEMPTS})`);
        }
        store.saveEvents();
      })
      .catch((err) => console.error(`[Monitor] 📊 Weekly roundup for ${station.id} failed:`, err.message));
  }
}

module.exports = {
  isDeployedInstance,
  start, stop, getStreams, getStatus, getHistory, getIncidents, getConfig, sendTestAlert,
  getPeriodRollup, sendWeeklyRoundup, previewWeeklyRoundup, previewAlertForEvent, roundupRecipients,
  getEvents, getSamples, getRollups, getListeners, getSummary, getOverallUptime, getAudioUptime, getCoverageStart,
  getDailyBuckets, getCauseBreakdown, getStorageInfo, getSnapshot, stationTz,
  getStationConfig: () => store.getStationConfig(),
  getStations, streamIdsFor,
  reloadConfig,
  alertsEnabledFor, recipientsFor, mutedReasonFor, isSelfCleared, describeAlertRouting, groupEntriesByStation,
  seedAlertsFromEnv,
  saveStationConfig,
  abandonEpisode,
  // Exported for tests. The storm engine is pure state plus a mail decision,
  // so the flap sequence that caused the flood can be replayed without an
  // encoder, a clock, or an SMTP server.
  noteStormEpisode, noteStormClear, resolveStorms, stormTotals, loadStorms,
  sustainedEscalation,
  _storms: () => storms,
  _resetStorms: () => { storms = {}; },
  STORM_OUTAGE_COUNT, STORM_WINDOW_MS, STORM_CLEAR_AFTER_MS, STORM_SUSTAINED_MS,
  composeAlert, renderAllStreamsTable, deliveryOutcome,
  isTransientRefusal, refusalDetail, queueDeliveryRetry, drainDeliveryRetries, _pendingDeliveries: pendingDeliveries,
  // Test seam. The retry loop is only meaningful against a transport that
  // refuses once and accepts later, which no real SMTP server will do on cue.
  _setTransporter: (t) => { transporter = t; },
  // Test seam. resolveStorms() has to find the stream a storm belongs to, and
  // the storm sequence is worth replaying without standing up a config file.
  _setStreams: (list) => { streams = list; },
  _setEpisodes: (e) => { episodes = e; },
  normaliseStreams, normaliseMounts, buildDefaultConfig, flattenChannels,
  trackVariantDegradation, runChecks, probeVariants, resolveDeadAir,
  // Test seam. Recording a recovery must not depend on whether it was emailed,
  // and that is only provable by driving this directly.
  dispatchNotifications,
  getVariantHealth: (streamId) => variantHealth[streamId] || {},
  // Deep listener analytics. Aggregates only — listener-detail.js guarantees no
  // IP or raw user agent is in here. Served behind the admin gate regardless,
  // because the audience breakdown is not something to publish by default.
  getListenerDetail: () => ({ meta: { ...listenerDetailMeta }, mounts: { ...listenerDetail } }),
  collectListenerDetail, adminCredsFor, adminHost,
  getDistinctDevices: (ids, since, until) => store.getDistinctDevices(ids, since, until),
  LISTENER_DETAIL_EVERY, LISTENER_DETAIL_ENABLED,
  /* Which geo databases are loaded, and the attribution owed for them. Both are
     configuration rather than data, and the CC-licensed databases REQUIRE the
     credit to be displayed wherever their data is shown — so the page that
     renders the figures has to be able to read it. */
  /* The station's own US state, for the in-market share. Optional: without it
     the page shows the distribution and says which figure is missing, rather
     than guessing that the largest state is the home one — which is usually
     true and is exactly the kind of "usually" that produces a wrong headline
     for the one station where it is false. */
  homeRegion: () => (process.env.STATION_REGION || '').trim().toUpperCase() || null,
  geoAvailable: () => geo.available(),
  geoAttribution: () => geo.attribution(),
};
