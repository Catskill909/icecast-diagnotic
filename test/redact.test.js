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

test('SWEEP: a delivery record leaks no address through a field the redactor never knew about', () => {
  // THIS is the test that was missing. The sweep above plants addresses only in
  // fields the projection already names, so it passed while `rejected` — added
  // to the delivery record later, holding the addresses a mail server refused —
  // was published to anonymous callers on every partially-delivered alert.
  //
  // An allowlist is what makes this test possible to pass at all: an unknown
  // field is withheld because it is unknown, not because someone predicted it.
  const nasty = {
    ...EVENT,
    email: {
      ...EVENT.email,
      rejected: ['bounced@example.org'],
      envelope: { from: 'monitor@example.org', to: ['gm@example.org'] },
      somethingAddedNextYear: 'escalate to oncall@example.org',
      error: '550 5.1.1 <refused@example.org>: Recipient address rejected',
      reason: 'no recipients configured for admin@example.org',
    },
  };
  const found = emailsIn(publicEvent(nasty));
  assert.deepEqual(found, [], `these leaked: ${found.join(', ')}`);
});

test('but a refused recipient is still COUNTED, so the page can say delivery was partial', () => {
  const out = publicEvent({
    ...EVENT,
    email: { ...EVENT.email, delivery: 'partial', accepted: 2, rejected: ['bounced@example.org'] },
  });
  assert.equal(out.email.rejectedCount, 1, 'the history page must be able to show partial delivery');
  assert.equal(out.email.rejected, undefined, 'without naming who bounced');
  assert.equal(out.email.delivery, 'partial');
  assert.equal(out.email.accepted, 2);
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

// ── Source-level guard ──────────────────────────────────────────────────────
test('no advice or error-catalogue constant contains an email address', () => {
  // The leak that free-text scrubbing exists to cover came from a hardcoded
  // string in diagnose.js: an administrator's address inside remediation advice,
  // stored on every matching event. Scrubbing covers events already written;
  // this stops a new one being introduced, and also keeps station-specific
  // contacts out of advice that other stations will read.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'diagnose.js'), 'utf8');
  // Only string literals, so the email-shaped regex in the file itself is not a hit.
  const literals = src.match(/'[^'\n]*'|"[^"\n]*"/g) || [];
  const offenders = literals.filter((s) => EMAIL_RE.test(s) && (EMAIL_RE.lastIndex = 0) === 0);
  assert.deepEqual(offenders, [], `address-bearing literals in diagnose.js: ${offenders.join(' ')}`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Per-station alert recipients are not published

   The allowlist in publicStationConfig() was written before this field existed,
   specifically so that a field added later would be withheld without anyone
   remembering to come back here. This asserts that it worked — the claim is
   worth nothing untested, and the cost of it being wrong is every station's
   staff addresses served to anyone who loads /api/stations.
   ═══════════════════════════════════════════════════════════════════════════ */

test('a station\'s alert recipients are withheld from anonymous callers', () => {
  const config = {
    version: 1,
    hosts: [{ id: 'h', host: 'streams.example.org:9000', statusUrl: 'https://u:p@streams.example.org:9000/admin/stats.xml' }],
    stations: [{
      id: 'wpfw',
      name: 'WPFW Washington DC',
      timezone: 'America/New_York',
      alerts: { enabled: true, recipients: ['gm@wpfw.org'], cc: ['eng@pacifica.org'] },
      channels: [{ id: 'wpfw', name: 'WPFW', url: 'https://streams.example.org:9000/wpfw_128', mounts: ['/wpfw_128'] }],
    }],
  };

  const pub = publicStationConfig(config);
  const serialised = JSON.stringify(pub);

  assert.equal(pub.stations[0].alerts, undefined, 'the alert block must not be projected');
  assert.equal(/gm@wpfw\.org|eng@pacifica\.org/.test(serialised), false,
    'no recipient address may appear anywhere in the public response');
  assert.equal(serialised.includes('u:p@'), false, 'nor may a status URL carrying credentials');

  // The station itself is still fully described — withholding must not turn
  // into hiding what is monitored, which is the part the public pages render.
  assert.equal(pub.stations[0].name, 'WPFW Washington DC');
  assert.equal(pub.stations[0].channels[0].id, 'wpfw');
});
