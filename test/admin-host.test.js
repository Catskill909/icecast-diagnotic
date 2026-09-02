/* ═══════════════════════════════════════════════════════════════════════════
   Which server an Icecast admin credential may be sent to

   TWO REQUIREMENTS THAT PULL AGAINST EACH OTHER.

   A hostname is not a secret. `streams.pacifica.org:9000` is in the README, in
   STREAMS.md, and is the address listeners connect to. Requiring an operator to
   retype it into a hosting panel before the audience figures switch on is pure
   friction — and it silently cost the first production deploy its entire cume
   collection, because two of the three settings were entered and the third was
   not.

   But an admin PASSWORD must reach exactly one server. KPFA is carried both on
   Pacifica's shared host and on its own at streams.kpfa.org:8443. A credential
   applied to "every monitored host" would post one organisation's admin
   password to another organisation's machine.

   So the host is DERIVED — the server carrying the most monitored channels,
   which is the one the monitor was set up against — and the credential still
   goes to that host alone. These tests pin both halves: it must work with no
   configuration, and it must never leak to a second server.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adminhost-'));

const monitor = require('../monitor');

const PACIFICA = 'streams.pacifica.org:9000';
const KPFA_OWN = 'streams.kpfa.org:8443';

// The real production shape: eight channels on the shared host, KPFA also
// carried on its own server.
const REAL_STREAMS = [
  { id: 'kpft-main', url: `https://${PACIFICA}/live_128` },
  { id: 'kpft-hd2', url: `https://${PACIFICA}/HD3_128` },
  { id: 'kpft-hd3', url: `https://${PACIFICA}/classic_country` },
  { id: 'wpfw', url: `https://${PACIFICA}/wpfw_128` },
  { id: 'kpfk', url: `https://${PACIFICA}/kpfk_128` },
  { id: 'wbai', url: `https://${PACIFICA}/wbai_128` },
  { id: 'kpfa-relay', url: `https://${PACIFICA}/kpfa` },
  { id: 'kpfa-own', url: `https://${KPFA_OWN}/kpfa` },
];

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const noConfig = {
  ICECAST_ADMIN_HOST: undefined,
  ICECAST_STATUS_URL: undefined,
  ICECAST_ADMIN_USER: 'admin',
  ICECAST_ADMIN_PASSWORD: 'secret',
};

test('the host is derived with NO configuration at all', () => {
  monitor._setStreams(REAL_STREAMS);
  withEnv(noConfig, () => {
    assert.equal(monitor.adminHost(), PACIFICA, 'the server carrying most channels');
  });
});

test('THE LEAK THIS PREVENTS: the credential never reaches a second server', () => {
  monitor._setStreams(REAL_STREAMS);
  withEnv(noConfig, () => {
    assert.ok(monitor.adminCredsFor(PACIFICA), 'reaches the host it belongs to');
    assert.equal(
      monitor.adminCredsFor(KPFA_OWN), null,
      "KPFA runs its own Icecast — Pacifica's password must never be sent to it",
    );
    assert.equal(monitor.adminCredsFor('streaming.wbai.org'), null);
  });
});

test('an explicit host overrides the derivation', () => {
  // For the unusual case: a credential issued for a server that is NOT the one
  // carrying most of the channels.
  monitor._setStreams(REAL_STREAMS);
  withEnv({ ...noConfig, ICECAST_ADMIN_HOST: KPFA_OWN }, () => {
    assert.equal(monitor.adminHost(), KPFA_OWN);
    assert.ok(monitor.adminCredsFor(KPFA_OWN));
    assert.equal(monitor.adminCredsFor(PACIFICA), null, 'and then Pacifica is the one refused');
  });
});

test('a status URL still decides it, when one is set', () => {
  monitor._setStreams(REAL_STREAMS);
  withEnv({ ...noConfig, ICECAST_STATUS_URL: `https://${KPFA_OWN}/status-json.xsl` }, () => {
    assert.equal(monitor.adminHost(), KPFA_OWN);
  });
});

test('no credential means nothing is sent anywhere', () => {
  monitor._setStreams(REAL_STREAMS);
  withEnv({ ...noConfig, ICECAST_ADMIN_USER: undefined, ICECAST_ADMIN_PASSWORD: undefined }, () => {
    assert.equal(monitor.adminCredsFor(PACIFICA), null, 'fail closed');
  });
});

test('a half-configured credential is not sent either', () => {
  // A password with no user, or a user with no password, is a misconfiguration.
  // Sending half of it would produce a 401 that looks like a rejected password.
  monitor._setStreams(REAL_STREAMS);
  withEnv({ ...noConfig, ICECAST_ADMIN_PASSWORD: undefined }, () => {
    assert.equal(monitor.adminCredsFor(PACIFICA), null);
  });
  withEnv({ ...noConfig, ICECAST_ADMIN_USER: undefined }, () => {
    assert.equal(monitor.adminCredsFor(PACIFICA), null);
  });
});

test('with no streams there is no host, and nothing is sent speculatively', () => {
  monitor._setStreams([]);
  withEnv(noConfig, () => {
    assert.equal(monitor.adminHost(), '');
    assert.equal(monitor.adminCredsFor(PACIFICA), null);
  });
});

test('a single-station install derives its own server', () => {
  // The affiliate case: one station, one host, no shared server at all.
  monitor._setStreams([{ id: 'only', url: 'https://radio.example.org:8000/live' }]);
  withEnv(noConfig, () => {
    assert.equal(monitor.adminHost(), 'radio.example.org:8000');
  });
});
