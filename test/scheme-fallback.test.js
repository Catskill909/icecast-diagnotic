/* ═══════════════════════════════════════════════════════════════════════════
   Scheme correction and request deadlines

   A scheme is the one part of a pasted URL that is a GUESS. Operators copy
   https out of the browser bar and append the stream port, but an Icecast on
   :8000 is very often plaintext — and an https request to a plaintext port does
   not fail fast. It STALLS in the TLS handshake.

   Measured against a real server: https://stream.wbai.org:8000/status-json.xsl
   took ~15s to fail against a 10s socket timeout, because `timeout:` on an
   http(s) request is a socket-INACTIVITY timer and a stalled handshake is not
   idle. Three retries made it 48 seconds behind a spinner reading "Looking…".
   The same server answered over http in 184ms.

   Two independent defects, tested separately below: the timeout that does not
   bound, and the scheme that is never reconsidered.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const discover = require('../discover');

// ── Scheme correction ───────────────────────────────────────────────────────

test('the other scheme keeps an explicit port', () => {
  // The operator told us which port Icecast is on. Only the scheme is in doubt.
  const alt = discover.altSchemeUrl(new URL('https://h.example.org:8000/status-json.xsl'));
  assert.strictEqual(alt.href, 'http://h.example.org:8000/status-json.xsl');
});

test('the other scheme moves an implicit default port', () => {
  const alt = discover.altSchemeUrl(new URL('http://h.example.org/status-json.xsl'));
  assert.strictEqual(alt.href, 'https://h.example.org/status-json.xsl');
  assert.strictEqual(alt.port, '');
});

test('only transport failures are worth retrying on the other scheme', () => {
  // Reached a server and it answered: the scheme was right, something else is
  // wrong. Retrying would add delay and then report a more confusing error.
  assert.strictEqual(discover.isTransportFailure('HTTP_404'), false);
  assert.strictEqual(discover.isTransportFailure('HTTP_500'), false);
  assert.strictEqual(discover.isTransportFailure('EPARSE'), false);
  assert.strictEqual(discover.isTransportFailure(null), false);

  // Never reached a server. The scheme is a live suspect.
  assert.strictEqual(discover.isTransportFailure('ECONNRESET'), true);
  assert.strictEqual(discover.isTransportFailure('ETIMEDOUT'), true);
  assert.strictEqual(discover.isTransportFailure('EDEADLINE'), true);
  assert.strictEqual(discover.isTransportFailure('ECONNREFUSED'), true);
});

// ── The deadline ────────────────────────────────────────────────────────────

/**
 * A server that accepts the connection and then says nothing, ever.
 *
 * This is the shape a TLS handshake against a plaintext port leaves the client
 * in, reproduced without needing TLS: connected, not idle by the socket's
 * reckoning on some paths, and never going to answer.
 */
function blackHoleServer() {
  return new Promise((resolve) => {
    const sockets = [];
    const srv = net.createServer((s) => { sockets.push(s); /* never respond */ });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => { sockets.forEach((s) => s.destroy()); srv.close(); },
    }));
  });
}

test('a status fetch to a server that never answers is bounded, not left hanging', async () => {
  const srv = await blackHoleServer();
  // A deadline short enough to keep the suite fast; the mechanism is the point.
  process.env.ICECAST_STATUS_DEADLINE_MS = '600';
  process.env.ICECAST_STATUS_TIMEOUT_MS = '60000';   // socket timer that will NOT save us
  process.env.ICECAST_STATUS_ATTEMPTS = '1';
  delete require.cache[require.resolve('../diagnose')];
  const diagnose = require('../diagnose');

  const started = Date.now();
  try {
    const snap = await diagnose.fetchIcecastSnapshot(`http://127.0.0.1:${srv.port}/status-json.xsl`);
    const elapsed = Date.now() - started;

    assert.strictEqual(snap.reachable, false);
    assert.strictEqual(snap.fetchErrorCode, 'EDEADLINE',
      'the hard deadline is what must end this, not the socket inactivity timer');
    assert.ok(elapsed < 5000,
      `bounded by the deadline, took ${elapsed}ms — an unbounded stall is the 48-second freeze`);
  } finally {
    srv.close();
    delete process.env.ICECAST_STATUS_DEADLINE_MS;
    delete process.env.ICECAST_STATUS_TIMEOUT_MS;
    delete process.env.ICECAST_STATUS_ATTEMPTS;
    delete require.cache[require.resolve('../diagnose')];
  }
});

test('a probe to a server that never answers is bounded too', async () => {
  const srv = await blackHoleServer();
  process.env.REQUEST_DEADLINE_MS = '600';
  process.env.REQUEST_TIMEOUT_MS = '60000';
  delete require.cache[require.resolve('../diagnose')];
  const diagnose = require('../diagnose');

  const started = Date.now();
  try {
    const r = await diagnose.probeStream({ id: 'x', name: 'x', url: `http://127.0.0.1:${srv.port}/live` });
    const elapsed = Date.now() - started;

    assert.strictEqual(r.status, 'down');
    assert.strictEqual(r.errorCode, 'EDEADLINE');
    assert.ok(elapsed < 5000, `bounded by the deadline, took ${elapsed}ms`);
  } finally {
    srv.close();
    delete process.env.REQUEST_DEADLINE_MS;
    delete process.env.REQUEST_TIMEOUT_MS;
    delete require.cache[require.resolve('../diagnose')];
  }
});

// ── The interactive retry budget ────────────────────────────────────────────

test('attempts: 1 does not spend the monitor retry budget on a person waiting', async () => {
  // A server that refuses immediately. The monitor's 3 attempts with 2s gaps is
  // right for an unattended cycle and wrong in front of a button.
  const srv = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));   // nothing listening now

  const diagnose = require('../diagnose');
  const url = `http://127.0.0.1:${port}/status-json.xsl`;

  const one = await diagnose.fetchIcecastSnapshot(url, { attempts: 1 });
  assert.strictEqual(one.reachable, false);
  assert.strictEqual(one.attempts, 1, 'an interactive caller gets exactly one try');

  const many = await diagnose.fetchIcecastSnapshot(url, { attempts: 3 });
  assert.strictEqual(many.attempts, 3, 'the monitor keeps its retry budget');
});
