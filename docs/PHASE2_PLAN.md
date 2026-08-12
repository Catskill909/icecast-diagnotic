# KPFT Icecast Diagnostic — Phase 2 Planning & Audit Document

> **Status: archived proposal — not a current specification.**
> The major Phase 2 capabilities shipped, but some proposed details changed or
> were not implemented. The system has also gained root-cause diagnosis,
> long-term incident retention, listener-impact reporting, weekly roundups, and
> email delivery tracking, none of which are fully described here. For current
> behaviour see [`../README.md`](../README.md), and for the diagnosis engine see
> [`DIAGNOSTICS.md`](DIAGNOSTICS.md).

This document outlines the technical audit and implementation plan for Phase 2 enhancements to the KPFT Icecast Stream Monitor.

---

## 1. Audit of Current Capabilities vs. Phase 2 Features

| Feature | Current State | Phase 2 Proposed State |
|---------|---------------|------------------------|
| **Stream Health Check** | HTTP 200 + Content-Type test | Includes **Silence / Dead Air RMS analysis** |
| **Server Metrics** | Response time (ms), 24h uptime % | **Live listener counts, peak listeners, show titles & bitrates** from `/status-json.xsl` |
| **Dashboard UI** | Status cards, 24h uptime bar, incident log | **Embedded Live Audio Player**, listener badges, Now Playing ticker |
| **Alerting** | HTTP 200 down / recovery alerts | Adds **"Dead Air / Silence"** alerts (e.g. HTTP 200 but no audio output) |

---

## 2. Technical Architecture for Phase 2

```
                       ┌──────────────────────────────────────────────────┐
                       │           Icecast Server (pacifica.org)          │
                       │  - Audio Stream (/live_128, etc.)                 │
                       │  - Stats JSON (/status-json.xsl)                 │
                       └────────────────────────┬─────────────────────────┘
                                                │
                                                ▼
                       ┌──────────────────────────────────────────────────┐
                       │               Node.js Monitor Worker             │
                       │                                                  │
                       │  ┌──────────────────────┐  ┌──────────────────┐  │
                       │  │ HTTP & Stats Poller   │  │ Audio Analyzer   │  │
                       │  │ (Listeners, Metadata)│  │ (Silence Check)  │  │
                       │  └──────────┬───────────┘  └────────┬─────────┘  │
                       └─────────────┼───────────────────────┼────────────┘
                                     │                       │
                                     ▼                       ▼
                       ┌──────────────────────────────────────────────────┐
                       │       In-Memory State + 24h JSON Store           │
                       └────────────────────────┬─────────────────────────┘
                                                │
                                                ▼
                       ┌──────────────────────────────────────────────────┐
                       │           Express API & Dark SPA UI              │
                       │  - HTML5 Audio Player per card                   │
                       │  - Listener count badges & peak metrics          │
                       │  - Now Playing track / show ticker               │
                       │  - Silence alert banners & notifications         │
                       └──────────────────────────────────────────────────┘
```

---

## 3. Detailed Feature Specifications

### Feature A: Icecast Listener Stats & Now Playing Metadata
* **Data Source**: `https://streams.pacifica.org:9000/status-json.xsl`
* **Metrics Extracted**:
  - `listeners`: Current active listener count (e.g., KPFT Main currently has ~138 listeners).
  - `listener_peak`: Historical peak listeners.
  - `title` / `server_name` / `server_description`: Show or source encoder metadata.
  - `bitrate`: Broadcast bitrate (e.g. 128 kbps).
  - `stream_start_iso8601`: Encoder start timestamp (calculates source uptime).
* **UI Integration**:
  - Listener count badge on each card (`🎧 138 listening`).
  - Bitrate badge (`128 kbps MP3`).
  - Now Playing marquee / info bar on cards.

---

### Feature B: Dead Air / Silence Detection (Audio Volume Check)
* **Mechanism**:
  - When performing stream checks, download a small buffer (e.g. 8KB of audio frames).
  - Parse audio frame chunk to compute Root Mean Square (RMS) signal amplitude.
  - If amplitude remains below `-50 dBFS` (silence) for 3 consecutive checks (3 minutes), trigger a **"DEAD AIR DETECTED"** alert.
* **Alerting**:
  - Distinct email subject: `🔇 KPFT Alert: Dead Air / Silence Detected on KPFT Main`.
  - Actionable troubleshooting steps specifically for encoder audio input failure.

---

### Feature C: In-Dashboard Live Audio Preview Player
* **UI Component**:
  - Sleek, custom-styled HTML5 audio control built into each stream card.
  - Play/Pause toggle with animated equalizer visualizer bars when playing.
  - Volume slider and direct stream URL copy button.
  - Automatic stream reconnection on network drop.

---

## 4. Proposed File Changes

### Backend

#### [MODIFY] [`monitor.js`](../monitor.js)
- Integrate `/status-json.xsl` fetch during check cycle.
- Add audio buffer chunk analyzer for silence detection (`checkAudioSilence`).
- Store `listeners`, `listener_peak`, `title`, and `bitrate` in `streamStatus`.
- Trigger `sendAlert` for `'silence'` state transitions.

#### [MODIFY] [`server.js`](../server.js)
- Expose new stats fields in `/api/status`.

---

### Frontend & UI

#### [MODIFY] [`public/index.html`](../public/index.html)
- Add total network listeners card to Summary Bar.
- Add HTML5 `<audio>` container template for stream cards.

#### [MODIFY] [`public/style.css`](../public/style.css)
- Styles for live audio player widget, play button, animated sound waves visualizer.
- Badge styles for listeners, bitrate, and dead air status.

#### [MODIFY] [`public/app.js`](../public/app.js)
- Render listener counts, bitrate, and show metadata.
- Implement HTML5 audio play/pause state handling for preview player.

---

## 5. Verification Plan

### Automated & API Tests
```bash
# Verify status API returns listener stats and metadata
curl -s https://kpft-icecast.supersoul.top/api/status | jq .

# This historical plan predates an automated test suite. Validate current JS syntax:
node --check diagnose.js
```

### Manual Verification
- Test audio preview player on desktop and mobile browsers.
- Confirm live listener count updates match `/status-json.xsl`.
- Verify silence detection triggers alert when mock stream sends empty PCM/MP3 buffer.
