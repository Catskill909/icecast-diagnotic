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

**Second baseline, 02:27 UTC 2026-09-13 (10:27 PM ET), after `a1d9d03`** — adds
the other-ports comparison and network owners:

| Server | Stream port | Other ports (healthy) | Route ends in |
|---|---|---|---|
| streams.pacifica.org | 9000: 5/5, 61 ms | **80: 2/2 · 443: 2/2** | CyberCloud Professionals (AS18501), 17 hops |
| streaming.wbai.org | 443: 5/5, 24 ms | 80: 2/2 | Amazon (AS16509), 10 hops |
| streams.kpfa.org | 8443: 5/5, 68 ms | 80: **0/2 (normal — not listening)** · 443: 2/2 | KPFA (AS397715), 11 hops |

Read a future failure against this: for Pacifica, 9000 failing while 80 and 443
still answer means the stream port is being blocked. For KPFA, port 80 is always
closed; only 443 is a meaningful comparison.

## 6. Tools — what the app records by itself

| Tool | When | Where to read it |
|---|---|---|
| Per-minute connection phases per server | every cycle | `GET /api/network?hours=` (admin) |
| Connection phases per stream check | every cycle | samples `tm` |
| Route trace (mtr TCP to stream port) + network test (DNS, status, stream, 5 raw connects, ports 80/443, hop owners, own sockets, verdict) | **Trigger:** the status page stops answering, OR 2+ streams on the server get no answer (1 if it carries one stream) — for 2 cycles in a row; then every 10 min (max 3); daily healthy baseline | Admin → Network test; `GET /api/network-tests`, `GET /api/path-traces` (admin); `networkVerdict`, `networkTestIds`, `pathTraceIds` on incidents |
| Whose feeds dropped (reach report) | when a troubled server recovers | "What the monitor found" on the incident; `GET /api/reach-reports` (admin) |

**Capture gap fixed (2026-09-13, commit below):** capture was triggered only by the
status page. In occurrence 2 the streams got no answer from 22:11:39 but the status
page answered until 22:15:44 — four minutes would have gone unrecorded. Silent
streams now trigger it too (a 404 never does — that is the server answering). The
same test found a second delay: the 10-minute spacing between traces counted the
healthy baseline taken at every startup, so a failure within 10 minutes of a
deploy would not be traced for up to 10 minutes. Spacing now applies between
failure traces only. Test: `test/capture-trigger.test.js`.

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
- [x] **Name the network** where the route stops — hop owners via Team Cymru DNS (live `a1d9d03`, verified 02:27 UTC 09-13)
- [x] **Block or broken route** — stream port compared with ports 80/443 (live, verified; baseline recorded)
- [x] **Whose encoders dropped** — automatic comparison written into the incident when the server answers (live; awaits a real occurrence)
- [x] Show the evidence and the one-sentence verdict on the incident page (live; awaits a real occurrence)
- [x] Capture starts at the first sign (silent streams, not only a silent status page); a startup baseline no longer delays it
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

---

## 9. Raw data — verbatim, as captured

Nothing below is summarised. Paste every future network test here in full, newest
first, with the time and whether the streams were failing at the moment.

### 9a. Network test — 2026-09-12 10:27:09 PM ET (02:27 UTC 09-13) — after `a1d9d03`, all streams UP

Run manually by the owner from Admin → Network test.

```
manual · 9/12/2026, 10:27:09 PM · monitor running 1 min, 7 open connections

streams.pacifica.org:9000 — The route from the monitor to this server is healthy.
Name lookup      68.168.105.107
Status page      answered · 283 ms · DNS 5ms · TCP 61ms · TLS 132ms · TTFB 278ms
Stream           audio received · 407 ms · DNS 11ms · TCP 62ms · TLS 65ms · TTFB 407ms
Raw connections  5 of 5 connected · typical 61 ms
Other ports      port 80: 2/2 · port 443: 2/2
Route            reached the server in 17 hops — JOESD-18501 - CyberCloud Professionals LLC, US (AS18501)

streaming.wbai.org — The route from the monitor to this server is healthy.
Name lookup      3.130.107.227
Status page      answered · 116 ms · DNS 5ms · TCP 25ms · TLS 58ms · TTFB 115ms
Stream           audio received · 379 ms · DNS 7ms · TCP 25ms · TLS 25ms · TTFB 379ms
Raw connections  5 of 5 connected · typical 24 ms
Other ports      port 80: 2/2
Route            reached the server in 10 hops — AMAZON-02 - Amazon.com, Inc., US (AS16509)

streams.kpfa.org:8443 — The route from the monitor to this server is healthy.
Name lookup      64.4.175.5
Status page      answered · 244 ms · DNS 4ms · TCP 72ms · TLS 84ms · TTFB 243ms
Stream           audio received · 374 ms · DNS 47ms · TCP 71ms · TLS 78ms · TTFB 374ms
Raw connections  5 of 5 connected · typical 68 ms
Other ports      port 80: 0/2 · port 443: 2/2
Route            reached the server in 11 hops — KPFA - KPFA, US (AS397715)
```

### 9b. Network test — 2026-09-12 6:40:59 PM ET (22:40 UTC) — after `e138c0a`, all streams UP

Run manually by the owner. First test ever run from the monitor's own host.
(This build had no other-ports check and no network owners yet.)

```
manual · 9/12/2026, 6:40:59 PM · monitor running 1 min, 7 open connections

streams.pacifica.org:9000 — The route from the monitor to this server is healthy.
Name lookup      68.168.105.107
Status page      answered · 282 ms · DNS 9ms · TCP 61ms · TLS 130ms · TTFB 282ms
Stream           audio received · 276 ms · DNS 8ms · TCP 61ms · TLS 63ms · TTFB 276ms
Raw connections  5 of 5 connected · typical 61 ms
Route            reached the server in 17 hops

streaming.wbai.org — The route from the monitor to this server is healthy.
Name lookup      3.130.107.227
Status page      answered · 115 ms · DNS 7ms · TCP 27ms · TLS 52ms · TTFB 114ms
Stream           audio received · 320 ms · DNS 7ms · TCP 30ms · TLS 43ms · TTFB 320ms
Raw connections  5 of 5 connected · typical 26 ms
Route            reached the server in 10 hops

streams.kpfa.org:8443 — The route from the monitor to this server is healthy.
Name lookup      64.4.175.5
Status page      answered · 273 ms · DNS 13ms · TCP 73ms · TLS 106ms · TTFB 273ms
Stream           audio received · 342 ms · DNS 13ms · TCP 67ms · TLS 72ms · TTFB 342ms
Raw connections  5 of 5 connected · typical 68 ms
Route            reached the server in 12 hops
```

### 9c. Live capture DURING occurrence 2 — 2026-09-12 22:19 UTC (6:19 PM ET), streams FAILING from the monitor

From the monitor's `/api/status` (timings of each stream's last probe) and
`/api/diagnostics`, taken from the owner's Mac at the same minute as the Mac probes.

```
SERVER streams.pacifica.org:9000  reachable: false  Status endpoint did not answer within 12000ms  rt: 12005
SERVER streaming.wbai.org         reachable: true   rt: 630
SERVER streams.kpfa.org:8443      reachable: true   rt: 680

kpft-main           down  3  EDEADLINE  ice:false  L:42   {"dns":23,"tcp":4363,"tls":null,"ttfb":null,"total":18003,"resolvedIp":"68.168.105.107"}
kpft-hd2            down  3  EDEADLINE  ice:false  L:9    {"dns":20,"tcp":5311,"tls":null,"ttfb":null,"total":18001,"resolvedIp":"68.168.105.107"}
kpft-hd3            down  3  EDEADLINE  ice:false  L:4    {"dns":19,"tcp":5311,"tls":null,"ttfb":null,"total":18000,"resolvedIp":"68.168.105.107"}
wpfw                down  3  ETIMEDOUT  ice:false  L:23   {"dns":18,"tcp":null,"tls":null,"ttfb":null,"total":15019,"resolvedIp":"68.168.105.107"}
kpfk                down  3  EDEADLINE  ice:false  L:158  {"dns":19,"tcp":2230,"tls":null,"ttfb":null,"total":18000,"resolvedIp":"68.168.105.107"}
wbai-verizon        up    0             ice:true   L:66   {"dns":16,"tcp":26,"tls":25,"ttfb":356,"total":357,"resolvedIp":"3.130.107.227"}
wbai-spectrum       up    0             ice:true   L:0    {"dns":18,"tcp":24,"tls":24,"ttfb":241,"total":242,"resolvedIp":"3.130.107.227"}
wbai-wpfw           up    0             ice:true   L:2    {"dns":10,"tcp":26,"tls":24,"ttfb":472,"total":473,"resolvedIp":"3.130.107.227"}
kpfa                down  3  EDEADLINE  ice:false  L:10   {"dns":11,"tcp":2395,"tls":null,"ttfb":null,"total":18000,"resolvedIp":"68.168.105.107"}
kpfa-kpfa-berkeley  up    0             ice:true   L:182  {"dns":10,"tcp":71,"tls":74,"ttfb":418,"total":642,"resolvedIp":"64.4.175.5"}

From the owner's Mac, same minute:
MAC kpfk_128    http=200 connect=0.318115s tls=0.491312s firstbyte=0.678922s bytes=60000
MAC kpfk        http=200 connect=0.087151s tls=0.268153s firstbyte=0.912411s bytes=60000
MAC live_128    http=200 connect=0.084324s tls=0.263296s firstbyte=0.439272s bytes=60000
MAC wpfw_128    http=404 connect=0.086062s tls=0.274824s firstbyte=0.365100s bytes=119
MAC status-json http=200 firstbyte=0.360015s
```

### 9d. Events at the start of occurrence 2 (monitor's event record)

(Email reasons were cut at 60 characters by the query that listed them.)

```
22:15:44 kpft-main  down outage       open | suppressed — KPFT Main is flapping (3 outages …)
22:15:44 kpft-hd2   down outage       open | suppressed — KPFT HD2 is flapping (3 outages …)
22:15:44 kpft-hd3   down outage       open | EMAILED 22:17:43
22:15:44 wpfw       down outage       open | suppressed — WPFW is flapping (5 outages …)
22:15:44 kpfk       down outage       open | EMAILED 22:17:43
22:15:44 kpfa       down outage       open | no recipients configured for this station
22:14:44 wpfw       up   recovery          | alerts are switched off for station "wpfw"
22:11:39 kpft-hd2   down probe_error  resolved | probe-side failure — Icecast reachable and mount still serving
22:11:39 wpfw       down outage       resolved
22:11:39 kpfk       down probe_error  resolved | probe-side failure — Icecast reachable and mount still serving
22:11:39 kpfa       down probe_error  resolved | probe-side failure — Icecast reachable and mount still serving
```

### 9e. Encoder reconnect record and listeners, read after occurrence 2 (~22:33 UTC)

```
server start: streams.pacifica.org:9000=2026-08-19T17:56:02-0500 | streaming.wbai.org=2025-06-15T03:48:42+0000 | streams.kpfa.org:8443=2026-08-05T07:14:35-0700
  /HD3              listeners 1    source connected since 2026-09-12T17:28:49-0500
  /HD3_128          listeners 5    source connected since 2026-09-12T17:28:49-0500
  /HD3_64           listeners 3    source connected since 2026-09-12T17:28:49-0500
  /classic_country  listeners 2    source connected since 2026-09-12T13:52:21-0500
  /kpfa             listeners 10   source connected since 2026-09-07T11:32:29-0500
  /kpfa_16          listeners 1    source connected since 2026-09-07T11:32:29-0500
  /kpfa_64          listeners 1    source connected since 2026-09-07T11:32:29-0500
  /kpfk             listeners 1    source connected since 2026-09-06T15:44:50-0500
  /kpfk_128         listeners 176  source connected since 2026-09-06T15:44:50-0500
  /kpfk_64          listeners 1    source connected since 2026-09-06T15:44:50-0500
  /live_128         listeners 27   source connected since 2026-09-12T17:27:50-0500
  /live_64          listeners 17   source connected since 2026-09-12T17:27:50-0500
  /padma            listeners 2    source connected since 2026-09-11T10:20:37-0500
  /wbai_128         listeners 10   source connected since 2026-09-05T03:05:14-0500
  /wpfw_128         listeners 74   source connected since 2026-09-12T17:25:21-0500

Listeners per minute around both windows (x = monitor could not check):
kpft-main: 20:45=157 20:46=155 20:47=154 20:48=154 20:49=155 20:50=156 20:51=157 20:52=x 21:06=39 21:07=38 21:08=37 21:09=42 22:05=30 22:06=32 22:07=37 22:08=35 22:09=34 22:10=40 22:11=37 22:28=12 22:29=16 22:30=17 22:31=20 22:32=21
kpft-hd2: 20:45=12 20:46=13 20:47=13 20:48=14 20:49=13 20:50=13 20:51=13 20:52=x 21:06=9 21:07=7 21:08=8 21:09=7 22:05=8 22:06=8 22:07=8 22:08=9 22:09=9 22:10=10 22:11=x 22:28=x 22:29=3 22:30=6 22:31=8 22:32=9
wpfw: 20:45=401 20:46=399 20:47=392 20:48=392 20:49=388 20:50=390 20:51=388 20:52=x 21:06=x 21:07=x 21:08=x 21:09=x 22:05=64 22:06=66 22:07=67 22:08=72 22:09=75 22:10=77 22:11=x 22:28=33 22:29=36 22:30=38 22:31=42 22:32=45
kpfk: 20:45=108 20:46=108 20:47=108 20:48=105 20:49=108 20:50=113 20:51=112 20:52=x 21:06=121 21:07=121 21:08=120 21:09=119 22:05=149 22:06=153 22:07=146 22:08=152 22:09=152 22:10=154 22:11=x 22:28=168 22:29=169 22:30=170 22:31=171 22:32=171
kpfa: 20:45=14 20:46=14 20:47=15 20:48=14 20:49=13 20:50=12 20:51=13 20:52=x 21:06=13 21:07=12 21:08=12 21:09=12 22:05=12 22:06=12 22:07=12 22:08=11 22:09=11 22:10=11 22:11=x 22:28=10 22:29=10 22:30=10 22:31=10 22:32=11
```

### 9f. Network ownership lookups (Team Cymru), 2026-09-12

```
144.126.148.20  → 40021 | 144.126.148.0/22 | US | arin | CONTABO-40021 - Contabo Inc., US
68.168.105.107  → 18501 | 68.168.105.0/24  | US | arin | JOESD-18501 - CyberCloud Professionals LLC, US
216.55.160.12   → 18501 | 216.55.160.0/24  | US | arin | JOESD-18501 - CyberCloud Professionals LLC, US
```

### 9g. Live capture DURING occurrence 1 — 2026-09-12 21:04:55 UTC (5:04 PM ET)

```
kpft-main           down  11  EDEADLINE  icecast:false  host:streams.pacifica.org:9000  tcp3213 tls7252 ttfb10642
kpft-hd2            down  11  EDEADLINE  icecast:false  host:streams.pacifica.org:9000  tcp152 tls14368 ttfb14797
kpft-hd3            down  11  EDEADLINE  icecast:false  host:streams.pacifica.org:9000  tcp5258 tls1019 ttfb6592
wpfw                down  11  HTTP_404   icecast:false  host:streams.pacifica.org:9000  tcp149 tls152 ttfb1646
kpfk                down  11  ETIMEDOUT  icecast:false  host:streams.pacifica.org:9000  tcp150 tls152 ttfb985
wbai-verizon        up    0              icecast:true   host:streaming.wbai.org        tcp26 tls28 ttfb326
wbai-spectrum       up    0              icecast:true   host:streaming.wbai.org        tcp25 tls26 ttfb316
wbai-wpfw           up    0              icecast:true   host:streaming.wbai.org        tcp25 tls26 ttfb382
kpfa                down  11  EDEADLINE  icecast:false  host:streams.pacifica.org:9000  tcp3209 tls152 ttfb4231
kpfa-kpfa-berkeley  up    0              icecast:true   host:streams.kpfa.org:8443     tcp71 tls74 ttfb354

From the Mac, same minute:
https://streams.pacifica.org:9000/kpfk_128 200 connect=0.300754 tls=0.475638 ttfb=0.715300 bytes=100000
https://streams.pacifica.org:9000/live_128 200 connect=0.084558 tls=0.266243 ttfb=0.458179 bytes=100000
MAC status-json 200 ttfb=0.375833 ip=68.168.105.107   (21:05)

/api/diagnostics at 21:05:23 UTC:
streams.pacifica.org:9000  reachable:false  fetchError:"Status endpoint timed out"  responseTime:11323
streaming.wbai.org         reachable:true   Icecast 2.4.4  responseTime:463
streams.kpfa.org:8443      reachable:true   Icecast 2.4.4  responseTime:523

KPFK event evt_1789246365901_kpfk_7 (20:52:45): cause timeout, listenerImpact unknown, scope stream,
timings dns 7 / tcp 9774 / tls 1014 / ttfb 14072 / total 18002, resolvedIp 68.168.105.107,
emailed 20:54:45 to alerts@kpfk.org, paul@rarefunk.com —
"🔴 KPFK Los Angeles Alert: KPFK Los Angeles — DOWN (Connection timeout) · 112 listeners affected"
```

### 9h. Earlier times 4+ Pacifica streams failed in the same minute (from the event record)

```
2026-08-30T04:58:45Z  5 streams  icecast reachable: true   lasted 1m each  cause: connection_reset
2026-09-07T01:29:11Z  6 streams  icecast reachable: true   lasted 1m each  cause: connection_reset
2026-09-12T20:52:45Z  6 streams  icecast reachable: false  lasted 13–14m (WPFW 1h 1m)  causes: icecast_down/timeout/source_disconnected
```

The two earlier ones were one-minute resets with Icecast still answering — a
different, much shorter shape. 2026-09-12 is the first long loss of contact.
