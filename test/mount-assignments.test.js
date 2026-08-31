/* ═══════════════════════════════════════════════════════════════════════════
   A mount path is not unique across servers

   `diagnose.snapshotForStream()` already exists for this reason on the
   measurement side: one global snapshot indexed by bare path made WBAI's mounts
   read as missing — 0 listeners — while a same-named `/wpfw_128` inherited
   Pacifica's audience.

   The lesson was then reintroduced on the CONFIGURATION side. The admin panel's
   mount inventory built "which channel already owns this mount" keyed by path
   alone, and on live production data it reported `/wpfw_128` on
   streams.pacifica.org:9000 as belonging to `wbai-wpfw` — a channel on
   streaming.wbai.org, a different server entirely.

   It is not a hypothetical collision. THIS DEPLOYMENT SERVES TWO DIFFERENT
   `/wpfw_128` MOUNTS ON TWO DIFFERENT HOSTS, and the fixture below is the real
   configuration.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { mountAssignments } = require('../discover');

/* The production shape, reduced to the part that collides. */
const CONFIG = {
  stations: [
    {
      id: 'wpfw',
      channels: [{
        id: 'wpfw',
        url: 'https://streams.pacifica.org:9000/wpfw_128',
        mounts: ['/wpfw_128'],
      }],
    },
    {
      id: 'wbai',
      channels: [{
        id: 'wbai-wpfw',
        url: 'https://streaming.wbai.org/wpfw_128',
        mounts: ['/wpfw_128'],
      }, {
        id: 'wbai-verizon',
        url: 'https://streaming.wbai.org/wbai_verizon',
        mounts: ['/wbai_verizon'],
      }],
    },
  ],
};

test('the same path on two hosts resolves to two different channels', () => {
  const a = mountAssignments(CONFIG);
  assert.equal(a.get('streams.pacifica.org:9000/wpfw_128').channelId, 'wpfw');
  assert.equal(a.get('streaming.wbai.org/wpfw_128').channelId, 'wbai-wpfw');
});

test('a bare path is not a key at all', () => {
  // The shape of the original bug: any lookup by path alone must miss, rather
  // than silently return whichever channel happened to be written last.
  const a = mountAssignments(CONFIG);
  assert.equal(a.get('/wpfw_128'), undefined);
});

test('both entries survive — one does not overwrite the other', () => {
  // Keyed by path, this map would have had ONE `/wpfw_128` and the second
  // station would have silently replaced the first.
  const a = mountAssignments(CONFIG);
  assert.equal([...a.keys()].filter((k) => k.endsWith('/wpfw_128')).length, 2);
});

test('the station is carried alongside the channel', () => {
  const a = mountAssignments(CONFIG);
  assert.equal(a.get('streams.pacifica.org:9000/wpfw_128').stationId, 'wpfw');
  assert.equal(a.get('streaming.wbai.org/wpfw_128').stationId, 'wbai');
});

test('a channel with an unparseable URL is skipped, not crashed on', () => {
  const a = mountAssignments({ stations: [{ id: 's', channels: [{ id: 'c', url: 'not a url', mounts: ['/x'] }] }] });
  assert.equal(a.size, 0);
});

test('a channel with no mounts contributes nothing', () => {
  const a = mountAssignments({ stations: [{ id: 's', channels: [{ id: 'c', url: 'https://h/x' }] }] });
  assert.equal(a.size, 0);
});

test('an empty or absent configuration is not an error', () => {
  assert.equal(mountAssignments(null).size, 0);
  assert.equal(mountAssignments({}).size, 0);
  assert.equal(mountAssignments({ stations: [] }).size, 0);
});
