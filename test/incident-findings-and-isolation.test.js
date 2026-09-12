/* ═══════════════════════════════════════════════════════════════════════════
   Two guarantees from 2026-09-12

   1. The incident page shows what the monitor found about the network — the
      automatic network test's verdict and the whose-feeds-dropped comparison —
      so the answer is on the incident, not in someone's memory.
   2. One station failing never changes another station's status. Asked
      directly that day ("could WPFW's real outage have spread?"); true by
      construction, pinned here so it stays true.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const vm = require('node:vm');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-isolation-'));
process.env.SEED_FILE = '/nonexistent';

test('the incident detail shows the network verdict and the feed comparison, escaped', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/event-detail.js'), 'utf8');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const html = ctx.window.EventDetail.render({
    type: 'down', severity: 'outage', timestamp: '2026-09-12T22:15:44Z',
    networkVerdict: { kind: 'dropped_target', sentence: "Nothing answers, and the route dies INSIDE THE SERVER'S OWN NETWORK <b>" },
    reachReport: { kind: 'partial', summary: 'KPFT Main (37 → 12 listeners) ALSO lost their connection' },
  });
  assert.match(html, /What the monitor found/);
  assert.match(html, /INSIDE THE SERVER&#39;S OWN NETWORK|INSIDE THE SERVER'S OWN NETWORK/);
  assert.match(html, /KPFT Main \(37 → 12 listeners\) ALSO lost/);
  assert.doesNotMatch(html, /<b>/, 'server-written text must be escaped');
});

test('one station failing never changes another station\'s status', async () => {
  const store = require('../store');
  const diagnose = require('../diagnose');
  const monitor = require('../monitor');
  store.load();
  const HOST = 'streams.example.org:9000';
  const st = (id) => ({ id, name: id, timezone: 'UTC', alerts: { enabled: false, recipients: [] },
    channels: [{ id, name: id, url: `https://${HOST}/${id}_128`, mounts: [`/${id}_128`] }] });
  store.setStationConfig({ version: 1, hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
    stations: [st('wpfw'), st('kpfk'), st('kpft')] });
  monitor.reloadConfig();

  const realSnap = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: { reachable: true, mountCount: 2, mounts: {
      '/kpfk_128': { pathname: '/kpfk_128', listeners: 150 }, '/kpft_128': { pathname: '/kpft_128', listeners: 40 } } } },
    hosts: [HOST], reachable: true, mounts: {}, mountCount: 2, servers: [{ host: HOST, reachable: true, timings: {} }],
  });
  // WPFW's encoder is gone for real; the others answer normally.
  diagnose.probeStream = async (s) => (s.id === 'wpfw'
    ? { status: 'down', responseTime: 300, httpStatus: 404, error: 'HTTP 404', errorCode: 'HTTP_404', timings: {} }
    : { status: 'up', responseTime: 300, isSilent: false, audioEnergy: 9, timings: {} });
  monitor._setTraceRunner(async (host, { reason }) => ({ host, reason, startedAt: new Date().toISOString(), ok: false, error: 'stubbed' }));
  try {
    for (let i = 0; i < 5; i++) await monitor.runChecks();
  } finally {
    diagnose.fetchHostSnapshots = realSnap;
    diagnose.probeStream = realProbe;
    monitor._setTraceRunner(null);
  }

  const status = Object.fromEntries(monitor.getStatus().map((s) => [s.id, s]));
  assert.strictEqual(status.wpfw.status, 'down');
  for (const id of ['kpfk', 'kpft']) {
    assert.strictEqual(status[id].status, 'up', `${id} changed because WPFW failed`);
    assert.strictEqual(store.getEvents({ streamId: id }).events.filter((e) => e.type === 'down').length, 0,
      `${id} got a failure record because WPFW failed`);
  }
});
