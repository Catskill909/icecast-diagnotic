/* ═══════════════════════════════════════════════════════════════════════════
   The Node version is declared in four places, and they must agree

   THE BUG THESE TESTS CATCH: the app moved to Node 24 because `device-store.js`
   needs `node:sqlite` (22.5+), and `store.js` requires it at module load. The
   Dockerfile, package.json and .nvmrc were all updated. The CI unit-test job
   was not — it stayed pinned to Node 20, so 26 test files died at require time
   with "node:sqlite is unavailable" while the image job went green beside them.

   The class is version drift, not that one stale pin: any declaration of the
   runtime that disagrees with the others sends a build somewhere the code does
   not run. So this checks the whole set against each other, and checks the
   interpreter actually running the suite too — one legible failure instead of a
   screenful of unrelated-looking stack traces.

   Deliberately parses no application code, so it still runs on a Node too old
   to load the app at all — which is exactly when its answer matters most.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** [major, minor] from a version string; missing parts read as 0. */
function parts(v) {
  const [major, minor = '0'] = String(v).trim().replace(/^v/, '').split('.');
  return [parseInt(major, 10), parseInt(minor, 10)];
}

const atLeast = (v, min) => {
  const [vMaj, vMin] = parts(v);
  const [mMaj, mMin] = parts(min);
  return vMaj !== mMaj ? vMaj > mMaj : vMin >= mMin;
};

const nvmrc = read('.nvmrc').trim();
const engines = JSON.parse(read('package.json')).engines.node;
// The floor the app genuinely needs, e.g. ">=22.5.0" -> "22.5".
const floor = engines.replace(/^[^\d]*/, '');

test('.nvmrc satisfies the floor package.json declares', () => {
  assert.ok(
    atLeast(nvmrc, floor),
    `.nvmrc is ${nvmrc} but package.json engines.node is ${engines}`,
  );
});

test('every Dockerfile stage builds on the .nvmrc major', () => {
  const froms = [...read('Dockerfile').matchAll(/^FROM node:(\d+)/gm)].map((m) => m[1]);
  assert.ok(froms.length > 0, 'no FROM node: line found in Dockerfile');
  for (const major of froms) {
    assert.equal(
      major, String(parts(nvmrc)[0]),
      `Dockerfile builds on node:${major} but .nvmrc says ${nvmrc}`,
    );
  }
});

test('CI does not test on a Node the app cannot run on', () => {
  // A hardcoded version here is what drifted last time, so the preferred shape
  // is node-version-file. A literal is still allowed — it just has to be a
  // version the app actually supports.
  const ci = read('.github/workflows/ci.yml');
  const pinned = [...ci.matchAll(/^\s*node-version:\s*'?"?([^'"\s]+)/gm)].map((m) => m[1]);
  const fromFile = /^\s*node-version-file:\s*'?"?\.nvmrc/m.test(ci);

  assert.ok(
    fromFile || pinned.length > 0,
    'the CI workflow declares no Node version at all',
  );
  for (const v of pinned) {
    assert.ok(
      atLeast(v, floor),
      `CI pins Node ${v}, below the ${engines} this app requires — `
      + "use node-version-file: '.nvmrc' instead of a literal",
    );
  }
});

test('the interpreter running these tests satisfies the floor', () => {
  // Without this the same mismatch reports as a pile of "Cannot find module"
  // and "node:sqlite is unavailable" failures that look like app bugs.
  assert.ok(
    atLeast(process.version, floor),
    `this suite is running on ${process.version}, below the ${engines} the app `
    + `requires — use the version in .nvmrc (${nvmrc})`,
  );
});
