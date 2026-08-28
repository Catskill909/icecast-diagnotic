/* ═══════════════════════════════════════════════════════════════════════════
   Which stations may send email

   Recipients are a single global list. So the moment a second station is added
   through the admin panel, its outages start paging the first station's staff —
   a general manager woken at 3am about a transmitter in another city, with no
   setting anywhere that says so.

   ALERT_STATIONS is the gate. Empty means every station, which is what a
   single-station deployment has always had and must keep having.

   The invariant that must NOT bend: recording is unaffected. A station that
   emails nobody is still fully monitored, and its events still enter the
   permanent record — otherwise "we are not paging you about this" quietly
   becomes "we are not watching this".
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertstations-'));
process.env.SEED_FILE = '/nonexistent';
process.env.ALERT_STATIONS = 'kpft';

const monitor = require('../monitor');
const { alertsEnabledFor } = monitor;

test('a station on the list may alert', () => {
  assert.equal(alertsEnabledFor({ stationId: 'kpft' }), true);
});

test('a station NOT on the list may not — this is the whole point', () => {
  assert.equal(alertsEnabledFor({ stationId: 'wpfw' }), false);
  assert.equal(alertsEnabledFor({ stationId: 'kpfk' }), false);
});

test('matching ignores case, because the value is typed into a hosting panel', () => {
  assert.equal(alertsEnabledFor({ stationId: 'KPFT' }), true);
});

test('a stream with no station cannot alert while a list is set', () => {
  // Failing open here would mean anything unrecognised pages everyone.
  assert.equal(alertsEnabledFor({}), false);
  assert.equal(alertsEnabledFor(null), false);
  assert.equal(alertsEnabledFor({ stationId: '' }), false);
});
