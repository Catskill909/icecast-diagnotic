# Handoff — Icecast Monitor

> **Purpose.** Everything a new session, a new developer, or another model needs
> to pick this up without reading the conversation it came from. Written
> 2026-08-27, current as of commit `d551742` (2026-09-02).
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
npm test                                   # 548 tests, all should pass
curl -s https://kpft-icecast.supersoul.top/api/stations | jq   # what it monitors
curl -s https://kpft-icecast.supersoul.top/api/status   | jq   # how it is doing
```

**Read, in this order.** §1 (the one idea), §3 (the data flow), §8 (the traps).
Those three are what stop you breaking something quietly. Everything else can be
read when you need it.

**The six things most likely to catch you out**, all of which fail *silently*:

| | |
|---|---|
| Alerting on probe failure | Reintroducing it undoes the product. §1 |
| A new aggregate that isn't station-scoped | Reports one station's outages as another's. §8 |
| Renaming a channel id | Orphans its history rather than moving it. §8 |
| Adding a module without updating the Dockerfile | Container dies on startup. CI catches it |
| Using a newer Node built-in than `.nvmrc` declares | Every test touching store.js dies at load. §5h |
| Assuming a push deployed | Deploys are manual, always |
| Gating a RECORD on whether it was emailed | Muting a station then edits its history. §5g |
| Thinking a station is a server | A card is a CHANNEL; a station only groups them. §5d, §8 |
| Putting calendar periods back on the audience cards | A month-to-date card is a few hours old on the 1st and reads as data loss. §5e |
| Dividing a per-minute window by an hourly one | Fabricates growth from nothing. Raw lasts 7 days, then compacts. §8 |

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

- **Live and healthy.** 5 stations (KPFT Houston, WPFW Washington DC, KPFK Los
  Angeles, WBAI New York, KPFA Berkeley), 10 channels, **3 Icecast hosts**, 510
  events retained since 2026-08-04 (523 once the recovery backfill in §5g runs).
  Re-verified against production 2026-09-02: 10/10 channels up, no impaired
  mounts, `oldestEvent` still `2026-08-04T17:52:53.123Z` after that day's
  deploy.
- **A recovery is recorded whether or not it is emailed** as of 2026-09-02.
  Muting a station decides who gets mail and nothing else. §5g.
- **Every mount on a card is playable from its chip** as of 2026-09-02 — the
  preview player is pointed at the probed mount and clicking another chip moves
  it. §5f.
- **The audience headline cards are ROLLING windows** — last 24 hours / 7 days /
  30 days — as of 2026-09-01. They were calendar periods and that was reported as
  data loss on the 1st of a month. §5e, and the traps in §8.
- **Recording start dates differ per figure.** Audience LEVELS go back to
  2026-08-04; ARRIVALS (tune-ins) only to 2026-08-24, because the earlier figures
  were listener-minutes and were deliberately erased. A window reaching before
  either is reported as a floor, on the card.
- **One station now spans two hosts.** KPFA is carried on Pacifica's relay
  (`streams.pacifica.org:9000`) AND on its own Icecast (`streams.kpfa.org:8443`).
  That is ONE station with TWO channels: two dashboard cards, watched
  independently, adding up to one line in the audience dropdown. §5d.
- **The second host is no longer hypothetical.** WBAI runs on
  `streaming.wbai.org` while the other three share `streams.pacifica.org:9000`,
  so the host-as-shared-pool design (§3.6) is now carrying real traffic rather
  than being argued for. One snapshot fetch per host per cycle serves every
  station on it.
- **548 tests**, `npm test`, Node's built-in runner, no test framework dependency.
- **Node 24 is required, not preferred.** `device-store.js` uses `node:sqlite`
  (Node 22.5+) and `store.js` requires it at the top level, so an older runtime
  does not degrade — it takes the whole process down at load. `.nvmrc` is the
  single source of truth; CI and local shells both read it. §5h.
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
| `store.js` | 2926 | Persistence, retention, audience model, rollups, **station config** |
| `monitor.js` | 3474 | Check cycle, episode state, email composition, weekly roundup |
| `diagnose.js` | 1255 | Probe, Icecast snapshot, **the classifier and the alert gate** |
| `server.js` | 815 | HTTP API |
| `auth.js` | ~290 | Admin session gate: scrypt, signed cookie, rate limiting |
| `redact.js` | ~130 | **Public projections.** What anonymous callers may see |
| `safe-url.js` | ~150 | **SSRF guard** for fetching user-supplied URLs |
| `discover.js` | 822 | Station discovery: mount → channel grouping, validation |
| `listener-detail.js` | 605 | `/admin/listclients`: parsing, agent + **channel classification**, **the privacy boundary** — IPs go in, aggregates come out |
| `geo-update.js` | ~250 | **Downloads GeoLite2 onto the data volume.** The only network code in the geo path, deliberately outside `geo.js` |
| `public/geo-map.js` | ~200 | **The cartogram and the in-market arithmetic**, separate so Node can test it. `window.GeoMap` in the browser |
| `geo.js` | 435 | **Local MMDB lookups.** IP → network (relay detection) and IP → place. No coordinates ever leave it. Databases optional, deployer-supplied |
| `device-store.js` | 297 | SQLite device records behind cume |
| `public/app.js` | 852 | Dashboard |
| `public/history.js` | 1537 | History page, station picker, charts |
| `public/listeners.js` | 694 | **Audience page**: rendering only — ATH, charts, tables, CSV export |
| `public/audience-stats.js` | 231 | **Audience arithmetic**, deliberately separate so Node can test it. Loads as `window.AudienceStats` in the browser and `require()`s in tests |
| `public/preview-player.js` | 130 | **The cards' audio previews**: selected mount, play state, one at a time. Separate for the same reason as `audience-stats.js`. `window.PreviewPlayer` in the browser, `require()`d in tests |
| `public/admin.js` | 1389 | Admin panel: add, edit, remove stations |
| `public/guide.js` | 359 | In-app guide (content lives here as data) — 12 topics |
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
| **TOTAL LISTENERS leads the page** | Reach, not concurrency. Every rise in the listener count is an arrival, so tune-ins are derivable with no credentials — 844 today against a concurrent peak of 178, and 1,269 against 193 on the busiest day. A listener-supported station quoting the concurrent figure understates itself four to nine fold to funders. Peak and average are kept, ranked below it |
| Reach comparison withheld when the earlier period is under-recorded | Caught in the live audit the day tune-ins shipped: last week fell outside raw retention and its rollups predated tune-in recording, so it returned 1,339 against this week's 5,813 and the page announced **+376%** — entirely an artefact. Both windows must be fully recorded before a percentage is computed |
| Tune-ins frozen onto rollups at compaction | An hourly average cannot show that forty listeners left as forty arrived. Miss the window when raw samples expire and the churn is unrecoverable |
| **Listener NUMBERS lead the page** | The page had drifted to answering "how much listening was delivered" when the first question a station asks is "how many people". Headcounts for today / this week / this month now head it, each with peak and average against the same elapsed span of the previous period; listening hours moved to the bottom. **The calendar periods here were SUPERSEDED 2026-09-01 by rolling windows — see §5e. Reach leading the page was not.** |
| Distinct listeners shown as unavailable | Icecast reports how many connections exist, not who they are, so no polling rate yields "1,800 different people". The card states that rather than omitting it or quietly presenting a concurrent figure as a headcount |
| **True concurrent peak** | The page reported the SUM of each channel's separate high-water mark — a total the station never reached at any one moment. Measured against production: it said 212 where the real simultaneous peak was 179, an 18% overstatement. Now computed from the channels summed per bucket, and carries the timestamp, because a peak with no "when" is trivia |
| Listener figures the page lacked | Quietest moment (the floor the station holds), "now vs typical for this hour" from the hour profile, and a day-by-day table of average / peak / low / hours |
| **ATH against the royalty allowance** | Aggregate Tuning Hours is what a US noncommercial webcaster's SoundExchange rate is computed from — the fee covers each channel's first 159,140 per month. `getListeningDelivered()` had computed the listener-minutes since day one and surfaced them nowhere. KPFT Main runs ≈39,100/month, ≈25% of the allowance |
| **A repeating fault is one fault** | Every other gate judges ONE episode and judges it right, which is how a flapping encoder sent 14 true alerts in an hour on 2026-09-02. A 2nd confirmed failure on a stream within `STORM_WINDOW_MS` (45 min) marks it **UNSTABLE**, says alerts are paused, then goes silent; one summary follows after `STORM_CLEAR_AFTER_MS` (30 min) of health. The first outage is never delayed — a hold-down was rejected for taxing the one alert that matters. Outages and dead air share one storm; state persists through the store so a redeploy mid-storm does not restart the flood |
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

## 5c. What changed on 2026-08-31: per-station alert recipients

Recipients were one global `ALERT_EMAILS` list, and `ALERT_STATIONS` — a mute —
was the only thing keeping one station's outage out of another station's inbox.
The cost was visible in production on the morning this was built: three confirmed
WPFW source-encoder dropouts in 27 hours, correctly diagnosed, fully recorded,
**and emailed to nobody at all**, because WPFW was not on the list. The station
was being watched and could not be told.

| Change | Why |
|---|---|
| `alerts: { enabled, recipients, cc }` per station, in the config store | Configuration the operator edits must live where the store is authoritative, or a redeploy reverts it |
| Recipients edited **on the station card** in the admin panel | First built as a separate `/station.html`, following §6's "two panels, not one". **Retracted the same day** — see the corrections below |
| **`sendGroupedAlert()` — one message per station** | The consolidation was written for a single station and grouped by nothing. Four stations on shared hosts fail in the same cycle, so one message would have reached one station's staff and named three others' outages |
| Recipients resolved inside `sendAlert()` from the entries' own station | So a new alert type gets the right list by default rather than by remembering to pass one |
| `describeAlertRouting()` and the routing banner | Four independent conditions must hold before mail goes out and each fails silently. The screen states the verdict and names the blocker, computed server-side from the same rules the sender uses |
| The station block overrides `ALERT_STATIONS` | The alternative is a screen that saves addresses and sends nothing, blocked by a hosting-panel variable no page displays |
| The recipient editor's page gated in `ADMIN_PAGES` | It can display named people's email addresses. Found on the standalone page because its stylesheet returned 302 while the page itself returned 200; the gate moved with the editor into `/admin.html` |
| `recipientSource` on the delivery record | "Sent to 2 people" is not an audit line if nobody can tell whether those two were the station's own contacts or the global fallback |
| **The weekly roundup now copies `ALERT_CC`** | It read a different recipient list from alerts — To only. The operator running the monitor was on `ALERT_CC`, so he received every 3am outage alert and, in seven weeks, not one roundup. The worst possible address to omit: the roundup is the only message that arrives in a quiet week, and therefore the only thing separating "nothing broke" from "the monitor died" |
| One recipient list per station, no CC field | To/CC separates people — "act on this" from "for your awareness". In an automated alert it separates nothing: identical message, identical delivery, anyone can act |

### The env fallback retired, and the roundup follows (later the same day)

The first pass left recipients as a per-station **override** on top of the
`ALERT_EMAILS` env list. The operator opened the panel and found the flaw
immediately: the banner read "2 recipients" directly above a list reading "none
set". Both were true. KPFT's actual recipients lived in an environment variable
the screen could not show, edit or correct.

**Two sources of truth was the whole bug**, and it contradicted a rule this
project already settled — env seeds once, the store owns. Recipients were the
last configuration still read from the environment at send time.

| Change | Why |
|---|---|
| `seedAlertsFromEnv()` — a one-time migration | `ALERT_EMAILS` + `ALERT_CC` become each station's own list, merged and deduplicated. Guarded by a `meta` marker, **not** by "does any station have alerts": an operator clearing the last address must not look like a fresh volume and get the env list written back underneath them |
| The send-time fallback is gone | `recipientsFor()` reads the store and nothing else. `ALERT_STATIONS` no longer gates anything at run time — it is a migration input, once |
| **One weekly roundup per station** | It read one monitor-wide list, so a station configured in the panel got its alerts and never its own report |
| Roundup hour in each station's **own timezone** | WPFW is Eastern, KPFK Pacific. A 9am report should arrive at 9am where the reader lives |
| The once-a-week marker is **per station** | One shared marker meant the first station to send declared the week finished for all of them, so three stations would silently never receive one. Retries are per station for the same reason |
| Edit and Test on every recipient row | "Remove it and type it again" is not editing. A transposed character is the likeliest mistake here and the quietest — mail goes nowhere and nothing reports it |
| `recipientSource` removed from the delivery record | With one source of truth it could only ever hold one value, and a constant field implies a choice that no longer exists |

**The migration's own test is the point of it.** `test/alert-migration.test.js`
computes the recipient set for every station before and after, under the real
production configuration, and asserts they are identical. The obvious
implementation — copy `ALERT_EMAILS` onto every station — would have signed
KPFT's general manager up for outages in Washington, Los Angeles and New York,
and would have looked correct in review.

### Also 2026-08-31: the channel editor, and a message that said nothing

| Change | Why |
|---|---|
| **Mounts are chips with an ×**, plus an add field | They were one space-separated text box. Nothing showed it was a list, nothing removed a single mount without editing text, and the only check was "starts with /". A pasted full URL is now reduced to its path, because pasting the stream URL is what an operator actually does |
| **+ Add a channel** | The editor could drop channels and never add one. The id is generated from the name and shown before saving — the editor still offers no way to TYPE an id, because reusing one attaches a new channel to another's recorded history and renaming one orphans it |
| A new channel's id is generated at **save**, not when the row appears | So the id matches the name the operator settled on rather than the placeholder the row started with |
| The alerts route returns JSON on every path | It could throw and return express's HTML error page; the panel parsed that as JSON, got nothing, and showed its generic fallback |
| `api()` keeps a non-JSON body; `failureText()` names the failure | `res.json().catch(() => ({}))` threw away the evidence, and every failure rendered the same six words |

| Timezone is a **dropdown**, US zones first, named by city | It was free text holding an IANA identifier. "America/Chicago" is not producible from memory, a typo was caught only on save, and the string says nothing about which offset it means — Houston is Central, and nothing in it says Houston. Arizona is listed separately because it does not observe daylight saving, which silently shifts a weekly report by an hour for half the year |
| A new mount is **checked against the live inventory** | Free — the monitor already holds it — and it opens no connection. Autocompletes from what the host actually serves, warns when a path is not being served, and warns when it already belongs to another channel |
| The test email is **scoped to its station** and names it | It rendered every stream the monitor watches. Testing an address just added to WPFW sent that person KPFT, KPFK and WBAI's listener counts — four cities' figures that are not theirs |
| Removing a mount or a recipient asks first | Both consequences are invisible: a channel keeps working while its listener count quietly drops by whatever that mount carried, and a removed address simply stops being told |

### Corrections worth inheriting

- **The handoff's own figures were stale and were corrected**, not merely
  updated: it said 3 stations / 5 channels / 1 host / 246 tests. Production on
  2026-08-31 is 4 stations, 8 channels, **2 hosts** — WBAI on
  `streaming.wbai.org`. The second host makes §3.6's shared-pool design load-
  bearing rather than anticipatory.
- **`redact.js` needed no change**, which was the point of writing it as an
  allowlist: per-station recipients were withheld from anonymous callers the
  moment they existed. Verified against a running instance — zero occurrences of
  a saved address in the anonymous `/api/stations` response — and now asserted in
  `test/redact.test.js` rather than left as a claim.
- **"Two panels, not one" was applied too early, and was retracted.** §6 says
  "add a station" (rare, technical, restricted) and "my station" (weekly, must
  be simple) are different jobs for different people, so recipients first
  shipped as a standalone `/station.html`. **That reasoning assumes two kinds of
  login, and there is one.** In practice it was the same person, behind the same
  password, using two menus that each showed half of one station's settings —
  which the operator reported as confusing within minutes of seeing it. A
  station's channels and its recipients are one idea: its settings. Recipients
  now live on the station card, opened by an **Alerts** button beside Edit and
  Remove, using the same inline-editor pattern.
  **The design note is not wrong — it is not yet due.** Split the GM screen back
  out when build-order item 12 (roles and multi-user) gives it a distinct
  audience. Splitting it before the roles that justify it bought only a second
  navigation bar.
- **The per-station panel offers ONE list, not To and CC.** It first mirrored
  the `ALERT_CC` env var into a second field. To/CC separates people — "act on
  this" from "for your awareness" — and in an automated alert it separates
  nothing: identical message, identical delivery, anyone can act. It was a
  second field, a second concept and a second decision buying only which header
  an address lands on. The env-level `ALERT_CC` is untouched — it is how the
  monitor owner currently receives everything — and the API still accepts `cc`,
  where an omitted field means unchanged rather than cleared.
- **Form fields were invisible, and it was measurable rather than a matter of
  taste.** Inputs were `--surface-2` on a `--surface-3` border, and a station
  card is ALSO `--surface-2` — the field was the same colour as the card behind
  it, outlined in a shade 1.42:1 against it. WCAG 1.4.11 asks 3:1 for a
  control's boundary. Fields are now the darkest surface with a `#6b6b85`
  border, measured at 3.30:1 on the card and 3.60:1 on the panel. A collapsed
  `<details>` was also styled at input width, height, radius and background, so
  it read as an empty text box; that section is now an ordinary labelled group.
  **Placeholders are not labels** — every field carries a real `<label>`.
- **The header navigation was rebuilt at the same time.** Every item was an
  identical bordered box, so Dashboard, Stations and Sign out read as three
  equal choices and the page title lost the header. Navigation is now quiet
  text; only the action that ends a session keeps an outline.
- **Two of the four consolidating call sites were the `degraded` paths**, which
  the first pass would have missed. They consolidate exactly like the outage
  paths and would have leaked the same way, less visibly. Fixing this at
  `sendGroupedAlert()` rather than at the call sites is what makes that
  irrelevant.

---

## 5d. Also 2026-08-31: a station that spans two servers

KPFA appeared **twice** in the station list, its audience split across two pages
and its channel count double-counted. Both entries were named "KPFA Berkeley".

**Why it is the first station to do this.** Every other multi-channel station's
mounts live on ONE server, so discovery reads one status document, groups its
mounts into channels, and the operator adds them in a SINGLE submission. KPFA is
carried on Pacifica's relay *and* on its own Icecast at
`streams.kpfa.org:8443` — two status documents, so two discovery runs, and the
add flow only ever creates a NEW station.

**The mechanism is worth reading, because it was a regression built out of two
correct fixes.** The guard existed: `validateStationPayload` rejects a taken
station id, and the admin form answers "this looks like a station already being
monitored — use Edit, then + Add a channel". Then `freeStationId` was added at
DISCOVERY time so a colliding id resolved to a free `kpfa-2` before submission —
so the save succeeded, validation never ran, and that guidance became
unreachable. A later commit stopped rendering `identityNote`, removing the last
visible trace. **Pre-resolving a conflict consumed the information the conflict
carried**: the id collision WAS the evidence that this is the same station.

| Change | Why |
|---|---|
| `discover.existingStationFor()` and `existingStation` on the discover response | De-confliction still happens — a genuinely separate station sharing a call sign must stay addable — but the station holding that id is now REPORTED alongside it |
| The offer hands ticked channels to that station's editor as **unsaved rows** | Identical to pressing "+ Add a channel". Nothing is written by the handover; the operator reviews and saves |
| A handed-over channel whose name matches the station's gets its **host appended** | Two channels of one station are told apart by which server they come from, which is the whole reason there are two |
| `openEditor(s, prefill)` does not toggle closed when given a prefill | Edit toggles; a handover always opens, or the channels are silently discarded |
| **The handover button became the PRIMARY action; "Add station" became a ghost reading "Add as a separate station instead"** | See the correction below |
| New guide topic **"Stations, channels and mounts"** | The three-level model was documented nowhere the operator could read it |

### Corrections worth inheriting

- **A warning that competes with a call to action loses.** The offer first
  shipped as a note ABOVE the form with "Add station" left as the big primary
  button. On the first real use the note was read, understood, **and the primary
  button was pressed anyway** — recreating the duplicate. That is what a primary
  button is for. The fix was not a louder warning: when discovery knows the
  station is already monitored, the safe action IS the primary button and the
  duplicate-creating one is demoted. Both are still one click; only the default
  moved.
- **Grouping channels under a station does NOT merge dashboard cards, and this
  was the operator's first question.** `flattenChannels()` turns every channel of
  every station into its own monitored stream and the dashboard renders one card
  per stream. WBAI has been one station with three separate cards since it was
  added. A station is a grouping for **alert recipients, the weekly roundup, the
  timezone, and the Audience page** — nothing else. Answering this wrongly would
  have talked the operator out of the correct fix.
- **A mount is not a channel, and picking the wrong one here is destructive.**
  Adding the second server's URL as MOUNTS on the existing channel would have
  merged the two into one card with one probe and summed listeners — losing the
  independent monitoring of a whole Icecast server. The handover adds a CHANNEL.
- **`freeStationId` is the only pre-emptive de-confliction in the codebase.**
  Swept after the fix: the channel-id path errors rather than auto-resolving,
  which is correct. One instance, reported rather than left implied.

---

## 5e. What changed on 2026-09-01: rolling windows, and a comparison that lied

**It began as a reported emergency that was not one.** The operator opened the
audience page on the morning of 1 September and found "This month" reading 415
where it had read thousands — over a week of KPFT data apparently wiped.

Nothing was lost. Every sample since 2026-08-04 was intact: 504 hourly rollups
(Aug 4 → Aug 25) joining seamlessly to 10,060 raw samples per channel (Aug 25 →
Sep 1). The container had restarted ~11 hours earlier and the volume had carried
everything through. **The page looked empty because it was the 1st of the month
and the card had reset to nine hours old.**

That is the finding worth inheriting: *a calendar period on a live dashboard
spends most of its life partly elapsed, and looks broken while it does.*

| Change | Why |
|---|---|
| **Peak and average gated like reach** | The `comparable` flag guarded `totalListeners` only. Its two neighbours were computed from the same pair of windows, ungated, and printed **+887% peak / +989% average** on production from a window holding 33 readings against 1,969 |
| **Comparisons levelled to a shared resolution** | Withholding those figures would hide them for ever — a 7-day window always outlives 7-day raw retention, so the older side is always hourly. `concurrentBetween(..., 'hour')` coarsens the finer side; the headline peak stays a peak MINUTE and only the percentage uses the levelled pair |
| **Calendar periods → rolling windows** | Last 24 hours / 7 days / 30 days. `30d ⊇ 7d ⊇ 24h` by construction, so no card can report less than the one inside it, and nothing collapses at a midnight or a 1st |
| **`recordedFrom` per figure** | A window can reach back further than the recording behind it, and reach and levels began on DIFFERENT days (2026-08-24 vs 2026-08-04). That is why one row on a card compares and the row beneath it says there is not enough history — now stated on the card instead of guessed at |
| `hoursCovered` counts **whole** hours | See the trap in §8. Counting partial edges withheld the 7-day and 30-day comparisons permanently |
| `COMPARISON_COVERAGE_FLOOR = 0.9` | 100% coverage meant a single missed hour voided a whole week |
| `periodBounds()` deleted | Dead once the cards stopped using calendars. `monthStartMs` / `zonedMidnightMs` still serve daily buckets and monthly ATH |

### Corrections worth inheriting

- **The reported bug was not a bug, and saying so quickly mattered more than
  fixing anything.** The right first move was to prove the data existed — count
  the samples and the rollups and show the range — not to start editing. Two real
  bugs were then found *while checking*, which is a different thing from the one
  reported.
- **I shipped a bug in the fix, and it was invisible to the test suite.**
  Requiring the previous window to cover every hour of its span looked correct and
  passed every test, because the tests used hour-aligned fixtures. `now` is never
  hour-aligned in production, so a rollup-backed window was always 1–2 hours short
  and the 7-day and 30-day comparisons would have been withheld **for ever** —
  the exact failure the levelling was written to avoid. Found only by asking "will
  this actually start working as data accumulates?" and checking against live
  data rather than reasoning about it. **`test/counts-comparability.test.js` now
  uses a deliberately non-hour-aligned `now`.**
- **A gate can do more damage than the artefact it guards against.** The first
  coverage rule demanded 100% and one genuine monitoring gap — 24 Aug at 01:00 —
  silently withheld a week of comparison. A guard that fires on ordinary
  conditions is not conservative, it is broken.
- **The 7-day rise is not yet known to be audience growth.** The card now reads
  +79.2% peak / +71.1% average against the previous week. KPFT HD3
  (`/classic_country`) has a `streamStart` of 2026-08-29 — inside the current
  window, absent from the comparison one. A station-wide total that grew because
  the station grew is not wrong, but it must not be quoted to a funder as
  audience growth. Open as item 0.6 in the phase plan.
- **Two flags, not one.** `totalListenersComparable` and `concurrencyComparable`
  are separate because they fail for different reasons and either can be true
  while the other is false. Collapsing them back into one flag reintroduces the
  original bug.

---

## 5f. What changed on 2026-09-02: the mount chips became play controls

The chips listing each channel's mounts were inert labels, and the card's single
preview player could only ever play the probed mount. So the one mount an
operator most wants to hear — the amber one Icecast still lists but will not
serve — was the one mount the dashboard would not play.

| Change | Why |
|---|---|
| Chips are `<button>`s that point the card's preview at their own mount | Hearing a variant was impossible from the dashboard, and "is this mount actually serving audio" is a question only the ear settles. Clicking the mount that is playing stops it, so a chip behaves like the play button beside it |
| The highlight follows the SELECTED mount, defaulting to the probed one | A card at rest looks exactly as it did. `.primary` keeps its own quieter treatment, so the probed mount is still identifiable when the selection has moved off it |
| A `missing` mount is `disabled` | Icecast is not serving it. Offering a play control for it would promise audio that cannot arrive |
| Selection falls back when its mount stops being playable | A card must never highlight a mount nobody can play. `selectionFor()` re-picks on every render, which is also what makes the choice survive the 10s poll |
| The player subtitle names a variant instead of showing `bitrate` | The configured bitrate describes the PROBED mount only. Printed beside `/kpfa_64` it is simply false |
| **Player state moved to `public/preview-player.js`** | Same split, and the same reason, as `audience-stats.js`: the race below was untestable while it lived inside the page's IIFE |

### Corrections worth inheriting

- **Audio event handlers must be scoped to their own element, not to the stream
  id.** `pause` is delivered asynchronously, so when a card tears one element
  down and builds another in the same gesture, the old element's `pause` arrives
  *after* the new one has started — and a handler keyed by stream alone reports
  it as the card's state, stopping the mount the operator just asked for. The
  handlers had always been written that way; nothing had ever replaced a stream's
  element, so the path was unreachable until clickable chips made it the common
  case. Every handler now returns early unless it is still the current player.
  `test/preview-player.test.js` delivers `pause` on flush rather than on call, so
  the ordering under test is the real one.
- **A latent bug and a shipped bug look identical in the diff.** This one was
  introduced by no commit — it was made reachable by a feature. Reviewing "what
  did I change" would never have found it; reviewing "what is now possible that
  was not before" did.
- **A mount path is only meaningful against its own channel's host.** `mountUrl()`
  swaps the pathname on `stream.url` and changes nothing else, which is the same
  assumption `mountListeners` already makes — the per-mount counts are read from
  that host's snapshot. If a channel is ever allowed to carry mounts from a second
  server, both break together, and both must be fixed together.
- **Audio previews are listeners.** Clicking a chip opens a real connection that
  Icecast counts, exactly like the monitor's own variant probes (§5b). It is worth
  saying in the guide, because an operator sampling seven mounts of a quiet
  channel can move its number visibly.

---

## 5g. Also 2026-09-02: the recoveries that were never recorded

**Reported from the dashboard:** WPFW went down at 09:46 and came back four
minutes later, and the incident feed showed the outage — carrying *"lasted 4m"*,
so the recovery had plainly been observed and measured — with no RECOVERED row
anywhere. Across the whole 512-event production record the split was exact: the
three KPFT channels had 107 outages and 115 recoveries; the two stations whose
alerts are switched off had **5 outages and 0 recoveries**.

**The mechanism.** Writing the `up` event was gated on `episode.alerted`, and
that flag is set in one place only — inside the branch of `dispatchNotifications`
that sends mail, over a list already filtered by `alertsEnabledFor()`. So the
record was a side effect of the email. A muted station could never set it.

It was never only about muted stations: **8 of the 13 lost recoveries were on
KPFT, where alerts are on.** A confirmed outage that the listener-impact gate
declines to email does not set `alerted` either, so it lost its recovery the same
way. Any reason not to send mail was a reason to lose history.

| Change | Why |
|---|---|
| The recovery is queued for every **confirmed** episode, not every alerted one | Recording is decoupled from notifying — the failure branch says so in a comment, twelve lines above the code that did the opposite. An episode that never reached `outage` still gets none: an all-clear for a one-check blip is noise in a feed that has to stay readable |
| `dispatchNotifications` records first, then decides mail | The recovery event is now written for every recovery it is handed. Emailing needs the outage to have been alerted AND the station to be enabled, and neither condition can reach the record |
| Muted recoveries no longer filtered out at the top | They were split into a `mutedUp` list that could not have saved them anyway: that loop opens `if (!m.eventId) continue`, and a recovery carries its outage's id as `episode.eventId`. Filtering a recovery out before its event exists does not mute it, it erases it |
| The event says which silence it was | `alerts are switched off for station "wpfw"` versus `no all-clear sent — the outage it ends was not emailed`. Two different reasons for the same blank |
| `isSelfCleared(episode)` replaces `!episode.alerted` | Same conflation, one field along. WPFW's event carried `confirmed: true` and `selfCleared: true` at once, and the detail panel rendered *"Self-cleared before confirmation"* on a confirmed four-minute outage |
| `store.backfillRecoveries()` at load | 13 outages had already lost theirs. Rehearsed against a copy of the production record: 13 written, 0 on a second run, 0 confirmed-and-resolved outages left without one |

### Corrections worth inheriting

- **The guide already promised what the code did not do.** *"Switching a station
  off stops its email without stopping its monitoring: the outages are still
  recorded in full."* That sentence shipped months before this bug was found. When
  a doc and the code disagree, the doc is sometimes the specification — read it
  as evidence, not as prose to be updated to match.
- **A gate on the wrong side of a decision is invisible in the diff that adds
  it.** Nothing here was written carelessly: the rule "no all-clear for an alert
  nobody received" is correct, and the comment defending it is correct. It was
  applied one step too early, where it decided the record instead of the mail.
  The question to ask of any gate is not "is this rule right" but "what else is
  downstream of it".
- **Backfilling from `resolvedAt` is a repair, not an invention.** The recovery
  WAS observed — a check saw the stream serving again and wrote the timestamp and
  the duration. Only the event was missing. That is the exact distinction
  `abandonEpisode()` draws when it refuses to write one, and the backfill skips
  abandoned and unresolved outages for that reason. Reconstructed rows carry
  `reconstructed: true` and are badged in the UI.
- **The rehearsal mattered more than the unit tests.** The tests prove the rule;
  loading a copy of the production record proved the blast radius — 13 events,
  which streams, which dates, idempotent on the second boot. Do that before
  shipping anything that writes to the permanent record.
- **Order matters when inserting into the event record.** `findOpenOutage()`
  walks the array backwards and stops at the first `up` for a stream, so a
  backfilled recovery appended at the end would hide a later, still-open outage
  and report a stream that is off the air as healthy. The backfill re-sorts by
  timestamp, and `test/recovery-recording.test.js` builds exactly that shape.

---

## 5h. Also 2026-09-02: CI was testing on a Node the app had outgrown

**Reported from GitHub:** the CI run on `b39481f` failed in 16 seconds. "Unit
tests" red, "Image builds and boots" green beside it. The commit was documentation
only and had touched no code, which is what made it confusing.

**The mechanism.** Three commits earlier, `470bf7e` added `device-store.js` — it
requires `node:sqlite`, a built-in that only exists from Node 22.5. On its own
that changed nothing, because nothing imported it yet; that run was green. Then
`dbd30cb` wired it in, and it did so at the TOP LEVEL of `store.js`:

```js
const { DeviceStore } = require('./device-store');   // store.js, module scope
```

So the SQLite requirement stopped being local to the audience code and became a
requirement of loading `store.js` at all. **26 test files died at require time**,
every one of them with the same error, none of them about the feature that had
changed.

The version had been raised everywhere it was declared — `.nvmrc`, the Dockerfile,
`package.json` engines — except in `.github/workflows/ci.yml`, which still said
`node-version: '20'` from weeks earlier. It had been harmless for exactly as long
as nothing needed anything newer.

**Why the image job stayed green, and why that mattered.** It builds from the
Dockerfile, which says `FROM node:24-alpine`. So the job designed to prove
deployability passed, while the job running the tests used a runtime the shipped
artifact never uses. The two jobs disagreed about what Node this app runs on, and
nothing was comparing them.

| Change | Why |
|---|---|
| CI reads `node-version-file: '.nvmrc'` | The version is declared once. A future bump cannot leave CI behind. |
| `test/runtime-version.test.js` | Checks `.nvmrc`, `engines`, every Dockerfile `FROM`, the workflow, and the running interpreter all agree. |
| Dead skip guard removed from `device-store.test.js` | It caught the failed require and reported a skip — green while everything else burned. |
| `nvm alias default 24` on the dev Mac | The default was 20, so a fresh terminal failed `npm test` for environment reasons. |

**What to carry forward.**

- **The bug was in the gap between two declarations, not in either one.** Both
  the Dockerfile and the workflow were internally consistent and individually
  defensible. Nothing checked they agreed, so a change to one silently made the
  other wrong. `runtime-version.test.js` exists to be that check, and it
  deliberately parses no application code so it still runs on a Node too old to
  load the app — which is precisely when its answer is worth having.
- **A top-level require changes the blast radius of a dependency.** Moving
  `require('./device-store')` into module scope of `store.js` promoted a niche
  requirement into a hard requirement for two thirds of the suite. If a new
  module needs something the runtime may not have, where you require it decides
  how much dies with it.
- **The failing commit is not always the breaking commit.** `b39481f` was docs.
  The break arrived in `dbd30cb` and was merely re-run by the next push. Read the
  run history before reading the diff: `470bf7e` green, `dbd30cb` red is the whole
  story, and the API gives it without a login.
- **Test counts move for reasons other than new tests.** The suite went 298 → 548.
  Not because 250 tests were written, but because the SQLite tests had been
  quietly skipping themselves and started actually running.

---

## 5i. Also 2026-09-02: how the audience arrives, and two documented facts that were wrong

**What was built:** Phase 5.4 — distribution channel and ASN classification.
`geo.js` is new; `listener-detail.js` classifies each connection; the proxied
share renders as a qualifier at the top of the Who Is Listening panel.

**Why it was urgent rather than next.** `DEEP-ANALYTICS-PLAN.md` §7 puts the
proxied share **before** publishing anything derived from sessions, so that the
correction does not land in public afterwards. TSL, session distribution and the
player mix had already shipped without it. That ordering rule had been crossed,
and this closes it.

**The idea.** An aggregator that *proxies* carries an unknown number of people
behind one connection. Every audience number in the product then understates
reality by a factor nothing else can bound. So this is not a seventh tile — it
is a banner above the six, and the copy says **a proxied listener is uncounted,
not lost**, because the obvious misreading is "our audience is falling".

**Two things the planning documents asserted that turned out to be false.** Both
were found by fetching the real artefact instead of trusting its documentation —
the same discipline `ADMIN-ACCESS-SCOPE.md` §7 step 0 applies to the Icecast API.

| Documented | Actually |
|---|---|
| GeoLite2 ASN "separates datacenter from residential" | **No free ASN database has a hosting flag.** `is_hosting_provider` is in MaxMind's PAID Anonymous IP database. The free tiers give an AS number and an organisation NAME |
| DB-IP Lite is too inaccurate | True **at city level only**. For ASN it is equivalent — an AS number comes from the public routing table — and **it needs no account**: CC BY 4.0, 9 MB, direct download, same MMDB format |

So datacenter detection is a **name heuristic**, labelled as one, with three
outcomes: `hosting`, `unrecognised`, `unknown`. **`unrecognised` is not
`residential`** — it is the absence of a match, which is also what a small
regional host looks like.

**A bug this caught, worth recording as a class.** `buildEpoch` in MMDB metadata
is Unix *seconds* per the file-format spec, so `new Date(epoch * 1000)` is the
obvious reading — and it is wrong, because `mmdb-lib` has already converted it
and returns a `Date`. The result was a build date in the year **58636**. The
damage was not cosmetic: that field exists to reveal a **stale** database, which
misplaces listeners silently, and a date 56,000 years out reads as impossibly
fresh — the bug disabled exactly the check the field provides. `buildDate()` now
accepts either form and rejects anything outside plausible reality. A sweep for
the same unit assumption elsewhere in the codebase found nothing.

**Traps this adds:**

| | |
|---|---|
| Tallying consumer ISPs alongside datacenters | At this audience size "1 listener at University of Houston" is not an aggregate. Only *datacenter* orgs are named |
| Averaging a proxied share across mounts | A share is not additive. Recompute from summed counts, or a mount with 3 listeners outweighs one with 300 |
| Letting a merged figure keep the STRONGER confidence | It inherits the **weakest**. One mount read with no ASN database makes the whole channel a floor |
| Calling the share `share` | It is `connectionShare`. It is a share of *connections*, not of listening, and the two differ by the factor nobody can measure |
| Adding `measured` to its confidence vocabulary | Nothing available measures this |

**Geo databases are optional and supplied by the deployer** (`GEOIP_ASN_DB`,
`GEOIP_CITY_DB` — filesystem paths). Nothing is bundled and nothing is
downloaded. A **local database, never a lookup API**: an API means sending every
listener's IP to a third party, one request per listener, for ever.

**5.9, the map, is NOT built.** `geo.js` has `lookupPlace()` with the US-state /
country-only rule and the centroid gate, both tested, but no aggregation, no API
and no page. It also needs a **city** database, which is where the accuracy
argument genuinely bites and where a MaxMind account may earn its keep.

---

## 5j. Also 2026-09-02: the map (Phase 5.9)

**Built:** `geo-update.js`, `public/geo-map.js`, a "Where They Listen" section,
and geography aggregation in `listener-detail.js`.

### The finding that decided the database, measured not argued

`ADMIN-ACCESS-SCOPE.md` §2 recommended MaxMind GeoLite2 City over DB-IP on
*accuracy*. The real reason is harder, and it was found by fetching both files:

| | MaxMind GeoLite2 City | DB-IP City Lite |
|---|---|---|
| `subdivisions[0].iso_code` | `"TX"` | **absent** — only the name |
| `location.accuracy_radius` | present | **absent entirely** |

**`accuracy_radius` is the centroid guard.** It is the only field that says an
answer is a fallback rather than a place. Without it a manufactured cluster is
indistinguishable from a finding — the Kansas-farm artefact. So DB-IP City is
used at **country resolution only**, and the app withholds every US state with
`regionWithheld: 'no-accuracy-radius'` and says so on the page. Verified against
production: 173 US connections placed by country, 173 states withheld.

State NAMES are mapped back to codes (`US_STATE_CODES`) so a DB-IP database is
not silently stateless for a second, separate reason.

### How the city database reaches a server nobody can shell into

The ASN database rides in the image because CC BY permits redistribution.
**GeoLite2's EULA does not**, so it cannot travel that way. `geo-update.js`
downloads it at startup onto the **data volume**, under the deployment's own
licence key — MaxMind's own documented pattern, and nothing is redistributed by
us. It also fixes staleness, which the image-baked ASN database still has.

**This does not contradict the rule in `geo.js`.** That rule is *never send a
listener's address to a third party*; downloading a database file sends nobody's
address anywhere. The network code lives in `geo-update.js` and
`test/geo-update.test.js` asserts `geo.js` still has no HTTP client — an http
client in there is one refactor away from being pointed at a per-listener API.

MaxMind ships `.tar.gz` only, so the updater walks the tar directly rather than
shelling out or adding a dependency. The entry is matched **by extension**: the
directory name carries a build date that changes every download.

### A tile grid, not a shaped map

The scope doc says "SVG choropleth — US states". It is one, with the geometry
changed deliberately: **area is not audience.** A shaped map makes Montana sixty
times the size of Rhode Island, hides Delaware, DC and Rhode Island — where a
Pacifica audience actually concentrates — and implies a precision a
radius-gated state figure does not have. Equal tiles say "per-state" and stop.
It also saves ~120 KB of path data.

### Traps this adds

| | |
|---|---|
| Counting relays in the geography | A datacenter address geolocates to the DATACENTER. Production has **41** relays; unexcluded they would report as an audience in Virginia and be the largest error on the page |
| Dividing the in-market share by anything but US-placed connections | Using `placed` or all connections gives a number that FALLS when the database gets worse, so a data-quality problem reads as an audience shift |
| Guessing the home state from the largest one | Usually right, and the one station it is wrong for gets a confident wrong headline. `STATION_REGION` or the figure is withheld |
| Calling the in-market figure a coverage area | It is a whole STATE. A listener in Dallas counts as inside KPFT's "market" |
| Rendering a blank grid | "No database", "wrong database" and "no data yet" are three problems with three different fixes. `readiness()` keeps them apart |
| Painting a one-listener state as empty | Any listener gets at least band 1 |

---

## 6. Where it is going

> **Sequencing lives in [`docs/PHASE-PLAN.md`](docs/PHASE-PLAN.md)** — one
> document, seven phases, with entry and exit conditions and the decisions
> already made so they are not re-litigated. Planning had spread across five
> documents carrying four separate build orders; that consolidation happened
> 2026-08-31. The list below is the historical record of what shipped and in
> what order, not the plan.

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
7. ✅ **Per-station alert recipients** (2026-08-31). Each station owns an
   explicit `alerts: { enabled, recipients }` list in the config store, edited
   with the **Alerts** button on its card in the admin panel, with Edit and Test
   on every row. `ALERT_EMAILS` / `ALERT_CC` / `ALERT_STATIONS` seeded those
   lists once and are never read again — **there is no send-time fallback**.
   The weekly roundup follows the same lists, one report per station.
   **The load-bearing part is that one message never spans two stations** — §8
8. ✅ Listener analytics page — audience as its own destination, station-scoped,
   with per-channel and per-mount breakdowns and CSV export
9. 🔶 **Audience page phase 1** — [`docs/AUDIENCE-ROADMAP.md`](docs/AUDIENCE-ROADMAP.md)
   §4. ATH against the SoundExchange threshold ✅ and trend vs previous period ✅
   shipped 2026-08-28; the headline cards were rebuilt as **rolling windows** ✅
   2026-09-01 (§5e). Still to do: day-of-week × hour heatmap, audience retained
   through an outage, per-mount trend over time, and **month-to-month by name**
9b. **Month-to-month, by name — "October vs September".** The rolling cards
    deliberately cannot answer this; a GM writing a board report or a funder
    update asks about a NAMED month. **Date-gated, not effort-gated:** recording
    began 2026-08-04, so August is partial and can never be an honest term.
    September is the first complete month, October the second, so the first
    truthful comparison is **available 2026-11-01**. The data is already safe —
    hourly rollups are never pruned. Rules it inherits, and why shipping it early
    reintroduces the `+376%` artefact, in
    [`docs/AUDIENCE-ROADMAP.md`](docs/AUDIENCE-ROADMAP.md) §4 item 6 and
    [`docs/PHASE-PLAN.md`](docs/PHASE-PLAN.md) item 2.6
10. Fleet view
10b. **Icecast admin access** — scoped 2026-08-31 in
    [`docs/ADMIN-ACCESS-SCOPE.md`](docs/ADMIN-ACCESS-SCOPE.md). Both production
    hosts already answer `/admin/listclients` with 401, so this is gated on one
    credential, not on Pacifica changing anything. Unlocks TSL, real (not
    estimated) ATH, player breakdown, geography, and the one nobody else can
    build: how much of an audience actually returned after an outage.
    **Two decisions come before any collection** — storage (this is where the
    "SQLite not needed yet" note expires, at ~630k rows/day) and listener
    privacy (`listclients` returns IP addresses and this dashboard is public).
    Build plan in [`docs/DEEP-ANALYTICS-PLAN.md`](docs/DEEP-ANALYTICS-PLAN.md):
    go as deep as the data allows and show every limitation on screen, via one
    confidence envelope rather than a sentence per panel. **Two items in it need
    no credential at all** — the confidence system, and programme-level audience,
    which only needs the now-playing title to be STORED instead of discarded
11. **SMS alerting** — [`docs/SMS-ALERTING.md`](docs/SMS-ALERTING.md). ~$3–4.50/mo
    plus a one-time ~$15–20 10DLC registration. **Unblocked** — item 7 shipped
    the per-station routing it was waiting for. Phone numbers go in the same
    `alerts` block, and `sendGroupedAlert()` is the seam that already guarantees
    one station's incident reaches only that station's people
12. Roles and multi-user — **only when a real GM asks for a login**

Two design rules already decided:

- ~~**Two panels, not one.**~~ **Resolved 2026-08-31, differently than written.**
  The note assumed GM-versus-technician and therefore two kinds of login. The
  real division is **public versus private**: one narrow, `noindex` public status
  page for reading during an emergency, and everything else behind the single
  existing admin credential. No per-user roles, no GM accounts. See
  [`docs/PHASE-PLAN.md`](docs/PHASE-PLAN.md) Phase 7.
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
- **ONE ALERT MESSAGE MUST NEVER SPAN TWO STATIONS.** Alerts are consolidated so
  an incident produces one email rather than five. That consolidation predates
  multi-station support and grouped by NOTHING. Now that recipients are
  per-station, and because these stations share Icecast hosts — so a server-side
  fault fails all of them in the same second — an ungrouped consolidated message
  goes to whichever station sorts first, tells them about stations in other
  cities, and tells everyone else nothing. Grouping lives in
  `sendGroupedAlert()`, the single point every alert passes through, and
  `sendAlert()` resolves recipients from the entries' own station rather than
  from a list a caller passes in. **A new alert type must call
  `sendGroupedAlert()`, not `sendAlert()` directly** — the two dead-air paths
  call `sendAlert()` and are safe only because they are single-stream by
  construction. `test/alert-recipients.test.js` reproduces the four-station
  shared-host cycle.
- **THERE IS NO RECIPIENT FALLBACK, and putting one back is a regression.**
  `ALERT_EMAILS`, `ALERT_CC` and `ALERT_STATIONS` seed the store once at
  migration and are never read again. A send-time fallback is what let the panel
  display one list while a different one was emailed — the banner said "2
  recipients" directly above a list saying "none set", and the two addresses that
  actually received KPFT's alerts could not be seen, edited or corrected from the
  screen whose entire job is managing them. `test/alert-stations.test.js` and
  `test/roundup-recipients.test.js` are regression guards: they set those
  variables and assert none of them reaches a send.
- **The migration is guarded by a `meta` marker, not by "has any station got
  alerts".** An operator who clears the last address from every station must not
  look like a fresh volume and get the env list written back underneath them.
  Verified against a running instance: cleared, restarted, still cleared.
- **A station with no `alerts` block is ON with nobody on it.** Not muted. It
  sends nothing because there is nobody to send to, and `describeAlertRouting()`
  says exactly that — "no recipients have been added yet", which is a to-do an
  operator can act on. A silent mute looks identical to a working configuration.
- **The weekly roundup is one report PER STATION**, addressed to that station's
  own list, scoped to its own channels, and timed in **its own timezone**. Its
  once-a-week marker and its retry counter are per station too: one shared marker
  meant the first station to send declared the week finished for all of them, so
  the others would silently never receive one. Adding a station-wide send back is
  the same class of bug as an ungrouped alert.
- **A gated page and its assets must be gated together.** `ADMIN_PAGES` in
  server.js lists individual paths, so both directions break quietly: an
  un-gated page borrowing a gated stylesheet renders unstyled for exactly the
  visitor being turned away, and a gated stylesheet whose page is not gated
  protects nothing. A standalone `/station.html` shipped with this bug and it was caught by a
  302 on a stylesheet. `test/admin-pages-gate.test.js` walks the set.
- **Icecast counts our own probes as listeners.** Measured: one connection took
  `/kpfk` from 1 listener to 2. So the Icecast snapshot is fetched BEFORE any
  probe opens a connection, and the non-primary mounts are probed only every
  `VARIANT_PROBE_EVERY` cycles. Making the cycle "faster" by fetching the
  snapshot and probing in parallel again would corrupt every audience figure
  the system stores, permanently and invisibly.
- **THE AUDIENCE CARDS ARE ROLLING WINDOWS, NOT CALENDAR PERIODS, and putting
  calendar periods back is a regression.** They are the last 24 hours, 7 days and
  30 days, each against the window of equal length immediately before it. A
  calendar period spends most of its life partly elapsed: on 1 September the page
  read **415 for "This month" beside 1,809 for "This week"** — a month smaller
  than the week inside it — and it was reported as catastrophic data loss by the
  operator, who was right that it made no sense and wrong that anything was lost.
  `30d ⊇ 7d ⊇ 24h` is now true by construction. `test/listener-counts.test.js`
  asserts the nesting and asserts every window is its full length on the 1st of a
  month and five minutes into a Monday. **Calendar months are not gone** — they
  belong where naming the period is the point (§6 item 2.6, due 2026-11-01).
- **A ROLLING WINDOW IS THE SAME SPAN IN EVERY TIMEZONE, which retired a whole
  class of bug rather than fixing it.** A calendar month starts at a different
  instant in every zone, which once measured the network over a window no station
  kept: "All stations · This month" read 805 beside KPFT's own 10,560. There is
  no per-station boundary left to disagree about.
  `test/aggregate-not-less-than-part.test.js` now asserts the result does not
  depend on which zone is named. The `groups`/`timeZone` argument survives only
  because the payload still reports which clock the CHART is drawn on.
- **NEVER COMPUTE A PERCENTAGE ACROSS TWO DIFFERENT KINDS OF MEASUREMENT.** Raw
  samples last `SAMPLE_RETENTION_DAYS` and then compact to hourly rollups, so any
  window longer than that compares a per-minute present against an hourly past —
  and hourly averaging flattens every spike, so one side's "peak" is a peak MINUTE
  and the other's is a peak HOUR. Measured on production 2026-09-01: **+887% on
  peak and +989% on average** from a previous window holding 33 readings against
  1,969. Withholding it would hide it for ever, because a 7-day window will always
  outlive raw retention — so `concurrentBetween(ids, from, to, 'hour')` coarsens
  the finer side and the percentage comes from the levelled pair, while the
  headline peak stays at full resolution. `comparisonResolution` says which basis
  was used and the card prints it.
- **Never compute a percentage against a partially-recorded window.** Tune-ins
  exist in raw samples for the retention window and on rollups only for hours
  compacted since the feature shipped. An older window returns a partial total,
  and dividing by it manufactures a number a station would repeat in a board
  meeting. `totalListenersComparable: false` withholds reach;
  `concurrencyComparable: false` withholds peak and average. **Both flags exist
  because they fail for different reasons and one can be true while the other is
  false** — the original bug was that only reach was gated while its two
  neighbours, built from the same pair of windows, were not.
- **THE COVERAGE CHECK COUNTS WHOLE HOURS, AND THE EDGES ARE EXCLUDED ON PURPOSE.**
  `now` is never on an hour boundary, so a window's first and last hours are
  fractions, and an hourly rollup sits on an exact boundary and can never fill a
  fraction. Counting the edges left every rollup-backed window permanently 1–2
  hours short of its own span, which withheld the 7-day and 30-day comparisons
  **for ever** — shipped, and caught only by asking why a comparison that should
  have started working had not. `hoursCovered` counts buckets fully inside the
  window; callers compare it against the hours the window fully contains.
  `COMPARISON_COVERAGE_FLOOR` (0.9) then allows a real gap: demanding 100%
  meant one missed hour (24 Aug 01:00) voided a whole week.
- **Reach is the headline, not concurrency.** "How many listened" and "how many
  at once" differ by four to nine times on this record. The concurrent figure is
  about server load; reach is what a listener-supported station reports to
  funders. `totalListeners` leads the audience page and must stay there — this
  was got wrong repeatedly before it was got right.
- **Three different audience questions, and only one is answerable today.**
  *Concurrent* is how many connections are open at an instant — that is what we
  measure. *Plays* is how many times someone started listening. *Distinct
  listeners* is how many different people. One person tuning in three times is
  three plays and one listener, and neither equals a concurrent count. Never
  label a concurrent figure as either: `getListenerCounts()` returns an
  `unavailable` block with a null and a distinct reason for each, precisely so
  the UI has something honest to render. Definitions in
  [`docs/AUDIENCE-ROADMAP.md`](docs/AUDIENCE-ROADMAP.md) §1.5.
- **When distinct listeners do arrive, they are a PROXY.** The industry
  definition is a unique IP + user-agent pair, so a household or office behind
  one NAT collapses to one, and one person on a phone and a laptop counts as two.
  Label it wherever it is shown, the way ATH is labelled an estimate.
- **The dashboard mount row must stay OUTSIDE `.stream-header`.** It began
  inside `.stream-info`, which is a flex child sharing the header line with the
  status badge — so the chips only ever received about three quarters of the card
  and a three-mount channel wrapped onto three lines. That was restyled three
  times before the cause was found, because the cause was structural and every
  attempted fix was cosmetic. `.stream-mounts` is now a direct child of the card
  and gets its full width. If it ever wraps again when it should not, check where
  it sits in the DOM before touching the CSS.
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
- **STATION-SPECIFIC VOCABULARY NEVER BECOMES A WIRE FORMAT.** `faultSplit`'s two
  sides were `kpft` and `pacifica` — station names used as a generic enum for
  "which side of the handoff failed". Every Icecast station has those two sides,
  so on production it reported **WBAI New York's outages with `side: 'kpft'`**.
  Now `source` / `server` / `unknown`; the value is computed on every read and
  was never persisted, so nothing stored changed, and readers still recognise the
  old names. An enum, API field or CSS class named after one customer is
  invisible until a second customer exists and expensive by then.
  `test/fault-side-vocabulary.test.js` fails on ANY station name used as a
  category value, not just these two.
- **WHAT A MESSAGE SAYS IS SCOPED THE SAME WAY AS WHO IT IS SENT TO.** Recipients
  became per-station so KPFT's GM is not paged about Los Angeles; the message
  BODY was not, and every alert ended with an "ALL STREAMS OVERVIEW" rendered
  from every stream the monitor watches. A KPFT outage therefore reached
  gm@kpft.org carrying WPFW's, KPFK's and WBAI's live listener counts — the same
  cross-station exposure per-station recipients exist to prevent, one layer down
  where nobody looked. `sendGroupedAlert()` already guarantees the entries in a
  message share a station, so the body has a station to scope by.
  `test/alert-email-scope.test.js`, whose second case asserts the station's OWN
  channels still appear — so it cannot be satisfied by showing nothing.
- **A scoped feature needs the client to pass the scope.** `/api/test-alert`
  took a `stationId` and the panel never sent one, so the server fell back to
  "every stream" whenever more than one station existed. The server fix was
  written and verified; the caller was not, and the bug shipped looking fixed.
- **`stationAlerts` MUST NOT LEAVE `getStatus()`.** It rides on each flattened
  stream so the alert path can resolve recipients mid-send without re-reading
  configuration. `getStatus()` spread the stream straight into its response, and
  that response is `/api/status` and `/api/diagnostics` — **both public**. The
  monitor published every station's recipient list to anyone who loaded the
  dashboard's own API, live, until it was found by grepping public responses for
  anything address-shaped. **redact.js could not have caught it**: that module
  projects EVENTS and STATION CONFIG, and this arrived through neither. Stripped
  at the source, not in a projection, because two public routes read it and
  nothing forces a third through redaction.
  `test/public-status-redaction.test.js` scans every public accessor, and its
  first case asserts the alert path can STILL see the recipients — so the guard
  cannot be satisfied by breaking alerting.
- **EVERY route returning stored events must redact or require a session.**
  `/api/history` is the older sibling of `/api/events` and was missed when
  redaction was added to that one, so it went on returning `getIncidents()`
  verbatim — publishing the Icecast servers' contact addresses, and ready to
  publish real alert recipients the moment a station with recipients had an
  outage inside its 24-hour window. `test/route-redaction.test.js` checks the
  ROUTES, not the projection, because redact.js was never the thing that failed.
- **Grep public responses for address-shaped strings after adding any field.**
  This is now the second time a field added to a stored object walked into a
  public response — `/api/events` did it with delivery records on 2026-08-27,
  which is why redact.js exists at all. The check that found both is the same
  one line: fetch each public endpoint and grep for `@`.
- **TUNE-INS ARE FROZEN AT COMPACTION, AND prune() RUNS EVERY CYCLE.** The
  figure is computed from raw samples as they expire, because the samples are
  then destroyed and nothing can recompute it. prune() therefore almost always
  sees ONE expiring sample, and treating the first sample of a batch as
  "everyone already connected" adds the whole listener count once a minute
  instead of once a period — turning the stored figure into listener-MINUTES
  under the name tune-ins, wrong by about sixty times. Production carried
  tuneIns=2956 for a KPFT Main hour that averaged 50 listeners and peaked at 57,
  and a month-to-date reach of 270,436 against a week of 520. The previous
  reading is now carried across prune calls in `meta.compactCarry`.
  **Any test for this must drive prune() one sample at a time**; a single-batch
  test passes against the bug. `test/tunein-compaction.test.js` — all six cases
  fail against the old code, verified.
- **A number that cannot be recomputed must be erased, not corrected.** The
  wrong tune-in figures could not be recovered — the samples behind them were
  gone. `repairTuneIns()` deletes them once, so those hours report as
  *unrecorded* (`hoursMissing`), which every reader already handles, rather than
  continuing to publish a figure wrong by sixty times.
- **A MOUNT PATH IS NOT UNIQUE ACROSS SERVERS.** This deployment serves two
  different `/wpfw_128` mounts on two different hosts. `snapshotForStream()` in
  diagnose.js exists for this on the measurement side — one global snapshot
  indexed by bare path once made WBAI's mounts read as missing while a
  same-named mount inherited Pacifica's audience. The lesson was then
  **reintroduced on the configuration side** in the admin mount inventory, which
  keyed "who already owns this mount" by path alone and reported the Pacifica
  `/wpfw_128` as belonging to a channel on the other host. Anything mapping
  mounts to anything else keys by **host + path**: `discover.mountAssignments()`,
  with `test/mount-assignments.test.js` on the real colliding fixture.
- **Checking a mount must not open a connection.** The admin panel verifies a
  new mount against the inventory the monitor already holds, which is free. A
  probe proves more — Icecast can list a mount it will not serve — but every
  connection is counted as a listener, so a probe is something a person presses,
  never something a form does while you type.
- **A STATION IS A GROUPING; A DASHBOARD CARD IS A CHANNEL.** `flattenChannels()`
  turns every channel of every station into its own monitored stream, and the
  dashboard renders one card per stream. Putting two channels under one station
  does NOT merge their cards, their probes, their uptime bars or their alert
  histories — it changes who is emailed, which timezone the roundup uses, and
  what the Audience page adds together. KPFA is one station on two Icecast hosts
  and correctly shows two cards. Say this plainly when asked; getting it wrong
  argues an operator out of the right fix.
- **A MOUNT IS NOT A CHANNEL, and the choice is destructive in one direction.**
  Adding a second server's stream as MOUNTS on an existing channel merges them
  into one card with one probe and summed listeners, silently ending independent
  monitoring of a whole Icecast server. Adding it as a CHANNEL keeps both. The
  admin handover adds a channel; anything built near this must too.
- **NEVER PRE-RESOLVE A CONFLICT THAT CARRIES INFORMATION.** `freeStationId`
  de-conflicts a taken station id at discovery time so a station monitored on a
  second server can be added without hand-typing an id. Correct — but the
  collision was ALSO the only evidence that the pasted stream belongs to a
  station already being watched, and resolving it silently turned a guided error
  ("use Edit, then + Add a channel") into a duplicate station that split one
  station's audience across two pages. It now returns `existingStation` alongside
  the free id. `test/existing-station-handover.test.js` asserts the pairing for
  EVERY monitored station, not just the one that broke.
- **A WARNING THAT COMPETES WITH A PRIMARY BUTTON LOSES.** The offer to add a
  rediscovered stream to its real station first shipped as a note above the form,
  with "Add station" still styled primary. On first real use the note was read
  and the primary button pressed anyway, recreating the duplicate. When the
  system knows which action is right, that action must BE the primary button —
  a louder warning is not the fix.
- **The channel editor must never offer a field for a channel id.** Ids key every
  sample, rollup and event. A new channel's id is GENERATED from its name and
  shown before saving; an existing one is read from the row and is not editable.
  Reusing an id attaches a channel to another's history; renaming one orphans it.
- **A failed request must say what failed.** `api()` keeps a non-JSON body and
  `failureText()` turns it into something an operator can read down a phone.
  `res.json().catch(() => ({}))` discards exactly the evidence needed, and every
  route that can throw must return JSON — express's default HTML error page
  reaches the panel as an empty object and renders as a generic message.
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
- **A skip is not a pass, and a guard that hides a load error is worse than no
  guard.** `device-store.test.js` used to catch a failed `require` and turn it
  into a skip, so on Node 20 it reported green while 26 other files died on the
  same missing module. If a module is mandatory, require it plainly and let it
  throw. §5h.

---

## 9. Verifying a change

```bash
npm test                                             # 548 tests, on Node 24 (`nvm use`)
node --check server.js monitor.js store.js diagnose.js auth.js

# Against production
curl -s .../health
curl -s .../api/stations   | jq     # what it thinks it monitors
curl -s .../api/status     | jq     # per-channel state and variant counts
curl -s .../api/diagnostics| jq     # the Icecast inventory it can see
curl -s '.../api/stats?days=1' | jq .storage    # event count, oldest event

# The audience cards. Station scoping is `stationId`, NOT `station` — a wrong
# name is silently ignored and you get every station's figures instead.
curl -s '.../api/listeners?days=7&stationId=kpft' | jq '.counts | {day,week,month}'
```

**The audience invariant, checkable in one line:** `day ≤ week ≤ month` for
`totalListeners`. If a longer window ever reports less than a shorter one,
something has reintroduced calendar periods or broken the window arithmetic.

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
   rather than assuming. **Due in days, still unmeasured as of 2026-09-01.**
6. **Is the 7-day audience rise real?** The week card reads +79.2% peak / +71.1%
   average against the previous week. KPFT HD3 (`/classic_country`) started
   2026-08-29 — inside the current window, absent from the comparison one — so
   part of that may be a channel appearing rather than listeners arriving. Check
   before anyone quotes it to a funder. Phase plan item 0.6.
7. **Where does month-to-month belong on the page?** Item 9b is dated
   (2026-11-01) but not designed. The rolling cards must stay the headline — they
   answer "how are we doing right now" — so a named-month comparison is a second
   surface, not a fourth card. Undecided whether it lives on the audience page,
   the history page, or the roundup email.
