/* ═══════════════════════════════════════════════════════════════════════════
   Who is allowed to send email

   Configuration lives in one .env, and a developer's copy of it carries the
   production SMTP credentials and the real ALERT_EMAILS. So `node server.js` on
   a laptop mailed the station's General Manager three times, about a test
   fixture named "Seq" pointing at stream.example.org. Recipients cannot tell a
   development alert from a real outage, and an alert channel that cries wolf is
   worth less than no alert channel at all.

   The guard's ONLY hard requirement is the second group of tests: it must never
   silence a real deployment. A missed development email costs nothing; a missed
   outage email is the entire product failing.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-guard-'));

const monitor = require('../monitor');

const MARKERS = ['ALERTS_FORCE', 'MONITOR_CONTAINER', 'NODE_ENV'];

/** Runs fn with every deployment marker cleared, then restores them. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of MARKERS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of MARKERS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Inside a container this file exists, and the guard correctly reports
// "deployed" no matter what the environment says. The dev-machine assertions
// below are only meaningful off a container, which is where developers are.
const inContainer = fs.existsSync('/.dockerenv');

// ── A developer's machine must not mail the station ─────────────────────────

test('a plain checkout with no deployment marker may not send', { skip: inContainer && 'running inside a container' }, () => {
  withEnv({}, () => {
    assert.strictEqual(monitor.isDeployedInstance(), false,
      'this is what mailed the GM three times about a fixture named Seq');
  });
});

test('a stray NODE_ENV=development does not count as deployed', { skip: inContainer && 'running inside a container' }, () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.strictEqual(monitor.isDeployedInstance(), false);
  });
});

test('ALERTS_FORCE must be an explicit true, not merely present', { skip: inContainer && 'running inside a container' }, () => {
  // An empty or "false" value is someone turning it OFF. Treating presence as
  // consent would re-open the hole for anyone who left the key in their .env.
  for (const v of ['', 'false', 'no', '0']) {
    withEnv({ ALERTS_FORCE: v }, () => {
      assert.strictEqual(monitor.isDeployedInstance(), false, `ALERTS_FORCE=${JSON.stringify(v)}`);
    });
  }
});

// ── A real deployment must ALWAYS send ──────────────────────────────────────
// Each signal is independent on purpose: any one of them is enough. A
// deployment that matched none of them would go silent, which is the only
// failure mode of this guard that actually costs anything.

test('the Dockerfile marker permits sending', () => {
  withEnv({ MONITOR_CONTAINER: '1' }, () => {
    assert.strictEqual(monitor.isDeployedInstance(), true);
  });
});

test('NODE_ENV=production permits sending', () => {
  withEnv({ NODE_ENV: 'production' }, () => {
    assert.strictEqual(monitor.isDeployedInstance(), true);
  });
});

test('ALERTS_FORCE=true permits sending, whatever else is set', () => {
  withEnv({ ALERTS_FORCE: 'true' }, () => {
    assert.strictEqual(monitor.isDeployedInstance(), true);
  });
  withEnv({ ALERTS_FORCE: 'TRUE' }, () => {
    assert.strictEqual(monitor.isDeployedInstance(), true);
  });
});

test('the Dockerfile actually sets the marker the guard looks for', () => {
  // The guard and the image have to agree. If someone edits one and not the
  // other, a deployed container falls back to /.dockerenv alone — this test is
  // what notices that the belt was removed and only the braces are left.
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ENV MONITOR_CONTAINER=/m,
    'Dockerfile must set MONITOR_CONTAINER — see isDeployedInstance()');
});
