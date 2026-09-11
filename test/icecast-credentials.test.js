/* ═══════════════════════════════════════════════════════════════════════════
   An Icecast admin credential per HOST, because a network is not one server

   Five Pacifica stations share streams.pacifica.org, but WBAI is on
   streaming.wbai.org and KPFA is carried on BOTH Pacifica's host and its own.
   One credential covered one of the three, so two stations got no per-listener
   figures at all — not a limit of the product, only of where the password
   could be put.

   WHY ENV AND NOT THE ADMIN PANEL YET. AUDIENCE-ROADMAP.md §4.1 says these
   belong in the station setup flow, stored against the host. They do. But who
   may enter a credential, who may see that one exists and who may rotate it are
   questions about ROLES, and per-user accounts are deferred to the move to
   Pacifica production. Building the entry UI before that decision means
   building it twice.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');

const monitor = require('../monitor');

const ENV_KEYS = [
  'ICECAST_ADMIN_CREDS', 'ICECAST_ADMIN_USER', 'ICECAST_ADMIN_PASSWORD',
  'ICECAST_ADMIN_HOST',
];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const MAP = JSON.stringify({
  'streaming.wbai.org': { user: 'wbai', password: 'w-secret' },
  'streams.kpfa.org:8443': { user: 'kpfa', password: 'k-secret' },
});

test('each host gets its own credential', () => {
  withEnv({ ICECAST_ADMIN_CREDS: MAP }, () => {
    assert.deepEqual(monitor.adminCredsFor('streaming.wbai.org'), { user: 'wbai', password: 'w-secret' });
    assert.deepEqual(monitor.adminCredsFor('streams.kpfa.org:8443'), { user: 'kpfa', password: 'k-secret' });
  });
});

test('a host with no credential gets none — never another host\'s', () => {
  withEnv({ ICECAST_ADMIN_CREDS: MAP }, () => {
    assert.equal(monitor.adminCredsFor('streams.pacifica.org:9000'), null,
      'sending one server\'s password to another is the failure this scoping prevents');
    assert.equal(monitor.adminCredsFor(''), null);
    assert.equal(monitor.adminCredsFor(undefined), null);
  });
});

test('the existing single-host variables still work', () => {
  withEnv({
    ICECAST_ADMIN_USER: 'admin', ICECAST_ADMIN_PASSWORD: 'p',
    ICECAST_ADMIN_HOST: 'streams.pacifica.org:9000',
  }, () => {
    assert.deepEqual(monitor.adminCredsFor('streams.pacifica.org:9000'), { user: 'admin', password: 'p' });
    assert.equal(monitor.adminCredsFor('streaming.wbai.org'), null,
      'a deployment upgrading must not start posting its password to other servers');
  });
});

test('the map and the single-host variables work together', () => {
  withEnv({
    ICECAST_ADMIN_CREDS: MAP,
    ICECAST_ADMIN_USER: 'admin', ICECAST_ADMIN_PASSWORD: 'p',
    ICECAST_ADMIN_HOST: 'streams.pacifica.org:9000',
  }, () => {
    assert.equal(monitor.adminCredsFor('streams.pacifica.org:9000').user, 'admin');
    assert.equal(monitor.adminCredsFor('streaming.wbai.org').user, 'wbai');
    assert.deepEqual(
      Array.from(monitor.credentialedHosts()).sort(),
      ['streaming.wbai.org', 'streams.kpfa.org:8443', 'streams.pacifica.org:9000'],
    );
  });
});

test('the map wins for a host named in both, so it can be corrected', () => {
  withEnv({
    ICECAST_ADMIN_CREDS: JSON.stringify({ 'h.test': { user: 'new', password: 'n' } }),
    ICECAST_ADMIN_USER: 'old', ICECAST_ADMIN_PASSWORD: 'o', ICECAST_ADMIN_HOST: 'h.test',
  }, () => {
    assert.equal(monitor.adminCredsFor('h.test').user, 'new');
  });
});

/* ── Bad input must degrade, never crash the collection pass ─────────────── */

test('malformed JSON is ignored rather than throwing', () => {
  withEnv({ ICECAST_ADMIN_CREDS: '{not json' }, () => {
    assert.doesNotThrow(() => monitor.adminCredsFor('h.test'));
    assert.equal(monitor.adminCredsFor('h.test'), null);
    assert.deepEqual(Array.from(monitor.credentialedHosts()), []);
  });
});

test('an entry missing a user or a password is dropped, not half-used', () => {
  withEnv({
    ICECAST_ADMIN_CREDS: JSON.stringify({
      'a.test': { user: 'u' },
      'b.test': { password: 'p' },
      'c.test': { user: '', password: 'p' },
      'd.test': { user: 'u', password: 'p' },
    }),
  }, () => {
    assert.equal(monitor.adminCredsFor('a.test'), null);
    assert.equal(monitor.adminCredsFor('b.test'), null);
    assert.equal(monitor.adminCredsFor('c.test'), null);
    assert.ok(monitor.adminCredsFor('d.test'), 'the valid entry still works');
    assert.deepEqual(Array.from(monitor.credentialedHosts()), ['d.test']);
  });
});

test('a JSON array or a bare string is not a credential map', () => {
  for (const raw of ['[]', '"nope"', '42', 'null']) {
    withEnv({ ICECAST_ADMIN_CREDS: raw }, () => {
      assert.equal(monitor.adminCredsFor('h.test'), null, `for ${raw}`);
    });
  }
});

test('nothing configured means no credentials, not a crash', () => {
  withEnv({}, () => {
    assert.equal(monitor.adminCredsFor('h.test'), null);
    assert.deepEqual(Array.from(monitor.credentialedHosts()), []);
  });
});

/* ── The secret must not travel ──────────────────────────────────────────── */

test('credentialedHosts reports HOSTS and never a credential', () => {
  withEnv({ ICECAST_ADMIN_CREDS: MAP }, () => {
    const hosts = Array.from(monitor.credentialedHosts());
    const serialised = JSON.stringify(hosts);
    assert.doesNotMatch(serialised, /w-secret|k-secret/, 'a password must never leave this module');
    assert.doesNotMatch(serialised, /password/i);
    for (const h of hosts) assert.equal(typeof h, 'string', 'hostnames only');
  });
});

test('a hostname is not a secret, so reporting it is intended', () => {
  withEnv({ ICECAST_ADMIN_CREDS: MAP }, () => {
    // The page names the server an operator must go and ask about; hostnames
    // are already in the public station config.
    assert.ok(Array.from(monitor.credentialedHosts()).includes('streaming.wbai.org'));
  });
});
