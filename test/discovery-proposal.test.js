/* ═══════════════════════════════════════════════════════════════════════════
   Another station's stream is never pre-ticked

   Discovery classifies every channel on a server: the one you pasted, others
   sharing its call sign, and the rest — "other stations, most likely". The
   admin panel then decided which boxes arrived TICKED from a different fact
   entirely: `sharedHost`, meaning "more than three channels on this server".

   On a smaller host the two disagreed, and the form contradicted itself.
   streaming.wbai.org carries exactly THREE mounts, one of them named "WPFW
   Washington". The panel listed it under "other stations, most likely" and
   pre-ticked it in the same breath. It was added, and a WPFW relay reported its
   listeners as WBAI's audience.

   That is the fixture below: the real production host, at the size where the
   proxy and the classification part company. THE INVARIANT is that a channel
   positively identified as another station's is never proposed — at any host
   size. The number of mounts on a server says nothing about who owns them.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { summarise } = require('../discover');

const mount = (path, name, listeners) => ({
  pathname: path, listenurl: `https://streaming.wbai.org${path}`,
  serverName: name, name, listeners, bitrate: 128,
});

/** streaming.wbai.org exactly as production serves it: three mounts. */
const WBAI_HOST = {
  reachable: true,
  host: 'streaming.wbai.org',
  mounts: {
    a: mount('/wbai_verizon', 'WBAI (Verizon)', 60),
    b: mount('/wbai_spectrum', 'WBAI (Spectrum)', 1),
    c: mount('/wpfw_128', 'WPFW Washington', 2),
  },
};

const byPath = (d, path) => d.channels.find((c) => (c.mounts || []).includes(path));

test('a channel with a different call sign is not proposed, on a small host', () => {
  const d = summarise(WBAI_HOST, '/wbai_verizon', 'https://streaming.wbai.org');

  // This host has three channels, so `sharedHost` is false — the exact
  // condition under which everything used to arrive ticked.
  assert.equal(d.sharedHost, false, 'the fixture must sit below the old threshold');

  const wpfw = byPath(d, '/wpfw_128');
  assert.equal(wpfw.sameStation, undefined, 'WPFW does not share WBAI\'s call sign');
  assert.equal(wpfw.matched, undefined, 'and it is not the pasted stream');
  assert.equal(wpfw.proposed, false, 'so it must not arrive ticked');
});

test('the pasted stream and its call-sign siblings are proposed', () => {
  const d = summarise(WBAI_HOST, '/wbai_verizon', 'https://streaming.wbai.org');
  assert.equal(byPath(d, '/wbai_verizon').proposed, true, 'the stream that was pasted');
  assert.equal(byPath(d, '/wbai_spectrum').proposed, true, 'and its sibling on the same call sign');
});

test('the rule holds on a large shared host too', () => {
  // The case that always worked, kept so a fix aimed at small hosts cannot be
  // written in a way that only applies to them.
  const big = {
    reachable: true,
    host: 'streams.pacifica.org:9000',
    mounts: {
      a: mount('/kpft_128', 'KPFT Houston', 300),
      b: mount('/HD3_128', 'KPFT HD2', 20),
      c: mount('/wpfw_128', 'WPFW Washington', 800),
      d: mount('/kpfk_128', 'KPFK Los Angeles', 100),
      e: mount('/kpfa', 'KPFA Berkeley', 400),
    },
  };
  const d = summarise(big, '/kpft_128', 'https://streams.pacifica.org:9000');
  assert.equal(d.sharedHost, true);
  assert.equal(byPath(d, '/kpft_128').proposed, true);
  assert.equal(byPath(d, '/HD3_128').proposed, true, 'same call sign');
  for (const p of ['/wpfw_128', '/kpfk_128', '/kpfa']) {
    assert.equal(byPath(d, p).proposed, false, `${p} belongs to another station`);
  }
});

test('a status URL with nothing matched still proposes the whole small server', () => {
  // No call sign to reason from: the operator pasted "this server", and with no
  // classification to honour, size is the only signal there is. Behaviour here
  // is deliberately unchanged.
  const d = summarise(WBAI_HOST, null, 'https://streaming.wbai.org');
  assert.equal(d.channels.every((c) => c.proposed), true);
});

test('a status URL on a shared host proposes nothing, rather than five stations', () => {
  const big = {
    reachable: true,
    host: 'streams.pacifica.org:9000',
    mounts: {
      a: mount('/kpft_128', 'KPFT Houston', 300),
      b: mount('/HD3_128', 'KPFT HD2', 20),
      c: mount('/wpfw_128', 'WPFW Washington', 800),
      d: mount('/kpfk_128', 'KPFK Los Angeles', 100),
      e: mount('/kpfa', 'KPFA Berkeley', 400),
    },
  };
  const d = summarise(big, null, 'https://streams.pacifica.org:9000');
  assert.equal(d.channels.some((c) => c.proposed), false);
});
