# Handoff — Icecast Monitor

> **Purpose.** Everything a new session, a new developer, or another model needs
> to pick this up without reading the conversation it came from. Written
> 2026-08-27, current as of commit `91114be`.
>
> Read this first, then [`README.md`](README.md) for behaviour,
> [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) for the classifier, and
> [`icecast-app-future-dev.md`](icecast-app-future-dev.md) for where it is going.

---

## 0. Start here

If you are a new session or a different model picking this up cold, this is the
shortest path to being useful.

**Orient yourself (2 minutes).**

```bash
npm test                                   # 168 tests, all should pass
curl -s https://kpft-icecast.supersoul.top/api/stations | jq   # what it monitors
curl -s https://kpft-icecast.supersoul.top/api/status   | jq   # how it is doing
```

**Read, in this order.** §1 (the one idea), §3 (the data flow), §8 (the traps).
Those three are what stop you breaking something quietly. Everything else can be
read when you need it.

**The five things most likely to catch you out**, all of which fail *silently*:

| | |
|---|---|
| Alerting on probe failure | Reintroducing it undoes the product. §1 |
| A new aggregate that isn't station-scoped | Reports one station's outages as another's. §8 |
| Renaming a channel id | Orphans its history rather than moving it. §8 |
| Adding a module without updating the Dockerfile | Container dies on startup. CI catches it |
| Assuming a push deployed | Deploys are manual, always |

**How work gets shipped.** Commit, push, then *tell the operator to deploy* — a
human clicks deploy in Coolify and the build takes 1–5 minutes. Verify against
production afterwards, and check `oldestEvent` is still `2026-08-04T17:52:53.123Z`
to prove the data volume survived.

**What this session's operator values**, learned the hard way: no loose ends left
as asides, corrections stated plainly rather than buried, and claims backed by a
measurement rather than an inference. If you find yourself writing "worth doing
later", either do it or record it somewhere durable — do not leave it in prose.

---

## 1. What this is, and the one idea behind it

A monitor for Icecast audio streams, live at `https://kpft-icecast.supersoul.top`.
It began watching one station (KPFT Houston, a Pacifica Foundation station) and
now watches three, added through its own admin panel.

**The single idea that makes it different from every uptime monitor: it
distinguishes "our probe failed" from "listeners actually lost audio," and only
the second one emails anyone.**

Icecast is the witness. When a stream probe fails, the monitor asks the Icecast
server whether the mount is still there:

| Icecast says | Verdict | Emails? |
|---|---|---|
| Mount is **gone** | `confirmed` — every connected player was dropped | **yes** |
| Mount is **fine** | `none` — our probe broke, nobody noticed | **no** |
| Couldn't reach Icecast | `unknown` — cannot be cleared | **yes** |

This came from production data, and it is the thing to protect. Of 21 alerts
under the old alert-on-any-failure rules, 12 were 60-second probe resets in which
no listener was dropped — and they trained the recipients to ignore the alerts
that mattered. **Any change that reintroduces alerting on probe failure is a
regression, however green the tests are.**

---

## 2. Current state

- **Live and healthy.** 3 stations (KPFT Houston, WPFW Washington DC, KPFK Los
  Angeles), 5 channels, 1 Icecast host, ~456 events retained since 2026-08-04.
- **All three stations share one Icecast host**, which is the whole affiliate
  economics: one snapshot fetch per cycle serves all of them.
- **233 tests**, `npm test`, Node's built-in runner, no test framework dependency.
- **Dependencies: express, nodemailer 9, dotenv.** That is the whole list, and it
  is deliberate. Crypto, testing and HTTP are all Node built-ins. Adding a
  dependency should require an argument.
- **Deploys are MANUAL.** `git push` ships nothing. A human clicks deploy in
  Coolify. Build takes 1–5 minutes.

---

## 3. The data flow — read this before changing anything

This is the part that is easy to get wrong, because a change in the middle
silently alters what lands in someone's inbox.

```
 every 60s ─┬─→ probeStream(channel)        one HTTP request per CHANNEL
            │      ↓ timings, status, 8KB audio sample → RMS → dead-air?
            │
            └─→ fetchIcecastSnapshot()      ONE request per HOST, retried 3x
                   ↓ full mount inventory for every station on that server
                   ↓
              classify({stream, result, snapshot, prevSnapshot, cycle})
                   ↓ cause + scope + listenerImpact   ← THE ALERT GATE
                   ↓
          ┌────────┴────────┐
          ↓                 ↓
   store.addEvent()   dispatchNotifications()
   (ALWAYS records)   (emails only if warrantsAlert())
          ↓
   store.addSample()  → 7 days raw → prune() → hourly rollups → kept forever
```

### Five things that will bite you

1. **Recording and notifying are decoupled — on purpose.** Every failure enters
   the permanent record; only some earn an email. Do not "fix" a silent event by
   making it email.

2. **A channel is not a mount.** Icecast publishes each bitrate variant as its
   own mount, so KPFT Main is `/live_128` *and* `/live_64`. Listener counts are
   summed across a channel's `mounts` list. Reading the probed mount alone
   reported 57 of 88 listeners — a third of the audience invisible.

   One mount per channel is *probed every cycle*, so one problem still produces
   one alert, not three. The other variants are probed every `VARIANT_PROBE_EVERY`
   cycles, which is the only way to catch a mount Icecast still lists but is not
   serving. A variant failing alone is recorded as a `degraded` event — a real
   fault on a channel that kept playing.

3. **A degradation is not downtime.** `degraded` is the first event type that is
   neither a recovery nor a channel failure, and every "what went wrong" total in
   the system was written assuming those were the only two. Anything that counts
   failures, downtime, uptime or lost listening MUST filter through
   `store.isFailureEvent()`. Four separate call sites embedded the old assumption
   and each one turned a healthy channel's degradation into hours of fabricated
   off-air time.

4. **Our probes are counted as listeners.** Icecast counts every connection,
   including ours — measured: one connection took `/kpfk` from 1 listener to 2.
   The Icecast snapshot is therefore fetched BEFORE any probe opens a connection.
   Never restore the parallel `Promise.all`: it saves ~400 ms in a 60-second cycle
   and puts our own probes inside the audience figures we then store forever.

5. **Stream ids are load-bearing.** Every sample, rollup and event is keyed by
   them. `kpft-main`, `kpft-hd2`, `kpft-hd3` must not change or history detaches
   silently — the data does not disappear, it just stops being found.

6. **Hosts are a global pool, not a property of a station.** Five Pacifica
   stations share one Icecast server; ~28 affiliates share another. One snapshot
   fetch per *host* serves every station on it. A host-per-station model would
   refetch the same server 33 times a minute.

7. **Audience figures are frozen at recovery, not computed later.** Icecast only
   reports listeners while the mount exists, and raw samples compact after 7
   days. `getAudienceContext()` captures the pre-failure count at resolution time
   and writes it onto the event. Recomputing later is not possible.

---

## 4. Files

| File | Lines | What it owns |
|---|---|---|
| `store.js` | 1916 | Persistence, retention, audience model, rollups, **station config** |
| `monitor.js` | 2355 | Check cycle, episode state, email composition, weekly roundup |
| `diagnose.js` | 1079 | Probe, Icecast snapshot, **the classifier and the alert gate** |
| `server.js` | 592 | HTTP API |
| `auth.js` | ~290 | Admin session gate: scrypt, signed cookie, rate limiting |
| `redact.js` | ~130 | **Public projections.** What anonymous callers may see |
| `safe-url.js` | ~150 | **SSRF guard** for fetching user-supplied URLs |
| `discover.js` | ~240 | Station discovery: mount → channel grouping, validation |
| `public/app.js` | 694 | Dashboard |
| `public/history.js` | 1530 | History page, station picker, charts |
| `public/listeners.js` | ~420 | **Audience page**: rendering only — ATH, charts, tables, CSV export |
| `public/audience-stats.js` | ~190 | **Audience arithmetic**, deliberately separate so Node can test it. Loads as `window.AudienceStats` in the browser and `require()`s in tests |
| `public/admin.js` | 363 | Admin panel: add, edit, remove stations |
| `public/guide.js` | 230 | In-app guide (content lives here as data) |
| `public/login.js` | ~90 | Two-step sign-in |

No framework, no build step. Every page loads plain files.

Data lives in `DATA_DIR` (`/app/data` in production, **must be a persistent
volume**): `events.json` (permanent, plus config) and `samples.json` (rolling).

---

## 5. What changed on 2026-08-27, and why

Roughly thirty commits over one long session. The reasoning matters more than the
diffs; the table below covers the ones that changed how the system behaves.

| Commit | Change | Why |
|---|---|---|
| `b985fd9` | Channel audience summing | Dashboard showed 57 of 88 real listeners |
| `b985fd9` | Retry the Icecast status fetch | 141 of 443 events (32%) were `unknown` and alerted; 131 of 170 fetch failures were one-second socket hang-ups |
| `b985fd9` | Tolerant JSON parse | Icecast 2.4.x writes a bare `-` for empty metadata; a strict parse threw and was reported as "server unreachable", which silently disables the alert gate |
| `b578db0` | Config normalisation keeps unknown fields | A whitelist silently dropped `mounts` |
| `81fbd54` | Station config moved into the store | An admin panel must change settings without a redeploy |
| `e7c9a6e` | Admin authentication | `/api/test-alert` sent mail with **no credential at all** |
| `9657c42` | `auth.js` added to the Dockerfile | The image would have crashed on startup |
| `16c21cf` | Live configuration reload | A station added through the panel had to be monitored without a redeploy |
| `2fff761` | Station discovery | Paste one URL, get the channels back — the reason setup is 30 seconds rather than a support call |
| `44f6528` | Add-station endpoint and admin page | Also guarded overlapping check cycles, which would have corrupted uptime at 33 channels |
| `7727181` | Station scoping | Adding WPFW made KPFT's uptime silently wrong; every aggregate now takes a station |
| `d284ae3` | Heatmap and root causes scoped | The first scoping pass missed two panels, found from a screenshot |
| `ef83256` | Edit and remove stations | Channel ids immutable; history retained on removal |
| `bb22efa` | Station in the page title and URL | A remembered picker choice meant reading another station's numbers without noticing |

### Corrections worth inheriting

Several claims made during that work were wrong and were retracted. They are
marked in the scope document, but to save anyone re-deriving them:

- **SQLite is not needed *yet*.** An earlier draft called it "the highest-leverage
  refactor" for Phase 0. Measured: Phase 1 is 28 MB on disk and a 54 ms
  serialisation pause per minute. Flat JSON is fine well past five stations.
  Revisit at ~50 mounts **or when per-listener analytics begins, whichever comes
  first** — that is ~360,000 rows a day against ~7,000 today, and it should be
  done before collection starts rather than after (§3.5 of the scope doc).
- **Storage volume is a non-issue.** 5.8 MB today, growing 63 KB/day, ~229 MB
  after ten years. The write *amplification* (rewriting whole files every 60 s)
  is inefficient but harmless — 97 KB/s averaged.
- **The invalid-JSON bug never affected KPFT.** Zero of 443 production events.
  Real, and blocking for affiliates; not the emergency it was first called.
- **Auto-deploy does not exist.** Deploys are manual, always.

---

## 5b. What changed on 2026-08-28: per-mount health

The channel/mount distinction had been half-built. Listener counts were summed
across a channel's mounts, but nothing watched the mounts themselves — so a
single bitrate variant could stop serving and the dashboard would keep reading
ONLINE while that variant's listeners sat in silence. On this host that is not a
rounding error: `/live_64` regularly carries a third of KPFT Main's audience
(measured live at 33 of 86).

| Change | Why |
|---|---|
| `degraded` event type, one per episode | A variant failing alone is a real fault on a channel that never stopped playing. It had no way to be recorded |
| Two failure reasons: `missing` and `stalled` | Icecast dropping a mount and Icecast listing a mount it will not serve need different evidence and different fixes |
| Non-primary mounts probed every `VARIANT_PROBE_EVERY` cycles | The inventory can see a missing mount for free; only a probe can see a listed one that serves nothing |
| **Snapshot fetched before probes, not alongside them** | Icecast counts our probes as listeners. Measured: one connection took `/kpfk` from 1 to 2. The old `Promise.all` put our own probes inside the audience figures we stored |
| Samples carry `mountListeners`, `variantsPresent`, `variantsTotal` | The summed count can hold steady while one variant's audience collapses inside it. This is the only per-mount history there is, and raw samples expire |
| `store.isFailureEvent()` | A degradation is not downtime, and every failure total had to learn the difference |
| Mount chips on the dashboard card | The card showed one URL — the probed mount — and never said so. Now every mount is listed, with its own listener count and the failing one marked |
| `byMount` in the listener series | Per-mount audience history. Only reaches back `SAMPLE_RETENTION_DAYS` — hourly rollups compact the breakdown away, and the UI must say so rather than drawing a short line beside a long one |
| **Audience page** (`listeners.html`) | Audience is a different question, for a different reader, than "what went wrong". Station-scoped like the history page, with the per-mount split that every other figure sums away, plus CSV export |
| `getListeners()` scoped by station | It computed its series from the scoped set but returned the FULL stream list beside it. The chart filtered on which ids had a series, so nothing looked wrong — and the new page reads that list directly |
| **True concurrent peak** | The page reported the SUM of each channel's separate high-water mark — a total the station never reached at any one moment. Measured against production: it said 212 where the real simultaneous peak was 179, an 18% overstatement. Now computed from the channels summed per bucket, and carries the timestamp, because a peak with no "when" is trivia |
| Listener figures the page lacked | Quietest moment (the floor the station holds), "now vs typical for this hour" from the hour profile, and a day-by-day table of average / peak / low / hours |
| **ATH against the royalty allowance** | Aggregate Tuning Hours is what a US noncommercial webcaster's SoundExchange rate is computed from — the fee covers each channel's first 159,140 per month. `getListeningDelivered()` had computed the listener-minutes since day one and surfaced them nowhere. KPFT Main runs ≈39,100/month, ≈25% of the allowance |
| Degraded channels email when sustained AND costing listeners | A variant dead for half an hour with an audience on it is a real loss nobody would find out about. `DEGRADED_ALERT_AFTER_MS`, default 30 min, one message per episode plus an all-clear. The mail says DEGRADED, never DOWN |

### Corrections worth inheriting

- **The variant counts were never in samples.** `icecast-app-future-dev.md` said
  they were. They existed only on the live status record, so there was no
  per-mount history at all. Now written, and the claim now true.
- **Seven accounting sites, not three.** The first pass at `isFailureEvent` fixed
  the period rollup, the daily buckets and the downtime spread — found by
  grepping `type !== 'up'` in `store.js` and the history page. Three more express
  the same assumption as `type === 'up'` in a `continue` guard
  (`getAudioUptime()`, `getAudienceSummary()`, `backfillAudience()`), and a
  further three lived outside the files first searched: the listener-chart outage
  overlay and the alert-preview `kind` in `monitor.js`, and
  `scripts/backfill-audience.js`. Left unfixed, a one-hour degradation on a
  healthy channel would have been reported as an hour off air, drawn as an outage
  band across the audience chart, and given a fabricated channel-wide loss figure
  written onto the event as a *measured* value.
  **If a new event type is ever added: grep BOTH spellings, across ALL files,
  including `scripts/`.**
- **The HD2 / HD3 mount naming is Pacifica's, not ours — do not "fix" it.**
  KPFT HD2 is served from `/HD3`, `/HD3_128`, `/HD3_64`, which looks like a
  configuration error and is not. Icecast's own metadata on all three mounts
  reads `server_name: "KPFT HD2 Live Stream"`, so the mount PATH is misnamed
  upstream while our channel name matches the actual programme. KPFT HD3 is
  `/classic_country`, which carries no name to contradict. Renaming our channel
  to match the path would make the dashboard wrong.
- **Single-mount channels must still show their mount row.** It was first hidden
  as redundant ("1 of 1"), which read as missing data next to cards that showed
  a count. Consistency beat concision.

---

## 6. Where it is going

Full reasoning in [`icecast-app-future-dev.md`](icecast-app-future-dev.md) §5 and §10.

**The sequencing decision: build the admin panel BEFORE adding stations.** Adding
the five Pacifica sister stations by config file would build the configuration
path twice and throw the first away. Building the panel first makes those five
stations its test data, and affiliates then arrive through the same workflow.

Build order, with the current position marked:

1. ✅ Move station config into the store
2. ✅ Login (single admin)
3. ✅ Add-station flow with Icecast discovery — paste a URL, confirm, saved
4. ✅ Live configuration reload — a station added is monitored seconds later,
   with no redeploy
5. ✅ Station scoping — every aggregate takes a station, and the history page has
   a picker. Without it, adding a second station made the first one's uptime
   silently wrong
6. ✅ Edit and remove stations — ids immutable, history retained on removal
7. ⬅ **NEXT: per-station alert recipients.** Alert emails are still one global
   list. Today `ALERT_STATIONS=["kpft"]` is the only thing preventing WPFW's GM
   being paged about KPFT — which means WPFW and KPFK are monitored and nobody
   is ever told about them. This is the first genuinely GM-facing screen
8. ✅ Listener analytics page — audience as its own destination, station-scoped,
   with per-channel and per-mount breakdowns and CSV export
9. 🔶 **Audience page phase 1** — [`docs/AUDIENCE-ROADMAP.md`](docs/AUDIENCE-ROADMAP.md)
   §4. ATH against the SoundExchange threshold ✅ and trend vs previous period ✅
   shipped 2026-08-28. Still to do: day-of-week × hour heatmap, audience retained
   through an outage, per-mount trend over time
10. Fleet view
11. **SMS alerting** — [`docs/SMS-ALERTING.md`](docs/SMS-ALERTING.md). ~$3–4.50/mo
    plus a one-time ~$15–20 10DLC registration. Depends on item 7: phone numbers
    are per-station in exactly the way addresses are, and building SMS against
    the current global list would build that routing twice
12. Roles and multi-user — **only when a real GM asks for a login**

Two design rules already decided:

- **Two panels, not one.** "Add a station" (rare, technical, restricted) and "my
  station" (weekly, must be simple) are different jobs for different people.
- **Optional capabilities are shown as unavailable, never hidden.** Icecast admin
  credentials are optional and most servers will not have them. A panel that
  disappears teaches nobody anything and makes the page change shape depending on
  which station is picked; a panel reading *"unavailable for this server, needs
  Icecast admin access"* states both the capability and the missing piece.
- **One station screen, not one per station.** A dropdown selects the data. The
  screen must render 1..N channels — KPFT has 3, most affiliates have 1 — and
  every station needs its own URL so alert emails can deep-link to it.

### The prize

All five Pacifica sister stations are on one Icecast host **that this app already
fetches every 60 seconds and mostly discards**. A second host,
`stream.pacificaservice.org:9000`, carries ~28 affiliate stations. Two snapshot
fetches per minute would cover 33 stations. Affiliates are more rows, not a new
architecture.

---

---

## 7. Security posture

Reviewed end to end on 2026-08-27; findings and reasoning in
[`docs/SECURITY.md`](docs/SECURITY.md). Six things to carry forward:

1. **Reading is public; identities are not.** Every public response goes through
   `redact.js`. Station configuration is projected by **allowlist**, so a field
   added later is withheld until someone decides otherwise.
2. **Writing and sending mail require a session.** Protected routes fail closed —
   no password configured means 503, not 200.
3. **Escape helpers escape quotes.** They are used inside HTML attributes, and one
   renders Icecast metadata that a third party controls.
4. **No page carries inline script.** The CSP is `script-src 'self'` with no
   `'unsafe-inline'`. Adding an inline `<script>` to a page will silently stop it
   working; put it in a file.
5. **Reads are public by default, gateable by setting.**
   `REQUIRE_LOGIN_FOR_READ=true` puts everything behind the session.
6. **Any server-side fetch of a user-supplied URL goes through `safe-url.js`.**
   Built ahead of the add-station flow; its tests are that feature's spec.

## 8. Traps

- **Deploys are manual.** Pushing is not shipping. Say so explicitly.
- **Icecast counts our own probes as listeners.** Measured: one connection took
  `/kpfk` from 1 listener to 2. So the Icecast snapshot is fetched BEFORE any
  probe opens a connection, and the non-primary mounts are probed only every
  `VARIANT_PROBE_EVERY` cycles. Making the cycle "faster" by fetching the
  snapshot and probing in parallel again would corrupt every audience figure
  the system stores, permanently and invisibly.
- **Never sum per-channel peaks.** Two channels peaking at different moments do
  not add up to a moment. Any station-wide maximum must come from the channels
  summed per bucket (`stationSeries()` in `public/audience-stats.js`), which is
  summing the same instant. The page shipped with the wrong version and
  overstated the real peak by 18% on production data — 212 against a true 179.
- **Audience arithmetic goes in `audience-stats.js`, not in the page.** That
  split exists because the peak bug above was untestable while the maths lived
  inside the page's IIFE, and 212 is a perfectly plausible number to look at and
  not question. `test/audience-stats.test.js` reproduces that exact fixture. New
  calculations belong in the module; the page renders what it returns.
- **ATH is an ESTIMATE and every surface must say so.** It comes from polling
  listener counts once a minute, not from a log of connections. It is shown
  against a threshold with money attached, so somebody will eventually be tempted
  to file a royalty return on it. `getMonthToDateAth()` returns
  `estimated: true` and the panel prints the caveat in the panel body, not only
  in a popover — do not "tidy" either away. A filing-grade figure needs
  per-connection data, which needs admin credentials.
- **Listener IPs are personal data.** `/admin/listclients` returns an IP and a
  user agent per listener, and reading in this app is public. The natural
  implementation of any geography or device chart — send the rows to the browser
  and group them there — publishes every listener's IP address to anyone who
  loads the page. Aggregate before it leaves the server, or put the panel behind
  the session gate. Decide before Phase 2 ships, not after.
- **The audience page reads `getListeners().streams` directly.** That list is
  station-scoped; it was not, once. Anything added to that payload must be
  scoped too, or the page will render another station's channels under this
  station's heading.
- **A new event type must be taught to every total.** `type !== 'up'` is NOT a
  synonym for "this was a failure" — `degraded` is neither. Anything counting
  failures, downtime, uptime or lost listening goes through
  `store.isFailureEvent()`, and the same assumption hides behind
  `type === 'up'` guards in `getAudioUptime()`, `getAudienceSummary()` and
  `backfillAudience()`. Grep both spellings.
- **Audience analytics does NOT go in the admin panel.** Admin configures the
  system — rare, technical, restricted. Reporting is frequent and GM-facing, and
  belongs on the history page and fleet view. Collapsing them puts "delete
  station" a tab away from a weekly report (§8b of the scope doc).
- **The in-app guide's content lives in `public/guide.js`**, as data rather than
  markup. Edit the TOPICS array; do not put copy back into index.html.
- **`STREAMS` in the hosting panel no longer does anything** after first boot.
  The store owns configuration. `CONFIG_RESEED=true` overwrites it.
- **The Dockerfile lists files individually.** A new module must be added to it
  or the container dies on startup. CI now builds and boots the image, so this
  is caught — but only if CI is kept.
- **Public responses go through `redact.js`.** Anonymous callers get projections,
  not stored records. This is not decoration: on 2026-08-27 `/api/events` was
  serving real staff addresses to anyone who found the URL, because the delivery
  record names every recipient and the endpoint returned stored events verbatim.
  **Station configuration is projected by ALLOWLIST** — per-station recipients
  added later are withheld automatically, without anyone remembering to come
  back. Adding a field to a public response means checking `redact.js` first.
- **Protected routes fail closed.** With no `ADMIN_PASSWORD_HASH` they return
  503, not 200. That is deliberate.
- **Every aggregate must be scoped by station.** `streamIdsFor(stationId)` in
  monitor.js is the seam. A new figure that hardcodes "all streams" is not
  merely broader — it reports one station's outages as another's, and nothing
  fails. An unknown station id returns nothing, deliberately.
- **Channel ids key all history. They are unique across stations AND immutable.**
  Reusing one attaches a new channel to another's record. RENAMING one is worse:
  it orphans the history rather than moving it, so the channel restarts at zero
  while the old record sits under a name nothing references — and uptime is then
  computed from the empty one. The station editor deliberately offers no way to
  type an id. Do not add one.
- **Removing a station must never delete its history.** Configuration says what to
  watch from now on; it is not a statement about the past. Re-adding a station
  with the same channel ids reconnects to its record.
- **Probe URLs are built from the origin the operator reached**, never from
  Icecast's `listenurl`. On the Pacifica server those differ, and the announced
  one is plain HTTP against an internal host.
- **Check cycles must not overlap.** Guarded in runChecks(). Two in flight write
  two samples for the same instant and corrupt the uptime arithmetic — invisible
  at three channels, not at thirty-three.
- **Escape helpers escape quotes.** They are used inside HTML attributes, and
  one renders Icecast metadata that a third party controls. Do not replace them
  with the DOM textContent trick — that is the bug that was there.
- **The add-station flow must fetch through `safe-url.js`.** It is built and
  tested ahead of the feature; its tests are the specification. Calling
  `assertFetchable(url)` before any server-side fetch of a user-supplied address
  is the whole requirement, and redirects must be re-checked the same way.
- **Do not trust a green `npm test` as proof of deployability.** The tests pass
  on a machine where every file exists.

---

## 9. Verifying a change

```bash
npm test                                             # 168 tests
node --check server.js monitor.js store.js diagnose.js auth.js

# Against production
curl -s .../health
curl -s .../api/stations   | jq     # what it thinks it monitors
curl -s .../api/status     | jq     # per-channel state and variant counts
curl -s .../api/diagnostics| jq     # the Icecast inventory it can see
curl -s '.../api/stats?days=1' | jq .storage    # event count, oldest event
```

**After any redeploy, confirm the volume survived** by checking `oldestEvent` is
still `2026-08-04T17:52:53.123Z`. Comparing counts alone proves nothing when the
count could be zero — zero survives everything.

---

## 10. Open questions

1. Is the customer Pacifica specifically, or a general product with Pacifica as
   first user? Changes the tenancy and auth models.
2. Does Pacifica national have authority to monitor affiliates on the shared
   host, or must each affiliate opt in? Gates the affiliate wave entirely.
3. Is the mount→channel mapping right? Inferred from `server_name` strings,
   though the app's own `SIBLING_MOUNTS` corroborates it.
4. ~~Do we have Icecast admin credentials?~~ **Settled 2026-08-28: they are an
   optional per-host setting, added when a station is set up, and the tool is
   complete without them.** `/status-json.xsl` returns listener COUNTS, and
   counts can never yield unique listeners, session length, TSL, geography or
   device breakdowns at any polling rate — `/admin/listclients` is the only way
   to get those. Rather than block the audience page on Pacifica answering, those
   metrics are shown and marked *unavailable for this server*. Build the feature
   when a real credential exists to build against. Full reasoning and the two
   constraints it creates (allowlist redaction; listener IPs are personal data)
   in [`docs/AUDIENCE-ROADMAP.md`](docs/AUDIENCE-ROADMAP.md) §4.1–4.2.
5. **Did the retry actually reduce alert noise?** 32% of events were `unknown`
   before it. Re-measure after a week of production data — around 2026-09-03 —
   rather than assuming.
