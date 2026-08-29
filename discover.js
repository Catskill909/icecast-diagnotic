/* ═══════════════════════════════════════════════════════════════════════════
   Station discovery

   Turns one pasted URL into a proposed station: every mount the server is
   serving, grouped into the channels a listener would recognise, with live
   listener counts attached.

   This is the difference between a 30-second setup and a support conversation.
   A station operator knows their stream URL; they do not necessarily know which
   of six mounts are bitrate variants of the same programme, and asking them is
   how a form grows to fourteen fields.

   Nothing here fetches anything itself — the caller supplies the snapshot — so
   the grouping is testable against real inventories without a network.
   ═══════════════════════════════════════════════════════════════════════════ */

const { validateUrl } = require('./safe-url');

/**
 * Derives an Icecast status URL from whatever was pasted.
 *
 * Accepts the status document itself, or any stream URL on the same server —
 * because "paste your stream URL" is the instruction an operator can follow
 * without being told what a status endpoint is.
 */
function toStatusUrl(raw) {
  const v = validateUrl(raw);
  if (!v.ok) return v;
  const url = v.url;
  if (/status-json\.xsl$/i.test(url.pathname)) return { ok: true, url };
  const derived = new URL(url.origin);
  derived.pathname = '/status-json.xsl';
  return { ok: true, url: derived, derivedFrom: url.href };
}

/**
 * The same status URL over the other scheme, or null if it cannot be formed.
 *
 * A scheme is the one part of a pasted URL that is a GUESS rather than a fact.
 * People copy https from the browser bar and append the stream port, but an
 * Icecast on :8000 is very often plaintext — https://stream.wbai.org:8000 is
 * exactly that, while the same server answers instantly over http.
 *
 * The port is deliberately carried across unchanged when it was explicit: the
 * operator told us which port Icecast is on, and only the scheme is in doubt.
 */
function altSchemeUrl(url) {
  try {
    const alt = new URL(url.href);
    alt.protocol = url.protocol === 'https:' ? 'http:' : 'https:';
    // Setting protocol does not move an implicit default port, so a URL with no
    // explicit port correctly picks up the new scheme's default.
    return alt.href === url.href ? null : alt;
  } catch {
    return null;
  }
}

/**
 * Whether a failed fetch is worth retrying on the other scheme.
 *
 * Only TRANSPORT failures qualify. An HTTP status or an unparseable body both
 * mean we reached a server and it answered — the scheme was right and something
 * else is wrong, so retrying the other one would only add delay and then report
 * a more confusing error than the true one.
 */
function isTransportFailure(code) {
  if (!code) return false;
  if (String(code).startsWith('HTTP_')) return false;
  return code !== 'EPARSE';
}

// Bitrate suffixes Icecast operators conventionally append to a mount name.
const BITRATE_SUFFIX = /_(?:16|24|32|48|64|96|128|160|192|256|320)$/i;

/** The channel a mount belongs to, by stripping a trailing bitrate suffix. */
function channelKeyFor(pathname) {
  return String(pathname || '').replace(BITRATE_SUFFIX, '') || pathname;
}

/**
 * Groups mounts into proposed channels.
 *
 * The signal is the mount path, not the metadata title. Titles look like they
 * should work and do not: on the Pacifica server /live_128 announces itself as
 * "KPFT HiRes Stream" and /live_64 as "KPFT Houston Stereo Stream" — the same
 * programme under two names — while every /HD3* mount shares one title. Paths
 * follow the operator's own naming convention and are stable; titles change
 * whenever the source encoder feels like it.
 *
 * The result is a SUGGESTION. An operator confirms or regroups it; the point is
 * that the common case needs no thought.
 */
function suggestChannels(mounts, origin) {
  const groups = new Map();

  for (const m of mounts || []) {
    if (!m || !m.pathname) continue;
    const key = channelKeyFor(m.pathname);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const channels = [];
  for (const [key, list] of groups) {
    // Highest bitrate first: that mount becomes the probed one, so a probe
    // failure reflects the variant most listeners are on.
    const sorted = [...list].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const primary = sorted[0];
    channels.push({
      id: key.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'channel',
      // A name from the metadata when there is one, since it is what a human
      // recognises; the path is the fallback and is always present.
      name: primary.serverName || primary.title || key.replace(/^\//, ''),
      // Built from the origin the operator actually reached, NOT from Icecast's
      // self-reported listenurl.
      //
      // On the Pacifica server those differ: an operator reaches
      // https://streams.pacifica.org:9000 while Icecast announces itself as
      // http://stations1.pacifica.org:7267 — its own address behind the proxy,
      // over plain HTTP. Taking the announcement would silently downgrade the
      // connection and monitor a path no listener uses; behind a CDN it is
      // frequently an internal address that is not reachable at all.
      //
      // The operator reached the origin we were given. That is the one to probe.
      url: origin ? origin.replace(/\/+$/, '') + primary.pathname : primary.listenurl,
      mounts: sorted.map((m) => m.pathname),
      // Everything below is for the operator to look at while confirming.
      listeners: sorted.reduce((sum, m) => sum + (m.listeners || 0), 0),
      bitrates: sorted.map((m) => m.bitrate || null),
      variants: sorted.length,
    });
  }

  // Busiest first: the channel an operator is looking for is usually the one
  // with an audience.
  return channels.sort((a, b) => b.listeners - a.listeners);
}

/**
 * A complete discovery result from a snapshot.
 *
 * `stationHint` matters at Pacifica scale: two hosts carry 33 stations between
 * them, so a discovered inventory is usually many stations' mounts and the
 * operator needs to pick out their own rather than adopt all of them.
 */
function summarise(snapshot, pastedPath, origin) {
  const mounts = Object.values(snapshot?.mounts || {});
  const channels = suggestChannels(mounts, origin);

  // Which channel did they actually paste? On a shared host most of what was
  // found belongs to other stations, and making someone hunt for their own
  // among eight is the opposite of the point of discovery.
  let matched = null;
  if (pastedPath) {
    matched = channels.find((c) => (c.mounts || []).includes(pastedPath)) || null;
    if (matched) {
      matched.matched = true;
      // Put it first: it is the answer to the question they asked.
      channels.splice(channels.indexOf(matched), 1);
      channels.unshift(matched);
    }
  }

  // Channels that look like they belong to the SAME station as the one pasted.
  //
  // Most stations have one stream — twenty-two of the twenty-eight affiliates on
  // the shared Pacifica host — so the pasted channel is usually the whole story.
  // KPFT's three are the exception, and burying its HD2 among four other
  // stations' streams would make the exception needlessly hard.
  //
  // The signal is the call sign at the start of the metadata name, which is
  // conservative on purpose: it surfaces a likely sibling without claiming one.
  // KPFT's /classic_country announces "Unspecified name" and so is not matched —
  // a false negative costs one click, a false positive attaches another
  // station's stream to yours.
  const callSign = matched ? (String(matched.name || '').match(/^[A-Z]{3,5}\b/) || [])[0] : null;
  if (callSign) {
    for (const c of channels) {
      if (c === matched) continue;
      const sign = (String(c.name || '').match(/^[A-Z]{3,5}\b/) || [])[0];
      if (sign && sign === callSign) c.sameStation = true;
    }
  }

  return {
    matchedChannelId: matched ? matched.id : null,
    callSign: callSign || null,
    reachable: !!snapshot?.reachable,
    serverId: snapshot?.serverId || null,
    host: snapshot?.host || null,
    mountCount: mounts.length,
    channelCount: channels.length,
    totalListeners: channels.reduce((s, c) => s + c.listeners, 0),
    sharedHost: channels.length > 3,
    channels,
  };
}

/**
 * A station name and identifier suggested from a channel.
 *
 * Icecast metadata names are written for listeners, not for configuration:
 * "WPFW Eckington 1" and "KPFA HiRes Stream" both carry the call sign plus
 * noise. The call sign is the part worth keeping.
 */
function suggestStationIdentity(channel) {
  if (!channel) return { name: '', id: '' };
  // Strip the descriptive tail operators append: "WPFW Eckington 1" → "WPFW".
  const raw = String(channel.name || '').trim();
  const callSign = (raw.match(/^[A-Z]{3,5}\b/) || [])[0];

  // The call sign is the station. The mount path is only a fallback, and a poor
  // one for a station id — "/HD3_128" is one KPFT channel, not the station.
  const fromPath = String((channel.mounts || [])[0] || '')
    .replace(/^\//, '').replace(/_\d+$/, '');
  const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
  const id = callSign ? slug(callSign) : (slug(fromPath) || 'station');

  return { name: callSign || raw || id.toUpperCase(), id };
}

module.exports = {
  altSchemeUrl,
  isTransportFailure, toStatusUrl, channelKeyFor, suggestChannels, summarise, suggestStationIdentity };

/* ═══════════════════════════════════════════════════════════════════════════
   Validating a station before it is written

   Two things here are not cosmetic.

   CHANNEL IDS ARE LOAD-BEARING. Every sample, rollup and event is keyed by them.
   Reusing an id attaches a new channel to another channel's history — the data
   does not disappear, it silently becomes wrong, and uptime is computed from it.
   So ids must be unique across every station, not merely within the one being
   added.

   URLS BECOME THINGS THIS SERVER FETCHES. A saved channel is probed every 60
   seconds forever. Validating only the URL that was discovered would leave the
   obvious hole: submit a discovered inventory, then swap in a loopback address
   before saving.
   ═══════════════════════════════════════════════════════════════════════════ */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Existing channel ids across the whole configuration. */
function existingChannelIds(config) {
  const ids = new Set();
  for (const s of config?.stations || []) for (const c of s.channels || []) ids.add(c.id);
  return ids;
}

/**
 * Checks a proposed station. Returns { ok: true, station, host } or
 * { ok: false, errors: [...] } — every problem at once, because fixing a form
 * one error per submission is miserable.
 */
function validateStationPayload(payload, config) {
  const errors = [];
  const p = payload && typeof payload === 'object' ? payload : {};
  const stationIn = p.station && typeof p.station === 'object' ? p.station : {};
  const channelsIn = Array.isArray(p.channels) ? p.channels : [];

  const id = String(stationIn.id || '').trim().toLowerCase();
  if (!id) errors.push('Station id is required');
  else if (!SLUG.test(id)) errors.push('Station id must be lowercase letters, numbers and hyphens');
  else if ((config?.stations || []).some((s) => s.id === id)) errors.push(`A station with id "${id}" already exists`);

  const name = String(stationIn.name || '').trim();
  if (!name) errors.push('Station name is required');

  const timezone = String(stationIn.timezone || 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    errors.push(`"${timezone}" is not a recognised timezone`);
  }

  if (!channelsIn.length) errors.push('At least one channel is required');

  const taken = existingChannelIds(config);
  const seen = new Set();
  const channels = [];

  channelsIn.forEach((c, i) => {
    const label = `Channel ${i + 1}`;
    const cid = String(c?.id || '').trim().toLowerCase();
    if (!cid) errors.push(`${label}: id is required`);
    else if (!SLUG.test(cid)) errors.push(`${label}: id must be lowercase letters, numbers and hyphens`);
    else if (taken.has(cid)) errors.push(`${label}: id "${cid}" is already used by another station — it would inherit that channel's history`);
    else if (seen.has(cid)) errors.push(`${label}: id "${cid}" is repeated`);
    seen.add(cid);

    const cname = String(c?.name || '').trim();
    if (!cname) errors.push(`${label}: name is required`);

    const v = validateUrl(c?.url);
    if (!v.ok) errors.push(`${label}: ${v.reason}`);

    const mounts = Array.isArray(c?.mounts)
      ? c.mounts.map((m) => String(m || '').trim()).filter(Boolean)
      : [];
    if (mounts.some((m) => !m.startsWith('/'))) errors.push(`${label}: mounts must be Icecast paths beginning with /`);

    if (v.ok && cid && cname) {
      channels.push({ id: cid, name: cname, url: v.url.href, mounts: mounts.length ? [...new Set(mounts)] : undefined });
    }
  });

  if (errors.length) return { ok: false, errors };

  // The host every channel lives on, derived rather than asked for.
  const origins = [...new Set(channels.map((c) => new URL(c.url).host))];
  return {
    ok: true,
    station: { id, name, timezone, channels },
    hosts: origins.map((host) => ({
      id: host.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      host,
      statusUrl: `${new URL(channels.find((c) => new URL(c.url).host === host).url).protocol}//${host}/status-json.xsl`,
    })),
  };
}

/** Merges a validated station into the configuration, without mutating it. */
function addStationToConfig(config, station, hosts) {
  const next = JSON.parse(JSON.stringify(config || { version: 1, hosts: [], stations: [] }));
  next.hosts = next.hosts || [];
  next.stations = next.stations || [];
  for (const h of hosts || []) {
    if (!next.hosts.some((existing) => existing.host === h.host)) next.hosts.push(h);
  }
  next.stations.push(station);
  return next;
}

module.exports.validateStationPayload = validateStationPayload;
module.exports.addStationToConfig = addStationToConfig;
module.exports.existingChannelIds = existingChannelIds;

/* ═══════════════════════════════════════════════════════════════════════════
   Editing and removing a station

   THE HAZARD IN EDITING is that channel ids key every stored sample, rollup and
   event. Renaming one does not move its history — it orphans it, and the channel
   silently starts again from zero while the old record sits under a name nothing
   references. So ids are immutable: a station's channels can be added to,
   removed, renamed in their DISPLAY name, repointed at a different URL, and have
   their mount lists changed, but an existing channel's id is fixed.

   THE HAZARD IN REMOVING is assuming configuration is a statement about the
   past. It is not. Removing a station stops it being watched; the record of what
   happened while it WAS watched stays exactly where it is. Deleting that would
   destroy the thing this application exists to keep, and would do it on a click.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Checks an edit to an existing station.
 *
 * Every problem is returned at once, and ids that already belong to this station
 * are permitted — they are what makes it an edit rather than a new station.
 */
function validateStationEdit(payload, config, stationId) {
  const errors = [];
  const station = (config?.stations || []).find((s) => s.id === stationId);
  if (!station) return { ok: false, errors: [`No station with id "${stationId}"`] };

  const p = payload && typeof payload === 'object' ? payload : {};
  const name = String(p.name ?? station.name ?? '').trim();
  if (!name) errors.push('Station name is required');

  const timezone = String(p.timezone ?? station.timezone ?? 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    errors.push(`"${timezone}" is not a recognised timezone`);
  }

  const channelsIn = Array.isArray(p.channels) ? p.channels : station.channels || [];
  if (!channelsIn.length) errors.push('A station must keep at least one channel');

  // Ids belonging to OTHER stations are taken; this station's own are not.
  const mine = new Set((station.channels || []).map((c) => c.id));
  const taken = new Set();
  for (const s of config.stations || []) {
    if (s.id === stationId) continue;
    for (const c of s.channels || []) taken.add(c.id);
  }

  const seen = new Set();
  const channels = [];

  channelsIn.forEach((c, i) => {
    const label = `Channel ${i + 1}`;
    const cid = String(c?.id || '').trim().toLowerCase();
    if (!cid) errors.push(`${label}: id is required`);
    else if (!SLUG.test(cid)) errors.push(`${label}: id must be lowercase letters, numbers and hyphens`);
    else if (taken.has(cid)) errors.push(`${label}: id "${cid}" belongs to another station`);
    else if (seen.has(cid)) errors.push(`${label}: id "${cid}" is repeated`);
    seen.add(cid);

    const cname = String(c?.name || '').trim();
    if (!cname) errors.push(`${label}: name is required`);

    const v = validateUrl(c?.url);
    if (!v.ok) errors.push(`${label}: ${v.reason}`);

    const mounts = Array.isArray(c?.mounts)
      ? c.mounts.map((m) => String(m || '').trim()).filter(Boolean)
      : [];
    if (mounts.some((m) => !m.startsWith('/'))) errors.push(`${label}: mounts must be Icecast paths beginning with /`);

    if (v.ok && cid && cname) {
      channels.push({ id: cid, name: cname, url: v.url.href, mounts: mounts.length ? [...new Set(mounts)] : undefined });
    }
  });

  if (errors.length) return { ok: false, errors };

  // What is being dropped, so the caller can say so before doing it.
  const kept = new Set(channels.map((c) => c.id));
  const removed = [...mine].filter((id) => !kept.has(id));

  const origins = [...new Set(channels.map((c) => new URL(c.url).host))];
  return {
    ok: true,
    station: { ...station, id: stationId, name, timezone, channels },
    removedChannels: removed,
    hosts: origins.map((host) => ({
      id: host.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      host,
      statusUrl: `${new URL(channels.find((c) => new URL(c.url).host === host).url).protocol}//${host}/status-json.xsl`,
    })),
  };
}

/** Replaces one station in the configuration, without mutating the original. */
function replaceStationInConfig(config, station, hosts) {
  const next = JSON.parse(JSON.stringify(config));
  next.stations = (next.stations || []).map((s) => (s.id === station.id ? station : s));
  next.hosts = next.hosts || [];
  for (const h of hosts || []) {
    if (!next.hosts.some((existing) => existing.host === h.host)) next.hosts.push(h);
  }
  return next;
}

/**
 * Removes a station. Its stored history is deliberately untouched.
 *
 * Hosts left serving no channel are dropped too, so the check cycle stops
 * fetching a status document nothing reads.
 */
function removeStationFromConfig(config, stationId) {
  const next = JSON.parse(JSON.stringify(config));
  next.stations = (next.stations || []).filter((s) => s.id !== stationId);

  const stillUsed = new Set();
  for (const s of next.stations) {
    for (const c of s.channels || []) {
      try { stillUsed.add(new URL(c.url).host); } catch { /* keep the host */ }
    }
  }
  next.hosts = (next.hosts || []).filter((h) => stillUsed.has(h.host));
  return next;
}

module.exports.validateStationEdit = validateStationEdit;
module.exports.replaceStationInConfig = replaceStationInConfig;
module.exports.removeStationFromConfig = removeStationFromConfig;
