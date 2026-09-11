/* ═══════════════════════════════════════════════════════════════════════════
   Export and import — moving a deployment, and the backup it doesn't have

   ONE BUNDLE, NOT A SET OF FILES, and the reason is a single field.

   A device is a salted hash of IP and user agent. The hashes are in
   `devices.db`; the salt that made them is in `events.json`. Move the database
   without the salt and the new host invents a fresh one — so every returning
   listener hashes to a new value, cume jumps by the whole audience on day one,
   and "came back" reads zero for ever. Nothing errors. `store.js` already
   carries this warning for an unclean restart: "the graph just goes up."

   A manual file copy makes that mistake easy: the database is large and
   obvious, the salt is one string inside a different file. So the export is a
   bundle containing both, and the import REFUSES a bundle without the salt.

   WHAT IS NOT IN IT: every secret. SMTP, the admin password hash, the session
   secret and the Icecast credentials are environment, never on the volume — so
   a bundle cannot reproduce a deployment by itself, and pretending otherwise
   ends with a running app that mails nobody. The manifest carries the env var
   NAMES the new host will need, never their values.

   A BUNDLE IS A FILE, and files get downloaded, forwarded and left in folders.
   `host.statusUrl` may carry credentials — which is why redact.js withholds it
   from public responses — so they are stripped here too, and the manifest says
   how many were removed rather than leaving it to be discovered.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/* The bundle format's own version, independent of the app's. Bumped only when
   the SHAPE changes in a way an older reader could misread. An older app
   refusing a newer bundle is the point: reading it wrong corrupts, where
   refusing merely stops. */
const BUNDLE_SCHEMA = 1;

/** The files that together ARE the deployment's state. */
const JSON_PARTS = ['events.json', 'samples.json'];
const DEVICE_DB = 'devices.db';

/* Environment this app reads that a new host must be given again. Names only —
   a value here would put a password in the very file most likely to be
   emailed. Grouped so the checklist reads as a task list rather than a dump. */
const ENV_GROUPS = {
  required: ['DATA_DIR'],
  /* THE ONE THAT DECIDES WHETHER LISTENERS STAY RECOGNISABLE. The salt is
     normally generated once and kept in events.json, where it travels inside
     the bundle. But store.deviceSalt() prefers DEVICE_HASH_SALT when it is set,
     and in that case the salt is never written to the volume at all — so it
     travels only if somebody copies this variable across. First in the list,
     and called out by name in the manifest, because getting it wrong resets
     every listener identity silently. */
  listenerIdentity: ['DEVICE_HASH_SALT'],
  signIn: ['ADMIN_USER', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET'],
  mail: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  icecastAdmin: ['ICECAST_ADMIN_CREDS', 'ICECAST_ADMIN_USER', 'ICECAST_ADMIN_PASSWORD', 'ICECAST_ADMIN_HOST'],
  geo: ['MAXMIND_LICENSE_KEY', 'GEOIP_ASN_DB', 'GEOIP_CITY_DB'],
  identity: ['PRODUCT_NAME', 'PRODUCT_OWNER', 'DASHBOARD_URL', 'STATION_TZ'],
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* A URL with a password in it, in the form Icecast admin URLs take:
   https://user:pass@host/admin/stats.xml. Matched on the credential portion
   rather than on the field name, because the same shape turns up in a channel
   URL, an evidence string, or a field added next year. */
const CRED_URL = /(\w+:\/\/)[^/\s"'@]+:[^/\s"'@]+@/g;

/**
 * Strip credentials from every URL in a value, however deeply nested.
 * Returns the cleaned value and how many were removed, because "we redacted
 * nothing" and "we redacted four" are different things for an operator to know
 * — the second means four things must be re-entered on the new host.
 */
function stripCredentials(value) {
  let removed = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      return v.replace(CRED_URL, (_m, scheme) => { removed += 1; return scheme; });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value), removed };
}

/** The env var names a new host needs, split into what IS and IS NOT set here. */
function envChecklist(env = process.env) {
  const out = {};
  for (const [group, names] of Object.entries(ENV_GROUPS)) {
    out[group] = names.map((name) => ({
      name,
      setOnSource: Boolean(String(env[name] ?? '').trim()),
    }));
  }
  return out;
}

/**
 * Read the deployment's state into a bundle object.
 *
 * `snapshotDeviceDb` is injected rather than imported so this module never
 * needs the store, and so a test can drive it without SQLite. It must produce
 * a CONSISTENT copy — see DeviceStore.snapshotTo, which uses VACUUM INTO
 * because the database runs in WAL mode and a plain file copy is torn.
 */
function buildBundle({ dataDir, snapshotDeviceDb, appVersion, sourceHost = null, env = process.env, now = new Date() }) {
  const parts = {};
  const checksums = {};
  const counts = {};
  const sizes = {};
  let redacted = 0;

  for (const name of JSON_PARTS) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // A corrupt source file must stop the export, not be silently omitted:
      // an incomplete bundle that imports cleanly is the worst outcome here.
      throw new Error(`${name} is not valid JSON and cannot be exported: ${err.message}`);
    }
    const clean = stripCredentials(parsed);
    redacted += clean.removed;
    parts[name] = clean.value;
    const text = JSON.stringify(clean.value);
    checksums[name] = sha256(text);
    sizes[name] = Buffer.byteLength(text);
  }

  counts.events = Array.isArray(parts['events.json']?.events) ? parts['events.json'].events.length : 0;
  const cfg = parts['events.json']?.config;
  counts.stations = Array.isArray(cfg?.stations) ? cfg.stations.length : 0;
  counts.channels = (cfg?.stations || []).reduce((n, s) => n + (s.channels || []).length, 0);
  counts.hosts = Array.isArray(cfg?.hosts) ? cfg.hosts.length : 0;

  /* THE SALT. Named in the manifest as present or absent, so a bundle that
     would silently reset every listener identity can be refused at import
     rather than discovered months later. The VALUE travels inside
     events.json's meta, which is where it already lives. */
  /* The salt is in the volume OR in the environment, and the difference decides
     what the operator has to do next. Env-supplied means the bundle cannot
     carry it and the new host must be given the same value by hand. */
  const storedSalt = parts['events.json']?.meta?.deviceSalt;
  const envSalt = String(env.DEVICE_HASH_SALT ?? '').trim();
  const saltSource = storedSalt ? 'bundle' : (envSalt ? 'environment' : 'none');
  const hasDeviceSalt = saltSource !== 'none';

  let deviceDb = null;
  /* The ROW COUNT matters as much as the bytes. A database holding hashes needs
     its salt or those identities are lost for ever; an EMPTY one — a deployment
     with listener detail switched off, or one that has never run a pass — has
     nothing to orphan, and refusing it would block a perfectly good migration.
     Found by the end-to-end migration test, which is exactly what it was for. */
  let deviceRows = null;
  if (typeof snapshotDeviceDb === 'function') {
    const snap = snapshotDeviceDb();
    // A bare Buffer is accepted so a caller that cannot count is not forced to
    // lie; it is then treated conservatively at validation.
    const buf = Buffer.isBuffer(snap) ? snap : snap?.buffer;
    if (!Buffer.isBuffer(snap) && snap && Number.isInteger(snap.rows)) deviceRows = snap.rows;
    if (buf && buf.length) {
      deviceDb = buf.toString('base64');
      checksums[DEVICE_DB] = sha256(buf);
      sizes[DEVICE_DB] = buf.length;
    }
  }
  counts.deviceRows = deviceRows;

  return {
    manifest: {
      bundleSchema: BUNDLE_SCHEMA,
      appVersion: appVersion || null,
      sourceHost,
      createdAt: now.toISOString(),
      counts,
      sizes,
      checksums,
      hasDeviceSalt,
      saltSource,
      /* Stated plainly, because a device database without its salt is worse
         than no device database: it imports, it looks right, and every
         returning listener reads as new for ever. */
      deviceSaltNote: saltSource === 'bundle'
        ? 'The device salt travelled with the device database. Returning-listener figures will be continuous across the move.'
        : saltSource === 'environment'
          ? 'DEVICE_HASH_SALT is set on the source, so the salt is NOT in this bundle. Set the SAME value on the new host, or every returning listener will read as new for ever.'
          : (deviceRows === 0
          ? 'No device salt, and no device records to go with one — nothing to carry. Listener history starts fresh on the new host.'
            : 'NO DEVICE SALT IN THIS BUNDLE. Importing it would reset every listener identity: "came back" would read zero permanently.'),
      redactedCredentials: redacted,
      env: envChecklist(env),
      notInBundle: 'Secrets are environment, not volume state. Nothing in ENV_GROUPS is exported — see `env` for the names to set on the new host.',
    },
    parts,
    deviceDb,
  };
}

/** Gzip a bundle for transport. One file, and `gunzip -c … | jq .manifest` works. */
function packBundle(bundle) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
}

/** The inverse. Accepts gzipped or plain JSON, because an operator may gunzip. */
function unpackBundle(buf) {
  let text;
  // gzip magic number, so a plain .json still imports rather than erroring.
  if (buf[0] === 0x1f && buf[1] === 0x8b) text = zlib.gunzipSync(buf).toString('utf8');
  else text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return JSON.parse(text);
}

/**
 * Everything that must be true before a single byte is written.
 *
 * Checked TOGETHER and reported as a list, because an operator fixing one
 * problem at a time across a migration window is an operator doing it at 2am.
 */
function validateBundle(bundle, { appSchema = BUNDLE_SCHEMA } = {}) {
  const errors = [];
  const warnings = [];

  if (!bundle || typeof bundle !== 'object' || !bundle.manifest) {
    return { ok: false, errors: ['Not a bundle: no manifest.'], warnings };
  }
  const m = bundle.manifest;

  if (typeof m.bundleSchema !== 'number') errors.push('Manifest has no bundleSchema.');
  else if (m.bundleSchema > appSchema) {
    /* The one failure that corrupts rather than stops. A newer bundle may hold
       fields this build does not know to preserve, so importing it would write
       a volume that silently loses them. */
    errors.push(
      `This bundle was written by a newer version (bundle schema ${m.bundleSchema}, this app understands ${appSchema}). Upgrade the app before importing.`,
    );
  }

  if (!bundle.parts || !bundle.parts['events.json']) {
    errors.push('No events.json in the bundle — that file holds the station configuration and the event record.');
  }

  // Checksums before anything is written: a truncated download must fail loudly
  // rather than half-import.
  for (const [name, expected] of Object.entries(m.checksums || {})) {
    if (name === DEVICE_DB) {
      if (!bundle.deviceDb) { errors.push('Manifest lists a device database but the bundle has none.'); continue; }
      const buf = Buffer.from(bundle.deviceDb, 'base64');
      if (sha256(buf) !== expected) errors.push('devices.db failed its checksum — the bundle is corrupt or truncated.');
      continue;
    }
    const part = bundle.parts?.[name];
    if (part === undefined) { errors.push(`Manifest lists ${name} but the bundle has none.`); continue; }
    if (sha256(JSON.stringify(part)) !== expected) errors.push(`${name} failed its checksum — the bundle is corrupt.`);
  }

  /* THE SALT CHECK, and it is an ERROR rather than a warning when there is a
     device database to go with it. Importing hashes without the salt that made
     them cannot be undone by re-running anything: the identities are gone. */
  const salt = bundle.parts?.['events.json']?.meta?.deviceSalt;
  const rows = m.counts?.deviceRows;
  /* Refused only when there are IDENTITIES to lose. `null` means the exporter
     could not count, which is treated as "assume there are" — the conservative
     direction, because a wrong refusal is an inconvenience and a wrong import
     is unrecoverable. */
  /* An env-supplied salt is legitimate: it simply is not ours to carry. Treated
     as present, with a loud warning naming the variable, rather than refused —
     refusing would block every deployment that sets DEVICE_HASH_SALT. */
  const envSupplied = m.saltSource === 'environment';
  if (envSupplied) {
    warnings.push(
      'The source set DEVICE_HASH_SALT in its environment, so the salt is not in this bundle. '
      + 'Set the SAME value on the new host before importing, or every returning listener will read as new for ever.',
    );
  }
  if (bundle.deviceDb && !salt && !envSupplied && rows !== 0) {
    errors.push(
      'This bundle has a device database but no device salt. Importing it would reset every listener identity — '
      + '"came back" would read zero permanently and individual listeners would jump by the whole audience. Refusing.',
    );
  }
  if (bundle.deviceDb && !salt && !envSupplied && rows === 0) {
    warnings.push('The device database is empty and there is no salt yet — nothing to carry. Listener history starts fresh on the new host.');
  }
  if (!bundle.deviceDb && salt) {
    warnings.push('The bundle carries a device salt but no device database. Listener history will start from empty on the new host.');
  }
  if (m.redactedCredentials) {
    warnings.push(`${m.redactedCredentials} URL credential(s) were stripped at export. Re-enter them on the new host.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Write a validated bundle onto a data directory.
 *
 * REPLACE, NEVER MERGE. Two event logs cannot be interleaved without duplicate
 * ids, and two device databases cannot be unioned at all when they were hashed
 * with different salts — the same device is two different rows and nothing can
 * tell that afterwards.
 *
 * Staged then swapped, so a crash halfway leaves the previous volume intact.
 * The displaced files are RENAMED aside, not deleted: an import that turns out
 * to be the wrong bundle must be recoverable by hand.
 */
function applyBundle(bundle, dataDir, { now = new Date() } = {}) {
  const check = validateBundle(bundle);
  if (!check.ok) throw new Error(check.errors.join(' '));

  fs.mkdirSync(dataDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const staging = path.join(dataDir, `.import-${stamp}`);
  fs.mkdirSync(staging, { recursive: true });

  const written = [];
  try {
    for (const [name, value] of Object.entries(bundle.parts || {})) {
      fs.writeFileSync(path.join(staging, name), JSON.stringify(value));
      written.push(name);
    }
    if (bundle.deviceDb) {
      fs.writeFileSync(path.join(staging, DEVICE_DB), Buffer.from(bundle.deviceDb, 'base64'));
      written.push(DEVICE_DB);
    }

    const displaced = [];
    for (const name of written) {
      const live = path.join(dataDir, name);
      if (fs.existsSync(live)) {
        const aside = path.join(dataDir, `${name}.replaced-${stamp}`);
        fs.renameSync(live, aside);
        displaced.push(path.basename(aside));
      }
      fs.renameSync(path.join(staging, name), live);
      /* WAL and shared-memory sidecars belong to the database being REPLACED.
         Left behind they describe a file that no longer exists, and SQLite may
         apply them over the imported one. */
      if (name === DEVICE_DB) {
        for (const suffix of ['-wal', '-shm']) {
          const stale = path.join(dataDir, DEVICE_DB + suffix);
          if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
        }
      }
    }
    return { written, displaced, warnings: check.warnings };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Is there already a deployment's worth of data here? */
function dataDirOccupied(dataDir) {
  const found = [...JSON_PARTS, DEVICE_DB].filter((n) => {
    const f = path.join(dataDir, n);
    return fs.existsSync(f) && fs.statSync(f).size > 2;
  });
  return { occupied: found.length > 0, files: found };
}

module.exports = {
  BUNDLE_SCHEMA, JSON_PARTS, DEVICE_DB, ENV_GROUPS,
  buildBundle, packBundle, unpackBundle, validateBundle, applyBundle,
  stripCredentials, envChecklist, dataDirOccupied, sha256,
};
