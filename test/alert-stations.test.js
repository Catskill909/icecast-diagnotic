/* ═══════════════════════════════════════════════════════════════════════════
   ALERT_STATIONS is a migration input, not a run-time gate

   It used to decide, on every send, which stations were allowed to email. That
   made it the only thing keeping one station's 3am outage out of another
   station's inbox — and, because nothing displayed it, the reason three
   monitored stations could reach nobody at all while looking fully configured.

   On 2026-08-31 recipients moved into the store. ALERT_STATIONS now has exactly
   one job, once: it decides which stations get seeded with the environment's
   addresses and which are seeded explicitly off (see alert-migration.test.js).
   After that it is never read again.

   THESE ARE REGRESSION GUARDS. Every case here fails if env-based gating is put
   back at send time. That would be a regression even though it would look like
   a safety feature: it reintroduces a rule that overrides the admin panel and
   appears on no screen, so an operator adds recipients, saves them, sees them
   stored, and is never told why nothing arrives.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertstations-'));
process.env.SEED_FILE = '/nonexistent';
// Deliberately restrictive. Under the old rules this permitted kpft and nothing
// else; under the current rules it must permit nothing and forbid nothing.
process.env.ALERT_STATIONS = 'kpft';
process.env.ALERT_EMAILS = 'env-list@example.org';

const monitor = require('../monitor');
const { alertsEnabledFor, recipientsFor } = monitor;

test('a station NOT named by ALERT_STATIONS may still email', () => {
  assert.equal(
    alertsEnabledFor({ stationId: 'wpfw', stationAlerts: { enabled: true, recipients: ['gm@wpfw.org'] } }),
    true,
  );
});

test('a station named by ALERT_STATIONS is still muted when switched off', () => {
  // The panel's switch is the authority in both directions, not just the
  // permissive one.
  assert.equal(
    alertsEnabledFor({ stationId: 'kpft', stationAlerts: { enabled: false, recipients: ['gm@kpft.org'] } }),
    false,
  );
});

test('ALERT_EMAILS never reaches a send', () => {
  // It is set above. If it appears in any resolved recipient list, the
  // send-time fallback has been reintroduced.
  for (const stream of [
    { stationId: 'kpft' },
    { stationId: 'wpfw' },
    { stationId: 'kpft', stationAlerts: { enabled: true, recipients: [] } },
    {},
  ]) {
    assert.deepEqual(recipientsFor(stream).recipients, [],
      `ALERT_EMAILS leaked into ${JSON.stringify(stream)}`);
  }
});

test('a stream with no station reaches nobody', () => {
  // Failing open here would mean anything unrecognised pages everyone.
  assert.deepEqual(recipientsFor({}).recipients, []);
  assert.deepEqual(recipientsFor(null).recipients, []);
});
