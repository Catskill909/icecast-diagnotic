#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   Witness — a second pair of eyes on another network

   WHY THIS EXISTS. 2026-09-12, 20:52 UTC: the monitor could not reach
   streams.pacifica.org for 14 minutes. It showed KPFK OFFLINE and emailed KPFK,
   while KPFK's encoder stayed connected, its audience grew, and people played it
   on the website. From ONE network, "the station is off air" and "our route to
   it is broken" look identical. From two, they do not.

   The monitor calls this whenever its own connection to a stream fails. The
   witness, running on a DIFFERENT network, tries the same stream and reads the
   same server's status page, and says what it saw. If it got audio, the station
   is on air and the monitor's path is the fault.

   Deliberately tiny and dependency-free: it must keep working when everything
   else is having a bad day, and it must be deployable anywhere Node 18+ runs.

   It is NOT an open proxy. Every request needs WITNESS_TOKEN, and it only ever
   connects to hosts listed in WITNESS_ALLOWED_HOSTS.

   Environment:
     WITNESS_TOKEN          required — shared secret; the monitor sends it
     WITNESS_ALLOWED_HOSTS  required — comma list of host[:port] it may check,
                            e.g. streams.pacifica.org:9000,streaming.wbai.org
     WITNESS_NAME           shown in the monitor's evidence, e.g. "fly-ord"
     PORT                   default 8080
   ═══════════════════════════════════════════════════════════════════════════ */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const STREAM_READ_BYTES = 16 * 1024;
const STREAM_DEADLINE_MS = 12 * 1000;
const STATUS_DEADLINE_MS = 12 * 1000;
const STATUS_MAX_BYTES = 4 * 1024 * 1024;

function config(env = process.env) {
  return {
    token: String(env.WITNESS_TOKEN || ''),
    allowed: new Set(String(env.WITNESS_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
    name: String(env.WITNESS_NAME || 'witness'),
    port: parseInt(env.PORT, 10) || 8080,
  };
}

function hostAllowed(cfg, urlString) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return cfg.allowed.has(u.host.toLowerCase());
}

/**
 * One GET with connection phase timings. `mode: 'stream'` stops after a little
 * audio — enough to prove the mount is serving; `mode: 'body'` reads the whole
 * (bounded) response. Never throws.
 */
function fetchOnce(urlString, mode) {
  return new Promise((resolve) => {
    const start = Date.now();
    const marks = {};
    const timings = {};
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const u = new URL(urlString);
    const client = u.protocol === 'https:' ? https : http;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timings.total = Date.now() - start;
      resolve({ ...payload, bytes, timings });
    };
    const req = client.get(urlString, { agent: false, headers: { 'User-Agent': 'PacificaMonitorWitness/1.0', 'Icy-MetaData': '0' } }, (res) => {
      timings.ttfb = Date.now() - start;
      const httpStatus = res.statusCode;
      const contentType = res.headers['content-type'] || null;
      if (httpStatus !== 200) {
        res.resume();
        return done({ ok: false, httpStatus, contentType, error: `HTTP ${httpStatus}` });
      }
      res.on('data', (c) => {
        bytes += c.length;
        if (mode === 'body') {
          if (bytes > STATUS_MAX_BYTES) { req.destroy(); return done({ ok: false, httpStatus, error: 'status body too large' }); }
          chunks.push(c);
        } else if (bytes >= STREAM_READ_BYTES) {
          req.destroy();
          done({ ok: true, httpStatus, contentType });
        }
      });
      res.on('end', () => done(mode === 'body'
        ? { ok: true, httpStatus, contentType, body: Buffer.concat(chunks).toString('utf8') }
        : { ok: bytes > 0, httpStatus, contentType, ...(bytes > 0 ? {} : { error: 'stream ended with no audio' }) }));
      res.on('error', (err) => done({ ok: mode !== 'body' && bytes > 0, httpStatus, error: err.message }));
    });
    req.on('socket', (socket) => {
      socket.on('lookup', (err, address) => { marks.dns = Date.now(); timings.dns = marks.dns - start; if (!err && address) timings.ip = address; });
      socket.on('connect', () => { marks.tcp = Date.now(); timings.tcp = marks.tcp - (marks.dns || start); });
      socket.on('secureConnect', () => { timings.tls = Date.now() - (marks.tcp || marks.dns || start); });
    });
    req.on('error', (err) => done({ ok: false, error: err.message, errorCode: err.code || null }));
    const timer = setTimeout(() => {
      req.destroy();
      done(mode === 'stream' && bytes > 0
        ? { ok: true, note: 'deadline reached while audio was flowing' }
        : { ok: false, error: `no ${mode === 'body' ? 'response' : 'audio'} within ${mode === 'body' ? STATUS_DEADLINE_MS : STREAM_DEADLINE_MS}ms`, errorCode: 'EDEADLINE' });
    }, mode === 'body' ? STATUS_DEADLINE_MS : STREAM_DEADLINE_MS);
  });
}

function tokenMatches(cfg, header) {
  const given = String(header || '').replace(/^Bearer\s+/i, '');
  if (!cfg.token || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createServer(cfg = config(), fetcher = fetchOnce) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://witness');

    if (url.pathname === '/health') return send(200, { ok: true, witness: cfg.name });
    if (url.pathname !== '/check' || req.method !== 'GET') return send(404, { error: 'not found' });
    if (!tokenMatches(cfg, req.headers.authorization)) return send(401, { error: 'unauthorized' });

    const streamUrl = url.searchParams.get('stream');
    const statusUrl = url.searchParams.get('status');
    for (const u of [streamUrl, statusUrl].filter(Boolean)) {
      if (!hostAllowed(cfg, u)) return send(403, { error: `host not allowed: ${u}` });
    }
    if (!streamUrl && !statusUrl) return send(400, { error: 'stream or status required' });

    const at = new Date().toISOString();
    // Status FIRST, then the stream — never together. Icecast counts every
    // connection as a listener, the witness's own included, so reading the
    // inventory while our stream connection is open would put us in the counts.
    const status = statusUrl ? await fetcher(statusUrl, 'body') : null;
    const stream = streamUrl ? await fetcher(streamUrl, 'stream') : null;
    send(200, { witness: cfg.name, at, stream, status });
  });
}

if (require.main === module) {
  const cfg = config();
  if (!cfg.token || !cfg.allowed.size) {
    console.error('[witness] WITNESS_TOKEN and WITNESS_ALLOWED_HOSTS are both required.');
    process.exit(1);
  }
  createServer(cfg).listen(cfg.port, () => {
    console.log(`[witness] "${cfg.name}" listening on :${cfg.port} — allowed: ${[...cfg.allowed].join(', ')}`);
  });
}

module.exports = { createServer, config, hostAllowed, fetchOnce, tokenMatches };
