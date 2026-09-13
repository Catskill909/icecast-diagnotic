/* ═══════════════════════════════════════════════════════════════════════════
   Admin authentication — the minimum gate

   SCOPE, DELIBERATELY SMALL. This is not the eventual login. It is one shared
   admin credential and a signed cookie, enough to stop an anonymous visitor
   changing configuration or sending mail. Per-user accounts, roles and
   per-station scoping come later; the middleware boundary here is what lets
   that arrive without revisiting every route.

   WHY IT COMES BEFORE THE ADMIN PANEL. The dashboard is deliberately open, and
   reading stats is harmless. Writing is not: an unprotected panel would let
   anyone who finds the URL delete a station, redirect alert emails to
   themselves, or add junk streams. `/api/test-alert` already sends mail through
   the station's SMTP with no credential at all, which is the hole this closes on
   day one.

   NO NEW DEPENDENCIES. Everything here is `node:crypto`.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* HOW LONG A SESSION LASTS — a sliding window with an absolute cap.

   It was a fixed 12 hours from sign-in, never renewed. Every other cause of
   "the login keeps forgetting me" had been fixed (an ephemeral secret,
   SameSite=Strict) and it still happened daily, because that was the design:
   sign in in the morning, and the next morning the cookie has expired no matter
   how much the dashboard was used in between.

   SESSION_HOURS is now an IDLE window. Any signed-in request past the halfway
   point reissues the cookie (see refreshSession), so a login in use stays signed
   in. SESSION_MAX_DAYS caps how long one sign-in can be carried forward:
   renewal keeps the original sign-in time, so a copied cookie cannot be kept
   alive indefinitely just by using it. */
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS, 10) || 168;
const SESSION_MAX_DAYS = parseInt(process.env.SESSION_MAX_DAYS, 10) || 30;
const COOKIE_NAME = 'kpft_admin';
const SCRYPT_KEYLEN = 64;

// Brute-force protection. This — not the shape of the login form — is what
// actually stops password guessing.
const MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS, 10) || 5;
const LOCKOUT_MS = (parseInt(process.env.LOGIN_LOCKOUT_MIN, 10) || 15) * 60 * 1000;
const attempts = new Map();   // ip → { count, until }

// A secret is required to sign sessions. Generating an ephemeral one keeps a
// misconfigured deployment working rather than crashing, at the cost of logging
// everyone out on restart — which is announced, not silent.
let SESSION_SECRET = process.env.SESSION_SECRET || '';
/* WHETHER IT WAS CONFIGURED, reported as a capability flag.

   An ephemeral secret is silently wrong in the one way nobody reports as a bug:
   sign-in works, the session works, and then a redeploy logs everybody out
   again. The operator experiences "the login keeps forgetting me" and has no
   way to see why, because the warning is in a container log and the difference
   is invisible from outside. Published in /api/config beside emailConfigured,
   it becomes a thing a deploy can be checked against. */
const SESSION_SECRET_CONFIGURED = !!SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[Auth] SESSION_SECRET is not set — generated an ephemeral one. Sessions will not survive a restart.');
}

// ── Password hashing ────────────────────────────────────────────────────────
/**
 * scrypt with a per-password random salt, stored as `scrypt:salt:key`.
 * Deliberately slow: the whole point is that guessing is expensive.
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt:${salt}:${key}`;
}

/**
 * Constant-time verification. A plain `===` on the derived key leaks how much
 * of it matched through timing, which is enough to recover it byte by byte.
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, key] = parts;
  let expected;
  try { expected = Buffer.from(key, 'hex'); } catch { return false; }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * The configured admin credential, as a hash.
 *
 * ADMIN_PASSWORD_HASH is preferred. ADMIN_PASSWORD is accepted because it is
 * what someone will reach for first, but it is hashed at boot and its use is
 * logged — anyone with hosting-panel access can read a plaintext env var.
 */
let warnedPlaintext = false;
function configuredHash() {
  if (process.env.ADMIN_PASSWORD_HASH) return process.env.ADMIN_PASSWORD_HASH.trim();
  const plain = (process.env.ADMIN_PASSWORD || '').trim();
  if (!plain) return null;
  if (!warnedPlaintext) {
    console.warn('[Auth] Using ADMIN_PASSWORD (plaintext). Prefer ADMIN_PASSWORD_HASH — run: node scripts/hash-password.js');
    warnedPlaintext = true;
  }
  return hashPassword(plain, 'kpft-static-salt-for-plaintext-env');
}

function isConfigured() { return !!configuredHash(); }

/** The configured admin username. Defaults to 'admin' when unset. */
function configuredUser() {
  return (process.env.ADMIN_USER || 'admin').trim();
}

/**
 * Constant-time username comparison.
 *
 * Hashed before comparing so that two names of different lengths still compare
 * over equal-length buffers — timingSafeEqual throws on a length mismatch, and
 * returning early on length would leak the username's length.
 */
function verifyUser(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(configuredUser()).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies a full credential pair.
 *
 * Both halves are always checked, even when the username is already wrong, so
 * the response time does not reveal which half failed. This is what keeps a
 * two-step login form from becoming a username enumerator: the first screen can
 * accept anything and advance, because nothing is decided until here.
 */
function verifyCredentials(username, password) {
  const userOk = verifyUser(username);
  const passOk = verifyPassword(password, configuredHash());
  return userOk && passOk;
}

// ── Session tokens ──────────────────────────────────────────────────────────
// Stateless and signed rather than stored server-side: there is one user, and a
// signed token survives a redeploy without a session table.
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Signs a session and sets its cookie. The ONLY place a session is issued, so
 * sign-in and renewal cannot disagree about how long one lasts.
 *
 * `signedInAt` is when the credential was actually entered. Renewal passes the
 * original value through, which is what makes SESSION_MAX_DAYS a real cap.
 */
function issueSession(req, res, signedInAt = Date.now()) {
  const exp = expiryFor(signedInAt);
  setSessionCookie(req, res, signSession({ sub: 'admin', iat: signedInAt, exp }), exp - Date.now());
  return exp;
}

/** A full idle window from now, but never past the cap for this sign-in. */
function expiryFor(signedInAt) {
  return Math.min(Date.now() + SESSION_HOURS * 3600 * 1000, signedInAt + SESSION_MAX_DAYS * 86400 * 1000);
}

/**
 * Middleware: carries a session in use forward. Mounted before every gate, so
 * any signed-in request — a page, an asset, the dashboard's own polling — counts
 * as use.
 *
 * Reissues only past the halfway point, so a busy page is not re-signing a
 * cookie on every request, and only when the new expiry is actually later: at
 * the absolute cap there is nothing to extend, and the session ends there.
 */
function refreshSession(req, res, next) {
  if (req.path === '/api/login' || req.path === '/api/logout') return next();
  const session = currentSession(req);
  // At-or-past, not strictly past: with `<`, a reader visiting exactly every half
  // window arrives at the halfway mark each time, never renews, and is signed out.
  const pastHalfway = session && session.exp - Date.now() <= (SESSION_HOURS * 3600 * 1000) / 2;
  // A token with no sign-in time cannot be capped, so it is left to expire.
  if (pastHalfway && Number.isFinite(session.iat) && expiryFor(session.iat) > session.exp) {
    issueSession(req, res, session.iat);
  }
  next();
}

// ── Cookies ─────────────────────────────────────────────────────────────────
// Parsed by hand to avoid adding cookie-parser for one header.
function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, token, lifetimeMs = SESSION_HOURS * 3600 * 1000) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',                       // unreadable from JavaScript, so XSS cannot steal it
    /* LAX, NOT STRICT, and the difference is felt daily.

       Strict withholds the cookie on ANY navigation originating off-site, so
       opening the dashboard from a link in mail, a chat or a bookmark manager
       arrives without a session and renders signed out. The reader logs in
       again, it works, and it happens again tomorrow — experienced as "the
       login keeps forgetting me", with nothing to point at.

       Lax still withholds it on cross-site POST, PUT and DELETE, which is the
       CSRF that matters. It sends it on a top-level GET navigation — which is
       safe only because no GET on this server changes anything: sending a test
       alert and sending a roundup are POST routes for exactly this reason. IF A
       GET IS EVER GIVEN A SIDE EFFECT, THIS SETTING BECOMES A HOLE. */
    'SameSite=Lax',
    // The cookie outlives nothing the token does not: at the cap it is shorter.
    `Max-Age=${Math.max(0, Math.floor(lifetimeMs / 1000))}`,
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Rate limiting ───────────────────────────────────────────────────────────
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.ip || req.socket?.remoteAddress || 'unknown';
}

function lockoutRemaining(key) {
  const rec = attempts.get(key);
  if (!rec || !rec.until) return 0;
  const left = rec.until - Date.now();
  if (left <= 0) { attempts.delete(key); return 0; }
  return left;
}

function recordFailure(key) {
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.until = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(key, rec);
}

function clearFailures(key) { attempts.delete(key); }

// ── Middleware ──────────────────────────────────────────────────────────────
function currentSession(req) {
  return verifySession(readCookie(req, COOKIE_NAME));
}

/**
 * Guards routes that change state or send mail.
 *
 * When no admin password is configured this REFUSES rather than allowing
 * through. Failing open would mean a deployment that forgot to set one silently
 * keeps the hole this module exists to close, and the 503 says exactly what to
 * do about it.
 */
function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Admin password not configured',
      detail: 'Set ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) to enable protected endpoints.',
    });
  }
  if (!currentSession(req)) return res.status(401).json({ error: 'Authentication required' });
  next();
}

module.exports = {
  COOKIE_NAME,
  hashPassword, verifyPassword, isConfigured, configuredHash,
  configuredUser, verifyUser, verifyCredentials,
  signSession, verifySession, issueSession, refreshSession,
  readCookie, setSessionCookie, clearSessionCookie,
  clientKey, lockoutRemaining, recordFailure, clearFailures,
  currentSession, requireAuth,
  SESSION_HOURS, SESSION_MAX_DAYS, MAX_ATTEMPTS, LOCKOUT_MS, SESSION_SECRET_CONFIGURED,
};
