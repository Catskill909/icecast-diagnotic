/* ═══════════════════════════════════════════════════════════════════════════
   Migrating environment recipients into the store

   Recipients were the last configuration still read from the environment at send
   time. That is why the admin panel could say "2 recipients" in one line and
   "none set" in the next — the addresses that actually received KPFT's alerts
   lived in a variable no screen could show or edit.

   THE ONLY THING THIS MIGRATION MUST NOT DO IS CHANGE WHO RECEIVES EMAIL.

   That is not a property anyone can eyeball. `ALERT_STATIONS=kpft` means exactly
   one of four stations may email today, so the obvious implementation — copy
   ALERT_EMAILS onto every station — signs KPFT's general manager up for outages
   at three stations in three other cities. It is the precise 3am failure
   per-station recipients were built to prevent, and it would ship looking
   correct.

   So the central test computes the recipient set for every station BEFORE and
   AFTER, under the real production configuration, and asserts they are
   identical. Everything else here is detail.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertmig-'));
process.env.SEED_FILE = '/nonexistent';

const monitor = require('../monitor');
const { seedAlertsFromEnv } = monitor;

/* The production configuration on the day of the migration. */
const PROD = {
  version: 1,
  hosts: [{ id: 'h1', host: 'streams.pacifica.org:9000' }, { id: 'h2', host: 'streaming.wbai.org' }],
  stations: [
    { id: 'kpft', name: 'KPFT Houston', channels: [{ id: 'kpft-main' }, { id: 'kpft-hd2' }, { id: 'kpft-hd3' }] },
    { id: 'wpfw', name: 'WPFW Washington DC', channels: [{ id: 'wpfw' }] },
    { id: 'kpfk', name: 'KPFK Los Angeles', channels: [{ id: 'kpfk' }] },
    { id: 'wbai', name: 'WBAI New York', channels: [{ id: 'wbai-verizon' }, { id: 'wbai-spectrum' }] },
  ],
};

const ENV = {
  alertEmails: 'gm@kpft.org,omaclay@gmail.com',
  alertCc: 'paul@hype.net',
  alertStations: 'kpft',
};

/** Who a station reached under the OLD rules: env lists, gated by ALERT_STATIONS. */
function recipientsBefore(stationId, env) {
  const permitted = !env.alertStations.trim()
    || env.alertStations.split(',').map((s) => s.trim().toLowerCase()).includes(stationId);
  if (!permitted) return [];
  return [...env.alertEmails.split(','), ...env.alertCc.split(',')]
    .map((e) => e.trim()).filter(Boolean);
}

/** Who a station reaches under the NEW rules: its own stored list, if enabled. */
function recipientsAfter(station) {
  const a = station.alerts || {};
  if (a.enabled === false) return [];
  return [...(a.recipients || [])];
}

const norm = (list) => [...new Set(list.map((a) => a.toLowerCase()))].sort();

/* ── The test the whole migration exists to pass ───────────────────────────── */

test('NOBODY gains or loses email: the recipient set per station is identical', () => {
  const after = seedAlertsFromEnv(PROD, ENV);

  for (const station of PROD.stations) {
    const migrated = after.stations.find((s) => s.id === station.id);
    assert.deepEqual(
      norm(recipientsAfter(migrated)),
      norm(recipientsBefore(station.id, ENV)),
      `${station.id}: the migration changed who receives its alerts`,
    );
  }
});

test('the three stations that could not email still cannot', () => {
  // Stated separately from the equivalence above, because this is the specific
  // catastrophe: KPFT's GM woken about a transmitter in Los Angeles.
  const after = seedAlertsFromEnv(PROD, ENV);
  for (const id of ['wpfw', 'kpfk', 'wbai']) {
    const s = after.stations.find((x) => x.id === id);
    assert.equal(s.alerts.enabled, false, `${id} must not be able to email`);
    assert.deepEqual(s.alerts.recipients, [], `${id} must not inherit KPFT's recipients`);
  }
});

test('KPFT keeps all three addresses, ALERT_CC merged into the one list', () => {
  const after = seedAlertsFromEnv(PROD, ENV);
  const kpft = after.stations.find((s) => s.id === 'kpft');
  assert.deepEqual(kpft.alerts.recipients, ['gm@kpft.org', 'omaclay@gmail.com', 'paul@hype.net']);
  assert.equal(kpft.alerts.enabled, true);
  assert.equal(kpft.alerts.cc, undefined, 'CC is retired — it is one list now');
});

/* ── Detail ────────────────────────────────────────────────────────────────── */

test('an empty ALERT_STATIONS means every station may email — the single-station case', () => {
  const after = seedAlertsFromEnv(PROD, { ...ENV, alertStations: '' });
  for (const s of after.stations) {
    assert.equal(s.alerts.enabled, true, `${s.id} should be permitted`);
    assert.equal(s.alerts.recipients.length, 3);
  }
});

test('a station already configured in the panel is never overwritten', () => {
  // The store is authoritative. This fills in what was never set; it does not
  // reach back over an operator's own edits.
  const configured = JSON.parse(JSON.stringify(PROD));
  configured.stations[1].alerts = { enabled: true, recipients: ['gm@wpfw.org'] };

  const after = seedAlertsFromEnv(configured, ENV);
  assert.deepEqual(after.stations[1].alerts.recipients, ['gm@wpfw.org']);
  assert.equal(after.stations[1].alerts.enabled, true);
});

test('running it twice changes nothing the second time', () => {
  const once = seedAlertsFromEnv(PROD, ENV);
  const twice = seedAlertsFromEnv(once, ENV);
  assert.deepEqual(twice, once);
});

test('addresses appearing in both ALERT_EMAILS and ALERT_CC are not duplicated', () => {
  const after = seedAlertsFromEnv(PROD, {
    ...ENV, alertEmails: 'gm@kpft.org', alertCc: 'GM@kpft.org,paul@hype.net',
  });
  const kpft = after.stations.find((s) => s.id === 'kpft');
  assert.deepEqual(kpft.alerts.recipients, ['gm@kpft.org', 'paul@hype.net']);
});

test('no environment configured at all yields empty lists, not crashes', () => {
  const after = seedAlertsFromEnv(PROD, { alertEmails: '', alertCc: '', alertStations: '' });
  for (const s of after.stations) assert.deepEqual(s.alerts.recipients, []);
});

test('the original configuration is not mutated', () => {
  seedAlertsFromEnv(PROD, ENV);
  assert.equal(PROD.stations[0].alerts, undefined);
});
