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

test('a station with no list of its own reaches NOBODY — there is no fallback', () => {
  // ALERT_EMAILS is set in this file's environment. It must not leak into a
  // send. It seeded the stored lists once at migration and is never read again:
  // a fallback consulted at send time is what let the panel display one list
  // while a different one was emailed.
  const r = recipientsFor({ stationId: 'kpft' });
  assert.deepEqual(r.recipients, [], 'ALERT_EMAILS must not be consulted at send time');
  assert.equal(r.source, 'station');
});

test('an empty recipient list means nobody, not "fall back to the env list"', () => {
  const r = recipientsFor({ stationId: 'wpfw', stationAlerts: { recipients: [], enabled: true } });
  assert.deepEqual(r.recipients, []);
});

/* ── The gate ──────────────────────────────────────────────────────────────── */

test('ALERT_STATIONS does not gate anything at run time', () => {
  // Set to 'kpft' in this file's environment. A station it does not name must
  // still be able to email once the panel says so — otherwise an operator adds
  // recipients, saves, sees them stored, and nothing sends, blocked by a
  // variable typed into a hosting panel weeks earlier that no screen displays.
  //
  // This is a REGRESSION GUARD. It fails if env gating is ever put back.
  assert.equal(
    alertsEnabledFor({ stationId: 'wpfw', stationAlerts: { recipients: ['gm@wpfw.org'] } }),
    true,
    'a configured station must email regardless of ALERT_STATIONS',
  );
});

test('switching a station off mutes it even when it has recipients', () => {
  assert.equal(
    alertsEnabledFor({ stationId: 'kpft', stationAlerts: { enabled: false, recipients: ['gm@kpft.org'] } }),
    false,
  );
});

test('a station with no block is ON with nobody on it, not silently muted', () => {
  // A station added after the migration. "On, with no recipients" surfaces as
  // "no recipients have been added yet" — a to-do an operator can act on. A
  // silent mute looks identical to a working configuration and is not
  // actionable, which is the failure mode this whole screen exists to remove.
  assert.equal(alertsEnabledFor({ stationId: 'newstation' }), true);
  assert.deepEqual(recipientsFor({ stationId: 'newstation' }).recipients, [],
    'enabled, but nothing is sent because there is nobody to send to');
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
