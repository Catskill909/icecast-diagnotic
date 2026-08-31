/* ═══════════════════════════════════════════════════════════════════════════
   Who the weekly roundup reaches

   Reported 2026-08-31: the operator running the monitor had received every
   outage alert for weeks and not one weekly roundup. The cause was not a
   delivery failure — the Aug 24 roundup sent successfully — it was that alerts
   and the roundup read DIFFERENT recipient lists. Alerts went to ALERT_EMAILS
   plus ALERT_CC; the roundup went to ALERT_EMAILS alone, so an address
   configured only as CC got the 3am pages and never the report.

   That matters more than an ordinary missing copy. The roundup is the ONE
   message that arrives in a week when nothing went wrong, and it is therefore
   the only thing distinguishing a quiet week from a monitor that has silently
   died. The person most in need of that signal is precisely the one who was
   omitted.

   THE RULE, now that recipients live in the store: a station's roundup goes to
   the same list as its alerts. Not a parallel list, not an env var — the same
   list. Two lists is what caused this, and any second source of truth
   reintroduces it.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roundup-'));
process.env.SEED_FILE = '/nonexistent';
// Set deliberately. None of these may reach a send any more.
process.env.ALERT_EMAILS = 'env-alerts@example.org';
process.env.ALERT_CC = 'env-cc@example.org';
process.env.WEEKLY_ROUNDUP_EMAILS = 'env-roundup@example.org';

const monitor = require('../monitor');
const { roundupRecipients, recipientsFor, reloadConfig } = monitor;

/* Two stations with different lists, so "the right list" is a real assertion
   rather than something a single-station fixture would pass by accident. */
const CONFIG = {
  version: 1,
  hosts: [{ id: 'h', host: 'streams.example.org:9000' }],
  stations: [
    {
      id: 'kpft',
      name: 'KPFT',
      timezone: 'America/Chicago',
      alerts: { enabled: true, recipients: ['gm@kpft.org', 'paul@hype.net'] },
      channels: [{ id: 'kpft-main', name: 'Main', url: 'https://streams.example.org:9000/live_128' }],
    },
    {
      id: 'wpfw',
      name: 'WPFW',
      timezone: 'America/New_York',
      alerts: { enabled: true, recipients: ['gm@wpfw.org'] },
      channels: [{ id: 'wpfw', name: 'WPFW', url: 'https://streams.example.org:9000/wpfw_128' }],
    },
    {
      id: 'kpfk',
      name: 'KPFK',
      timezone: 'America/Los_Angeles',
      alerts: { enabled: false, recipients: ['gm@kpfk.org'] },
      channels: [{ id: 'kpfk', name: 'KPFK', url: 'https://streams.example.org:9000/kpfk_128' }],
    },
  ],
};

const store = require('../store');
store.load();
store.setStationConfig(CONFIG);
reloadConfig();

test('a station\'s roundup goes to the SAME list as its alerts', () => {
  // The whole finding, as one assertion. Two lists is what caused this.
  for (const id of ['kpft', 'wpfw']) {
    const stream = monitor.getStreams().find((s) => s.stationId === id);
    assert.deepEqual(
      roundupRecipients(undefined, id).recipients,
      recipientsFor(stream).recipients,
      `${id}: the roundup and its alerts must not read different lists`,
    );
  }
});

test('each station gets its own list, not another station\'s', () => {
  assert.deepEqual(roundupRecipients(undefined, 'kpft').recipients, ['gm@kpft.org', 'paul@hype.net']);
  assert.deepEqual(roundupRecipients(undefined, 'wpfw').recipients, ['gm@wpfw.org']);
});

test('no environment variable reaches a roundup', () => {
  // ALERT_EMAILS, ALERT_CC and WEEKLY_ROUNDUP_EMAILS are all set above. A
  // regression guard: any of them appearing here means a second source of truth
  // has been reintroduced, which is the bug this file exists for.
  const all = ['kpft', 'wpfw', 'kpfk', 'nosuchstation']
    .flatMap((id) => roundupRecipients(undefined, id).recipients)
    .join(' ');
  for (const leaked of ['env-alerts@example.org', 'env-cc@example.org', 'env-roundup@example.org']) {
    assert.equal(all.includes(leaked), false, `${leaked} reached a roundup`);
  }
});

test('a station with alerts switched off gets no roundup', () => {
  // Switching alerts off means "do not email this station's people". A weekly
  // report is email. It keeps its recipients, so switching back on restores it.
  assert.deepEqual(roundupRecipients(undefined, 'kpfk').recipients, []);
});

test('an unknown station reaches nobody rather than falling back', () => {
  assert.deepEqual(roundupRecipients(undefined, 'nosuchstation').recipients, []);
});

test('an explicit ?to= sends to that one address and copies nobody', () => {
  // That parameter exists so a person can CHECK the message. Mailing the whole
  // station every time somebody previews it is the opposite of its purpose.
  const r = roundupRecipients('me@example.org', 'kpft');
  assert.deepEqual(r.recipients, ['me@example.org']);
  assert.deepEqual(r.cc, [], 'a one-off check must not mail the station');
});
