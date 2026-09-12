/* ═══════════════════════════════════════════════════════════════════════════
   One outage is counted toward a storm once, whether or not anyone is mailed

   On 2026-09-12 WPFW's source dropped once and stayed down. Its event read
   "suppressed — WPFW Washington DC is flapping (3 outages since 4:52:45 PM)".

   The storm counter is meant to run once per episode, and was gated on
   `episode.alerted`. Only dispatchNotifications() sets that flag, and it never
   sets it for a station with alerts switched off — so a muted station re-entered
   the counter on every cycle of a single outage: 'alert', 'declare', 'suppress'.
   The phantom storm is persisted, so switching the station's alerts on would
   have silenced its first genuine outage.

   Driven through full check cycles, because the defect was never in the
   counter — it was in what decides when to call it.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-once-'));
process.env.SEED_FILE = '/nonexistent';

const store = require('../store');
const diagnose = require('../diagnose');
const monitor = require('../monitor');

store.load();

const HOST = 'stream.example.org:9000';
const station = (id, enabled) => ({
  id, name: id, timezone: 'UTC',
  alerts: { enabled, recipients: [`gm@${id}.example.org`] },
  channels: [{ id, name: id, url: `https://${HOST}/${id}_128`, mounts: [`/${id}_128`] }],
});

store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  // A healthy third stream keeps this a per-stream fault, not a whole-server one.
  stations: [station('muted', false), station('loud', true), station('fine', true)],
});
monitor.reloadConfig();

async function cycles(n) {
  const realSnapshot = diagnose.fetchHostSnapshots;
  const realProbe = diagnose.probeStream;
  // Icecast reachable, the two failing mounts absent: a confirmed, listener-
  // impacting outage — the case that is alertable.
  diagnose.fetchHostSnapshots = async () => ({
    byHost: { [HOST]: { reachable: true, mountCount: 1, mounts: { '/fine_128': { pathname: '/fine_128', listeners: 5 } } } },
    hosts: [HOST], servers: [], reachable: true, mounts: {}, mountCount: 1,
  });
  diagnose.probeStream = async (s) => (s.id === 'fine'
    ? { status: 'up', responseTime: 12, isSilent: false, audioEnergy: 9, timings: {} }
    : { status: 'down', responseTime: 40, httpStatus: 404, error: 'HTTP 404', errorCode: 'HTTP_404', timings: {} });
  try {
    for (let i = 0; i < n; i++) await monitor.runChecks();
  } finally {
    diagnose.fetchHostSnapshots = realSnapshot;
    diagnose.probeStream = realProbe;
  }
}

test('a long outage on a muted station and on an alerting one each count as ONE storm outage', async () => {
  const sent = [];
  monitor._setTransporter({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to], rejected: [] }; } });
  monitor._resetStorms();
  store.setMeta('storms', {});
  monitor._setEpisodes({});

  try {
    await cycles(8);
  } finally {
    monitor._setTransporter(null);
  }

  for (const s of [{ id: 'muted' }, { id: 'loud' }]) {
    const st = monitor._storms()[s.id];
    assert.ok(st, `${s.id}: the confirmed outage reached the storm counter`);
    assert.strictEqual(st.outages.length, 1,
      `${s.id}: one continuous outage was counted ${st.outages.length} times`);
    assert.strictEqual(st.active, false, `${s.id}: one outage declared a storm`);
  }

  const mutedDown = store.getEvents().events.find((e) => e.streamId === 'muted' && e.type === 'down');
  assert.doesNotMatch(mutedDown.email.reason, /flapping/);
  assert.match(mutedDown.email.reason, /switched off/);

  const loudMail = sent.filter((m) => /loud/.test(m.subject) && /DOWN/.test(m.subject));
  assert.strictEqual(loudMail.length, 1, 'the alerting station is emailed its outage exactly once');
  assert.strictEqual(sent.filter((m) => /muted/.test(m.subject)).length, 0, 'the muted station is never emailed');
});
