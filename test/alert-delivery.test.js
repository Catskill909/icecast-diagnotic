/* ═══════════════════════════════════════════════════════════════════════════
   Alert delivery outcomes

   On 2026-09-02 KPFT Main and KPFT HD2 both went down. The DOWN alert was
   stored `sent: true`, the history page rendered a green "Alert sent", and the
   event detail said "Alert sent: Yes" — while the very same delivery record
   held `rejected: ["<an address>"]`. One of the three recipients never received
   it, and the only thing that surfaced the gap was that person noticing the
   silence and asking why the recovery email had arrived alone.

   THE MECHANISM: nodemailer's sendMail RESOLVES on a PARTIAL delivery failure.
   The SMTP dialogue refuses individual RCPT TO addresses and accepts the rest;
   the promise only rejects when every recipient is refused. Every sender in
   monitor.js read "it did not throw" as "it was delivered".

   These tests are written against the CLASS, not the incident. The specific
   case (one of three refused) is checked, but the tests that matter are the
   ones asserting that NO sender can report an unqualified success while the
   transport is telling it someone was refused.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { deliveryOutcome } = require('../monitor');

// ── The reported instance ───────────────────────────────────────────────────
test('a partially refused send is NOT reported as delivered', () => {
  // Exactly the shape nodemailer returned for the 9:44 KPFT DOWN alert.
  const info = {
    accepted: ['gm@example.org', 'engineer@example.org'],
    rejected: ['refused@example.net'],
  };
  const out = deliveryOutcome(info, ['gm@example.org', 'engineer@example.org', 'refused@example.net']);

  assert.equal(out.delivery, 'partial', 'the verdict every reader must consult');
  assert.equal(out.rejectedCount, 1);
  assert.deepEqual(out.rejected, ['refused@example.net']);
  assert.equal(out.accepted, 2);
  assert.equal(out.sent, true, 'two people genuinely were told — the counters must still see an alert');
});

// ── The class ───────────────────────────────────────────────────────────────
test('a send every recipient refused is not a send at all', () => {
  // Some transports resolve rather than throwing even here. `sent: true` would
  // record an alert that reached nobody as having been delivered.
  const out = deliveryOutcome({ accepted: [], rejected: ['a@example.org', 'b@example.org'] },
    ['a@example.org', 'b@example.org']);

  assert.equal(out.sent, false);
  assert.equal(out.delivery, 'none');
  assert.equal(out.rejectedCount, 2);
});

test('a clean send is delivery "all" and rejects nobody', () => {
  const out = deliveryOutcome({ accepted: ['a@example.org'], rejected: [] }, ['a@example.org']);
  assert.equal(out.sent, true);
  assert.equal(out.delivery, 'all');
  assert.equal(out.rejectedCount, 0);
});

test('CC recipients count toward acceptance', () => {
  const out = deliveryOutcome({ accepted: ['a@example.org', 'c@example.org'], rejected: [] },
    ['a@example.org'], ['c@example.org']);
  assert.equal(out.accepted, 2);
  assert.equal(out.delivery, 'all');
});

test('a transport reporting neither list is assumed to have refused nobody', () => {
  // jsonTransport and test stubs report no accepted/rejected arrays. A
  // transport that cannot refuse anyone must not read as a failure.
  for (const info of [undefined, null, {}, { messageId: '<x@y>' }]) {
    const out = deliveryOutcome(info, ['a@example.org'], ['b@example.org']);
    assert.equal(out.sent, true, `bare result ${JSON.stringify(info)} should still count as sent`);
    assert.equal(out.delivery, 'all');
    assert.equal(out.rejectedCount, 0);
  }
});

test('a rejected address is subtracted when the transport reports no accepted list', () => {
  const out = deliveryOutcome({ rejected: ['a@example.org'] }, ['a@example.org', 'b@example.org']);
  assert.equal(out.accepted, 1);
  assert.equal(out.delivery, 'partial');
});

test('malformed transport results do not throw', () => {
  for (const info of [null, undefined, 'string', 42, { accepted: 'x', rejected: 'y' }]) {
    assert.doesNotThrow(() => deliveryOutcome(info, ['a@example.org']));
  }
  assert.doesNotThrow(() => deliveryOutcome({}, undefined, undefined));
});

// ── The sweep: no sender may hand-roll a success ────────────────────────────
test('SWEEP: every sendMail call site reads its result through deliveryOutcome', () => {
  // The bug existed in three places at once — sendAlert, sendWeeklyRoundup and
  // sendTestAlert — because each hand-wrote its own success object. This is the
  // test that fails when a fourth sender is added the same way.
  const src = fs.readFileSync(path.join(__dirname, '..', 'monitor.js'), 'utf8');

  const sendMailCalls = (src.match(/transporter\.sendMail\(/g) || []).length;
  const outcomeReads = (src.match(/deliveryOutcome\(/g) || []).length;

  assert.ok(sendMailCalls > 0, 'expected to find sendMail call sites');
  assert.ok(
    outcomeReads >= sendMailCalls + 1,   // +1 for the definition itself
    `${sendMailCalls} sendMail call site(s) but only ${outcomeReads - 1} read the result through ` +
    'deliveryOutcome(). A sender that builds its own success object cannot see a refused recipient.',
  );
});

test('SWEEP: no sender writes an unconditional `sent: true`', () => {
  // `sent` must be derived from what the transport reported, never asserted.
  const src = fs.readFileSync(path.join(__dirname, '..', 'monitor.js'), 'utf8');
  const offenders = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    // Prose about the bug is not the bug. Comment lines are excluded so the
    // explanation of why this rule exists can quote the thing it forbids.
    .filter(([, line]) => !/^\s*(\/\/|\/?\*)/.test(line))
    .filter(([, line]) => /(^|[^.\w])sent:\s*true\b/.test(line));

  assert.deepEqual(
    offenders.map(([n, l]) => `${n}: ${l.trim()}`),
    [],
    'these lines assert delivery instead of reading it from the transport result',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   Retrying a refused recipient

   Recording the refusal honestly was only half the fix. The refusal on
   2026-09-02 was TRANSIENT — the same mail server refused a recipient at 9:44
   and 9:46 and accepted normally from 9:47 — so the alert was recoverable and
   was simply never tried again. A three-minute hiccup became a permanently
   missing DOWN alert for an outage still in progress.
   ═══════════════════════════════════════════════════════════════════════════ */

const monitor = require('../monitor');

test('a 4xx refusal is temporary and worth retrying', () => {
  for (const code of [421, 450, 451, 452]) {
    assert.equal(monitor.isTransientRefusal(code), true, `${code} should be retried`);
  }
});

test('a 5xx refusal is final and must NOT be retried', () => {
  // Retrying "no such mailbox" three times changes nothing and delays the
  // record saying so.
  for (const code of [550, 551, 553, 554]) {
    assert.equal(monitor.isTransientRefusal(code), false, `${code} should not be retried`);
  }
});

test('a refusal with no code is assumed temporary', () => {
  // Giving up because the server was terse is how the original alert was lost.
  assert.equal(monitor.isTransientRefusal(null), true);
  assert.equal(monitor.isTransientRefusal(undefined), true);
});

test('per-address refusal codes are read from rejectedErrors', () => {
  const detail = monitor.refusalDetail({
    rejectedErrors: [
      { recipient: 'Temp@Example.org', responseCode: 451, message: 'greylisted' },
      { recipient: 'gone@example.org', responseCode: 550, message: 'no such user' },
    ],
  });
  assert.equal(detail.get('temp@example.org').code, 451, 'addresses are matched case-insensitively');
  assert.equal(detail.get('gone@example.org').code, 550);
});

test('the outcome splits retryable refusals from permanent ones', () => {
  const out = monitor.deliveryOutcome({
    accepted: ['ok@example.org'],
    rejected: ['temp@example.org', 'gone@example.org'],
    rejectedErrors: [
      { recipient: 'temp@example.org', responseCode: 451 },
      { recipient: 'gone@example.org', responseCode: 550 },
    ],
  }, ['ok@example.org', 'temp@example.org', 'gone@example.org']);

  assert.equal(out.delivery, 'partial');
  assert.deepEqual(out.retryableRejections, ['temp@example.org']);
  assert.deepEqual(out.permanentRejections, ['gone@example.org']);
});

test('THE REPORTED CASE: a transiently refused recipient is queued for retry', () => {
  // Exactly the 2026-09-02 shape: three recipients, one refused, refusal
  // temporary. The queue is what turns that into a late alert instead of none.
  const before = monitor._pendingDeliveries.length;
  const queued = monitor.queueDeliveryRetry({
    deliveryId: 'test-1',
    from: 'monitor@example.org',
    to: ['refused@example.org'],
    cc: [],
    subject: '🔴 KPFT HD2 — DOWN',
    html: '<p>down</p>',
  });

  assert.ok(queued, 'a retry must be scheduled');
  assert.equal(monitor._pendingDeliveries.length, before + 1);

  const job = monitor._pendingDeliveries[monitor._pendingDeliveries.length - 1];
  assert.deepEqual(job.to, ['refused@example.org'], 'ONLY the refused address is retried');
  assert.ok(job.nextAt > Date.now(), 'scheduled in the future, not sent inline');

  monitor._pendingDeliveries.length = before;   // leave the queue as we found it
});

test('nobody who already received the message is re-sent it', () => {
  // Re-sending the whole envelope would mail the two people who DID get the
  // alert a duplicate — its own kind of noise, and the reason the retry is
  // scoped to the refused addresses.
  const before = monitor._pendingDeliveries.length;
  monitor.queueDeliveryRetry({
    deliveryId: 'test-2',
    from: 'monitor@example.org',
    to: ['refused@example.org'],
    cc: [],
    subject: 's', html: 'h',
  });
  const job = monitor._pendingDeliveries[monitor._pendingDeliveries.length - 1];
  assert.ok(!job.to.includes('ok@example.org'));
  assert.equal(job.to.length, 1);
  monitor._pendingDeliveries.length = before;
});

test('nothing is queued when there is nothing retryable', () => {
  const before = monitor._pendingDeliveries.length;
  assert.equal(monitor.queueDeliveryRetry({
    deliveryId: 'test-3', from: 'a@example.org', to: [], cc: [], subject: 's', html: 'h',
  }), null);
  assert.equal(monitor._pendingDeliveries.length, before);
});

test('the retry pass is safe to run with an empty queue and no SMTP', async () => {
  // It runs inside the check cycle, so it must never throw there.
  await assert.doesNotReject(() => monitor.drainDeliveryRetries());
});
