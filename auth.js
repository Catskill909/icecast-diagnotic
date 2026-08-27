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

const SESSION_HOURS = parseInt(process.env.SESSION_HOURS, 10) || 12;
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

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',                       // unreadable from JavaScript, so XSS cannot steal it
    'SameSite=Strict',                // not sent cross-site, which blocks CSRF on write routes
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
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
  signSession, verifySession,
  readCookie, setSessionCookie, clearSessionCookie,
  clientKey, lockoutRemaining, recordFailure, clearFailures,
  currentSession, requireAuth,
  SESSION_HOURS, MAX_ATTEMPTS, LOCKOUT_MS,
};
