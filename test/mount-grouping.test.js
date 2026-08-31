/* ═══════════════════════════════════════════════════════════════════════════
   A mount whose NAME follows no convention still belongs to its channel

   Grouping keyed on the mount path, which is right for the common case and
   blind to the one that costs the most. KPFA's main stream is `/padma`. It
   shares no prefix with `/kpfa`, so discovery left it out and the station was
   added reporting **5 listeners out of 253** — the other 245 were on a mount
   nobody had grouped.

   The evidence was in the inventory the whole time: `/padma`, `/kpfa_192`,
   `/kpfa_24` and `/kpfa_64.aac` were all playing the same programme, all
   announcing a server_name containing KPFA.

   TWO SIGNALS TOGETHER, NEVER EITHER ALONE:
     · the same non-empty title at this instant
     · the same call sign in server_name

   Title alone would be actively wrong: five Pacifica sister stations share one
   Icecast host and carry the same network programmes, so during Democracy Now
   every station's title matches every other's.

   AND AN ORPHAN JOINS A LADDER; TWO LADDERS NEVER MERGE. KPFT Main and KPFT HD2
   share the call sign KPFT and are separate services. A simulcast would give
   them the same title, and merging them would take HD2's audience into Main's
   figure with nothing on screen to show it happened.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { suggestChannels, callSignOf } = require('../discover');

const ORIGIN = 'https://streams.kpfa.org:8443';

/* KPFA's own server, as it really is. */
const KPFA = [
  { pathname: '/kpfa', listeners: 0, bitrate: null, serverName: null, title: null },
  { pathname: '/kpfa_192', listeners: 3, bitrate: 192, serverName: 'KPFA', title: 'Against the Grain' },
  { pathname: '/kpfa_24', listeners: 3, bitrate: 24, serverName: 'KPFA', title: 'Against the Grain' },
  { pathname: '/padma', listeners: 245, bitrate: 120, serverName: 'KPFA AIR', title: 'Against the Grain' },
  { pathname: '/ku_right', listeners: 5, bitrate: 185, serverName: 'KPFA Air', title: null },
];

const channelWith = (channels, path) => channels.find((c) => c.mounts.includes(path));

test('the unconventionally-named mount joins its channel', () => {
  const ch = channelWith(suggestChannels(KPFA, ORIGIN), '/kpfa');
  assert.ok(ch.mounts.includes('/padma'),
    `/padma was left out; the station would report a fraction of its audience: ${ch.mounts.join(' ')}`);
});

test('and the listener count is the station\'s real audience', () => {
  const ch = channelWith(suggestChannels(KPFA, ORIGIN), '/kpfa');
  assert.equal(ch.listeners, 251, 'the whole channel, not the conventionally-named part of it');
});

test('a same-call-sign mount with NO title is not guessed into the group', () => {
  // /ku_right announces "KPFA Air" but no programme. Same station, unknown
  // relationship — the conservative outcome is its own channel.
  const ch = channelWith(suggestChannels(KPFA, ORIGIN), '/kpfa');
  assert.equal(ch.mounts.includes('/ku_right'), false);
});

test('two stations playing the same network programme are NOT merged', () => {
  // The failure mode that makes title-alone unusable. Five Pacifica sisters
  // share a host and simulcast Democracy Now every weekday.
  const shared = [
    { pathname: '/live_128', listeners: 150, bitrate: 128, serverName: 'KPFT HiRes Stream', title: 'Democracy Now' },
    { pathname: '/kpfk_128', listeners: 80, bitrate: 128, serverName: 'KPFK HiRes Stream', title: 'Democracy Now' },
    { pathname: '/wpfw_128', listeners: 140, bitrate: 128, serverName: 'WPFW', title: 'Democracy Now' },
  ];
  const channels = suggestChannels(shared, ORIGIN);
  assert.equal(channels.length, 3, 'three stations must stay three channels');
});

test('TWO LADDERS NEVER MERGE, even simulcasting the same programme', () => {
  // KPFT Main and KPFT HD2: same call sign, same title during a fund drive,
  // genuinely different services. Merging would fold HD2's audience into Main.
  const sim = [
    { pathname: '/live_128', listeners: 150, bitrate: 128, serverName: 'KPFT HiRes Stream', title: 'Fund Drive' },
    { pathname: '/live_64', listeners: 30, bitrate: 64, serverName: 'KPFT Houston', title: 'Fund Drive' },
    { pathname: '/HD3_128', listeners: 8, bitrate: 128, serverName: 'KPFT HD2 Live Stream', title: 'Fund Drive' },
    { pathname: '/HD3_64', listeners: 2, bitrate: 64, serverName: 'KPFT HD2 Live Stream', title: 'Fund Drive' },
  ];
  const channels = suggestChannels(sim, ORIGIN);
  assert.equal(channels.length, 2, 'Main and HD2 are two channels');
  assert.equal(channelWith(channels, '/live_128').mounts.includes('/HD3_128'), false);
});

test('an orphan with a different call sign stays out', () => {
  const mixed = [
    { pathname: '/kpfa_192', listeners: 3, bitrate: 192, serverName: 'KPFA', title: 'Same Show' },
    { pathname: '/kpfa_24', listeners: 3, bitrate: 24, serverName: 'KPFA', title: 'Same Show' },
    { pathname: '/relay9', listeners: 99, bitrate: 128, serverName: 'WBAI Live', title: 'Same Show' },
  ];
  const ch = channelWith(suggestChannels(mixed, ORIGIN), '/kpfa_192');
  assert.equal(ch.mounts.includes('/relay9'), false);
});

test('callSignOf reads the station out of a server name', () => {
  assert.equal(callSignOf({ serverName: 'KPFA AIR' }), 'KPFA');
  assert.equal(callSignOf({ serverName: 'KPFT HD2 Live Stream' }), 'KPFT');
  assert.equal(callSignOf({ serverName: 'Unspecified name' }), null);
  assert.equal(callSignOf({ serverName: null }), null);
});
