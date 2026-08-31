require('dotenv').config();
const express = require('express');
const path = require('path');
const monitor = require('./monitor');
const auth = require('./auth');
const redact = require('./redact');
const discover = require('./discover');
const safeUrl = require('./safe-url');
const diagnose = require('./diagnose');

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

// The admin pages always require a session, even when reads are otherwise
// public. Their API calls are protected either way, so an anonymous visitor
// could only ever have seen an empty form — but a browsable administration
// screen invites people to try, and there is no reason to serve one.
//
// Alert recipients are edited here too, which makes the gate stronger than a
// preference: what this page can put on screen is a list of named people's
// email addresses. Every asset the page loads must be listed as well — a page
// that borrows a gated stylesheet while not being gated itself renders
// unstyled for exactly the visitor who should not have reached it.
const ADMIN_PAGES = new Set(['/admin.html', '/admin.js', '/admin.css']);
app.use((req, res, next) => {
  if (!ADMIN_PAGES.has(req.path)) return next();
  if (auth.currentSession(req)) return next();
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
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

// Every aggregate is scoped by station. Absent means "all stations", which is
// what a fleet view wants and what a single-station deployment always got.
const stationOf = (req) => (typeof req.query.stationId === 'string' && req.query.stationId.trim())
  ? req.query.stationId.trim()
  : undefined;

// The stations available to a picker, cheap enough to poll.
app.get('/api/stations/list', (req, res) => {
  res.json({ stations: monitor.getStations() });
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
    // Redacted for anonymous callers exactly as /api/events is. This route
    // returned STORED events verbatim — the older, back-compatible sibling of
    // /api/events, which was given redaction when the leak there was found and
    // this one was not. It was publishing the Icecast servers' own contact
    // addresses, and would have published real alert recipients the moment a
    // station with recipients had an outage inside the 24-hour window.
    //
    // The same lesson twice in one day: a projection protects the routes that
    // were routed through it, and nothing makes a second route comply.
    incidents: auth.currentSession(req)
      ? monitor.getIncidents()
      : redact.publicEvents(monitor.getIncidents()),
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

// ── Station Discovery ───────────────────────────────────────────────────────
// Paste one URL — a status document or any stream on the same server — and get
// back every mount that server is serving, grouped into the channels a listener
// would recognise, with live listener counts.
//
// Authenticated, and not only because it writes nothing: it makes THIS SERVER
// fetch an address someone else chose. Every such fetch goes through safe-url,
// which resolves the hostname and refuses private and reserved ranges — a
// hostname resolving to 127.0.0.1 passes any check that reads only the URL.
app.post('/api/stations/discover', auth.requireAuth, async (req, res) => {
  const raw = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!raw.trim()) return res.status(400).json({ error: 'Provide a URL' });

  const derived = discover.toStatusUrl(raw);
  if (!derived.ok) return res.status(400).json({ error: derived.reason });

  try {
    // Structural validation happened above; this is the resolution check.
    await safeUrl.assertPublicHost(derived.url.hostname);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // attempts: 1 — a person is watching a button. The 3x retry budget in
  // fetchIcecastSnapshot is sized for an unattended cycle where a wasted 30s
  // costs nothing; here it is the whole complaint.
  let statusUrl = derived.url;
  let snapshot = await diagnose.fetchIcecastSnapshot(statusUrl.href, { attempts: 1 });

  // The pasted scheme is a guess. An Icecast on :8000 is very often plaintext
  // even though the operator copied https from their browser bar, and an https
  // request to a plaintext port stalls in the TLS handshake rather than failing
  // fast — which is what turned one pasted URL into a 48-second spinner.
  //
  // Only transport failures are retried: an HTTP status or an unparseable body
  // mean the scheme was right and something else is wrong.
  let schemeCorrected = null;
  if (!snapshot.reachable && discover.isTransportFailure(snapshot.fetchErrorCode)) {
    const alt = discover.altSchemeUrl(statusUrl);
    if (alt) {
      // Same hostname, so the resolution check above still covers it; the port
      // may differ, which the host-based guard does not care about.
      const retry = await diagnose.fetchIcecastSnapshot(alt.href, { attempts: 1 });
      if (retry.reachable) {
        schemeCorrected = { from: statusUrl.protocol.replace(':', ''), to: alt.protocol.replace(':', '') };
        statusUrl = alt;
        snapshot = retry;
      }
    }
  }

  if (!snapshot.reachable) {
    // The upstream body is never echoed back — it is a response from a server
    // the caller chose, and returning it verbatim is half of what makes SSRF
    // worth exploiting.
    return res.status(502).json({
      error: 'Could not read an Icecast status document from that address',
      detail: snapshot.fetchError,
      statusUrl: statusUrl.href,
      // Both schemes were tried when the failure was a transport one, so the
      // operator is not left guessing that http might have worked.
      triedBothSchemes: discover.isTransportFailure(snapshot.fetchErrorCode),
    });
  }

  // The mount they pasted, when they pasted a stream rather than a status URL.
  let pastedPath = null;
  if (derived.derivedFrom) {
    try { pastedPath = new URL(derived.derivedFrom).pathname; } catch { /* ignore */ }
  }

  const body = {
    statusUrl: statusUrl.href,
    derivedFrom: derived.derivedFrom || null,
    repairedJson: !!snapshot.repairedJson,
    // Surfaced, never silent. Channel URLs below are built from the scheme that
    // actually worked, and https -> http is a real downgrade for every future
    // probe — the operator confirms it rather than discovering it later.
    schemeCorrected,
    // The origin the operator reached — the addresses to probe are built from
    // it rather than from what Icecast says about itself.
    ...discover.summarise(snapshot, pastedPath, statusUrl.origin),
  };
  // A suggested name and identifier, so the operator confirms rather than types.
  // Placeholder text that merely LOOKS filled in is worse than an empty field:
  // the first attempt at this shipped with realistic placeholders and the form
  // was submitted empty.
  const matched = (body.channels || []).find((c) => c.matched) || (body.channels || [])[0];
  body.suggestedStation = discover.suggestStationIdentity(matched);
  res.json(body);
});

// Adds a station and starts monitoring it, without a redeploy.
//
// Every channel URL is re-validated here even though discovery already checked
// the one it was found on. Trusting the submitted payload would leave the
// obvious hole: discover a real inventory, then swap in a loopback address
// before saving. What gets probed every sixty seconds forever is what arrives
// in THIS request.
app.post('/api/stations', auth.requireAuth, async (req, res) => {
  const config = monitor.getStationConfig();
  const v = discover.validateStationPayload(req.body, config);
  if (!v.ok) return res.status(400).json({ errors: v.errors });

  try {
    // Structural validation happened above; this resolves each hostname, which
    // is the check a name pointing at 127.0.0.1 would otherwise walk past.
    for (const c of v.station.channels) {
      await safeUrl.assertPublicHost(new URL(c.url).hostname);
    }
  } catch (err) {
    return res.status(400).json({ errors: [err.message] });
  }

  const next = discover.addStationToConfig(config, v.station, v.hosts);
  const reload = monitor.saveStationConfig(next);

  res.status(201).json({
    station: v.station,
    monitoring: { added: reload.added, total: reload.total },
  });
});

// Edits a station. Channel ids are IMMUTABLE — they key every stored sample,
// rollup and event, so renaming one would orphan its history rather than move
// it. Everything else may change: display names, URLs, mount lists, and which
// channels the station has.
app.patch('/api/stations/:id', auth.requireAuth, async (req, res) => {
  const config = monitor.getStationConfig();
  const v = discover.validateStationEdit(req.body, config, req.params.id);
  if (!v.ok) return res.status(v.errors[0]?.startsWith('No station') ? 404 : 400).json({ errors: v.errors });

  try {
    // Re-resolved on every save. A URL that was safe when discovered is not
    // necessarily the URL being saved now.
    for (const c of v.station.channels) await safeUrl.assertPublicHost(new URL(c.url).hostname);
  } catch (err) {
    return res.status(400).json({ errors: [err.message] });
  }

  const next = discover.replaceStationInConfig(config, v.station, v.hosts);
  const reload = monitor.saveStationConfig(next);

  res.json({
    station: v.station,
    // Named explicitly: a channel dropped by an edit stops being watched, and
    // the operator should see which rather than infer it from a count.
    removedChannels: v.removedChannels,
    monitoring: { added: reload.added, removed: reload.removed, total: reload.total },
  });
});

// Stops monitoring a station. Its recorded history is NOT deleted.
//
// Configuration says what to watch from now on; it is not a statement about the
// past. Removing the record of what happened while a station WAS watched would
// destroy the thing this application exists to keep, and would do it on a click.
app.delete('/api/stations/:id', auth.requireAuth, (req, res) => {
  const config = monitor.getStationConfig();
  const station = (config?.stations || []).find((s) => s.id === req.params.id);
  if (!station) return res.status(404).json({ error: `No station with id "${req.params.id}"` });

  const next = discover.removeStationFromConfig(config, req.params.id);
  if (!next.stations.length) {
    // reloadConfig would refuse this anyway; saying so here is clearer than
    // letting the save appear to succeed and change nothing.
    return res.status(400).json({ error: 'That is the only station. Add another before removing this one.' });
  }

  const reload = monitor.saveStationConfig(next);
  res.json({
    removed: { id: station.id, name: station.name, channels: (station.channels || []).map((c) => c.id) },
    historyRetained: true,
    monitoring: { removed: reload.removed, total: reload.total },
  });
});

// What this station's Icecast host is actually serving right now.
//
// Used to check a mount BEFORE it is saved. The check is free: the monitor
// already fetches each host's full inventory once a cycle, so asking "does this
// mount exist" costs nothing and — crucially — opens no connection. Probing
// would prove more (Icecast can list a mount it will not serve) but Icecast
// counts every connection as a listener, ours included, so a probe is a button
// somebody presses, never something a form does while you type.
//
// Authenticated: it is an admin tool, and there is no reason to widen a new
// endpoint beyond the panel that uses it.
app.get('/api/stations/:id/mounts', auth.requireAuth, (req, res) => {
  const config = monitor.getStationConfig();
  if (!config) return res.status(503).json({ error: 'Configuration not initialised yet' });

  const station = (config.stations || []).find((s) => s.id === req.params.id);
  if (!station) return res.status(404).json({ error: `No station with id "${req.params.id}"` });

  const snapshot = monitor.getSnapshot();
  if (!snapshot) {
    // Not an error. Before the first cycle completes there is simply nothing to
    // compare against, and the panel must say that rather than report every
    // mount as missing.
    return res.json({ available: false, reason: 'No Icecast snapshot yet — the first check cycle has not completed', mounts: [] });
  }

  // The hosts this station's own channels live on, so a shared server does not
  // offer one station the mounts of the 28 others sitting beside it.
  const hosts = new Set();
  for (const c of station.channels || []) {
    try { hosts.add(new URL(c.url).host); } catch { /* an unparseable URL contributes no host */ }
  }

  // Which mounts are already spoken for, so the panel can say so instead of
  // letting someone attach the same mount to two channels. Keyed by host AND
  // path — see mountAssignments().
  const assigned = discover.mountAssignments(config);

  const mounts = Object.values(snapshot.mounts || {})
    .filter((m) => hosts.has(m.host))
    .map((m) => ({
      path: m.pathname,
      host: m.host,
      listeners: m.listeners ?? null,
      bitrate: m.bitrate ?? null,
      name: m.serverName || null,
      assignedTo: assigned.get(`${m.host}${m.pathname}`) || null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  res.json({
    available: true,
    reachable: snapshot.reachable !== false,
    fetchedAt: snapshot.fetchedAt || null,
    hosts: [...hosts],
    mounts,
  });
});

// ── Alert recipients ────────────────────────────────────────────────────────
// Who a station's alerts go to. A route of its own rather than a field on the
// station edit, because the two are different jobs for different people: editing
// channels is technical and occasional, editing who gets paged is routine and
// belongs to the station. Sharing a Save button would also put this one click
// away from "remove station".
//
// Authenticated to WRITE because these are people's addresses. Reading them is
// covered by GET /api/stations, which returns the full configuration to a
// session and an allowlisted projection to everyone else — so the addresses are
// never in an anonymous response.
// Would this station's next outage actually reach anyone? Authenticated
// because the answer names counts and the rule that withheld delivery, which
// together describe a station's notification setup.
app.get('/api/stations/:id/alerts/preview', auth.requireAuth, (req, res) => {
  const config = monitor.getStationConfig();
  if (!config) return res.status(503).json({ error: 'Configuration not initialised yet' });
  if (!(config.stations || []).some((s) => s.id === req.params.id)) {
    return res.status(404).json({ error: `No station with id "${req.params.id}"` });
  }
  res.json({ effective: monitor.describeAlertRouting(req.params.id) });
});

app.put('/api/stations/:id/alerts', auth.requireAuth, (req, res) => {
  const config = monitor.getStationConfig();
  if (!config) return res.status(503).json({ error: 'Configuration not initialised yet' });

  const station = (config.stations || []).find((s) => s.id === req.params.id);
  if (!station) return res.status(404).json({ error: `No station with id "${req.params.id}"` });

  const v = discover.validateAlertsPayload(req.body, station.alerts);
  if (!v.ok) return res.status(400).json({ errors: v.errors });

  // Wrapped so that an unexpected throw returns JSON.
  //
  // Without this, express's default handler returns an HTML error page. The
  // panel parses the body as JSON, gets nothing, and renders its generic
  // fallback — "Could not save." — which names no cause, points at no line, and
  // is indistinguishable from a dropped connection. An operator reported exactly
  // that and it could not be diagnosed from either end.
  try {
    const next = discover.setStationAlerts(config, station.id, v.alerts);
    monitor.saveStationConfig(next);

    // The saved station is re-read rather than echoing the payload back: a field
    // that was dropped in normalisation must be visibly absent to the panel, not
    // reflected back as though it had been stored.
    const saved = (monitor.getStationConfig().stations || []).find((s) => s.id === station.id);

    res.json({
      station: { id: saved.id, name: saved.name },
      alerts: saved.alerts || null,
      // Stated because it is the question the operator is actually asking, and
      // the answer depends on rules — the switch, whether any recipients exist,
      // whether mail is configured — that no single stored field expresses.
      effective: monitor.describeAlertRouting(station.id),
    });
  } catch (err) {
    console.error(`[Server] Saving alerts for "${station.id}" failed:`, err);
    res.status(500).json({ error: `Saving failed: ${err.message}` });
  }
});

// Applies stored configuration to the running monitor without a redeploy.
// The admin panel's write endpoints will call reloadConfig() directly; this
// exposes it on its own so a configuration change can be applied and verified
// before the panel that makes them exists.
app.post('/api/stations/reload', auth.requireAuth, (req, res) => {
  const result = monitor.reloadConfig();
  res.json(result);
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

  const station = stationOf(req);
  const result = monitor.getEvents({
    streamId: q.streamId || undefined,
    // Scoped before paging, not after: trimming afterwards would page through
    // every station's events and return a short page of one station's.
    streamIds: station ? monitor.streamIdsFor(station) : undefined,
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
    stationId: stationOf(req) || null,
    summary: monitor.getSummary(windowMs, stationOf(req)),
    daily: monitor.getDailyBuckets(days, stationOf(req)),
    dailyTimeZone: monitor.getConfig().weeklyRoundup.timezone,
    causes: monitor.getCauseBreakdown(windowMs, stationOf(req)),
    storage: monitor.getStorageInfo(),
    stations: monitor.getStations(),
    streams: monitor.getStreams()
      .filter((s) => !stationOf(req) || s.stationId === stationOf(req))
      .map((s) => ({ id: s.id, name: s.name, url: s.url, stationId: s.stationId })),
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
  const coverageStart = monitor.getCoverageStart(stationOf(req));
  const coverageDays = coverageStart
    ? Math.round(((Date.now() - new Date(coverageStart).getTime()) / (24 * 60 * 60 * 1000)) * 100) / 100
    : 0;

  res.json({
    days,
    // Uptime as the audience experienced it: failures where Icecast kept
    // serving the mount are not counted against the station. `probeUptime` is
    // the older sample-based figure, kept for comparison.
    uptime: monitor.getAudioUptime(windowMs, stationOf(req)),
    probeUptime: monitor.getOverallUptime(windowMs, stationOf(req)),
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
  res.json(monitor.getPeriodRollup(days * 24 * 60 * 60 * 1000, stationOf(req)));
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
      stationOf(req),
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
      // One Icecast process per monitored host. serverId and serverStart
      // describe a single process, so they have no merged meaning once more
      // than one host is monitored — `servers` is the truthful shape there.
      servers: snapshot.servers || null,
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
    // Scoped, so a test for one station's recipient does not send them every
    // other station's listener figures.
    await monitor.sendTestAlert(to, stationOf(req));
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
  // The roundup is one report per station. Absent, it falls back to the only
  // station when there is one, which keeps every existing call working.
  const stationId = stationOf(req);

  // ?preview=1 renders the message in the browser instead of mailing it, so it
  // can be checked before a real one goes out — and without needing SMTP at all.
  if (req.query.preview === '1' || req.query.preview === 'true') {
    const { subject, html } = monitor.previewWeeklyRoundup(windowMs, stationId);
    res.setHeader('X-Roundup-Subject', encodeURIComponent(subject));
    return res.type('html').send(html);
  }

  try {
    const result = await monitor.sendWeeklyRoundup({ to: to || undefined, windowMs, stationId });
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
