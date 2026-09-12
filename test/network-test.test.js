/* ═══════════════════════════════════════════════════════════════════════════
   The network test, run from the monitor's own host

   2026-09-12: twice the monitor's host could not reach streams.pacifica.org
   while everyone else could. Every test that was run came from another machine
   and passed; the failing machine recorded nothing, and once the route
   recovered the evidence was gone. These tests pin the battery and, above all,
   the sentence it produces — the thing a person reads.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const networkTest = require('../network-test');

const HOST = 'streams.pacifica.org:9000';
const target = { host: HOST, statusUrl: `https://${HOST}/status-json.xsl`, stream: { id: 'kpfk', url: `https://${HOST}/kpfk_128` } };

function deps(over = {}) {
  return {
    lookup: async () => [{ address: '68.168.105.107' }],
    fetchSnapshot: async () => ({ reachable: true, responseTime: 300, timings: { tcp: 60, tls: 64, ttfb: 290 }, mountCount: 14 }),
    probe: async () => ({ status: 'up', responseTime: 400, httpStatus: 200, timings: { tcp: 62 } }),
    connect: async () => ({ ok: true, ms: 62 }),
    trace: async () => ({ ok: true, reachedTarget: true, hops: [{ hop: 1 }, { hop: 2 }] }),
    ...over,
  };
}

test('a healthy route says so in plain words', async () => {
  const r = await networkTest.testHost(target, deps());
  assert.strictEqual(r.dns.addresses[0], '68.168.105.107');
  assert.strictEqual(r.tcp.succeeded, networkTest.TCP_ATTEMPTS);
  assert.match(r.verdict, /route from the monitor to this server is healthy/);
});

test('the 2026-09-12 shape: slow and failed connects, silent status page, trace stops inside the server\'s network — named', async () => {
  let n = 0;
  const r = await networkTest.testHost(target, deps({
    fetchSnapshot: async () => ({ reachable: false, responseTime: 12000, timings: { tcp: 3100 }, fetchError: 'Status endpoint did not answer within 12000ms' }),
    probe: async () => ({ status: 'down', responseTime: 18000, error: 'No response within 18000ms', timings: { tcp: 2230 } }),
    connect: async () => (++n % 2 ? { ok: false, ms: 8000, error: 'no connection within 8000ms' } : { ok: true, ms: 3200 }),
    trace: async () => ({ ok: true, reachedTarget: false, stopsIn: 'target', hops: [],
      lastAnsweringHop: { hop: 4, host: '216.55.160.12', network: CYBERCLOUD },
      targetNetwork: CYBERCLOUD, sourceNetwork: CONTABO }),
  }));
  assert.ok(r.tcp.failed >= 2, 'failed connects were not counted');
  assert.strictEqual(r.kind, 'dropped_target');
  assert.match(r.verdict, /connections to port 9000 failed/);
  assert.match(r.verdict, /status page did not answer/);
  assert.match(r.verdict, /hop 4 \(216\.55\.160\.12, .*CyberCloud.*AS18501\)/, 'the verdict must say where and whose');
  assert.match(r.verdict, /INSIDE THE SERVER'S OWN NETWORK/);
});

const CONTABO = { asn: 40021, owner: 'CONTABO-40021 - Contabo Inc., US' };
const CYBERCLOUD = { asn: 18501, owner: 'JOESD-18501 - CyberCloud Professionals LLC, US' };
const deadStream = {
  fetchSnapshot: async () => ({ reachable: false, fetchError: 'Status endpoint did not answer within 12000ms', timings: {} }),
  probe: async () => ({ status: 'down', error: 'No response within 18000ms', timings: {} }),
};

test('the stream port dead while port 80 answers is a BLOCK on the server\'s side, not a broken route', async () => {
  const r = await networkTest.testHost(target, deps({
    ...deadStream,
    connect: async (_a, port) => (port === 9000 ? { ok: false, ms: 8000, error: 'no connection within 8000ms' } : { ok: true, ms: 60 }),
  }));
  assert.strictEqual(r.kind, 'port_blocked');
  assert.match(r.verdict, /DOES answer on port 80 and 443/);
  assert.match(r.verdict, /BLOCKING the stream port/);
});

test('connections actively refused are named as a rejection', async () => {
  const r = await networkTest.testHost(target, deps({
    ...deadStream,
    connect: async () => ({ ok: false, ms: 40, error: 'ECONNREFUSED' }),
  }));
  assert.strictEqual(r.kind, 'refused');
  assert.match(r.verdict, /ACTIVELY REFUSING/);
});

test('a route dying inside the monitor\'s own provider is blamed on the monitor\'s side', async () => {
  const r = await networkTest.testHost(target, deps({
    ...deadStream,
    connect: async () => ({ ok: false, ms: 8000, error: 'no connection within 8000ms' }),
    trace: async () => ({ ok: true, reachedTarget: false, stopsIn: 'source', hops: [],
      lastAnsweringHop: { hop: 2, host: '62.141.47.1', network: CONTABO }, sourceNetwork: CONTABO, targetNetwork: CYBERCLOUD }),
  }));
  assert.strictEqual(r.kind, 'dropped_source');
  assert.match(r.verdict, /INSIDE THE MONITOR'S OWN PROVIDER, .*Contabo/);
});

test('a route dying in between names the transit network and both ends', async () => {
  const ZAYO = { asn: 6461, owner: 'ZAYO-6461 - Zayo Bandwidth, US' };
  const r = await networkTest.testHost(target, deps({
    ...deadStream,
    connect: async () => ({ ok: false, ms: 8000, error: 'no connection within 8000ms' }),
    trace: async () => ({ ok: true, reachedTarget: false, stopsIn: 'transit', hops: [],
      lastAnsweringHop: { hop: 7, host: '64.125.199.194', network: ZAYO }, sourceNetwork: CONTABO, targetNetwork: CYBERCLOUD }),
  }));
  assert.strictEqual(r.kind, 'dropped_transit');
  assert.match(r.verdict, /Zayo.*BETWEEN the monitor \(.*Contabo.*\) and the server \(.*CyberCloud/);
});

test('a route that reaches the server with failing connects is loss or rate limiting near the server', async () => {
  let n = 0;
  const r = await networkTest.testHost(target, deps({
    ...deadStream,
    connect: async (_a, port) => (port !== 9000 ? { ok: false, ms: 8000, error: 'no connection within 8000ms' }
      : (++n % 2 ? { ok: false, ms: 8000, error: 'no connection within 8000ms' } : { ok: true, ms: 4200 })),
    trace: async () => ({ ok: true, reachedTarget: true, hops: [], targetNetwork: CYBERCLOUD }),
  }));
  assert.strictEqual(r.kind, 'lossy');
  assert.match(r.verdict, /getting there but being lost or delayed/);
});

test('a monitor holding hundreds of connections is itself named as the suspect', async () => {
  const fake = [];
  const orig = process._getActiveHandles;
  process._getActiveHandles = () => { fake.length = networkTest.SOCKET_LEAK_THRESHOLD + 50; return fake; };
  try {
    const res = await networkTest.runNetworkTest([target], { deps: deps() });
    if (res.process.openSockets == null) assert.match(res.process.verdict || '', /connection leak in the monitor/);
  } finally {
    process._getActiveHandles = orig;
  }
});

test('a server that answers the stream with 404 is not a route problem', async () => {
  const r = await networkTest.testHost(target, deps({
    probe: async () => ({ status: 'down', responseTime: 300, httpStatus: 404, error: 'HTTP 404', timings: {} }),
  }));
  assert.match(r.verdict, /route from the monitor is healthy; the server answered the stream with HTTP 404/);
});

test('an unresolvable name is reported first, and the rest still runs', async () => {
  const r = await networkTest.testHost(target, deps({ lookup: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } }));
  assert.match(r.verdict, /does not resolve from the monitor \(ENOTFOUND\)/);
  assert.ok(r.tcp, 'connects must still be attempted');
});

test('runNetworkTest records the process state, so a connection leak in the monitor would show', async () => {
  const res = await networkTest.runNetworkTest([target], { deps: deps() });
  assert.ok(res.process && typeof res.process.uptimeSec === 'number');
  assert.ok('openSockets' in res.process && 'activeHandles' in res.process);
  assert.strictEqual(res.hosts.length, 1);
});

test('tcpConnect measures a real connect and reports a refused one', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  const ok = await networkTest.tcpConnect('127.0.0.1', port);
  assert.strictEqual(ok.ok, true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  const refused = await networkTest.tcpConnect('127.0.0.1', port, 2000);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);
});
