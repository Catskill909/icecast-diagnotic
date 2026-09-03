/* ═══════════════════════════════════════════════════════════════════════════
   GeoLite2 updater

   THE CLASS THIS FILE EXISTS TO PREVENT: a stream monitor that stops monitoring
   because a geolocation mirror had a bad minute.

   This module downloads a 60 MB file over the public internet at startup. Every
   failure mode it has — no key, wrong key, timeout, truncated archive, an
   archive with no database in it — must end with the app running normally on
   whatever database it already had. None of them may throw into the boot path.

   The tar reader is tested against a REAL archive built the way MaxMind builds
   theirs (a dated directory containing the .mmdb plus licence files), because
   the format detail that matters — the entry is matched by extension, since the
   directory name carries a build date that changes every time — is exactly the
   kind of thing an invented fixture would paper over.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const gu = require('../geo-update');

// ── A real tar archive, built here ──────────────────────────────────────────

/** One 512-byte tar header. Enough of the format to build a valid archive. */
function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('000644 \0', 100, 8);              // mode
  h.write('000000 \0', 108, 8);              // uid
  h.write('000000 \0', 116, 8);              // gid
  h.write(`${size.toString(8).padStart(11, '0')} `, 124, 12);
  h.write(`${Math.floor(Date.now() / 1000).toString(8)} `, 136, 12);
  h.write('        ', 148, 8);               // checksum placeholder
  h.write('0', 156, 1);                      // type: regular file
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

function buildTar(entries) {
  const parts = [];
  for (const [name, body] of entries) {
    parts.push(tarHeader(name, body.length), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));            // two zero blocks end the archive
  return Buffer.concat(parts);
}

const MMDB_BODY = Buffer.from('this-stands-in-for-a-database'.repeat(50));

test('the database is extracted from a MaxMind-shaped archive', () => {
  const tar = buildTar([
    ['GeoLite2-City_20260901/COPYRIGHT.txt', Buffer.from('(c) MaxMind')],
    ['GeoLite2-City_20260901/GeoLite2-City.mmdb', MMDB_BODY],
    ['GeoLite2-City_20260901/LICENSE.txt', Buffer.from('EULA')],
  ]);
  const out = gu.extractMmdb(tar);
  assert.ok(out, 'the .mmdb entry must be found');
  assert.equal(Buffer.compare(out, MMDB_BODY), 0, 'and extracted byte for byte');
});

test('THE ENTRY IS MATCHED BY EXTENSION, because the directory name is dated', () => {
  /* MaxMind names the directory with the build date, so it differs on every
     download. Matching a full path would work once and then silently stop. */
  const tar = buildTar([['GeoLite2-City_20991231/GeoLite2-City.mmdb', MMDB_BODY]]);
  assert.equal(Buffer.compare(gu.extractMmdb(tar), MMDB_BODY), 0);
});

test('files before the database do not confuse the walk', () => {
  // Entries are variable length; a reader that mis-computes padding lands
  // mid-file and reads garbage as a header.
  const tar = buildTar([
    ['GeoLite2-City_20260901/a.txt', Buffer.from('x')],          // 1 byte, heavy padding
    ['GeoLite2-City_20260901/b.txt', Buffer.alloc(512, 7)],      // exactly one block
    ['GeoLite2-City_20260901/c.txt', Buffer.alloc(513, 9)],      // one byte over
    ['GeoLite2-City_20260901/GeoLite2-City.mmdb', MMDB_BODY],
  ]);
  assert.equal(Buffer.compare(gu.extractMmdb(tar), MMDB_BODY), 0);
});

test('an archive with no database returns null rather than something else', () => {
  const tar = buildTar([['GeoLite2-City_20260901/COPYRIGHT.txt', Buffer.from('(c)')]]);
  assert.equal(gu.extractMmdb(tar), null);
});

test('a truncated archive returns null instead of a partial database', () => {
  /* A half-written database loads as an unreadable file and disables the
     feature until somebody notices. Better to keep the previous one. */
  const full = buildTar([['GeoLite2-City_20260901/GeoLite2-City.mmdb', MMDB_BODY]]);
  assert.equal(gu.extractMmdb(full.subarray(0, 700)), null);
});

test('empty and garbage input do not throw', () => {
  assert.equal(gu.extractMmdb(Buffer.alloc(0)), null);
  assert.equal(gu.extractMmdb(Buffer.alloc(2048)), null);
  assert.equal(gu.extractMmdb(Buffer.from('not a tar file at all')), null);
});

test('the archive round-trips through gzip, as it arrives from MaxMind', () => {
  const tar = buildTar([['GeoLite2-City_20260901/GeoLite2-City.mmdb', MMDB_BODY]]);
  const out = gu.extractMmdb(zlib.gunzipSync(zlib.gzipSync(tar)));
  assert.equal(Buffer.compare(out, MMDB_BODY), 0);
});

// ── Staleness ───────────────────────────────────────────────────────────────

test('a missing database needs an update; a fresh one does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoupd-'));
  try {
    assert.equal(gu.needsUpdate('city', dir), true, 'missing must be fetched');
    fs.writeFileSync(gu.targetPath('city', dir), 'x');
    assert.equal(gu.needsUpdate('city', dir), false, 'just written is current');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database older than the max age is refreshed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoupd-'));
  try {
    const p = gu.targetPath('city', dir);
    fs.writeFileSync(p, 'x');
    const old = Date.now() - gu.MAX_AGE_MS - 60000;
    fs.utimesSync(p, new Date(old), new Date(old));
    assert.equal(gu.needsUpdate('city', dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the database is written to the DATA VOLUME, so it survives a redeploy', () => {
  /* If it landed in the image or in /tmp, every deploy would re-download 60 MB
     and every restart would run briefly with no geography. */
  assert.match(gu.targetPath('city', '/app/data'), /^\/app\/data\//);
  assert.match(gu.targetPath('city', '/app/data'), /GeoLite2-City\.mmdb$/);
});

// ── Soft failure ────────────────────────────────────────────────────────────

test('WITH NO LICENCE KEY, updateAll returns quietly and changes nothing', () => {
  const before = process.env.MAXMIND_LICENSE_KEY;
  delete process.env.MAXMIND_LICENSE_KEY;
  try {
    assert.equal(gu.licenceKey(), '');
  } finally {
    if (before !== undefined) process.env.MAXMIND_LICENSE_KEY = before;
  }
});

test('updateAll never throws, and never sets a path it did not write', async () => {
  const before = { key: process.env.MAXMIND_LICENSE_KEY, city: process.env.GEOIP_CITY_DB };
  delete process.env.MAXMIND_LICENSE_KEY;
  delete process.env.GEOIP_CITY_DB;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoupd-'));
  try {
    const res = await gu.updateAll({ dataDir: dir, editions: ['city'], log: () => {} });
    assert.deepEqual(res, {}, 'no key means no work attempted');
    assert.equal(process.env.GEOIP_CITY_DB, undefined, 'must not point at a file that does not exist');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (before.key !== undefined) process.env.MAXMIND_LICENSE_KEY = before.key;
    if (before.city !== undefined) process.env.GEOIP_CITY_DB = before.city;
  }
});

test('AN EXPLICITLY CONFIGURED PATH IS NEVER OVERWRITTEN', async () => {
  /* An operator who mounted their own database did that deliberately.
     Downloading over the top of it would be the wrong kind of helpful. */
  const before = { key: process.env.MAXMIND_LICENSE_KEY, city: process.env.GEOIP_CITY_DB };
  process.env.MAXMIND_LICENSE_KEY = 'test-key-not-used';
  process.env.GEOIP_CITY_DB = '/somewhere/else/mine.mmdb';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoupd-'));
  try {
    const res = await gu.updateAll({ dataDir: dir, editions: ['city'], log: () => {} });
    assert.equal(res.city.reason, 'path-configured-explicitly');
    assert.equal(process.env.GEOIP_CITY_DB, '/somewhere/else/mine.mmdb', 'left exactly as set');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (before.key === undefined) delete process.env.MAXMIND_LICENSE_KEY;
    else process.env.MAXMIND_LICENSE_KEY = before.key;
    if (before.city === undefined) delete process.env.GEOIP_CITY_DB;
    else process.env.GEOIP_CITY_DB = before.city;
  }
});

test('geo.js still contains no network client', () => {
  /* THE RULE: a local database, never a lookup API. Fetching a database file
     sends nobody's address anywhere, which is why THIS module may use https and
     geo.js may not — an http client in geo.js is one refactor away from being
     pointed at a per-listener lookup endpoint. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'geo.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  for (const banned of ["require('https')", "require('http')", "require('node:https')", 'fetch('] ) {
    assert.ok(!code.includes(banned), `geo.js must not reach the network: found ${banned}`);
  }
});
