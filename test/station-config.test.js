/* ═══════════════════════════════════════════════════════════════════════════
   Station configuration in the store

   Configuration used to live in environment variables, read once at startup, so
   changing anything meant a redeploy. An admin panel needs to change settings
   while the app runs, and both cannot be authoritative — leaving it ambiguous
   produces the permanent bug "I changed it in Coolify and nothing happened".

   The rule these tests pin down: env vars SEED the configuration once, then the
   store owns it. And critically — channel ids must survive the move, because
   every stored sample, rollup and event is keyed by them.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { buildDefaultConfig, flattenChannels } = require('../monitor');

const KPFT = [
  { id: 'kpft-main', name: 'KPFT Main', url: 'https://streams.pacifica.org:9000/live_128', mounts: ['/live_128', '/live_64'] },
  { id: 'kpft-hd2', name: 'KPFT HD2', url: 'https://streams.pacifica.org:9000/HD3_128', mounts: ['/HD3_128', '/HD3', '/HD3_64'] },
  { id: 'kpft-hd3', name: 'KPFT HD3', url: 'https://streams.pacifica.org:9000/classic_country', mounts: ['/classic_country'] },
];

test('channel ids survive the round trip — stored history is keyed by them', () => {
  const ids = flattenChannels(buildDefaultConfig(KPFT)).map((s) => s.id);
  assert.deepEqual(ids, ['kpft-main', 'kpft-hd2', 'kpft-hd3']);
});

test('mount lists survive the round trip', () => {
  const [main] = flattenChannels(buildDefaultConfig(KPFT));
  assert.deepEqual(main.mounts, ['/live_128', '/live_64']);
});

test('streams sharing one Icecast server produce ONE host', () => {
  // The whole affiliate economics depend on this: one snapshot fetch per host
  // serves every station on it. A host per stream would refetch the same
  // Pacifica server once per channel, every cycle.
  const cfg = buildDefaultConfig(KPFT);
  assert.equal(cfg.hosts.length, 1);
  assert.equal(cfg.hosts[0].host, 'streams.pacifica.org:9000');
});

test('streams on different servers produce separate hosts', () => {
  // A minority of stations span more than one Icecast server.
  const cfg = buildDefaultConfig([
    { id: 'a', url: 'https://one.example.org:9000/a' },
    { id: 'b', url: 'https://two.example.org:8000/b' },
  ]);
  assert.equal(cfg.hosts.length, 2);
  assert.deepEqual(cfg.hosts.map((h) => h.host).sort(), ['one.example.org:9000', 'two.example.org:8000']);
});

test('a derived status URL uses the conventional Icecast path on the same origin', () => {
  const saved = process.env.ICECAST_STATUS_URL;
  delete process.env.ICECAST_STATUS_URL;
  try {
    const cfg = buildDefaultConfig([{ id: 'a', url: 'https://h.example.org:8000/live' }]);
    assert.equal(cfg.hosts[0].statusUrl, 'https://h.example.org:8000/status-json.xsl');
  } finally { if (saved !== undefined) process.env.ICECAST_STATUS_URL = saved; }
});

test('an unparseable stream URL is skipped rather than creating a junk host', () => {
  const cfg = buildDefaultConfig([{ id: 'bad', url: 'not-a-url' }, { id: 'ok', url: 'https://h:9000/a' }]);
  assert.equal(cfg.hosts.length, 1);
  assert.equal(cfg.hosts[0].host, 'h:9000');
});

test('flattening carries the owning station onto each channel', () => {
  const [ch] = flattenChannels(buildDefaultConfig(KPFT));
  assert.ok(ch.stationId, 'channel must know its station');
  assert.ok(ch.stationName);
});

test('flattening tolerates an empty or malformed config without throwing', () => {
  assert.deepEqual(flattenChannels(null), []);
  assert.deepEqual(flattenChannels({}), []);
  assert.deepEqual(flattenChannels({ stations: [{ id: 'x' }] }), [], 'station with no channels');
});

test('a multi-station config flattens every station in order', () => {
  const cfg = {
    stations: [
      { id: 's1', name: 'One', channels: [{ id: 'c1', url: 'https://h:9000/1' }] },
      { id: 's2', name: 'Two', channels: [{ id: 'c2', url: 'https://h:9000/2' }, { id: 'c3', url: 'https://h:9000/3' }] },
    ],
  };
  assert.deepEqual(flattenChannels(cfg).map((c) => c.id), ['c1', 'c2', 'c3']);
});
