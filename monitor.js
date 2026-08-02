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

// ── Stream Health Check ─────────────────────────────────────────────────────
function checkStream(stream) {
  return new Promise((resolve) => {
    const start = Date.now();
    const urlObj = new URL(stream.url);
    const client = urlObj.protocol === 'https:' ? https : http;

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

        // Destroy the response immediately — we don't need the audio data
        res.destroy();

        if (res.statusCode === 200 && (contentType.includes('audio') || contentType.includes('ogg') || icyName)) {
          resolve({ status: 'up', responseTime, error: null });
        } else {
          resolve({
            status: 'down',
            responseTime,
            error: `HTTP ${res.statusCode}, Content-Type: ${contentType}`,
          });
        }
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 'down',
        responseTime: Date.now() - start,
        error: 'Connection timed out',
      });
    });

    req.on('error', (err) => {
      resolve({
        status: 'down',
        responseTime: Date.now() - start,
        error: err.message,
      });
    });

    req.end();
  });
}

// ── Run Check Cycle ─────────────────────────────────────────────────────────
async function runChecks() {
  const timestamp = new Date().toISOString();
  console.log(`[Monitor] Running checks at ${timestamp}`);

  const results = await Promise.all(streams.map((s) => checkStream(s)));

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const result = results[i];
    const prev = streamStatus[stream.id];
    const wasDown = prev.status === 'down';
    const isDown = result.status === 'down';

    // Update status
    streamStatus[stream.id] = {
      status: result.status,
      responseTime: result.responseTime,
      lastChecked: timestamp,
      consecutiveFailures: isDown ? prev.consecutiveFailures + 1 : 0,
      error: result.error,
    };

    // Record history
    history[stream.id].push({
      timestamp,
      status: result.status,
      responseTime: result.responseTime,
      error: result.error,
    });

    // State transition detection
    const failures = streamStatus[stream.id].consecutiveFailures;

    // DOWN alert: crossed the threshold exactly
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

    // RECOVERY alert
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
  const dashboardUrl = process.env.DASHBOARD_URL || '';
  const isDown = type === 'down';
  const emoji = isDown ? '🔴' : '🟢';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';
  const failures = streamStatus[stream.id]?.consecutiveFailures || 0;

  const subject = `${emoji} KPFT Alert: ${stream.name} is ${statusText}`;

  // Build all-streams status summary for the email
  const allStreamsRows = streams.map((s) => {
    const st = streamStatus[s.id] || {};
    const dot = st.status === 'up' ? '🟢' : st.status === 'down' ? '🔴' : '⚪';
    const stText = st.status === 'up' ? 'Online' : st.status === 'down' ? 'Offline' : 'Unknown';
    const rt = st.responseTime != null ? `${st.responseTime}ms` : '—';
    return `
          <tr>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">${dot} ${s.name}</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e; color: ${st.status === 'up' ? '#4ade80' : st.status === 'down' ? '#f87171' : '#888'}; font-weight: 600;">${stText}</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">${rt}</td>
          </tr>`;
  }).join('');

  // Build troubleshooting guidance
  const troubleshooting = isDown ? `
        <div style="background: #1a1020; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; padding: 16px; margin-top: 16px;">
          <p style="font-weight: 600; color: #f87171; margin: 0 0 8px 0; font-size: 14px;">⚠️ Troubleshooting Steps</p>
          <ol style="margin: 0; padding-left: 20px; color: #c0c0d0; font-size: 13px; line-height: 1.8;">
            <li>Check if the Icecast server at <code style="background: #2a2a3e; padding: 1px 4px; border-radius: 3px;">streams.pacifica.org:9000</code> is reachable</li>
            <li>Verify the source client is connected and sending audio</li>
            <li>Check Icecast admin panel for mount point status</li>
            <li>Review Icecast server logs for errors</li>
            <li>Restart the source encoder if needed</li>
          </ol>
        </div>` : '';

  const dashboardLink = dashboardUrl ? `
        <div style="text-align: center; margin-top: 20px;">
          <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #7c6aef, #a595ff); color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
            📊 Open Stream Monitor Dashboard
          </a>
        </div>` : '';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${isDown ? 'linear-gradient(135deg, #dc2626, #991b1b)' : 'linear-gradient(135deg, #16a34a, #15803d)'}; color: white; padding: 24px 28px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">${emoji} Stream ${statusText}</h1>
        <p style="margin: 8px 0 0 0; font-size: 14px; opacity: 0.9;">${isDown ? `${stream.name} has gone offline after ${failures} consecutive failed checks.` : `${stream.name} is back online and streaming normally.`}</p>
      </div>
      <div style="background: #1e1e2e; color: #e0e0e0; padding: 24px 28px;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #9090a8; text-transform: uppercase; letter-spacing: 0.05em;">Affected Stream</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
          <tr>
            <td style="padding: 8px 0; color: #888; width: 140px;">Stream Name</td>
            <td style="padding: 8px 0; font-weight: 600;">${stream.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #888;">Stream URL</td>
            <td style="padding: 8px 0;"><code style="background: #2a2a3e; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${stream.url}</code></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #888;">M3U Playlist</td>
            <td style="padding: 8px 0;"><a href="${stream.m3u}" style="color: #a595ff; text-decoration: none; font-size: 12px;">${stream.m3u}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #888;">Status</td>
            <td style="padding: 8px 0; font-weight: 700; color: ${isDown ? '#f87171' : '#4ade80'}; font-size: 16px;">${statusText}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #888;">Response Time</td>
            <td style="padding: 8px 0;">${result.responseTime}ms</td>
          </tr>
          ${result.error ? `
          <tr>
            <td style="padding: 8px 0; color: #888;">Error Details</td>
            <td style="padding: 8px 0; color: #f87171;"><code style="background: rgba(239,68,68,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px;">${result.error}</code></td>
          </tr>` : ''}
          ${isDown ? `
          <tr>
            <td style="padding: 8px 0; color: #888;">Failed Checks</td>
            <td style="padding: 8px 0; color: #f59e0b; font-weight: 600;">${failures} consecutive</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 0; color: #888;">Detected At</td>
            <td style="padding: 8px 0;">${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} CT</td>
          </tr>
        </table>

        ${troubleshooting}

        <hr style="border: none; border-top: 1px solid #2a2a3e; margin: 20px 0;">

        <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #9090a8; text-transform: uppercase; letter-spacing: 0.05em;">All Streams Overview</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">Stream</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">Status</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">Response</td>
          </tr>
          ${allStreamsRows}
        </table>

        ${dashboardLink}
      </div>
      <div style="background: #12121e; padding: 16px 28px; border-radius: 0 0 12px 12px; text-align: center;">
        <p style="color: #606078; font-size: 11px; margin: 0;">
          KPFT Icecast Stream Monitor · Checking every ${Math.round(CHECK_INTERVAL / 1000)}s · Alert after ${FAILURE_THRESHOLD} failures
        </p>
        <p style="color: #606078; font-size: 11px; margin: 4px 0 0 0;">
          Pacifica Foundation — Houston, TX
        </p>
      </div>
    </div>
  `;

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
    emailConfigured: !!transporter,
    alertRecipients: (process.env.ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean).length,
  };
}

async function sendTestAlert(toEmail) {
  if (!transporter) {
    throw new Error('SMTP not configured');
  }

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  const dashboardUrl = process.env.DASHBOARD_URL || '';
  const testStream = streams[0] || { name: 'KPFT Main', url: 'https://streams.pacifica.org:9000/live_128', m3u: '' };

  // Build current status of all streams
  const allStreamsRows = streams.map((s) => {
    const st = streamStatus[s.id] || {};
    const dot = st.status === 'up' ? '🟢' : st.status === 'down' ? '🔴' : '⚪';
    const stText = st.status === 'up' ? 'Online' : st.status === 'down' ? 'Offline' : 'Unknown';
    const rt = st.responseTime != null ? `${st.responseTime}ms` : '—';
    return `
          <tr>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">${dot} ${s.name}</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e; color: ${st.status === 'up' ? '#4ade80' : st.status === 'down' ? '#f87171' : '#888'}; font-weight: 600;">${stText}</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">${rt}</td>
          </tr>`;
  }).join('');

  const dashboardLink = dashboardUrl ? `
        <div style="text-align: center; margin-top: 20px;">
          <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #7c6aef, #a595ff); color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
            📊 Open Stream Monitor Dashboard
          </a>
        </div>` : '';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #7c6aef, #5a49c9); color: white; padding: 24px 28px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">🧪 Test Alert — Email Working!</h1>
        <p style="margin: 8px 0 0 0; font-size: 14px; opacity: 0.9;">This is a test alert from the KPFT Stream Monitor. If you receive this, email alerts are configured correctly.</p>
      </div>
      <div style="background: #1e1e2e; color: #e0e0e0; padding: 24px 28px;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #9090a8; text-transform: uppercase; letter-spacing: 0.05em;">Current Stream Status</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">Stream</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">Status</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #2a2a3e;">Response</td>
          </tr>
          ${allStreamsRows}
        </table>

        <div style="background: rgba(124, 106, 239, 0.08); border: 1px solid rgba(124, 106, 239, 0.2); border-radius: 8px; padding: 16px; margin-top: 16px;">
          <p style="font-weight: 600; color: #a595ff; margin: 0 0 8px 0; font-size: 14px;">ℹ️ What to expect</p>
          <ul style="margin: 0; padding-left: 20px; color: #c0c0d0; font-size: 13px; line-height: 1.8;">
            <li>🔴 <strong>Down alert</strong> when a stream fails ${FAILURE_THRESHOLD} consecutive checks</li>
            <li>🟢 <strong>Recovery alert</strong> when a stream comes back online</li>
            <li>Checks run every ${Math.round(CHECK_INTERVAL / 1000)} seconds</li>
          </ul>
        </div>

        ${dashboardLink}
      </div>
      <div style="background: #12121e; padding: 16px 28px; border-radius: 0 0 12px 12px; text-align: center;">
        <p style="color: #606078; font-size: 11px; margin: 0;">
          KPFT Icecast Stream Monitor · Test Email · ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} CT
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject: '🧪 KPFT Stream Monitor — Test Alert',
    html,
  });
  console.log(`[Monitor] Test alert sent to ${toEmail}`);
}

module.exports = { start, stop, getStreams, getStatus, getHistory, getIncidents, getConfig, sendTestAlert };
