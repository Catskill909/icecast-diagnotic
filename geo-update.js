/* ═══════════════════════════════════════════════════════════════════════════
   GeoLite2 database updater

   WHY THIS EXISTS. The person deploying this has a deploy button and no shell:
   no `docker cp`, no way to place a 60 MB binary on a named volume. The ASN
   database solves that by riding in the image, which its CC BY licence permits.
   MaxMind's GeoLite2 EULA does NOT permit redistribution, so the City database
   cannot travel that way — and City is the one the map needs, because it is the
   only free database that ships `accuracy_radius`, the field that tells a real
   place apart from a region centroid (verified against DB-IP on 2026-09-02:
   it has no such field at all).

   So the app fetches it, at runtime, onto the persistent volume. That is also
   MaxMind's own documented pattern, and it means the database is never
   redistributed by us — each deployment downloads its own copy under its own
   licence key.

   THIS DOES NOT CONTRADICT THE RULE IN geo.js. That rule is "a local database,
   never a lookup API", and it is about LISTENER DATA: never send a listener's
   IP address to a third party. Downloading a database file once a month sends
   nobody's address anywhere. The distinction is the whole point, which is why
   the network code lives here and geo.js still has none.

   FAILURE IS ALWAYS SOFT. A monitor whose job is watching radio streams must
   not fail to start, fail a check cycle, or lose an alert because a database
   mirror was slow. Every failure here logs and returns; the app runs on with
   whatever database it already had, or with none.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const HOST = 'download.maxmind.com';

/* How old a database may be before a refresh is attempted. MaxMind rebuilds
   GeoLite2 twice a week and the EULA obliges users to keep data current, but
   the figures here move slowly and a station is not served by re-downloading
   60 MB daily. Fortnightly is comfortably inside "current" and quiet. */
const MAX_AGE_MS = Math.max(
  24 * 60 * 60 * 1000,
  parseInt(process.env.GEOIP_MAX_AGE_MS, 10) || 14 * 24 * 60 * 60 * 1000,
);

const EDITIONS = {
  city: 'GeoLite2-City',
  asn: 'GeoLite2-ASN',
};

function licenceKey() {
  return (process.env.MAXMIND_LICENSE_KEY || '').trim();
}

/** Where a downloaded edition is kept. The data volume, so it survives deploys. */
function targetPath(kind, dataDir) {
  return path.join(dataDir, `GeoLite2-${kind === 'city' ? 'City' : 'ASN'}.mmdb`);
}

// ── A minimal tar reader ────────────────────────────────────────────────────

/* MaxMind ships `.tar.gz` and nothing else — there is no plain `.mmdb.gz`
   endpoint. Rather than shell out to `tar` (a dependency on the image having
   it, and on a shell being available) or add an npm package, the archive is
   walked directly: tar is 512-byte headers, each followed by the file's bytes
   padded to a 512-byte boundary. Only one member is wanted.

   The archive contains a dated directory, e.g.
   `GeoLite2-City_20260901/GeoLite2-City.mmdb`, so the entry is matched by
   EXTENSION rather than by full path — the date changes every build. */
function extractMmdb(buf) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);

    // Two consecutive zero blocks end the archive.
    if (header.every((b) => b === 0)) return null;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    // Size is octal, NUL- or space-padded, at offset 124.
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/[\0 ]/g, '');
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) return null;

    const start = off + 512;
    if (name.endsWith('.mmdb') && size > 0) {
      if (start + size > buf.length) return null;   // truncated archive
      return buf.subarray(start, start + size);
    }

    // Advance past the body, rounded up to the next 512-byte boundary.
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

// ── Download ────────────────────────────────────────────────────────────────

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 120000 }, (res) => {
      // MaxMind answers with a redirect to a signed storage URL.
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!redirectsLeft || !res.headers.location) return reject(new Error('too many redirects'));
        return resolve(download(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        /* 401 here means the licence key is wrong or revoked. Say so plainly:
           the alternative is an operator staring at "no database" with no idea
           whether they typed the key wrong or the feature is broken. */
        return reject(new Error(
          res.statusCode === 401
            ? 'MaxMind rejected the licence key (401) — check MAXMIND_LICENSE_KEY'
            : `HTTP ${res.statusCode}`,
        ));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
  });
}

/**
 * Fetch one edition and write it to the data volume.
 *
 * Written to a temporary file and renamed, so a process killed mid-download
 * leaves the previous database intact rather than a truncated one that would
 * load as an unreadable file and disable the feature until someone noticed.
 */
async function fetchEdition(kind, dataDir) {
  const key = licenceKey();
  if (!key) return { ok: false, reason: 'no-licence-key' };

  const edition = EDITIONS[kind];
  if (!edition) return { ok: false, reason: 'unknown-edition' };

  const url = `https://${HOST}/app/geoip_download`
    + `?edition_id=${edition}&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;

  const gz = await download(url);
  const tar = zlib.gunzipSync(gz);
  const mmdb = extractMmdb(tar);
  if (!mmdb) return { ok: false, reason: 'no-mmdb-in-archive' };

  const dest = targetPath(kind, dataDir);
  const tmp = `${dest}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, mmdb);
  fs.renameSync(tmp, dest);
  return { ok: true, path: dest, bytes: mmdb.length };
}

/** Whether an edition is missing or old enough to be worth re-fetching. */
function needsUpdate(kind, dataDir) {
  const dest = targetPath(kind, dataDir);
  let st;
  try {
    st = fs.statSync(dest);
  } catch {
    return true;   // missing
  }
  return Date.now() - st.mtimeMs > MAX_AGE_MS;
}

/**
 * Bring the configured editions up to date, and point geo.js at them.
 *
 * Called at startup. **Never throws and never blocks a check cycle** — it is
 * awaited only so the log lines land in order.
 *
 * The env var is set here rather than in a config file because geo.js reads
 * paths from the environment, and a database that has just been downloaded to
 * a path nothing points at is the same as no database at all.
 */
async function updateAll({ dataDir, editions = ['city'], log = console.log } = {}) {
  const results = {};
  if (!licenceKey()) return results;

  for (const kind of editions) {
    const dest = targetPath(kind, dataDir);
    const envVar = kind === 'city' ? 'GEOIP_CITY_DB' : 'GEOIP_ASN_DB';

    /* An explicitly configured path always wins. An operator who mounted their
       own database did so deliberately, and silently downloading over the top
       of that decision would be the wrong kind of helpful. */
    if (process.env[envVar] && !process.env[envVar].startsWith(dataDir)) {
      results[kind] = { ok: false, reason: 'path-configured-explicitly' };
      continue;
    }

    if (!needsUpdate(kind, dataDir)) {
      process.env[envVar] = dest;
      results[kind] = { ok: true, reason: 'already-current', path: dest };
      continue;
    }

    try {
      log(`[Geo] Downloading ${EDITIONS[kind]}…`);
      const r = await fetchEdition(kind, dataDir);
      if (r.ok) {
        process.env[envVar] = dest;
        log(`[Geo] ${EDITIONS[kind]} installed (${(r.bytes / 1e6).toFixed(1)} MB)`);
      } else {
        log(`[Geo] ${EDITIONS[kind]} not updated: ${r.reason}`);
        // A previous copy is still perfectly usable.
        if (fs.existsSync(dest)) process.env[envVar] = dest;
      }
      results[kind] = r;
    } catch (e) {
      /* SOFT FAILURE, ALWAYS. The product is a stream monitor; it does not stop
         for a geolocation mirror. */
      log(`[Geo] ${EDITIONS[kind]} download failed: ${e.message}`);
      if (fs.existsSync(dest)) process.env[envVar] = dest;
      results[kind] = { ok: false, reason: e.message };
    }
  }
  return results;
}

module.exports = {
  updateAll,
  fetchEdition,
  needsUpdate,
  targetPath,
  extractMmdb,
  licenceKey,
  MAX_AGE_MS,
  EDITIONS,
};
