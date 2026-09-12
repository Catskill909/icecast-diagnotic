/* ═══════════════════════════════════════════════════════════════════════════
   "Did everything fail together?" is a question about ONE server

   On 2026-09-12 at 20:52 UTC the monitor's network path to streams.pacifica.org
   broke for 14 minutes. All six channels on that server — KPFT ×3, WPFW, KPFK
   and a KPFA channel — failed in the same cycle, and so did Pacifica's status
   endpoint. WBAI's and KPFA's own servers stayed healthy, and the streams played
   normally for listeners the whole time.

   The cross-stream correlation counted across EVERY monitored stream, a rule
   written when the monitor watched one server. Six of ten can never be "all",
   so the event was classified — and emailed to KPFT and KPFK — as a
   "Single stream" fault with "6 of 10 monitored streams failing".

   These tests are written against the SHAPE, not against Pacifica: any fleet
   of two servers where one server's streams all fail and the other's don't.

   The same alert also carried two sibling mistakes, tested at the bottom:
     · "Detected At 1:54:44 PM PDT CT" — a hard-coded Houston zone suffix
     · a "plaintext port" hint on a deadline hit AFTER TLS had completed
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'serverscope-'));
process.env.SEED_FILE = '/nonexistent';

const diagnose = require('../diagnose');
const monitor = require('../monitor');

const HOST_A = 'alpha.example.org:9000';   // the server whose path breaks
const HOST_B = 'beta.example.org';         // a healthy server alongside it

const streamOn = (host, p, extra = {}) => ({ id: `${host}${p}`, name: p, url: `https://${host}${p}`, ...extra });

const A1 = streamOn(HOST_A, '/one_128');
const A2 = streamOn(HOST_A, '/two_128');
const A3 = streamOn(HOST_A, '/three_128');
const B1 = streamOn(HOST_B, '/four_128');
const B2 = streamOn(HOST_B, '/five_128');

const timeout = {
  status: 'down', responseTime: 18000, error: 'No response within 18000ms', errorCode: 'EDEADLINE',
  timings: { dns: 7, tcp: 150, tls: 152, ttfb: null, total: 18000 },
};
const up = { status: 'up', responseTime: 300, timings: { dns: 5, tcp: 20, tls: 25, ttfb: 300 } };

/** Host A's status endpoint is unreachable too; host B is healthy. */
function snapshot() {
  return {
    byHost: {
      [HOST_A]: { reachable: false, fetchError: 'Status endpoint timed out', mounts: {}, mountCount: 0 },
      [HOST_B]: {
        reachable: true, serverStart: 'B', mountCount: 2,
        mounts: {
          '/four_128': { pathname: '/four_128', listeners: 69 },
          '/five_128': { pathname: '/five_128', listeners: 3 },
        },
      },
    },
    hosts: [HOST_A, HOST_B],
    reachable: false,
    mounts: {},
    mountCount: 2,
  };
}

const cycle = [
  { stream: A1, result: timeout },
  { stream: A2, result: timeout },
  { stream: A3, result: timeout },
  { stream: B1, result: up },
  { stream: B2, result: up },
];

test('every stream on one server failing is a server-level event, whatever other servers do', () => {
  for (const s of [A1, A2, A3]) {
    const dg = diagnose.classify({ stream: s, result: timeout, snapshot: snapshot(), prevSnapshot: snapshot(), cycle });
    assert.strictEqual(dg.scope, 'server',
      `${s.name}: a whole-server failure was scoped "${dg.scope}" because healthy streams on ANOTHER server were counted`);
    assert.ok(dg.evidence.some((e) => e.startsWith(`ALL 3 monitored streams on ${HOST_A}`)), dg.evidence.join('\n'));
    assert.ok(!dg.evidence.some((e) => / of 5 monitored streams/.test(e)),
      'the fleet-wide "N of M failing" count is back');
  }
});

test('a partial failure on one server is counted within that server only', () => {
  const partial = [
    { stream: A1, result: timeout },
    { stream: A2, result: timeout },
    { stream: A3, result: up },
    { stream: B1, result: timeout },
    { stream: B2, result: up },
  ];
  const dg = diagnose.classify({ stream: A1, result: timeout, snapshot: snapshot(), prevSnapshot: snapshot(), cycle: partial });
  assert.notStrictEqual(dg.scope, 'server');
  assert.ok(dg.evidence.includes(`2 of 3 monitored streams on ${HOST_A} are failing simultaneously.`), dg.evidence.join('\n'));
});

test('serverWideHosts names only servers whose every stream failed', () => {
  const all = [A1, A2, A3, B1, B2];
  assert.deepStrictEqual([...diagnose.serverWideHosts(all, [A1, A2, A3])], [HOST_A]);
  assert.deepStrictEqual([...diagnose.serverWideHosts(all, [A1, A2, B1])], [],
    'a failure spread across two servers is not either server failing');
  assert.deepStrictEqual([...diagnose.serverWideHosts(all, all)].sort(), [HOST_A, HOST_B].sort());
});

test('a server carrying a single stream never claims a server-level event', () => {
  const lone = streamOn('gamma.example.org', '/solo');
  assert.strictEqual(diagnose.serverWideHosts([A1, lone], [lone]).size, 0);
});

// ── The same alert's sibling mistakes ───────────────────────────────────────

test('a deadline hit after TLS completed does not suggest a plaintext port', () => {
  const dg = diagnose.classify({ stream: A1, result: timeout, snapshot: snapshot(), prevSnapshot: snapshot(), cycle });
  assert.ok(!dg.evidence.some((e) => /plaintext/.test(e)),
    'the handshake finished — the port demonstrably speaks HTTPS');
});

test('a deadline hit with the handshake never finished still raises the plaintext possibility', () => {
  const stalled = { ...timeout, timings: { dns: 7, tcp: 150, tls: null, ttfb: null } };
  const dg = diagnose.classify({ stream: A1, result: stalled, snapshot: snapshot(), prevSnapshot: snapshot(), cycle: [{ stream: A1, result: stalled }] });
  assert.ok(dg.evidence.some((e) => /plaintext/.test(e)), dg.evidence.join('\n'));
});

test('an alert timestamp names its zone once, for a station in any timezone', () => {
  for (const tz of ['America/Los_Angeles', 'America/New_York', 'America/Chicago']) {
    const { html } = monitor.composeAlert({
      kind: 'down',
      entries: [{
        stream: { ...A1, stationName: 'Station', stationTimezone: tz },
        result: timeout,
        diagnosis: { cause: 'timeout', causeLabel: 'Connection timeout', scope: 'server', evidence: [], remediation: [] },
        audience: { listenersBefore: 10 },
      }],
      scope: 'server',
    });
    const m = html.match(/Detected At[\s\S]*?<span[^>]*>([^<]+)<\/span>/);
    assert.ok(m, 'Detected At row present');
    const zones = m[1].match(/\b(?!AM\b|PM\b)[A-Z]{2,4}\b/g) || [];
    assert.strictEqual(zones.length, 1, `${tz}: "${m[1]}" names more than one zone`);
  }
});
