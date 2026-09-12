/* ═══════════════════════════════════════════════════════════════════════════
   Path traces — WHERE between the monitor and a server the traffic stops

   2026-09-12: for 14 minutes the monitor could not reach streams.pacifica.org
   while its stations played for everyone else. Nothing recorded the route, so
   "which network failed" could never be answered — only guessed. This runs a
   route trace from the monitor's own host when a server stops answering, and a
   baseline once a day while it answers, so a failing route can be read against
   a working one hop by hop.

   mtr in TCP mode to the stream port: a listener's connection is TCP to that
   port, and many networks drop the ICMP/UDP a classic traceroute sends, which
   would show a healthy path as broken. The image grants mtr-packet NET_RAW (see
   the Dockerfile); where mtr is absent — a laptop, say — the trace records that
   plainly rather than failing silently.
   ═══════════════════════════════════════════════════════════════════════════ */

const { execFile } = require('child_process');

const TRACE_TIMEOUT_MS = 90 * 1000;
const TRACE_CYCLES = Math.max(1, parseInt(process.env.PATH_TRACE_CYCLES, 10) || 5);

/** Splits "host:port" (or a bare host) into the target mtr needs. */
function targetOf(host) {
  const m = String(host || '').match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  if (!m) return null;
  return { name: m[1], port: m[2] ? parseInt(m[2], 10) : 443 };
}

/**
 * mtr --json output → the fields a person reads. Hops keep mtr's order; a hop
 * that never answered is host "???" with 100% loss, and is kept — a run of those
 * at the end of a trace is exactly where the path died.
 */
function parseMtrJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  const hubs = doc?.report?.hubs;
  if (!Array.isArray(hubs)) return null;
  return hubs.map((h) => ({
    hop: h.count,
    host: h.host,
    lossPct: typeof h['Loss%'] === 'number' ? h['Loss%'] : null,
    sent: h.Snt ?? null,
    avgMs: h.Avg ?? null,
    bestMs: h.Best ?? null,
    worstMs: h.Wrst ?? null,
  }));
}

/**
 * Where did it stop? The last hop that answered at all, and whether the target
 * itself was reached. A trace whose final answering hop is inside the server's
 * own network reads very differently from one that dies at the monitor's edge.
 */
function summarise(hops, targetName) {
  if (!hops || !hops.length) return { reachedTarget: false, lastAnsweringHop: null };
  const answering = hops.filter((h) => h.host && h.host !== '???' && (h.lossPct ?? 100) < 100);
  const last = answering.at(-1) || null;
  const final = hops.at(-1);
  // With --no-dns an IP target comes back as that IP, so the final hop can be
  // matched exactly; a hostname target cannot, and answering is the test.
  const targetIsIp = /^\d+\.\d+\.\d+\.\d+$/.test(String(targetName || ''));
  const reachedTarget = !!final && final.host !== '???' && (final.lossPct ?? 100) < 100
    && (!targetIsIp || final.host === targetName);
  return {
    reachedTarget,
    lastAnsweringHop: last ? { hop: last.hop, host: last.host, lossPct: last.lossPct, avgMs: last.avgMs } : null,
    finalLossPct: final?.lossPct ?? null,
  };
}

/**
 * Runs one trace. Never throws: every outcome, including "tool not installed",
 * comes back as a record, because a trace that failed to run is itself
 * something the incident page has to be able to say.
 *
 * `run` is injectable for tests; production uses execFile.
 */
function runTrace(host, { reason = 'manual', run = execFile, resolvedIp = null } = {}) {
  const target = targetOf(host);
  const startedAt = new Date().toISOString();
  const base = { host, reason, startedAt, tool: 'mtr', mode: 'tcp', port: target?.port ?? null };
  if (!target) return Promise.resolve({ ...base, ok: false, error: 'unparseable host', finishedAt: startedAt });

  const args = ['--tcp', '--port', String(target.port), '--report-cycles', String(TRACE_CYCLES),
    '--json', '--no-dns', resolvedIp || target.name];

  return new Promise((resolve) => {
    run('mtr', args, { timeout: TRACE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const finishedAt = new Date().toISOString();
      if (err && err.code === 'ENOENT') {
        return resolve({ ...base, ok: false, finishedAt, error: 'mtr is not installed on this host' });
      }
      const hops = parseMtrJson(stdout || '');
      if (!hops) {
        return resolve({
          ...base, ok: false, finishedAt,
          error: (String(stderr || '').trim() || err?.message || 'mtr produced no report').slice(0, 300),
        });
      }
      resolve({ ...base, ok: true, finishedAt, target: resolvedIp || target.name, hops, ...summarise(hops, resolvedIp || target.name) });
    });
  });
}

module.exports = { runTrace, parseMtrJson, summarise, targetOf, TRACE_CYCLES };
