/* ═══════════════════════════════════════════════════════════════════════════
   Signing in must return you to where you were, and stay signed in

   TWO REPORTED FAULTS, both of which look like the login "not working" and
   neither of which is in the login:

   1. The Audience page's "Sign in" link went to /login.html with no `next`, so
      after signing in the reader landed on the dashboard — having lost the
      station and range they had selected. Every other caller passed `next`;
      this one link did not.

   2. Sessions did not survive a redeploy. SESSION_SECRET was unset, so auth.js
      generated an EPHEMERAL one at boot and every restart invalidated every
      cookie. Sign-in works, the session works, and then it silently forgets —
      an operator experiences "the login keeps forgetting me" with nothing on
      screen to explain it, because the warning is in a container log. It is now
      a capability flag in /api/config, beside emailConfigured, so a deployment
      can be checked rather than guessed at.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const listeners = fs.readFileSync(path.join(root, 'public/listeners.js'), 'utf8');
const loginJs = fs.readFileSync(path.join(root, 'public/login.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// ── 1. The return path ──────────────────────────────────────────────────────

test('the Audience page sends you back to the Audience page', () => {
  const link = listeners.slice(listeners.indexOf("class=\"deep-signin\""));
  assert.match(
    link.slice(0, 200), /login\.html\?next=\$\{encodeURIComponent\(location\.pathname \+ location\.search\)\}/,
    'a Sign in link with no next drops the reader on the dashboard',
  );
});

test('the selected station survives the round trip', () => {
  // The link is built from pathname + search, so ?station=kpft comes back too.
  const built = (pathname, search) =>
    `/login.html?next=${encodeURIComponent(pathname + search)}`;
  const url = built('/listeners.html', '?station=kpft');
  const next = new URLSearchParams(url.split('?').slice(1).join('?')).get('next');
  assert.equal(next, '/listeners.html?station=kpft',
    'losing the station means signing in and arriving at a different station');
});

/* ── The guard that makes `next` safe to accept at all ──────────────────────
   `next` arrives in a URL and is therefore attacker-supplied. */
function nextOf(search) {
  const ctx = { location: { search }, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(loginJs.slice(loginJs.indexOf('  function next() {'), loginJs.indexOf('  $(\'step1\')')), ctx);
  return ctx.next();
}

test('an absolute URL in next is refused, not followed', () => {
  assert.equal(nextOf('?next=https://evil.example/login'), '/');
  assert.equal(nextOf('?next=//evil.example'), '/', 'protocol-relative is still off-site');
  assert.equal(nextOf('?next=javascript:alert(1)'), '/');
});

test('a same-origin path is honoured', () => {
  assert.equal(nextOf('?next=%2Flisteners.html%3Fstation%3Dkpft'), '/listeners.html?station=kpft');
  assert.equal(nextOf(''), '/', 'no next is the dashboard, as before');
});

// ── 2. The session capability flag ──────────────────────────────────────────

function configBody({ secretConfigured, passwordConfigured }) {
  const start = serverJs.indexOf("app.get('/api/config'");
  const end = serverJs.indexOf('// ── Station Configuration', start);
  let handler;
  const ctx = {
    app: { get(_r, fn) { handler = fn; } },
    monitor: { getConfig: () => ({ emailConfigured: true, streams: [] }) },
    auth: {
      isConfigured: () => passwordConfigured,
      SESSION_SECRET_CONFIGURED: secretConfigured,
      SESSION_HOURS: 12,
    },
  };
  vm.createContext(ctx);
  vm.runInContext(serverJs.slice(start, end), ctx);
  let out;
  handler({}, { json(v) { out = v; } });
  return out;
}

test('a correctly configured deployment reports so', () => {
  const c = configBody({ secretConfigured: true, passwordConfigured: true });
  assert.equal(c.auth.sessionSecretConfigured, true);
  assert.equal(c.auth.passwordConfigured, true);
  assert.equal(c.auth.sessionHours, 12);
});

test('THE FAULT IS VISIBLE: a missing SESSION_SECRET is reported, not hidden', () => {
  const c = configBody({ secretConfigured: false, passwordConfigured: true });
  assert.equal(
    c.auth.sessionSecretConfigured, false,
    'without this the operator can only see that sign-in "keeps forgetting", never why',
  );
});

test('the flag carries no secret, only booleans and a duration', () => {
  const c = configBody({ secretConfigured: true, passwordConfigured: true });
  assert.deepEqual(
    Object.keys(c.auth).sort(),
    ['passwordConfigured', 'sessionHours', 'sessionSecretConfigured'],
    'this endpoint is public — a hash or a secret must never appear here',
  );
  for (const v of Object.values(c.auth)) {
    assert.ok(typeof v === 'boolean' || typeof v === 'number', `unexpected value type: ${typeof v}`);
  }
});

test('it does not disturb the rest of the config payload', () => {
  const c = configBody({ secretConfigured: true, passwordConfigured: true });
  assert.equal(c.emailConfigured, true);
  assert.ok(Array.isArray(c.streams));
});
