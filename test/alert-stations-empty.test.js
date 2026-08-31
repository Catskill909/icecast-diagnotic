/* A single-station install must never go silent on upgrade.
 *
 * This began as "unset ALERT_STATIONS means every station alerts", a rule the
 * send path enforced. Recipients moved into the store on 2026-08-31 and the send
 * path no longer reads that variable at all — but the risk it guarded against is
 * unchanged and is the worst failure this system has: a monitor that quietly
 * stops emailing and reports nothing about it. Nobody discovers that until an
 * outage nobody hears about.
 *
 * So the assertions stay, now pinning the DEFAULT rather than the env rule: a
 * station is enabled unless somebody switched it off. The matching migration
 * case — an install with no ALERT_STATIONS seeds every station with the
 * environment's addresses, so it keeps alerting across the upgrade — is in
 * test/alert-migration.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertstations-none-'));
process.env.SEED_FILE = '/nonexistent';
delete process.env.ALERT_STATIONS;

const { alertsEnabledFor, seedAlertsFromEnv } = require('../monitor');

test('a station is enabled unless somebody switched it off', () => {
  assert.equal(alertsEnabledFor({ stationId: 'kpft' }), true);
  assert.equal(alertsEnabledFor({ stationId: 'wpfw' }), true);
  assert.equal(alertsEnabledFor({ stationId: 'anything' }), true);
});

test('even a stream with no station, which is how the app shipped for months', () => {
  assert.equal(alertsEnabledFor({}), true);
});

test('a single-station install keeps its recipients across the migration', () => {
  // The upgrade path for every deployment that predates per-station recipients:
  // one station, no ALERT_STATIONS, addresses only in ALERT_EMAILS.
  const config = { version: 1, hosts: [], stations: [{ id: 'wxyz', name: 'WXYZ', channels: [{ id: 'wxyz' }] }] };
  const after = seedAlertsFromEnv(config, {
    alertEmails: 'engineer@wxyz.org,gm@wxyz.org', alertCc: '', alertStations: '',
  });
  assert.equal(after.stations[0].alerts.enabled, true);
  assert.deepEqual(after.stations[0].alerts.recipients, ['engineer@wxyz.org', 'gm@wxyz.org']);
});
