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
// Other ports on the same address, tried alongside the stream port. If the
// server answers on these but not on the stream port, something is filtering
// that port for this monitor — a block, not a broken route.
const COMPARE_PORTS = [80, 443];
const COMPARE_ATTEMPTS = 2;
// Far above what the monitor needs (7 at startup, 2026-09-12). Above this the
// monitor itself is the suspect.
const SOCKET_LEAK_THRESHOLD = 200;
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
  // The same address on other ports, for the block-vs-route question.
  const otherPorts = [];
  for (const port of COMPARE_PORTS.filter((p) => p !== target?.port)) {
    const tries = [];
    for (let i = 0; i < COMPARE_ATTEMPTS; i++) tries.push(await connect(address, port));
    otherPorts.push({ port, connected: tries.filter((t) => t.ok).length, attempts: tries.length, errors: tries.filter((t) => !t.ok).map((t) => t.error) });
  }
  result.otherPorts = otherPorts;

  const okTimes = tcp.filter((t) => t.ok).map((t) => t.ms);
  result.tcp = {
    attempts: tcp,
    succeeded: okTimes.length,
    failed: tcp.length - okTimes.length,
    medianMs: okTimes.length ? okTimes.sort((a, b) => a - b)[Math.floor(okTimes.length / 2)] : null,
  };

  if (withTrace) result.trace = await trace(host, { reason: 'network-test', resolvedIp: address });

  const c = classify(result);
  result.kind = c.kind;
  result.verdict = c.sentence;
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * What failed, and whose it is — the question 2026-09-12 could not answer.
 *
 *   healthy          route fine; any stream failure is an HTTP answer from the server
 *   dns              the name does not resolve from here
 *   refused          connections actively refused/reset — something rejects us
 *   port_blocked     the server answers on another port but not the stream port
 *   dropped_target   nothing answers; the route dies inside the server's network
 *   dropped_source   ...inside the monitor's own provider
 *   dropped_transit  ...inside a network between them
 *   lossy            the route reaches the server, but connections fail or crawl
 *   unreachable      nothing answers and the route could not be attributed
 */
function classify(r) {
  const tr = r.trace;
  const label = (n) => pathTrace.networkLabel(n);
  if (r.dns && !r.dns.ok) {
    return { kind: 'dns', sentence: `The name ${r.host} does not resolve from the monitor (${r.dns.error}).` };
  }
  const attempts = r.tcp?.attempts || [];
  const failed = attempts.filter((a) => !a.ok);
  const tcpBad = failed.length > 0;
  const tcpSlow = r.tcp?.medianMs != null && r.tcp.medianMs > 1000;
  const statusBad = r.status && !r.status.ok;
  const streamBad = r.stream && !r.stream.ok && r.stream.httpStatus == null;

  if (!tcpBad && !tcpSlow && !statusBad && !streamBad) {
    return {
      kind: 'healthy',
      sentence: r.stream && !r.stream.ok
        ? `The route from the monitor is healthy; the server answered the stream with HTTP ${r.stream.httpStatus}.`
        : 'The route from the monitor to this server is healthy.',
    };
  }

  const symptoms = [];
  if (tcpBad) symptoms.push(`${failed.length} of ${attempts.length} connections to port ${pathTrace.targetOf(r.host)?.port} failed`);
  if (tcpSlow) symptoms.push(`connections took ${r.tcp.medianMs}ms (normal is well under 200ms)`);
  if (statusBad) symptoms.push(`the status page did not answer (${r.status.error})`);
  if (streamBad) symptoms.push(`the stream did not answer (${r.stream.error})`);
  const lead = `From the monitor's own host: ${symptoms.join('; ')}.`;

  const refused = failed.filter((a) => /ECONNREFUSED|ECONNRESET/.test(a.error || ''));
  if (refused.length && refused.length === failed.length) {
    return { kind: 'refused', sentence: `${lead} The server's side is ACTIVELY REFUSING the monitor (${refused[0].error}) — a firewall or the server itself is rejecting these connections.` };
  }

  const streamPortDead = attempts.length > 0 && failed.length === attempts.length;
  const answeringOther = (r.otherPorts || []).filter((p) => p.connected > 0);
  if (streamPortDead && answeringOther.length) {
    return { kind: 'port_blocked', sentence: `${lead} The same server DOES answer on port ${answeringOther.map((p) => p.port).join(' and ')}, so the machine is reachable but the stream port is not — a filter on the server's side is BLOCKING the stream port for this monitor.` };
  }

  if (tr?.ok && !tr.reachedTarget) {
    const hop = tr.lastAnsweringHop;
    const at = hop ? `hop ${hop.hop} (${hop.host}, ${label(hop.network)})` : 'the first hop';
    if (tr.stopsIn === 'target') return { kind: 'dropped_target', sentence: `${lead} Nothing answers, and the route dies at ${at} — INSIDE THE SERVER'S OWN NETWORK, ${label(tr.targetNetwork)}. The fault is on the server's side.` };
    if (tr.stopsIn === 'source') return { kind: 'dropped_source', sentence: `${lead} The route dies at ${at} — INSIDE THE MONITOR'S OWN PROVIDER, ${label(tr.sourceNetwork)}. The fault is on the monitor's side.` };
    if (tr.stopsIn === 'transit') return { kind: 'dropped_transit', sentence: `${lead} The route dies at ${at} — in a network BETWEEN the monitor (${label(tr.sourceNetwork)}) and the server (${label(tr.targetNetwork)}).` };
    return { kind: 'unreachable', sentence: `${lead} The route stops after ${at}; its owner could not be identified.` };
  }
  if (tr?.ok && tr.reachedTarget) {
    return { kind: 'lossy', sentence: `${lead} The route trace does reach the server (${label(tr.targetNetwork)}), so packets are getting there but being lost or delayed — congestion or rate limiting near the server.` };
  }
  return { kind: 'unreachable', sentence: `${lead}${tr && !tr.ok ? ` The route trace could not run: ${tr.error}.` : ' No route trace was taken in this test.'}` };
}

/** The finding, in one sentence a person can act on. */
function verdictFor(r) {
  return classify(r).sentence;
}

/**
 * The whole battery for every host, in parallel (they are different servers).
 * `hosts` is [{ host, statusUrl, stream }].
 */
async function runNetworkTest(hosts, { reason = 'manual', deps } = {}) {
  const startedAt = new Date().toISOString();
  const before = processState();
  const results = await Promise.all(hosts.map((h) => testHost(h, deps)));
  const sockets = before.openSockets ?? before.activeHandles;
  const processVerdict = sockets != null && sockets > SOCKET_LEAK_THRESHOLD
    ? `The monitor itself holds ${sockets} open connections — far above normal. Suspect a connection leak in the monitor before blaming the network.`
    : null;
  return { reason, startedAt, finishedAt: new Date().toISOString(), process: { ...before, verdict: processVerdict }, hosts: results };
}

module.exports = { runNetworkTest, testHost, tcpConnect, processState, verdictFor, classify, TCP_ATTEMPTS, COMPARE_PORTS, SOCKET_LEAK_THRESHOLD };
