# 📡 KPFT Icecast Stream Monitor & Diagnostic Tool

Monitors KPFT (Pacifica Foundation) Icecast live streams and — the point of the tool — **diagnoses which end broke**: the Barix encoder at the studio, or the Icecast server.

A bare "stream is down" alert leaves you guessing who to call. This correlates connection-layer timings, Icecast's live mount inventory, and cross-stream behaviour to name the cause, and keeps a permanent record so patterns are visible over months rather than hours.

![Dashboard Preview](docs/dashboard_preview.png)

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
                │  store.js    ── events.json   (permanent, forever)   │
                │                 samples.json  (7d raw → hourly)      │
                │                          │                           │
                │  server.js   ── Express API + static SPA             │
                └───────────────┬──────────────────────┬───────────────┘
                                │                      │
                                ▼                      ▼
                ┌───────────────────────┐  ┌───────────────────────────┐
                │   Dashboard (live)    │  │  History (permanent)      │
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
- **`store.js`**: Persistence. Splits the permanent event record from rolling telemetry; handles atomic writes, hourly compaction, and legacy migration.
- **`public/index.html` / `app.js`**: Live dashboard.
- **`public/history.html` / `history.js` / `history.css`**: Permanent incident history — heatmap, listener-audience chart, filters, per-event drill-down.
- **`scripts/backfill-audience.js`**: Reporting/repair tool for the `audience` block. **Not normally needed** — `store.load()` backfills automatically at every startup, before `prune()` runs. Use this to preview the numbers (dry-run by default) or to repair after a manual data edit. Safe to re-run; it never overwrites a measured figure.
- **`public/style.css`**: Dark Material Design 3 theme system using CSS variables.
- **`Dockerfile`**: Production build on `node:20-alpine` with `curl` for Coolify health probes.

### Event Model (important)

Notification is decoupled from recording. **Every failed check is recorded permanently**; only some of them email.

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

1. **Listeners cut off** — a headcount. The headline, always.
2. **Listening lost** — listener-hours. The subheadline, always with its explanation.
3. **Where the fault was** — KPFT equipment vs Pacifica server.
4. **Stream downtime** — clock time, for engineers.
5. Everything else — monitoring detail.

**The rule that keeps it readable: a headcount, a clock duration and a person-hours figure
never appear in the same row or the same tile group.** They measure different things, and
formatted alike they invite a reader to reconcile numbers that cannot be compared — which is
exactly how "3h 35m … 100.9 listener-hours" came to read as four days of downtime.

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

#### Where the fault was

`faultSplit` attributes every listener-affecting outage to the equipment that failed, decided
by whether Icecast itself answered at the moment of failure:

| `side` | Means |
|---|---|
| `kpft` | Icecast was **reachable and serving other mounts** — our source encoder or mount dropped |
| `pacifica` | Icecast itself could **not be reached** |
| `unknown` | not enough evidence to attribute |

This is the single most consequential field in the record. On the first production week it read
19h 26m of KPFT encoder dropouts against 3h 46m of Pacifica server trouble — a conclusion no
aggregate downtime figure can produce, and the difference between an engineer looking at the
studio Barix and a pointless conversation with Pacifica.

#### Time off air vs. stream-hours

Two different questions, and only one of them is what "how long were we down" means:

| Figure | Field | Meaning |
|---|---|---|
| **Time off air** | `downtime.wallClockMs` | elapsed time with *at least one* stream down; concurrent outages merged and counted once |
| Stream-hours | `downtime.streamMs` | per-stream durations added together — the figure that reconciles with the uptime percentage |

On the production record these read 19h 52m and 1d 4h for the same period. The gap is one
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

The key distinction it draws: **an Icecast mount returning HTTP 404 means the server is healthy and the source encoder dropped off.** That is a studio problem (check the Barix), not a server problem. Because other Pacifica stations share the host, the engine can also confirm whether a fault is KPFT-specific or server-wide — and `stream_start_iso8601` gives the exact source reconnect moment, yielding a true outage duration independent of the polling interval.

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
SMTP_HOST=mail.hype.net
SMTP_PORT=587
SMTP_USER=paul@hype.net
SMTP_PASS=YourPasswordHere
SMTP_FROM="KPFT Stream Monitor <paul@hype.net>"

# ── Alert Recipients ─────────────────────────────────
ALERT_EMAILS=gm@kpft.org,omaclay@gmail.com
ALERT_CC=paul@hype.net

# ── Dashboard Link in Emails ─────────────────────────
DASHBOARD_URL=https://kpft-icecast.supersoul.top

# ── Monitor & Silence Thresholds ─────────────────────
CHECK_INTERVAL_MS=60000         # Routine check interval (default: 60000ms / 1 min)
FAILURE_THRESHOLD=2             # Consecutive failures before sending server DOWN alert
SILENCE_PROBE_INTERVAL_MS=5000   # Rapid probe interval during silence evaluation (default: 5s)
SILENCE_FAILURE_THRESHOLD=3      # Consecutive silent probes before confirming Dead Air (default: 3)

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
# Events are ALWAYS permanent. This controls only the per-check telemetry
# behind uptime figures: raw samples kept this many days, then compacted into
# hourly summaries kept forever.
SAMPLE_RETENTION_DAYS=7
DATA_DIR=/app/data              # MUST be a persistent volume in production

# ── Diagnostics ──────────────────────────────────────
ICECAST_STATUS_URL=https://streams.pacifica.org:9000/status-json.xsl
SIBLING_MOUNTS=/live_128,/live_64,/HD3,/HD3_128,/HD3_64,/classic_country
```

---

## 🩺 Interpreting the Data

**Uptime and the event log come from different sources.** Uptime percentages and the 24h bars are computed from per-check *samples*; the incident timeline comes from *events*. They are stored separately, so it is possible to restore one without the other and see a reassuring 100% on a day that contained real outages. If uptime looks implausibly clean, check `sampleCount` in `/api/stats`.

**Unconfirmed failures are not noise, they are just not urgent.** A single failed check that self-clears is recorded permanently but never emails — by the time anyone reads an alert it is already over. The value is in the aggregate: if *Connection reset by server* climbs week over week in the Root Causes panel, that is evidence worth taking to Pacifica, and far more persuasive than an anecdote. Note the split: a `probe_error` says more about the path between the monitor and Pacifica than about KPFT's streams, so do not cite it as station downtime.

**Listener-minutes are the honest unit of harm.** `9 outages` and `35 minutes down` both understate a midday failure and overstate a 4am one. Each resolved event freezes an `audience` block — the listener count Icecast reported immediately before the mount vanished, multiplied by the outage length. It is captured at resolution time because it cannot be recovered later: Icecast only reports an audience while the mount exists, and raw samples compact after `SAMPLE_RETENTION_DAYS`. Events proven to have no listener impact are charged **zero**, never their audience.

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
The **permanent** event log, never pruned by age. Each event carries its root-cause diagnosis, connection timings, Icecast state at the time of failure, resolution duration, and the email delivery outcome.

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
delivery, listeners cut off, listening lost, per-stream breakdown, top causes and the two
most notable incidents.

The sentence in `narrative` is composed server-side and used **verbatim** by both the
history page's Overview line and the weekly roundup email, so the dashboard and the inbox
cannot describe the same week differently.

Two counts are deliberately kept apart and must not be conflated:

| Field | Counts |
|---|---|
| `alerts.messages` | emails actually sent — one consolidated message can cover three streams |
| `alerts.eventsAlerted` | events that were covered by an alert |
| `audience.listenersCutOff` | audience summed **per incident** — someone cut off three times counts three times |
| `audience.listenerMinutesLost` | reach × duration; the figure to lead with |

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

   Incident history is retained **permanently** and lives in `/app/data/events.json`. Without a persistent volume, every redeploy silently resets the entire record to zero — the container filesystem does not survive a rebuild. Verify with:

   ```bash
   curl -s https://<your-host>/api/stats?days=1 | jq .storage
   # oldestEvent should predate your last deploy
   ```

   Two files are written there:
   - `events.json` — the permanent incident record (small; ~400 bytes/event)
   - `samples.json` — rolling telemetry, 7 days raw then hourly rollups (~4 MB at 3 streams)

---

## 📄 License
Pacifica Foundation / KPFT Houston — Open Internal Diagnostic Tool.
