/* ═══════════════════════════════════════════════════════════════════════════
   Icecast status fetch — retry before declaring the server unreachable

   THE CLASS OF BUG THIS PREVENTS. Icecast is the witness the alert policy
   depends on: reachable + mount present means nobody lost audio, so no email.
   When the status fetch fails we lose that witness, listenerImpact becomes
   'unknown', and 'unknown' alerts. So a single dropped connection between the
   monitor and Pacifica — costing listeners nothing — paged people.

   Production bore this out: 141 of 443 events (32%) carried 'unknown', and of
   the 170 fetch failures behind them, 131 were one-second socket hang-ups.

   The rule these tests pin down: a transient failure must NOT be reported as
   unreachable, and a sustained one MUST be — a real server outage has to keep
   alerting exactly as before.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// diagnose.js reads its config at require time, so the environment is set first.
const PORT = 19833;
process.env.ICECAST_STATUS_URL = `http://127.0.0.1:${PORT}/status-json.xsl`;
process.env.ICECAST_STATUS_ATTEMPTS = '3';
process.env.ICECAST_STATUS_RETRY_MS = '10';   // keep the suite fast
const { fetchIcecastSnapshot } = require('../diagnose');

const GOOD = JSON.stringify({
  icestats: { server_id: 'Icecast 2.4.4', source: [{ listenurl: `http://127.0.0.1:${PORT}/live_128`, listeners: 22 }] },
});

// ONE server for the whole file. Rebinding the same port between tests races
// with the previous close() and produced phantom connection failures.
const behaviour = { failures: 0, body: GOOD, seen: 0 };
const srv = http.createServer((req, res) => {
  behaviour.seen += 1;
  if (behaviour.seen <= behaviour.failures) return req.socket.destroy();  // socket hang up
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(behaviour.body);
});

function arrange({ failures = 0, body = GOOD } = {}) {
  behaviour.failures = failures; behaviour.body = body; behaviour.seen = 0;
}

test.before(() => new Promise((r) => srv.listen(PORT, '127.0.0.1', r)));
test.after(() => new Promise((r) => srv.close(r)));

test('a single transient hang-up does NOT make the server look unreachable', async () => {
  arrange({ failures: 1 });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, true, 'the retry must rescue the cycle');
  assert.equal(snap.attempts, 2, 'and record that it took two tries');
  assert.equal(snap.mountCount, 1);
});

test('two consecutive hang-ups are still survived', async () => {
  arrange({ failures: 2 });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, true);
  assert.equal(snap.attempts, 3);
});

test('a sustained outage IS reported unreachable — real outages still alert', async () => {
  arrange({ failures: Infinity });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, false, 'a sustained outage must not be masked');
  assert.equal(snap.attempts, 3, 'after exhausting every attempt');
  assert.equal(behaviour.seen, 3, 'it really did ask three times');
});

test('a healthy server costs exactly one attempt', async () => {
  arrange({ failures: 0 });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, true);
  assert.equal(snap.attempts, 1, 'no retries when none are needed');
  assert.equal(behaviour.seen, 1, 'and no wasted requests against Icecast');
});

test('an unrepairable document is not retried — the bytes would be identical', async () => {
  arrange({ body: '<html>not icecast</html>' });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, false);
  assert.equal(snap.fetchErrorCode, 'EPARSE');
  assert.equal(snap.attempts, 1, 'must fail fast rather than burn the cycle');
  assert.equal(behaviour.seen, 1);
});

test('a malformed-but-repairable document needs no retry either', async () => {
  arrange({ body: GOOD.replace('"listeners":22', '"title": - ,"listeners":22') });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, true, 'the repair handles it on the first try');
  assert.equal(snap.repairedJson, true);
  assert.equal(snap.attempts, 1);
});

test('a hang-up followed by a repairable document still succeeds', async () => {
  // Both failure modes in one cycle: the retry recovers the transport, the
  // repair recovers the payload.
  arrange({ failures: 1, body: GOOD.replace('"listeners":22', '"title": - ,"listeners":22') });
  const snap = await fetchIcecastSnapshot();
  assert.equal(snap.reachable, true);
  assert.equal(snap.attempts, 2);
  assert.equal(snap.repairedJson, true);
});
