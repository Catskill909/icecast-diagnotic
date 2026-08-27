/* ═══════════════════════════════════════════════════════════════════════════
   Server-side fetch guard

   Written before the add-station flow exists, because the flow's whole appeal —
   "paste a URL and we discover the rest" — is a server-side request to an
   address someone else chose. The tests are the specification for that feature.

   The cases that matter are the bypasses, not the happy path: a hostname that
   resolves to loopback, an IPv4 address wearing an IPv6 costume, and a redirect
   from a permitted host to a forbidden one.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { validateUrl, assertPublicHost, assertFetchable, isBlockedAddress } = require('../safe-url');

// ── Scheme and structure ────────────────────────────────────────────────────
test('http and https are accepted', () => {
  assert.equal(validateUrl('https://streams.pacifica.org:9000/status-json.xsl').ok, true);
  assert.equal(validateUrl('http://example.org:8000/status-json.xsl').ok, true);
});

test('other schemes are refused — they are ways to read something else', () => {
  for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/html,x', 'javascript:alert(1)']) {
    const r = validateUrl(u);
    assert.equal(r.ok, false, `${u} must be refused`);
    assert.match(r.reason, /scheme|valid URL/i);
  }
});

test('credentials embedded in the URL are refused', () => {
  // They would be forwarded upstream and stored in configuration.
  const r = validateUrl('https://admin:hunter2@example.org/admin/stats.xml');
  assert.equal(r.ok, false);
  assert.match(r.reason, /username and password/i);
});

test('junk input is refused without throwing', () => {
  for (const u of ['', '   ', null, undefined, 'not a url', 42, {}]) {
    assert.equal(validateUrl(u).ok, false);
  }
});

// ── The addresses that matter ───────────────────────────────────────────────
test('cloud metadata is blocked', () => {
  // The single most valuable SSRF target on a cloud host.
  assert.equal(isBlockedAddress('169.254.169.254'), true);
  assert.equal(validateUrl('http://169.254.169.254/latest/meta-data/').ok, false);
});

test('loopback and private ranges are blocked', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.0.1',
                    '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.1.1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('adjacent public addresses are NOT blocked — the ranges are not too greedy', () => {
  for (const ip of ['9.255.255.255', '11.0.0.1', '172.15.255.255', '172.32.0.1',
                    '192.167.1.1', '192.169.1.1', '8.8.8.8', '1.1.1.1']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
});

test('IPv6 loopback and local ranges are blocked', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('an IPv4 address wearing an IPv6 costume is still blocked', () => {
  // The classic bypass: ::ffff:127.0.0.1 is loopback written as IPv6.
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false, 'a mapped PUBLIC address is fine');
});

test('a zone index does not smuggle a link-local address through', () => {
  assert.equal(isBlockedAddress('fe80::1%eth0'), true);
});

test('anything that is not an IP at all is refused', () => {
  for (const x of ['', 'localhost', 'not-an-ip', '999.999.999.999', '1.2.3', null]) {
    assert.equal(isBlockedAddress(x), true, `${x} must be refused`);
  }
});

// ── Resolution is where the real check happens ──────────────────────────────
test('a hostname resolving to loopback is refused — this is the whole point', async () => {
  // Checking the text of the URL is not enough: localhost is a public-looking
  // name that resolves somewhere private.
  await assert.rejects(() => assertPublicHost('localhost'), /private or reserved/);
});

test('a literal blocked address is refused without a DNS lookup', async () => {
  await assert.rejects(() => assertPublicHost('127.0.0.1'), /private or reserved/);
  await assert.rejects(() => assertFetchable('http://127.0.0.1:8000/status-json.xsl'), /private or reserved/);
});

test('an unresolvable hostname is refused clearly', async () => {
  await assert.rejects(
    () => assertPublicHost('this-name-does-not-exist.invalid'),
    /Could not resolve/,
  );
});

test('a real public host passes the full check', async () => {
  const url = await assertFetchable('https://streams.pacifica.org:9000/status-json.xsl');
  assert.equal(url.hostname, 'streams.pacifica.org');
  assert.equal(url.port, '9000');
});

test('the error does not echo the private address back', async () => {
  // What it resolved to is information about the network behind us that the
  // person asking does not otherwise have.
  await assert.rejects(() => assertPublicHost('localhost'), (e) => {
    assert.doesNotMatch(e.message, /127\.0\.0\.1|::1/, 'must not disclose the resolved address');
    return true;
  });
});
