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
const dnsPromises = require('dns').promises;

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

// ── Who owns each hop ───────────────────────────────────────────────────────
// A hop's IP says little; its network's name says whose side a break is on.
// Team Cymru's public IP→ASN service over DNS: no account, no API key, one TXT
// query per address. Verified 2026-09-12: the monitor 144.126.148.20 is AS40021
// CONTABO; streams.pacifica.org 68.168.105.107 is AS18501 CyberCloud
// Professionals, as are the last routers before it (216.55.160.x).
const ASN_CACHE_MS = 24 * 60 * 60 * 1000;
const asnCache = new Map();   // key → { at, value }
const ASN_LOOKUP_TIMEOUT_MS = 3000;

function isPublicIpv4(ip) {
  const m = String(ip || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;   // carrier-grade NAT
  if (a === 169 && b === 254) return false;
  return true;
}

async function cachedTxt(name, resolveTxt) {
  const hit = asnCache.get(name);
  if (hit && Date.now() - hit.at < ASN_CACHE_MS) return hit.value;
  const value = await Promise.race([
    resolveTxt(name).then((r) => (r[0] ? r[0].join('') : null)).catch(() => null),
    new Promise((res) => setTimeout(() => res(null), ASN_LOOKUP_TIMEOUT_MS).unref?.()),
  ]);
  asnCache.set(name, { at: Date.now(), value });
  return value;
}

/** An IPv4 address → { asn, owner } or null. Never throws. */
async function lookupNetwork(ip, { resolveTxt = dnsPromises.resolveTxt } = {}) {
  if (!isPublicIpv4(ip)) return null;
  const origin = await cachedTxt(`${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`, resolveTxt);
  const asn = origin ? parseInt(origin.split('|')[0].trim().split(' ')[0], 10) : NaN;
  if (!Number.isFinite(asn)) return null;
  const desc = await cachedTxt(`AS${asn}.asn.cymru.com`, resolveTxt);
  const owner = desc ? desc.split('|').slice(4).join('|').trim() : null;
  return { asn, owner };
}

/** Adds `network` to every answering public hop, and names the endpoints. */
async function annotateNetworks(trace, opts = {}) {
  if (!trace?.ok || !Array.isArray(trace.hops)) return trace;
  await Promise.all(trace.hops.map(async (h) => {
    if (h.host && h.host !== '???') h.network = await lookupNetwork(h.host, opts);
  }));
  const firstPublic = trace.hops.find((h) => h.network);
  trace.sourceNetwork = opts.sourceIp ? await lookupNetwork(opts.sourceIp, opts) : (firstPublic?.network || null);
  trace.targetNetwork = trace.target ? await lookupNetwork(trace.target, opts) : null;
  if (trace.lastAnsweringHop) {
    const hop = trace.hops.find((h) => h.hop === trace.lastAnsweringHop.hop);
    trace.lastAnsweringHop.network = hop?.network || null;
  }
  trace.stopsIn = whereItStops(trace);
  return trace;
}

/**
 * 'target'  — the last answering hop is in the server's own network
 * 'source'  — in the monitor's own provider
 * 'transit' — in a network between them
 * null      — the trace reached the server, or there is no owner to compare
 */
function whereItStops(trace) {
  if (!trace?.ok || trace.reachedTarget) return null;
  const last = trace.lastAnsweringHop?.network?.asn;
  if (!last) return null;
  if (trace.targetNetwork?.asn && last === trace.targetNetwork.asn) return 'target';
  if (trace.sourceNetwork?.asn && last === trace.sourceNetwork.asn) return 'source';
  return 'transit';
}

const networkLabel = (n) => (n ? `${n.owner || 'unknown owner'} (AS${n.asn})` : 'an unidentified network');

/**
 * Runs one trace. Never throws: every outcome, including "tool not installed",
 * comes back as a record, because a trace that failed to run is itself
 * something the incident page has to be able to say.
 *
 * `run` is injectable for tests; production uses execFile.
 */
function runTrace(host, { reason = 'manual', run = execFile, resolvedIp = null, resolveTxt, sourceIp } = {}) {
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
      const trace = { ...base, ok: true, finishedAt, target: resolvedIp || target.name, hops, ...summarise(hops, resolvedIp || target.name) };
      annotateNetworks(trace, { ...(resolveTxt ? { resolveTxt } : {}), sourceIp })
        .catch(() => trace)
        .then(() => resolve(trace));
    });
  });
}

module.exports = {
  runTrace, parseMtrJson, summarise, targetOf, TRACE_CYCLES,
  lookupNetwork, annotateNetworks, whereItStops, networkLabel, isPublicIpv4,
  _clearAsnCache: () => asnCache.clear(),
};
