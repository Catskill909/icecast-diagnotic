/* ═══════════════════════════════════════════════════════════════════════════
   Dockerfile completeness

   auth.js was added and the Dockerfile was not updated, so the image would have
   started and immediately died on `Cannot find module './auth'`. Nothing in the
   test suite or a local run catches that: locally every file is present, and the
   failure only appears inside the built image.

   This walks the require graph from server.js and asserts every local module it
   reaches is COPYd. It is written against the class — any module added later is
   covered automatically, without anyone remembering this file exists.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Every local .js module reachable from an entry point. */
function localModuleGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/require\(['"]\.\/([\w.-]+)['"]\)/g)) {
      const dep = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
      if (fs.existsSync(path.join(ROOT, dep))) stack.push(dep);
    }
  }
  return [...seen].sort();
}

test('every module the app requires at runtime is copied into the image', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const missing = localModuleGraph('server.js')
    .filter((f) => !new RegExp(`^COPY\\s+${f.replace('.', '\\.')}\\s`, 'm').test(dockerfile));

  assert.deepEqual(
    missing, [],
    `these modules are required at runtime but never COPYd — the container would ` +
    `start and die on "Cannot find module": ${missing.join(', ')}`,
  );
});

test('directories the app reads at runtime are copied', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  for (const dir of ['public/', 'seed/']) {
    assert.match(dockerfile, new RegExp(`^COPY\\s+${dir}`, 'm'), `${dir} must be in the image`);
  }
});

test('the entry point named in package.json is the one the image runs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const cmd = /CMD\s+\[([^\]]+)\]/.exec(dockerfile);
  assert.ok(cmd, 'Dockerfile must declare a CMD');
  assert.ok(cmd[1].includes(pkg.main), `CMD should run ${pkg.main}`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   The geo database stage

   THE CLASS: A PATH THAT DRIFTS BETWEEN TWO STAGES. The database is fetched in
   one build stage, copied into another, and named by an ENV default that a
   third thing reads. Nothing connects those three strings but a person
   remembering all of them, and if they drift the image builds cleanly, starts
   cleanly, and silently reports every listener's network as unknown — which
   looks exactly like a deployment that never wanted the database.

   That failure is invisible precisely because the feature is designed to
   degrade quietly when no database is configured.
   ═══════════════════════════════════════════════════════════════════════════ */

test('the geo database is fetched, copied, and named by the same path', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

  const fetched = /fetch-geodb\.sh\s+(\S+\.mmdb)/.exec(dockerfile);
  assert.ok(fetched, 'the geodb stage must fetch to an explicit path');

  const copied = /^COPY\s+--from=geodb\s+(\S+)\s+(\S+)/m.exec(dockerfile);
  assert.ok(copied, 'the fetched database must be copied into the final image');

  const env = /^ENV\s+GEOIP_ASN_DB=(\S+)/m.exec(dockerfile);
  assert.ok(env, 'the image must name a default GEOIP_ASN_DB');

  // /geo/dbip-asn.mmdb, copied from /geo/ to ./geo/, must equal /app/geo/dbip-asn.mmdb.
  const file = path.basename(fetched[1]);
  const dest = copied[2].replace(/^\.\//, '/app/').replace(/\/$/, '');
  assert.equal(
    env[1], `${dest}/${file}`,
    `the ENV default (${env[1]}) does not match where the database is actually `
    + `copied (${dest}/${file}). The image would run with no database and say nothing.`,
  );
});

test('the fetch script the geodb stage runs actually exists and is POSIX sh', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY\s+scripts\/fetch-geodb\.sh/, 'the script must enter the stage');

  const script = fs.readFileSync(path.join(ROOT, 'scripts/fetch-geodb.sh'), 'utf8');
  assert.match(script, /^#!\/bin\/sh/, 'Alpine has no bash — this must be POSIX sh');

  /* `10#$M` is the bash idiom for stripping a leading zero before arithmetic.
     busybox ash does not support it, and without SOME stripping the script
     breaks on 08 and 09 only — a build that works all year and fails through
     August and September.

     COMMENTS ARE STRIPPED FIRST. The script explains in prose why it does not
     use `10#`, and a check that reads the whole file flags that explanation as
     the very thing it warns against. Assert against code, not against writing
     about code. */
  const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!code.includes('10#'), 'busybox ash does not support the 10# base prefix');
  assert.match(code, /\$\{M#0\}/, 'the leading zero must be stripped before arithmetic');
});

test('the geodb stage cannot fail the build', () => {
  /* A monitor that stops shipping because a database mirror had a bad minute
     has traded a working product for an optional feature. */
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const stage = dockerfile.slice(dockerfile.indexOf('AS geodb'));
  const runLine = /RUN if \[ "\$SKIP_GEODB"[\s\S]*?fi/.exec(stage);
  assert.ok(runLine, 'the geodb stage must guard its fetch');
  assert.match(runLine[0], /\|\|/, 'the fetch must fall through on failure, never abort the build');
});
