/* ═══════════════════════════════════════════════════════════════════════════
   KPFT Icecast Monitor — Check Engine
   ───────────────────────────────────────────────────────────────────────────
   EVENT MODEL

   Every failed check is recorded, permanently. Notification is decoupled from
   recording, which is what fixes the old behaviour where an isolated failure
   painted a red mark on the dashboard but left no trace anywhere else.

   An "episode" spans from a stream's first failed check to its recovery.
   Within one episode we record continuously but email at most twice — once
   when it becomes notable, once when it recovers:

     failure #1              → event recorded, severity 'blip'  (silent)
     failure #FAILURE_THRESHOLD → same event promoted to 'outage' (emails)
     recovery                → event resolved with true duration (emails, if alerted)

   The exception that closes the real gap: when a blip hits EVERY monitored
   stream in the same cycle it is server-level by definition, so it emails
   immediately — as a single consolidated message rather than one per stream.
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
    m3u: 'https://docs.pacifica.org/kpft/kpft.m3u',
  },
  {
    id: 'kpft-hd2',
    name: 'KPFT HD2',
    url: 'https://streams.pacifica.org:9000/HD3_128',
    m3u: 'https://docs.pacifica.org/kpft/kpft_hd2.m3u',
  },
  {
    id: 'kpft-hd3',
    name: 'KPFT HD3',
    url: 'https://streams.pacifica.org:9000/classic_country',
    m3u: 'https://docs.pacifica.org/kpft/kpft_hd3.m3u',
  },
];

// ── Configuration ───────────────────────────────────────────────────────────
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 60000;
const FAILURE_THRESHOLD = parseInt(process.env.FAILURE_THRESHOLD, 10) || 2;
const SILENCE_PROBE_INTERVAL_MS = parseInt(process.env.SILENCE_PROBE_INTERVAL_MS, 10) || 5000;
const SILENCE_FAILURE_THRESHOLD = parseInt(process.env.SILENCE_FAILURE_THRESHOLD, 10) || 3;
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL_MS, 10) || 60 * 1000;
// Email an unconfirmed blip when it hits every stream at once (server-level).
// Tolerant of case and stray whitespace — this gets typed into a hosting-panel
// text field, where a capitalised value or a pasted tab would otherwise leave
// alerts silently switched on.
const ALERT_ON_SERVER_BLIP =
  String(process.env.ALERT_ON_SERVER_BLIP ?? '').trim().toLowerCase() !== 'false';

// ── State ───────────────────────────────────────────────────────────────────
let streams = [];
let streamStatus = {};
let silenceState = {};
let episodes = {};        // { [streamId]: { eventId, startedAt, alerted, severity } }
let snapshot = null;      // latest Icecast snapshot
let prevSnapshot = null;
let intervalHandle = null;
let flushHandle = null;
let transporter = null;

// ── Initialize ──────────────────────────────────────────────────────────────
function init() {
  if (process.env.STREAMS) {
    try {
      const parsed = JSON.parse(process.env.STREAMS);
      streams = parsed.map((s, i) => ({
        id: s.id || `stream-${i}`,
        name: s.name || `Stream ${i + 1}`,
        url: s.url,
        m3u: s.m3u || '',
      }));
    } catch (e) {
      console.error('[Monitor] Failed to parse STREAMS env var, using defaults:', e.message);
      streams = DEFAULT_STREAMS;
    }
  } else {
    streams = DEFAULT_STREAMS;
  }

  streams.forEach((s) => {
    streamStatus[s.id] = {
      status: 'unknown',
      responseTime: null,
      lastChecked: null,
      consecutiveFailures: 0,
      error: null,
    };
    silenceState[s.id] = { streak: 0, state: 'normal', timer: null };
  });

  store.load(streams.map((s) => s.id));

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
  console.log(`[Monitor] Retention: events forever, raw samples ${store.SAMPLE_RETENTION_DAYS}d then hourly rollups`);
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
        entries: [{ stream, result, diagnosis: dg }],
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

  if (episode?.eventId) {
    const durationMs = new Date(timestamp) - new Date(episode.startedAt);
    store.updateEvent(episode.eventId, {
      resolvedAt: timestamp,
      durationMs,
      durationLabel: diagnose.fmtDuration(durationMs),
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
    durationMs: episode ? new Date(timestamp) - new Date(episode.startedAt) : null,
    diagnosis: dg,
    email: { attempted: false, sent: null },
  });

  delete episodes[stream.id];

  const emailResult = await sendAlert({
    kind: 'recovery',
    entries: [{ stream, result, diagnosis: dg }],
    scope: 'stream',
    recoveredFrom: 'dead air',
  });
  store.updateEvent(event.id, { email: emailResult });
  store.saveEvents();
}

// ── Run Check Cycle ─────────────────────────────────────────────────────────
async function runChecks() {
  const timestamp = new Date().toISOString();

  prevSnapshot = snapshot;
  const [results, snap] = await Promise.all([
    Promise.all(streams.map((s) => diagnose.probeStream(s))),
    diagnose.fetchIcecastSnapshot(),
  ]);
  snapshot = snap;

  const cycle = streams.map((s, i) => ({ stream: s, result: results[i] }));
  const downCount = cycle.filter((c) => c.result.status === 'down').length;
  const allDown = downCount === streams.length && streams.length > 0;

  console.log(
    `[Monitor] Cycle ${timestamp} — ${streams.length - downCount}/${streams.length} up` +
    (snap.reachable ? ` · Icecast OK (${snap.mountCount} mounts)` : ` · Icecast UNREACHABLE (${snap.fetchError})`),
  );

  const newlyNotable = [];   // episodes that just became worth emailing
  const recoveries = [];     // episodes that just ended

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const result = results[i];
    const prev = streamStatus[stream.id] || {};
    const wasDown = prev.status === 'down';
    const isDown = result.status === 'down';
    const mount = diagnose.findMount(snap, stream);

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
      listeners: mount
        ? mount.listeners
        : snap.reachable
        ? 0
        : prev.listeners ?? 0,
      listenerPeak: mount?.listenerPeak ?? prev.listenerPeak ?? 0,
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
    });

    // ── Episode transitions ────────────────────────────────────────────────
    if (isDown) {
      const dg = diagnose.classify({ stream, result, snapshot: snap, prevSnapshot, cycle });
      const episode = episodes[stream.id];

      if (!episode) {
        // First failure of a new episode. Always recorded, even though a
        // single blip normally stays silent.
        const serverLevel = allDown && streams.length > 1;
        const event = store.addEvent({
          timestamp,
          streamId: stream.id,
          streamName: stream.name,
          type: 'down',
          severity: 'blip',
          confirmed: false,
          scope: dg.scope,
          message: `${stream.name} failed a check — ${dg.causeLabel}${result.error ? ` (${result.error})` : ''}`,
          failedChecks: 1,
          diagnosis: dg,
          email: { attempted: false, sent: null, reason: 'unconfirmed single-check blip' },
        });

        episodes[stream.id] = {
          eventId: event.id,
          startedAt: timestamp,
          alerted: false,
          severity: 'blip',
        };

        console.warn(`[Monitor] ⚠️  BLIP recorded — ${stream.name}: ${dg.causeLabel} (${result.error})`);

        if (serverLevel && ALERT_ON_SERVER_BLIP) {
          newlyNotable.push({
            stream, result, diagnosis: dg,
            eventId: event.id,
            reason: 'server-level blip',
          });
        }
      } else {
        // Ongoing episode: keep the single event up to date rather than
        // creating a new one for every failed check.
        const patch = {
          failedChecks: failures,
          diagnosis: dg,
          lastCheckAt: timestamp,
        };

        if (failures >= FAILURE_THRESHOLD && episode.severity !== 'outage') {
          patch.severity = 'outage';
          patch.confirmed = true;
          patch.scope = dg.scope;
          patch.confirmedAt = timestamp;
          patch.message = `${stream.name} is DOWN — ${dg.causeLabel}${result.error ? ` (${result.error})` : ''}`;
          episode.severity = 'outage';
          console.error(`[ALERT] ${stream.name} DOWN confirmed after ${failures} checks — ${dg.causeLabel}`);
        }

        store.updateEvent(episode.eventId, patch);

        if (failures >= FAILURE_THRESHOLD && !episode.alerted) {
          newlyNotable.push({
            stream, result, diagnosis: dg,
            eventId: episode.eventId,
            reason: 'confirmed outage',
          });
        }
      }
    } else if (wasDown || episodes[stream.id]) {
      const episode = episodes[stream.id];
      if (episode && episode.severity !== 'dead_air') {
        const durationMs = new Date(timestamp) - new Date(episode.startedAt);
        const dg = diagnose.classify({ stream, result, snapshot: snap, prevSnapshot, cycle });
        const sourceOutage = diagnose.deriveSourceOutage(snap, stream, episode.startedAt);

        store.updateEvent(episode.eventId, {
          resolvedAt: timestamp,
          durationMs,
          durationLabel: diagnose.fmtDuration(durationMs),
          sourceOutage,
          selfCleared: !episode.alerted,
        });

        if (episode.alerted) {
          recoveries.push({ stream, result, diagnosis: dg, episode, durationMs, sourceOutage });
        } else {
          console.log(`[Monitor] ✓ ${stream.name} self-cleared after ${diagnose.fmtDuration(durationMs)} (blip, no alert sent)`);
        }
        delete episodes[stream.id];
      }
    }
  }

  // ── Notification pass ─────────────────────────────────────────────────────
  await dispatchNotifications(newlyNotable, recoveries, { allDown, timestamp, snapshot: snap });

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
  if (newlyNotable.length > 0) {
    const serverScope =
      ctx.allDown && streams.length > 1
        ? 'server'
        : newlyNotable[0].diagnosis.scope;

    const consolidated = newlyNotable.length > 1;
    const entries = newlyNotable.map((n) => ({
      stream: n.stream, result: n.result, diagnosis: n.diagnosis,
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
                <span class="footer-text" style="color: #94a3b8 !important;">KPFT Icecast Stream Monitor · Pacifica Foundation — Houston, TX</span>
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
    station: '📻 Station-wide — affects all KPFT mounts',
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

function renderStreamBlock(entry, index, total) {
  const { stream, result, diagnosis } = entry;
  const heading = total > 1
    ? `<h3 class="section-hdr" style="margin:${index === 0 ? '0' : '24px'} 0 12px 0; font-size:14px; color:#f8fafc !important; letter-spacing:0.02em;"><span style="color:#f8fafc !important;">${index + 1}. ${esc(stream.name)}</span></h3>`
    : `<h3 class="section-hdr" style="margin:0 0 12px 0; font-size:13px; color:#cbd5e1 !important; text-transform:uppercase; letter-spacing:0.05em;"><span class="section-hdr" style="color:#cbd5e1 !important;">Affected Stream</span></h3>`;

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
    row('Response Time', `<span class="val-col" style="color:#f8fafc !important;">${result.responseTime}ms</span>`, true),
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
async function sendAlert({ kind, entries, scope, consolidated = false, recoveredFrom = null }) {
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

  const isDeadAir = kind === 'dead_air';
  const isRecovery = kind === 'recovery';
  const isDown = !isRecovery;

  const emoji = isDeadAir ? '🔇' : isDown ? '🔴' : '🟢';
  const statusText = isDeadAir ? 'DEAD AIR (SILENCE)' : isDown ? 'DOWN' : 'RECOVERED';

  const names = entries.map((e) => e.stream.name);
  const nameList = names.length > 2
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : names.join(' and ');

  const primaryCause = entries[0]?.diagnosis?.causeLabel || '';

  // Subject leads with the root cause, so the inbox itself is diagnostic.
  let subject;
  if (consolidated) {
    subject = `${emoji} KPFT Alert: ${entries.length} streams ${statusText}${primaryCause ? ` — ${primaryCause}` : ''}`;
  } else {
    subject = `${emoji} KPFT Alert: ${nameList} — ${statusText}${primaryCause && isDown ? ` (${primaryCause})` : ''}`;
  }

  const headerBg = isDeadAir
    ? 'linear-gradient(135deg, #d97706, #b45309)'
    : isDown
    ? 'linear-gradient(135deg, #dc2626, #991b1b)'
    : 'linear-gradient(135deg, #16a34a, #15803d)';

  const scopeNote = scope === 'server'
    ? ' This is a SERVER-LEVEL event affecting every monitored stream.'
    : scope === 'station'
    ? ' This affects all KPFT mounts.'
    : '';

  const subtitle = isDeadAir
    ? `${nameList} is connected but silent — dead air confirmed across ${SILENCE_FAILURE_THRESHOLD} consecutive probes.`
    : isDown
    ? `${nameList} ${entries.length > 1 ? 'have' : 'has'} gone offline.${scopeNote}`
    : `${nameList} ${entries.length > 1 ? 'are' : 'is'} back online${recoveredFrom ? ` (recovered from ${recoveredFrom})` : ''}.`;

  const detectedAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric',
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

// ── Public API ──────────────────────────────────────────────────────────────
function start() {
  init();
  runChecks().catch((err) => console.error('[Monitor] Check cycle failed:', err));

  intervalHandle = setInterval(() => {
    runChecks().catch((err) => console.error('[Monitor] Check cycle failed:', err));
  }, CHECK_INTERVAL);

  flushHandle = setInterval(() => store.save(), SAVE_INTERVAL);

  const shutdown = () => { store.save(true); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('[Monitor] Started');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  if (flushHandle) clearInterval(flushHandle);
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
function getSummary(windowMs) { return store.getSummary(streams.map((s) => s.id), windowMs); }
function getDailyBuckets(days) { return store.getDailyBuckets(days); }
function getCauseBreakdown(windowMs) { return store.getCauseBreakdown(windowMs); }
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
    alertOnServerBlip: ALERT_ON_SERVER_BLIP,
    sampleRetentionDays: store.SAMPLE_RETENTION_DAYS,
    eventRetention: 'permanent',
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
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🔇 <strong>Dead Air alert</strong> when silence persists across ${SILENCE_FAILURE_THRESHOLD} 5-second probes</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🟢 <strong>Recovery alert</strong> with the true outage duration</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Checks run every ${Math.round(CHECK_INTERVAL / 1000)} seconds</span></li>
      </ul>
    </div>

    <div class="diag-box" style="background-color:#101a2e; border:1px solid #1e3a5f; border-radius:8px; padding:16px; margin-top:16px;">
      <p class="diag-title" style="font-weight:600; color:#7dd3fc !important; margin:0 0 8px 0; font-size:14px;"><span class="diag-title" style="color:#7dd3fc !important;">📚 Incident history</span></p>
      <ul style="margin:0; padding-left:20px; font-size:13px; line-height:1.8;">
        <li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">Every failed check is recorded permanently — including brief blips that do not trigger an email</span></li>
        <li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">${storage.eventCount} event(s) currently on record${storage.oldestEvent ? `, back to ${new Date(storage.oldestEvent).toLocaleDateString('en-US')}` : ''}</span></li>
        <li style="color:#e2e8f0 !important;"><span style="color:#e2e8f0 !important;">Per-minute telemetry kept ${storage.sampleRetentionDays} days, then compacted to hourly summaries kept forever</span></li>
      </ul>
    </div>`;

  const html = buildEmailHtml({
    title: '🧪 Test Alert — Email Working!',
    subtitle: 'This is a test alert from the KPFT Stream Monitor. Email alerts are configured correctly.',
    headerBg: 'linear-gradient(135deg, #6c5ce7, #5a49c9)',
    contentHtml,
  });

  await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject: '🧪 KPFT Stream Monitor — Test Alert',
    html,
  });
  console.log(`[Monitor] Test alert sent to ${toEmail}`);
}

module.exports = {
  start, stop, getStreams, getStatus, getHistory, getIncidents, getConfig, sendTestAlert,
  getEvents, getSamples, getRollups, getSummary, getDailyBuckets, getCauseBreakdown,
  getStorageInfo, getSnapshot,
};
