/* ═══════════════════════════════════════════════════════════════════════════
   "Can't reach the server" is not "the station is down"

   2026-09-12, twice (20:52 and 22:15 UTC): the monitor could not reach
   streams.pacifica.org. Every stream on it timed out and the status page did not
   answer. The dashboard showed KPFK OFFLINE and emailed KPFK and KPFT — while
   both played normally from everywhere else.

   Rule: a station is shown down and emailed only on evidence about its OWN feed.
   While its server cannot be seen, a failing stream is unconfirmed: recorded,
   not an outage, not emailed. When the server answers, each station is settled
   on its own evidence — and only a station whose feed really dropped is emailed.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unreachable-hold-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const diagnose = require('../diagnose');
const monitor = require('../monitor');

store.load();

const HOST = 'streams.example.org:9000';
const station = (id) => ({
  id, name: id, timezone: 'UTC', alerts: { enabled: true, recipients: [`gm@${id}.example.org`] },
  channels: [{ id, name: id, url: `https://${HOST}/${id}_128`, mounts: [`/${id}_128`] }],
});
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  stations: [station('held'), station('dropped')],
});
monitor.reloadConfig();

const t0 = Date.now();
const iso = (mins) => new Date(t0 + mins * 60000).toISOString();

/** One check cycle. `server`: 'up' (with the given mounts) or 'unreachable'. */
async function cycle({ server, mounts = {}, probes }) {
  const realSnap = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  const reachable = server === 'up';
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: reachable
      ? { reachable: true, mountCount: Object.keys(mounts).length, mounts }
      : { reachable: false, fetchError: 'Status endpoint did not answer within 12000ms', mounts: {}, mountCount: 0 } },
    hosts: [HOST], servers: [], reachable, mounts: {}, mountCount: 0,
  });
  diagnose.probeStream = async (s) => (probes[s.id] === 'up'
    ? { status: 'up', responseTime: 300, isSilent: false, audioEnergy: 9, timings: {} }
    : probes[s.id] === '404'
    ? { status: 'down', responseTime: 300, httpStatus: 404, error: 'HTTP 404', errorCode: 'HTTP_404', timings: {} }
    : { status: 'down', responseTime: 18000, error: 'No response within 18000ms', errorCode: 'EDEADLINE', timings: { tcp: 2230 } });
  try { await monitor.runChecks(); } finally {
    diagnose.fetchHostSnapshots = realSnap;
    diagnose.probeStream = realProbe;
  }
}

test('an unreachable server marks its streams unconfirmed and emails nobody; on return only a real drop is emailed', async () => {
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });

  // A healthy cycle first, so the server is known to have a status page.
  const healthy = {
    '/held_128': { pathname: '/held_128', listeners: 100, streamStart: iso(-600) },
    '/dropped_128': { pathname: '/dropped_128', listeners: 50, streamStart: iso(-600) },
  };
  await cycle({ server: 'up', mounts: healthy, probes: { held: 'up', dropped: 'up' } });

  // Six cycles with the server out of sight and every probe timing out.
  for (let i = 0; i < 6; i++) await cycle({ server: 'unreachable', probes: { held: 'timeout', dropped: 'timeout' } });

  const status = monitor.getStatus().streams || monitor.getStatus();
  const byId = Object.fromEntries((Array.isArray(status) ? status : []).map((s) => [s.id, s]));
  for (const id of ['held', 'dropped']) {
    assert.strictEqual(byId[id]?.unconfirmed, true, `${id}: shown as a confirmed failure while its server could not be seen`);
    const ev = store.getEvents({ streamId: id, type: 'down' }).events[0];
    assert.notStrictEqual(ev.severity, 'outage', `${id}: promoted to an outage with no evidence about its feed`);
    assert.doesNotMatch(ev.message, /is DOWN/, `${id}: recorded as DOWN with no evidence`);
    assert.strictEqual(ev.awaitingEvidence, true);
  }
  assert.strictEqual(sent.length, 0, `emailed while the server could not be seen: ${sent.map((m) => m.subject).join(' | ')}`);

  // The server answers. "held" never dropped (source connected long before);
  // "dropped" reconnected during the gap — its feed really went.
  const after = {
    '/held_128': { pathname: '/held_128', listeners: 110, streamStart: iso(-600) },
    '/dropped_128': { pathname: '/dropped_128', listeners: 5, streamStart: new Date().toISOString() },
  };
  await cycle({ server: 'up', mounts: after, probes: { held: 'up', dropped: 'up' } });

  const held = store.getEvents({ streamId: 'held', type: 'down' }).events[0];
  const dropped = store.getEvents({ streamId: 'dropped', type: 'down' }).events[0];
  assert.strictEqual(held.severity, 'probe_error', 'a station whose feed held was left looking like an outage');
  assert.strictEqual(dropped.severity, 'outage', 'a station whose feed really dropped was not confirmed');

  const subjects = sent.map((m) => m.subject);
  assert.ok(subjects.some((s) => /dropped/.test(s)), `the station that really dropped was not emailed: ${subjects}`);
  assert.ok(!subjects.some((s) => /held/.test(s)), `the station that stayed on air was emailed: ${subjects}`);

  monitor._setTransporter(null);
});

test('a server that is reachable still alerts immediately on a missing mount', async () => {
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });
  const mounts = { '/held_128': { pathname: '/held_128', listeners: 100, streamStart: iso(-600) } };
  for (let i = 0; i < 3; i++) await cycle({ server: 'up', mounts, probes: { held: 'up', dropped: '404' } });
  assert.ok(sent.some((m) => /dropped/.test(m.subject) && /DOWN|UNSTABLE/.test(m.subject)),
    `an ordinary source drop on a reachable server must still email at once: ${sent.map((m) => m.subject)}`);
  monitor._setTransporter(null);
});
