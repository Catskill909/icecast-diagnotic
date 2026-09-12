/* ═══════════════════════════════════════════════════════════════════════════
   Network test — run FROM the monitor's own host, on demand or automatically

   2026-09-12, 20:52 and 22:11 UTC: the monitor's host could not reach
   streams.pacifica.org while the stations played for everyone else. Every test
   anyone could run came from a different machine on a different route, and
   passed. The machine that was failing had no way to say what it saw, and by
   the time anyone looked, the route had recovered and the evidence was gone.

   This runs the whole battery on the monitor's host and keeps the result:

     · DNS          which addresses the name resolves to, from here
     · status page  the Icecast status fetch, with phase timings
     · stream       the same probe the monitor uses, with phase timings
     · TCP connects several raw connects — packet loss shows as slow or failed
                    connects even when a single one happens to succeed
     · route trace  where between here and the server the path stops
     · this process open sockets and handles, so "is it us?" — a connection
                    leak in the monitor itself — is answered, not guessed

   Never throws. Every stage that fails says how, because a failed stage IS the
   finding.
   ═══════════════════════════════════════════════════════════════════════════ */

const net = require('net');
const fs = require('fs');
const dns = require('dns').promises;
const diagnose = require('./diagnose');
const pathTrace = require('./path-trace');

const TCP_ATTEMPTS = 5;
const TCP_TIMEOUT_MS = 8000;

function splitHost(host) {
  const t = pathTrace.targetOf(host);
  return t ? { name: t.name, port: t.port } : null;
}

/** One raw TCP connect: how long it took, or how it failed. */
function tcpConnect(address, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host: address, port });
    let done = false;
    const finish = (r) => { if (done) return; done = true; socket.destroy(); resolve({ ...r, ms: Date.now() - start }); };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `no connection within ${timeoutMs}ms` }));
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
  });
}

/**
 * The monitor process's own connection count. On Linux every open socket is an
 * fd under /proc/self/fd; elsewhere only the handle count is available.
 */
function processState() {
  const out = {
    uptimeSec: Math.round(process.uptime()),
    activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null,
    openSockets: null,
    openFds: null,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
  try {
    const fds = fs.readdirSync('/proc/self/fd');
    out.openFds = fds.length;
    out.openSockets = fds.filter((fd) => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith('socket:'); } catch { return false; }
    }).length;
  } catch {
    // Not Linux (a developer laptop): /proc does not exist. The handle count
    // above still answers the leak question approximately.
  }
  return out;
}

/**
 * Tests one Icecast host. `probeStreamUrl` is a stream on it, probed exactly the
 * way the monitor probes. `deps` is injectable for tests.
 */
async function testHost({ host, statusUrl, stream }, deps = {}) {
  const {
    lookup = (name) => dns.lookup(name, { all: true }),
    fetchSnapshot = (url) => diagnose.fetchIcecastSnapshot(url, { attempts: 1 }),
    probe = (s) => diagnose.probeStream(s),
    connect = tcpConnect,
    trace = (h, o) => pathTrace.runTrace(h, o),
    withTrace = true,
  } = deps;

  const target = splitHost(host);
  const result = { host, startedAt: new Date().toISOString() };

  try {
    const addrs = await lookup(target.name);
    result.dns = { ok: true, addresses: addrs.map((a) => a.address) };
  } catch (err) {
    result.dns = { ok: false, error: err.code || err.message };
  }
  const address = result.dns.ok ? result.dns.addresses[0] : target?.name;

  // Status page and stream probe one after the other, never together — the
  // probe is a listener connection and would sit inside the counts otherwise.
  if (statusUrl) {
    const snap = await fetchSnapshot(statusUrl);
    result.status = { ok: !!snap.reachable, ms: snap.responseTime ?? null, timings: snap.timings || {}, error: snap.fetchError || null, mounts: snap.mountCount ?? null };
  }
  if (stream) {
    const r = await probe(stream);
    result.stream = { streamId: stream.id, ok: r.status === 'up', httpStatus: r.httpStatus ?? null, ms: r.responseTime ?? null, timings: r.timings || {}, error: r.error || null };
  }

  const tcp = [];
  for (let i = 0; i < TCP_ATTEMPTS && target; i++) tcp.push(await connect(address, target.port));
  const okTimes = tcp.filter((t) => t.ok).map((t) => t.ms);
  result.tcp = {
    attempts: tcp,
    succeeded: okTimes.length,
    failed: tcp.length - okTimes.length,
    medianMs: okTimes.length ? okTimes.sort((a, b) => a - b)[Math.floor(okTimes.length / 2)] : null,
  };

  if (withTrace) result.trace = await trace(host, { reason: 'network-test', resolvedIp: address });

  result.verdict = verdictFor(result);
  result.finishedAt = new Date().toISOString();
  return result;
}

/** The finding, in one sentence a person can act on. */
function verdictFor(r) {
  if (r.dns && !r.dns.ok) return `The name ${r.host} does not resolve from the monitor (${r.dns.error}).`;
  const tcpBad = r.tcp && r.tcp.failed > 0;
  const tcpSlow = r.tcp?.medianMs != null && r.tcp.medianMs > 1000;
  const statusBad = r.status && !r.status.ok;
  const streamBad = r.stream && !r.stream.ok && r.stream.httpStatus == null;
  if (!tcpBad && !tcpSlow && !statusBad && !streamBad) {
    return r.stream && !r.stream.ok
      ? `The route from the monitor is healthy; the server answered the stream with HTTP ${r.stream.httpStatus}.`
      : 'The route from the monitor to this server is healthy.';
  }
  const parts = [];
  if (tcpBad) parts.push(`${r.tcp.failed} of ${r.tcp.attempts.length} TCP connections failed`);
  if (tcpSlow) parts.push(`connections took ${r.tcp.medianMs}ms (normal is well under 200ms)`);
  if (statusBad) parts.push(`the status page did not answer (${r.status.error})`);
  if (streamBad) parts.push(`the stream did not answer (${r.stream.error})`);
  let where = '';
  if (r.trace?.ok) {
    where = r.trace.reachedTarget
      ? ' The route trace reached the server, so packets are getting there but being lost or delayed.'
      : ` The route trace stopped after hop ${r.trace.lastAnsweringHop?.hop} (${r.trace.lastAnsweringHop?.host}) — that is where the path is failing.`;
  } else if (r.trace && !r.trace.ok) {
    where = ` The route trace could not run: ${r.trace.error}.`;
  }
  return `From the monitor's own host: ${parts.join('; ')}.${where}`;
}

/**
 * The whole battery for every host, in parallel (they are different servers).
 * `hosts` is [{ host, statusUrl, stream }].
 */
async function runNetworkTest(hosts, { reason = 'manual', deps } = {}) {
  const startedAt = new Date().toISOString();
  const before = processState();
  const results = await Promise.all(hosts.map((h) => testHost(h, deps)));
  return { reason, startedAt, finishedAt: new Date().toISOString(), process: before, hosts: results };
}

module.exports = { runNetworkTest, testHost, tcpConnect, processState, verdictFor, TCP_ATTEMPTS };
