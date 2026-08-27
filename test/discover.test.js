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
