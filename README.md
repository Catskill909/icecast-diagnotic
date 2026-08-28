# 📡 KPFT Icecast Stream Monitor & Diagnostic Tool

> **New to this codebase?** Start with **[HANDOFF.md](HANDOFF.md)** — the data flow,
> the decisions behind it, and the traps, in one page.

Monitors KPFT (Pacifica Foundation) Icecast live streams and — the point of the tool — **identifies which side of the handoff needs attention**: KPFT's source/feed path or the Pacifica/Icecast path.

A bare "stream is down" alert leaves you guessing who to call. This correlates connection-layer timings, Icecast's live mount inventory, and cross-stream behaviour to name the cause, and keeps a long-term record so patterns are visible over months rather than hours.

---

## 🔎 The Core Distinction

Icecast returning **HTTP 404** on a mount does not mean the server is down. It means the opposite: the server is alive and answering, and the **source encoder has disconnected**. The mount vanishes from Icecast's inventory while every other station on the same host keeps streaming.

That single fact separates two failures with completely different owners and completely different listener impact:

| | Studio side — Barix encoder | Server side — Icecast |
|---|---|---|
| **Signature** | `HTTP 404`, mount absent from inventory, other stations fine | Connection reset/refused, often several streams in the same second |
| **Confirmed by** | `stream_start` timestamp showing the source reconnect | Simultaneity across streams; Icecast uptime unchanged |
| **Listeners already tuned in** | **All cut off.** Audience rebuilds slowly | Unaffected — established connections continue |
| **Listeners pressing play** | Cannot connect until the source returns | **Cannot start playback** during the window |
| **Who fixes it** | KPFT — check the encoder and studio audio chain | Pacifica — server load, connection limits, proxy |

Observed on 2026-08-04/05: a Barix dropout took KPFT Main from 66 listeners to 10, with the audience taking over half an hour to rebuild. Server-side resets in the same period cost zero established listeners.

---

## 🎯 Architecture Overview

```
                ┌──────────────────────────────────────────────────────┐
                │            Icecast Server (pacifica.org)             │
                │  Streams: /live_128, /HD3_128, /classic_country      │
                │  Inventory: /status-json.xsl  (15 mounts, 5 stations)│
                └───────────────┬──────────────────────┬───────────────┘
                    probe each stream          full mount inventory
                                │                      │
                                ▼                      ▼
                ┌──────────────────────────────────────────────────────┐
                │                  Docker Container                    │
                │                                                      │
                │  diagnose.js ── instrumented probe (DNS/TCP/TLS/TTFB)│
                │              └─ classifier: correlates the probe     │
                │                 result, the mount inventory, and     │
                │                 every other stream in the cycle      │
                │                          │                           │
                │  monitor.js  ── episode state machine                │
                │                 brief → confirmed outage → recovery  │
                │                 decides what is worth emailing       │
                │                          │                           │
                │  store.js    ── events.json   (long-term event log)  │
                │                 samples.json  (7d raw → hourly)      │
                │                          │                           │
                │  server.js   ── Express API + static SPA             │
                └───────────────┬──────────────────────┬───────────────┘
                                │                      │
                                ▼                      ▼
                ┌───────────────────────┐  ┌───────────────────────────┐
                │   Dashboard (live)    │  │  History (long-term)      │
                │  status, listeners,   │  │  heatmap, filters,        │
                │  uptime bars          │  │  per-event drill-down     │
                └───────────────────────┘  └───────────────────────────┘
                                │
                                ▼
                        Email alerts — lead with root cause,
                        include remediation, record delivery
```

---

## 🧠 AI / LLM Handoff & Developer Quickstart

If you are an AI assistant or developer picking up this project, here is the essential state map:

### Key File Locations
- **`server.js`**: Express server entrypoint. Serves static files from `public/` and the API.
- **`monitor.js`**: Check engine. Owns the check cycle, the episode/event lifecycle, the silence engine, and Nodemailer alerts.
- **`diagnose.js`**: Root-cause diagnosis engine. Instrumented stream probe (DNS/TCP/TLS/TTFB timings), Icecast mount-inventory snapshot, and the classifier that turns a transport error into an actionable cause.
- **`store.js`**: Persistence. Splits the long-term event record from rolling telemetry; handles atomic writes, hourly compaction, and legacy migration.
- **`public/index.html` / `app.js`**: Live dashboard.
- **`public/history.html` / `history.js` / `history.css`**: Long-term incident history — heatmap, listener-audience chart, filters, per-event drill-down.
- **`public/listeners.html` / `listeners.js` / `listeners.css`**: Audience analytics — every channel on one scale, the per-mount split that every other figure sums away, hour-of-day profile, and CSV export. Station-scoped like the history page.
- **`scripts/backfill-audience.js`**: Reporting/repair tool for the `audience` block. **Not normally needed** — `store.load()` backfills automatically at every startup, before `prune()` runs. Use this to preview the numbers (dry-run by default) or to repair after a manual data edit. Safe to re-run; it never overwrites a measured figure.
- **`public/style.css`**: Dark Material Design 3 theme system using CSS variables.
- **`Dockerfile`**: Production build on `node:20-alpine` with `curl` for Coolify health probes.

### Event Model (important)

Notification is decoupled from recording. **Every failed check enters the long-term event record**; only some of them email. Events are not pruned by age, but only the newest `MAX_EVENTS` entries are retained (100,000 by default).

An *episode* runs from a stream's first failed check to its recovery. Within one episode:

| Point | Recorded | Emails |
|---|---|---|
| Failure #1 | event, severity `brief_outage` or `probe_error` | no |
| Failure #`FAILURE_THRESHOLD` | same event promoted to `outage` | **only if listeners were affected** |
| Recovery | event resolved with true duration | yes, if an alert was sent |

**The bar for an email is listener impact, not probe failure.** The monitor watches from
outside Pacifica's network, so a failed probe alone proves only that *our* connection broke.
Icecast is the witness: if it is reachable and still lists the mount, the mount kept serving
its audience. Each diagnosis therefore carries a `listenerImpact` verdict:

| Verdict | Meaning | Emails |
|---|---|---|
| `confirmed` | Icecast reachable, mount **gone** — every connected player dropped | yes |
| `unknown` | Icecast unreachable — cannot be cleared, so treated as real | yes |
| `none` | Icecast reachable, mount still serving — nobody lost audio | **no** |

This replaced an earlier rule that emailed any single failure hitting all streams at once. Four
days of production data showed 12 of 21 alerts were 60-second probe resets in which no mount ever
dropped a listener — noise that trains recipients to ignore the alerts that matter.

An unconfirmed failure is split by the same verdict: `brief_outage` when the mount really did
vanish (a real gap, just short) and `probe_error` when Icecast stayed healthy throughout. The
retired name for both was `blip`; stored events still carry it and every counter recognises it.

### Who this is for, and which number leads

Two audiences read the same pages, and the layout is built around that:

| | Needs to know | Reads |
|---|---|---|
| **Station managers** (non-technical) | Is something broken? Whose fault? How many listeners did we lose? | the headline, the fault split, the incident list |
| **KPFT & Pacifica engineers** | What broke, when, for how long, with evidence | the incident list, the drill-downs, the timeline |

**The metric hierarchy is fixed and deliberate:**

1. **Share of possible listening delivered** — a proportion with a meaningful scale.
2. **Listener interruptions** — repeatable exposure, not a unique-person count.
3. **Which path needs attention** — KPFT source/feed vs Pacifica/Icecast, with evidence limits.
4. **Broadcast-time measures** — elapsed and summed stream-time shown together and qualified.
5. Everything else — monitoring detail.

**The rule that keeps it readable: a headcount, a clock duration and a person-hours figure are
never presented without their unit and counting rule.** When they appear together, the page
explicitly reconciles them and warns which values cannot be added.

### What an alert says about the audience

Every alert states the human cost, in the subject as well as the body — that is the part read
on a phone at 3am, and it is what separates "get up now" from "look at it in the morning".

| Alert | Audience figure | Why that one |
|---|---|---|
| Down / dead air | **listeners at risk** — the audience at the moment it started | the loss is still accruing and cannot be totalled yet |
| Recovery | **listeners cut off** and **listening lost** | the outage length is finally known, so reach × duration is real |

`listening lost` is listener-minutes — how much actual listening the failure cost.
Neither number conveys it alone — 5 listeners for an hour and 300 listeners for a minute are
not the same event, and the raw outage duration calls them equal. Each figure is labelled
`measured` (from listener counts recorded just before the failure) or `modelled` (from that
hour's typical audience, when no live count survived), and the email says which.

#### How listener-minutes are calculated

The audience is **measured** immediately before the failure. How it is carried across the
outage depends on how long the outage ran — `audience.model` on every event records which
rule was applied:

| `model` | When | Rule |
|---|---|---|
| `flat` | outage ≤ 1 hour | audience × duration |
| `hour-of-day` | outage > 1 hour | the stream's own hour-of-day audience profile, rescaled to pass through the measured starting point, integrated across the outage |
| `none` | no listener impact | zero — Icecast kept serving the mount |

**Why the curve exists.** A flat multiplier assumes whoever was listening when it broke would
have kept listening, at that exact headcount, for every minute it stayed broken. Over four
minutes that is fine. Over a 3h35m outage beginning at 8:12pm it charges a primetime audience
for the small hours. On the production record, two long events carried 88% of all reported
loss, so this assumption — not the measurement — was the dominant source of error.

**It moves in both directions.** An outage starting at peak and running overnight is revised
*down*; one starting in a quiet hour and running into the next day's peak is revised *up*,
because the audience it kept out was larger than the headcount at the moment it began. Events
re-costed this way keep `flatEquivalent` so the older figure is always recoverable.

The curve is used only when the profile has at least 12 populated hours, and the rescaling
factor is clamped to 0.2×–5× so one freak reading at the moment of failure cannot multiply a
long extrapolation. Failing either guard, the flat figure stands.

#### Which path needs attention

`faultSplit` assigns every listener-affecting outage to the side of the handoff indicated by
Icecast reachability at the moment of failure. It does **not** prove which physical device,
service, or network hop failed:

| `side` | Means |
|---|---|
| `kpft` | Icecast was **reachable** but the monitored source/mount was absent — inspect the KPFT source/feed path |
| `pacifica` | Icecast could **not be reached** — inspect the Pacifica/Icecast server, network, DNS, and TLS path |
| `unknown` | not enough evidence to assign the handoff; investigate jointly |

This is the action-routing field in the record. Its category windows can overlap: if the KPFT
source path is already down when the Icecast path becomes unreachable, both categories accrue
time. Therefore category hours must **never** be added to derive total elapsed downtime.
Each entry's `streamRecords` is the clear-name count; `outages` remains as a compatibility alias.
The GM-facing History cards therefore omit aggregate category hours: they split the interruption
records by action owner and show only the longest single interruption. The overlap field remains
available to engineers and API consumers.

#### Time off air vs. stream-hours

Two different questions, and only one of them is what "how long were we down" means:

| Figure | Field | Meaning |
|---|---|---|
| **Elapsed off-air window** | `downtime.wallClockMs` / `downtime.elapsedOffAirMs` | elapsed time with *at least one* stream down; concurrent outages merged and counted once |
| Summed stream-time | `downtime.streamMs` / `downtime.summedStreamMs` | per-stream durations added together — the figure that reconciles with the uptime percentage |
| Fault-category overlap | `downtime.categoryOverlapMs` | category time occurring concurrently; explains why `faultSplit` durations do not add to elapsed time |

On the production record these read about 19h 28m and 1d 3h for the same period. The gap is one
Icecast fault that took two streams down together: 3h35m off air, but 7h10m of stream-hours.
Reporting the sum as though it were elapsed time overstated the outage by nearly half, so the
tile leads with wall-clock and names the summed figure beside it.

Both **exclude failures that cost the audience nothing** — Icecast was reachable and still
serving the mount, so counting them as downtime would contradict the verdict already reached
about them.

#### Which impact verdict counts

Every event carries two, and they routinely disagree:

| Field | Written | Says |
|---|---|---|
| `diagnosis.listenerImpact` | while the stream was still failing | often `unknown` — Icecast was unreachable, so nothing could be confirmed |
| `audience.listenerImpact` | at recovery | the **settled** verdict, once Icecast could be asked whether the mount had really gone |

**The settled verdict wins** (`store.settledImpact()`). Reading the failure-time guess instead
counted 49 harmless probe resets as downtime on the production record. `unknown` always groups
*with* `confirmed`: an outage that could not be cleared is treated as real, never written off.

#### Audio uptime

`uptime` is the share of monitored time the streams were **actually serving audio** — failures
where Icecast kept serving the mount are not charged to the station. The older sample-based
figure, in which every failed probe is a down sample, remains available as `probeUptime`.

On the first production week these read 94.77% and 94.35%. The gap is the monitor's own
network hiccups, which a station's uptime figure has no business reporting as its own downtime.
Both `/api/uptime` and `/api/rollup` return both numbers, and the live dashboard and the
history page read the same one, so the two pages cannot disagree.

`audience.lostSharePercent` puts the loss against everything actually delivered
(`listenerHoursDelivered`, integrated from real listener samples). "214 listener-hours lost"
means little alone; "2.2% of all listening" is a number a station manager can act on.

A probe anomaly is charged **zero** loss even though it recorded a failure: Icecast was
reachable and the mount kept serving, so nobody lost a second of audio.

### Diagnosis

The classifier correlates three independent signals: connection-layer timings, the Icecast `/status-json.xsl` mount inventory, and cross-stream correlation within the same cycle.

The status fetch is **retried** before Icecast is declared unreachable. Icecast is
the witness the alert gate depends on, so a failed fetch forces `listenerImpact` to
`unknown` — which emails. A one-second network hiccup between the monitor and
Pacifica costs listeners nothing, yet used to page people; a genuine outage
survives three tries and still alerts exactly as before.

The status document is parsed **tolerantly**: Icecast 2.4.x emits invalid JSON when a mount has no title metadata, and treating that as an unreachable server would force every `listenerImpact` verdict to `unknown` — which alerts. The malformation is repaired before parsing and flagged as `repairedJson`. See [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md).

The key distinction it draws: **an Icecast mount returning HTTP 404 means the server is healthy and the source encoder dropped off.** That is a studio problem (check the Barix), not a server problem. Because other Pacifica stations share the host, the engine can also confirm whether a fault is KPFT-specific or server-wide — and `stream_start_iso8601` gives the exact source reconnect moment, yielding a true outage duration independent of the polling interval.

### In-app guide

The dashboard carries a guide covering how diagnosis works, what counts as an
outage, when an email is sent, and how listener impact is measured. Its content
lives in [`public/guide.js`](public/guide.js) as data — a TOPICS array — rather than
as markup, so editing it does not mean editing the page.

### Security

A point-by-point review is in **[`docs/SECURITY.md`](docs/SECURITY.md)** — findings,
severity, what was fixed, and what is verified sound.

### Installing elsewhere

The app is a plain Node service in a standard container and does **not** depend on
any hosting platform. Docker Compose, Coolify, a bare Docker host and Node under
systemd all run the same code — they differ only in where the environment
variables are typed. A `docker-compose.yml` is included.

See **[`docs/INSTALL.md`](docs/INSTALL.md)** for all four paths, the minimum
configuration for a single-stream station, and what must be on a persistent
volume.

### Admin authentication

Endpoints that **change state or send mail** require a session; reading stays
open. Sign in at `/login.html`.

```bash
node scripts/hash-password.js          # prints ADMIN_PASSWORD_HASH=...
```

Set `ADMIN_USER`, `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` in the hosting panel.

**Protected routes fail closed.** With no password configured they return 503
rather than allowing the request. This is deliberate: `/api/test-alert` sends mail
through the station's SMTP, and before this gate existed anyone who found the
URL could fire station-branded email at arbitrary addresses. A deployment that
forgets to set a password gets a broken button, not a silent hole.

| Route | Access |
|---|---|
| `/api/test-alert`, `/api/weekly-roundup` | **Authenticated** — both send mail |
| `POST /api/login`, `/api/logout`, `GET /api/me` | Public |
| `/api/events`, `/api/stations`, `/api/diagnostics` | Public, but **redacted** — see below |
| Everything else | Public by default; set `REQUIRE_LOGIN_FOR_READ=true` to gate reads too |

### What anonymous callers are not shown

Reading is open, but stored records are richer than what should be published.
Public responses go through [`redact.js`](redact.js):

| Withheld from anonymous callers | Why |
|---|---|
| `event.email.recipients` / `cc` | These are people. Replaced by `recipientCount`, so the history page can still say an alert reached three people without naming them |
| `event.email.messageId` | Embeds the sending domain and reads as an address; nothing renders it |
| `diagnosis.icecast.admin` | The Icecast server's published contact address |
| `host.statusUrl` | May carry credentials — `https://user:pass@host/admin/stats.xml` |
| Anything not on the station-config allowlist | Per-station recipients and thresholds are withheld **before** they exist |

Authenticated administrators see the full records, including who was notified.

**Station configuration is projected by allowlist, not blocklist.** A blocklist
protects the fields someone remembered; the next field leaks silently and nothing
fails. A field wrongly withheld is a bug report — a field wrongly published
cannot be recalled.

**What the gate is and is not.** It is one shared credential, an scrypt password
hash, constant-time comparison, rate limiting with lockout, and a signed
`HttpOnly` / `SameSite=Strict` session cookie. It is not per-user accounts, roles
or per-station scoping — those arrive with the admin panel, and the middleware
boundary here is what lets them arrive without revisiting every route.

The login is two screens (username, then password) because that interaction was
asked for. **It adds no security** — it is an identity-*routing* pattern, and a
script posts both steps as fast as one. It is implemented safely: the first
screen accepts any username and always advances, and both halves are verified
together on the server, so it cannot be used to discover valid usernames.

### Where configuration lives

**Station, channel and host configuration lives in the data store, not in
environment variables.** On the first boot against an empty volume, `STREAMS` (or
the built-in defaults) seeds it; from then on the store is authoritative and env
changes to `STREAMS` are ignored.

This is deliberate. An admin panel changes settings while the app is running, so
the store has to win — otherwise every redeploy would silently revert whatever an
operator had just configured. Secrets stay in the environment, where they never
need a UI and so never conflict.

`GET /api/stations` returns the live configuration: the host pool, the stations,
and each station's channels. To overwrite a bad seed, set `CONFIG_RESEED=true`
and restart — wiping the volume would also destroy the incident history.

**Hosts are a shared pool, not a property of a station.** Many stations share one
Icecast server (all five Pacifica sister stations are on one; ~28 affiliates on
another), so each host's inventory is fetched once per cycle and serves every
station on it. A minority of stations span more than one host, which the same
shape supports.

### Channels and their mounts

Icecast publishes each bitrate variant of a channel as its own mount, so **KPFT
Main is both `/live_128` and `/live_64`**. Each monitored stream therefore declares
a `mounts` list, and **listener counts are summed across the whole channel**.
Reading only the probed mount reported a fraction of the real audience —
measured live at 57 of 88 listeners, with 35% of the audience invisible.

| Channel | Probed mount | Other variants |
|---|---|---|
| KPFT Main | `/live_128` | `/live_64` |
| KPFT HD2 | `/HD3_128` | `/HD3`, `/HD3_64` |
| KPFT HD3 | `/classic_country` | — |

The primary mount is probed every cycle, so a channel produces one alert, not
one per variant. The other variants are probed every `VARIANT_PROBE_EVERY`
cycles (default 5) — often enough to catch a mount Icecast still lists but is
not actually serving, rarely enough that the audio pulled and the connections
opened stay a fraction of probing them all every minute.

Samples carry `variantsPresent` / `variantsTotal` and a per-mount
`mountListeners` breakdown: `present === 0` is a channel outage, while
`0 < present < total` is a degraded channel still playing for most of its
audience. The breakdown is the only per-mount history there is — the summed
count can hold steady while one variant's audience collapses inside it.

**The Icecast snapshot is fetched before any probe connection is opened.**
Icecast counts every connection as a listener, ours included: opening one
connection to `/kpfk` was measured taking it from 1 listener to 2. Probing
first would put the monitor's own probes inside the listener counts it then
records.

### Streams Monitored
| Name | Mount Point | M3U Source | Default URL |
|------|-------------|------------|-------------|
| **KPFT Main** | `/live_128` | `kpft.m3u` | `https://streams.pacifica.org:9000/live_128` |
| **KPFT HD2** | `/HD3_128` | `kpft_hd2.m3u` | `https://streams.pacifica.org:9000/HD3_128` |
| **KPFT HD3** | `/classic_country` | `kpft_hd3.m3u` | `https://streams.pacifica.org:9000/classic_country` |

---

## 🚀 Environment Variables Reference

Configure these environment variables in your deployment environment (e.g. Coolify UI or `.env` file):

```env
# ── Server Config ────────────────────────────────────
PORT=3000

# ── SMTP Email Config ────────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=monitor@example.com
SMTP_PASS=YourPasswordHere
SMTP_FROM="KPFT Stream Monitor <monitor@example.com>"

# ── Alert Recipients ─────────────────────────────────
ALERT_EMAILS=manager@example.com,engineer@example.com
ALERT_STATIONS=                  # Station ids that may email; empty = all
ALERT_CC=monitor-owner@example.com

# ── Dashboard Link in Emails ─────────────────────────
DASHBOARD_URL=https://kpft-icecast.supersoul.top

# ── Monitor & Silence Thresholds ─────────────────────
CHECK_INTERVAL_MS=60000         # Routine check interval (default: 60000ms / 1 min)
FAILURE_THRESHOLD=2             # Consecutive failures before sending server DOWN alert
SILENCE_PROBE_INTERVAL_MS=5000   # Rapid probe interval during silence evaluation (default: 5s)
SILENCE_FAILURE_THRESHOLD=3      # Consecutive silent probes before confirming Dead Air (default: 3)
REQUEST_TIMEOUT_MS=15000         # Individual stream-probe timeout
ICECAST_STATUS_TIMEOUT_MS=10000  # Icecast inventory request timeout
DEGRADED_ALERT_AFTER_MS=1800000  # A degraded channel emails only once it has lasted this
                                 # long AND cost listeners. Either alone stays silent and
                                 # recorded. 0 disables degraded alerting entirely.
VARIANT_PROBE_EVERY=5            # Probe a channel's NON-primary mounts every Nth cycle.
                                 # Each probe pulls 8 KB off the station's server AND
                                 # registers as a listener on that mount, so 1 would both
                                 # double the bandwidth and inflate small mounts' counts.
SAVE_INTERVAL_MS=60000           # Periodic persistence flush interval

# ── Alert Noise Control ──────────────────────────────
# Escape hatch: email EVERY confirmed outage, including ones Icecast proves did
# not cost a single listener any audio. Off by default — that behaviour is what
# buried the real alerts in noise. Everything is recorded either way.
ALERT_ON_HARMLESS_OUTAGE=false

# ── Weekly Roundup ───────────────────────────────────
# A scheduled 7-day summary — uptime, outages, listeners cut off, listening
# lost — sent whether or not anything went wrong. It is the only message that
# arrives during a quiet week, which is what tells a quiet week apart from a
# monitor that has silently stopped running.
WEEKLY_ROUNDUP=true             # false disables it entirely
WEEKLY_ROUNDUP_DAY=1            # 0=Sun … 6=Sat (default: 1, Monday)
WEEKLY_ROUNDUP_HOUR=9           # 24h clock, in STATION_TZ (default: 9)
WEEKLY_ROUNDUP_EMAILS=          # falls back to ALERT_EMAILS when empty
STATION_TZ=America/Chicago      # timezone for all email timestamps + schedule

# ── Retention ────────────────────────────────────────
# Events are not pruned by age, but the newest MAX_EVENTS are retained. Raw
# samples behind uptime figures are kept this many days, then compacted into
# long-term hourly summaries.
SAMPLE_RETENTION_DAYS=7
MAX_EVENTS=100000               # Memory-safety ceiling for the event log
DATA_DIR=/app/data              # MUST be a persistent volume in production
SEED_FILE=/app/seed/historical-events.json  # Optional one-time historical import

# ── Diagnostics ──────────────────────────────────────
CONFIG_RESEED=false              # Overwrite stored station config from env on next boot
STATION_ID=kpft                  # Station identity, used only when seeding
STATION_NAME=KPFT Houston
ICECAST_STATUS_ATTEMPTS=3        # Tries before believing Icecast is unreachable
ICECAST_STATUS_RETRY_MS=2000     # Wait between those tries
ICECAST_STATUS_URL=https://streams.pacifica.org:9000/status-json.xsl
SIBLING_MOUNTS=/live_128,/live_64,/HD3,/HD3_128,/HD3_64,/classic_country
STATION_LABEL=KPFT              # Station name used in operator-facing evidence text

# Optional JSON array replacing the three default streams. Include `mounts` to
# list a channel every bitrate variant, so listener counts cover the whole
# channel rather than the probed mount alone. Entries may be pathnames or full
# URLs. Omit `mounts` and the stream counts only its own URL.
# STREAMS=[{"id":"main","name":"Main","url":"https://example.com/main_128","mounts":["/main_128","/main_64"]}]
```

---

## 🩺 Interpreting the Data

**Uptime and the event log come from different sources.** Uptime percentages and the 24h bars are computed from per-check *samples*; the incident timeline comes from *events*. They are stored separately, so it is possible to restore one without the other and see a reassuring 100% on a day that contained real outages. If uptime looks implausibly clean, check `sampleCount` in `/api/stats`.

**Unconfirmed failures are not noise, they are just not urgent.** A single failed check that self-clears enters the long-term record but never emails — by the time anyone reads an alert it is already over. The value is in the aggregate: if *Connection reset by server* climbs week over week in the Root Causes panel, that is evidence worth taking to Pacifica, and far more persuasive than an anecdote. Note the split: a `probe_error` says more about the path between the monitor and Pacifica than about KPFT's streams, so do not cite it as station downtime.

**Listener-minutes are the honest unit of harm.** `9 outages` and `35 minutes down` both understate a midday failure and overstate a 4am one. Each resolved event freezes an `audience` block using the pre-failure listener count. Outages up to one hour use audience × duration; longer outages use the stream's hour-of-day audience curve when enough history exists, falling back to the flat calculation otherwise. Events proven to have no listener impact are charged **zero**. The block is frozen at recovery because the raw measurements compact after `SAMPLE_RETENTION_DAYS`.

**Listener counts during an outage.** When a mount vanishes, listeners correctly read **0** — the mount cannot serve anyone because it no longer exists. Earlier builds carried the last known count forward, which made outages appear to retain their full audience and hid the real loss. Counts are only carried forward when Icecast itself is unreachable and the true figure is genuinely unknown.

**True outage duration.** Polling every 60s bounds resolution to a minute, but `stream_start_iso8601` records the exact moment a source reconnected. Recovery events carry a `sourceOutage` block with the real duration derived from it.

**Reconstructed events.** Events flagged `reconstructed: true` were backfilled from raw telemetry rather than observed live — timestamps, statuses and errors are real recorded values, but the diagnosis was inferred after the fact. They render with a *Reconstructed* badge and a provenance note so they are never mistaken for live observations.

---

## 📡 API Endpoints

### `GET /api/status`
Returns real-time status of all monitored streams, including listener counts, response times, bitrate, now playing metadata, and error details.

### `GET /api/history`
Returns the rolling 24-hour check history per stream plus the last 24h of events. Kept for dashboard back-compatibility — use `/api/events` for the full record.

### `GET /api/events`
The long-term event log. It is not pruned by age, but retains the newest `MAX_EVENTS` entries. Each event carries its root-cause diagnosis, connection timings, Icecast state at the time of failure, resolution duration, and the email delivery outcome.

Query params: `days`, `since`, `until`, `streamId`, `type`, `severity` (`outage`/`brief_outage`/`probe_error`/`dead_air`/`recovery`, plus legacy `blip`), `cause`, `scope` (`stream`/`station`/`server`), `emailed` (`true`/`false`), `limit`, `offset`, `order`.

```bash
# Every event that never generated an alert email
curl 'localhost:3000/api/events?days=90&emailed=false'

# Confirmed source-encoder dropouts only
curl 'localhost:3000/api/events?cause=source_disconnected&severity=outage'
```

### `GET /api/events/:id`
Full detail for a single event.

### `GET /api/stats?days=30`
Aggregates for the history view: per-stream uptime and counts, daily buckets for the heatmap, root-cause breakdown, and storage info.

Each daily bucket includes `impactMs` (elapsed off-air time, overlaps merged) and `streamMs`
(affected streams summed separately), spread across every station-local day the outage touched.
`dailyTimeZone` names that timezone. Probe-only failures do not color the off-air calendar.

### `GET /api/uptime?days=1`
Returns audience-experienced `uptime`, which excludes probe-only failures where Icecast kept serving the mount, plus the raw sample-based `probeUptime`. It also reports the actual history coverage so the UI can label partial ranges.

### `GET /api/samples/:streamId?hours=24`
Raw per-check telemetry plus hourly rollups for one stream.

> ⚠️ **`hours` defaults to 24, not to everything retained.** Deriving an audience
> baseline from that default and applying it to older incidents overstated listener
> loss threefold once. Pass `?hours=168` when you want the full raw window.

### `GET /api/listeners?days=1&bucketMinutes=`
Audience over time for every stream, the outage windows that interrupted it, and the
summary — all in one payload, so a chart can never draw a series and its overlay from
two different moments.

Raw samples and hourly rollups are stitched transparently, so a long range spans both
storage tiers. `bucketMs` auto-scales with the window (5 min → 6 h) and is reported back;
override it with `bucketMinutes`. Averages count only checks where the stream was **up** —
a zero reported during an outage means the mount was gone, not that the audience left.

`summary.eventsMissingAudience` is the count of resolved failures with no frozen `audience`
block. It should be zero: the store backfills automatically at startup. A non-zero value means
those events were already past the raw-sample retention window when first seen, so their
listener cost is gone for good — the totals are a floor.

### `GET /api/rollup?days=7`
Period totals in numbers **and in one English sentence** — outage counts, downtime, alert
delivery, listener interruptions, listening lost, per-stream breakdown, top causes and the
sustained incidents.

The sentence in `narrative` is composed server-side for the weekly roundup email and for API
consumers that need a plain-English summary. The History page renders the same underlying
fields as explicitly qualified metrics rather than restating them in a second summary card.

Two counts are deliberately kept apart and must not be conflated:

| Field | Counts |
|---|---|
| `alerts.messages` | emails actually sent — one consolidated message can cover three streams |
| `alerts.eventsAlerted` | events that were covered by an alert |
| `interruptions.streamRecords` | one record per affected stream; one incident affecting two streams creates two records |
| `interruptions.sustainedStreamRecords` + `.briefStreamRecords` | reconciliation of the stream-record total at the five-minute threshold |
| `audience.listenerInterruptions` / `listenersCutOff` | audience summed **per interruption** — someone cut off three times counts three times |
| `audience.listenerMinutesLost` | audience × duration; always show it with its share of possible listening |

`coverageMs` is how much of the window the monitor actually watched. When it falls below
95% of the window, both the page and the email say so rather than quoting a partial period
as a whole one.

### `GET /api/weekly-roundup`
| Query | Effect |
|---|---|
| `?preview=1` | renders the email in the browser **without sending it** — works with no SMTP configured |
| `?to=user@example.com` | sends it to one address instead of the configured recipients |
| `?days=7` | window to report on (default 7) |

The scheduled job sends this on its own; this route exists so the message can be checked
without waiting a week. Last-sent state is persisted in `events.json` under `meta`, keyed by
station-local date — so a container that redeploys six times on a Monday still sends one
roundup, and a monitor that was down at 9am sends it when it returns later that day rather
than skipping the week.

### `GET /api/events/:id/email-preview`
Re-renders the alert email for a stored event, from that event's own diagnosis and frozen
audience figures. An email template that can only be seen during an outage is one nobody
ever checks.

### `GET /api/diagnostics`
Live Icecast server state — the full mount inventory including other Pacifica stations, which is what the classifier correlates against.

### `GET /api/config`
Returns public monitor settings (check interval, recipient counts, SMTP status, retention policy).

### `GET /api/test-alert?to=user@example.com`
Sends a formatted test email alert to the requested address for deliverability verification.

### `GET /health`
Container health check endpoint (used by Docker and Coolify probes). Returns `200 OK`.

---

## 🐳 Local Development & Testing

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode with auto-reload
npm run dev

# 3. Test API endpoint locally
curl http://localhost:3000/api/status

# 4. Trigger a test email locally
curl "http://localhost:3000/api/test-alert?to=your-email@example.com"

# 5. Look at the weekly roundup without sending it (no SMTP needed)
open "http://localhost:3000/api/weekly-roundup?preview=1&days=7"

# 6. Send this week's roundup to yourself right now
curl "http://localhost:3000/api/weekly-roundup?to=your-email@example.com"

# 7. See the alert email a past incident produced
curl -s 'http://localhost:3000/api/events?severity=outage&limit=1' | jq -r '.events[0].id' \
  | xargs -I{} open "http://localhost:3000/api/events/{}/email-preview"
```

---

## 🚢 Coolify Deployment Notes

1. **Build Pack**: Set to `Dockerfile`
2. **Ports Exposes**: `3000`
3. **Port Mappings**: `3000:3000`
4. **Healthcheck URL**: `http://localhost:3000/health` (uses `curl -f`)
5. **Persistent Storage** ⚠️ **required**: Mount a persistent volume at container path `/app/data`.

   Incident history lives in `/app/data/events.json`, is not pruned by age, and retains the newest `MAX_EVENTS` entries. Without a persistent volume, every redeploy silently resets the entire record to zero — the container filesystem does not survive a rebuild. Verify with:

   ```bash
   curl -s https://<your-host>/api/stats?days=1 | jq .storage
   # oldestEvent should predate your last deploy
   ```

   Two files are written there:
   - `events.json` — the long-term incident record (small; ~400 bytes/event; newest `MAX_EVENTS` retained)
   - `samples.json` — rolling telemetry, 7 days raw then hourly rollups (~4 MB at 3 streams)

---

## 📄 License
Pacifica Foundation / KPFT Houston — Open Internal Diagnostic Tool.
