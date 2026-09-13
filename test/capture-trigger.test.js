/* ═══════════════════════════════════════════════════════════════════════════
   Evidence capture starts at the first sign, not when the status page gives up

   2026-09-12, 22:11:39 UTC: every stream on streams.pacifica.org got no answer
   while its status page still did. Capture was triggered only by the status
   page, which went silent at 22:15:44 — four minutes of the failure unrecorded.
   Streams getting NO answer on the same server now trigger it too. A 404 is the
   server answering, and never does.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-trigger-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const diagnose = require('../diagnose');
const monitor = require('../monitor');

store.load();
const HOST = 'streams.example.org:9000';
const OLD = '2026-09-06T20:44:50Z';
const ids = ['kpft', 'wpfw', 'kpfk'];
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  stations: ids.map((id) => ({ id, name: id.toUpperCase(), timezone: 'UTC', alerts: { enabled: false, recipients: [] },
    channels: [{ id, name: id.toUpperCase(), url: `https://${HOST}/${id}_128`, mounts: [`/${id}_128`] }] })),
});
monitor.reloadConfig();

const TIMEOUT = { status: 'down', responseTime: 18000, error: 'No response within 18000ms', errorCode: 'EDEADLINE', timings: { tcp: 2230 } };
const UP = { status: 'up', responseTime: 300, isSilent: false, audioEnergy: 9, timings: {} };
const NOT_FOUND = { status: 'down', responseTime: 300, httpStatus: 404, error: 'HTTP 404', errorCode: 'HTTP_404', timings: {} };

async function cycle(probes, mounts) {
  const realSnap = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: { reachable: true, mountCount: Object.keys(mounts).length, mounts } },   // status page ANSWERS throughout
    hosts: [HOST], reachable: true, mounts: {}, mountCount: 0,
    servers: [{ host: HOST, reachable: true, timings: {} }],
  });
  diagnose.probeStream = async (s) => probes[s.id];
  try { await monitor.runChecks(); } finally {
    diagnose.fetchHostSnapshots = realSnap;
    diagnose.probeStream = realProbe;
  }
}

const allMounts = (start = OLD) => Object.fromEntries(ids.map((id) => [`/${id}_128`, { pathname: `/${id}_128`, listeners: 50, streamStart: start }]));

test('streams getting no answer while the status page answers start capture by the second cycle, and a report on recovery', async () => {
  const calls = [];
  monitor._resetTraceState();
  monitor._setTraceRunner(async (host, { reason }) => { calls.push(reason); return { host, reason, startedAt: new Date().toISOString(), ok: false, error: 'stubbed' }; });

  await cycle({ kpft: UP, wpfw: UP, kpfk: UP }, allMounts());
  calls.length = 0;   // ignore the startup baseline

  await cycle({ kpft: TIMEOUT, wpfw: TIMEOUT, kpfk: TIMEOUT }, allMounts());
  await cycle({ kpft: TIMEOUT, wpfw: TIMEOUT, kpfk: TIMEOUT }, allMounts());
  // Let the not-awaited trace jobs settle.
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.includes('unreachable'), `capture did not start while the status page still answered: ${calls}`);

  const reconnected = new Date(Date.now() + 1000).toISOString();
  const after = allMounts();
  after['/kpft_128'].streamStart = reconnected;
  await cycle({ kpft: UP, wpfw: UP, kpfk: UP }, after);

  const [report] = store.getReachReports();
  assert.ok(report, 'no whose-feeds-dropped report after a failure the status page never showed');
  assert.match(report.trigger, /3 of 3 streams got no answer/);
  assert.strictEqual(report.kind, 'partial');
  monitor._setTraceRunner(null);
});

test('one real 404 is the server answering — it never triggers capture', () => {
  const trouble = monitor._troubledHosts({ servers: [{ host: HOST, reachable: true }] }, [NOT_FOUND, UP, UP]);
  assert.strictEqual(trouble.size, 0);
});

test('a single stream getting no answer on a multi-stream server is not enough; two are', () => {
  const snap = { servers: [{ host: HOST, reachable: true }] };
  assert.strictEqual(monitor._troubledHosts(snap, [TIMEOUT, UP, UP]).size, 0);
  assert.match(monitor._troubledHosts(snap, [TIMEOUT, TIMEOUT, UP]).get(HOST), /2 of 3 streams got no answer/);
});
