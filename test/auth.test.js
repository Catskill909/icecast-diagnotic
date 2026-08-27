/* ═══════════════════════════════════════════════════════════════════════════
   Admin authentication

   What this gate exists to stop: an anonymous visitor who finds the URL
   changing configuration or sending mail through the station's SMTP.
   `/api/test-alert` was doing exactly that with no credential at all.

   The properties worth pinning down are not "the right password works" — it is
   the failure modes: a tampered token, an expired one, a token signed with a
   different secret, and guessing being rate-limited rather than free.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');

process.env.SESSION_SECRET = 'test-secret-for-signing-only';
const auth = require('../auth');

// ── Password hashing ────────────────────────────────────────────────────────
test('a hashed password verifies, and the hash is not the password', () => {
  const stored = auth.hashPassword('correct horse battery staple');
  assert.ok(!stored.includes('correct horse'), 'the password must not appear in the hash');
  assert.equal(auth.verifyPassword('correct horse battery staple', stored), true);
});

test('the wrong password is rejected', () => {
  const stored = auth.hashPassword('right-password');
  assert.equal(auth.verifyPassword('wrong-password', stored), false);
  assert.equal(auth.verifyPassword('right-password ', stored), false, 'trailing space is a different password');
  assert.equal(auth.verifyPassword('', stored), false);
});

test('the same password hashed twice gives different hashes', () => {
  // Per-password random salt: two people choosing the same password must not
  // produce the same stored value.
  assert.notEqual(auth.hashPassword('same'), auth.hashPassword('same'));
});

test('malformed or missing stored hashes are rejected, not crashed on', () => {
  for (const bad of [null, undefined, '', 'plaintext', 'scrypt:only-two', 'bcrypt:a:b', 'scrypt:salt:nothex', {}, 42]) {
    assert.equal(auth.verifyPassword('anything', bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
});

test('a truncated hash is rejected rather than matching a short key', () => {
  const stored = auth.hashPassword('pw');
  const [, salt, key] = stored.split(':');
  assert.equal(auth.verifyPassword('pw', `scrypt:${salt}:${key.slice(0, 32)}`), false);
});

// ── Session tokens ──────────────────────────────────────────────────────────
test('a signed session round-trips', () => {
  const exp = Date.now() + 60000;
  const payload = auth.verifySession(auth.signSession({ sub: 'admin', exp }));
  assert.equal(payload.sub, 'admin');
  assert.equal(payload.exp, exp);
});

test('a tampered payload is rejected — this is the one that matters', () => {
  const token = auth.signSession({ sub: 'admin', exp: Date.now() + 60000 });
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + 99999999 })).toString('base64url');
  assert.equal(auth.verifySession(`${forged}.${sig}`), null, 'must not accept a re-signed-looking payload');
  assert.equal(auth.verifySession(`${body}.${sig}x`), null, 'must not accept a mangled signature');
});

test('an expired session is rejected', () => {
  assert.equal(auth.verifySession(auth.signSession({ sub: 'admin', exp: Date.now() - 1 })), null);
});

test('a session with no expiry is rejected rather than living forever', () => {
  assert.equal(auth.verifySession(auth.signSession({ sub: 'admin' })), null);
});

test('garbage tokens are rejected without throwing', () => {
  for (const bad of [null, undefined, '', 'nodot', '.', 'a.b', 'x'.repeat(500), 42, {}]) {
    assert.equal(auth.verifySession(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

// ── Cookies ─────────────────────────────────────────────────────────────────
test('the session cookie is parsed out from among others', () => {
  const req = { headers: { cookie: `other=1; ${auth.COOKIE_NAME}=abc123; trailing=2` } };
  assert.equal(auth.readCookie(req, auth.COOKIE_NAME), 'abc123');
});

test('a missing cookie header is not an error', () => {
  assert.equal(auth.readCookie({ headers: {} }, auth.COOKIE_NAME), null);
  assert.equal(auth.readCookie({}, auth.COOKIE_NAME), null);
});

test('the cookie is HttpOnly and SameSite=Strict', () => {
  // HttpOnly keeps XSS from reading it; SameSite=Strict is what blocks CSRF
  // against the write routes this gate protects.
  let header = null;
  const res = { setHeader: (_, v) => { header = v; } };
  auth.setSessionCookie({ headers: { 'x-forwarded-proto': 'https' }, secure: false }, res, 'tok');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/, 'Secure must be set when the request arrived over https');
});

test('Secure is omitted on plain http so local development still works', () => {
  let header = null;
  const res = { setHeader: (_, v) => { header = v; } };
  auth.setSessionCookie({ headers: {}, secure: false }, res, 'tok');
  assert.doesNotMatch(header, /Secure/);
});

// ── Rate limiting ───────────────────────────────────────────────────────────
test('repeated failures lock the client out', () => {
  const key = 'test-ip-' + Math.random();
  assert.equal(auth.lockoutRemaining(key), 0);
  for (let i = 0; i < auth.MAX_ATTEMPTS; i++) auth.recordFailure(key);
  assert.ok(auth.lockoutRemaining(key) > 0, 'must lock out after MAX_ATTEMPTS');
});

test('a successful login clears the failure count', () => {
  const key = 'test-ip-' + Math.random();
  for (let i = 0; i < auth.MAX_ATTEMPTS - 1; i++) auth.recordFailure(key);
  auth.clearFailures(key);
  for (let i = 0; i < auth.MAX_ATTEMPTS - 1; i++) auth.recordFailure(key);
  assert.equal(auth.lockoutRemaining(key), 0, 'the earlier failures must not still count');
});

// ── Fail closed ─────────────────────────────────────────────────────────────
test('with no password configured, protected routes REFUSE rather than open', () => {
  const saved = [process.env.ADMIN_PASSWORD_HASH, process.env.ADMIN_PASSWORD];
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD;
  try {
    assert.equal(auth.isConfigured(), false);
    let code = null;
    const res = { status(c) { code = c; return this; }, json() { return this; } };
    let nexted = false;
    auth.requireAuth({ headers: {} }, res, () => { nexted = true; });
    assert.equal(nexted, false, 'must NOT fall through to the handler');
    assert.equal(code, 503);
  } finally {
    if (saved[0] !== undefined) process.env.ADMIN_PASSWORD_HASH = saved[0];
    if (saved[1] !== undefined) process.env.ADMIN_PASSWORD = saved[1];
  }
});

test('configured but unauthenticated gets 401, not a pass', () => {
  process.env.ADMIN_PASSWORD_HASH = auth.hashPassword('secret12345');
  try {
    let code = null;
    const res = { status(c) { code = c; return this; }, json() { return this; } };
    let nexted = false;
    auth.requireAuth({ headers: {} }, res, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(code, 401);
  } finally { delete process.env.ADMIN_PASSWORD_HASH; }
});
