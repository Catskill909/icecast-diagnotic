/* ═══════════════════════════════════════════════════════════════════════════
   Per-station alert recipients

   Recipients used to be ONE global ALERT_EMAILS list, and the only thing keeping
   one station's 3am outage out of another station's inbox was ALERT_STATIONS —
   a mute. On the production record that mute is why WPFW, KPFK and WBAI were
   monitored for weeks, diagnosed correctly, recorded in full, and could reach
   nobody at all: three confirmed WPFW source dropouts on 2026-08-31 alone, every
   one of them emailed to no one.

   THE INVARIANT THAT MUST NOT BEND: one message never spans two stations.

   These four stations share one Icecast host. A server-side fault therefore
   fails all of them in the SAME CYCLE, and alerts are consolidated so that one
   incident produces one email rather than five. Consolidation was written when
   the monitor watched a single station, so it grouped by nothing at all — which
   the moment recipients became per-station meant the single message went to
   whichever station sorted first, telling them about three stations in other
   cities and telling the other three nobody.

   Recording remains unaffected throughout. A station that emails nobody is
   still fully monitored — otherwise "we are not paging you about this" quietly
   becomes "we are not watching this".
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertrecip-'));
process.env.SEED_FILE = '/nonexistent';
process.env.ALERT_STATIONS = 'kpft';
process.env.ALERT_EMAILS = 'fallback@example.org';
process.env.ALERT_CC = 'cc-fallback@example.org';

const monitor = require('../monitor');
const discover = require('../discover');
const { alertsEnabledFor, recipientsFor, groupEntriesByStation } = monitor;

/* ── The invariant: one message, one station ───────────────────────────────── */

// The real shape of the incident: the shared Icecast host resets and every
// station on it fails in the same second.
const sharedHostOutage = [
  { stream: { id: 'kpft-main', stationId: 'kpft' } },
  { stream: { id: 'kpft-hd2', stationId: 'kpft' } },
  { stream: { id: 'wpfw', stationId: 'wpfw' } },
  { stream: { id: 'kpfk', stationId: 'kpfk' } },
  { stream: { id: 'wbai-verizon', stationId: 'wbai' } },
];

test('a consolidated alert is never addressed across two stations', () => {
  for (const group of groupEntriesByStation(sharedHostOutage)) {
    const stations = new Set(group.map((e) => e.stream.stationId));
    assert.equal(stations.size, 1,
      `a single message covered ${[...stations].join(' + ')} — those are different people`);
  }
});

test('every failing stream is still covered by some message', () => {
  // The other half of the bug: grouping that DROPS a stream is not an
  // improvement on grouping that misaddresses it. Both leave someone untold.
  const covered = groupEntriesByStation(sharedHostOutage).flat().map((e) => e.stream.id);
  assert.deepEqual(covered.sort(), sharedHostOutage.map((e) => e.stream.id).sort());
});

test('streams of one station still consolidate into a single message', () => {
  // The reason consolidation exists. Three KPFT channels failing together must
  // not become three separate emails.
  const groups = groupEntriesByStation([
    { stream: { id: 'kpft-main', stationId: 'kpft' } },
    { stream: { id: 'kpft-hd2', stationId: 'kpft' } },
    { stream: { id: 'kpft-hd3', stationId: 'kpft' } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});

test('a stream with no station is never folded into a real station\'s message', () => {
  const groups = groupEntriesByStation([
    { stream: { id: 'orphan' } },
    { stream: { id: 'kpft-main', stationId: 'kpft' } },
  ]);
  assert.equal(groups.length, 2, 'an unattributed failure must not inherit an owner');
});

/* ── Resolution ────────────────────────────────────────────────────────────── */

test("a station's own recipients are used in place of the global list", () => {
  const r = recipientsFor({
    stationId: 'wpfw',
    stationAlerts: { recipients: ['gm@wpfw.org'], cc: ['eng@pacifica.org'] },
  });
  assert.deepEqual(r.recipients, ['gm@wpfw.org']);
  assert.deepEqual(r.cc, ['eng@pacifica.org']);
  assert.equal(r.source, 'station');
});

test('a station with none of its own falls back to the global list', () => {
  // Every deployment predating this feature has exactly this shape, and must
  // keep behaving as it did.
  const r = recipientsFor({ stationId: 'kpft' });
  assert.deepEqual(r.recipients, ['fallback@example.org']);
  assert.deepEqual(r.cc, ['cc-fallback@example.org']);
  assert.equal(r.source, 'global');
});

test('an empty recipient list falls back rather than sending to nobody', () => {
  const r = recipientsFor({ stationId: 'wpfw', stationAlerts: { recipients: [], enabled: true } });
  assert.equal(r.source, 'global');
});

/* ── The gate ──────────────────────────────────────────────────────────────── */

test('a station configured in the panel overrides the ALERT_STATIONS env mute', () => {
  // ALERT_STATIONS is 'kpft' above, so before this feature WPFW could not email
  // at all. Adding recipients in the panel must be sufficient on its own — the
  // alternative is a screen that saves addresses and silently sends nothing
  // because of a variable typed into a hosting panel weeks earlier.
  assert.equal(alertsEnabledFor({ stationId: 'wpfw' }), false, 'unset, the env mute still applies');
  assert.equal(
    alertsEnabledFor({ stationId: 'wpfw', stationAlerts: { recipients: ['gm@wpfw.org'] } }),
    true,
    'configured in the panel, the station may email',
  );
});

test('switching a station off mutes it even when it has recipients', () => {
  assert.equal(
    alertsEnabledFor({ stationId: 'kpft', stationAlerts: { enabled: false, recipients: ['gm@kpft.org'] } }),
    false,
  );
});

test('an empty block is not a decision, so the env behaviour still applies', () => {
  // `{}` must read as "never configured", not as "configured to send".
  assert.equal(alertsEnabledFor({ stationId: 'wpfw', stationAlerts: {} }), false);
  assert.equal(alertsEnabledFor({ stationId: 'kpft', stationAlerts: {} }), true);
});

/* ── Validation ────────────────────────────────────────────────────────────── */

test('addresses are accepted, and non-addresses are named in the error', () => {
  const bad = discover.validateAlertsPayload({ recipients: ['Sandy', 'gm@kpft.org'] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /Sandy/);

  const good = discover.validateAlertsPayload({ recipients: ['gm@kpft.org', 'a.b+alerts@sub.example.co.uk'] });
  assert.equal(good.ok, true, good.errors && good.errors.join('; '));
  assert.equal(good.alerts.recipients.length, 2, 'plus addressing and long TLDs are real addresses');
});

test('a pasted comma-separated string becomes several recipients, not one bad one', () => {
  const v = discover.validateAlertsPayload({ recipients: 'gm@kpft.org, engineer@kpft.org' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.alerts.recipients, ['gm@kpft.org', 'engineer@kpft.org']);
});

test('duplicates are dropped case-insensitively, and the address is stored as typed', () => {
  const v = discover.validateAlertsPayload({ recipients: ['GM@kpft.org', 'gm@kpft.ORG'] });
  assert.deepEqual(v.alerts.recipients, ['GM@kpft.org']);
});

test('an address in both lists is not mailed twice', () => {
  const v = discover.validateAlertsPayload({
    recipients: ['gm@kpft.org'],
    cc: ['GM@kpft.org', 'board@kpft.org'],
  });
  assert.deepEqual(v.alerts.recipients, ['gm@kpft.org']);
  assert.deepEqual(v.alerts.cc, ['board@kpft.org']);
});

test('a field that was not sent is left unchanged, not cleared', () => {
  // A panel saving only the field it edited must not silently empty the other.
  const v = discover.validateAlertsPayload({ enabled: false }, { recipients: ['gm@kpft.org'] });
  assert.deepEqual(v.alerts.recipients, ['gm@kpft.org']);
  assert.equal(v.alerts.enabled, false);
});

test('an explicitly empty list DOES clear, because removing the last address is a real act', () => {
  const v = discover.validateAlertsPayload({ recipients: [] }, { recipients: ['gm@kpft.org'] });
  assert.equal(v.ok, true);
  assert.equal(v.alerts.recipients, undefined);
});

test('setStationAlerts removes an empty block rather than storing {}', () => {
  // `{}` and "never configured" must be indistinguishable, or the env fallback
  // stops applying to a station whose settings were merely cleared.
  const config = { version: 1, hosts: [], stations: [{ id: 'kpft', name: 'KPFT', alerts: { recipients: ['x@y.org'] } }] };
  const next = discover.setStationAlerts(config, 'kpft', {});
  assert.equal('alerts' in next.stations[0], false);
  assert.deepEqual(config.stations[0].alerts.recipients, ['x@y.org'], 'the original is not mutated');
});
