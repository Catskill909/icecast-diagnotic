require('dotenv').config();
const express = require('express');
const path = require('path');
const monitor = require('./monitor');
const auth = require('./auth');
const redact = require('./redact');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(express.json({ limit: '256kb' }));

// ── Security & Search Engine Deterrence Middleware ─────────────────────────
app.use((req, res, next) => {
  // Discourage search engine indexing (unlisted site)
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  // Defence in depth behind the output escaping, not instead of it. If a script
  // ever does get injected, this is what stops it loading a payload or posting
  // stolen data somewhere.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // No 'unsafe-inline'. Every page loads its script from a file, so an
    // injected <script> does not execute even if one is somehow rendered —
    // which is the difference between an escaping bug being a defect and being
    // an account takeover.
    "script-src 'self'",
    // Split so scripts stay strict while nine inline style attributes in the
    // dashboard markup keep working. Style injection is defacement; script
    // injection is the one worth spending strictness on.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "style-src-elem 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    // The dashboard's preview player streams audio straight from Icecast, which
    // is a different origin.
    "media-src 'self' https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Clickjacking: nothing here should ever be framed.
    "frame-ancestors 'none'",
  ].join('; '));

  // Stops a response being reinterpreted as a type it is not — the classic way
  // a JSON endpoint becomes a script include.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Belt and braces with frame-ancestors, for older browsers.
  res.setHeader('X-Frame-Options', 'DENY');
  // Keeps the dashboard URL out of Referer headers sent to other sites; this is
  // an unlisted host and its address is not worth leaking.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // HSTS only over https, and only when a proxy says the original request was.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Reading is public by default: the dashboard is meant to be openable, and
// redact.js keeps identities out of every public response. A station that would
// rather its incident history were not readable by anyone with the URL sets
// REQUIRE_LOGIN_FOR_READ=true and everything except the login page and the
// health check needs a session.
//
// Written as a setting rather than left as an open question, because "we should
// decide about this someday" is how a deployment ends up more open than its
// operator believes.
const REQUIRE_LOGIN_FOR_READ =
  String(process.env.REQUIRE_LOGIN_FOR_READ ?? '').trim().toLowerCase() === 'true';

const ALWAYS_PUBLIC = new Set(['/login.html', '/login.css', '/login.js', '/health', '/robots.txt']);

app.use((req, res, next) => {
  if (!REQUIRE_LOGIN_FOR_READ) return next();
  if (ALWAYS_PUBLIC.has(req.path)) return next();
  if (req.path === '/api/login' || req.path === '/api/logout' || req.path === '/api/me') return next();
  if (auth.currentSession(req)) return next();
  // A browser asking for a page is sent to sign in; anything else gets a 401 it
  // can act on rather than an HTML page it cannot parse.
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ error: 'Authentication required' });
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

// ── Authentication ──────────────────────────────────────────────────────────
// One shared admin credential and a signed cookie — the minimum needed before
// any endpoint that changes state or sends mail can safely exist. Reading stays
// open, which is the dashboard's existing behaviour.

app.post('/api/login', (req, res) => {
  if (!auth.isConfigured()) {
    return res.status(503).json({
      error: 'Admin password not configured',
      detail: 'Set ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) to enable login.',
    });
  }

  const key = auth.clientKey(req);
  const locked = auth.lockoutRemaining(key);
  if (locked > 0) {
    // Rate limiting is what actually stops password guessing — not the shape of
    // the login form.
    return res.status(429).json({
      error: 'Too many attempts',
      retryAfterSeconds: Math.ceil(locked / 1000),
    });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!auth.verifyCredentials(username, password)) {
    auth.recordFailure(key);
    // Deliberately says nothing about which part was wrong.
    return res.status(401).json({ error: 'Incorrect credentials' });
  }

  auth.clearFailures(key);
  const exp = Date.now() + auth.SESSION_HOURS * 60 * 60 * 1000;
  auth.setSessionCookie(req, res, auth.signSession({ sub: 'admin', iat: Date.now(), exp }));
  res.json({ ok: true, expiresAt: new Date(exp).toISOString() });
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Lets the UI decide what to render without guessing, and tells an operator
// whether a password has been configured at all.
app.get('/api/me', (req, res) => {
  const session = auth.currentSession(req);
  res.json({
    authenticated: !!session,
    configured: auth.isConfigured(),
    expiresAt: session?.exp ? new Date(session.exp).toISOString() : null,
  });
});

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

// ── Station Configuration ───────────────────────────────────────────────────
// The station/channel/host tree the monitor is running from. Configuration now
// lives in the store rather than in environment variables, so this is the
// authoritative answer to "what is being monitored" — and it is the API the
// admin panel will later write to.
app.get('/api/stations', (req, res) => {
  const config = monitor.getStationConfig();
  if (!config) return res.status(503).json({ error: 'Configuration not initialised yet' });
  // Anonymous callers get an allowlisted view. Alert recipients and status URLs
  // — which can carry credentials — are never in it, and any field added to the
  // configuration later is withheld until someone decides otherwise.
  res.json(auth.currentSession(req) ? config : redact.publicStationConfig(config));
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

  // The delivery record on each event names every person alerted. That is worth
  // keeping — it answers "who was told" — but it must not be served to anyone
  // who finds the URL. Authenticated administrators still see it in full.
  if (!auth.currentSession(req)) result.events = redact.publicEvents(result.events);
  res.json(result);
});

app.get('/api/events/:id', (req, res) => {
  const { events } = monitor.getEvents({});
  const event = events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(auth.currentSession(req) ? event : redact.publicEvent(event));
});

// ── Aggregate Statistics ────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
  const windowMs = days * 24 * 60 * 60 * 1000;

  res.json({
    windowDays: days,
    summary: monitor.getSummary(windowMs),
    daily: monitor.getDailyBuckets(days),
    dailyTimeZone: monitor.getConfig().weeklyRoundup.timezone,
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
    // Uptime as the audience experienced it: failures where Icecast kept
    // serving the mount are not counted against the station. `probeUptime` is
    // the older sample-based figure, kept for comparison.
    uptime: monitor.getAudioUptime(windowMs),
    probeUptime: monitor.getOverallUptime(windowMs),
    coverageStart,
    coverageDays,
  });
});

// ── Period Rollup ───────────────────────────────────────────────────────────
// "What happened over this window", in numbers and in one English sentence.
// The history page's Overview line and the weekly roundup email both read this,
// so the dashboard and the inbox can never quote different figures.
app.get('/api/rollup', (req, res) => {
  const days = Math.min(Math.max(parseFloat(req.query.days) || 7, 0.04), 3650);
  res.json(monitor.getPeriodRollup(days * 24 * 60 * 60 * 1000));
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

// ── Listener Analytics ──────────────────────────────────────────────────────
// Audience over time with the outage windows that interrupted it, served
// together so the chart and its overlay always describe the same instant.
app.get('/api/listeners', (req, res) => {
  const days = Math.min(Math.max(parseFloat(req.query.days) || 1, 0.04), 3650);
  const bucketMinutes = parseInt(req.query.bucketMinutes, 10);
  res.json(
    monitor.getListeners(
      days * 24 * 60 * 60 * 1000,
      Number.isFinite(bucketMinutes) && bucketMinutes > 0 ? bucketMinutes * 60 * 1000 : undefined,
    ),
  );
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
  const icecast = {
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
  };
  res.json({
    icecast: auth.currentSession(req) ? icecast : redact.publicIcecast(icecast),
    mounts: Object.values(snapshot.mounts || {}),
    streams: monitor.getStatus(),
  });
});

// ── Test Email Alert ────────────────────────────────────────────────────────
// PROTECTED: sends mail through the station's SMTP. Open to the internet this
// was a way for anyone who found the URL to fire station-branded email at
// arbitrary addresses and burn the sending reputation.
app.get('/api/test-alert', auth.requireAuth, async (req, res) => {
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

// ── Alert Email Preview ─────────────────────────────────────────────────────
// Renders the alert email for a stored event. Lets the exact message be checked
// against real data instead of only ever being seen when something breaks.
app.get('/api/events/:id/email-preview', (req, res) => {
  const message = monitor.previewAlertForEvent(req.params.id);
  if (!message) return res.status(404).json({ error: 'Event not found' });
  res.setHeader('X-Alert-Subject', encodeURIComponent(message.subject));
  res.type('html').send(message.html);
});

// ── Weekly Roundup (manual send / preview) ──────────────────────────────────
// The scheduled job sends this on its own; this route is for proving it works
// without waiting a week, and for re-sending one on request.
// PROTECTED: can send the roundup to an arbitrary address.
app.get('/api/weekly-roundup', auth.requireAuth, async (req, res) => {
  const to = (req.query.to || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (to && !emailRegex.test(to)) {
    return res.status(400).json({ error: 'Invalid email address in ?to=' });
  }
  const days = Math.min(Math.max(parseFloat(req.query.days) || 7, 0.04), 365);
  const windowMs = days * 24 * 60 * 60 * 1000;

  // ?preview=1 renders the message in the browser instead of mailing it, so it
  // can be checked before a real one goes out — and without needing SMTP at all.
  if (req.query.preview === '1' || req.query.preview === 'true') {
    const { subject, html } = monitor.previewWeeklyRoundup(windowMs);
    res.setHeader('X-Roundup-Subject', encodeURIComponent(subject));
    return res.type('html').send(html);
  }

  try {
    const result = await monitor.sendWeeklyRoundup({ to: to || undefined, windowMs });
    // A configuration problem is not a server fault — report it as a refusal
    // with its reason rather than a 500 with no explanation.
    if (!result.sent) return res.status(result.attempted ? 502 : 400).json(result);
    res.json(result);
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
