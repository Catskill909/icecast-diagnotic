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
/** The call sign a mount announces itself under: "KPFA AIR" -> "KPFA". */
function callSignOf(m) {
  const name = String(m?.serverName || '').trim();
  return (name.match(/\b([A-Z]{3,5})\b/) || [])[1] || null;
}

/**
 * Merges groups that are demonstrably the same audio under unrelated names.
 *
 * Path-prefix grouping is right for the common case and blind to the one that
 * matters most on real servers: a mount whose NAME follows no convention.
 * KPFA's main stream is `/padma` — 245 of its 253 listeners — and it shares no
 * prefix with `/kpfa`, so it was left out and the station reported 5 listeners
 * out of 253.
 *
 * TWO signals together, never either alone:
 *
 *   · the SAME non-empty title at this instant — the same programme is playing
 *   · the SAME call sign in server_name — it is the same station's stream
 *
 * Title alone is unsafe and would be actively wrong here: five Pacifica sister
 * stations share one host and carry the same network programmes, so during
 * Democracy Now every station's title matches every other's. The call sign is
 * what separates them. Requiring a non-empty title is what keeps a nameless
 * relay like `/ku_right` — same call sign, no title — out of the group rather
 * than guessed into it.
 */
function mergeByProgramme(groups) {
  const keys = [...groups.keys()];
  const merged = new Set();

  for (let i = 0; i < keys.length; i++) {
    if (merged.has(keys[i])) continue;
    const a = groups.get(keys[i]);
    const aTitle = String(a.find((m) => m.title)?.title || '').trim();
    const aSign = a.map(callSignOf).find(Boolean);
    if (!aTitle || !aSign) continue;

    for (let j = i + 1; j < keys.length; j++) {
      if (merged.has(keys[j])) continue;
      const b = groups.get(keys[j]);
      const bTitle = String(b.find((m) => m.title)?.title || '').trim();
      const bSign = b.map(callSignOf).find(Boolean);
      if (!bTitle || !bSign) continue;

      // AN ORPHAN JOINS A LADDER; TWO LADDERS NEVER MERGE.
      //
      // A group with several mounts is already a well-formed channel — its own
      // bitrate ladder, named to a convention. Two of those are two channels,
      // even when both conditions above hold, and merging them would be wrong
      // in a way nobody would notice.
      //
      // KPFT Main (/live_128, /live_64) and KPFT HD2 (/HD3, /HD3_128, /HD3_64)
      // share the call sign KPFT and are separate services. They carry
      // different programmes today, but a simulcast — a fund drive, an election
      // night — would give them the same title and silently collapse two
      // channels into one, taking HD2's audience with it.
      //
      // What the KPFA case actually is: ONE unconventionally-named mount
      // (/padma) that belongs to an existing ladder. That is the shape to
      // merge, and it is the shape this allows.
      const orphanJoiningLadder = a.length === 1 || b.length === 1;

      if (aTitle === bTitle && aSign === bSign && orphanJoiningLadder) {
        a.push(...b);
        groups.delete(keys[j]);
        merged.add(keys[j]);
      }
    }
  }
  return groups;
}

function suggestChannels(mounts, origin) {
  const groups = new Map();

  for (const m of mounts || []) {
    if (!m || !m.pathname) continue;
    const key = channelKeyFor(m.pathname);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  mergeByProgramme(groups);

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

  // A bare three-to-five letter token IS a US call sign, so present it the way a
  // station writes its own name. Without this, a mount with no `server_name` —
  // KPFA's public /kpfa is a sourceless fallback and has none — proposed the
  // station name as lowercase "kpfa", leaving the operator to capitalise it by
  // hand. Every field they have to correct is ingestion that did not happen.
  const display = callSign || raw || id;
  const name = /^[a-z]{3,5}$/.test(display) ? display.toUpperCase() : display;

  return { name, id };
}

/**
 * The channel id a station id will produce for a discovered channel.
 *
 * Lives here, not in the browser, because the SERVER has to predict the same
 * value in order to check whether it is free. The rule was duplicated in
 * public/admin.js and the copy in the browser was the only one that knew it.
 *
 * The exception — no prefix when the channel already carries the station's name
 * — exists so ids do not read "wpfw-wpfw". It is also what made KPFA
 * unaddable: its mount is /kpfa and its natural station id is `kpfa`, so the
 * prefix was skipped and the id landed on an existing station's channel.
 */
function deriveChannelId(stationId, channelId) {
  const c = String(channelId || 'channel');
  const s = String(stationId || '');
  return (c === s || c.startsWith(s + '-') ? c : `${s}-${c}`).slice(0, 64);
}

/**
 * A station id that is actually usable — free itself, AND producing channel ids
 * that are all free.
 *
 * Discovery used to propose an id from the call sign alone and hand it to the
 * form with no idea whether it was taken. Adding a station already monitored on
 * a DIFFERENT server therefore failed, and the only way through was for the
 * operator to invent a unique id by hand. That is not ingestion: a general
 * manager pasting their stream URL has no reason to know another server already
 * claimed the obvious name.
 *
 * Both halves have to be checked together. A free station id is not enough —
 * the channel ids it derives are what key the history, and those are what
 * collided.
 */
function freeStationId(baseId, channels, config) {
  const takenStations = new Set((config?.stations || []).map((s) => String(s.id).toLowerCase()));
  const takenChannels = existingChannelIds(config);

  const base = String(baseId || 'station').toLowerCase();
  const fits = (candidate) => !takenStations.has(candidate)
    && (channels || []).every((c) => !takenChannels.has(deriveChannelId(candidate, c.id)));

  if (fits(base)) return { id: base, adjusted: false };

  // Numbered rather than host-derived: "kpfa-streams-kpfa-org" is unreadable,
  // and the station NAME is where the human distinction belongs.
  for (let n = 2; n < 50; n++) {
    const candidate = `${base}-${n}`;
    if (fits(candidate)) return { id: candidate, adjusted: true, base };
  }
  return { id: base, adjusted: false, exhausted: true };
}

/**
 * The station this discovery BELONGS TO, when it is one already monitored.
 *
 * A station id derived from the call sign that is already taken is not an
 * obstacle to route around — it is the strongest signal available that this is
 * the same station's stream on a SECOND SERVER. KPFA is exactly that: carried
 * on Pacifica's relay and again on its own Icecast, two status documents, so
 * two separate discovery runs.
 *
 * `freeStationId` resolved that collision silently to `kpfa-2`, and a second
 * "KPFA Berkeley" appeared in the station list with the audience split between
 * the two halves of one station. The guidance for this case already existed —
 * the add form catches "already exists" and points at Edit -> "+ Add a channel"
 * — but pre-resolving the id meant the save SUCCEEDED and that guidance became
 * unreachable. The collision has to be reported, not consumed.
 *
 * Returned as a SUGGESTION, never applied. Two unrelated stations can slug to
 * the same id, so the operator is offered the existing station and can still
 * add a separate one; a false positive costs a click, and refusing outright
 * would make a legitimate second station unaddable.
 */
function existingStationFor(baseId, config) {
  const base = String(baseId || '').toLowerCase();
  if (!base) return null;
  return (config?.stations || []).find((s) => String(s.id).toLowerCase() === base) || null;
}

module.exports = {
  altSchemeUrl,
  isTransportFailure, toStatusUrl, channelKeyFor, suggestChannels, summarise, suggestStationIdentity,
  deriveChannelId, freeStationId, existingStationFor, callSignOf };

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

/* ═══════════════════════════════════════════════════════════════════════════
   Who a station's alerts go to

   Until this existed, recipients were one global ALERT_EMAILS list and the only
   thing keeping one station's 3am outage out of another station's GM's inbox was
   ALERT_STATIONS — a mute. That mute is why WPFW, KPFK and WBAI were monitored
   for weeks, diagnosed correctly, recorded in full, and could reach nobody at
   all. A per-station list is what lets a station be watched AND told.

   THE FIELD IS SEPARATE FROM THE REST OF THE STATION EDIT, deliberately. Editing
   channels is a technical, occasional act; editing who gets paged is a routine
   one a station manager does themselves, and the two must not share a Save
   button with "remove station" sitting beside it.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Deliberately permissive, and the asymmetry is the reason. A pattern strict
   enough to reject every malformed address also rejects real ones — plus
   addressing, long TLDs, hyphenated subdomains — and the two errors do not cost
   the same. A wrongly REJECTED address is a support call from someone whose
   address is fine. A wrongly ACCEPTED one bounces at the first send, visibly,
   against a delivery record built to show exactly that. What this must catch is
   input that is not an address at all: a bare name, a phone number, a sentence. */
const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;

/* A ceiling, not a policy. Nothing about the system breaks at 21 addresses; an
   unbounded list arriving from a form is simply not something to write to disk
   and then hand to an SMTP server on every outage. */
const MAX_ADDRESSES = 25;

/**
 * Accepts an array of addresses, or one string holding several.
 *
 * Both because both will arrive: the panel sends an array, and a person pasting
 * from a mail client sends "a@x.org, b@y.org" — which, silently treated as one
 * address, would be one invalid recipient rather than two valid ones.
 */
function parseAddressList(raw) {
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => String(p ?? '').split(/[,;\n]/))
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Validates and normalises a station's alert block.
 *
 * `enabled` is kept SEPARATE from "has recipients", though an empty list also
 * sends nothing. They mean different things and are read by different people: an
 * empty list is an unfinished setup, while `enabled: false` is a decision — a
 * station being trialled, or one whose staff have not been onboarded. Collapsing
 * them would make "we turned alerts off deliberately" indistinguishable from
 * "somebody deleted the last address by accident".
 */
function validateAlertsPayload(payload, existing) {
  const errors = [];
  const p = payload && typeof payload === 'object' ? payload : {};
  const prev = existing && typeof existing === 'object' ? existing : {};

  const out = {};

  for (const field of ['recipients', 'cc']) {
    // Absent means unchanged, NOT cleared. A panel that saves only the field it
    // edited must not silently empty the one it did not send.
    if (p[field] === undefined) {
      const kept = Array.isArray(prev[field]) ? prev[field] : [];
      if (kept.length) out[field] = [...kept];
      continue;
    }

    const list = parseAddressList(p[field]);
    const seen = new Set();
    const clean = [];

    for (const addr of list) {
      if (!ADDRESS_RE.test(addr)) {
        errors.push(`"${addr}" is not an email address`);
        continue;
      }
      // Deduped case-insensitively because mail domains are, but the address is
      // stored as typed — an operator who wrote it in mixed case should see it
      // back that way rather than being silently corrected.
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(addr);
    }

    if (clean.length > MAX_ADDRESSES) {
      errors.push(`No more than ${MAX_ADDRESSES} ${field === 'cc' ? 'CC ' : ''}addresses`);
      continue;
    }
    if (clean.length) out[field] = clean;
  }

  // An address in both lists would be mailed twice by every alert. The To list
  // wins: it is the one whose recipients the delivery record counts as told.
  if (out.recipients && out.cc) {
    const to = new Set(out.recipients.map((a) => a.toLowerCase()));
    out.cc = out.cc.filter((a) => !to.has(a.toLowerCase()));
    if (!out.cc.length) delete out.cc;
  }

  if (p.enabled === undefined) {
    if (prev.enabled !== undefined) out.enabled = !!prev.enabled;
  } else {
    out.enabled = !!p.enabled;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, alerts: out };
}

/**
 * Writes an alert block onto one station, without mutating the original.
 *
 * An empty block is REMOVED rather than stored as `{}`, so a station that has
 * never been configured and one whose settings were cleared read identically —
 * which is what `alertsEnabledFor()` needs to fall back to the env-var behaviour
 * every existing deployment still runs on.
 */
function setStationAlerts(config, stationId, alerts) {
  const next = JSON.parse(JSON.stringify(config));
  next.stations = (next.stations || []).map((s) => {
    if (s.id !== stationId) return s;
    const updated = { ...s };
    if (alerts && Object.keys(alerts).length) updated.alerts = alerts;
    else delete updated.alerts;
    return updated;
  });
  return next;
}

module.exports.validateAlertsPayload = validateAlertsPayload;
module.exports.setStationAlerts = setStationAlerts;
module.exports.parseAddressList = parseAddressList;


/**
 * Every mount already claimed by a channel, keyed by HOST **and** path.
 *
 * A mount path is not unique across servers, and on this deployment it is not
 * unique in practice: streams.pacifica.org:9000 and streaming.wbai.org both
 * publish a `/wpfw_128`. Keyed by path alone, the Pacifica one reports as
 * belonging to a channel on the other host.
 *
 * `diagnose.snapshotForStream()` exists for exactly this reason on the
 * measurement side — one global snapshot indexed by bare path once made WBAI's
 * mounts read as missing while a same-named mount inherited Pacifica's
 * audience. This is the same rule applied to configuration.
 */
function mountAssignments(config) {
  const assigned = new Map();
  for (const station of config?.stations || []) {
    for (const channel of station.channels || []) {
      let host;
      try { host = new URL(channel.url).host; } catch { continue; }
      for (const mount of channel.mounts || []) {
        assigned.set(`${host}${mount}`, { channelId: channel.id, stationId: station.id });
      }
    }
  }
  return assigned;
}

module.exports.mountAssignments = mountAssignments;
