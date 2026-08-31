/* ═══════════════════════════════════════════════════════════════════════════
   Every public route that returns stored records redacts them

   redact.js is thorough and well tested. It has now failed twice anyway, both
   times the same way: **a projection protects the routes that were routed
   through it, and nothing makes a new or older route comply.**

     · 2026-08-27  /api/events returned stored events verbatim, publishing the
                   real staff addresses in every delivery record. redact.js was
                   written in response.
     · 2026-08-31  /api/status published `stationAlerts` — recipients attached to
                   each stream for the alert path. redact.js projects events and
                   station config; this came through neither.
     · 2026-08-31  /api/history — the older, back-compatible sibling of
                   /api/events — was still returning `monitor.getIncidents()`
                   raw. It was publishing the Icecast servers' own contact
                   addresses, and would have published real alert recipients the
                   moment a station with recipients had an outage inside its
                   24-hour window. KPFT has three.

   So this test does not check redact.js. It checks the ROUTES: any handler that
   reaches for stored events must either redact them or require a session.

   It is deliberately structural. A behavioural test would need the app booted
   and an outage staged inside a 24-hour window, which is exactly why nobody
   wrote one and why this shipped three times.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/** Every `app.<method>('<path>', ...)` handler, with its body. */
function routes() {
  const out = [];
  const re = /app\.(get|post|put|patch|delete)\('([^']+)'/g;
  let m;
  const starts = [];
  while ((m = re.exec(SERVER))) starts.push({ method: m[1], path: m[2], at: m.index });

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : SERVER.length;
    out.push({ ...starts[i], body: SERVER.slice(from, to) });
  }
  return out;
}

// Anything that reads stored records rich enough to name a person.
const READS_STORED_RECORDS = /monitor\.getIncidents\(|monitor\.getEvents\(/;

test('a route returning stored events either redacts or requires a session', () => {
  const offenders = routes()
    .filter((r) => READS_STORED_RECORDS.test(r.body))
    .filter((r) => !/redact\./.test(r.body) && !/auth\.requireAuth/.test(r.body))
    .map((r) => `${r.method.toUpperCase()} ${r.path}`);

  assert.deepEqual(offenders, [],
    `these publish stored events unredacted: ${offenders.join(', ')}`);
});

test('the routes that do redact are still doing it', () => {
  // Guards against the offenders list above being satisfied by deleting the
  // routes rather than protecting them.
  const redacting = routes().filter((r) => /redact\./.test(r.body)).map((r) => r.path);
  for (const p of ['/api/events', '/api/events/:id', '/api/history', '/api/stations']) {
    assert.ok(redacting.includes(p), `${p} no longer redacts anything`);
  }
});

test('redaction removes the Icecast server\'s own contact address', () => {
  // The field actually found published on /api/history against the live site.
  const { publicEvent } = require('../redact');
  const out = publicEvent({
    id: 'e1',
    diagnosis: { cause: 'source_disconnected', icecast: { admin: 'streams@stations1.pacifica.org', reachable: true } },
  });
  assert.equal(out.diagnosis.icecast.admin, undefined);
  assert.equal(out.diagnosis.icecast.reachable, true, 'the rest of the diagnosis survives');
});

test('redaction removes a delivery record\'s recipients but keeps the count', () => {
  const { publicEvent } = require('../redact');
  const out = publicEvent({
    id: 'e1',
    email: { sent: true, recipients: ['gm@kpft.org', 'omaclay@gmail.com'], cc: ['paul@hype.net'], messageId: '<x@mail>' },
  });
  assert.equal(JSON.stringify(out).includes('@'), false, 'no address-shaped string survives');
  assert.equal(out.email.recipientCount, 2);
  assert.equal(out.email.ccCount, 1);
  assert.equal(out.email.sent, true);
});
