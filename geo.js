/* ═══════════════════════════════════════════════════════════════════════════
   Geo and network lookups — local MMDB databases, never a lookup API

   TWO RULES THIS MODULE EXISTS TO ENFORCE.

   1. A LOCAL DATABASE, NEVER A LOOKUP API. An API means sending every
      listener's IP address to a third party, one request per listener, for as
      long as the product runs. That is a materially different privacy posture
      from reading a file on our own disk, and `AUDIENCE-ROADMAP.md` §4 settles
      it: local, always. There is deliberately no HTTP client in this file.

   2. AN IP GOES IN; A PLACE AND A NETWORK CLASS COME OUT. Never coordinates,
      never the address back, never a city. The lookup libraries return
      latitude/longitude and MaxMind's own documented failure case is a Kansas
      farm that received years of harassment because unresolvable US addresses
      resolved to its coordinates. Coordinates are dropped HERE, at the read,
      so that no caller downstream can plot one.

   ── The database is optional and supplied by the deployer ───────────────────

   `GEOIP_ASN_DB` and `GEOIP_CITY_DB` are filesystem paths to MMDB files. With
   neither set the module reports itself unavailable and every caller degrades
   to an honest "not available" rather than a wrong answer. Nothing is bundled
   and nothing is downloaded: the licences differ per vendor, and a deployer
   supplying their own file is the only arrangement that closes no doors.

   TWO VENDORS, ONE FORMAT. DB-IP Lite (CC BY 4.0, no account) and MaxMind
   GeoLite2 (free, account + licence key) both publish MMDB, so switching
   vendors is an env path and not a code change. Their field names differ
   slightly and both shapes are read below.

   ATTRIBUTION IS AN OBLIGATION, NOT A COURTESY. The CC-licensed databases
   require a visible credit with a link on any page showing their data.
   `attribution()` returns it, derived from the file actually loaded, so a page
   cannot show DB-IP data under a MaxMind credit or vice versa.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* A city record whose accuracy radius is wider than this is a REGION CENTROID,
   not a place. MaxMind and DB-IP both fall back to a country or region centre
   when they cannot resolve further, and that fallback is the single most
   dangerous artefact in geolocation: it manufactures a dense cluster of
   listeners at a point where nobody lives, and on a map it reads as a genuine
   finding.

   200 km is chosen to reject centroids rather than to guarantee a state. A
   country-level fallback carries a radius in the high hundreds or thousands;
   a real city record is typically 5-100 km. A US state is 200-500 km across,
   so a record inside this bound is a real place, and is usually — not always —
   in the state the record names. That residual error is why the figure is
   published as an estimate. */
const MAX_ACCURACY_RADIUS_KM = Math.max(
  1,
  parseInt(process.env.GEOIP_MAX_ACCURACY_RADIUS_KM, 10) || 200,
);

// ── Private and non-routable addresses ──────────────────────────────────────

/* These are not listeners in a place. An address from RFC1918 or loopback
   reaches us only from a relay inside the same network as the Icecast server,
   or from our own probes, and geolocating it would return either nothing or
   the datacenter. Excluded explicitly and counted, because "we could not place
   14% of connections" is itself a finding. */
function isPrivateAddress(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;

  // IPv6, including the ::ffff:a.b.c.d form Icecast emits on dual-stack hosts.
  if (s.includes(':')) {
    const v4 = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4) return isPrivateAddress(v4[1]);
    const low = s.toLowerCase();
    if (low === '::1' || low === '::') return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd]/.test(low)) return true;
    if (/^fe[89ab]/.test(low)) return true;
    return false;
  }

  const parts = s.split('.');
  if (parts.length !== 4) return true;
  const [a, b] = parts.map((n) => parseInt(n, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT, RFC6598
  if (a >= 224) return true;                            // multicast, reserved
  return false;
}

// ── Which AS organisations are hosting providers ────────────────────────────

/* NO FREE DATABASE CARRIES A HOSTING FLAG. `is_hosting_provider` belongs to
   MaxMind's PAID Anonymous IP database. GeoLite2 ASN and DB-IP ASN Lite both
   return exactly two useful fields — an AS number and an organisation name —
   so separating a datacenter from a consumer ISP is a heuristic over that
   name, and is reported as one.

   `DEEP-ANALYTICS-PLAN.md` §3 describes this signal as though the database
   answered it directly. It does not, and building it as a boolean would state
   a certainty the data does not support.

   Therefore three outcomes, not two: `hosting` when the name matches a known
   provider, `unrecognised` when it does not, and `unknown` with no database.
   `unrecognised` IS NOT "residential" — it is the absence of a match, which is
   also what a small regional host looks like. Every caller renders it as such. */
const HOSTING_PATTERNS = [
  // The large clouds.
  /\bamazon\b|\baws\b/i,
  /\bgoogle\b.*\bcloud\b|\bgoogle llc\b|\bgcp\b/i,
  /\bmicrosoft\b|\bazure\b/i,
  /\boracle\b.*\bcloud\b/i,
  /\balibaba\b|\baliyun\b/i,
  /\btencent\b/i,
  /\bibm\b|\bsoftlayer\b/i,
  // Mainstream VPS and dedicated hosts.
  /\bdigitalocean\b/i,
  /\blinode\b/i,
  /\bovh\b/i,
  /\bhetzner\b/i,
  /\bvultr\b|\bchoopa\b/i,
  /\bscaleway\b|\bonline s\.?a\.?s\b/i,
  /\bcontabo\b/i,
  /\bleaseweb\b/i,
  /\bupcloud\b/i,
  /\bnetcup\b/i,
  /\bhostwinds\b/i,
  /\bliquid ?web\b/i,
  /\bdreamhost\b/i,
  /\bbluehost\b/i,
  /\bgodaddy\b/i,
  /\bhostinger\b/i,
  /\bnamecheap\b/i,
  /\bionos\b|\b1&1\b/i,
  /\brackspace\b/i,
  /\bequinix\b|\bpacket host\b/i,
  /\bm247\b/i,
  /\bdatacamp\b/i,
  /\bworldstream\b/i,
  /\bserverius\b/i,
  /\bcolocrossing\b/i,
  /\bpsychz\b/i,
  /\bquadranet\b/i,
  /\bzenlayer\b/i,
  // CDNs and edge networks. A listener does not arrive from one; a relay does.
  /\bcloudflare\b/i,
  /\bfastly\b/i,
  /\bakamai\b/i,
  // Generic tokens, kept DELIBERATELY NARROW. Bare "cloud" and "server" are
  // excluded because consumer ISPs are named things like "Cloud 9 Broadband"
  // and matching them would report a residential listener as a datacenter.
  /\bhosting\b/i,
  /\bdata ?cent(er|re)\b/i,
  /\bdedicated server/i,
  /\bcolocation\b/i,
  /\bvps\b/i,
];

/**
 * Classify an AS organisation name.
 *
 * Returns 'hosting' or 'unrecognised'. Never 'residential' — see above.
 */
function classifyOrg(org) {
  const s = String(org || '').trim();
  if (!s) return 'unrecognised';
  for (const re of HOSTING_PATTERNS) if (re.test(s)) return 'hosting';
  return 'unrecognised';
}

// ── Readers ─────────────────────────────────────────────────────────────────

/* Opened lazily and once. The City database is ~70 MB and reading it at
   require() time would add that to startup for every deployment, including the
   overwhelming majority that have no database configured at all. */
let readers = null;

/**
 * The database's build date, from metadata whose UNITS ARE NOT WHAT THE FILE
 * FORMAT SAYS.
 *
 * The MMDB spec stores `build_epoch` as Unix SECONDS, and the obvious reading
 * — `new Date(epoch * 1000)` — is wrong, because mmdb-lib has already done the
 * conversion and hands back a `Date`. Multiplying again put the build date in
 * the year 58636. Caught by fetching a real DB-IP file and looking at it, which
 * is the same discipline `ADMIN-ACCESS-SCOPE.md` §7 step 0 applies to the
 * Icecast API: read the real document before designing against an assumed shape.
 *
 * Both forms are accepted rather than the one this library happens to return,
 * because the other vendor's file is read by the same code and a future version
 * of the library could reasonably change its mind.
 *
 * A value that is not a plausible build date returns null. A stale database
 * misplaces listeners silently, so the panel shows this age — and a date 56,000
 * years out would read as "impossibly fresh" and hide exactly what it is there
 * to reveal.
 */
function buildDate(raw) {
  if (raw == null) return null;
  const ms = raw instanceof Date
    ? raw.getTime()
    : Number(raw) > 1e12 ? Number(raw)   // already milliseconds
      : Number(raw) * 1000;              // Unix seconds, per the MMDB spec
  if (!Number.isFinite(ms)) return null;
  // No geolocation database was built before 2000 or will be built next year.
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 1) return null;
  return d.toISOString();
}

function openOne(kind, filePath) {
  const out = { kind, path: filePath || null, loaded: false, error: null, vendor: null, builtAt: null };
  if (!filePath) return out;

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    /* A configured-but-unreadable database is an operator error and must be
       visible. Reporting it as "no database" would hide a typo'd path behind a
       panel that reads exactly like a deployment that never wanted one. */
    out.error = e.code === 'ENOENT'
      ? `not found: ${filePath}`
      : `unreadable: ${e.code || e.message}`;
    return out;
  }

  try {
    const { Reader } = require('maxmind');
    out.reader = new Reader(buf);
    out.loaded = true;
    const md = out.reader.metadata || {};
    // Both vendors write their name into the database type. This is how the
    // attribution line below knows which credit it owes.
    const type = String(md.databaseType || '');
    out.databaseType = type || null;
    out.vendor = /dbip/i.test(type) ? 'db-ip'
      : /geolite|geoip/i.test(type) ? 'maxmind'
        : null;
    out.builtAt = buildDate(md.buildEpoch);
  } catch (e) {
    out.error = `not a valid MMDB file: ${e.message}`;
  }
  return out;
}

function load() {
  if (readers) return readers;
  readers = {
    asn: openOne('asn', process.env.GEOIP_ASN_DB),
    city: openOne('city', process.env.GEOIP_CITY_DB),
  };
  return readers;
}

/** Drop the loaded databases. Tests set env and reload; nothing else needs it. */
function reset() {
  readers = null;
}

/**
 * What is loaded, for the panel and the API — never the reader itself.
 *
 * `path` is included because it is an operator's own configuration and carries
 * no secret: unlike a status URL it cannot hold credentials, and a panel that
 * will not say which file it read is useless for diagnosing a wrong one.
 */
function available() {
  const r = load();
  const describe = (x) => ({
    configured: !!x.path,
    loaded: x.loaded,
    error: x.error,
    vendor: x.vendor,
    databaseType: x.databaseType || null,
    // A stale database misplaces listeners silently, and MaxMind's EULA
    // actually requires keeping it current, so the build date is reported.
    builtAt: x.builtAt || null,
    path: x.path ? path.basename(x.path) : null,
  });
  return { asn: describe(r.asn), city: describe(r.city) };
}

/**
 * The attribution line owed for the databases actually loaded.
 *
 * Derived from the files rather than from configuration, so a page cannot
 * credit a vendor whose data it is not showing. CC BY REQUIRES this to be
 * displayed; it is not decorative.
 */
function attribution() {
  const r = load();
  const out = [];
  const seen = new Set();
  for (const x of [r.asn, r.city]) {
    if (!x.loaded || !x.vendor || seen.has(x.vendor)) continue;
    seen.add(x.vendor);
    if (x.vendor === 'db-ip') {
      out.push({ vendor: 'db-ip', text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' });
    } else if (x.vendor === 'maxmind') {
      out.push({ vendor: 'maxmind', text: 'This product includes GeoLite2 data created by MaxMind', url: 'https://www.maxmind.com' });
    }
  }
  return out;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/**
 * The network an address belongs to.
 *
 * `hosting` is a NAME MATCH on the AS organisation, not a database flag — see
 * HOSTING_PATTERNS. `asn` and `org` are returned because they are properties of
 * a network, not of a person: an AS number describes a routing entity operating
 * thousands of addresses, and is the same value for every listener on that ISP.
 * Callers still aggregate before publishing.
 */
function networkMiss(reason) {
  return { resolved: false, reason, network: 'unknown', asn: null, org: null };
}

/**
 * An ASN record → the published shape. Pure, and exported so the rule can be
 * tested against record shapes rather than against a 30 MB binary file.
 */
function networkFromRecord(rec) {
  if (!rec) return networkMiss('not-in-database');

  // DB-IP and MaxMind name these fields identically; alternatives are read
  // defensively because this parser is written against real files rather than
  // against a specification that enumerates them.
  const asn = rec.autonomous_system_number ?? rec.as_number ?? null;
  const org = rec.autonomous_system_organization ?? rec.as_organization ?? rec.organization ?? null;

  return {
    resolved: true,
    reason: null,
    network: classifyOrg(org),
    asn: asn == null ? null : Number(asn),
    org: org ? String(org) : null,
  };
}

function lookupNetwork(ip) {
  const r = load();
  if (isPrivateAddress(ip)) return networkMiss('private');
  if (!r.asn.loaded) return networkMiss('no-database');

  try {
    return networkFromRecord(r.asn.reader.get(String(ip)));
  } catch {
    // A malformed address from a server we do not control. Not an error worth
    // failing a whole collection pass for.
    return networkMiss('invalid-address');
  }
}

/**
 * The place an address is in, at the ONLY two resolutions this product publishes.
 *
 * THE RULE, from `ADMIN-ACCESS-SCOPE.md` §2:
 *   - US            → state (subdivision), and only when the record is precise
 *                     enough to be a place rather than a centroid
 *   - everywhere else → country, and STOP. However confidently the database
 *                     offers a city, subdivision accuracy outside the US, Canada,
 *                     Western Europe and Australia is materially weaker, and a
 *                     wrong region is worse than an admitted country.
 *
 * No latitude, no longitude, no city, ever — not even internally past this
 * function's own return.
 */
function placeMiss(reason) {
  return { resolved: false, reason, countryCode: null, region: null, isEU: false, accuracyRadius: null };
}

/**
 * A city record → the published shape. Pure, and exported so the US/non-US
 * rule and the centroid gate can be tested directly — they are the two pieces
 * of logic here that can be wrong in a way nobody notices.
 */
function placeFromRecord(rec) {
  if (!rec) return placeMiss('not-in-database');

  const countryCode = rec.country?.iso_code || rec.registered_country?.iso_code || null;
  if (!countryCode) return placeMiss('no-country');

  const isEU = !!(rec.country?.is_in_european_union || rec.registered_country?.is_in_european_union);
  const accuracyRadius = rec.location?.accuracy_radius ?? null;

  let region = null;
  if (countryCode === 'US') {
    const sub = Array.isArray(rec.subdivisions) ? rec.subdivisions[0] : null;
    const code = sub?.iso_code || null;
    /* BOTH conditions, not either. A subdivision with a 1000 km radius is the
       database naming the state a country centroid happens to sit in, which is
       precisely the artefact the gate exists to stop. */
    if (code && accuracyRadius != null && accuracyRadius <= MAX_ACCURACY_RADIUS_KM) {
      region = String(code);
    }
  }

  return { resolved: true, reason: null, countryCode: String(countryCode), region, isEU, accuracyRadius };
}

function lookupPlace(ip) {
  const r = load();
  if (isPrivateAddress(ip)) return placeMiss('private');
  if (!r.city.loaded) return placeMiss('no-database');

  try {
    return placeFromRecord(r.city.reader.get(String(ip)));
  } catch {
    return placeMiss('invalid-address');
  }
}

module.exports = {
  available,
  attribution,
  lookupNetwork,
  lookupPlace,
  // Exported for tests. Nothing else should need them.
  buildDate,
  classifyOrg,
  isPrivateAddress,
  networkFromRecord,
  placeFromRecord,
  reset,
  MAX_ACCURACY_RADIUS_KM,
};
