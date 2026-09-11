/* ═══════════════════════════════════════════════════════════════════════════
   Export and import — the bundle, and the one field that decides its shape

   THE FAILURE THIS EXISTS TO PREVENT, stated once so it is never re-derived:

   A device is a salted hash of IP and user agent. The hashes live in
   `devices.db`; the salt that made them lives in `events.json`. Move the
   database without the salt and the new host generates a fresh one — so every
   returning listener hashes to a new value. Cume jumps by the whole audience on
   day one and "came back" reads ZERO for ever. Nothing errors, nothing looks
   wrong, and by the time anyone notices the old volume is gone.

   `store.js` already carries this warning for an unclean restart: "the graph
   just goes up." A migration is the same failure, permanent. So a bundle
   carrying hashes without their salt is REFUSED, not warned about.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backup = require('../backup');
const { DeviceStore } = require('../device-store');
const listenerDetail = require('../listener-detail');

const SALT = 'the-secret-that-must-travel';

let seq = 0;
function fixtureDir({ salt = SALT, withDb = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bundle-${seq++}-`));
  const meta = {};
  if (salt) meta.deviceSalt = salt;
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({
    events: [{ id: 'e1', type: 'outage' }, { id: 'e2', type: 'recovery' }],
    meta,
    config: {
      version: 1,
      hosts: [
        { id: 'h1', host: 'streams.pacifica.org:9000', statusUrl: 'https://admin:hunter2@streams.pacifica.org:9000/status-json.xsl' },
        { id: 'h2', host: 'streaming.wbai.org', statusUrl: 'https://streaming.wbai.org/status-json.xsl' },
      ],
      stations: [
        { id: 'kpft', name: 'KPFT Houston', region: 'TX', channels: [{ id: 'kpft-main', name: 'Main', url: 'https://streams.pacifica.org:9000/live_128' }] },
        { id: 'wbai', name: 'WBAI New York', channels: [{ id: 'wbai-a', name: 'A', url: 'https://streaming.wbai.org/wbai' }] },
      ],
    },
  }));
  fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify({ samples: {}, rollups: {} }));
  if (withDb) {
    const s = new DeviceStore(path.join(dir, 'devices.db'));
    s.recordDevices('kpft-main', new Date().toISOString(), [
      { id: listenerDetail.deviceId('1.2.3.4', 'Safari', SALT), cls: 'Safari|iOS', place: 'US:TX:Houston', sess: 3 },
    ]);
  }
  return dir;
}

const snapshotOf = (dir) => () => {
  const s = new DeviceStore(path.join(dir, 'devices.db'));
  const out = path.join(dir, 'snap.db');
  s.snapshotTo(out);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return buf;
};

const build = (dir, opts = {}) => backup.buildBundle({
  dataDir: dir,
  snapshotDeviceDb: fs.existsSync(path.join(dir, 'devices.db')) ? snapshotOf(dir) : null,
  appVersion: '1.0.0',
  sourceHost: 'old.example',
  env: {},
  ...opts,
});

// ── THE SALT ────────────────────────────────────────────────────────────────

test('the salt travels with the device database', () => {
  const b = build(fixtureDir());
  assert.equal(b.manifest.hasDeviceSalt, true);
  assert.equal(b.parts['events.json'].meta.deviceSalt, SALT);
  assert.ok(b.deviceDb, 'and the database is in the same bundle');
  assert.match(b.manifest.deviceSaltNote, /continuous across the move/);
});

test('A DATABASE WITHOUT ITS SALT IS REFUSED, not warned about', () => {
  const b = build(fixtureDir({ salt: null }));
  assert.equal(b.manifest.hasDeviceSalt, false);
  assert.match(b.manifest.deviceSaltNote, /NO DEVICE SALT/);

  const check = backup.validateBundle(b);
  assert.equal(check.ok, false, 'this import cannot be undone by re-running anything');
  assert.ok(
    check.errors.some((e) => /came back.*zero permanently/i.test(e)),
    `the refusal must say what it prevents: ${check.errors.join(' | ')}`,
  );
});

test('a salt with no database is a warning, because nothing is destroyed', () => {
  const b = build(fixtureDir({ withDb: false }));
  const check = backup.validateBundle(b);
  assert.equal(check.ok, true);
  assert.ok(check.warnings.some((w) => /start from empty/.test(w)));
});

test('THE ROUND TRIP: a listener recognised before the move is recognised after', () => {
  const dir = fixtureDir();
  const bundle = backup.unpackBundle(backup.packBundle(build(dir)));

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'target-'));
  backup.applyBundle(bundle, target);

  // The salt came across, so the SAME listener hashes to the SAME id...
  const salt = JSON.parse(fs.readFileSync(path.join(target, 'events.json'), 'utf8')).meta.deviceSalt;
  const id = listenerDetail.deviceId('1.2.3.4', 'Safari', salt);

  // ...and that id is already in the imported database.
  const s = new DeviceStore(path.join(target, 'devices.db'));
  const r = s.getDistinctDevices(['kpft-main'], Date.now() - 6 * 3600_000, Date.now() + 3600_000);
  assert.equal(r.devices, 1);
  assert.deepEqual(r.places.usCities, { 'TX/Houston': 1 });
  assert.equal(
    listenerDetail.deviceId('1.2.3.4', 'Safari', SALT), id,
    'the whole point: this listener is not a stranger on the new host',
  );
});

// ── Credentials must not ride along ────────────────────────────────────────

test('credentials are stripped from URLs, and the count is reported', () => {
  const b = build(fixtureDir());
  const text = JSON.stringify(b.parts);
  assert.ok(!text.includes('hunter2'), 'a password must not be in a file that gets emailed');
  assert.ok(!text.includes('admin:hunter2'));
  assert.equal(b.manifest.redactedCredentials, 1);
  assert.match(b.parts['events.json'].config.hosts[0].statusUrl, /^https:\/\/streams\.pacifica\.org/);
  assert.equal(backup.validateBundle(b).warnings.some((w) => /Re-enter them/.test(w)), true);
});

test('a URL with no credentials is left exactly as it was', () => {
  const b = build(fixtureDir());
  assert.equal(b.parts['events.json'].config.hosts[1].statusUrl, 'https://streaming.wbai.org/status-json.xsl');
});

test('stripping reaches any depth, not just the fields we thought of', () => {
  const { value, removed } = backup.stripCredentials({
    a: [{ b: { c: 'https://u:p@h/x' } }],
    d: 'icecast://user:pass@other/y',
    e: 42,
    f: null,
  });
  assert.equal(removed, 2);
  assert.equal(value.a[0].b.c, 'https://h/x');
  assert.equal(value.d, 'icecast://other/y');
  assert.equal(value.e, 42);
  assert.equal(value.f, null);
});

// ── Secrets are not in the bundle at all ───────────────────────────────────

test('no secret VALUE is exported — only the NAMES a new host will need', () => {
  const env = { SMTP_PASS: 'super-secret-pw', SESSION_SECRET: 'sess-secret', ADMIN_USER: 'paul' };
  const b = build(fixtureDir(), { env });
  const whole = JSON.stringify(b.manifest);
  assert.ok(!whole.includes('super-secret-pw'));
  assert.ok(!whole.includes('sess-secret'));

  const mail = b.manifest.env.mail.find((x) => x.name === 'SMTP_PASS');
  assert.equal(mail.setOnSource, true, 'the operator is told it WAS set, never what it was');
  const geo = b.manifest.env.geo.find((x) => x.name === 'MAXMIND_LICENSE_KEY');
  assert.equal(geo.setOnSource, false);
});

// ── Integrity ──────────────────────────────────────────────────────────────

test('a corrupted part fails its checksum before anything is written', () => {
  const b = build(fixtureDir());
  b.parts['events.json'].events.push({ id: 'injected' });
  const check = backup.validateBundle(b);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /events\.json failed its checksum/.test(e)));
});

test('a truncated device database fails its checksum', () => {
  const b = build(fixtureDir());
  b.deviceDb = Buffer.from(Buffer.from(b.deviceDb, 'base64').subarray(0, 400)).toString('base64');
  const check = backup.validateBundle(b);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /devices\.db failed its checksum/.test(e)));
});

test('a bundle from a NEWER app is refused — that one corrupts rather than stops', () => {
  const b = build(fixtureDir());
  b.manifest.bundleSchema = backup.BUNDLE_SCHEMA + 1;
  const check = backup.validateBundle(b);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /Upgrade the app before importing/.test(e)));
});

test('rubbish is rejected as not-a-bundle rather than throwing', () => {
  for (const bad of [null, undefined, {}, { parts: {} }, 'nope', 42]) {
    assert.equal(backup.validateBundle(bad).ok, false, `rejected: ${JSON.stringify(bad)}`);
  }
});

// ── Applying it ────────────────────────────────────────────────────────────

test('gzip round-trips, and a plain JSON bundle still imports', () => {
  const b = build(fixtureDir());
  assert.equal(backup.unpackBundle(backup.packBundle(b)).manifest.hasDeviceSalt, true);
  assert.equal(backup.unpackBundle(Buffer.from(JSON.stringify(b))).manifest.hasDeviceSalt, true);
});

test('an import REPLACES, and renames the displaced files aside rather than deleting them', () => {
  const source = fixtureDir();
  const target = fixtureDir();
  fs.writeFileSync(path.join(target, 'events.json'), JSON.stringify({ events: [{ id: 'OLD' }], meta: {} }));

  const result = backup.applyBundle(build(source), target);
  const after = JSON.parse(fs.readFileSync(path.join(target, 'events.json'), 'utf8'));
  assert.deepEqual(after.events.map((e) => e.id), ['e1', 'e2'], 'replaced, never merged');
  assert.ok(result.displaced.some((f) => f.startsWith('events.json.replaced-')),
    'the wrong bundle must be recoverable by hand');
  assert.ok(fs.readdirSync(target).some((f) => f.startsWith('events.json.replaced-')));
});

test('stale WAL sidecars are removed, or SQLite may apply them over the import', () => {
  const source = fixtureDir();
  const target = fixtureDir();
  fs.writeFileSync(path.join(target, 'devices.db-wal'), 'stale');
  fs.writeFileSync(path.join(target, 'devices.db-shm'), 'stale');
  backup.applyBundle(build(source), target);
  assert.equal(fs.existsSync(path.join(target, 'devices.db-wal')), false);
  assert.equal(fs.existsSync(path.join(target, 'devices.db-shm')), false);
});

test('a rejected bundle writes nothing at all', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'untouched-'));
  const b = build(fixtureDir({ salt: null }));
  assert.throws(() => backup.applyBundle(b, target), /device salt/i);
  assert.deepEqual(fs.readdirSync(target), [], 'staged then swapped — a refusal leaves no trace');
});

test('an occupied volume is detected, so import can refuse it', () => {
  const dir = fixtureDir();
  const occupied = backup.dataDirOccupied(dir);
  assert.equal(occupied.occupied, true);
  assert.ok(occupied.files.includes('events.json'));
  assert.equal(backup.dataDirOccupied(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))).occupied, false);
});

test('the manifest answers "what is this" without parsing the body', () => {
  const m = build(fixtureDir()).manifest;
  assert.equal(m.counts.stations, 2);
  assert.equal(m.counts.channels, 2);
  assert.equal(m.counts.hosts, 2);
  assert.equal(m.counts.events, 2);
  assert.equal(m.sourceHost, 'old.example');
  assert.equal(m.appVersion, '1.0.0');
  assert.ok(m.sizes['devices.db'] > 0);
  assert.match(m.notInBundle, /Secrets are environment/);
});

test('a corrupt source file stops the export rather than yielding a short bundle', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'samples.json'), '{not json');
  assert.throws(() => build(dir), /samples\.json is not valid JSON/,
    'an incomplete bundle that imports cleanly is the worst outcome');
});

/* ── The over-strict guard, found by the end-to-end migration test ──────────
   A deployment with listener detail switched off, or one that has simply never
   run a pass, has an empty devices.db and no salt — because the salt is created
   the first time a device is hashed. Refusing that bundle blocked a migration
   that had nothing to lose. The rule is about IDENTITIES, not about the file. */

test('an EMPTY device database with no salt is allowed — nothing to orphan', () => {
  const dir = fixtureDir({ salt: null });
  const b = backup.buildBundle({
    dataDir: dir,
    snapshotDeviceDb: () => ({ buffer: snapshotOf(dir)(), rows: 0 }),
    appVersion: '1.0.0',
    env: {},
  });
  assert.equal(b.manifest.counts.deviceRows, 0);
  const check = backup.validateBundle(b);
  assert.equal(check.ok, true, 'a fresh install must be able to migrate');
  assert.ok(check.warnings.some((w) => /starts fresh/.test(w)));
  assert.match(b.manifest.deviceSaltNote, /nothing to carry/);
});

test('a POPULATED device database with no salt is still refused', () => {
  const dir = fixtureDir({ salt: null });
  const b = backup.buildBundle({
    dataDir: dir,
    snapshotDeviceDb: () => ({ buffer: snapshotOf(dir)(), rows: 42 }),
    appVersion: '1.0.0',
    env: {},
  });
  assert.equal(b.manifest.counts.deviceRows, 42);
  assert.equal(backup.validateBundle(b).ok, false);
});

test('an exporter that cannot count is treated as if there were identities', () => {
  // A wrong refusal is an inconvenience; a wrong import is unrecoverable.
  const dir = fixtureDir({ salt: null });
  const b = backup.buildBundle({
    dataDir: dir, snapshotDeviceDb: snapshotOf(dir), appVersion: '1.0.0', env: {},
  });
  assert.equal(b.manifest.counts.deviceRows, null);
  assert.equal(backup.validateBundle(b).ok, false);
});

test('the row count is carried so an operator can see what is being moved', () => {
  const dir = fixtureDir();
  const b = backup.buildBundle({
    dataDir: dir,
    snapshotDeviceDb: () => ({ buffer: snapshotOf(dir)(), rows: 7 }),
    appVersion: '1.0.0', env: {},
  });
  assert.equal(b.manifest.counts.deviceRows, 7);
  assert.equal(backup.validateBundle(b).ok, true);
});

/* ── The salt can also live in the ENVIRONMENT ──────────────────────────────
   store.deviceSalt() prefers DEVICE_HASH_SALT when it is set, and then the
   salt is never written to the volume at all. Two things follow, and missing
   either resets every listener identity as surely as losing the salt outright:
   the bundle cannot carry it, and the variable must be on the checklist. */

const withEnvSalt = (dir, rows) => backup.buildBundle({
  dataDir: dir,
  snapshotDeviceDb: () => ({ buffer: snapshotOf(dir)(), rows }),
  appVersion: '1.0.0',
  env: { DEVICE_HASH_SALT: 'set-in-the-hosting-panel' },
});

test('DEVICE_HASH_SALT is on the env checklist — it IS the salt', () => {
  const m = withEnvSalt(fixtureDir(), 1).manifest;
  const entry = m.env.listenerIdentity.find((x) => x.name === 'DEVICE_HASH_SALT');
  assert.ok(entry, 'the most important variable to carry must be listed');
  assert.equal(entry.setOnSource, true);
});

test('an env-supplied salt is NOT in the bundle, and the manifest says so', () => {
  const m = withEnvSalt(fixtureDir({ salt: null }), 500).manifest;
  assert.equal(m.saltSource, 'environment');
  assert.equal(m.hasDeviceSalt, true, 'it exists — it is simply not ours to carry');
  assert.match(m.deviceSaltNote, /Set the SAME value on the new host/);
  assert.ok(!JSON.stringify(m).includes('set-in-the-hosting-panel'), 'and never its value');
});

test('an env-supplied salt is allowed with a loud warning, not refused', () => {
  // Refusing would block every deployment that sets DEVICE_HASH_SALT.
  const check = backup.validateBundle(withEnvSalt(fixtureDir({ salt: null }), 500));
  assert.equal(check.ok, true);
  assert.ok(check.warnings.some((w) => /DEVICE_HASH_SALT/.test(w) && /SAME value/.test(w)));
});

test('a salt stored in the volume is reported as travelling in the bundle', () => {
  const m = build(fixtureDir()).manifest;
  assert.equal(m.saltSource, 'bundle');
  assert.match(m.deviceSaltNote, /continuous across the move/);
});

test('no salt anywhere, with identities to lose, is still refused', () => {
  const dir = fixtureDir({ salt: null });
  const b = backup.buildBundle({
    dataDir: dir,
    snapshotDeviceDb: () => ({ buffer: snapshotOf(dir)(), rows: 500 }),
    appVersion: '1.0.0',
    env: {},
  });
  assert.equal(b.manifest.saltSource, 'none');
  assert.equal(backup.validateBundle(b).ok, false);
});
