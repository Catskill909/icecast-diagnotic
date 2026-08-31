/* ═══════════════════════════════════════════════════════════════════════════
   Discovery proposes an identifier that actually works

   The promise is: paste one URL, the server tells us the rest. Discovery
   proposed a station id from the call sign alone and handed it to the form
   WITHOUT CHECKING WHETHER IT WAS TAKEN.

   So adding a station already monitored on a DIFFERENT server failed, and the
   only way through was for the operator to invent a unique id by hand. KPFA is
   relayed on Pacifica's shared host AND runs its own Icecast: both publish a
   mount called /kpfa, both produce the id `kpfa`, and the add was refused five
   times in a row. A general manager pasting their stream URL has no reason to
   know another server already claimed the obvious name — and being asked to
   invent `kpfa-berkeley` is not ingestion, it is data entry.

   BOTH HALVES MUST BE CHECKED TOGETHER. A free station id is not sufficient:
   the CHANNEL ids it derives are what key the recorded history, and those are
   what actually collided.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { freeStationId, deriveChannelId, suggestStationIdentity } = require('../discover');

/* Production on 2026-08-31: KPFA already monitored via the Pacifica relay. */
const CONFIG = {
  stations: [
    { id: 'kpft', channels: [{ id: 'kpft-main' }, { id: 'kpft-hd2' }, { id: 'kpft-hd3' }] },
    { id: 'wpfw', channels: [{ id: 'wpfw' }] },
    { id: 'kpfk', channels: [{ id: 'kpfk' }] },
    { id: 'wbai', channels: [{ id: 'wbai-verizon' }, { id: 'wbai-spectrum' }, { id: 'wbai-wpfw' }] },
    { id: 'kpfa', channels: [{ id: 'kpfa' }] },
  ],
};

const KPFA_CHANNELS = [{ id: 'kpfa', mounts: ['/kpfa', '/kpfa_192', '/kpfa_24'] }];

test('the same station on a second server gets a usable id, with no typing', () => {
  const r = freeStationId('kpfa', KPFA_CHANNELS, CONFIG);
  assert.equal(r.adjusted, true);
  assert.notEqual(r.id, 'kpfa');
  assert.equal(r.base, 'kpfa', 'the operator is told what it was adjusted from');
});

test('and the channel id it derives is free too — the half that actually collided', () => {
  const r = freeStationId('kpfa', KPFA_CHANNELS, CONFIG);
  const taken = new Set(CONFIG.stations.flatMap((s) => s.channels.map((c) => c.id)));
  for (const c of KPFA_CHANNELS) {
    assert.equal(taken.has(deriveChannelId(r.id, c.id)), false,
      `${deriveChannelId(r.id, c.id)} is already used — the add would be refused`);
  }
});

test('a genuinely new station keeps the obvious identifier', () => {
  // De-confliction must not make every id ugly. It fires only on a real clash.
  const r = freeStationId('wxyz', [{ id: 'wxyz' }], CONFIG);
  assert.deepEqual(r, { id: 'wxyz', adjusted: false });
});

test('a THIRD copy of the same station still resolves', () => {
  // Pacifica relay, own server, and a hypothetical third — affiliates are
  // relayed in more than one place.
  const withTwo = {
    stations: [...CONFIG.stations, { id: 'kpfa-2', channels: [{ id: 'kpfa-2-kpfa' }] }],
  };
  const r = freeStationId('kpfa', KPFA_CHANNELS, withTwo);
  assert.equal(r.adjusted, true);
  assert.equal(['kpfa', 'kpfa-2'].includes(r.id), false, `got ${r.id}, which is taken`);
});

test('the station id alone being free is NOT enough', () => {
  // The exact shape of the bug. `zzz` is a free STATION id, but the channel it
  // derives is taken, so the add would still have been refused.
  const cfg = { stations: [{ id: 'other', channels: [{ id: 'zzz-kpfa' }] }] };
  const r = freeStationId('zzz', [{ id: 'kpfa' }], cfg);
  assert.notEqual(r.id, 'zzz', 'a free station id with a colliding channel id must be rejected');
});

test('deriveChannelId does not double up a station name', () => {
  // The readability rule that caused this, kept — it is correct, it just could
  // not be the only consideration.
  assert.equal(deriveChannelId('wpfw', 'wpfw'), 'wpfw');
  assert.equal(deriveChannelId('kpft', 'kpft-main'), 'kpft-main');
  assert.equal(deriveChannelId('kpfa-2', 'kpfa'), 'kpfa-2-kpfa');
});

test('the suggested NAME is untouched — only the internal id moves', () => {
  // The operator sees "KPFA"; the id is plumbing.
  const identity = suggestStationIdentity({ name: 'KPFA', mounts: ['/kpfa'] });
  assert.equal(identity.name, 'KPFA');
});
