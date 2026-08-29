/* ═══════════════════════════════════════════════════════════════════════════
   Per-host mount resolution

   A mount path is only meaningful relative to its own server. The monitor used
   to fetch ONE inventory, from one configured status URL, and look up every
   station's mounts in it by bare path. Two independent failures followed, both
   visible on the dashboard at once:

     - /wbai_verizon and /wbai_spectrum live on streaming.wbai.org, which was
       never fetched. They read as ABSENT — struck through, 0 listeners — while
       the stream itself probed ONLINE.

     - /wpfw_128 exists on BOTH streams.pacifica.org:9000 and streaming.wbai.org.
       The WBAI-hosted one inherited Pacifica's 780 listeners. A wrong number
       that looks entirely plausible, which is why nobody caught it by reading.

   These tests are written against the COLLISION, not against WBAI: any two
   hosts sharing a mount path reproduce it. That is the part that would
   otherwise ship again the next time two stations share a naming convention.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const diagnose = require('../diagnose');

const HOST_A = 'alpha.example.org:9000';
const HOST_B = 'beta.example.org';

function mount(path, listeners, extra = {}) {
  return { pathname: path, listeners, listenerPeak: listeners, bitrate: 128, ...extra };
}

/** Two servers that share the /shared_128 path and each carry one unique mount. */
function twoHostSnapshot() {
  return {
    byHost: {
      [HOST_A]: {
        reachable: true,
        serverId: 'Icecast 2.4.3',
        serverStart: 'A-start',
        mountCount: 2,
        mounts: {
          '/shared_128': mount('/shared_128', 780),
          '/only_on_a': mount('/only_on_a', 71),
        },
      },
      [HOST_B]: {
        reachable: true,
        serverId: 'Icecast 2.4.4',
        serverStart: 'B-start',
        mountCount: 2,
        mounts: {
          '/shared_128': mount('/shared_128', 2),
          '/only_on_b': mount('/only_on_b', 69),
        },
      },
    },
    hosts: [HOST_A, HOST_B],
    reachable: true,
    mounts: {},
    mountCount: 4,
  };
}

const streamOn = (host, path) => ({ id: path, name: path, url: `https://${host}${path}` });

test('a shared mount path resolves to its own host, not the first match', () => {
  const snap = twoHostSnapshot();

  // The identical path on two servers must yield two different audiences.
  assert.strictEqual(diagnose.findMount(snap, streamOn(HOST_A, '/shared_128')).listeners, 780);
  assert.strictEqual(diagnose.findMount(snap, streamOn(HOST_B, '/shared_128')).listeners, 2,
    'the B-hosted mount inherited the A-hosted audience — the cross-host collision is back');
});

test('a mount unique to one host is found there and absent on the other', () => {
  const snap = twoHostSnapshot();

  assert.strictEqual(diagnose.findMount(snap, streamOn(HOST_B, '/only_on_b')).listeners, 69,
    'a mount on a host that was never fetched reads as absent — 0 listeners under a live stream');
  assert.strictEqual(diagnose.findMount(snap, streamOn(HOST_A, '/only_on_b')), null);
  assert.strictEqual(diagnose.findMount(snap, streamOn(HOST_B, '/only_on_a')), null);
});

test('channelAudience sums variants within one host only', () => {
  const snap = twoHostSnapshot();
  const stream = { ...streamOn(HOST_B, '/shared_128'), mounts: ['/shared_128', '/only_on_b'] };

  const audience = diagnose.channelAudience(snap, stream);
  assert.strictEqual(audience.listeners, 71, 'B-host variants are 2 + 69');
  assert.strictEqual(audience.present, 2);
  assert.deepStrictEqual(audience.missing, []);
});

test('a mount absent from its own host is missing even when another host has it', () => {
  const snap = twoHostSnapshot();
  const stream = { ...streamOn(HOST_A, '/shared_128'), mounts: ['/shared_128', '/only_on_b'] };

  const audience = diagnose.channelAudience(snap, stream);
  assert.deepStrictEqual(audience.missing, ['/only_on_b'],
    '/only_on_b is on host B; it must not count as present for a host-A channel');
  assert.strictEqual(audience.listeners, 780);
});

test('an unknown host resolves to no inventory rather than to some other server', () => {
  const snap = twoHostSnapshot();
  assert.strictEqual(diagnose.snapshotForStream(snap, streamOn('gamma.example.org', '/shared_128')), null);
  assert.strictEqual(diagnose.findMount(snap, streamOn('gamma.example.org', '/shared_128')), null);
});

test('reachability is per host: one server down does not blind the other', () => {
  const snap = twoHostSnapshot();
  snap.byHost[HOST_A] = { reachable: false, fetchError: 'ETIMEDOUT', mounts: {}, mountCount: 0 };
  snap.reachable = false;

  assert.strictEqual(diagnose.snapshotForStream(snap, streamOn(HOST_A, '/shared_128')).reachable, false);
  assert.strictEqual(diagnose.snapshotForStream(snap, streamOn(HOST_B, '/shared_128')).reachable, true,
    'host B is up; a merged verdict must not mark its streams unknown');
  assert.strictEqual(diagnose.findMount(snap, streamOn(HOST_B, '/only_on_b')).listeners, 69);
});

test('a single-host snapshot still resolves — the pre-multi-host shape', () => {
  const legacy = { reachable: true, mounts: { '/live_128': mount('/live_128', 42) }, mountCount: 1 };
  assert.strictEqual(diagnose.findMount(legacy, streamOn('anything.example.org', '/live_128')).listeners, 42);
});

test('classify reads the stream\'s own server for restart and health evidence', () => {
  const snap = twoHostSnapshot();
  const prev = twoHostSnapshot();
  // Only host A restarted.
  snap.byHost[HOST_A].serverStart = 'A-start-2';

  const up = { status: 'up', responseTime: 100, timings: {} };
  const onB = diagnose.classify({ stream: streamOn(HOST_B, '/only_on_b'), result: up, snapshot: snap, prevSnapshot: prev, cycle: [] });
  assert.notStrictEqual(onB.cause, 'server_restart',
    "host A's restart was attributed to a stream on host B");
});
