const https = require('https');
const http = require('http');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

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
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const HISTORY_FLUSH_INTERVAL = 5 * 60 * 1000; // flush to disk every 5 min
const REQUEST_TIMEOUT = 15000; // 15s timeout for stream checks

// ── State ───────────────────────────────────────────────────────────────────
let streams = [];
let streamStatus = {};   // { [id]: { status, responseTime, lastChecked, consecutiveFailures, error } }
let history = {};         // { [id]: [ { timestamp, status, responseTime, error } ] }
let incidents = [];       // [ { timestamp, streamId, streamName, type: 'down'|'up', message } ]
let silenceState = {};    // { [id]: { streak: 0, state: 'normal'|'evaluating'|'dead_air', timer: null } }
let intervalHandle = null;
let flushHandle = null;
let transporter = null;

// ── Initialize ──────────────────────────────────────────────────────────────
function init() {
  // Parse streams from env or use defaults
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

  // Initialize status for each stream
  streams.forEach((s) => {
    streamStatus[s.id] = {
      status: 'unknown',
      responseTime: null,
      lastChecked: null,
      consecutiveFailures: 0,
      error: null,
    };
    silenceState[s.id] = {
      streak: 0,
      state: 'normal',
      timer: null,
    };
    history[s.id] = [];
  });

  // Load persisted history
  loadHistory();

  // Setup email transporter
  setupMailer();

  console.log(`[Monitor] Initialized with ${streams.length} streams`);
  console.log(`[Monitor] Check interval: ${CHECK_INTERVAL}ms, Failure threshold: ${FAILURE_THRESHOLD}`);
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

  transporter.verify().then(() => {
    console.log('[Monitor] SMTP connection verified');
  }).catch((err) => {
    console.error('[Monitor] SMTP verification failed:', err.message);
  });
}

// ── Icecast Server Stats (/status-json.xsl) ─────────────────────────────────
function fetchIcecastStats() {
  return new Promise((resolve) => {
    const statsUrl = 'https://streams.pacifica.org:9000/status-json.xsl';
    const req = https.get(statsUrl, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const sources = parsed?.icestats?.source || [];
          const sourceArray = Array.isArray(sources) ? sources : [sources];
          const statsMap = {};

          sourceArray.forEach((src) => {
            if (!src || !src.listenurl) return;
            const listenUrl = src.listenurl;
            statsMap[listenUrl] = {
              listeners: src.listeners || 0,
              listenerPeak: src.listener_peak || 0,
              title: src.title || src.server_name || '',
              bitrate: src.bitrate || src['ice-bitrate'] || 0,
              genre: src.genre || '',
              serverDescription: src.server_description || '',
              streamStart: src.stream_start_iso8601 || src.stream_start || '',
            };
          });

          resolve(statsMap);
        } catch (e) {
          resolve({});
        }
      });
    });

    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// ── Audio Chunk Silence Analyzer ────────────────────────────────────────────
function analyzeAudioChunk(buffer) {
  if (!buffer || buffer.length < 1024) {
    return { isSilent: false, energy: 100 };
  }
  let sumDiff = 0;
  let nonZeroCount = 0;

  for (let i = 0; i < buffer.length - 1; i++) {
    const diff = Math.abs(buffer[i + 1] - buffer[i]);
    sumDiff += diff;
    if (buffer[i] > 10) nonZeroCount++;
  }

  const avgDiff = sumDiff / buffer.length;
  const nonZeroRatio = nonZeroCount / buffer.length;

  // Digital silence in MP3/AAC streams manifests as flat/repeating frame headers with near 0 byte variation
  const isSilent = avgDiff < 0.5 && nonZeroRatio < 0.02;
  return { isSilent, energy: Math.round(avgDiff * 100) / 100 };
}

// ── Stream Health Check ─────────────────────────────────────────────────────
function checkStream(stream, sampleBytes = 8192) {
  return new Promise((resolve) => {
    const start = Date.now();
    const urlObj = new URL(stream.url);
    const client = urlObj.protocol === 'https:' ? https : http;

    let receivedBytes = 0;
    const chunks = [];
    const maxSampleBytes = sampleBytes; // Customizable sample size for deep audio checks

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Icy-MetaData': '1',
          'User-Agent': 'IcecastMonitor/1.0',
        },
      },
      (res) => {
        const responseTime = Date.now() - start;
        const contentType = res.headers['content-type'] || '';
        const icyName = res.headers['icy-name'] || '';

        if (res.statusCode !== 200) {
          res.destroy();
          return resolve({
            status: 'down',
            responseTime,
            error: `HTTP ${res.statusCode}, Content-Type: ${contentType}`,
            isSilent: false,
          });
        }

        if (!contentType.includes('audio') && !contentType.includes('ogg') && !icyName) {
          res.destroy();
          return resolve({
            status: 'down',
            responseTime,
            error: `Invalid Content-Type: ${contentType}`,
            isSilent: false,
          });
        }

        // Stream audio sample for silence analysis
        res.on('data', (chunk) => {
          chunks.push(chunk);
          receivedBytes += chunk.length;
          if (receivedBytes >= maxSampleBytes) {
            res.destroy();
          }
        });

        res.on('close', () => {
          const fullBuffer = Buffer.concat(chunks);
          const silenceAnalysis = analyzeAudioChunk(fullBuffer);
          resolve({
            status: 'up',
            responseTime,
            error: null,
            isSilent: silenceAnalysis.isSilent,
            audioEnergy: silenceAnalysis.energy,
          });
        });

        res.on('error', () => {
          res.destroy();
          resolve({ status: 'up', responseTime, error: null, isSilent: false });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 'down',
        responseTime: Date.now() - start,
        error: 'Connection timed out',
        isSilent: false,
      });
    });

    req.on('error', (err) => {
      resolve({
        status: 'down',
        responseTime: Date.now() - start,
        error: err.message,
        isSilent: false,
      });
    });

    req.end();
  });
}

// ── Aggressive Silence Verification Engine ───────────────────────────────
function scheduleAggressiveProbe(stream) {
  const st = silenceState[stream.id] || { streak: 0, state: 'normal', timer: null };
  if (st.timer) clearTimeout(st.timer);

  st.timer = setTimeout(async () => {
    st.timer = null;
    const probeNum = st.streak + 1;
    console.log(`[Silence Engine] Running aggressive verification probe for ${stream.name} (Probe ${probeNum}/${SILENCE_FAILURE_THRESHOLD})`);

    // Sample ~32KB (~2s audio) for deep audio phrase evaluation
    const result = await checkStream(stream, 32768);
    const timestamp = new Date().toISOString();

    if (result.status === 'down') {
      return; // Connection failure handled by standard cycle
    }

    if (!result.isSilent) {
      // 🟢 INSTANT RESET! Voice / Audio energy detected!
      const wasDeadAir = st.state === 'dead_air';
      console.log(`[Silence Engine] 🟢 Audio detected on ${stream.name} (Energy: ${result.audioEnergy})! Instant reset of silence streak.`);

      st.streak = 0;
      st.state = 'normal';

      if (streamStatus[stream.id]) {
        streamStatus[stream.id].isSilent = false;
        streamStatus[stream.id].audioEnergy = result.audioEnergy;
        streamStatus[stream.id].silenceState = 'normal';
        streamStatus[stream.id].silenceStreak = 0;
      }

      if (wasDeadAir) {
        const incident = {
          timestamp,
          streamId: stream.id,
          streamName: stream.name,
          type: 'up',
          message: `${stream.name} Audio Output Restored — Dead Air cleared`,
        };
        incidents.push(incident);
        sendAlert(stream, result, 'up');
      }
      return;
    }

    // Still silent! Increment streak
    st.streak += 1;

    if (st.streak < SILENCE_FAILURE_THRESHOLD) {
      st.state = 'evaluating';
      if (streamStatus[stream.id]) {
        streamStatus[stream.id].silenceState = 'evaluating';
        streamStatus[stream.id].silenceStreak = st.streak;
      }
      console.warn(`[Silence Engine] 🟡 Silence probe ${st.streak}/${SILENCE_FAILURE_THRESHOLD} confirmed for ${stream.name}. Scheduling next probe in ${SILENCE_PROBE_INTERVAL_MS}ms.`);
      scheduleAggressiveProbe(stream);
    } else {
      // 🔴 Sustained Dead Air Confirmed!
      st.state = 'dead_air';
      if (streamStatus[stream.id]) {
        streamStatus[stream.id].silenceState = 'dead_air';
        streamStatus[stream.id].silenceStreak = st.streak;
      }
      const durationSec = Math.round((st.streak * SILENCE_PROBE_INTERVAL_MS) / 1000);
      console.error(`[Silence Engine] 🔴 Sustained DEAD AIR confirmed on ${stream.name} after ${st.streak} probes (~${durationSec}s continuous silence).`);

      const incident = {
        timestamp,
        streamId: stream.id,
        streamName: stream.name,
        type: 'down',
        message: `${stream.name} has DEAD AIR — Continuous silence confirmed for ${durationSec}s+`,
      };
      incidents.push(incident);
      sendAlert(stream, result, 'dead_air');
    }
  }, SILENCE_PROBE_INTERVAL_MS);
}

// ── Run Check Cycle ─────────────────────────────────────────────────────────
async function runChecks() {
  const timestamp = new Date().toISOString();
  console.log(`[Monitor] Running checks at ${timestamp}`);

  const [checkResults, icecastStats] = await Promise.all([
    Promise.all(streams.map((s) => checkStream(s))),
    fetchIcecastStats(),
  ]);

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const result = checkResults[i];
    const prev = streamStatus[stream.id] || {};
    const wasDown = prev.status === 'down';
    const isDown = result.status === 'down';
    const isSilent = result.isSilent;

    // Match mount point in Icecast JSON stats
    let matchedStats = null;
    for (const [listenUrl, stats] of Object.entries(icecastStats)) {
      if (listenUrl.includes(stream.url.split(':9000')[1] || '____')) {
        matchedStats = stats;
        break;
      }
    }

    // Silence evaluation state tracking
    const st = silenceState[stream.id] || { streak: 0, state: 'normal', timer: null };

    if (!isDown) {
      if (!isSilent) {
        // 🟢 INSTANT RESET: Sound / voice detected on routine check
        if (st.state !== 'normal') {
          const wasDeadAir = st.state === 'dead_air';
          console.log(`[Silence Engine] 🟢 Routine check detected sound on ${stream.name} (Energy: ${result.audioEnergy}). Resetting silence evaluation.`);
          if (st.timer) clearTimeout(st.timer);
          st.streak = 0;
          st.state = 'normal';
          st.timer = null;

          if (wasDeadAir) {
            const incident = {
              timestamp,
              streamId: stream.id,
              streamName: stream.name,
              type: 'up',
              message: `${stream.name} Audio Output Restored — Dead Air cleared`,
            };
            incidents.push(incident);
            sendAlert(stream, result, 'up');
          }
        }
      } else {
        // 🟡 Initial silence detected on routine check
        if (st.state === 'normal') {
          st.streak = 1;
          st.state = 'evaluating';
          console.warn(`[Silence Engine] 🟡 Routine check detected initial silence pause on ${stream.name}. Starting aggressive verification probe schedule.`);
          scheduleAggressiveProbe(stream);
        }
      }
    }

    // Update status object
    streamStatus[stream.id] = {
      status: result.status,
      responseTime: result.responseTime,
      lastChecked: timestamp,
      consecutiveFailures: isDown ? (prev.consecutiveFailures || 0) + 1 : 0,
      isSilent: isSilent,
      audioEnergy: result.audioEnergy || 0,
      silenceState: st.state,
      silenceStreak: st.streak,
      error: result.error,
      // Stats from /status-json.xsl
      listeners: matchedStats?.listeners ?? prev.listeners ?? 0,
      listenerPeak: matchedStats?.listenerPeak ?? prev.listenerPeak ?? 0,
      title: matchedStats?.title || prev.title || '',
      bitrate: matchedStats?.bitrate || prev.bitrate || 128,
      streamStart: matchedStats?.streamStart || prev.streamStart || '',
    };

    // Record history
    history[stream.id].push({
      timestamp,
      status: result.status,
      responseTime: result.responseTime,
      listeners: streamStatus[stream.id].listeners,
      isSilent,
      silenceState: st.state,
      error: result.error,
    });

    // State transition detection
    const failures = streamStatus[stream.id].consecutiveFailures;

    // DOWN alert (Network / Connection level)
    if (isDown && failures === FAILURE_THRESHOLD) {
      const incident = {
        timestamp,
        streamId: stream.id,
        streamName: stream.name,
        type: 'down',
        message: `${stream.name} is DOWN — ${result.error || 'No response'}`,
      };
      incidents.push(incident);
      console.error(`[ALERT] ${incident.message}`);
      sendAlert(stream, result, 'down');
    }

    // RECOVERY alert (Network / Connection level)
    if (wasDown && !isDown && prev.consecutiveFailures >= FAILURE_THRESHOLD) {
      const incident = {
        timestamp,
        streamId: stream.id,
        streamName: stream.name,
        type: 'up',
        message: `${stream.name} has RECOVERED (response: ${result.responseTime}ms)`,
      };
      incidents.push(incident);
      console.log(`[RECOVERY] ${incident.message}`);
      sendAlert(stream, result, 'up');
    }
  }

  // Prune old history
  pruneHistory();
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

// ── Email Alerts ────────────────────────────────────────────────────────────
async function sendAlert(stream, result, type) {
  if (!transporter) return;

  const recipients = (process.env.ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    console.warn('[Monitor] No ALERT_EMAILS configured');
    return;
  }

  const ccRecipients = (process.env.ALERT_CC || '').split(',').map((e) => e.trim()).filter(Boolean);
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  const isDeadAir = type === 'dead_air';
  const isDown = type === 'down' || isDeadAir;
  const emoji = isDeadAir ? '🔇' : isDown ? '🔴' : '🟢';
  const statusText = isDeadAir ? 'DEAD AIR (SILENCE)' : isDown ? 'DOWN' : 'RECOVERED';
  const failures = streamStatus[stream.id]?.consecutiveFailures || 0;
  const silenceStreak = streamStatus[stream.id]?.silenceStreak || SILENCE_FAILURE_THRESHOLD;

  const subject = `${emoji} KPFT Alert: ${stream.name} — ${statusText}`;

  // Header Background Gradient
  const headerBg = isDeadAir
    ? 'linear-gradient(135deg, #d97706, #b45309)'
    : isDown
    ? 'linear-gradient(135deg, #dc2626, #991b1b)'
    : 'linear-gradient(135deg, #16a34a, #15803d)';

  const subtitle = isDeadAir
    ? `${stream.name} output audio is silent (Dead Air confirmed across multiple 5s probes).`
    : isDown
    ? `${stream.name} has gone offline after ${failures} consecutive failed checks.`
    : `${stream.name} is back online and streaming normally.`;

  // Build all-streams status summary table
  const allStreamsRows = streams.map((s) => {
    const st = streamStatus[s.id] || {};
    const isStDeadAir = st.silenceState === 'dead_air';
    const dot = isStDeadAir ? '🔇' : st.status === 'up' ? '🟢' : st.status === 'down' ? '🔴' : '⚪';
    const stText = isStDeadAir ? 'Dead Air' : st.status === 'up' ? 'Online' : st.status === 'down' ? 'Offline' : 'Unknown';
    const stColor = isStDeadAir ? '#f59e0b' : st.status === 'up' ? '#4ade80' : '#f87171';
    const rt = st.responseTime != null ? `${st.responseTime}ms` : '—';
    return `
          <tr class="row-border" style="border-bottom: 1px solid #28283d;">
            <td class="val-col" style="padding: 8px; color: #f8fafc !important; font-size: 13px;"><span class="val-col" style="color: #f8fafc !important;">${dot} ${s.name}</span></td>
            <td style="padding: 8px; color: ${stColor} !important; font-weight: 600; font-size: 13px;"><span style="color: ${stColor} !important;">${stText}</span></td>
            <td class="label-col" style="padding: 8px; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">${rt}</span></td>
          </tr>`;
  }).join('');

  // Troubleshooting steps callout
  const troubleshooting = isDeadAir ? `
    <div class="callout-box" style="background-color: #261d10; border: 1px solid #52370e; border-radius: 8px; padding: 16px; margin-top: 16px;">
      <p class="callout-title" style="font-weight: 600; color: #fbbf24 !important; margin: 0 0 8px 0; font-size: 14px;"><span class="callout-title" style="color: #fbbf24 !important;">⚠️ Dead Air Troubleshooting Steps</span></p>
      <ol class="callout-text" style="margin: 0; padding-left: 20px; color: #e2e8f0 !important; font-size: 13px; line-height: 1.8;">
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">HTTP stream connection is active (HTTP 200 OK), but output audio is silent</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Check studio audio routing, mixing console master output, or automation software</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Verify studio audio interface / soundcard connections to stream encoder</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Check if broadcast source player or automation software is paused or stopped</span></li>
      </ol>
    </div>` : isDown ? `
    <div class="callout-box" style="background-color: #291418; border: 1px solid #5c2028; border-radius: 8px; padding: 16px; margin-top: 16px;">
      <p class="callout-title" style="font-weight: 600; color: #f87171 !important; margin: 0 0 8px 0; font-size: 14px;"><span class="callout-title" style="color: #f87171 !important;">⚠️ Server Down Troubleshooting Steps</span></p>
      <ol class="callout-text" style="margin: 0; padding-left: 20px; color: #e2e8f0 !important; font-size: 13px; line-height: 1.8;">
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Check if the Icecast server at <code style="background: #28283d; color: #a78bfa !important; padding: 2px 5px; border-radius: 3px;">streams.pacifica.org:9000</code> is reachable</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Verify the source client is connected and sending audio</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Check Icecast admin panel for mount point status</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Review Icecast server logs for errors</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Restart the source encoder if needed</span></li>
      </ol>
    </div>` : '';

  const contentHtml = `
    <h3 class="section-hdr" style="margin: 0 0 12px 0; font-size: 13px; color: #cbd5e1 !important; text-transform: uppercase; letter-spacing: 0.05em;"><span class="section-hdr" style="color: #cbd5e1 !important;">Affected Stream</span></h3>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 16px;">
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; width: 140px; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Stream Name</span></td>
        <td class="val-col" style="padding: 8px 0; font-weight: 600; color: #f8fafc !important; font-size: 13px;"><span class="val-col" style="color: #f8fafc !important;">${stream.name}</span></td>
      </tr>
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Stream URL</span></td>
        <td style="padding: 8px 0;"><code style="background: #28283d; color: #a78bfa !important; padding: 3px 6px; border-radius: 4px; font-size: 12px;">${stream.url}</code></td>
      </tr>
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">M3U Playlist</span></td>
        <td style="padding: 8px 0;"><a href="${stream.m3u}" style="color: #a78bfa !important; text-decoration: none; font-size: 12px;">${stream.m3u}</a></td>
      </tr>
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Status</span></td>
        <td style="padding: 8px 0; font-weight: 700; color: ${isDown ? '#f87171' : '#4ade80'} !important; font-size: 15px;"><span style="color: ${isDown ? '#f87171' : '#4ade80'} !important;">${statusText}</span></td>
      </tr>
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Response Time</span></td>
        <td class="val-col" style="padding: 8px 0; color: #f8fafc !important; font-size: 13px;"><span class="val-col" style="color: #f8fafc !important;">${result.responseTime}ms</span></td>
      </tr>
      ${result.error ? `
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Error Details</span></td>
        <td style="padding: 8px 0;"><code style="background: rgba(239,68,68,0.15); color: #f87171 !important; padding: 3px 6px; border-radius: 4px; font-size: 12px;">${result.error}</code></td>
      </tr>` : ''}
      ${isDown ? `
      <tr class="row-border" style="border-bottom: 1px solid #28283d;">
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Failed Checks</span></td>
        <td style="padding: 8px 0; color: #f59e0b !important; font-weight: 600; font-size: 13px;"><span style="color: #f59e0b !important;">${isDeadAir ? `${silenceStreak} consecutive (probes every 5s)` : `${failures} consecutive`}</span></td>
      </tr>` : ''}
      <tr>
        <td class="label-col" style="padding: 8px 0; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">Detected At</span></td>
        <td class="val-col" style="padding: 8px 0; color: #f8fafc !important; font-size: 13px;"><span class="val-col" style="color: #f8fafc !important;">${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} CT</span></td>
      </tr>
    </table>

    ${troubleshooting}

    <hr style="border: none; border-top: 1px solid #28283d; margin: 20px 0;">

    <h3 class="section-hdr" style="margin: 0 0 12px 0; font-size: 13px; color: #cbd5e1 !important; text-transform: uppercase; letter-spacing: 0.05em;"><span class="section-hdr" style="color: #cbd5e1 !important;">All Streams Overview</span></h3>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
      <tr style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Stream</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Status</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Response</span></td>
      </tr>
      ${allStreamsRows}
    </table>`;

  const html = buildEmailHtml({
    title: `${emoji} Stream ${statusText}`,
    subtitle,
    headerBg,
    contentHtml,
  });

  try {
    const mailOptions = {
      from: fromAddr,
      to: recipients.join(', '),
      subject,
      html,
    };
    if (ccRecipients.length > 0) {
      mailOptions.cc = ccRecipients.join(', ');
    }
    await transporter.sendMail(mailOptions);
    console.log(`[Monitor] Alert email sent to ${recipients.length} recipient(s)${ccRecipients.length ? ` + ${ccRecipients.length} CC` : ''}`);
  } catch (err) {
    console.error('[Monitor] Failed to send alert email:', err.message);
  }
}

// ── History Management ──────────────────────────────────────────────────────
function pruneHistory() {
  const cutoff = Date.now() - MAX_HISTORY_AGE_MS;
  for (const id of Object.keys(history)) {
    history[id] = history[id].filter((h) => new Date(h.timestamp).getTime() > cutoff);
  }
  // Also prune incidents
  incidents = incidents.filter((i) => new Date(i.timestamp).getTime() > cutoff);
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (data.history) history = { ...history, ...data.history };
      if (data.incidents) incidents = data.incidents;
      if (data.streamStatus) {
        // Restore last known status but reset consecutiveFailures
        for (const id of Object.keys(data.streamStatus)) {
          if (streamStatus[id]) {
            streamStatus[id] = {
              ...data.streamStatus[id],
              consecutiveFailures: 0,
              status: 'unknown',
            };
          }
        }
      }
      console.log('[Monitor] Loaded persisted history');
      pruneHistory();
    }
  } catch (err) {
    console.error('[Monitor] Failed to load history:', err.message);
  }
}

function saveHistory() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify({ history, incidents, streamStatus, savedAt: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    console.error('[Monitor] Failed to save history:', err.message);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────
function start() {
  init();

  // Run first check immediately
  runChecks();

  // Schedule periodic checks
  intervalHandle = setInterval(runChecks, CHECK_INTERVAL);

  // Schedule periodic history flush
  flushHandle = setInterval(saveHistory, HISTORY_FLUSH_INTERVAL);

  // Save on shutdown
  process.on('SIGTERM', () => { saveHistory(); process.exit(0); });
  process.on('SIGINT', () => { saveHistory(); process.exit(0); });

  console.log('[Monitor] Started');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  if (flushHandle) clearInterval(flushHandle);
  saveHistory();
  console.log('[Monitor] Stopped');
}

function getStreams() {
  return streams;
}

function getStatus() {
  return streams.map((s) => ({
    ...s,
    ...streamStatus[s.id],
  }));
}

function getHistory() {
  return history;
}

function getIncidents() {
  return incidents;
}

function getConfig() {
  return {
    checkInterval: CHECK_INTERVAL,
    failureThreshold: FAILURE_THRESHOLD,
    silenceProbeInterval: SILENCE_PROBE_INTERVAL_MS,
    silenceFailureThreshold: SILENCE_FAILURE_THRESHOLD,
    emailConfigured: !!transporter,
    alertRecipients: (process.env.ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean).length,
  };
}

async function sendTestAlert(toEmail) {
  if (!transporter) {
    throw new Error('SMTP not configured');
  }

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  // Build current status of all streams
  const allStreamsRows = streams.map((s) => {
    const st = streamStatus[s.id] || {};
    const isStDeadAir = st.silenceState === 'dead_air';
    const dot = isStDeadAir ? '🔇' : st.status === 'up' ? '🟢' : st.status === 'down' ? '🔴' : '⚪';
    const stText = isStDeadAir ? 'Dead Air' : st.status === 'up' ? 'Online' : st.status === 'down' ? 'Offline' : 'Unknown';
    const stColor = isStDeadAir ? '#f59e0b' : st.status === 'up' ? '#4ade80' : '#f87171';
    const rt = st.responseTime != null ? `${st.responseTime}ms` : '—';
    return `
          <tr class="row-border" style="border-bottom: 1px solid #28283d;">
            <td class="val-col" style="padding: 8px; color: #f8fafc !important; font-size: 13px;"><span class="val-col" style="color: #f8fafc !important;">${dot} ${s.name}</span></td>
            <td style="padding: 8px; color: ${stColor} !important; font-weight: 600; font-size: 13px;"><span style="color: ${stColor} !important;">${stText}</span></td>
            <td class="label-col" style="padding: 8px; color: #94a3b8 !important; font-size: 13px;"><span class="label-col" style="color: #94a3b8 !important;">${rt}</span></td>
          </tr>`;
  }).join('');

  const contentHtml = `
    <h3 class="section-hdr" style="margin: 0 0 12px 0; font-size: 13px; color: #cbd5e1 !important; text-transform: uppercase; letter-spacing: 0.05em;"><span class="section-hdr" style="color: #cbd5e1 !important;">Current Stream Status</span></h3>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
      <tr style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Stream</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Status</span></td>
        <td class="label-col" style="padding: 6px 8px; border-bottom: 1px solid #28283d;"><span class="label-col" style="color: #94a3b8 !important;">Response</span></td>
      </tr>
      ${allStreamsRows}
    </table>

    <div class="callout-box" style="background-color: #1e1b38; border: 1px solid #3d3575; border-radius: 8px; padding: 16px; margin-top: 20px;">
      <p class="callout-title" style="font-weight: 600; color: #c4b5fd !important; margin: 0 0 8px 0; font-size: 14px;"><span class="callout-title" style="color: #c4b5fd !important;">ℹ️ What to expect</span></p>
      <ul class="callout-text" style="margin: 0; padding-left: 20px; color: #e2e8f0 !important; font-size: 13px; line-height: 1.8;">
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🔴 <strong>Down alert</strong> when a stream fails ${FAILURE_THRESHOLD} consecutive checks</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🔇 <strong>Dead Air alert</strong> when silence persists across ${SILENCE_FAILURE_THRESHOLD} 5-second probes</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">🟢 <strong>Recovery alert</strong> when a stream comes back online</span></li>
        <li style="color: #e2e8f0 !important;"><span style="color: #e2e8f0 !important;">Checks run every ${Math.round(CHECK_INTERVAL / 1000)} seconds</span></li>
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

module.exports = { start, stop, getStreams, getStatus, getHistory, getIncidents, getConfig, sendTestAlert };
