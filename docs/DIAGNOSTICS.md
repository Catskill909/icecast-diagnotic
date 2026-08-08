# Diagnostics Reference

How the monitor decides *what* broke, and how to read what it tells you.

Implementation: [`../diagnose.js`](../diagnose.js). Episode/alert logic: [`../monitor.js`](../monitor.js).

---

## 1. Why a bare status check is not enough

A stream check that only reports up/down cannot distinguish these two situations, which look identical from the outside and have nothing else in common:

- The Icecast server is down.
- The Icecast server is perfectly healthy, and KPFT's encoder stopped feeding it.

The second is far more common in practice, and it is a studio problem. Reporting it as "the stream is down" sends people to the wrong place.

## 2. The three signals

Every check gathers three independent pieces of evidence, and the classifier only reaches a confident verdict where they agree.

**a. Connection-layer timings.** The probe instruments the socket, recording where in `DNS → TCP → TLS → first byte` the request got to. A failure before TCP is a network or DNS problem; a failure after a full connection with an HTTP response is a server-application problem. Captured in `diagnosis.timings`.

**b. Icecast's own mount inventory.** `/status-json.xsl` is fetched every cycle and kept in full — all 15 mounts across all five Pacifica stations, not just KPFT's. This answers "does Icecast think this mount exists?" and "is the rest of the server healthy?"

**c. Cross-stream correlation.** All three KPFT streams are checked in the same cycle. One stream failing is a stream problem; all three failing in the same second is not a coincidence.

## 3. The decisive rule

> **HTTP 404 on a mount means the server is UP and the SOURCE is gone.**

Icecast had to be running to answer with a 404 at all. If the mount is also absent from the inventory while other stations keep streaming, the conclusion is unambiguous: no source client is connected to that mount.

This is `cause: 'source_disconnected'`, and it points at the Barix encoder, the studio audio chain, or the encoder's network link — never at Pacifica.

## 4. Cause catalogue

| `cause` | Trigger | Scope | Points at |
|---|---|---|---|
| `source_disconnected` | 404 + mount absent from inventory | stream / station | Studio encoder |
| `mount_stalled` | 404 but Icecast still lists the mount | stream | Edge/proxy out of sync with Icecast |
| `icecast_down` | `ECONNREFUSED`, or resets with the status endpoint also unreachable | server | Icecast process stopped |
| `server_restart` | `server_start` timestamp changed between cycles | server | Icecast restarted; sources reconnect on their own |
| `connection_reset` | `ECONNRESET` / socket hang up, server otherwise reachable | stream / server | Connection limit, proxy recycling, transient |
| `timeout` | `ETIMEDOUT` | stream / server | Load or network path |
| `dns` | `ENOTFOUND`, `EAI_AGAIN` | stream | DNS record or resolver |
| `tls` | Certificate expiry, hostname mismatch, chain errors | stream | HTTPS cert on the streaming host |
| `server_error` | HTTP 5xx | stream | Icecast or proxy internal fault |
| `bad_content` | 200 but not audio | stream | Intercepting proxy or error page |
| `dead_air` | 200, audio flowing, but silent | stream | Studio audio routing / automation |

**Scope** escalates on correlation: `stream` → `station` (all KPFT mounts gone, other stations fine) → `server` (everything down, or Icecast unreachable).

## 5. Confirming duration independently of polling

Checks run every 60 seconds, which bounds outage-duration resolution to a minute. But Icecast stamps each mount with `stream_start_iso8601` — the moment its source connected. When a stream recovers, comparing that timestamp against the outage start gives the **true** source-side downtime.

Recovery events carry this as `sourceOutage.sourceDownLabel`. It is the most defensible number available: Icecast's own record of when the encoder came back.

## 6. Listener impact

Listener counts come from the mount inventory. Two behaviours matter when reading outage reports:

- **Mount absent + Icecast reachable → 0 listeners.** The mount cannot serve anyone; it does not exist. Earlier builds carried the last known count forward here, which made outages look like they retained their whole audience.
- **Icecast unreachable → previous value retained,** because the true count is genuinely unknown.

Empirically the two failure modes affect listeners very differently:

- **Source dropout:** everyone on that mount is disconnected. Observed 2026-08-04: KPFT Main fell 66 → 10 listeners and took over 30 minutes to rebuild, with a second dropout landing mid-recovery.
- **Server-side reset:** established listeners are unaffected — counts stayed flat at 65–67 through the 19:05 reset. What fails is *new* connections, so anyone pressing play in that window gets a stream that will not load.

The second is easy to under-weight: it generates no complaints and no visible dip, but it is exactly what produces a "the stream is unreliable" reputation.

## 7. Recording vs. alerting

These are deliberately decoupled. **Every** failed check is recorded permanently; only some are worth an email.

| Point in an episode | Recorded | Emails |
|---|---|---|
| Failure #1 | `brief_outage` or `probe_error` | no |
| Failure #`FAILURE_THRESHOLD` | promoted to `outage` | only if listeners were affected |
| Recovery | resolved with true duration | yes, if an alert was sent |

The gate is the diagnosis's `listenerImpact` verdict. `confirmed` (Icecast reachable, mount gone)
and `unknown` (Icecast unreachable, so it cannot be cleared) both email. `none` — Icecast reachable
and still serving the mount — does not, because nobody lost a second of audio. The observation in
§6 above is exactly why: a server-side reset leaves established listeners untouched, and the
listener counts prove it.

Set `ALERT_ON_HARMLESS_OUTAGE=true` to email confirmed outages regardless of impact. Everything is
recorded permanently either way — the aggregate trend is the actionable signal, not the individual
event.

Every event stores its delivery outcome in `email`: `sent`, `attempted` with the SMTP error, or an explicit `reason` for why no alert was warranted. A failed send is visible rather than silent.

## 8. Investigating an incident

```bash
# Everything the diagnosis knows about one event
curl -s 'localhost:3000/api/events/<id>' | jq

# All source-side dropouts in the last 90 days
curl -s 'localhost:3000/api/events?days=90&cause=source_disconnected' | jq '.total'

# Events that generated no alert
curl -s 'localhost:3000/api/events?days=90&emailed=false' | jq

# Live server state, including other stations on the same host
curl -s 'localhost:3000/api/diagnostics' | jq '.mounts[] | {pathname, listeners, streamStart}'
```

In the UI, the History page groups by day, filters by cause/severity/stream/delivery, and every row expands to its full evidence chain, Icecast state, timing breakdown and delivery record. Individual events are linkable via `history.html#<event-id>`.

## 9. Provenance

Events flagged `reconstructed: true` were backfilled from raw telemetry rather than observed live. Their timestamps, statuses and error strings are real recorded values; the diagnosis was inferred afterwards from those errors plus cross-stream correlation. They render with a *Reconstructed* badge and an explanatory note. Do not cite them as live measurements.
