/* ═══════════════════════════════════════════════════════════════════════════
   Deep listener analytics — parsing, classification, and the privacy boundary

   THE CLASS THIS FILE EXISTS TO PREVENT: every panel built on per-listener data
   has the same natural implementation — fetch the rows, send them to the
   browser, group them in the chart — and that implementation publishes every
   listener's IP address to anyone who loads the page. It is not an exotic
   mistake; it is the obvious way to write it, and this codebase has shipped
   that class of leak before (`/api/events`, `/api/status`, `/api/history`).

   So the boundary is tested as a property, not as a special case: whatever goes
   into aggregate(), no IP and no raw user-agent string may appear anywhere in
   what comes out. A test that only checked `assert(!out.ip)` would pass while a
   nested field leaked; these walk the whole returned object.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');

const ld = require('../listener-detail');

// A real document, shaped exactly as Icecast 2.4.3 returned it on 2026-09-02.
const DOC = `<?xml version="1.0"?>
<icestats><source mount="/live_128">
<listener><IP>203.0.113.7</IP><UserAgent>Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1</UserAgent><Connected>2208</Connected><ID>1394164</ID></listener>
<listener><IP>198.51.100.22</IP><UserAgent>VLC/3.0.20 LibVLC/3.0.20</UserAgent><Connected>45</Connected><ID>1394165</ID></listener>
<listener><IP>198.51.100.22</IP><UserAgent>Sonos/70.1 (ZPS12)</UserAgent><Connected>7200</Connected><ID>1394166</ID></listener>
<listener><IP>192.0.2.9</IP><UserAgent>TuneIn Radio/26.1; Android</UserAgent><Connected>600</Connected><ID>1394167</ID></listener>
<listener><IP>192.0.2.10</IP><UserAgent>okhttp/4.9.0</UserAgent><Connected>90</Connected><ID>1394168</ID></listener>
<listener><IP>192.0.2.11</IP><UserAgent>Mozilla/5.0 (compatible; UptimeRobot/2.0)</UserAgent><Connected>30</Connected><ID>1394169</ID></listener>
<listener><IP>192.0.2.12</IP><UserAgent>Chrome/120</UserAgent><Connected>340388</Connected><ID>1394170</ID></listener>
</source></icestats>`;

// ── Parsing ─────────────────────────────────────────────────────────────────

test('parses the four fields Icecast 2.4.3 actually returns', () => {
  const rows = ld.parseListClients(DOC);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], {
    ip: '198.51.100.22',
    userAgent: 'VLC/3.0.20 LibVLC/3.0.20',
    connectedSec: 45,
    id: '1394165',
  });
});

test('a document with no listeners is empty, NOT an error', () => {
  const rows = ld.parseListClients('<?xml version="1.0"?><icestats></icestats>');
  assert.deepEqual(rows, [], 'nobody listening is a real answer');
});

test('a non-listclients body is null, not an empty audience', () => {
  // Collapsing these would record "nobody is listening" for a server that
  // returned an error page — a silent zero in the audience record.
  assert.equal(ld.parseListClients('<html><body>502 Bad Gateway</body></html>'), null);
  assert.equal(ld.parseListClients(''), null);
  assert.equal(ld.parseListClients(null), null);
});

test('an unparseable Connected stays null rather than becoming zero', () => {
  const rows = ld.parseListClients(
    '<icestats><listener><IP>1.2.3.4</IP><UserAgent>x</UserAgent><Connected></Connected><ID>1</ID></listener></icestats>',
  );
  assert.equal(rows[0].connectedSec, null, 'zero would land in the "under 1m" bucket and look like a real short session');
});

test('XML entities in a user agent are unescaped', () => {
  const rows = ld.parseListClients(
    '<icestats><listener><IP>1.2.3.4</IP><UserAgent>Foo &amp; Bar/1.0 &quot;beta&quot;</UserAgent><Connected>1</Connected><ID>1</ID></listener></icestats>',
  );
  assert.equal(rows[0].userAgent, 'Foo & Bar/1.0 "beta"');
});

// ── Classification ──────────────────────────────────────────────────────────

test('specific players win over the browser tokens they contain', () => {
  // Nearly every agent below also contains "Mozilla" or a platform token, which
  // is exactly why rule ORDER is load-bearing rather than incidental.
  assert.equal(ld.classifyAgent('Sonos/70.1 (ZPS12)').family, 'Sonos');
  assert.equal(ld.classifyAgent('TuneIn Radio/26.1; Android').family, 'TuneIn');
  assert.equal(ld.classifyAgent('Mozilla/5.0 (compatible; UptimeRobot/2.0)').family, 'Bot / monitor');
  assert.equal(ld.classifyAgent('VLC/3.0.20 LibVLC/3.0.20').family, 'VLC');
});

test('smart speakers are identifiable, including Alexa', () => {
  assert.equal(ld.classifyAgent('Sonos/70.1 (ZPS12)').kind, 'smart-speaker');
  assert.equal(ld.classifyAgent('AlexaMediaPlayer/2.0').kind, 'smart-speaker');
  assert.equal(ld.classifyAgent('CrKey/1.54').family, 'Chromecast');
});

test('an agent carrying no information is an honest unknown, never a guess', () => {
  for (const ua of ['', null, undefined, '   ']) {
    const c = ld.classifyAgent(ua);
    assert.equal(c.family, 'Unknown');
    assert.equal(c.platform, 'Unknown');
  }
  // These are common and mean "some application". Labelling them confidently
  // would be worse than admitting the gap.
  assert.equal(ld.classifyAgent('okhttp/4.9.0').family, 'Script / library');
  assert.equal(ld.classifyAgent('Lavf/58.29.100').family, 'Media library');
});

test('platform is read separately from player', () => {
  assert.equal(ld.classifyAgent('Dalvik/2.1.0 (Linux; U; Android 13; SM-G991B)').platform, 'Android');
  assert.equal(ld.classifyAgent('AppleCoreMedia/1.0 (iPhone; U; CPU OS 17_2)').platform, 'iOS');
});

// ── Aggregation ─────────────────────────────────────────────────────────────

test('bots are excluded from the audience and counted separately', () => {
  const a = ld.aggregate(ld.parseListClients(DOC));
  // UptimeRobot by agent; the 340388s (3.9 day) session by duration.
  assert.equal(a.bots, 2);
  assert.equal(a.connections, 7);
  assert.equal(a.listeners, 5, 'the audience figure is connections minus machines');
});

test('a long session is a machine whatever its agent claims', () => {
  // The 3.9-day row calls itself Chrome. Trusting the agent alone would leave
  // it inside the listener count, and inside the royalty estimate.
  const a = ld.aggregate([{ ip: '1.1.1.1', userAgent: 'Chrome/120', connectedSec: 340388, id: '1' }]);
  assert.equal(a.bots, 1);
  assert.equal(a.listeners, 0);
});

test('session percentiles describe humans only', () => {
  const a = ld.aggregate(ld.parseListClients(DOC));
  assert.equal(a.session.count, 5);
  assert.equal(a.session.maxSec, 7200, 'the 3.9-day bot must not become the maximum session');
});

test('distinct addresses counts values, and is a floor not a headcount', () => {
  const a = ld.aggregate(ld.parseListClients(DOC));
  // Two rows share 198.51.100.22 — one household, two devices.
  assert.equal(a.distinctAddresses, 6);
  assert.ok(a.distinctAddresses < a.connections);
});

test('rows with an unknown duration are counted, not silently dropped', () => {
  const a = ld.aggregate([
    { ip: '1.1.1.1', userAgent: 'VLC', connectedSec: null, id: '1' },
    { ip: '1.1.1.2', userAgent: 'VLC', connectedSec: 60, id: '2' },
  ]);
  assert.equal(a.listeners, 2);
  assert.equal(a.session.unknown, 1);
  assert.equal(a.session.count, 1, 'only measurable sessions enter the percentiles');
});

test('an empty mount aggregates to zero without throwing', () => {
  const a = ld.aggregate([]);
  assert.equal(a.listeners, 0);
  assert.equal(a.session.medianSec, null, 'no sessions means no median, not zero');
});

// ── The privacy boundary ────────────────────────────────────────────────────

/** Every string anywhere in a value, however deeply nested. */
function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push(k); allStrings(x, out); }
  }
  return out;
}

test('THE BOUNDARY: no IP address survives aggregation, anywhere in the object', () => {
  const rows = ld.parseListClients(DOC);
  const strings = allStrings(ld.aggregate(rows, { mount: '/live_128', host: 'streams.example.org' }));
  for (const r of rows) {
    assert.ok(
      !strings.some((s) => s.includes(r.ip)),
      `IP ${r.ip} leaked into the aggregate — this is the whole reason the module exists`,
    );
  }
});

test('THE BOUNDARY: no raw user-agent string survives aggregation', () => {
  const rows = ld.parseListClients(DOC);
  const strings = allStrings(ld.aggregate(rows));
  for (const r of rows) {
    assert.ok(
      !strings.some((s) => s.includes(r.userAgent)),
      `raw agent leaked: ${r.userAgent}`,
    );
  }
  // The CLASSIFIED family is fine and is the point — it is not the raw string.
  const a = ld.aggregate(rows);
  assert.ok(a.players.Sonos, 'the classification is what may be published');
});

test('THE BOUNDARY: connection IDs do not survive either', () => {
  const rows = ld.parseListClients(DOC);
  const strings = allStrings(ld.aggregate(rows));
  for (const r of rows) {
    assert.ok(!strings.some((s) => s === r.id), `connection id ${r.id} leaked`);
  }
});

// ── Merging ─────────────────────────────────────────────────────────────────

test('merging sums the additive fields across mounts', () => {
  const a = ld.aggregate(ld.parseListClients(DOC));
  const m = ld.mergeAggregates([a, a], { mount: 'channel' });
  assert.equal(m.connections, a.connections * 2);
  assert.equal(m.listeners, a.listeners * 2);
  assert.equal(m.players.Sonos, a.players.Sonos * 2);
});

test('a merged median is withheld rather than invented', () => {
  const a = ld.aggregate(ld.parseListClients(DOC));
  const m = ld.mergeAggregates([a, a]);
  assert.equal(m.session.medianSec, null, 'percentiles cannot be merged from percentiles');
  assert.equal(m.session.p90Sec, null);
  // A mean IS mergeable when weighted by its own count, so it survives.
  assert.equal(m.session.meanSec, a.session.meanSec);
  assert.equal(m.session.maxSec, a.session.maxSec, 'a max merges by taking the larger');
});

/* ── Classifications caught in live traffic, 2026-09-02 ─────────────────────
   Every case below is a REAL agent string from Pacifica's server that the first
   version of the table got wrong. They are pinned individually because each one
   moved a whole category of listener into the wrong bucket, and the only way
   the error surfaced at all was an operator reading the breakdown and saying
   "where are the iPhones". A rule table cannot be verified by inspection —
   only against traffic. */

test('AppleCoreMedia on an iPhone is an iOS app, NOT iTunes', () => {
  // The framework every iOS app and Safari audio element streams through.
  // Filing it as iTunes hid the station's entire iPhone audience under a
  // desktop music player.
  const c = ld.classifyAgent('AppleCoreMedia/1.0.0.23G83 (iPhone; U; CPU OS 26_6_1 like Mac OS X)');
  assert.equal(c.family, 'iOS app');
  assert.equal(c.platform, 'iOS');
});

test('real iTunes is still iTunes', () => {
  const c = ld.classifyAgent('iTunes/12.12.4 (Macintosh; OS X 10.15.7)');
  assert.equal(c.family, 'Apple Music / iTunes');
});

test('an Icecast relay is a machine, not a listener', () => {
  // Three of these were sitting in the published listener count as "Unknown".
  // A relay serves its own audience on its own server; counting it here both
  // inflates reach and adds a phantom to the royalty estimate.
  const c = ld.classifyAgent('Icecast 2.4.3');
  assert.equal(c.bot, true, 'a relay must never enter the audience');
  assert.equal(c.family, 'Relay');
  assert.equal(ld.aggregate([{ ip: '1.1.1.1', userAgent: 'Icecast 2.4.3', connectedSec: 60, id: '1' }]).listeners, 0);
});

test('Chrome on Android is a browser, not a native app', () => {
  // "Android" appears in every Android BROWSER agent, so matching the bare OS
  // token labelled Chrome-on-Android a native app and emptied the browser
  // breakdown. Only Dalvik means a native app.
  const c = ld.classifyAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36');
  assert.equal(c.family, 'Chrome');
  assert.equal(c.platform, 'Android', 'the platform is still reported — it moved, it did not vanish');
});

test('a genuine Android native app is still an Android app', () => {
  const c = ld.classifyAgent('Dalvik/2.1.0 (Linux; U; Android 13; SM-G991B)');
  assert.equal(c.family, 'Android app');
});

test('an Amazon Echo is identified — the scope doc expected this to be unanswerable', () => {
  const c = ld.classifyAgent('Echo/1.0(APNG)');
  assert.equal(c.family, 'Alexa');
  assert.equal(c.kind, 'smart-speaker');
});

test('the TuneIn app wins over the iOS beneath it', () => {
  const c = ld.classifyAgent('TuneIn Radio/42.3.0; iPhone14,7; iOS/26.6.1');
  assert.equal(c.family, 'TuneIn', 'distribution channel matters more than the OS carrying it');
  assert.equal(c.platform, 'iOS');
});

/* ── Native app vs browser, and browser identity on iOS ─────────────────────
   TWO SIDES OF ONE CLASS: a platform token that appears in BOTH a native app
   and a browser agent. Match it too broadly and every browser user becomes an
   app user; match it too narrowly and the real apps disappear. The first
   version of this table did both, in opposite directions, on the same platform.
   Every string below is real traffic from 2026-09-02. */

test('a native Android app is told apart from Chrome on Android', () => {
  // ExoPlayer and Media3 are Android's own playback stack and never appear in a
  // browser agent. Dalvik alone caught only 3 of the 8 real apps — most Android
  // radio apps are built on ExoPlayer now.
  for (const ua of [
    'Dalvik/2.1.0 (Linux; U; Android 16; SM-S928U Build/BP4A.251205.006)',
    'just_audio/1.0.5 (Linux;Android 16) ExoPlayerLib/2.18.7',
    'RadioService/1.4 (Linux;Android 12) ExoPlayerLib/2.9.6',
    'just_audio/1.0.1 (Linux;Android 11) AndroidXMedia3/1.4.1',
  ]) {
    assert.equal(ld.classifyAgent(ua).family, 'Android app', ua);
  }
  // ...while the browser stays a browser, with Android still named as platform.
  const c = ld.classifyAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36');
  assert.equal(c.family, 'Chrome');
  assert.equal(c.platform, 'Android');
});

test('an aggregator still wins over the Android stack it is built on', () => {
  // TuneIn's agent contains AndroidXMedia3. Distribution channel is the more
  // important fact about that listener than the toolkit underneath.
  assert.equal(ld.classifyAgent('TuneIn Radio/42.3 (Linux;Android 16) AndroidXMedia3/1.10.1').family, 'TuneIn');
});

test('iOS browsers are not all Safari', () => {
  // Apple requires every iOS browser to use WebKit, so Chrome, Firefox, Edge
  // and the Google app all ship "Safari/604.1". Without their own token first,
  // every one of them is reported as Safari — which is what was happening.
  const ios = (token) => `Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${token} Mobile/15E148 Safari/604.1`;
  assert.equal(ld.classifyAgent(ios('CriOS/152.0.7977.64')).family, 'Chrome');
  assert.equal(ld.classifyAgent(ios('FxiOS/130.0')).family, 'Firefox');
  assert.equal(ld.classifyAgent(ios('EdgiOS/131.0')).family, 'Edge');
  assert.equal(ld.classifyAgent(ios('GSA/436.4.969249353')).family, 'Google app');
  // Real Safari has no third-party token and must still land on Safari.
  assert.equal(ld.classifyAgent(ios('Version/18.7.5')).family, 'Safari');
});

test('desktop browser identity still resolves correctly', () => {
  const win = (t) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${t} Safari/537.36`;
  assert.equal(ld.classifyAgent(win('Chrome/120.0.0.0 Edg/120.0.2210.91')).family, 'Edge');
  assert.equal(ld.classifyAgent(win('Chrome/120.0.0.0')).family, 'Chrome');
  assert.equal(ld.classifyAgent('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0').family, 'Firefox');
});
