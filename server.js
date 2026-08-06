require('dotenv').config();
const express = require('express');
const path = require('path');
const monitor = require('./monitor');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Security & Search Engine Deterrence Middleware ─────────────────────────
app.use((req, res, next) => {
  // Discourage search engine indexing (unlisted site)
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});

// ── Serve Static Frontend (Cache Busting for Dev) ───────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Prevent stale client-side caching during dev & deployment
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ── API Endpoints ───────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    streams: monitor.getStatus(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/history', (req, res) => {
  res.json({
    history: monitor.getHistory(),
    incidents: monitor.getIncidents(),
  });
});

app.get('/api/config', (req, res) => {
  res.json(monitor.getConfig());
});

// ── Permanent Event Log ─────────────────────────────────────────────────────
// Every recorded event, filterable. Unlike /api/history this is never pruned
// by age, so it can serve the full incident record back to day one.
app.get('/api/events', (req, res) => {
  const q = req.query;
  const limit = Math.min(parseInt(q.limit, 10) || 200, 2000);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

  let since = q.since;
  // Convenience: ?days=30 instead of an explicit ISO timestamp.
  if (!since && q.days) {
    const days = parseInt(q.days, 10);
    if (Number.isFinite(days) && days > 0) {
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  const result = monitor.getEvents({
    streamId: q.streamId || undefined,
    type: q.type || undefined,
    severity: q.severity || undefined,
    cause: q.cause || undefined,
    scope: q.scope || undefined,
    since,
    until: q.until || undefined,
    emailed: q.emailed === 'true' ? true : q.emailed === 'false' ? false : undefined,
    limit,
    offset,
    order: q.order === 'asc' ? 'asc' : 'desc',
  });

  res.json(result);
});

app.get('/api/events/:id', (req, res) => {
  const { events } = monitor.getEvents({});
  const event = events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// ── Aggregate Statistics ────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
  const windowMs = days * 24 * 60 * 60 * 1000;

  res.json({
    windowDays: days,
    summary: monitor.getSummary(windowMs),
    daily: monitor.getDailyBuckets(days),
    causes: monitor.getCauseBreakdown(windowMs),
    storage: monitor.getStorageInfo(),
    streams: monitor.getStreams().map((s) => ({ id: s.id, name: s.name, url: s.url })),
    generatedAt: new Date().toISOString(),
  });
});

// ── Uptime Over a Range (24h / 7d / 30d / 90d / 1y / all) ───────────────────
// Lightweight on purpose — the dashboard's range tabs and the History page's
// summary tile call this on demand, so it skips the heavier daily-bucket and
// cause-breakdown work that /api/stats does.
app.get('/api/uptime', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 1, 1), 3650);
  const windowMs = days * 24 * 60 * 60 * 1000;
  const coverageStart = monitor.getCoverageStart();
  const coverageDays = coverageStart
    ? Math.round(((Date.now() - new Date(coverageStart).getTime()) / (24 * 60 * 60 * 1000)) * 100) / 100
    : 0;

  res.json({
    days,
    uptime: monitor.getOverallUptime(windowMs),
    coverageStart,
    coverageDays,
  });
});

// ── Per-stream Telemetry (raw samples + hourly rollups) ─────────────────────
app.get('/api/samples/:streamId', (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 365);
  res.json({
    streamId: req.params.streamId,
    samples: monitor.getSamples(req.params.streamId, hours * 60 * 60 * 1000),
    rollups: monitor.getRollups(req.params.streamId),
  });
});

// ── Live Icecast Server Diagnostics ─────────────────────────────────────────
// Exposes the raw mount inventory the diagnosis engine correlates against —
// including other stations on the same host, which is how a KPFT-only fault is
// told apart from a Pacifica-wide one.
app.get('/api/diagnostics', (req, res) => {
  const snapshot = monitor.getSnapshot();
  if (!snapshot) {
    return res.status(503).json({ error: 'No Icecast snapshot yet — first check cycle has not completed' });
  }
  res.json({
    icecast: {
      reachable: snapshot.reachable,
      fetchError: snapshot.fetchError,
      serverId: snapshot.serverId,
      host: snapshot.host,
      admin: snapshot.admin,
      location: snapshot.location,
      serverStart: snapshot.serverStart,
      mountCount: snapshot.mountCount,
      responseTime: snapshot.responseTime,
      fetchedAt: snapshot.fetchedAt,
    },
    mounts: Object.values(snapshot.mounts || {}),
    streams: monitor.getStatus(),
  });
});

// ── Test Email Alert ────────────────────────────────────────────────────────
app.get('/api/test-alert', async (req, res) => {
  const to = (req.query.to || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!to || !emailRegex.test(to)) {
    return res.status(400).json({ error: 'Provide a valid email address via ?to=user@example.com' });
  }
  try {
    await monitor.sendTestAlert(to);
    res.json({ success: true, message: `Test alert sent to ${to}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health Check (for Docker / Coolify) ─────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Dashboard running at http://0.0.0.0:${PORT}`);
  monitor.start();
});
