/* ═══════════════════════════════════════════════════════════════════════════
   End-to-end: a refused alert reaches its recipient anyway

   The unit tests around deliveryOutcome() and queueDeliveryRetry() prove the
   PARTS behave. This proves the LOOP does — refusal → queue → retry → the
   stored event record corrected — which is the only thing that would actually
   have got the 2026-09-02 DOWN alert to the recipient the mail server refused.

   The transport here refuses one address with a 451 on the first attempt and
   accepts it on the second, which is exactly what hype.net did across the
   9:44 → 9:47 window and what no real SMTP server will do on cue.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// store.js resolves DATA_DIR once at module load, so this must precede the
// require below or the test writes into the real data volume.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-e2e-'));

const store = require('../store');
const monitor = require('../monitor');

const REFUSED = 'refused@example.org';
const OK = ['gm@example.org', 'engineer@example.org'];

/** A transport that refuses REFUSED until `acceptFrom` calls have happened. */
function flakyTransport(acceptFrom) {
  let calls = 0;
  return {
    calls: () => calls,
    sendMail: async ({ to }) => {
      calls++;
      const addrs = String(to).split(',').map((a) => a.trim());
      const refuse = calls < acceptFrom ? addrs.filter((a) => a === REFUSED) : [];
      return {
        messageId: `<m${calls}@example.org>`,
        accepted: addrs.filter((a) => !refuse.includes(a)),
        rejected: refuse,
        rejectedErrors: refuse.map((a) => ({ recipient: a, responseCode: 451, message: 'greylisted, try again' })),
      };
    },
  };
}

test('a transiently refused recipient is delivered to on retry, and the event says so', async () => {
  // The ORIGINAL send was already refused — that is what the event below
  // records. This transport is the 9:47 mail server: it accepts.
  const transport = flakyTransport(1);
  monitor._setTransporter(transport);

  const deliveryId = 'e2e-recover';

  // The event as the monitor would have stored it: the message went out, two
  // people got it, one was refused.
  const event = store.addEvent({
    timestamp: new Date().toISOString(),
    streamId: 'kpft-hd2',
    streamName: 'KPFT HD2',
    type: 'down',
    severity: 'outage',
    email: {
      attempted: true, sent: true, delivery: 'partial',
      deliveryId, accepted: 2,
      recipients: [...OK, REFUSED],
      rejected: [REFUSED], rejectedCount: 1,
    },
  });

  monitor.queueDeliveryRetry({
    deliveryId,
    from: 'monitor@example.org',
    to: [REFUSED],
    cc: [],
    subject: '🔴 KPFT HD2 — DOWN',
    html: '<p>down</p>',
  });

  const job = monitor._pendingDeliveries[monitor._pendingDeliveries.length - 1];
  assert.ok(job, 'a retry was queued');
  job.nextAt = Date.now() - 1;                  // due now, rather than waiting a minute

  await monitor.drainDeliveryRetries();

  // The retry went ONLY to the refused address.
  assert.equal(transport.calls(), 1, 'exactly one retry send');

  const after = store.getEvents({ limit: 500 }).events.find((e) => e.id === event.id);
  assert.equal(after.email.delivery, 'all', 'the record now says everyone received it');
  assert.equal(after.email.rejectedCount, 0);
  assert.equal(after.email.retry.recovered, true);
  assert.equal(after.email.retry.attempts, 1);
  assert.ok(after.email.retry.deliveredAt);

  assert.equal(monitor._pendingDeliveries.includes(job), false, 'the job is off the queue');
});

test('a recipient that keeps being refused is given up on, and the event names them', async () => {
  // Refusing forever: the schedule must end rather than retry indefinitely.
  monitor._setTransporter(flakyTransport(Infinity));

  const deliveryId = 'e2e-exhaust';
  const event = store.addEvent({
    timestamp: new Date().toISOString(),
    streamId: 'kpft-main',
    streamName: 'KPFT Main',
    type: 'down',
    severity: 'outage',
    email: {
      attempted: true, sent: true, delivery: 'partial',
      deliveryId, recipients: [...OK, REFUSED], rejected: [REFUSED], rejectedCount: 1,
    },
  });

  monitor.queueDeliveryRetry({
    deliveryId, from: 'monitor@example.org', to: [REFUSED], cc: [],
    subject: '🔴 KPFT Main — DOWN', html: '<p>down</p>',
  });
  const job = monitor._pendingDeliveries[monitor._pendingDeliveries.length - 1];

  // Drive the whole schedule.
  for (let i = 0; i < 10 && monitor._pendingDeliveries.includes(job); i++) {
    job.nextAt = Date.now() - 1;
    await monitor.drainDeliveryRetries();
  }

  assert.equal(monitor._pendingDeliveries.includes(job), false, 'the queue does not grow forever');

  const after = store.getEvents({ limit: 500 }).events.find((e) => e.id === event.id);
  assert.equal(after.email.retry.exhausted, true);
  assert.deepEqual(after.email.retry.stillRefused, [REFUSED], 'the record names who never got it');
  assert.equal(after.email.delivery, 'partial', 'and it is still not claiming full delivery');
});

test('a permanently refused address is never queued at all', () => {
  // 550 means the mailbox does not exist. Three more attempts change nothing
  // and only delay the record saying so.
  const out = monitor.deliveryOutcome({
    accepted: OK,
    rejected: ['gone@example.org'],
    rejectedErrors: [{ recipient: 'gone@example.org', responseCode: 550, message: 'no such user' }],
  }, [...OK, 'gone@example.org']);

  assert.deepEqual(out.retryableRejections, []);
  assert.deepEqual(out.permanentRejections, ['gone@example.org']);

  const before = monitor._pendingDeliveries.length;
  assert.equal(monitor.queueDeliveryRetry({
    deliveryId: 'e2e-perm', from: 'a@example.org',
    to: out.retryableRejections, cc: [], subject: 's', html: 'h',
  }), null);
  assert.equal(monitor._pendingDeliveries.length, before);
});

test('the retry never re-sends to someone who already received the message', async () => {
  const transport = flakyTransport(2);
  monitor._setTransporter(transport);

  const sentTo = [];
  const spy = { sendMail: async (opts) => { sentTo.push(opts.to); return transport.sendMail(opts); } };
  monitor._setTransporter(spy);

  monitor.queueDeliveryRetry({
    deliveryId: 'e2e-noduplicate', from: 'monitor@example.org',
    to: [REFUSED], cc: [], subject: 's', html: 'h',
  });
  const job = monitor._pendingDeliveries[monitor._pendingDeliveries.length - 1];
  job.nextAt = Date.now() - 1;
  await monitor.drainDeliveryRetries();

  assert.equal(sentTo.length, 1);
  for (const addr of OK) {
    assert.ok(!sentTo[0].includes(addr), `${addr} already received it and must not be mailed twice`);
  }
});
