# 📡 KPFT Icecast Stream Monitor & Diagnostic Tool

A modern, high-performance, dark Material Design web application for monitoring KPFT (Pacifica Foundation) Icecast live streams. Features adaptive talk-show friendly silence verification (rapid 5s re-verification probes with instant audio reset to eliminate false alarms during speech pauses), listener statistics, response time metrics, and email alerts.

![Dashboard Preview](docs/dashboard_preview.png)

---

## 🎯 Architecture Overview

```
                      ┌──────────────────────────────────────────────────┐
                      │          Icecast Server (pacifica.org)           │
                      │  - Streams: /live_128, /HD3_128, /classic_country │
                      │  - Stats API: /status-json.xsl                   │
                      └────────────────────────┬─────────────────────────┘
                                               │
                                               ▼
                      ┌──────────────────────────────────────────────────┐
                      │                Docker Container                  │
                      │                                                  │
                      │  ┌──────────────────────┐  ┌──────────────────┐  │
                      │  │ Health & Stats Worker│  │ Silence Analyzer │  │
                      │  │ (Listeners, Metadata)│  │ (RMS Amplitude)  │  │
                      │  └──────────┬───────────┘  └────────┬─────────┘  │
                      │             │                       │            │
                      │             ▼                       ▼            │
                      │  ┌─────────────────────────────────────────────┐ │
                      │  │       In-Memory State + 24h JSON Cache      │ │
                      │  └──────────────────────┬──────────────────────┘ │
                      │                         │                        │
                      │                         ▼                        │
                      │  ┌─────────────────────────────────────────────┐ │
                      │  │          Express API & Static SPA           │ │
                      │  └─────────────────────────────────────────────┘ │
                      └─────────────────────────┬────────────────────────┘
                                                │
                                                ▼
                      ┌──────────────────────────────────────────────────┐
                      │            Dark Material 3 SPA (Browser)         │
                      │  - HTML5 Live Audio Preview Player               │
                      │  - Real-time Listener Badges & Metadata          │
                      │  - 24-Hour Uptime Bars & Incident Timeline       │
                      └──────────────────────────────────────────────────┘
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
- **`public/history.html` / `history.js` / `history.css`**: Permanent incident history — heatmap, filters, per-event drill-down.
- **`public/style.css`**: Dark Material Design 3 theme system using CSS variables.
- **`Dockerfile`**: Production build on `node:20-alpine` with `curl` for Coolify health probes.

### Event Model (important)

Notification is decoupled from recording. **Every failed check is recorded permanently**; only some of them email.

An *episode* runs from a stream's first failed check to its recovery. Within one episode:

| Point | Recorded | Emails |
|---|---|---|
| Failure #1 | event, severity `blip` | no — unless it hits *every* stream at once (server-level) |
| Failure #`FAILURE_THRESHOLD` | same event promoted to `outage` | yes |
| Recovery | event resolved with true duration | yes, if an alert was sent |

This fixes the prior behaviour where an isolated failed check painted a red segment on the uptime bar but produced no incident and no email. Those now appear as `blip` events carrying an explicit reason why no alert was sent.

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
```

---

## 📡 API Endpoints

### `GET /api/status`
Returns real-time status of all monitored streams, including listener counts, response times, bitrate, now playing metadata, and error details.

### `GET /api/history`
Returns the rolling 24-hour check history per stream plus the last 24h of events. Kept for dashboard back-compatibility — use `/api/events` for the full record.

### `GET /api/events`
The **permanent** event log, never pruned by age. Each event carries its root-cause diagnosis, connection timings, Icecast state at the time of failure, resolution duration, and the email delivery outcome.

Query params: `days`, `since`, `until`, `streamId`, `type`, `severity` (`outage`/`blip`/`dead_air`/`recovery`), `cause`, `scope` (`stream`/`station`/`server`), `emailed` (`true`/`false`), `limit`, `offset`, `order`.

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
