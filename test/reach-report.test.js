/* ═══════════════════════════════════════════════════════════════════════════
   Whose feeds dropped while the monitor could not see the server

   2026-09-12, 22:11–22:27 UTC: the monitor lost streams.pacifica.org. Telling
   the real outages from the false ones took reading, by hand, when each encoder
   last connected: KPFT's and WPFW's reconnected at 22:27:50 and 22:25:21, KPFK's
   had been connected since 2026-09-06. The monitor restarted in the middle of it.
   This replays that window, restart included, and requires the app to write
   the same finding itself.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-report-'));
process.env.SEED_FILE = '/nonexistent';

const HOST = 'streams.example.org:9000';

function boot() {
  for (const m of ['../monitor', '../store', '../diagnose']) delete require.cache[require.resolve(m)];
  return { store: require('../store'), diagnose: require('../diagnose'), monitor: require('../monitor') };
}

let { store, diagnose, monitor } = boot();
store.load();
const channel = (id, name) => ({ id, name, timezone: 'UTC', alerts: { enabled: false, recipients: [] },
  channels: [{ id, name, url: `https://${HOST}/${id}_128`, mounts: [`/${id}_128`] }] });
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  stations: [channel('kpft', 'KPFT Main'), channel('wpfw', 'WPFW'), channel('kpfk', 'KPFK')],
});
monitor.reloadConfig();

const OLD = '2026-09-06T20:44:50Z';
const mount = (id, listeners, streamStart) => ({ pathname: `/${id}_128`, listeners, streamStart });

async function cycle({ reachable, mounts = {} }) {
  const realSnap = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: reachable ? { reachable: true, mountCount: Object.keys(mounts).length, mounts }
      : { reachable: false, fetchError: 'Status endpoint did not answer within 12000ms', mounts: {}, mountCount: 0 } },
    hosts: [HOST], reachable, mounts: {}, mountCount: 0,
    servers: [{ host: HOST, reachable, fetchError: reachable ? null : 'timeout', timings: {} }],
  });
  diagnose.probeStream = async () => (reachable
    ? { status: 'up', responseTime: 300, isSilent: false, audioEnergy: 9, timings: {} }
    : { status: 'down', responseTime: 18000, error: 'No response within 18000ms', errorCode: 'EDEADLINE', timings: { tcp: 2230 } });
  try { await monitor.runChecks(); } finally {
    diagnose.fetchHostSnapshots = realSnap;
    diagnose.probeStream = realProbe;
  }
}

test('the 2026-09-12 window, restart included: KPFT and WPFW dropped, KPFK held — written by the app', async () => {
  monitor._setTraceRunner(async (host, { reason }) => ({ host, reason, startedAt: new Date().toISOString(), ok: false, error: 'stubbed' }));

  await cycle({ reachable: true, mounts: { '/kpft_128': mount('kpft', 37, OLD), '/wpfw_128': mount('wpfw', 77, OLD), '/kpfk_128': mount('kpfk', 154, OLD) } });
  for (let i = 0; i < 3; i++) await cycle({ reachable: false });

  // The monitor restarts while the server is still out of sight.
  store.save(true);
  ({ store, diagnose, monitor } = boot());
  monitor._init();
  monitor._setTraceRunner(async (host, { reason }) => ({ host, reason, startedAt: new Date().toISOString(), ok: false, error: 'stubbed' }));
  await cycle({ reachable: false });

  const reconnected = new Date(Date.now() + 1000).toISOString();
  await cycle({ reachable: true, mounts: { '/kpft_128': mount('kpft', 12, reconnected), '/wpfw_128': mount('wpfw', 33, reconnected), '/kpfk_128': mount('kpfk', 168, OLD) } });

  const [report] = store.getReachReports();
  assert.ok(report, 'no report was written when the server came back');
  assert.strictEqual(report.kind, 'partial');
  const state = Object.fromEntries(report.channels.map((c) => [c.name, c.state]));
  assert.deepStrictEqual(state, { 'KPFT Main': 'dropped', WPFW: 'dropped', KPFK: 'held' });
  assert.match(report.summary, /KPFT Main \(37 → 12 listeners\), WPFW \(77 → 33 listeners\) ALSO lost their connection/);
  assert.match(report.summary, /KPFK \(154 → 168 listeners\) stayed connected throughout/);

  const kpfkEvent = store.getEvents({ streamId: 'kpfk', type: 'down' }).events[0];
  assert.strictEqual(kpfkEvent.reachReport?.id, report.id, 'the finding must be attached to the incidents it explains');
  monitor._setTraceRunner(null);
});

test('every feed held: only the monitor lost the server — the stations were on air', () => {
  const r = monitor._buildReachReport(HOST,
    { since: '2026-09-12T22:11:39Z', before: { at: '2026-09-12T22:10:39Z', mounts: { '/kpfk_128': { streamStart: OLD, listeners: 154 } } } },
    { reachable: true, mounts: { '/kpfk_128': mount('kpfk', 168, OLD) } },
    '2026-09-12T22:27:14Z');
  assert.strictEqual(r.kind, 'monitor_only');
  assert.match(r.summary, /Only the monitor lost .* every feed stayed connected/);
});

test('every feed dropped: the server or its network dropped everything', () => {
  const r = monitor._buildReachReport(HOST,
    { since: '2026-09-12T22:11:39Z', before: { at: '2026-09-12T22:10:39Z', mounts: { '/kpfk_128': { streamStart: OLD, listeners: 154 } } } },
    { reachable: true, mounts: { '/kpfk_128': mount('kpfk', 3, '2026-09-12T22:26:00Z') } },
    '2026-09-12T22:27:14Z');
  assert.strictEqual(r.kind, 'all_dropped');
});
