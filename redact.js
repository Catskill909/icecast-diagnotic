/* ═══════════════════════════════════════════════════════════════════════════
   Public projections

   Some stored data is deliberately richer than what an anonymous visitor should
   see. Alert delivery records keep the exact recipient list so it is possible to
   answer "who was told, and did it arrive" — a genuinely useful audit trail —
   and station configuration will soon hold per-station recipients and status
   URLs that can carry credentials.

   Neither is a mistake on its own. Serving them verbatim to an unauthenticated
   caller is. On 2026-08-27 /api/events was publishing real staff addresses to
   anyone who found the URL.

   THE RULE HERE IS ALLOWLIST, NOT BLOCKLIST. A blocklist protects the fields
   someone remembered; the next field added leaks silently, and nothing fails.
   These projections name what may be published, so anything new is withheld
   until a person decides otherwise. Getting a field wrongly withheld is a bug
   report; getting one wrongly published cannot be undone.
   ═══════════════════════════════════════════════════════════════════════════ */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Removes address-shaped strings from human-readable text.
 *
 * Structured redaction is not enough on its own. Advice and evidence strings are
 * free text, and on 2026-08-27 one of them had an administrator's address baked
 * into it — published on every matching event, past redaction that was only
 * looking at fields named "recipients".
 *
 * Fixing the string at its source stops new events carrying it; this covers the
 * hundreds already stored, which cannot be rewritten.
 */
function scrubText(value) {
  if (typeof value === 'string') return value.replace(EMAIL_RE, '[address withheld]');
  if (Array.isArray(value)) return value.map(scrubText);
  return value;
}

/**
 * An event as an anonymous caller may see it.
 *
 * Everything the dashboard and history page render is kept — cause, severity,
 * timings, diagnosis, audience impact. Only the identities of the people
 * notified are removed, replaced by counts so "3 people were told" still reads
 * correctly without naming them.
 */
function publicEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const { email, diagnosis, ...rest } = event;

  const out = { ...rest };

  // The diagnosis carries a copy of the Icecast server's own published contact
  // address. Arguably public — anyone can read it from the status endpoint — but
  // "it is public somewhere else" is exactly the reasoning that leaves addresses
  // sitting in responses, so it is withheld here too. Nothing in the UI reads it.
  if (diagnosis && typeof diagnosis === 'object') {
    const { icecast, remediation, evidence, ...restDiag } = diagnosis;
    // Free text is scrubbed rather than dropped, because the advice itself is
    // what the history page shows and is worth keeping. Absent fields stay
    // absent — adding `undefined` keys would change the shape of every event.
    out.diagnosis = { ...restDiag };
    if (remediation !== undefined) out.diagnosis.remediation = scrubText(remediation);
    if (evidence !== undefined) out.diagnosis.evidence = scrubText(evidence);
    if (icecast !== undefined) {
      out.diagnosis.icecast = icecast && typeof icecast === 'object' ? publicIcecast(icecast) : icecast;
    }
  } else if (diagnosis !== undefined) {
    out.diagnosis = diagnosis;
  }

  if (typeof out.message === 'string') out.message = scrubText(out.message);

  if (!email || typeof email !== 'object') {
    if (email !== undefined) out.email = email;
    return out;
  }

  const {
    // Withheld: these are people.
    recipients, cc, to, bcc, replyTo, from,
    // Withheld: a Message-ID embeds the sending domain and reads as an address.
    // Nothing renders it, and an absolute "no address-shaped string" invariant
    // is enforceable in a way that "no address except these" is not.
    messageId,
    ...safeEmail
  } = email;

  out.email = {
    ...safeEmail,
    // Preserved as counts: the delivery record stays legible without naming
    // anyone, so the history page can still say an alert reached N people.
    recipientCount: Array.isArray(recipients) ? recipients.length : undefined,
    ccCount: Array.isArray(cc) ? cc.length : undefined,
  };
  return out;
}

function publicEvents(events) {
  return Array.isArray(events) ? events.map(publicEvent) : events;
}

/**
 * Station configuration as an anonymous caller may see it.
 *
 * Built by naming permitted fields rather than removing forbidden ones. When
 * per-station alert recipients, SMTP overrides or thresholds land in this
 * structure, they are withheld automatically — nobody has to remember to come
 * back here.
 *
 * `statusUrl` is withheld deliberately even though it is usually harmless: an
 * Icecast admin endpoint may be configured with credentials embedded in the
 * URL (https://user:pass@host/admin/stats.xml), and that must never be served.
 */
function publicStationConfig(config) {
  if (!config || typeof config !== 'object') return config;
  return {
    version: config.version,
    hosts: (config.hosts || []).map((h) => ({
      id: h.id,
      host: h.host,
    })),
    stations: (config.stations || []).map((s) => ({
      id: s.id,
      name: s.name,
      timezone: s.timezone,
      channels: (s.channels || []).map((c) => ({
        id: c.id,
        name: c.name,
        url: c.url,
        mounts: c.mounts,
        m3u: c.m3u,
      })),
    })),
  };
}

/**
 * Live Icecast diagnostics as an anonymous caller may see it.
 *
 * `admin` is the contact address the Icecast server publishes about itself. It
 * is arguably public already — but "it is public somewhere else" is the reasoning
 * that leaves addresses sitting in responses, so it is withheld here too.
 */
function publicIcecast(icecast) {
  if (!icecast || typeof icecast !== 'object') return icecast;
  const { admin, ...rest } = icecast;
  return rest;
}

module.exports = { publicEvent, publicEvents, publicStationConfig, publicIcecast, scrubText };
