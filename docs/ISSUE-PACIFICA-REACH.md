# OPEN ISSUE — The monitor loses streams.pacifica.org and calls stations down

> **Status: OPEN.** Cause of the network failure not yet identified to a
> network. The app's false alarms are mitigated; the evidence tools are being
> built so the next occurrence names the culprit by itself.
>
> **This is the single tracking file for this issue.** Append every new
> occurrence to the log at the bottom, update "Current understanding", and tick
> the checklist. Do not scatter findings across other docs — link here instead.

---

## 1. The issue in one paragraph

On **2026-09-12**, twice, the monitor (running on a Contabo server) lost its
connection to Pacifica's streaming server `streams.pacifica.org:9000`
(68.168.105.107). While that lasted, the dashboard showed every Pacifica station
as DOWN and emailed KPFT and KPFK. At the same moments **KPFT's and WPFW's
encoders really dropped** (their audiences fell), while **KPFK's and KPFA's
encoders never dropped** and the stations played normally — the owner was
playing them from the dashboard. Nothing like this had happened before in the
record (since 2026-08-04).

## 2. Plain facts that must not be re-derived

1. **The dashboard's play buttons do not go through our server.** They connect
   from the viewer's browser straight to Icecast (`new Audio(url)`,
   `public/app.js`). UP/DOWN comes from the monitor's host at Contabo. "It plays
   for me but the card says down" means the two routes differ.
2. **Each station's status comes from its own probe.** One station failing never
   changes another's status. WPFW's real outage did not "spread" to KPFK.
3. **Our code did not trigger it.** Nothing deployed on 2026-09-12 before 20:52
   UTC touched how the monitor connects (player list UI, docs, sign-in tests).
   The last change to how it talks to Pacifica (per-host admin credentials,
   `c2f4ac3`) was committed 2026-09-11 10:45 ET and ran through the following day
   without an occurrence. And encoders in Houston
   and DC, which never touch our app, failed at the same moments.
4. **Alert emails (dev phase) go only to KPFT and KPFK.** Other stations are
   muted on purpose. The app must still catalog every station's incidents.
5. **Owner's rule:** only the station with the issue is emailed, and only on
   evidence about its own feed. "Can't reach the server" is not evidence.
6. **The fix is never "ask Pacifica / ask Contabo".** The app gathers its own
   evidence.

## 3. The two occurrences

Times UTC (ET = UTC−4, Central = UTC−5).

### 3a. 20:52:45 → 21:06:45 (4:52–5:06 PM ET)

- All six Pacifica channels failed in one cycle; Pacifica's status page
  unreachable from the monitor. WBAI's and KPFA Berkeley's servers normal.
- Monitor's connection timings to 68.168.105.107: TCP connect 150 ms to 9,774 ms,
  TLS up to 14,368 ms, stalls to the 18 s deadline. (Normal at 22:40: TCP 61 ms.)
- Emails: KPFT (3 streams DOWN, "174 listeners affected"), KPFK ("112 listeners
  affected"); both again on recovery.
- Icecast `server_start` unchanged (2026-08-19) — the Icecast process did not
  restart.

| Channel | Listeners before → after | Source (encoder) | Verdict |
|---|---|---|---|
| KPFT Main | 157 → 39 | reconnected 21:03:16 | real |
| KPFT HD2 | 13 → 7 | reconnected 21:03:03 | real |
| KPFT HD3 | 4 → 2 | — | real |
| WPFW | 388 → 0 | dropped, did not return until later | real |
| KPFK | 112 → 121 | connected since 2026-09-06 | **false** |
| KPFA (Pacifica) | 13 → 13 | connected since 2026-09-07 | **false** |

### 3b. 22:11:39 → 22:27 (6:11–6:27 PM ET)

- 22:11:39 checks began failing (Icecast still answering some); from 22:15:44
  no contact. Recovered 22:27:14 (KPFK first).
- Captured live at 22:19 UTC, same minute:

| | From the monitor (Contabo 144.126.148.20) | From the owner's Mac |
|---|---|---|
| KPFK stream | TCP 2,230 ms, TLS never completed, 18 s deadline | 200, connect 0.32 s, audio |
| KPFT Main | TCP 4,363 ms, deadline | 200, connect 0.08 s |
| WPFW | TCP never connected, 15 s timeout | 404 (real: encoder gone) |
| Status page | no answer in 12 s | answered 0.36 s |
| WBAI / KPFA Berkeley | TCP 24–71 ms, normal | — |

- Emails at 22:17:43 to KPFK and KPFT (HD3) — both false.
- Monitor container restarts in the window (deploys): 22:12:43, 22:24:13, 22:28:13.

| Channel | Listeners before → after | Source (encoder) | Verdict |
|---|---|---|---|
| KPFT Main | 37 → 12 | reconnected **22:27:50** | real |
| KPFT HD2 | 10 → 3 | reconnected **22:28:49** | real |
| WPFW | 77 → 33 | reconnected **22:25:21** | real |
| KPFK | 154 → 168 | connected since 2026-09-06 | **false** |
| KPFA (Pacifica) | 11 → 10 | connected since 2026-09-07 | **false** |

## 4. Current understanding

**Pacifica's server had a partial network failure, twice.** Connections from
some networks failed; from others they did not. In both windows the same three
failed — our monitor (Contabo), KPFT's encoder (Houston), WPFW's encoder (DC) —
and the same ones held — KPFK's and KPFA's encoders, KPFK's listeners, the
owner's browser. In window 2 the failing three came back within the same three
minutes (22:25–22:28). Three unrelated networks failing and recovering together
puts the fault on **Pacifica's side of the internet**: its host (CyberCloud
Professionals, whose block is 68.168.104.0/23) or the network just in front of it.

**Not yet known, and the point of the tools below:**
- Which network hop failed, and whose network it is in.
- Whether it was a block (firewall / rate limit / DDoS filter) or a broken or
  congested route.
- Why these particular networks and not others.

Hypotheses still open (none confirmed):
- Upstream route flap into CyberCloud affecting some transit paths. Supporting:
  the monitor's normal connect time changed from ~150 ms (before) to ~61 ms
  (after), suggesting a different route afterwards.
- A filter/rate limit on Pacifica's side affecting certain source ranges.
- Coincidence with the monitor's own restarts in window 2 (22:12 restart, loss
  from 22:15) — weak: window 1 had no restart and encoders unrelated to us failed.

## 5. What the app got wrong, and what shipped (2026-09-12)

| Commit | Change | State |
|---|---|---|
| `314f4a5` | Open outages count to now; restarts resume them; correlation per server; muted-station storm miscount; email wording | live, audited 21:44 |
| `6195a82` | Server unreachable → streams UNCONFIRMED (grey "Can't reach server"), no station email, settle per station when it answers | live; **did not engage** (see next) |
| `e737dd8` | That hold also applies to a server unreachable since the deploy (history proves it has a status page) | live; not yet exercised by a real occurrence |
| `e138c0a` | Evidence: per-minute connection timings per server and stream; automatic route traces (mtr TCP) + network test when a server stops answering; admin **Network test** button; second-location witness (inert) | live; owner ran the test 22:40 — all healthy |

**Healthy baseline, 22:40 UTC, from the monitor's host:**

| Server | Status page | Stream | Raw connects | Route |
|---|---|---|---|---|
| streams.pacifica.org:9000 | 282 ms (TCP 61, TLS 130) | 276 ms | 5/5, 61 ms | 17 hops, reached |
| streaming.wbai.org | 115 ms (TCP 27) | 320 ms | 5/5, 26 ms | 10 hops, reached |
| streams.kpfa.org:8443 | 273 ms (TCP 73) | 342 ms | 5/5, 68 ms | 12 hops, reached |

Monitor process at 1 min uptime: 7 open connections.

## 6. Tools — what the app records by itself

| Tool | When | Where to read it |
|---|---|---|
| Per-minute connection phases per server | every cycle | `GET /api/network?hours=` (admin) |
| Connection phases per stream check | every cycle | samples `tm` |
| Route trace (mtr TCP to stream port) | 2 missed checks, then every 10 min (max 3); daily baseline | `GET /api/path-traces` (admin); `pathTraceIds` on incidents |
| Network test (DNS, status, stream, 5 raw connects, trace, own sockets, verdict) | automatically when a server stops answering; on demand | Admin → Network test; `GET /api/network-tests`; `networkTestIds` on incidents |

### Networks involved (looked up 2026-09-12)

| Address | Network |
|---|---|
| 144.126.148.20 — the monitor | AS40021 Contabo Inc. |
| 68.168.105.107 — streams.pacifica.org | AS18501 CyberCloud Professionals LLC |
| 216.55.160.x — last routers before Pacifica (seen from the owner's Mac) | AS18501 CyberCloud Professionals LLC |

### How to read the next occurrence

Open the incident on the dashboard or History page. The **What the monitor found**
block holds two sentences, both written automatically:

1. **Network test from the monitor's server** — one of:
   - *ACTIVELY REFUSING* → something on the server's side rejects the monitor.
   - *DOES answer on port 80/443 … BLOCKING the stream port* → a filter on the
     server's side blocks the stream port for the monitor.
   - *route dies … INSIDE THE SERVER'S OWN NETWORK* (CyberCloud) → Pacifica's side.
   - *INSIDE THE MONITOR'S OWN PROVIDER* (Contabo) → our side.
   - *in a network BETWEEN* → a transit network, named.
   - *getting there but being lost or delayed* → congestion or rate limiting near the server.
   - *the monitor itself holds N open connections* → our app.
2. **What every feed on the server did** — *partial* (some encoders dropped with
   the monitor, others held: the server's side), *monitor_only* (every feed held:
   our route), *all_dropped* (the server dropped everything).

Admin → **Network test** shows the full detail of every saved test, including the
automatic ones. Record both sentences in the occurrence log below.

## 7. Checklist — until this is solved

- [x] Stop calling a station down when the monitor can't reach its server
- [x] Record connection timings, route traces and network tests from the monitor's own host
- [x] Capture a healthy baseline (22:40 UTC)
- [x] **Name the network** where the route stops — hop owners via Team Cymru DNS (built, not yet deployed)
- [x] **Block or broken route** — stream port compared with ports 80/443 on the same server (built, not yet deployed)
- [x] **Whose encoders dropped** — automatic comparison written into the incident when the server answers (built, not yet deployed)
- [x] Show the evidence and the one-sentence verdict on the incident page (built, not yet deployed)
- [ ] Browser second opinion (logged-in dashboard verifies a stream from the viewer's route)
- [x] Test: one station's failure never changes another station's status
- [ ] Verify the grey "can't reach" hold on a real occurrence
- [ ] Next occurrence: read the automatic evidence and record the culprit here
- [ ] Close this issue

## 8. Occurrence log

Append one entry per occurrence: times, which connections failed and held (from
the automatic encoder comparison), the network test verdict, the route trace's
last hop and owner, and what the app showed and emailed.

| # | Date (UTC) | Window | Failed | Held | Verdict / last hop | App behaviour |
|---|---|---|---|---|---|---|
| 1 | 2026-09-12 | 20:52–21:06 | monitor, KPFT enc, WPFW enc | KPFK enc, KPFA enc | not captured (tools not yet built) | DOWN + emails to KPFT, KPFK |
| 2 | 2026-09-12 | 22:11–22:27 | monitor, KPFT enc, WPFW enc | KPFK enc, KPFA enc | not captured (tools not yet built) | DOWN + emails to KPFT, KPFK (hold fix did not engage) |
