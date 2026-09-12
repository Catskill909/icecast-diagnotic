/* ═══════════════════════════════════════════════════════════════════════════
   Deployed while the server was already unreachable

   2026-09-12, 22:24 UTC: the "can't reach the server is not down" fix went live
   while streams.pacifica.org was unreachable. The fix only held alerts for a
   server it had SEEN answer, and it had seen nothing since starting — so every
   Pacifica station was still called DOWN. The history already proved the status
   page existed; it was not consulted.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unreachable-first-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const diagnose = require('../diagnose');
const monitor = require('../monitor');

store.load();

const HOST = 'streams.example.org:9000';
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  stations: [
    { id: 'kpfk', name: 'KPFK', timezone: 'UTC', alerts: { enabled: true, recipients: ['gm@kpfk.example.org'] },
      channels: [{ id: 'kpfk', name: 'KPFK', url: `https://${HOST}/kpfk_128`, mounts: ['/kpfk_128'] }] },
    { id: 'nopage', name: 'NoPage', timezone: 'UTC', alerts: { enabled: true, recipients: ['gm@nopage.example.org'] },
      channels: [{ id: 'nopage', name: 'NoPage', url: 'https://nostatus.example.org/live', mounts: ['/live'] }] },
  ],
});
monitor.reloadConfig();

// History from before this build: a diagnosis that reached Pacifica's page.
store.addEvent({
  timestamp: new Date(Date.now() - 3600e3).toISOString(), streamId: 'kpfk', streamName: 'KPFK',
  type: 'down', severity: 'probe_error', resolvedAt: new Date(Date.now() - 3500e3).toISOString(), durationMs: 60000,
  diagnosis: { cause: 'connection_reset', icecast: { reachable: true, mountPresent: true } },
});

async function unreachableCycle() {
  const realSnap = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  diagnose.fetchHostSnapshots = async () => ({
    byHost: {
      [HOST]: { reachable: false, fetchError: 'Status endpoint did not answer within 12000ms', mounts: {}, mountCount: 0 },
      'nostatus.example.org': { reachable: false, fetchError: 'HTTP 404', mounts: {}, mountCount: 0 },
    },
    hosts: [HOST, 'nostatus.example.org'], servers: [], reachable: false, mounts: {}, mountCount: 0,
  });
  diagnose.probeStream = async () => ({ status: 'down', responseTime: 18000, error: 'No response within 18000ms', errorCode: 'EDEADLINE', timings: {} });
  try { await monitor.runChecks(); } finally {
    diagnose.fetchHostSnapshots = realSnap;
    diagnose.probeStream = realProbe;
  }
}

test('a server unreachable from the very first cycle is still held, when history shows it has a status page', async () => {
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });
  for (let i = 0; i < 4; i++) await unreachableCycle();

  const kpfk = monitor.getStatus().find((s) => s.id === 'kpfk');
  assert.strictEqual(kpfk.unconfirmed, true, 'KPFK was called DOWN because the monitor had not yet seen its server answer since starting');
  assert.ok(!sent.some((m) => /KPFK/.test(m.subject)), `KPFK was emailed: ${sent.map((m) => m.subject)}`);

  // A server with no status page anywhere in the record keeps the old behaviour:
  // there is no evidence that will ever arrive to wait for.
  const nopage = monitor.getStatus().find((s) => s.id === 'nopage');
  assert.notStrictEqual(nopage.unconfirmed, true);
  assert.ok(sent.some((m) => /NoPage/.test(m.subject)), 'a server with no status page must still alert');
  monitor._setTransporter(null);
});
