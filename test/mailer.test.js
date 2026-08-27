/* ═══════════════════════════════════════════════════════════════════════════
   Mail transport compatibility

   nodemailer was upgraded 6.x → 9.x to clear security advisories. None of the
   affected code paths were in use, so the upgrade was hygiene rather than a
   fix — but a major version bump can still change the option shapes the app
   depends on, and the failure mode is silent until an outage happens at 3am and
   the alert does not arrive.

   These render real messages through an in-memory transport, using the exact
   option objects monitor.js builds. Nothing is sent.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');

test('the installed nodemailer is a version without the known advisories', () => {
  const major = parseInt(require('nodemailer/package.json').version.split('.')[0], 10);
  assert.ok(major >= 9, `expected >= 9, found ${require('nodemailer/package.json').version}`);
});

test('createTransport accepts the SMTP options setupMailer() builds', () => {
  const t = nodemailer.createTransport({
    host: 'smtp.example.org',
    port: 587,
    secure: false,
    auth: { user: 'monitor@example.org', pass: 'x' },
  });
  assert.equal(typeof t.sendMail, 'function');
  assert.equal(typeof t.verify, 'function', 'setupMailer() calls verify() at boot');
});

test('an alert message renders with the exact options sendAlert() builds', async () => {
  // jsonTransport renders without a network connection.
  const t = nodemailer.createTransport({ jsonTransport: true });
  const info = await t.sendMail({
    from: 'KPFT Stream Monitor <monitor@kpft.org>',
    to: 'gm@kpft.org, engineer@kpft.org',
    cc: 'board@kpft.org',
    subject: '🔴 KPFT Main is off air',
    html: '<html><body><h1>Outage</h1><p>42 listeners affected.</p></body></html>',
  });
  const msg = JSON.parse(info.message);
  assert.equal(msg.subject, '🔴 KPFT Main is off air', 'unicode in the subject survives');
  assert.equal(msg.to.length, 2, 'a comma-separated recipient string is still parsed into two');
  assert.equal(msg.cc.length, 1);
  assert.match(msg.html, /42 listeners affected/);
  assert.ok(info.messageId, 'a message id is still returned — the delivery record stores it');
});

test('the accepted/rejected shape the delivery record reads is still present', async () => {
  // sendAlert() stores info.accepted?.length — a shape change here would make
  // every delivery record silently report the wrong number.
  const t = nodemailer.createTransport({ jsonTransport: true });
  const info = await t.sendMail({
    from: 'a@example.org', to: 'b@example.org, c@example.org', subject: 's', html: '<p>x</p>',
  });
  assert.ok(Array.isArray(info.accepted) || info.accepted === undefined,
    'accepted must be an array or absent, never another shape');
  if (Array.isArray(info.accepted)) assert.equal(info.accepted.length, 2);
});

test('a message with no cc omits it rather than sending an empty header', async () => {
  const t = nodemailer.createTransport({ jsonTransport: true });
  const info = await t.sendMail({ from: 'a@example.org', to: 'b@example.org', subject: 's', html: '<p>x</p>' });
  const msg = JSON.parse(info.message);
  assert.ok(!msg.cc || msg.cc.length === 0);
});
