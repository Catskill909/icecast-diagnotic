/* Unset ALERT_STATIONS must keep the behaviour every existing deployment has:
   every station alerts. A gate that silences a single-station install on upgrade
   would be the worst possible failure — a monitor that stops emailing and says
   nothing about it. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertstations-none-'));
process.env.SEED_FILE = '/nonexistent';
delete process.env.ALERT_STATIONS;

const { alertsEnabledFor } = require('../monitor');

test('with no list set, every station may alert', () => {
  assert.equal(alertsEnabledFor({ stationId: 'kpft' }), true);
  assert.equal(alertsEnabledFor({ stationId: 'wpfw' }), true);
  assert.equal(alertsEnabledFor({ stationId: 'anything' }), true);
});

test('even a stream with no station, which is how the app shipped for months', () => {
  assert.equal(alertsEnabledFor({}), true);
});
