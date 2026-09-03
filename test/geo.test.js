/* ═══════════════════════════════════════════════════════════════════════════
   Geo and network lookups

   THE CLASS THIS FILE EXISTS TO PREVENT is not a leak — listener-detail.test.js
   guards that boundary — it is a CONFIDENT WRONG ANSWER.

   Geolocation fails by returning something plausible rather than by returning
   nothing. When a database cannot resolve an address it does not say so: it
   returns the centroid of the country or region, which is a real coordinate in
   a real state, and which reads on a map as a genuine finding. MaxMind's own
   documented case is a Kansas farm that received years of harassment because
   unresolvable US addresses defaulted to its coordinates.

   So the tests below are mostly about REFUSING to answer:
     - a wide accuracy radius is a centroid, not a state
     - a subdivision outside the US is not published however confident it is
     - a private address is not a place
     - a missing database is 'no-database', never an empty result that a caller
       could mistake for "nobody is anywhere"

   `placeFromRecord` and `networkFromRecord` are pure and take the record shape
   the vendors actually emit, so these exercise the real rules without needing a
   30 MB binary fixture in the repository.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');

const geo = require('../geo');

// ── The centroid gate ───────────────────────────────────────────────────────

/* A US record precise enough to be a place. `accuracy_radius` of 20 km is a
   normal city-grade answer. */
const US_PRECISE = {
  country: { iso_code: 'US', is_in_european_union: false },
  subdivisions: [{ iso_code: 'TX' }],
  city: { names: { en: 'Houston' } },
  location: { accuracy_radius: 20, latitude: 29.76, longitude: -95.36 },
};

/* The same shape, but the database is telling us it has no idea: a 1000 km
   radius spans most of the country. The subdivision here is an artefact of
   wherever the centroid landed. */
const US_CENTROID = {
  country: { iso_code: 'US', is_in_european_union: false },
  subdivisions: [{ iso_code: 'KS' }],
  city: { names: { en: 'Wichita' } },
  location: { accuracy_radius: 1000, latitude: 37.75, longitude: -97.82 },
};

test('a precise US record yields a state', () => {
  const p = geo.placeFromRecord(US_PRECISE);
  assert.equal(p.resolved, true);
  assert.equal(p.countryCode, 'US');
  assert.equal(p.region, 'TX');
});

test('THE CENTROID TRAP: a wide radius yields the country and NO state', () => {
  const p = geo.placeFromRecord(US_CENTROID);
  assert.equal(p.resolved, true);
  assert.equal(p.countryCode, 'US');
  assert.equal(
    p.region, null,
    'a 1000 km radius is the database admitting it cannot place the address; '
    + 'publishing the state it happened to land in is how a centroid becomes a finding',
  );
});

test('a US record with no accuracy radius at all yields no state', () => {
  // Absence is not precision. A record without the field cannot clear the gate.
  const p = geo.placeFromRecord({
    country: { iso_code: 'US' },
    subdivisions: [{ iso_code: 'CA' }],
  });
  assert.equal(p.resolved, true);
  assert.equal(p.countryCode, 'US');
  assert.equal(p.region, null);
});

test('a US record with a precise radius but no subdivision yields no state', () => {
  // Both conditions are required, not either.
  const p = geo.placeFromRecord({
    country: { iso_code: 'US' },
    location: { accuracy_radius: 10 },
  });
  assert.equal(p.region, null);
});

test('the gate is exactly at the configured radius, not near it', () => {
  const at = geo.placeFromRecord({
    country: { iso_code: 'US' },
    subdivisions: [{ iso_code: 'TX' }],
    location: { accuracy_radius: geo.MAX_ACCURACY_RADIUS_KM },
  });
  const past = geo.placeFromRecord({
    country: { iso_code: 'US' },
    subdivisions: [{ iso_code: 'TX' }],
    location: { accuracy_radius: geo.MAX_ACCURACY_RADIUS_KM + 1 },
  });
  assert.equal(at.region, 'TX');
  assert.equal(past.region, null);
});

// ── US only, everywhere else country and stop ───────────────────────────────

test('OUTSIDE THE US a subdivision is never published, however precise', () => {
  /* Subdivision accuracy is materially weaker across large parts of Africa,
     South Asia and Latin America, and a wrong region is worse than an admitted
     country. The rule is by country, not by confidence. */
  const p = geo.placeFromRecord({
    country: { iso_code: 'IN' },
    subdivisions: [{ iso_code: 'MH' }],
    city: { names: { en: 'Mumbai' } },
    location: { accuracy_radius: 5 },
  });
  assert.equal(p.resolved, true);
  assert.equal(p.countryCode, 'IN');
  assert.equal(p.region, null, 'only US records carry a region');
});

test('a precise Canadian record is still country-only', () => {
  // Canada is one of the countries where the data IS good. The rule still holds:
  // nothing in this product asks a question below country outside the US.
  const p = geo.placeFromRecord({
    country: { iso_code: 'CA' },
    subdivisions: [{ iso_code: 'ON' }],
    location: { accuracy_radius: 10 },
  });
  assert.equal(p.countryCode, 'CA');
  assert.equal(p.region, null);
});

test('the EU flag is carried through, because it changes the legal question', () => {
  const p = geo.placeFromRecord({
    country: { iso_code: 'DE', is_in_european_union: true },
    location: { accuracy_radius: 20 },
  });
  assert.equal(p.isEU, true);
  assert.equal(p.countryCode, 'DE');
});

test('registered_country is a fallback when country is absent', () => {
  const p = geo.placeFromRecord({ registered_country: { iso_code: 'FR' } });
  assert.equal(p.countryCode, 'FR');
});

// ── No coordinates escape, ever ─────────────────────────────────────────────

test('THE BOUNDARY: no latitude or longitude survives a lookup', () => {
  /* The record going in HAS coordinates. Dropping them at the read is what
     makes a dot-per-listener map impossible to build downstream by accident. */
  const p = geo.placeFromRecord(US_PRECISE);
  const json = JSON.stringify(p);
  assert.ok(!/latitude|longitude/i.test(json), `coordinates leaked: ${json}`);
  assert.ok(!json.includes('29.76'), `a latitude value leaked: ${json}`);
  assert.ok(!json.includes('-95.36'), `a longitude value leaked: ${json}`);
});

test('THE BOUNDARY: no city name survives a lookup', () => {
  // The published resolutions are state and country. A city is neither, and
  // returning one invites a panel to render it.
  const p = geo.placeFromRecord(US_PRECISE);
  assert.ok(!JSON.stringify(p).includes('Houston'));
});

// ── Misses are distinguishable from each other ──────────────────────────────

test('an unresolvable address is a stated reason, not an empty answer', () => {
  /* Four different failures, four different reasons. Collapsing them would make
     "we have no database" indistinguishable from "this listener is nowhere",
     and the panel would report a configuration mistake as a finding about the
     audience. */
  assert.equal(geo.placeFromRecord(null).reason, 'not-in-database');
  assert.equal(geo.placeFromRecord({}).reason, 'no-country');
  assert.equal(geo.lookupPlace('10.0.0.4').reason, 'private');
  assert.equal(geo.lookupPlace('8.8.8.8').reason, 'no-database');
});

test('a miss is never reported as resolved', () => {
  for (const r of [geo.placeFromRecord(null), geo.placeFromRecord({}), geo.lookupPlace('10.0.0.4')]) {
    assert.equal(r.resolved, false);
    assert.equal(r.countryCode, null);
    assert.equal(r.region, null);
  }
});

// ── Private and non-routable addresses ──────────────────────────────────────

test('RFC1918, loopback, link-local and CGNAT are not places', () => {
  for (const ip of [
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.1',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1', '100.127.255.1',   // CGNAT — a carrier's own range
    '0.0.0.0',
    '224.0.0.1',                      // multicast
    '::1', 'fe80::1', 'fd00::1',
    '', null, undefined, 'not-an-ip',
  ]) {
    assert.equal(geo.isPrivateAddress(ip), true, `${ip} should be non-routable`);
  }
});

test('ordinary public addresses are routable', () => {
  for (const ip of ['8.8.8.8', '203.0.113.7', '198.51.100.22', '172.32.0.1', '100.63.255.1', '2606:4700::1111']) {
    assert.equal(geo.isPrivateAddress(ip), false, `${ip} should be routable`);
  }
});

test('172.16/12 is bounded correctly at both ends', () => {
  // The classic off-by-one in this range: 172.15 and 172.32 are PUBLIC.
  assert.equal(geo.isPrivateAddress('172.15.255.255'), false);
  assert.equal(geo.isPrivateAddress('172.16.0.0'), true);
  assert.equal(geo.isPrivateAddress('172.31.255.255'), true);
  assert.equal(geo.isPrivateAddress('172.32.0.0'), false);
});

test('an IPv4-mapped IPv6 address is judged by its IPv4 half', () => {
  // Icecast emits these on dual-stack hosts. Reading ::ffff:10.0.0.1 as a
  // public IPv6 address would send an internal relay into the audience figures.
  assert.equal(geo.isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(geo.isPrivateAddress('::ffff:203.0.113.7'), false);
});

// ── AS organisation classification ──────────────────────────────────────────

test('known hosting providers are recognised', () => {
  for (const org of [
    'AMAZON-02', 'Amazon.com, Inc.', 'Google LLC', 'MICROSOFT-CORP-MSN-AS-BLOCK',
    'DIGITALOCEAN-ASN', 'Linode, LLC', 'OVH SAS', 'Hetzner Online GmbH',
    'The Constant Company, LLC (Vultr)'.replace('The Constant Company, LLC ', 'Vultr '),
    'Contabo GmbH', 'LeaseWeb USA', 'Cloudflare, Inc.', 'Fastly, Inc.',
    'M247 Europe SRL', 'Oracle Cloud', 'Alibaba Cloud',
  ]) {
    assert.equal(geo.classifyOrg(org), 'hosting', `${org} should be hosting`);
  }
});

test('consumer ISPs are not classified as hosting', () => {
  for (const org of [
    'Comcast Cable Communications, LLC',
    'AT&T Services, Inc.',
    'Charter Communications Inc',
    'Verizon Business',
    'T-Mobile USA, Inc.',
    'Cox Communications Inc.',
    'CenturyLink Communications, LLC',
    'Frontier Communications of America, Inc.',
  ]) {
    assert.equal(geo.classifyOrg(org), 'unrecognised', `${org} should not be hosting`);
  }
});

test('an ISP whose NAME contains a hosting-ish word is not swept up', () => {
  /* The reason bare "cloud" and "server" are not patterns. A consumer ISP
     called "Cloud 9 Broadband" is a real kind of name, and classifying its
     subscribers as datacenter traffic would delete real listeners from the
     audience figure — the expensive direction for this error to run. */
  assert.equal(geo.classifyOrg('Cloud 9 Broadband'), 'unrecognised');
  assert.equal(geo.classifyOrg('Silver Star Communications'), 'unrecognised');
});

test('an unmatched organisation is "unrecognised", NEVER "residential"', () => {
  /* The distinction the whole heuristic rests on. No free database carries a
     hosting flag, so a non-match is the ABSENCE of evidence — which is also
     exactly what a small regional host looks like. Calling it residential
     would state a certainty the data does not support. */
  const v = geo.classifyOrg('Some Regional Provider Ltd');
  assert.equal(v, 'unrecognised');
  assert.notEqual(v, 'residential');
});

test('an empty or missing organisation is unrecognised, not a crash', () => {
  for (const org of ['', null, undefined, '   ']) {
    assert.equal(geo.classifyOrg(org), 'unrecognised');
  }
});

// ── ASN records ─────────────────────────────────────────────────────────────

test('an ASN record is read into number, org and class', () => {
  const n = geo.networkFromRecord({
    autonomous_system_number: 16509,
    autonomous_system_organization: 'AMAZON-02',
  });
  assert.equal(n.resolved, true);
  assert.equal(n.asn, 16509);
  assert.equal(n.org, 'AMAZON-02');
  assert.equal(n.network, 'hosting');
});

test('a consumer ISP record resolves but is unrecognised', () => {
  const n = geo.networkFromRecord({
    autonomous_system_number: 7922,
    autonomous_system_organization: 'Comcast Cable Communications, LLC',
  });
  assert.equal(n.resolved, true);
  assert.equal(n.network, 'unrecognised');
});

test('the DB-IP field spelling is read as well as the MaxMind one', () => {
  // Both vendors ship MMDB and the deployer may use either. A parser that only
  // knew one spelling would silently report every listener as unknown.
  const n = geo.networkFromRecord({ as_number: 13335, as_organization: 'Cloudflare, Inc.' });
  assert.equal(n.asn, 13335);
  assert.equal(n.network, 'hosting');
});

test('a missing ASN record is unknown, not a false residential answer', () => {
  const n = geo.networkFromRecord(null);
  assert.equal(n.resolved, false);
  assert.equal(n.network, 'unknown');
  assert.equal(n.reason, 'not-in-database');
});

test('with no database configured every lookup says so', () => {
  const n = geo.lookupNetwork('8.8.8.8');
  assert.equal(n.resolved, false);
  assert.equal(n.reason, 'no-database');
  assert.equal(n.network, 'unknown');
});

test('a private address is not sent to the ASN database either', () => {
  assert.equal(geo.lookupNetwork('192.168.0.5').reason, 'private');
});

// ── Configuration reporting ─────────────────────────────────────────────────

test('with nothing configured, available() reports absence not failure', () => {
  const a = geo.available();
  assert.equal(a.asn.configured, false);
  assert.equal(a.asn.loaded, false);
  assert.equal(a.asn.error, null, 'no database configured is not an error');
  assert.equal(a.city.configured, false);
});

test('a configured but missing file is an ERROR, not silent absence', () => {
  /* A typo in a path must not look identical to a deployment that never wanted
     a database. One is a mistake to fix and the other is a valid choice, and a
     panel that renders them the same way hides the mistake for ever. */
  process.env.GEOIP_ASN_DB = '/nonexistent/path/to/asn.mmdb';
  geo.reset();
  try {
    const a = geo.available();
    assert.equal(a.asn.configured, true);
    assert.equal(a.asn.loaded, false);
    assert.match(a.asn.error, /not found/);
  } finally {
    delete process.env.GEOIP_ASN_DB;
    geo.reset();
  }
});

test('a file that is not an MMDB is reported as such', () => {
  process.env.GEOIP_ASN_DB = __filename;   // a JavaScript file
  geo.reset();
  try {
    const a = geo.available();
    assert.equal(a.asn.loaded, false);
    assert.match(a.asn.error, /not a valid MMDB/);
  } finally {
    delete process.env.GEOIP_ASN_DB;
    geo.reset();
  }
});

test('attribution is empty when nothing is loaded, and is never invented', () => {
  // CC BY requires the credit only for data actually shown. Printing one for a
  // database that was never read would credit a vendor whose data is not here.
  assert.deepEqual(geo.attribution(), []);
});

// ── Database build date ─────────────────────────────────────────────────────

/* THE CLASS: A UNIT ASSUMPTION ABOUT SOMEONE ELSE'S FIELD.
   The MMDB specification stores `build_epoch` as Unix SECONDS, so the obvious
   reading is `new Date(epoch * 1000)`. That is wrong — mmdb-lib has already
   converted it and returns a Date — and the result was a build date in the year
   58636. It was found by fetching a real DB-IP file and looking at the value
   rather than by trusting the format documentation.

   The damage is not cosmetic. This date exists to reveal a STALE database,
   which misplaces listeners silently and which MaxMind's EULA actually requires
   you to avoid. A date 56,000 years in the future reads as impossibly fresh,
   so the bug disabled precisely the check the field is there to provide.

   Tested as a range rather than as a value: any parse that lands outside
   plausible reality is rejected, whatever produced it. */

test('a Date from the library is passed through, not multiplied again', () => {
  const d = new Date('2026-09-01T01:38:17.000Z');
  assert.equal(geo.buildDate(d), '2026-09-01T01:38:17.000Z');
});

test('raw Unix SECONDS, as the MMDB spec stores them, are still understood', () => {
  assert.equal(geo.buildDate(1788226697), '2026-09-01T01:38:17.000Z');
});

test('raw milliseconds are understood too', () => {
  assert.equal(geo.buildDate(1788226697000), '2026-09-01T01:38:17.000Z');
});

test('THE BUG: a date outside plausible reality is rejected, not displayed', () => {
  /* What the doubled conversion produced. Returning null makes the panel say
     "unknown", which is honest; printing the year 58636 would read as a
     database that could not possibly be stale. */
  assert.equal(geo.buildDate(new Date('+058636-08-25T06:03:20.000Z')), null);
  assert.equal(geo.buildDate(1788226697 * 1000 * 1000), null);
  assert.equal(geo.buildDate(0), null);
  assert.equal(geo.buildDate(-1), null);
});

test('a missing or unparseable build date is null rather than a crash', () => {
  assert.equal(geo.buildDate(null), null);
  assert.equal(geo.buildDate(undefined), null);
  assert.equal(geo.buildDate('not a date'), null);
});

// ── The public capability flag ──────────────────────────────────────────────

test('the public geo status carries no filesystem path and no error string', () => {
  /* `/api/config` is ANONYMOUS. `available()` returns the database's basename
     and, on a misconfiguration, an error naming a filesystem path — neither is
     a secret, and neither answers a question an anonymous caller is asking.
     The rule this codebase runs on is allowlist, not blocklist: project the
     three fields that are wanted rather than deleting the two that are not,
     so a field added to `available()` later is withheld until someone names it. */
  process.env.GEOIP_ASN_DB = '/some/private/path/asn.mmdb';
  geo.reset();
  try {
    const full = geo.available();
    // What monitor.getConfig() publishes, kept in step with it here.
    const pub = (x) => ({ loaded: x.loaded, vendor: x.vendor, builtAt: x.builtAt });
    const published = { asn: pub(full.asn), city: pub(full.city) };

    const json = JSON.stringify(published);
    assert.ok(!json.includes('private'), `a filesystem path leaked: ${json}`);
    assert.ok(!json.includes('asn.mmdb'), `a filename leaked: ${json}`);
    assert.ok(!/not found|unreadable/.test(json), `an error string leaked: ${json}`);
    assert.deepEqual(Object.keys(published.asn).sort(), ['builtAt', 'loaded', 'vendor']);

    // The authenticated view still has what an operator needs to fix it.
    assert.match(full.asn.error, /not found/);
  } finally {
    delete process.env.GEOIP_ASN_DB;
    geo.reset();
  }
});
