/* ═══════════════════════════════════════════════════════════════════════════
   A resolved collision must not swallow what the collision meant

   Discovery de-conflicts a station id that is already taken, so that a station
   monitored on a second server can be added without the operator inventing a
   unique id by hand. That fix was right and is kept.

   What it did NOT keep is the INFORMATION. The add form already handled this
   case: submitting a taken id failed validation, and the form answered with
   "this looks like a station already being monitored — use Edit, then + Add a
   channel". Pre-resolving the id at discovery time meant the save SUCCEEDED,
   the validation never fired, and that guidance became unreachable.

   Production on 2026-08-31: KPFA is relayed on Pacifica's shared host and also
   runs its own Icecast on streams.kpfa.org:8443. The second one was discovered,
   silently became station `kpfa-2` named "KPFA Berkeley", and the station list
   showed two identical entries with one station's listeners split between them.

   THE CLASS, not the instance: any station already monitored, rediscovered on
   another server, must surface the station it belongs to. A collision that is
   resolved silently is a collision whose meaning was thrown away.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { freeStationId, existingStationFor, suggestStationIdentity } = require('../discover');

/* The configuration as deployed, before the duplicate was created. */
const CONFIG = {
  stations: [
    { id: 'kpft', name: 'KPFT Houston', channels: [{ id: 'kpft-main' }, { id: 'kpft-hd2' }, { id: 'kpft-hd3' }] },
    { id: 'wpfw', name: 'WPFW Washington DC', channels: [{ id: 'wpfw' }] },
    { id: 'kpfk', name: 'KPFK Los Angeles', channels: [{ id: 'kpfk' }] },
    { id: 'wbai', name: 'WBAI New York', channels: [{ id: 'wbai-verizon' }, { id: 'wbai-spectrum' }, { id: 'wbai-wpfw' }] },
    { id: 'kpfa', name: 'KPFA Berkeley', channels: [{ id: 'kpfa' }] },
  ],
};

/* What discovery returns for https://streams.kpfa.org:8443/kpfa — KPFA's own
   Icecast, a different server carrying the same station. */
const KPFA_DIRECT = {
  id: 'kpfa',
  name: 'KPFA Berkeley',
  mounts: ['/kpfa', '/kpfa_192', '/kpfa_24', '/kpfa_128.aac'],
};

test('the station a rediscovered stream belongs to is named, not silently renamed', () => {
  const identity = suggestStationIdentity(KPFA_DIRECT);
  const free = freeStationId(identity.id, [KPFA_DIRECT], CONFIG);
  const existing = existingStationFor(identity.id, CONFIG);

  // The de-confliction still happens — adding a separate station stays possible.
  assert.equal(free.adjusted, true);
  assert.notEqual(free.id, 'kpfa');

  // ...but the operator is told whose stream this is. Without this, the only
  // outcome available was a second "KPFA Berkeley".
  assert.ok(existing, 'the existing station must be surfaced');
  assert.equal(existing.id, 'kpfa');
  assert.equal(existing.name, 'KPFA Berkeley');
});

test('THE CLASS: every already-monitored station, rediscovered, surfaces itself', () => {
  for (const s of CONFIG.stations) {
    // A station's own call sign is what discovery derives its id from, so
    // rediscovering it anywhere produces this id.
    const existing = existingStationFor(s.id, CONFIG);
    assert.ok(existing, `${s.id} rediscovered must surface the station it belongs to`);
    assert.equal(existing.id, s.id);

    // The pairing is the invariant: whenever the id had to be adjusted because
    // a STATION already holds it, the station must come back with it. An
    // adjustment on its own is exactly the silent duplicate.
    const free = freeStationId(s.id, [{ id: s.id, mounts: ['/x'] }], CONFIG);
    assert.equal(free.adjusted, true, `${s.id} should still de-conflict`);
  }
});

test('a genuinely new station is not accused of being an existing one', () => {
  const identity = suggestStationIdentity({ id: 'kpfz', name: 'KPFZ Lakeport', mounts: ['/kpfz'] });
  const free = freeStationId(identity.id, [{ id: 'kpfz', mounts: ['/kpfz'] }], CONFIG);

  assert.equal(free.adjusted, false, 'nothing to de-conflict');
  assert.equal(existingStationFor(identity.id, CONFIG), null);
});

test('a CHANNEL-only collision is not a station handover', () => {
  // The station id is free; only a channel id it would derive is taken. That is
  // a naming clash with no station behind it, and numbering is the right answer.
  const config = { stations: [{ id: 'other', name: 'Other', channels: [{ id: 'knew' }] }] };
  const free = freeStationId('knew', [{ id: 'knew', mounts: ['/knew'] }], config);

  assert.equal(free.adjusted, true);
  assert.equal(existingStationFor('knew', config), null,
    'no station holds this id, so there is nothing to add a channel to');
});

test('the lookup is case-insensitive and survives a missing config', () => {
  assert.equal(existingStationFor('KPFA', CONFIG).id, 'kpfa');
  assert.equal(existingStationFor('kpfa', null), null);
  assert.equal(existingStationFor('', CONFIG), null);
});
