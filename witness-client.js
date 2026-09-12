/* ═══════════════════════════════════════════════════════════════════════════
   Asking a second location — the monitor's side of witness/witness.js

   Called only when the monitor's OWN connection to a stream failed at the
   transport level (no HTTP answer at all). A 404 is Icecast answering, which
   needs no second opinion; a timeout or reset is exactly the reading that
   cannot tell "station off air" from "our route is broken".

   Configuration:
     WITNESS_URLS   comma list of witness base URLs, e.g. https://w1.example.org
     WITNESS_TOKEN  the shared secret each witness was started with

   With neither set, nothing here runs and the monitor behaves exactly as before.
   ═══════════════════════════════════════════════════════════════════════════ */

const WITNESS_TIMEOUT_MS = 30 * 1000;

function witnessConfig(env = process.env) {
  return {
    urls: String(env.WITNESS_URLS || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean),
    token: String(env.WITNESS_TOKEN || ''),
  };
}

function witnessesConfigured(env = process.env) {
  const cfg = witnessConfig(env);
  return cfg.urls.length > 0 && !!cfg.token;
}

/** A transport failure: the monitor got no HTTP answer at all. */
function needsWitness(result) {
  return result?.status === 'down' && result.httpStatus == null;
}

/**
 * Asks every configured witness about one stream (and, optionally, its server's
 * status page). Never throws: a witness that is itself unreachable comes back as
 * `{ available: false }`, which is evidence of nothing and is recorded as such.
 */
async function askWitnesses({ streamUrl, statusUrl }, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = witnessConfig(env);
  if (!cfg.urls.length || !cfg.token) return [];
  return Promise.all(cfg.urls.map(async (base) => {
    const q = new URLSearchParams();
    if (statusUrl) q.set('status', statusUrl);
    if (streamUrl) q.set('stream', streamUrl);
    try {
      const res = await fetchImpl(`${base}/check?${q}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(WITNESS_TIMEOUT_MS),
      });
      if (!res.ok) return { base, available: false, error: `witness returned HTTP ${res.status}` };
      const body = await res.json();
      return { base, available: true, name: body.witness || base, at: body.at, stream: body.stream, status: body.status };
    } catch (err) {
      return { base, available: false, error: err.name === 'TimeoutError' ? 'witness did not answer in time' : err.message };
    }
  }));
}

/**
 * Many witnesses → one verdict for the stream. Any witness that got audio wins:
 * one location receiving the stream proves it was on air. Only if every witness
 * that answered failed is it "also failed"; if none answered, there is no
 * verdict at all.
 */
function streamVerdict(answers) {
  const answered = answers.filter((a) => a.available && a.stream);
  const ok = answered.find((a) => a.stream.ok);
  if (ok) return { name: ok.name, ok: true, bytes: ok.stream.bytes || 0, httpStatus: ok.stream.httpStatus ?? null, timings: ok.stream.timings || {}, at: ok.at };
  if (answered.length) {
    const a = answered[0];
    return { name: a.name, ok: false, error: a.stream.error || `HTTP ${a.stream.httpStatus}`, httpStatus: a.stream.httpStatus ?? null, timings: a.stream.timings || {}, at: a.at };
  }
  const why = answers.map((a) => a.error).filter(Boolean)[0];
  return answers.length ? { name: null, ok: null, unavailable: true, error: why || 'no witness answered' } : null;
}

/** The first witness copy of the status page that was actually read, if any. */
function statusBody(answers) {
  const hit = answers.find((a) => a.available && a.status?.ok && typeof a.status.body === 'string');
  return hit ? { name: hit.name, body: hit.status.body, timings: hit.status.timings || {} } : null;
}

module.exports = { witnessConfig, witnessesConfigured, needsWitness, askWitnesses, streamVerdict, statusBody, WITNESS_TIMEOUT_MS };
