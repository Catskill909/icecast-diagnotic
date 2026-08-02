# 📡 KPFT Icecast Stream Monitor & Diagnostic Tool

A modern, high-performance, dark Material Design web application for monitoring KPFT (Pacifica Foundation) Icecast live streams. Provides real-time health checks, dead air (silence) detection, listener statistics, response time metrics, and immediate email alert notifications.

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
- **`server.js`**: Express server entrypoint. Serves static files from `public/` and API endpoints (`/api/status`, `/api/history`, `/api/config`, `/api/test-alert`, `/health`).
- **`monitor.js`**: Core diagnostic engine. Handles HTTP checks, `/status-json.xsl` parsing, audio silence detection, state transitions, and Nodemailer email alerts.
- **`public/index.html`**: Single Page Application shell.
- **`public/app.js`**: Frontend app controller. Handles API polling every 10s, HTML5 audio preview player, rendering cards, 24h uptime bars, and incident logs.
- **`public/style.css`**: Dark Material Design 3 theme system using HSL CSS variables, glassmorphism, glowing status dots, and micro-animations.
- **`Dockerfile`**: Production Docker build based on `node:20-alpine` with `curl` installed for Coolify health probes.

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

# ── Monitor Thresholds ───────────────────────────────
CHECK_INTERVAL_MS=60000     # Time between checks (default: 60000ms / 1 min)
FAILURE_THRESHOLD=2         # Consecutive failures before sending DOWN alert
```

---

## 📡 API Endpoints

### `GET /api/status`
Returns real-time status of all monitored streams, including listener counts, response times, bitrate, now playing metadata, and error details.

### `GET /api/history`
Returns rolling 24-hour check history array per stream and incident log array.

### `GET /api/config`
Returns public monitor settings (check interval, recipient counts, SMTP status).

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
5. **Persistent Storage**: Mount container path `/app/data` to persist 24-hour history across container restarts.

---

## 📄 License
Pacifica Foundation / KPFT Houston — Open Internal Diagnostic Tool.
