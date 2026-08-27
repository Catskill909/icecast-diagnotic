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
function suggestChannels(mounts) {
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
      url: primary.listenurl,
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
function summarise(snapshot) {
  const mounts = Object.values(snapshot?.mounts || {});
  const channels = suggestChannels(mounts);
  return {
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

module.exports = { toStatusUrl, channelKeyFor, suggestChannels, summarise };
