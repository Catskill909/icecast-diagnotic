/* ═══════════════════════════════════════════════════════════════════════════
   Public projections

   On 2026-08-27 /api/events was serving real staff email addresses to anyone
   who found the public URL. The delivery record on each event names every
   recipient — worth keeping, since it answers "who was told" — but the endpoint
   handed stored events to anonymous callers verbatim.

   The tests below are written against the CLASS. The specific fix (drop
   `recipients`) is checked, but the important tests are the sweeps: they scan a
   whole public projection for anything shaped like an email address, so a field
   added later that happens to carry one fails here rather than in production.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { publicEvent, publicEvents, publicStationConfig, publicIcecast } = require('../redact');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Every email-shaped string anywhere in a structure, however deeply nested. */
function emailsIn(value) {
  return JSON.stringify(value ?? null).match(EMAIL_RE) || [];
}

const EVENT = {
  id: 'evt-1',
  timestamp: '2026-08-27T00:00:00.000Z',
  streamId: 'kpft-main',
  severity: 'outage',
  diagnosis: { cause: 'source_disconnected', listenerImpact: 'confirmed' },
  audience: { listenersBefore: 42 },
  email: {
    attempted: true,
    sent: true,
    subject: 'KPFT Main is off air',
    recipients: ['gm@kpft.org', 'engineer@kpft.org'],
    cc: ['board@kpft.org'],
    messageId: '<abc@kpft.org>',
  },
};

// ── The specific leak ───────────────────────────────────────────────────────
test('recipient addresses are removed from an event', () => {
  const out = publicEvent(EVENT);
  assert.equal(out.email.recipients, undefined);
  assert.equal(out.email.cc, undefined);
});

test('but the delivery record stays legible as counts', () => {
  const out = publicEvent(EVENT);
  assert.equal(out.email.sent, true);
  assert.equal(out.email.recipientCount, 2, 'the history page can still say how many were told');
  assert.equal(out.email.ccCount, 1);
});

test('everything the dashboard renders is preserved', () => {
  const out = publicEvent(EVENT);
  assert.equal(out.severity, 'outage');
  assert.deepEqual(out.diagnosis, EVENT.diagnosis);
  assert.deepEqual(out.audience, EVENT.audience);
  assert.equal(out.email.subject, EVENT.email.subject);
});

// ── The class ───────────────────────────────────────────────────────────────
test('SWEEP: no email address survives anywhere in a public event', () => {
  // Addresses planted in every plausible field, including ones the redactor has
  // never been told about.
  const nasty = {
    ...EVENT,
    email: {
      ...EVENT.email,
      to: 'someone@example.org',
      bcc: ['hidden@example.org'],
      replyTo: 'reply@example.org',
      from: 'monitor@example.org',
    },
  };
  const found = emailsIn(publicEvent(nasty));
  assert.deepEqual(found, [], `these leaked: ${found.join(', ')}`);
});

test('SWEEP: a list of events is redacted, not just a single one', () => {
  const found = emailsIn(publicEvents([EVENT, EVENT, EVENT]));
  assert.deepEqual(found, [], `these leaked: ${found.join(', ')}`);
});

test('SWEEP: the real stored event record contains no addresses once projected', () => {
  // The actual production data, not a fixture — this is what was leaking.
  const file = path.join(__dirname, '..', 'data', 'events.json');
  if (!fs.existsSync(file)) return;   // fresh checkout; nothing to check
  const events = JSON.parse(fs.readFileSync(file, 'utf8')).events || [];
  if (!events.length) return;
  const found = [...new Set(emailsIn(publicEvents(events)))];
  assert.deepEqual(found, [], `real data leaked: ${found.join(', ')}`);
});

test('malformed events do not throw', () => {
  for (const bad of [null, undefined, 'string', 42, {}, { email: null }, { email: 'x' }]) {
    assert.doesNotThrow(() => publicEvent(bad));
  }
  assert.doesNotThrow(() => publicEvents(null));
});

// ── Station configuration is an allowlist ───────────────────────────────────
const CONFIG = {
  version: 1,
  hosts: [{ id: 'h1', host: 'streams.example.org:9000', statusUrl: 'https://admin:hunter2@streams.example.org:9000/admin/stats.xml' }],
  stations: [{
    id: 'kpft', name: 'KPFT', timezone: 'America/Chicago',
    channels: [{ id: 'main', name: 'Main', url: 'https://h/live_128', mounts: ['/live_128', '/live_64'] }],
  }],
};

test('the station config keeps what the UI needs', () => {
  const out = publicStationConfig(CONFIG);
  assert.equal(out.stations[0].name, 'KPFT');
  assert.deepEqual(out.stations[0].channels[0].mounts, ['/live_128', '/live_64']);
  assert.equal(out.hosts[0].host, 'streams.example.org:9000');
});

test('statusUrl is withheld — it can carry credentials', () => {
  const out = publicStationConfig(CONFIG);
  assert.equal(out.hosts[0].statusUrl, undefined);
  assert.doesNotMatch(JSON.stringify(out), /hunter2/, 'embedded credentials must never be served');
});

test('SWEEP: fields the projection has never heard of are NOT published', () => {
  // This is the property that matters. When per-station alert recipients land in
  // the config, they must be withheld without anyone editing redact.js.
  const future = {
    ...CONFIG,
    smtpPassword: 'hunter2',
    stations: [{
      ...CONFIG.stations[0],
      alertRecipients: ['gm@kpft.org', 'engineer@kpft.org'],
      escalationPhone: '+15551234567',
      channels: [{ ...CONFIG.stations[0].channels[0], sourcePassword: 'secret' }],
    }],
  };
  const json = JSON.stringify(publicStationConfig(future));
  assert.doesNotMatch(json, /gm@kpft\.org/, 'future recipients must not leak');
  assert.doesNotMatch(json, /hunter2/);
  assert.doesNotMatch(json, /secret/);
  assert.doesNotMatch(json, /5551234567/);
  assert.deepEqual(emailsIn(publicStationConfig(future)), []);
});

test('a malformed config does not throw', () => {
  for (const bad of [null, undefined, {}, { stations: null }, { stations: [{}] }]) {
    assert.doesNotThrow(() => publicStationConfig(bad));
  }
});

// ── Icecast diagnostics ─────────────────────────────────────────────────────
test('the Icecast admin contact is withheld', () => {
  const out = publicIcecast({ reachable: true, host: 'h:9000', admin: 'streams@pacifica.org', mountCount: 15 });
  assert.equal(out.admin, undefined);
  assert.equal(out.reachable, true, 'the useful fields survive');
  assert.equal(out.mountCount, 15);
  assert.deepEqual(emailsIn(out), []);
});
