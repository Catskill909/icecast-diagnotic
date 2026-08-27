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
