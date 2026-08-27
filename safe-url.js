/* ═══════════════════════════════════════════════════════════════════════════
   Server-side fetch guard

   The add-station flow's appeal is "paste a URL and we discover the rest" —
   which is a server-side request to an address a user chose. Unguarded, that is
   a way to make this server read things the user cannot reach themselves:

     http://169.254.169.254/latest/meta-data/    cloud instance credentials
     http://127.0.0.1:9000/admin/                anything bound to loopback
     http://10.0.0.5/                            the private network behind us

   The response would then be rendered back to whoever asked. That is the whole
   bug, and it is why the check has to happen against the RESOLVED ADDRESS
   rather than the hostname: `evil.example.com` resolving to 127.0.0.1 passes any
   check that only reads the text of the URL.

   KNOWN LIMIT. Resolving and then connecting leaves a DNS-rebinding window: an
   attacker controlling the nameserver can answer once with a public address and
   again with a private one. Closing it fully means connecting to the address we
   validated and passing the hostname in the Host header. For an
   operator-initiated, one-shot discovery request that window is narrow, and it
   is recorded here rather than left for someone to discover.
   ═══════════════════════════════════════════════════════════════════════════ */

const dns = require('dns').promises;
const net = require('net');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;   // 2 MB — a status document is ~20 KB
const DEFAULT_MAX_REDIRECTS = 3;

/** Blocked IPv4 ranges, as [firstOctet, predicate] for readability. */
function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;// RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 192 && b === 88) return true;          // 6to4 relay anycast
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true;          // TEST-NET-2
  if (a === 203 && b === 0) return true;           // TEST-NET-3
  if (a >= 224) return true;                       // multicast and reserved
  return false;
}

function isBlockedIPv6(ip) {
  const s = ip.toLowerCase().split('%')[0];        // drop any zone index
  if (s === '::' || s === '::1') return true;      // unspecified, loopback
  // IPv4-mapped and IPv4-compatible forms are the classic bypass: ::ffff:127.0.0.1
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isBlockedIPv4(mapped[2]);
  if (/^f[cd]/.test(s)) return true;               // fc00::/7 unique local
  if (/^fe[89ab]/.test(s)) return true;            // fe80::/10 link-local
  if (/^ff/.test(s)) return true;                  // multicast
  return false;
}

function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true;                                     // not an IP at all — refuse
}

/**
 * Parses and structurally validates a URL, before any DNS lookup.
 * Returns { ok: true, url } or { ok: false, reason }.
 */
function validateUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }

  // file:, gopher:, ftp: and friends are all ways to read something else.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported scheme "${url.protocol.replace(':', '')}" — use http or https` };
  }
  // Credentials in the URL would be forwarded upstream and stored in config.
  if (url.username || url.password) {
    return { ok: false, reason: 'Remove the username and password from the URL' };
  }
  if (!url.hostname) return { ok: false, reason: 'No hostname in the URL' };

  // A literal address skips DNS entirely, so check it here too.
  if (net.isIP(url.hostname) && isBlockedAddress(url.hostname)) {
    return { ok: false, reason: 'That address is on a private or reserved network' };
  }
  return { ok: true, url };
}

/**
 * Resolves a hostname and refuses it if ANY answer is private or reserved.
 *
 * Every answer is checked, not just the first: a name that resolves to one
 * public and one private address must not be reachable through the public one.
 */
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('That address is on a private or reserved network');
    return [hostname];
  }
  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve "${hostname}"`);
  }
  if (!answers.length) throw new Error(`Could not resolve "${hostname}"`);
  for (const { address } of answers) {
    if (isBlockedAddress(address)) {
      // The address itself is not echoed back: it is information about the
      // network behind us that the person asking does not otherwise have.
      throw new Error(`"${hostname}" resolves to a private or reserved address`);
    }
  }
  return answers.map((a) => a.address);
}

/**
 * Full check for a user-supplied URL: structure, then resolution.
 * Redirects must be re-checked with this same function — a permitted host can
 * redirect to a forbidden one, which is how the guard is usually walked around.
 */
async function assertFetchable(raw) {
  const v = validateUrl(raw);
  if (!v.ok) throw new Error(v.reason);
  await assertPublicHost(v.url.hostname);
  return v.url;
}

module.exports = {
  validateUrl,
  assertPublicHost,
  assertFetchable,
  isBlockedAddress,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
};
