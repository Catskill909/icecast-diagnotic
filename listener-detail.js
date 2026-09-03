/* ═══════════════════════════════════════════════════════════════════════════
   Deep listener analytics — Icecast /admin/listclients

   Icecast returns four fields per connected listener: IP, UserAgent, Connected
   (seconds) and ID. Verified against Icecast 2.4.3 on 2026-09-02; the Icecast
   documentation does not enumerate them, so this parser is written against the
   real document and tolerates fields being absent rather than assuming a shape.

   THE ONE RULE THIS MODULE EXISTS TO ENFORCE: an IP address and a raw user
   agent go IN, and neither ever comes OUT. `aggregate()` returns counts,
   distributions and percentiles — never a row, never an address, never an agent
   string. The natural way to build every panel downstream of here is to pass the
   rows to the browser and group them in the chart, which publishes every
   listener's IP to whoever opens the page. Aggregating at the boundary means
   that mistake cannot be made later by someone who has not read this comment.

   `parseListClients()` returns raw rows because aggregation needs them. It is
   exported for tests. Nothing else should call it and nothing should persist
   its output.

   THE COUNTS ARE NOT ALL PEOPLE. Two known distortions, both measured on the
   first real fetch rather than anticipated:

     - A connection that has been open for days is a relay, a scraper or a stuck
       client, not a listener. The very first fetch of /classic_country found one
       at 3d 22h. These are currently inside every listener figure the app
       publishes, including the royalty estimate.
     - Aggregators (TuneIn, iHeart, Radio Garden) either proxy many listeners
       behind one connection or redirect each device to connect directly. Which
       one applies is empirical per aggregator. Where they proxy, everything here
       describes the direct-connection minority.

   Both are reported rather than silently corrected, because a number that
   quietly changed meaning is worse than one that says what it excludes.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const LISTCLIENTS_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.LISTCLIENTS_TIMEOUT_MS, 10) || 10000,
);

/* A session longer than this is not a person listening. Deliberately generous:
   a genuine all-day listener on a kitchen radio exists, and calling them a bot
   would understate the audience. Twelve hours is past any plausible single
   sitting and well short of the multi-day connections that are unambiguously
   machines. */
const BOT_SESSION_SECONDS = Math.max(
  0,
  parseInt(process.env.BOT_SESSION_SECONDS, 10) || 12 * 60 * 60,
);

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Unescape the five XML entities Icecast emits. */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(block, tag) {
  // Icecast is inconsistent about case across versions (IP vs ip), so match
  // either rather than depending on the casing one server happened to emit.
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? unescapeXml(m[1]).trim() : '';
}

/**
 * Rows from a /admin/listclients document.
 *
 * Returns [] for a document with no listeners, and null when the body is not a
 * listclients document at all — those are different, and collapsing them would
 * record "nobody is listening" for a server that returned an error page.
 */
function parseListClients(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return null;
  if (!/<icestats[\s>]/i.test(xml)) return null;

  const rows = [];
  for (const m of xml.matchAll(/<listener>([\s\S]*?)<\/listener>/gi)) {
    const block = m[1];
    const connectedRaw = tagValue(block, 'Connected');
    const connected = parseInt(connectedRaw, 10);
    rows.push({
      ip: tagValue(block, 'IP'),
      userAgent: tagValue(block, 'UserAgent'),
      // Absent or unparseable stays null rather than becoming 0, which would
      // land in the "under a minute" bucket and look like a real short session.
      connectedSec: Number.isFinite(connected) && connected >= 0 ? connected : null,
      id: tagValue(block, 'ID'),
    });
  }
  return rows;
}

// ── User-agent classification ───────────────────────────────────────────────

/* A hand-written table, not a parsing library. Roughly twenty rules cover most
   radio streaming traffic, and a library would be a fourth dependency in a
   project with three for something that does not need one.

   Order matters: the first match wins, so specific players precede the generic
   browser and library patterns they are built on. Sonos identifies itself
   before the Linux it runs on; the TuneIn app before the Android beneath it. */
const PLAYER_RULES = [
  /* Machines first. An Icecast or Shoutcast pulling our stream is a RELAY —
     verified in the live data on 2026-09-02, where three `Icecast 2.4.3`
     connections were sitting inside the published listener count as "Unknown".
     A relay is not a person and must never enter cume or the royalty estimate;
     the audience it serves is counted on ITS server, not ours. */
  [/^icecast|icecast\/|shoutcast|streamcast|liquidsoap/i, 'Relay', 'bot'],
  [/sonos/i,                          'Sonos',            'smart-speaker'],
  [/chromecast|crkey|google ?home/i,  'Chromecast',       'smart-speaker'],
  [/alexa|echo/i,                     'Alexa',            'smart-speaker'],
  [/roku/i,                           'Roku',             'tv'],
  [/appletv|apple ?tv/i,              'Apple TV',         'tv'],
  [/tunein/i,                         'TuneIn',           'aggregator'],
  [/iheart/i,                         'iHeart',           'aggregator'],
  [/radio ?garden/i,                  'Radio Garden',     'aggregator'],
  [/streema|onlineradiobox|radio-?browser/i, 'Directory', 'aggregator'],
  [/vlc/i,                            'VLC',              'desktop-player'],
  [/winamp/i,                         'Winamp',           'desktop-player'],
  [/foobar/i,                         'foobar2000',       'desktop-player'],
  /* AppleCoreMedia is the media framework EVERY iOS app and Safari audio
     element streams through — it is not iTunes, and filing it as such hid the
     station's whole iPhone audience under a desktop music player. Real iTunes
     identifies itself as `iTunes/12.x`. Split by the device in the string. */
  [/applecoremedia.*(iphone|ipad|ipod)/i, 'iOS app',      'app'],
  [/applecoremedia|coremedia/i,       'Apple player',     'desktop-player'],
  [/itunes\/|apple ?music/i,          'Apple Music / iTunes', 'desktop-player'],
  [/windows-?media-?player|nsplayer/i, 'Windows Media',   'desktop-player'],
  [/mpv|mplayer|audacious|rhythmbox|clementine/i, 'Desktop player', 'desktop-player'],
  [/spotify/i,                        'Spotify',          'app'],
  [/bot|crawler|spider|monitor|uptime|pingdom|zabbix|nagios|icecast-?check/i, 'Bot / monitor', 'bot'],
  [/curl|wget|python-?requests|go-?http|java\/|okhttp|libwww|axios|node-?fetch/i, 'Script / library', 'library'],
  [/lavf|ffmpeg|gstreamer|libmpg123/i, 'Media library',   'library'],
  /* NATIVE ANDROID APP vs ANDROID BROWSER — a real distinction, and the agent
     carries it cleanly. Verified against live traffic 2026-09-02:

       Dalvik/2.1.0 (Linux; U; Android 16; SM-S928U ...)          native
       just_audio/1.0.5 (Linux;Android 16) ExoPlayerLib/2.18.7    native
       RadioService/1.4 (Linux;Android 12) ExoPlayerLib/2.9.6     native
       Mozilla/5.0 (Linux; Android 10; K) AppleWebKit ... Chrome  BROWSER

     ExoPlayer, Media3 and Dalvik are Android's own playback stack and never
     appear in a browser agent; `Mozilla/…AppleWebKit` is the browser tell.
     Matching the bare word "android" conflated the two — it labelled every
     Chrome-on-Android user a native app. Matching Dalvik ALONE then went too
     far the other way and lost the five apps built on ExoPlayer/Media3, which
     is how most Android radio apps are written now. */
  [/dalvik|exoplayer|androidxmedia3/i, 'Android app',     'app'],
  [/cfnetwork|darwin/i,               'iOS app',          'app'],
  /* Browsers last: nearly every agent above also contains a browser token.
     And WITHIN browsers, iOS is the trap — Apple requires every iOS browser to
     use WebKit, so Chrome, Firefox, Edge and the Google app ALL ship
     "Safari/604.1" in their agent and are indistinguishable from Safari unless
     their own token is matched FIRST. Verified in live traffic 2026-09-02:
     CriOS and GSA connections were being reported as Safari. */
  [/crios/i,                          'Chrome',           'browser'],
  [/fxios/i,                          'Firefox',          'browser'],
  [/edgios|edga\/|edg\//i,            'Edge',             'browser'],
  [/opr\/|opera/i,                    'Opera',            'browser'],
  [/\bgsa\//i,                        'Google app',       'browser'],
  [/firefox/i,                        'Firefox',          'browser'],
  [/chrome|chromium/i,                'Chrome',           'browser'],
  [/safari/i,                         'Safari',           'browser'],
  [/mozilla/i,                        'Browser',          'browser'],
];

const PLATFORM_RULES = [
  [/iphone|ipad|ios |cfnetwork/i, 'iOS'],
  [/android|dalvik/i,             'Android'],
  [/windows|nsplayer/i,           'Windows'],
  [/mac ?os|macintosh|darwin/i,   'macOS'],
  [/linux|x11/i,                  'Linux'],
];

/**
 * What a user agent tells us, at the granularity it can actually support.
 *
 * `family` is reliable. `platform` usually is. Individual device identity is
 * not attempted — it is both unreliable and not something this tool should be
 * building toward.
 *
 * An agent that carries no information (`okhttp/4.9.0`, `Lavf/58.29`, empty)
 * becomes an honest `unknown` rather than being guessed into a category. These
 * are common, and a confident wrong label is worse than an admitted gap.
 */
function classifyAgent(ua) {
  const s = String(ua || '').trim();
  if (!s) return { family: 'Unknown', kind: 'unknown', platform: 'Unknown', bot: false };

  let family = 'Unknown';
  let kind = 'unknown';
  for (const [re, name, k] of PLAYER_RULES) {
    if (re.test(s)) { family = name; kind = k; break; }
  }

  let platform = 'Unknown';
  for (const [re, name] of PLATFORM_RULES) {
    if (re.test(s)) { platform = name; break; }
  }

  return { family, kind, platform, bot: kind === 'bot' };
}

// ── Device identity, for cume ───────────────────────────────────────────────

/* A device is (IP + user agent). Neither is stored: they are hashed together
   with a secret salt and truncated, and only the hash is kept. The hash exists
   for exactly one question — "have we counted this one already this period" —
   and is useless for any other.

   THE SALT MUST BE STABLE ACROSS RESTARTS. A new salt makes every returning
   listener look new, which would inflate cume on every deploy and quietly turn
   the most important number in the product into a deploy counter. The caller
   supplies it and is responsible for persisting it.

   12 hex characters is 48 bits. At the tens of thousands of devices a station
   sees in a month, the chance of any collision is far below the error already
   introduced by NAT, and a collision only ever UNDER-counts by one. */
function deviceId(ip, userAgent, salt) {
  return crypto
    .createHash('sha256')
    .update(`${salt}\u0000${ip || ''}\u0000${userAgent || ''}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Hashed, classified device identities for a set of listener rows.
 *
 * Machines are excluded here rather than at the far end, so a relay that sits
 * connected for a week can never enter the audience-reach figure. Cume is a
 * count of people reached; a scraper was never reached.
 */
function deviceIdentities(rows, salt) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const cls = classifyAgent(r.userAgent);
    if (cls.bot || (r.connectedSec != null && r.connectedSec >= BOT_SESSION_SECONDS)) continue;
    out.push({ id: deviceId(r.ip, r.userAgent, salt), cls: `${cls.family}|${cls.platform}` });
  }
  return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

const DURATION_BUCKETS = [
  ['under 1m',  0,               60],
  ['1–5m',      60,              5 * 60],
  ['5–15m',     5 * 60,          15 * 60],
  ['15–60m',    15 * 60,         60 * 60],
  ['1–6h',      60 * 60,         6 * 60 * 60],
  ['6h+',       6 * 60 * 60,     Infinity],
];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function tally(map, key) {
  map[key] = (map[key] || 0) + 1;
}

// ── Distribution channel ────────────────────────────────────────────────────

/* HOW THE AUDIENCE REACHES THE STATION, and — the reason this is load-bearing
   rather than a nice breakdown — HOW WRONG EVERY OTHER FIGURE IS.

   An aggregator that PROXIES relays one connection on behalf of many listeners.
   Every count this app publishes (concurrent, tune-ins, ATH, the royalty
   estimate) then understates the real audience by an unknown factor. Knowing
   the proxied share is what tells you the size of that error, which is why
   `DEEP-ANALYTICS-PLAN.md` §7 puts it BEFORE publishing anything derived from
   sessions.

   Two signals, applied in this order:

     1. THE USER AGENT names an aggregator (TuneIn, iHeart, Radio Garden). This
        needs no database and works today.
     2. THE AS ORGANISATION is a known hosting provider. A person listens from a
        consumer ISP; a relay listens from a datacenter.

   User agent wins, because it NAMES the service and the ASN only says
   "somewhere in AWS". A connection matching neither is `direct`.

   `DEEP-ANALYTICS-PLAN.md` §3 lists a third signal — connection shape, an
   address holding a very long session and reconnecting rarely. The long-session
   half of that is already applied as the bot rule above. The rest needs history
   across polls, which is a later build.

   A PROXIED LISTENER IS NOT A LOST LISTENER. It is an uncounted one. Every
   caller rendering this must say so, or a station reads a high proxied share as
   an audience decline. */
function classifyChannel(cls, net) {
  if (cls.kind === 'aggregator') return { channel: 'aggregator', name: cls.family };
  if (net && net.network === 'hosting') return { channel: 'datacenter', name: net.org || null };
  if (net && net.resolved) return { channel: 'direct', name: null };
  return { channel: 'unknown', name: null };
}

/* No geo database configured: every connection resolves as unknown, so the
   user-agent signal still works and nothing throws. Injected rather than
   required at module load so tests can drive the rules directly. */
const NO_GEO = { lookupNetwork: () => ({ resolved: false, reason: 'no-database', network: 'unknown', asn: null, org: null }) };

/**
 * Turn listener rows into publishable aggregates.
 *
 * NOTHING identifying survives this function. IPs are used only to count
 * distinct values and are then discarded; the count is a number, not a set.
 *
 * Bots are counted and reported SEPARATELY rather than dropped, because "we
 * excluded 3 non-human connections" is itself a finding — it is the difference
 * between the published listener count and the real audience.
 */
function aggregate(rows, { mount = '', host = '', fetchedAt = new Date().toISOString(), geo = NO_GEO } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  const players = {};
  const platforms = {};
  const kinds = {};
  const buckets = {};
  for (const [label] of DURATION_BUCKETS) buckets[label] = 0;

  const channels = { direct: 0, aggregator: 0, datacenter: 0, unknown: 0 };
  const aggregators = {};
  const relayNetworks = {};
  let networkResolved = 0;

  const distinctIps = new Set();
  const humanDurations = [];
  let bots = 0;
  let unknownDuration = 0;

  for (const r of list) {
    const cls = classifyAgent(r.userAgent);
    // A session longer than any plausible sitting is a machine regardless of
    // what its agent claims, which is how a relay with a browser-shaped agent
    // gets caught.
    const isBot = cls.bot || (r.connectedSec != null && r.connectedSec >= BOT_SESSION_SECONDS);

    if (r.ip) distinctIps.add(r.ip);

    if (isBot) { bots += 1; continue; }

    tally(players, cls.family);
    tally(platforms, cls.platform);
    tally(kinds, cls.kind);

    /* The IP is used here and discarded with the row. It never enters any
       accumulator above: `channels` counts, `aggregators` holds service names
       from the user agent, and `relayNetworks` holds AS organisations. */
    const net = geo.lookupNetwork(r.ip);
    if (net.resolved) networkResolved += 1;
    const ch = classifyChannel(cls, net);
    tally(channels, ch.channel);
    if (ch.channel === 'aggregator') tally(aggregators, ch.name || 'Unknown');
    /* NAME THE NETWORKS THAT ARE MACHINES; NEVER NAME THE NETWORKS THAT ARE
       PEOPLE. Which relay a station's audience arrives through is the finding.
       A tally of CONSUMER ISPs answers no question anyone here is asking, and
       at this audience size a count of one would say something about a person
       — "1 listener at a named university" is not an aggregate. */
    if (ch.channel === 'datacenter' && ch.name) tally(relayNetworks, ch.name);

    if (r.connectedSec == null) { unknownDuration += 1; continue; }
    humanDurations.push(r.connectedSec);
    for (const [label, lo, hi] of DURATION_BUCKETS) {
      if (r.connectedSec >= lo && r.connectedSec < hi) { buckets[label] += 1; break; }
    }
  }

  humanDurations.sort((a, b) => a - b);
  const sum = humanDurations.reduce((a, b) => a + b, 0);

  return {
    mount,
    host,
    fetchedAt,
    // Everything Icecast returned, before any judgement was applied.
    connections: list.length,
    // What is left once machines are removed. THIS is the audience figure.
    listeners: list.length - bots,
    bots,
    // Distinct source addresses among ALL connections. A floor on distinct
    // devices and a ceiling on nothing: a household behind one NAT is one
    // address, and an aggregator proxying hundreds is also one.
    distinctAddresses: distinctIps.size,
    session: {
      count: humanDurations.length,
      unknown: unknownDuration,
      meanSec: humanDurations.length ? Math.round(sum / humanDurations.length) : null,
      medianSec: percentile(humanDurations, 50),
      p90Sec: percentile(humanDurations, 90),
      maxSec: humanDurations.length ? humanDurations[humanDurations.length - 1] : null,
      buckets,
    },
    players,
    platforms,
    kinds,
    channels,
    aggregators,
    relayNetworks,
    proxied: proxiedSummary(channels, networkResolved, list.length - bots),
  };
}

/**
 * The proxied share, with the confidence that belongs to it.
 *
 * THIS IS A SHARE OF CONNECTIONS, NOT OF LISTENING, and the two differ by
 * exactly the factor nobody can measure: one proxied connection may carry one
 * listener or four hundred. A 10% proxied connection share is therefore
 * compatible with 60% of actual listening arriving that way. The field is named
 * `connectionShare` so no caller can shorten it to "share" and mean listening.
 *
 * The confidence vocabulary is `DEEP-ANALYTICS-PLAN.md` §2:
 *
 *   `floor`     — no ASN database, so only user agents that NAME an aggregator
 *                 are caught. Unnamed relays are invisible, so the true share
 *                 is at least this and possibly far more.
 *   `estimated` — an ASN database is answering, but "is this a hosting
 *                 provider" is a match against organisation names, not a flag
 *                 any free database carries. See geo.js.
 *
 * There is deliberately no `measured`. Nothing available here measures this.
 */
function proxiedSummary(channels, networkResolved, considered) {
  const proxiedConnections = (channels.aggregator || 0) + (channels.datacenter || 0);
  if (!considered) {
    return {
      connections: 0, connectionShare: null, confidence: 'unavailable',
      reason: 'no-connections', networkCoverage: null,
    };
  }
  return {
    connections: proxiedConnections,
    connectionShare: proxiedConnections / considered,
    confidence: networkResolved > 0 ? 'estimated' : 'floor',
    reason: networkResolved > 0 ? null : 'no-asn-database',
    // How much of the audience the ASN signal could speak to at all. A low
    // number means the figure rests almost entirely on user agents.
    networkCoverage: networkResolved / considered,
  };
}

/**
 * Merge per-mount aggregates into one, for a channel or a whole host.
 *
 * Percentiles CANNOT be merged from percentiles, so `session` percentiles are
 * dropped rather than averaged into a plausible-looking lie. Only the additive
 * fields survive. A caller that needs a real median across mounts has to
 * aggregate the rows together in the first place.
 */
function mergeAggregates(parts, { mount = '', host = '', fetchedAt = new Date().toISOString() } = {}) {
  const list = (parts || []).filter(Boolean);
  const out = {
    mount, host, fetchedAt,
    connections: 0, listeners: 0, bots: 0, distinctAddresses: null,
    session: { count: 0, unknown: 0, meanSec: null, medianSec: null, p90Sec: null, maxSec: null, buckets: {} },
    players: {}, platforms: {}, kinds: {},
    channels: { direct: 0, aggregator: 0, datacenter: 0, unknown: 0 },
    aggregators: {}, relayNetworks: {},
    merged: list.length,
  };
  for (const [label] of DURATION_BUCKETS) out.session.buckets[label] = 0;

  let weighted = 0;
  /* Recomputed from the merged counts rather than averaged from the parts. A
     share is not additive: averaging two mounts' shares weights a mount with
     three listeners equally against one with three hundred. */
  let networkResolved = 0;
  let weakestConfidence = null;
  for (const p of list) {
    out.connections += p.connections || 0;
    out.listeners += p.listeners || 0;
    out.bots += p.bots || 0;
    for (const [k, v] of Object.entries(p.channels || {})) out.channels[k] = (out.channels[k] || 0) + v;
    for (const [k, v] of Object.entries(p.aggregators || {})) out.aggregators[k] = (out.aggregators[k] || 0) + v;
    for (const [k, v] of Object.entries(p.relayNetworks || {})) out.relayNetworks[k] = (out.relayNetworks[k] || 0) + v;
    if (p.proxied?.networkCoverage != null) {
      networkResolved += p.proxied.networkCoverage * ((p.connections || 0) - (p.bots || 0));
    }
    /* A merged figure inherits the WEAKEST confidence of its parts — the §2
       rule that the tune-in comparison violated. One mount read without an ASN
       database makes the whole channel's share a floor, not an estimate. */
    if (p.proxied?.confidence === 'floor') weakestConfidence = 'floor';
    out.session.count += p.session?.count || 0;
    out.session.unknown += p.session?.unknown || 0;
    if (p.session?.meanSec != null) weighted += p.session.meanSec * (p.session.count || 0);
    if (p.session?.maxSec != null) {
      out.session.maxSec = Math.max(out.session.maxSec ?? 0, p.session.maxSec);
    }
    for (const [k, v] of Object.entries(p.session?.buckets || {})) out.session.buckets[k] = (out.session.buckets[k] || 0) + v;
    for (const [k, v] of Object.entries(p.players || {})) out.players[k] = (out.players[k] || 0) + v;
    for (const [k, v] of Object.entries(p.platforms || {})) out.platforms[k] = (out.platforms[k] || 0) + v;
    for (const [k, v] of Object.entries(p.kinds || {})) out.kinds[k] = (out.kinds[k] || 0) + v;
  }
  // A mean IS mergeable when weighted by its own count; a median is not.
  out.session.meanSec = out.session.count ? Math.round(weighted / out.session.count) : null;

  out.proxied = proxiedSummary(out.channels, networkResolved, out.connections - out.bots);
  if (weakestConfidence === 'floor' && out.proxied.confidence !== 'unavailable') {
    out.proxied.confidence = 'floor';
    out.proxied.reason = 'no-asn-database';
  }
  return out;
}

// ── Fetching ────────────────────────────────────────────────────────────────

/**
 * One /admin/listclients request.
 *
 * Credentials are passed per call rather than read from the environment here,
 * so the caller decides which host each credential is allowed to reach. That is
 * deliberate: several monitored stations run their own Icecast, and a
 * credential attached to the wrong one would be sent to a third party.
 */
function fetchListClients(baseUrl, mountPath, { user, password, timeout = LISTCLIENTS_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let url;
    try {
      url = new URL(`/admin/listclients`, baseUrl);
      url.searchParams.set('mount', mountPath);
    } catch {
      return resolve({ ok: false, error: 'Invalid host URL', errorCode: 'EURL', rows: null });
    }

    const client = url.protocol === 'http:' ? http : https;
    let cancelDeadline = () => {};
    const settle = (p) => { cancelDeadline(); resolve({ ...p, responseTime: Date.now() - start }); };

    const req = client.get(
      url,
      {
        timeout,
        // Basic auth via the header rather than the URL: a credential in a URL
        // ends up in logs, error messages and anything that echoes the request.
        headers: user
          ? { Authorization: `Basic ${Buffer.from(`${user}:${password || ''}`).toString('base64')}` }
          : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return settle({ ok: false, error: 'Admin credentials rejected', errorCode: 'EAUTH', rows: null });
          }
          if (res.statusCode !== 200) {
            return settle({ ok: false, error: `listclients returned HTTP ${res.statusCode}`, errorCode: `HTTP_${res.statusCode}`, rows: null });
          }
          const rows = parseListClients(body);
          if (rows === null) {
            return settle({ ok: false, error: 'Response was not a listclients document', errorCode: 'EPARSE', rows: null });
          }
          settle({ ok: true, error: null, errorCode: null, rows });
        });
      },
    );

    req.on('error', (e) => settle({ ok: false, error: e.message, errorCode: e.code || 'EREQ', rows: null }));
    req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'listclients timed out', errorCode: 'ETIMEDOUT', rows: null }); });
    cancelDeadline = () => { req.removeAllListeners('timeout'); };
  });
}

/**
 * Fetch and aggregate in one step, so raw rows never escape this module in
 * normal use. This is the function callers should reach for.
 */
async function collectMount(baseUrl, mountPath, creds) {
  const res = await fetchListClients(baseUrl, mountPath, creds);
  if (!res.ok) {
    return { ok: false, error: res.error, errorCode: res.errorCode, mount: mountPath, responseTime: res.responseTime };
  }
  const host = (() => { try { return new URL(baseUrl).host; } catch { return ''; } })();
  return { ok: true, error: null, errorCode: null, responseTime: res.responseTime, ...aggregate(res.rows, { mount: mountPath, host }) };
}

module.exports = {
  parseListClients,
  deviceId, deviceIdentities,
  classifyAgent,
  classifyChannel,
  aggregate,
  mergeAggregates,
  fetchListClients,
  collectMount,
  DURATION_BUCKETS,
  BOT_SESSION_SECONDS,
  LISTCLIENTS_TIMEOUT_MS,
};
