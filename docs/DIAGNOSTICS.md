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

The fetch is retried `ICECAST_STATUS_ATTEMPTS` times (default 3, `ICECAST_STATUS_RETRY_MS`
apart) before Icecast is declared unreachable. This matters because an
unreachable verdict forces `listenerImpact` to `unknown`, and `unknown` emails: a
single dropped connection between the monitor and Pacifica used to page people
for something no listener experienced. In the production record 131 of 170 fetch
failures were one-second socket hang-ups. A sustained outage survives every
retry and still alerts. An unparseable document is *not* retried — the bytes
would be identical.

The document is parsed tolerantly. Icecast 2.4.x emits **invalid JSON** when a mount has no title metadata — it writes a bare `-` where a string belongs. A strict parse throws, and reporting that as `reachable: false` would be wrong in the way that matters most: a malformed reply is positive proof Icecast is up and answering. Because an unreachable verdict forces `listenerImpact` to `unknown`, and `unknown` alerts, one station's empty title tag would otherwise silently disable the impact gate for every stream on the server. The malformation is repaired before parsing, and `snapshot.repairedJson` records when that happened. Observed live on `stream.pacificaservice.org` (Icecast 2.4.4); never yet on `streams.pacifica.org`.

**b-2. Channel audience.** Each bitrate variant of a channel is a separate
Icecast mount, so listener counts are summed across a channel's `mounts` list
rather than read from the probed mount alone. `variantsPresent` distinguishes a
channel that is off air (`0`) from one that lost a single encoder but is still
playing (`0 < present < total`).

**b-3. Degraded channels.** A variant fails in two ways, and they need different
evidence. **Missing** — Icecast no longer lists the mount; the inventory is the
witness and no probe is needed. **Stalled** — Icecast still lists it, but it
does not serve audio; only a direct probe can see this, so the non-primary
mounts are probed every `VARIANT_PROBE_EVERY` cycles. Both raise one `degraded`
event per episode, held open until every mount is serving again.

The listener figures come from opposite places on purpose. A missing mount
reports no listeners *because* nobody can reach it, so its audience is only
knowable from the previous snapshot and is frozen on the episode. A stalled
mount is still listed and still holding its listeners — connected, hearing
nothing — so its current count is the right one.

A degraded channel is **not** counted as downtime (`store.isFailureEvent`). The
probed mount never stopped serving, and folding it into the failure totals would
charge the station off-air time its listeners did not experience.

**Alerting.** A degradation emails only when it is BOTH sustained
(`DEGRADED_ALERT_AFTER_MS`, default 30 min) AND cost listeners — one message per
episode, plus an all-clear when it ends. Either condition alone stays silent and
recorded. A variant nobody was listening to is a fact about an encoder; a variant
dead for half an hour with an audience on it is a loss nobody would otherwise
find out about, because the dashboard shows it and nobody is watching the
dashboard at 4am. The email says DEGRADED, never DOWN — describing a playing
channel as offline is the most damaging thing an alert can get wrong.

**Repeated outages.** Every rule above judges one episode. A fault that keeps
recurring — almost always a source encoder dropping and reconnecting — satisfies
all of them every time, truthfully, and produces one email per flap. On
2026-09-02 that was fourteen messages in an hour about a single ongoing fault.

So a second confirmed outage on the same stream within `STORM_WINDOW_MS`
(default 45 min) declares a **storm**. The alert that declares it says so and
says that further alerts are paused; after that the stream emails nothing.
Recording is untouched — every outage, recovery, duration and listener-minute
still lands on the dashboard, and each suppressed event carries the reason in
its own `email.reason`. When the stream has been healthy without interruption
for `STORM_CLEAR_AFTER_MS` (default 30 min) one summary goes out — total
outages, total downtime, peak audience affected, listener-minutes lost — and
normal alerting resumes. Storm state is persisted through the store, so a
redeploy mid-storm does not restart the flood from the first email.

The first outage is never delayed. A hold-down would have quieted the inbox too,
by taxing the one alert that matters; this pays with the sixth alert instead of
the first.

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

Checks run every `CHECK_INTERVAL_MS` (60 seconds by default), which normally bounds outage-duration resolution to a minute. But Icecast stamps each mount with `stream_start_iso8601` — the moment its source connected. When a stream recovers, comparing that timestamp against the outage start gives the **true** source-side downtime.

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

These are deliberately decoupled. **Every** failed check enters the long-term event record; only some are worth an email. Events are not pruned by age, but the store retains the newest `MAX_EVENTS` entries (100,000 by default) as a memory-safety ceiling.

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
recorded in the long-term history either way — the aggregate trend is the actionable signal, not the individual
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

Recovery events can also be reconstructed, by `store.backfillRecoveries()` at startup: a confirmed outage that carries a `resolvedAt` but has no `recovery` event beside it gets one written from its own record. That is a repair, not an inference — `resolvedAt` was written by the check that saw the stream serving again. An outage with no `resolvedAt`, or one closed as `abandoned`, is left alone: nothing was observed there.

Events flagged `reconstructed: true` were backfilled from raw telemetry rather than observed live. Their timestamps, statuses and error strings are real recorded values; the diagnosis was inferred afterwards from those errors plus cross-stream correlation. They render with a *Reconstructed* badge and an explanatory note. Do not cite them as live measurements.
