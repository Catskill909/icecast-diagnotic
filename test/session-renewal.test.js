/* ═══════════════════════════════════════════════════════════════════════════
   A login in use stays signed in

   THE THIRD CAUSE of "the login keeps forgetting me", found 2026-09-13 after the
   first two were fixed. SESSION_SECRET was set (so restarts were not it) and the
   cookie was already SameSite=Lax (so inbound links were not it). The live
   /api/config reported sessionHours: 12 — and nothing ever renewed a session.
   Sign in, use the dashboard all day, and the next morning it has expired: a
   fixed lifetime counted from sign-in, experienced as being forgotten.

   The earlier tests checked a single token at a single instant, which is why
   none of them could see it. Every test here moves the clock, because the fault
   only exists over time: the property is that a session USED more often than
   its window never ends, one left idle does, and no amount of use carries a
   single sign-in past the cap.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = 'test-secret-for-signing-only';
delete process.env.SESSION_HOURS;
delete process.env.SESSION_MAX_DAYS;
const auth = require('../auth');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WINDOW = auth.SESSION_HOURS * HOUR;

/* A tiny browser: holds the cookie, sends it, and honours Set-Cookie including
   Max-Age — so a cookie the server let lapse is actually gone, as it would be. */
function browser(clock) {
  let cookie = null;
  let cookieExpires = 0;
  const jar = {
    header: () => (cookie && clock.now < cookieExpires ? `${auth.COOKIE_NAME}=${cookie}` : undefined),
    take(setCookie) {
      if (!setCookie) return;
      const value = setCookie.split(';')[0].split('=').slice(1).join('=');
      const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)[1]);
      cookie = decodeURIComponent(value);
      cookieExpires = clock.now + maxAge * 1000;
    },
  };
  return {
    signIn() {
      const res = response();
      auth.issueSession(request(jar, '/api/login'), res);
      jar.take(res.cookie);
    },
    /** One request through the renewal middleware; true if it arrived signed in. */
    visit(pathname = '/api/status') {
      const req = request(jar, pathname);
      const res = response();
      let signedIn = false;
      auth.refreshSession(req, res, () => { signedIn = !!auth.currentSession(req); });
      jar.take(res.cookie);
      return signedIn;
    },
    token: () => auth.verifySession(cookie),
  };
}
const request = (jar, pathname) => ({ path: pathname, secure: true, headers: { cookie: jar.header() } });
const response = () => ({ cookie: null, setHeader(name, v) { if (name === 'Set-Cookie') this.cookie = v; } });

/** Runs fn against a controllable Date.now, restoring the real one after. */
function withClock(fn) {
  const real = Date.now;
  const clock = { now: Date.UTC(2026, 8, 13, 9, 0, 0), advance(ms) { this.now += ms; } };
  Date.now = () => clock.now;
  try { fn(clock); } finally { Date.now = real; }
}

// ── The fault ───────────────────────────────────────────────────────────────

test('THE REPORTED FAULT: signed in, used all day, still signed in the next day', () => {
  withClock((clock) => {
    const b = browser(clock);
    b.signIn();
    for (let h = 0; h < 36; h++) {
      clock.advance(HOUR);
      assert.ok(b.visit(), `signed out ${h + 1}h after signing in, while in use`);
    }
  });
});

test('THE CLASS: any usage interval shorter than the window never signs you out before the cap', () => {
  // Deliberately includes intervals just under the window, and ones that land
  // exactly on the halfway point, where an off-by-one in the renewal test lives.
  for (const gap of [5 * 60 * 1000, HOUR, WINDOW / 2, WINDOW / 2 + 1, WINDOW - 60 * 1000]) {
    withClock((clock) => {
      const b = browser(clock);
      b.signIn();
      const signedInAt = clock.now;
      while (clock.now + gap < signedInAt + auth.SESSION_MAX_DAYS * DAY) {
        clock.advance(gap);
        assert.ok(b.visit(), `a visit every ${gap / HOUR}h was signed out after ${((clock.now - signedInAt) / DAY).toFixed(2)} days`);
      }
    });
  }
});

// ── What must still end ─────────────────────────────────────────────────────

test('left idle longer than the window, the session ends', () => {
  withClock((clock) => {
    const b = browser(clock);
    b.signIn();
    clock.advance(WINDOW + 1);
    assert.equal(b.visit(), false);
  });
});

test('use cannot carry one sign-in past the cap — renewal keeps the original sign-in time', () => {
  withClock((clock) => {
    const b = browser(clock);
    b.signIn();
    const signedInAt = clock.now;
    const cap = signedInAt + auth.SESSION_MAX_DAYS * DAY;
    while (clock.now < cap - HOUR) {
      clock.advance(HOUR);
      b.visit();
      assert.equal(b.token()?.iat, signedInAt, 'renewal must not reset the sign-in time');
      assert.ok(b.token().exp <= cap, 'no renewed token may expire past the cap');
    }
    clock.advance(2 * HOUR);
    assert.equal(b.visit(), false, 'a copied cookie in constant use must still die at the cap');
  });
});

test('an expired session is not resurrected by the renewal middleware', () => {
  // Sent directly, bypassing the browser's Max-Age, as a stale cookie replayed by
  // hand would be.
  withClock((clock) => {
    const token = auth.signSession({ sub: 'admin', iat: clock.now - DAY, exp: clock.now - 1 });
    const req = { path: '/api/status', secure: true, headers: { cookie: `${auth.COOKIE_NAME}=${token}` } };
    const res = response();
    auth.refreshSession(req, res, () => {});
    assert.equal(res.cookie, null, 'nothing may reissue a token for an expired session');
  });
});

test('a fresh session is not re-signed on every request', () => {
  withClock((clock) => {
    const req = { path: '/api/status', secure: true, headers: {} };
    const res = response();
    auth.issueSession(req, res);
    req.headers.cookie = res.cookie.split(';')[0];
    const again = response();
    clock.advance(HOUR);
    auth.refreshSession(req, again, () => {});
    assert.equal(again.cookie, null, 'renewal is only past halfway');
  });
});

test('login and logout are not overridden by the renewal middleware', () => {
  withClock((clock) => {
    const req = { path: '/api/logout', secure: true, headers: {} };
    const setup = response();
    auth.issueSession(req, setup);
    req.headers.cookie = setup.cookie.split(';')[0];
    clock.advance(WINDOW - HOUR);   // well past halfway, where renewal would fire
    const res = response();
    auth.refreshSession(req, res, () => {});
    assert.equal(res.cookie, null, 'a renewed cookie racing a logout would sign the reader back in');
  });
});

// ── The wiring ──────────────────────────────────────────────────────────────

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the renewal middleware is mounted before every gate and before static files', () => {
  const refresh = serverJs.indexOf('app.use(auth.refreshSession)');
  assert.ok(refresh > 0, 'server.js must mount auth.refreshSession');
  for (const later of ['if (!REQUIRE_LOGIN_FOR_READ) return next();', 'if (!ADMIN_PAGES.has(req.path)) return next();', 'express.static(']) {
    const at = serverJs.indexOf(later);
    assert.ok(at > refresh, `mounted after "${later}", so the requests it answers would not count as use`);
  }
});

test('sign-in issues its session through the same function renewal uses', () => {
  const login = serverJs.slice(serverJs.indexOf("app.post('/api/login'"), serverJs.indexOf("app.post('/api/logout'"));
  assert.match(login, /auth\.issueSession\(req, res\)/);
  assert.doesNotMatch(login, /signSession/, 'a second place computing expiry is how the two drift apart');
});

test('the default is a week idle and a month overall, not a fixed half day', () => {
  assert.equal(auth.SESSION_HOURS, 168);
  assert.equal(auth.SESSION_MAX_DAYS, 30);
});
