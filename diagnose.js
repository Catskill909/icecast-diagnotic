/* ═══════════════════════════════════════════════════════════════════════════
   Pacifica Stream Monitor — Root Cause Diagnosis Engine
   ───────────────────────────────────────────────────────────────────────────
   Turns a bare transport error ("HTTP 404", "socket hang up") into an
   actionable diagnosis by correlating three independent signals:

     1. Connection-layer timings  — DNS / TCP / TLS / TTFB breakdown
     2. Icecast server state      — /status-json.xsl mount inventory
     3. Cross-stream correlation  — is one mount down, or the whole box?

   The single most important distinction it draws: an Icecast mount returning
   404 means the SERVER IS HEALTHY and the SOURCE ENCODER dropped off. That is
   a studio problem, not a server problem, and it has a completely different
   remediation path.
   ═══════════════════════════════════════════════════════════════════════════ */

const https = require('https');
const http = require('http');

const ICECAST_STATUS_URL =
  process.env.ICECAST_STATUS_URL || 'https://streams.pacifica.org:9000/status-json.xsl';
const STATUS_TIMEOUT = parseInt(process.env.ICECAST_STATUS_TIMEOUT_MS, 10) || 10000;
// How many times to ask Icecast before believing it is unreachable, and how long
// to wait between asks. See fetchIcecastSnapshot() for why a single failed fetch
// is not evidence of anything.
const STATUS_ATTEMPTS = Math.max(1, parseInt(process.env.ICECAST_STATUS_ATTEMPTS, 10) || 3);
const STATUS_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.ICECAST_STATUS_RETRY_MS, 10) || 2000);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15000;

// Mount pathnames belonging to the station we monitor. Used to tell a
// station-wide source failure apart from a whole-server failure: if OUR mounts
// vanish while other Pacifica stations keep streaming, the fault is local.
// Name used when describing this station's own mounts in operator-facing
// evidence text. Configurable because the sibling mounts are configurable —
// hardcoding one station's call sign here made every other station's
// diagnosis read as if it belonged to KPFT.
const STATION_LABEL = process.env.STATION_LABEL || 'station';

const SIBLING_MOUNT_PATTERNS = (process.env.SIBLING_MOUNTS ||
  '/live_128,/live_64,/HD3,/HD3_128,/HD3_64,/classic_country')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Node error code → operator-readable cause ───────────────────────────────
const ERROR_CATALOG = {
  ENOTFOUND: {
    cause: 'dns',
    label: 'DNS lookup failed',
    detail: 'The stream hostname could not be resolved. DNS outage, or the record was removed.',
  },
  EAI_AGAIN: {
    cause: 'dns',
    label: 'DNS temporarily unavailable',
    detail: 'The resolver timed out. Usually a transient upstream DNS problem.',
  },
  ECONNREFUSED: {
    cause: 'icecast_down',
    label: 'Connection refused',
    detail: 'The host is reachable but nothing is listening on the stream port. Icecast is stopped or crashed.',
  },
  ECONNRESET: {
    cause: 'connection_reset',
    label: 'Connection reset by server',
    detail: 'The server accepted the connection then dropped it mid-transfer. Typical of an Icecast restart, a hit connection limit, or a proxy recycling.',
  },
  EPIPE: {
    cause: 'connection_reset',
    label: 'Broken pipe',
    detail: 'The connection closed unexpectedly while data was in flight.',
  },
  ETIMEDOUT: {
    cause: 'timeout',
    label: 'Connection timed out',
    detail: 'No response within the timeout window. Network path problem or a severely overloaded server.',
  },
  EHOSTUNREACH: {
    cause: 'network',
    label: 'Host unreachable',
    detail: 'No network route to the streaming server.',
  },
  ENETUNREACH: {
    cause: 'network',
    label: 'Network unreachable',
    detail: 'The monitor host has no route to the network. Check the monitor’s own connectivity first.',
  },
  CERT_HAS_EXPIRED: {
    cause: 'tls',
    label: 'TLS certificate expired',
    detail: 'The HTTPS certificate on the streaming host has expired. Listeners on HTTPS players will be blocked.',
  },
  ERR_TLS_CERT_ALTNAME_INVALID: {
    cause: 'tls',
    label: 'TLS hostname mismatch',
    detail: 'The certificate does not cover this hostname.',
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    cause: 'tls',
    label: 'TLS chain incomplete',
    detail: 'The server is not sending its full certificate chain.',
  },
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    cause: 'tls',
    label: 'Self-signed TLS certificate',
    detail: 'The certificate is not signed by a trusted authority.',
  },
};

// Human labels for every cause the engine can emit.
const CAUSE_LABELS = {
  source_disconnected: 'Source encoder disconnected',
  icecast_down: 'Icecast server down',
  server_restart: 'Icecast server restarted',
  connection_reset: 'Connection reset by server',
  network: 'Network path failure',
  dns: 'DNS resolution failure',
  tls: 'TLS/certificate failure',
  timeout: 'Connection timeout',
  server_error: 'Icecast server error',
  access_denied: 'Access denied',
  bad_content: 'Invalid stream content',
  mount_stalled: 'Mount listed but not serving audio',
  dead_air: 'Dead air — silent audio',
  unknown: 'Unclassified failure',
};

// Remediation steps keyed by cause. These are what actually goes in the email.
const REMEDIATION = {
  source_disconnected: [
    'The Icecast server is healthy — this is a SOURCE-side failure.',
    'Check the Barix encoder / studio streaming appliance is powered and online.',
    'Verify the encoder’s network link and its Icecast source password.',
    'Confirm the studio audio chain is feeding the encoder input.',
    'The mount will reappear automatically the moment the source reconnects.',
  ],
  icecast_down: [
    'The Icecast process itself is not accepting connections.',
    // No address here. Remediation text is stored on every matching event and
    // served to anonymous callers, so an address in it is published — see
    // redact.js. Whoever reads an alert is station staff and knows who to
    // contact; the address itself adds nothing to the advice.
    'Contact the upstream server administrator.',
    'Verify the host stations1.pacifica.org is up and the service is running.',
    'This affects ALL stations on the server, not just this one.',
  ],
  server_restart: [
    'Icecast was restarted — every mount dropped simultaneously.',
    'Sources normally reconnect on their own within a minute or two.',
    'If a mount does not return, restart that source encoder.',
  ],
  connection_reset: [
    'The server dropped an established connection.',
    'Often transient: an Icecast restart, a connection-limit ceiling, or a proxy recycling.',
    'If this repeats, check Icecast’s max-clients setting and server load.',
  ],
  network: [
    'A network path problem between the monitor and the streaming server.',
    'Check whether the stream is reachable from other networks before escalating.',
  ],
  dns: [
    'The stream hostname failed to resolve.',
    'Verify the DNS record still exists and the resolver is healthy.',
  ],
  tls: [
    'An HTTPS/certificate problem on the streaming host.',
    'HTTPS listeners will be blocked until the certificate is fixed.',
    'Contact the server administrator to renew or repair the certificate.',
  ],
  timeout: [
    'No response within the timeout window.',
    'Check server load and the network path.',
  ],
  server_error: [
    'Icecast returned a 5xx error.',
    'Review the Icecast server logs for the underlying fault.',
  ],
  access_denied: [
    'The stream returned an authorization failure.',
    'Check whether the mount was made private or its credentials changed.',
  ],
  bad_content: [
    'The endpoint responded, but not with audio.',
    'A proxy or error page may be intercepting the stream URL.',
  ],
  mount_stalled: [
    'Icecast lists the mount, but the direct connection is failing.',
    'This points at the edge/proxy layer rather than Icecast itself.',
  ],
  dead_air: [
    'The connection is healthy (HTTP 200) but the audio is silent.',
    'Check the studio mixing console master output and audio routing.',
    'Verify the automation system or source player is not paused or stopped.',
    'Check the audio interface feeding the stream encoder.',
  ],
  unknown: ['Could not classify automatically. Review the raw error and timings below.'],
};

// ── Instrumented Stream Probe ───────────────────────────────────────────────
/**
 * Performs a stream check with full connection-layer timing instrumentation.
 * Captures where in the DNS → TCP → TLS → HTTP sequence a failure occurred,
 * which is what separates "network problem" from "server problem".
 */
function probeStream(stream, sampleBytes = 8192) {
  return new Promise((resolve) => {
    const start = Date.now();
    const marks = { start };
    const timings = { dns: null, tcp: null, tls: null, ttfb: null, total: null };

    let urlObj;
    try {
      urlObj = new URL(stream.url);
    } catch (e) {
      return resolve({
        status: 'down',
        responseTime: 0,
        error: `Malformed stream URL: ${stream.url}`,
        errorCode: 'ERR_INVALID_URL',
        timings,
        isSilent: false,
      });
    }

    const client = urlObj.protocol === 'https:' ? https : http;
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;

    const done = (payload) => {
      if (settled) return;
      settled = true;
      timings.total = Date.now() - start;
      resolve({ ...payload, timings });
    };

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Icy-MetaData': '1',
          'User-Agent': 'IcecastMonitor/2.0 (+diagnostics)',
        },
      },
      (res) => {
        timings.ttfb = Date.now() - start;
        const responseTime = timings.ttfb;
        const contentType = res.headers['content-type'] || '';
        const icyName = res.headers['icy-name'] || '';

        // Capture the Icecast-specific response headers — these carry the
        // mount's advertised name/genre/bitrate and confirm we reached Icecast
        // rather than a proxy error page.
        const icyHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (k.startsWith('icy-') || k === 'server' || k === 'content-type') {
            icyHeaders[k] = v;
          }
        }

        if (res.statusCode !== 200) {
          // Read a snippet of the error body — a 404 page from Icecast reads
          // differently from one served by an intervening proxy.
          let body = '';
          res.on('data', (c) => {
            if (body.length < 512) body += c.toString('utf8');
          });
          res.on('end', () => {
            done({
              status: 'down',
              responseTime,
              httpStatus: res.statusCode,
              error: `HTTP ${res.statusCode}, Content-Type: ${contentType}`,
              errorCode: `HTTP_${res.statusCode}`,
              bodySnippet: body.slice(0, 300).replace(/\s+/g, ' ').trim(),
              headers: icyHeaders,
              isSilent: false,
            });
          });
          res.on('error', () =>
            done({
              status: 'down',
              responseTime,
              httpStatus: res.statusCode,
              error: `HTTP ${res.statusCode}`,
              errorCode: `HTTP_${res.statusCode}`,
              headers: icyHeaders,
              isSilent: false,
            }),
          );
          return;
        }

        if (!contentType.includes('audio') && !contentType.includes('ogg') && !icyName) {
          res.destroy();
          return done({
            status: 'down',
            responseTime,
            httpStatus: 200,
            error: `Invalid Content-Type: ${contentType}`,
            errorCode: 'BAD_CONTENT_TYPE',
            headers: icyHeaders,
            isSilent: false,
          });
        }

        res.on('data', (chunk) => {
          chunks.push(chunk);
          receivedBytes += chunk.length;
          if (receivedBytes >= sampleBytes) res.destroy();
        });

        res.on('close', () => {
          const buf = Buffer.concat(chunks);
          const silence = analyzeAudioChunk(buf);
          done({
            status: 'up',
            responseTime,
            httpStatus: 200,
            error: null,
            errorCode: null,
            headers: icyHeaders,
            bytesSampled: receivedBytes,
            isSilent: silence.isSilent,
            audioEnergy: silence.energy,
          });
        });

        res.on('error', () =>
          done({
            status: 'up',
            responseTime,
            httpStatus: 200,
            error: null,
            errorCode: null,
            headers: icyHeaders,
            isSilent: false,
          }),
        );
      },
    );

    // Connection-layer instrumentation. A fresh socket per request (no
    // keep-alive agent) guarantees these fire.
    req.on('socket', (socket) => {
      // 'lookup' fires on failure too, carrying the error as its first
      // argument — without checking it we would report a failed resolution as
      // a successful one.
      socket.on('lookup', (err, address) => {
        marks.dns = Date.now();
        timings.dns = marks.dns - start;
        if (err) {
          timings.dnsFailed = true;
        } else if (address) {
          timings.resolvedIp = address;
        }
      });
      socket.on('connect', () => {
        marks.tcp = Date.now();
        timings.tcp = marks.tcp - (marks.dns || start);
      });
      socket.on('secureConnect', () => {
        marks.tls = Date.now();
        timings.tls = marks.tls - (marks.tcp || marks.dns || start);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      done({
        status: 'down',
        responseTime: Date.now() - start,
        error: 'Connection timed out',
        errorCode: 'ETIMEDOUT',
        isSilent: false,
      });
    });

    req.on('error', (err) => {
      done({
        status: 'down',
        responseTime: Date.now() - start,
        error: err.message,
        errorCode: err.code || (err.message === 'socket hang up' ? 'ECONNRESET' : 'UNKNOWN'),
        isSilent: false,
      });
    });

    req.end();
  });
}

// ── Audio Chunk Silence Analyzer ────────────────────────────────────────────
function analyzeAudioChunk(buffer) {
  if (!buffer || buffer.length < 1024) {
    return { isSilent: false, energy: 100 };
  }
  let sumDiff = 0;
  let nonZeroCount = 0;

  for (let i = 0; i < buffer.length - 1; i++) {
    sumDiff += Math.abs(buffer[i + 1] - buffer[i]);
    if (buffer[i] > 10) nonZeroCount++;
  }

  const avgDiff = sumDiff / buffer.length;
  const nonZeroRatio = nonZeroCount / buffer.length;

  // Digital silence in MP3/AAC manifests as flat/repeating frame headers with
  // near-zero byte-to-byte variation.
  const isSilent = avgDiff < 0.5 && nonZeroRatio < 0.02;
  return { isSilent, energy: Math.round(avgDiff * 100) / 100 };
}

// ── Icecast status document parsing ─────────────────────────────────────────
/**
 * Icecast 2.4.x emits INVALID JSON when a mount has no metadata: it writes a
 * bare `-` where a string belongs — `"title": - ,`. Observed live on
 * stream.pacificaservice.org (Icecast 2.4.4), which serves ~28 Pacifica
 * affiliates, and possible on any mount of any 2.4.x server the moment a source
 * connects without a title.
 *
 * A strict parse throws, and the caller used to report that as `reachable:
 * false` — which is wrong in the way that matters most. A malformed reply is
 * positive proof Icecast is UP and answering. Reporting it as unreachable flips
 * every listener-impact verdict to 'unknown', and an 'unknown' verdict alerts,
 * so one station's empty title tag silently disables the impact gate for every
 * stream on that server.
 *
 * A minus sign not followed by a digit is never valid JSON, so this repair
 * cannot corrupt a well-formed document.
 */
function repairIcecastJson(body) {
  return body.replace(/:\s*-\s*(?=[,}\]])/g, ':""');
}

/**
 * Parses an Icecast status document, repairing the malformation above when
 * present. Returns null only when the document is genuinely unusable —
 * which is the one case that still counts as "no inventory".
 */
function parseIcecastStatus(body) {
  let parsed = null;
  let repaired = false;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = JSON.parse(repairIcecastJson(body));
      repaired = true;
    } catch {
      return null;
    }
  }

  const stats = parsed?.icestats;
  if (!stats) return null;

  const raw = stats.source || [];
  const sourceArray = Array.isArray(raw) ? raw : [raw];
  const mounts = {};

  sourceArray.forEach((src) => {
    if (!src || !src.listenurl) return;
    let pathname;
    try {
      pathname = new URL(src.listenurl).pathname;
    } catch {
      return;
    }
    mounts[pathname] = {
      pathname,
      listenurl: src.listenurl,
      listeners: src.listeners || 0,
      listenerPeak: src.listener_peak || 0,
      // A repaired title is an empty string, not a lie about what is playing.
      title: src.title || src.server_name || '',
      serverName: src.server_name || '',
      serverDescription: src.server_description || '',
      genre: src.genre || '',
      bitrate: src.bitrate || src['ice-bitrate'] || 0,
      sampleRate: src.samplerate || src['ice-samplerate'] || 0,
      channels: src.channels || src['ice-channels'] || 0,
      serverType: src.server_type || '',
      streamStart: src.stream_start_iso8601 || src.stream_start || '',
      isSibling: SIBLING_MOUNT_PATTERNS.includes(pathname),
    };
  });

  return { stats, mounts, mountCount: Object.keys(mounts).length, repaired };
}

// ── Icecast Server Snapshot ─────────────────────────────────────────────────
/**
 * Fetches the full Icecast mount inventory. Unlike a simple stats fetch, this
 * keeps the complete mount list — including other Pacifica stations — so we can
 * answer "is it just us, or is it the whole server?"
 */
function fetchIcecastSnapshotOnce(statusUrl = ICECAST_STATUS_URL) {
  return new Promise((resolve) => {
    const start = Date.now();
    const statusClient = statusUrl.startsWith('http:') ? http : https;
    const req = statusClient.get(statusUrl, { timeout: STATUS_TIMEOUT }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve({
            reachable: false,
            fetchError: `Status endpoint returned HTTP ${res.statusCode}`,
            fetchErrorCode: `HTTP_${res.statusCode}`,
            fetchedAt: new Date().toISOString(),
            responseTime: Date.now() - start,
            mounts: {},
            mountCount: 0,
          });
        }
        const doc = parseIcecastStatus(body);
        if (!doc) {
          return resolve({
            reachable: false,
            fetchError: 'Malformed status JSON could not be parsed or repaired',
            fetchErrorCode: 'EPARSE',
            fetchedAt: new Date().toISOString(),
            responseTime: Date.now() - start,
            mounts: {},
            mountCount: 0,
          });
        }

        const { stats, mounts, mountCount, repaired } = doc;
        resolve({
          reachable: true,
          fetchError: null,
          fetchErrorCode: null,
          // Surfaced rather than silently swallowed: a server emitting broken
          // JSON is a real fault worth reporting to whoever runs it.
          repairedJson: repaired,
          fetchedAt: new Date().toISOString(),
          responseTime: Date.now() - start,
          serverId: stats.server_id || '',
          host: stats.host || '',
          admin: stats.admin || '',
          location: stats.location || '',
          serverStart: stats.server_start_iso8601 || stats.server_start || '',
          mounts,
          mountCount,
        });
      });
    });

    req.on('error', (err) => resolve({
      reachable: false,
      fetchError: err.message,
      fetchErrorCode: err.code || 'UNKNOWN',
      fetchedAt: new Date().toISOString(),
      responseTime: Date.now() - start,
      mounts: {},
      mountCount: 0,
    }));

    req.on('timeout', () => {
      req.destroy();
      resolve({
        reachable: false,
        fetchError: 'Status endpoint timed out',
        fetchErrorCode: 'ETIMEDOUT',
        fetchedAt: new Date().toISOString(),
        responseTime: Date.now() - start,
        mounts: {},
        mountCount: 0,
      });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches the Icecast inventory, retrying transient failures before concluding
 * the server is unreachable.
 *
 * WHY THIS EXISTS. Icecast is the witness the whole alert policy depends on:
 * reachable + mount present means nobody lost audio, and no email is sent. When
 * the status fetch fails we lose that witness, listenerImpact becomes 'unknown',
 * and 'unknown' alerts. So a single dropped connection between this monitor and
 * Pacifica — which costs listeners nothing — used to page people.
 *
 * The production record made the case: of 443 events, 141 (32%) carried an
 * 'unknown' verdict, and of the 170 fetch failures behind them 131 were
 * one-second socket hang-ups and 35 were timeouts. Those are transient network
 * conditions on OUR side, not Icecast outages.
 *
 * A genuine outage survives a retry; a hiccup does not. That is the whole idea.
 * A truly unreachable server still costs only STATUS_ATTEMPTS x timeout, well
 * inside one check cycle, and still ends in 'unknown' — so a real server outage
 * alerts exactly as it always did.
 */
async function fetchIcecastSnapshot(statusUrl = ICECAST_STATUS_URL) {
  let last = null;
  let made = 0;
  for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt++) {
    last = await fetchIcecastSnapshotOnce(statusUrl);
    made = attempt;
    // A reachable server is the answer, however many tries it took.
    if (last.reachable) break;
    // A parseable-but-broken document is not a transport failure; retrying it
    // would return the identical bytes. Fail fast rather than burn the cycle.
    if (last.fetchErrorCode === 'EPARSE') break;
    if (attempt < STATUS_ATTEMPTS) await sleep(STATUS_RETRY_DELAY_MS);
  }
  // `attempts` is what was actually spent, so a retry that rescued the cycle is
  // visible rather than inferred.
  return { ...last, attempts: made };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function mountPathFor(stream) {
  try {
    return new URL(stream.url).pathname;
  } catch {
    return null;
  }
}

/**
 * Every mount path belonging to one channel, primary (the probed URL) first.
 *
 * Icecast publishes each bitrate variant of a channel as its own mount, so
 * "KPFT Main" is /live_128 AND /live_64. Treating the probed mount as the whole
 * channel undercounts the audience — for KPFT that hid roughly half of it.
 */
function channelMountPaths(stream) {
  const primary = mountPathFor(stream);
  const extra = Array.isArray(stream?.mounts) ? stream.mounts : [];
  return [...new Set([primary, ...extra].filter(Boolean))];
}

/**
 * The channel's audience: listeners summed across every variant Icecast is
 * currently serving.
 *
 *   present === 0            → the whole channel is off air
 *   present < total          → some variants are down; the channel still plays
 *
 * `present` is what separates "one encoder dropped" from "the channel is gone",
 * which are the same event today and should not be.
 */
function channelAudience(snapshot, stream) {
  const paths = channelMountPaths(stream);
  let listeners = 0;
  let peak = 0;
  let present = 0;
  const missing = [];
  for (const p of paths) {
    const m = snapshot?.mounts?.[p];
    if (!m) { missing.push(p); continue; }
    present += 1;
    listeners += m.listeners || 0;
    peak += m.listenerPeak || 0;
  }
  // Named, not just counted: "2 of 3 mounts" tells an operator something is
  // wrong, "/live_64 is not listed" tells them which encoder to restart.
  return { listeners, peak, present, total: paths.length, missing };
}

/**
 * A channel that is playing, but not on every mount it publishes.
 *
 * The probe watches ONE mount per channel — the highest bitrate — so a variant
 * dropping on its own is invisible to it: the channel answers, the card reads
 * ONLINE, and the listeners on the dropped variant are off the air with nothing
 * recorded. On this host that is not a hypothetical share of the audience:
 * /live_64 carries 22 of KPFT Main's 59 listeners.
 *
 * Icecast's own inventory is the witness. A mount it no longer lists is not
 * being served to anyone, which needs no probe to establish.
 *
 * `listenersBefore` is read from the PREVIOUS snapshot, because the current one
 * no longer has the mount to report on — a vanished mount reports no listeners
 * precisely because nobody can reach it. It is therefore only knowable in the
 * cycle the variant disappears, which is why the caller freezes it on the
 * episode rather than re-deriving it later.
 */
function channelDegradation(snapshot, prevSnapshot, stream) {
  const audience = channelAudience(snapshot, stream);
  const missing = audience.missing.map((path) => ({
    path,
    listenersBefore: prevSnapshot?.mounts?.[path]?.listeners ?? null,
  }));

  // present === 0 is not degradation, it is the channel being off air, and the
  // outage path already owns that. An unreachable Icecast also lands here: we
  // cannot see any mount, which is not evidence that any of them are gone.
  const degraded = !!snapshot?.reachable && audience.present > 0 && audience.present < audience.total;

  return {
    degraded,
    present: audience.present,
    total: audience.total,
    missing,
    // Summed over the missing variants only. Null counts contribute nothing:
    // an unknown headcount is not a measured zero, and `listenersKnown` says
    // which of the two this is.
    listenersBefore: missing.reduce((sum, m) => sum + (m.listenersBefore || 0), 0),
    listenersKnown: missing.some((m) => m.listenersBefore != null),
  };
}

/** Exact-pathname mount lookup. Substring matching would confuse /HD3 with /HD3_128. */
function findMount(snapshot, stream) {
  const p = mountPathFor(stream);
  if (!p || !snapshot?.mounts) return null;
  return snapshot.mounts[p] || null;
}

function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  // Drop a zero remainder rather than printing "5m 0s", which reads as a
  // stopwatch reading where a plain "5m" reads as a length.
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

// ── The Classifier ──────────────────────────────────────────────────────────
/**
 * Correlates a single stream's probe result against the Icecast snapshot and
 * the results for every other monitored stream in the same cycle.
 *
 * @param {object}   opts.stream        the stream definition
 * @param {object}   opts.result        probeStream() output
 * @param {object}   opts.snapshot      fetchIcecastSnapshot() output
 * @param {object}   opts.prevSnapshot  previous cycle's snapshot (restart detection)
 * @param {Array}    opts.cycle         [{ stream, result }] for all streams this cycle
 * @param {boolean}  opts.deadAir       classify as dead air rather than a transport failure
 */
function classify({ stream, result, snapshot, prevSnapshot, cycle = [], deadAir = false }) {
  const evidence = [];
  const timings = result?.timings || {};
  const errorCode = result?.errorCode || null;
  const httpStatus = result?.httpStatus ?? null;

  const mount = findMount(snapshot, stream);
  const mountPath = mountPathFor(stream);
  const serverReachable = !!snapshot?.reachable;

  // ── Cross-stream correlation ──────────────────────────────────────────────
  const monitored = cycle.filter((c) => c && c.result);
  const downStreams = monitored.filter((c) => c.result.status === 'down');
  const allDown = monitored.length > 0 && downStreams.length === monitored.length;

  // Are OTHER stations on the same box still streaming?
  const foreignMounts = Object.values(snapshot?.mounts || {}).filter((m) => !m.isSibling);
  const siblingMounts = Object.values(snapshot?.mounts || {}).filter((m) => m.isSibling);
  const foreignHealthy = foreignMounts.length > 0;

  // Did Icecast restart since the previous cycle?
  const serverRestarted =
    serverReachable &&
    prevSnapshot?.reachable &&
    prevSnapshot.serverStart &&
    snapshot.serverStart &&
    prevSnapshot.serverStart !== snapshot.serverStart;

  // ── Dead air is a content failure, not a transport failure ────────────────
  if (deadAir) {
    evidence.push('HTTP connection is healthy (200 OK) — the transport layer is fine.');
    evidence.push(`Audio energy measured at ${result?.audioEnergy ?? 0} (silence threshold: 0.5).`);
    if (mount) {
      evidence.push(`Icecast still lists the mount with ${mount.listeners} listener(s) connected.`);
      if (mount.streamStart) {
        evidence.push(`Source has been connected since ${mount.streamStart} — the encoder did not drop, it is sending silence.`);
      }
    }
    return finalize({
      cause: 'dead_air',
      confidence: 'high',
      scope: 'stream',
      evidence,
      mount,
      mountPath,
      snapshot,
      timings,
      errorCode,
      httpStatus,
      result,
      serverRestarted,
    });
  }

  // ── Healthy ───────────────────────────────────────────────────────────────
  if (result?.status === 'up') {
    return finalize({
      cause: null,
      confidence: 'high',
      scope: 'stream',
      evidence: ['Stream responded normally with audio content.'],
      mount,
      mountPath,
      snapshot,
      timings,
      errorCode,
      httpStatus,
      result,
      serverRestarted,
    });
  }

  // ── Failure classification ────────────────────────────────────────────────
  let cause = 'unknown';
  let confidence = 'low';

  const catalogEntry = ERROR_CATALOG[errorCode];

  // Layer-based evidence from the timing breakdown.
  if (timings.dnsFailed) {
    evidence.push(`DNS resolution FAILED after ${timings.dns}ms — the hostname could not be resolved to an address.`);
  } else if (timings.dns == null && errorCode && errorCode.startsWith('E')) {
    evidence.push('Failure occurred before DNS resolution completed.');
  } else if (timings.dns != null && timings.tcp == null) {
    evidence.push(`DNS resolved${timings.resolvedIp ? ` to ${timings.resolvedIp}` : ''} in ${timings.dns}ms, but the TCP connection never established.`);
  } else if (timings.tcp != null && timings.tls == null && stream.url.startsWith('https')) {
    evidence.push(`TCP connected in ${timings.tcp}ms, but the TLS handshake did not complete.`);
  } else if (timings.ttfb != null) {
    evidence.push(`Full connection established; server responded in ${timings.ttfb}ms.`);
  }

  if (httpStatus === 404) {
    // The headline case. A 404 on a mount is definitive: Icecast answered, so
    // the server is alive — the mount simply is not attached.
    evidence.push(`Icecast answered the request and returned HTTP 404 for ${mountPath} — the server process is alive and serving.`);

    if (serverReachable && !mount) {
      cause = 'source_disconnected';
      confidence = 'high';
      evidence.push(`Mount ${mountPath} is ABSENT from the Icecast mount inventory — no source client is connected to it.`);
      evidence.push(`Icecast is currently serving ${snapshot.mountCount} other mount(s), so the server itself is healthy.`);

      const siblingsPresent = siblingMounts.length;
      if (siblingsPresent === 0 && SIBLING_MOUNT_PATTERNS.length > 0) {
        evidence.push(`ALL ${STATION_LABEL} mounts are absent — the station's entire source feed has dropped, not just this one stream.`);
      } else if (siblingsPresent > 0) {
        evidence.push(`${siblingsPresent} other ${STATION_LABEL} mount(s) are still connected — this is an isolated per-mount source failure.`);
      }
      if (foreignHealthy) {
        evidence.push(`${foreignMounts.length} mount(s) from other stations on this server are streaming normally — the fault is on the ${STATION_LABEL} side, not the server.`);
      }
    } else if (serverReachable && mount) {
      // Listed but 404 on direct fetch — the edge/proxy layer disagrees with
      // Icecast's own view.
      cause = 'mount_stalled';
      confidence = 'medium';
      evidence.push(`Icecast LISTS mount ${mountPath} (source connected since ${mount.streamStart || 'unknown'}), yet a direct request 404s.`);
      evidence.push('The edge/proxy layer in front of Icecast is likely out of sync or misrouting.');
    } else {
      cause = 'source_disconnected';
      confidence = 'medium';
      evidence.push('Could not reach the Icecast status endpoint to confirm mount state.');
    }
  } else if (httpStatus === 403 || httpStatus === 401) {
    cause = 'access_denied';
    confidence = 'high';
    evidence.push(`Server returned HTTP ${httpStatus} — the mount is refusing this client.`);
  } else if (httpStatus >= 500) {
    cause = 'server_error';
    confidence = 'high';
    evidence.push(`Server returned HTTP ${httpStatus} — an internal Icecast or proxy fault.`);
  } else if (errorCode === 'BAD_CONTENT_TYPE') {
    cause = 'bad_content';
    confidence = 'high';
    evidence.push('The endpoint responded with non-audio content — likely an intercepting proxy or error page.');
  } else if (catalogEntry) {
    cause = catalogEntry.cause;
    confidence = 'high';
    evidence.push(catalogEntry.detail);

    // Refine reset/timeout failures using correlation — this is what separates
    // a one-off blip from a genuine server-level event.
    if (cause === 'connection_reset' || cause === 'timeout' || cause === 'network') {
      if (serverRestarted) {
        cause = 'server_restart';
        confidence = 'high';
        evidence.push(`Icecast start time changed (${prevSnapshot.serverStart} → ${snapshot.serverStart}) — the server was restarted.`);
      } else if (allDown && monitored.length > 1) {
        confidence = 'high';
        evidence.push(`ALL ${monitored.length} monitored streams failed in the same check cycle — this is a server-level or network-level event, not a per-stream fault.`);
      } else if (serverReachable) {
        evidence.push('The Icecast status endpoint is still reachable, so the server is up — this looks like a transient connection drop.');
        if (mount) {
          evidence.push(`Mount ${mountPath} is still listed and serving ${mount.listeners} listener(s) — the stream itself never actually stopped.`);
          confidence = 'high';
        }
      } else {
        evidence.push('The Icecast status endpoint is ALSO unreachable — the server or the network path to it is down.');
        if (cause !== 'timeout') cause = 'icecast_down';
        confidence = 'high';
      }
    }

    if (cause === 'icecast_down' && errorCode === 'ECONNREFUSED') {
      evidence.push('Nothing is listening on the stream port — the Icecast process is stopped, not merely unhealthy.');
    }
  }

  // ── Scope determination ───────────────────────────────────────────────────
  let scope = 'stream';
  if (cause === 'icecast_down' || cause === 'server_restart') {
    scope = 'server';
  } else if (allDown && monitored.length > 1) {
    scope = foreignHealthy && serverReachable ? 'station' : 'server';
  } else if (cause === 'source_disconnected' && siblingMounts.length === 0 && serverReachable) {
    scope = 'station';
  }

  if (downStreams.length > 1 && downStreams.length < monitored.length) {
    evidence.push(`${downStreams.length} of ${monitored.length} monitored streams are failing simultaneously.`);
  }

  return finalize({
    cause,
    confidence,
    scope,
    evidence,
    mount,
    mountPath,
    snapshot,
    timings,
    errorCode,
    httpStatus,
    result,
    serverRestarted,
  });
}

/**
 * Did this failure actually cost us listeners?
 *
 * The monitor sits outside the network, so a failed probe proves only that OUR
 * connection broke — not that the audience lost audio. Icecast itself is the
 * witness: if the server is reachable and still lists the mount, the mount was
 * serving listeners the whole time and only our probe fell over. If the server
 * is reachable and the mount is GONE, the mount could not have served anyone —
 * every connected player was dropped. If we cannot reach Icecast at all we have
 * no witness and must not guess in either direction.
 *
 *   'confirmed' → listeners were dropped (or are hearing silence)
 *   'none'      → Icecast and the mount stayed healthy; probe-side failure only
 *   'unknown'   → no Icecast evidence available
 */
function assessListenerImpact({ cause, mount, snapshot }) {
  if (cause === 'dead_air') return 'confirmed';
  if (!cause) return 'none';
  if (!snapshot?.reachable) return 'unknown';
  return mount ? 'none' : 'confirmed';
}

function finalize({
  cause, confidence, scope, evidence, mount, mountPath,
  snapshot, timings, errorCode, httpStatus, result, serverRestarted,
}) {
  const listenerImpact = assessListenerImpact({ cause, mount, snapshot });
  return {
    cause,
    causeLabel: cause ? CAUSE_LABELS[cause] || CAUSE_LABELS.unknown : 'Healthy',
    listenerImpact,
    confidence,
    scope,
    evidence,
    remediation: cause ? REMEDIATION[cause] || REMEDIATION.unknown : [],
    httpStatus,
    errorCode,
    errorMessage: result?.error || null,
    bodySnippet: result?.bodySnippet || null,
    timings,
    icecast: {
      reachable: !!snapshot?.reachable,
      statusError: snapshot?.fetchError || null,
      serverId: snapshot?.serverId || null,
      host: snapshot?.host || null,
      admin: snapshot?.admin || null,
      serverStart: snapshot?.serverStart || null,
      serverRestarted: !!serverRestarted,
      mountPath,
      // null, not false, when Icecast is unreachable: we did not observe the
      // mount missing, we failed to look. Recording `false` here made every
      // network hiccup read as "the mount vanished" and overstated the fault.
      mountPresent: snapshot?.reachable ? !!mount : null,
      mountCount: snapshot?.mountCount || 0,
      sourceConnectedSince: mount?.streamStart || null,
      listeners: mount?.listeners ?? null,
      listenerPeak: mount?.listenerPeak ?? null,
    },
  };
}

/**
 * Computes the true source-side outage window from the mount's stream_start.
 * When a Barix drops and reconnects, Icecast stamps the reconnect moment —
 * giving an exact duration independent of our polling interval.
 */
function deriveSourceOutage(snapshot, stream, incidentStartIso) {
  const mount = findMount(snapshot, stream);
  if (!mount?.streamStart || !incidentStartIso) return null;
  const reconnected = new Date(mount.streamStart).getTime();
  const started = new Date(incidentStartIso).getTime();
  if (!isFinite(reconnected) || !isFinite(started) || reconnected <= started) return null;
  return {
    reconnectedAt: new Date(reconnected).toISOString(),
    sourceDownMs: reconnected - started,
    sourceDownLabel: fmtDuration(reconnected - started),
  };
}

module.exports = {
  probeStream,
  analyzeAudioChunk,
  fetchIcecastSnapshot,
  channelMountPaths,
  channelAudience,
  channelDegradation,
  parseIcecastStatus,
  repairIcecastJson,
  classify,
  deriveSourceOutage,
  findMount,
  mountPathFor,
  fmtDuration,
  CAUSE_LABELS,
  REMEDIATION,
};
