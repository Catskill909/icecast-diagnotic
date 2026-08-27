/* ═══════════════════════════════════════════════════════════════════════════
   Channel audience

   Icecast publishes each bitrate variant of a channel as a separate mount, so
   "KPFT Main" is /live_128 AND /live_64. Reading only the probed mount reported
   a fraction of the real audience — measured live at 57 of 88 listeners — and
   every listener-loss figure derived from it inherited the undercount.

   These cover the class: any channel whose audience is split across variants.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { channelAudience, channelMountPaths } = require('../diagnose');

const snap = (m) => ({ reachable: true, mounts: m });
const mount = (listeners, peak) => ({ listeners, listenerPeak: peak ?? listeners });

const MAIN = {
  id: 'kpft-main',
  url: 'https://streams.pacifica.org:9000/live_128',
  mounts: ['/live_128', '/live_64'],
};

test('audience is summed across every variant of the channel', () => {
  const s = snap({ '/live_128': mount(22), '/live_64': mount(20) });
  const a = channelAudience(s, MAIN);
  assert.equal(a.listeners, 42, 'both variants must count');
  assert.equal(a.present, 2);
  assert.equal(a.total, 2);
});

test('reading only the probed mount is what undercounted the audience', () => {
  // Regression guard stated as the bug it prevents: if channelAudience ever
  // silently falls back to the primary mount, this figure drops to 22.
  const s = snap({ '/live_128': mount(22), '/live_64': mount(20) });
  assert.notEqual(channelAudience(s, MAIN).listeners, 22);
});

test('a partly-down channel is degraded, not off air', () => {
  const s = snap({ '/live_64': mount(20) });          // 128k variant gone
  const a = channelAudience(s, MAIN);
  assert.equal(a.listeners, 20, 'surviving variant still counts');
  assert.equal(a.present, 1);
  assert.ok(a.present > 0 && a.present < a.total, 'this is the degraded state');
});

test('a fully off-air channel reports present === 0', () => {
  const a = channelAudience(snap({}), MAIN);
  assert.equal(a.present, 0);
  assert.equal(a.listeners, 0);
});

test('mounts belonging to OTHER channels are never counted', () => {
  const s = snap({
    '/live_128': mount(22), '/live_64': mount(20),
    '/HD3_128': mount(4), '/kpfk_128': mount(45),   // other channel, other station
  });
  assert.equal(channelAudience(s, MAIN).listeners, 42);
});

test('peak is summed across variants too', () => {
  const s = snap({ '/live_128': mount(22, 50), '/live_64': mount(20, 30) });
  assert.equal(channelAudience(s, MAIN).peak, 80);
});

test('a single-mount channel still works and does not double-count', () => {
  const hd3 = { url: 'https://streams.pacifica.org:9000/classic_country', mounts: ['/classic_country'] };
  const a = channelAudience(snap({ '/classic_country': mount(4) }), hd3);
  assert.equal(a.listeners, 4);
  assert.equal(a.total, 1, 'primary must not be counted twice');
});

test('a stream declaring no mounts falls back to its probed URL', () => {
  const legacy = { url: 'https://streams.pacifica.org:9000/live_128' };
  const a = channelAudience(snap({ '/live_128': mount(22) }), legacy);
  assert.equal(a.listeners, 22);
  assert.equal(a.total, 1);
});

test('channelMountPaths puts the probed mount first and de-duplicates', () => {
  const p = channelMountPaths(MAIN);
  assert.equal(p[0], '/live_128', 'probed mount leads');
  assert.deepEqual(p, ['/live_128', '/live_64']);
  // Declaring the primary again must not produce a duplicate.
  assert.deepEqual(channelMountPaths({ ...MAIN, mounts: ['/live_128', '/live_64'] }),
                   ['/live_128', '/live_64']);
});

test('an unreachable snapshot yields no audience rather than throwing', () => {
  const a = channelAudience({ reachable: false, mounts: {} }, MAIN);
  assert.equal(a.present, 0);
  assert.equal(a.listeners, 0);
});
