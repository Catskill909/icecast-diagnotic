/* ═══════════════════════════════════════════════════════════════════════════
   Station discovery

   Turns one pasted URL into a proposed station. The grouping is the whole
   feature: an operator knows their stream URL but should not have to work out
   which of six mounts are bitrate variants of the same programme, and asking
   them is how a form grows to fourteen fields.

   Tested against the real Pacifica inventory, because a heuristic that works on
   invented data and not on the server it was written for is worthless.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { toStatusUrl, channelKeyFor, suggestChannels, summarise } = require('../discover');
const { parseIcecastStatus } = require('../diagnose');

const snapshot = () => {
  const body = fs.readFileSync(path.join(__dirname, 'fixtures', 'pacifica-status.json'), 'utf8');
  const doc = parseIcecastStatus(body);
  return { reachable: true, mounts: doc.mounts, serverId: doc.stats.server_id, host: doc.stats.host };
};

// ── Deriving the status URL ─────────────────────────────────────────────────
test('a status URL is accepted unchanged', () => {
  const r = toStatusUrl('https://streams.pacifica.org:9000/status-json.xsl');
  assert.equal(r.ok, true);
  assert.equal(r.url.pathname, '/status-json.xsl');
});

test('a STREAM url is accepted too — that is what an operator actually has', () => {
  const r = toStatusUrl('https://streams.pacifica.org:9000/live_128');
  assert.equal(r.ok, true);
  assert.equal(r.url.href, 'https://streams.pacifica.org:9000/status-json.xsl');
  assert.ok(r.derivedFrom, 'and it records what it was derived from');
});

test('the port is preserved when deriving — Icecast rarely runs on 443', () => {
  assert.equal(toStatusUrl('https://h.example.org:8000/live').url.href,
               'https://h.example.org:8000/status-json.xsl');
});

test('discovery refuses the same addresses the SSRF guard does', () => {
  // Discovery is the feature that makes URLs user-supplied, so it must not be a
  // way around safe-url.
  assert.equal(toStatusUrl('http://169.254.169.254/latest/meta-data/').ok, false);
  assert.equal(toStatusUrl('file:///etc/passwd').ok, false);
  assert.equal(toStatusUrl('https://user:pw@h/status-json.xsl').ok, false);
});

// ── Grouping ────────────────────────────────────────────────────────────────
test('bitrate suffixes are stripped, other underscores are not', () => {
  assert.equal(channelKeyFor('/live_128'), '/live');
  assert.equal(channelKeyFor('/live_64'), '/live');
  assert.equal(channelKeyFor('/HD3'), '/HD3');
  assert.equal(channelKeyFor('/kpfa_16'), '/kpfa');
  // The trap: a real mount name that merely ends in something numeric-ish.
  assert.equal(channelKeyFor('/classic_country'), '/classic_country');
  assert.equal(channelKeyFor('/studio51'), '/studio51');
});

test('REAL DATA: the Pacifica inventory groups into the channels a listener knows', () => {
  const chans = suggestChannels(Object.values(snapshot().mounts));
  const byId = Object.fromEntries(chans.map((c) => [c.id, c]));

  // KPFT Main: two bitrates of one programme.
  assert.deepEqual(byId.live.mounts.sort(), ['/live_128', '/live_64']);
  // KPFT HD2: three.
  assert.deepEqual(byId.hd3.mounts.sort(), ['/HD3', '/HD3_128', '/HD3_64']);
  // KPFT HD3: one, and it must not be swept in with anything else.
  assert.deepEqual(byId['classic-country'].mounts, ['/classic_country']);
  // A sister station's mounts stay their own channel.
  assert.deepEqual(byId.kpfa.mounts.sort(), ['/kpfa', '/kpfa_16', '/kpfa_64']);
});

test('REAL DATA: metadata titles are NOT used for grouping — they would split a channel', () => {
  // /live_128 announces "KPFT HiRes Stream" and /live_64 "KPFT Houston Stereo
  // Stream" — the same programme under two names. Grouping on title would make
  // them two channels and reinstate the audience undercount.
  const mounts = Object.values(snapshot().mounts);
  const names = new Set(mounts.filter((m) => m.pathname.startsWith('/live')).map((m) => m.serverName));
  assert.ok(names.size > 1, 'precondition: the titles really do differ');
  const live = suggestChannels(mounts).find((c) => c.id === 'live');
  assert.equal(live.variants, 2, 'and they are still one channel');
});

test('the highest bitrate becomes the probed mount', () => {
  const chans = suggestChannels(Object.values(snapshot().mounts));
  const live = chans.find((c) => c.id === 'live');
  assert.equal(live.mounts[0], '/live_128', 'a probe failure should reflect the variant most people are on');
});

test('listeners are summed across a channel, not taken from one mount', () => {
  const mounts = Object.values(snapshot().mounts);
  const live = suggestChannels(mounts).find((c) => c.id === 'live');
  const expected = mounts.filter((m) => m.pathname.startsWith('/live')).reduce((s, m) => s + m.listeners, 0);
  assert.equal(live.listeners, expected);
});

test('channels are returned busiest first', () => {
  const l = suggestChannels(Object.values(snapshot().mounts)).map((c) => c.listeners);
  assert.deepEqual(l, [...l].sort((a, b) => b - a));
});

// ── Summary ─────────────────────────────────────────────────────────────────
test('a shared host is flagged, because the operator must pick out their own', () => {
  const s = summarise(snapshot());
  assert.equal(s.sharedHost, true, 'Pacifica carries five stations on one server');
  assert.ok(s.channelCount >= 8);
  assert.ok(s.totalListeners > 0);
});

test('an empty or unreachable snapshot summarises without throwing', () => {
  for (const bad of [null, undefined, {}, { reachable: false, mounts: {} }]) {
    const s = summarise(bad);
    assert.equal(s.channelCount, 0);
    assert.equal(s.totalListeners, 0);
  }
});

// ── Which channel did they actually paste? ──────────────────────────────────
test('the pasted channel is marked and hoisted to the top', () => {
  // On a shared host most of what was found belongs to other stations. Making
  // someone hunt for their own among eight defeats the point of discovery — and
  // the first version of this screen did exactly that.
  const s = summarise(snapshot(), '/wpfw_128');
  assert.equal(s.matchedChannelId, 'wpfw');
  assert.equal(s.channels[0].id, 'wpfw', 'it must come first, not in listener order');
  assert.equal(s.channels[0].matched, true);
});

test('a pasted mount that is one of several bitrates still matches its channel', () => {
  const s = summarise(snapshot(), '/live_64');
  assert.equal(s.matchedChannelId, 'live', 'the 64k variant identifies KPFT Main');
  assert.equal(s.channels[0].id, 'live');
});

test('pasting a status URL marks nothing, and nothing is hoisted', () => {
  const s = summarise(snapshot(), null);
  assert.equal(s.matchedChannelId, null);
  assert.ok(!s.channels.some((c) => c.matched));
});

test('an unrecognised mount marks nothing rather than guessing', () => {
  const s = summarise(snapshot(), '/not-on-this-server');
  assert.equal(s.matchedChannelId, null);
});

// ── Suggested station identity ──────────────────────────────────────────────
const { suggestStationIdentity } = require('../discover');

test('the call sign is extracted from the metadata name', () => {
  assert.deepEqual(suggestStationIdentity({ name: 'WPFW Eckington 1', mounts: ['/wpfw_128'] }),
                   { name: 'WPFW', id: 'wpfw' });
  assert.deepEqual(suggestStationIdentity({ name: 'KPFA HiRes Stream', mounts: ['/kpfa'] }),
                   { name: 'KPFA', id: 'kpfa' });
});

test('the call sign wins over the mount path for the station id', () => {
  // "/HD3_128" is one KPFT channel, not the station. Deriving the station id
  // from the path would have produced "hd3".
  assert.deepEqual(suggestStationIdentity({ name: 'KPFT HD2 Live Stream', mounts: ['/HD3_128'] }),
                   { name: 'KPFT', id: 'kpft' });
});

test('a mount with no usable name falls back to the path', () => {
  const r = suggestStationIdentity({ name: 'Unspecified name', mounts: ['/classic_country'] });
  assert.equal(r.id, 'classic-country');
});

test('a nameless channel still yields something usable', () => {
  assert.deepEqual(suggestStationIdentity({ name: '', mounts: ['/wuwu'] }), { name: 'WUWU', id: 'wuwu' });
  assert.deepEqual(suggestStationIdentity(null), { name: '', id: '' });
});

test('every suggested id passes the validator that will receive it', () => {
  // A suggestion the form then rejects is worse than no suggestion.
  const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
  for (const c of summarise(snapshot(), '/wpfw_128').channels) {
    const { id } = suggestStationIdentity(c);
    assert.match(id, SLUG, `suggested id "${id}" from "${c.name}" would be rejected`);
  }
});

// ── The URL to probe ────────────────────────────────────────────────────────
test('channel URLs are built from the origin reached, not Icecast self-report', () => {
  // Icecast announces its own address behind the proxy — on the Pacifica server
  // http://stations1.pacifica.org:7267, over plain HTTP — while an operator
  // reaches https://streams.pacifica.org:9000. Taking the announcement would
  // downgrade the connection and probe a path no listener uses.
  const chans = suggestChannels(Object.values(snapshot().mounts), 'https://streams.pacifica.org:9000');
  for (const c of chans) {
    assert.ok(c.url.startsWith('https://streams.pacifica.org:9000/'), `got ${c.url}`);
    assert.doesNotMatch(c.url, /stations1|:7267/, 'must not use the self-reported host');
  }
});

test('the built URL keeps the mount path exactly', () => {
  const c = suggestChannels(Object.values(snapshot().mounts), 'https://h.example.org:8000')
    .find((x) => x.id === 'live');
  assert.equal(c.url, 'https://h.example.org:8000/live_128');
});

test('a trailing slash on the origin does not produce a doubled slash', () => {
  const c = suggestChannels(Object.values(snapshot().mounts), 'https://h.example.org:8000/')
    .find((x) => x.id === 'live');
  assert.equal(c.url, 'https://h.example.org:8000/live_128');
});

test('with no origin it falls back to the announced URL rather than breaking', () => {
  const c = suggestChannels(Object.values(snapshot().mounts)).find((x) => x.id === 'live');
  assert.ok(c.url, 'a URL is still produced');
});

// ── One stream is the normal case ───────────────────────────────────────────
test('a single-stream station sees ONE channel, not the whole server', () => {
  // Twenty-two of the twenty-eight affiliates on the shared Pacifica host are
  // single-channel. Showing all eight and asking someone to find theirs made
  // the normal case look like a puzzle.
  const s = summarise(snapshot(), '/wpfw_128', 'https://streams.pacifica.org:9000');
  const front = s.channels.filter((c) => c.matched || c.sameStation);
  assert.equal(front.length, 1, 'WPFW has one stream and should present as one');
  assert.equal(front[0].id, 'wpfw');
});

test('a multi-channel station gets its siblings surfaced by call sign', () => {
  // KPFT is the exception, and burying its HD2 among four other stations'
  // streams would make the exception needlessly hard.
  const s = summarise(snapshot(), '/live_128', 'https://streams.pacifica.org:9000');
  assert.equal(s.callSign, 'KPFT');
  const front = s.channels.filter((c) => c.matched || c.sameStation);
  assert.ok(front.length >= 2, 'KPFT Main and HD2 belong together');
  assert.ok(front.some((c) => c.id === 'hd3' && c.sameStation), 'HD2 surfaced as a sibling');
});

test('a sibling is surfaced but NOT pre-selected', () => {
  // Surfacing says "this might be yours". Ticking it would claim so.
  const s = summarise(snapshot(), '/live_128', 'https://streams.pacifica.org:9000');
  const sib = s.channels.find((c) => c.sameStation);
  assert.equal(sib.matched, undefined, 'only the pasted channel is the confirmed one');
});

test('another station on the same server is NEVER treated as a sibling', () => {
  // The failure that would actually matter: attaching someone else's stream.
  const s = summarise(snapshot(), '/wpfw_128', 'https://streams.pacifica.org:9000');
  for (const c of s.channels) {
    if (c.matched) continue;
    assert.notEqual(c.sameStation, true, `${c.name} must not be treated as WPFW's`);
  }
});

test('a channel with no call sign in its name is left alone', () => {
  // KPFT's /classic_country announces "Unspecified name". A false negative costs
  // one click; a false positive attaches another station's stream to yours.
  const s = summarise(snapshot(), '/live_128', 'https://streams.pacifica.org:9000');
  const cc = s.channels.find((c) => c.id === 'classic-country');
  assert.notEqual(cc.sameStation, true);
});

test('with no pasted mount there is no call sign and no sibling guessing', () => {
  const s = summarise(snapshot(), null, 'https://streams.pacifica.org:9000');
  assert.equal(s.callSign, null);
  assert.ok(!s.channels.some((c) => c.sameStation));
});
