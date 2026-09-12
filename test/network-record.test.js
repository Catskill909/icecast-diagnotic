/* ═══════════════════════════════════════════════════════════════════════════
   The network record: every check keeps its connection phases

   On 2026-09-12 the monitor could not reach streams.pacifica.org for 14 minutes
   while the stations played. Afterwards there was no record of WHICH stage was
   failing — DNS, TCP connect, TLS, or the server's reply — nor when it began to
   slow, because the status fetch kept only a total and the stream samples kept
   none. Every cycle now records both, per server and per stream.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'netrecord-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const diagnose = require('../diagnose');
const monitor = require('../monitor');

store.load();

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('a status fetch reports its connection phases, success or failure', async () => {
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ icestats: { server_id: 'Icecast 2.4.3', source: [] } }));
  });
  const { port } = srv.address();
  try {
    const snap = await diagnose.fetchHostSnapshots([{ host: `localhost:${port}`, statusUrl: `http://localhost:${port}/status-json.xsl` }]);
    const sv = snap.servers[0];
    assert.strictEqual(sv.reachable, true);
    assert.ok(sv.timings.tcp != null, 'TCP connect time missing from a successful fetch');
    assert.ok(sv.timings.ttfb != null, 'first-byte time missing from a successful fetch');
    assert.ok(sv.timings.dns != null, 'a hostname lookup was not timed');
  } finally {
    srv.close();
  }

  // A port nothing listens on: the failure still says how far it got.
  const dead = await diagnose.fetchHostSnapshots([{ host: `localhost:${port}`, statusUrl: `http://localhost:${port}/status-json.xsl` }]);
  assert.strictEqual(dead.servers[0].reachable, false);
  assert.ok(dead.servers[0].timings, 'a failed fetch must still carry its timings object');
  assert.strictEqual(dead.servers[0].timings.ttfb, undefined, 'no reply, so no first byte');
});

test('each check cycle writes one network row per server and phases on every stream sample', async () => {
  const HOST = 'stream.example.org:9000';
  store.setStationConfig({
    version: 1,
    hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
    stations: [{ id: 'st', name: 'St', timezone: 'UTC', alerts: { enabled: false, recipients: [] },
      channels: [{ id: 'ch', name: 'Ch', url: `https://${HOST}/ch_128`, mounts: ['/ch_128'] }] }],
  });
  monitor.reloadConfig();

  const realSnap = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: { reachable: false, fetchError: 'Status endpoint timed out', mounts: {}, mountCount: 0 } },
    hosts: [HOST], reachable: false, mounts: {}, mountCount: 0,
    servers: [{ host: HOST, reachable: false, fetchError: 'Status endpoint timed out', responseTime: 12000,
      attempts: 3, timings: { dns: 4, tcp: 3100, ip: '68.168.105.107' } }],
  });
  diagnose.probeStream = async () => ({
    status: 'down', responseTime: 18000, error: 'No response within 18000ms', errorCode: 'EDEADLINE',
    timings: { dns: 7, tcp: 9774, tls: 1014 },
  });
  try {
    await monitor.runChecks();
  } finally {
    diagnose.fetchHostSnapshots = realSnap;
    diagnose.probeStream = realProbe;
  }

  const rows = store.getNetSamples(HOST)[HOST];
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(
    { ok: rows[0].ok, tcp: rows[0].tcp, tls: rows[0].tls, ttfb: rows[0].ttfb, n: rows[0].n, ip: rows[0].ip, err: rows[0].err },
    { ok: false, tcp: 3100, tls: null, ttfb: null, n: 3, ip: '68.168.105.107', err: 'Status endpoint timed out' },
  );

  const sample = store.getSamples('ch').at(-1);
  assert.deepStrictEqual(sample.tm, [7, 9774, 1014, null], 'the stream sample lost its connection phases');
});
