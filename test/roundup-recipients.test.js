/* ═══════════════════════════════════════════════════════════════════════════
   Who the weekly roundup reaches

   Reported 2026-08-31: the operator running the monitor had received every
   outage alert for weeks and not one weekly roundup. The cause was not a
   delivery failure — the Aug 24 roundup sent successfully — it was that alerts
   and the roundup read DIFFERENT recipient lists. sendAlert() sends to
   ALERT_EMAILS plus ALERT_CC; the roundup sent to ALERT_EMAILS alone, so an
   address configured only as CC got the 3am pages and never the report.

   That matters more than an ordinary missing copy. The roundup is the ONE
   message that arrives in a week when nothing went wrong, and it is therefore
   the only thing distinguishing a quiet week from a monitor that has silently
   died. The person most in need of that signal is precisely the one on ALERT_CC.

   Written against the class: any message the monitor sends on its own schedule
   must reach the same people as the ones it sends on an incident.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roundup-'));
process.env.SEED_FILE = '/nonexistent';

const monitor = require('../monitor');
const { roundupRecipients } = monitor;

/** Restores the env after each case, so ordering cannot make one pass falsely. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the roundup copies ALERT_CC, exactly as an alert does', () => {
  withEnv({
    ALERT_EMAILS: 'gm@kpft.org,engineer@kpft.org',
    ALERT_CC: 'monitor-owner@example.org',
    WEEKLY_ROUNDUP_EMAILS: undefined,
  }, () => {
    const r = roundupRecipients();
    assert.deepEqual(r.recipients, ['gm@kpft.org', 'engineer@kpft.org']);
    assert.deepEqual(r.cc, ['monitor-owner@example.org'],
      'an address configured only as CC must receive the roundup too');
  });
});

test('WEEKLY_ROUNDUP_EMAILS overrides the recipients but does NOT drop the CC', () => {
  // The override chooses who the report is FOR. It is not a statement that the
  // monitor owner should stop hearing whether the monitor is alive.
  withEnv({
    ALERT_EMAILS: 'gm@kpft.org',
    ALERT_CC: 'monitor-owner@example.org',
    WEEKLY_ROUNDUP_EMAILS: 'board@kpft.org',
  }, () => {
    const r = roundupRecipients();
    assert.deepEqual(r.recipients, ['board@kpft.org']);
    assert.deepEqual(r.cc, ['monitor-owner@example.org']);
  });
});

test('an explicit ?to= copies nobody', () => {
  // That parameter exists so a person can CHECK the message. Mailing the whole
  // station every time somebody previews it is the opposite of its purpose.
  withEnv({
    ALERT_EMAILS: 'gm@kpft.org',
    ALERT_CC: 'monitor-owner@example.org',
  }, () => {
    const r = roundupRecipients('me@example.org');
    assert.deepEqual(r.recipients, ['me@example.org']);
    assert.deepEqual(r.cc, [], 'a one-off check must not mail the station');
  });
});

test('an address on both lists is not mailed twice', () => {
  withEnv({
    ALERT_EMAILS: 'gm@kpft.org',
    ALERT_CC: 'GM@kpft.org,board@kpft.org',
  }, () => {
    const r = roundupRecipients();
    assert.deepEqual(r.cc, ['board@kpft.org']);
  });
});

test('no ALERT_CC configured is not an error, it is simply no copies', () => {
  withEnv({ ALERT_EMAILS: 'gm@kpft.org', ALERT_CC: undefined }, () => {
    const r = roundupRecipients();
    assert.deepEqual(r.recipients, ['gm@kpft.org']);
    assert.deepEqual(r.cc, []);
  });
});

test('no recipients at all is reported, not silently sent to nobody', () => {
  withEnv({ ALERT_EMAILS: undefined, WEEKLY_ROUNDUP_EMAILS: undefined, ALERT_CC: 'owner@example.org' }, () => {
    const r = roundupRecipients();
    assert.deepEqual(r.recipients, [], 'sendWeeklyRoundup() refuses on an empty To list');
    // Deliberate: a message with only a CC and no To is a shape some servers
    // reject and every client renders oddly. The refusal is the correct outcome.
  });
});
