# Icecast Monitor — Future Development Scope

> **Status: brainstorming / scoping document.** Nothing here is committed. Its job
> is to turn "add an admin panel and more stations" into a set of decisions we can
> argue about before any of it is built.
>
> Written 2026-08-26 against the current single-station build; corrected
> 2026-08-27 after measuring the live deployment. Figures sourced from the
> production `/api/stats`, `/api/events` and `/api/config` endpoints, from live
> fetches of both Icecast hosts, and from local serialisation timings — except
> the memory/CPU figures in §3.3, which are a local simulation of the container,
> not a measurement of it.
> For what exists today see [`README.md`](README.md) and [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md).

---

## 0. The short version

We have a monitoring engine that is genuinely better than the commercial options
in one specific way: **it can tell the difference between "our probe failed" and
"listeners actually lost audio."** That distinction is the whole product. Almost
everything below is about applying that engine to more stations and putting it in
front of people who are not the person who built it.

**Sequencing decision (2026-08-27): build the admin panel before adding the
stations.** Adding five stations by config file builds the configuration path
twice; building the panel first makes those five stations its test data, and the
affiliates then arrive through the same workflow rather than a second one. See
§5 and §10.

Three findings shape the scope:

| # | Finding | Consequence |
|---|---------|-------------|
| 1 | The 5 sister stations share one Icecast host, and we already fetch all of it | Network-wide monitoring is mostly configuration, not new engineering |
| 1b | ~28 **affiliates** share a second host (`stream.pacificaservice.org`) | ~33 stations for roughly the cost of one. Affiliates are more rows, not a new architecture |
| 2 | ✅ **FIXED** — we were monitoring 3 of KPFT's 6 mounts and undercounting its audience | Channel model shipped 2026-08-27; measured live 57 → 88 listeners. See §3.1 |
| 3 | The engine is a set of module-level singletons over flat JSON files | Multi-tenancy is a real refactor, and it is the critical path for everything else |
| 4 | ✅ **FIXED** — Icecast 2.4.x emits invalid JSON and we treated that as "server down" | Real, and blocking for the affiliate wave. **It has never occurred on KPFT** (0 of 443 production events), so it was not the emergency it was first described as. See §2.3 |
| 5 | Roughly a third to a half of real stations expose `status-json.xsl` | The diagnosis engine needs a discovery-adapter layer and an honest degraded mode — see §2.4 (sample of 10 usable hosts; treat as indicative, not a survey) |
| 6 | ✅ **FIXED** — 32% of production events carried `listenerImpact: 'unknown'` | Status fetch now retries before declaring Icecast unreachable. See §3.4 |

---

## 1. What we already have

Worth being explicit about, because it is more than it looks like from outside
and it determines what "expansion" actually costs.

### The engine ([`diagnose.js`](diagnose.js), 833 lines)

- **Instrumented probe** — per-phase timing (DNS, TCP, TLS, first byte), not just
  a 200/not-200.
- **Cause classification** — a catalog mapping Node error codes to
  operator-readable causes, with per-cause remediation text.
- **Dead-air detection** — pulls an audio chunk, computes RMS, escalates on
  sustained silence with an aggressive re-probe loop.
- **Server-vs-station correlation** — this is the crown jewel. It holds the full
  mount inventory of the Icecast host, so it can answer *"is it just us, or is
  the whole server down?"* by checking whether sibling mounts survived.
- **Listener-impact verdicts** — `confirmed` / `unknown` / `none`, derived from
  whether Icecast kept serving the mount through the failure.

### The record ([`store.js`](store.js), 1800+ lines)

- Permanent event log, never pruned by age.
- Raw samples for 7 days, compacted into permanent hourly rollups.
- **Audience loss modeling** — hour-of-day listener profiles, so an outage at 3am
  and an outage at drive time are not reported as equally costly. Produces
  "listeners cut off" and "listening hours lost."
- Atomic writes; split files so a corrupt sample file cannot destroy incident history.

### The policy ([`monitor.js`](monitor.js), 1700+ lines)

- Alerts gated on **listener impact, not probe failure**. This was learned the
  hard way: of 21 alerts under the old rules, 12 were 60-second probe resets that
  cost nobody anything, and they trained recipients to ignore the real ones.
- Episode model — at most two emails per incident (confirmed, recovered).
- Weekly roundup that sends *even when nothing broke*, so a quiet week is
  distinguishable from a monitor that silently died.

### The honest constraints

| Constraint | Detail | Why it matters for expansion |
|---|---|---|
| **No authentication** | Zero. The dashboard is unlisted, not protected | An admin panel cannot ship without auth. This is new build, not a tweak |
| **Almost no test suite** | 8 tests exist (`npm test`, added 2026-08-26) covering status-document parsing only | A multi-tenant refactor of a 1700-line stateful module is still effectively untested. This is the real Phase 0 blocker |
| **Single-tenant by construction** | `streams`, `snapshot`, `prevSnapshot`, `streamStatus`, `episodes`, `silenceState` are module-level singletons; `ICECAST_STATUS_URL` and `SIBLING_MOUNTS` are single env vars | Every one of these becomes per-server state |
| **Flat-file store** | Whole-file JSON rewrite on a timer | See the scaling math in §3.3 |
| ~~**Fragile status parsing**~~ | ✅ Fixed 2026-08-26: tolerant parse + regression tests | Was blocking the affiliate wave; never affected KPFT (§2.3) |
| **Config is env vars** | Streams via a `STREAMS` JSON env var; recipients via `ALERT_EMAILS` | An admin panel means config moves to the database and env becomes bootstrap-only |

---

## 2. Finding 1 — The Pacifica network is already in our hands

### 2.1 The five sister stations

A live fetch of `streams.pacifica.org:9000/status-json.xsl` returns **15 mounts
across all five sister stations**:

| Station | Mounts | Listeners (sample) |
|---|---|---|
| WPFW (Washington) | `/wpfw_128` | 78 |
| KPFK (Los Angeles) | `/kpfk`, `/kpfk_128`, `/kpfk_64` | 47 |
| KPFT (Houston) | `/live_128`, `/live_64`, `/HD3`, `/HD3_128`, `/HD3_64`, `/classic_country` | 52 |
| KPFA (Berkeley) | `/kpfa`, `/kpfa_16`, `/kpfa_64` | 13 |
| WBAI (New York) | `/wbai_128`, `/padma` | 10 |

**We fetch and parse all of this, every 60 seconds, today.** `fetchIcecastSnapshot()`
deliberately keeps the complete mount list — that is what makes the
station-vs-server correlation work — and then we discard the 9 mounts that
aren't KPFT's.

This changes the pitch entirely. It isn't "let us build you a monitor." It's
**"we have been recording your uptime for months; here is the dashboard."** The
diagnosis engine's hardest feature — cross-station correlation — gets *better*
with each station added, because a fault that hits four stations at once is
provably the server and not anyone's studio.

### 2.2 The affiliates are on a shared host too

Pacifica has ~200 affiliate stations. The instinct is that this means ~200
Icecast servers to discover, configure and poll. **It does not.** A live fetch of
`stream.pacificaservice.org:9000/status-json.xsl` (Icecast 2.4.4) returns
**39 mounts covering roughly 28 affiliate stations**, identified by call sign:

```
kbcs  kcei  kciw  kcpk  kepw  kglp  khen  khoi  kkfi  kocf  kodx  kpsq  krfp
ktim  kvmr  kyaq  kyrs  wdbx  weru  wgot  wiox  wjff  wmpg  wojb  wooc  wslr
wuwu  studio51
```

Two consequences:

1. **Two snapshot fetches per minute cover 5 sister stations and ~28 affiliates.**
   Affiliates are not a different architecture — they are more rows in the same
   tables. The per-host snapshot cache in §4 is what makes this nearly free.
2. **It independently confirms the channel/mount model in §3.2.** `/kvmr`,
   `/kvmr_32` and `/kvmr_64` are one station's three bitrate variants; `/weru`,
   `/weru_128`, `/weru_64` likewise. Any per-mount model double-counts these
   stations' audiences and misreports a single-variant failure as an outage.

The remaining affiliates will be scattered across their own servers and
commercial hosts, and they are the hard case — see §2.4.

### 2.3 ✅ Icecast emits invalid JSON — fixed 2026-08-26

> **Status: fixed and tested.** `parseIcecastStatus()` in [`diagnose.js`](diagnose.js)
> repairs the malformation before parsing; 8 regression tests cover the class
> (`npm test`). Verified live: the affiliate host went from `reachable=false,
> 0 mounts` to `reachable=true, 39 mounts`, and KPFT's host is unchanged
> (`repaired=false`).
>
> **Severity, honestly stated.** This was first written up as a live threat to
> KPFT. The production record does not support that: of 443 stored events, **zero**
> were caused by a parse failure. It is a genuine defect and it genuinely blocks
> Wave 2 — but on KPFT it was latent, not active.

The affiliate host's status document does not parse:

```
"stream_start_iso8601":"2026-08-26T18:32:51-0500","title": - ,"dummy":null
```

A bare `-` sits where a JSON string belongs. Icecast 2.4.x writes an unquoted
placeholder when a mount's `title` metadata is empty, producing a document that
`JSON.parse` rejects.

**Root cause.** [`diagnose.js:429`](diagnose.js#L429) assumes the status endpoint
returns strictly valid JSON. When the parse throws, the catch block returns
`{ reachable: false, fetchErrorCode: 'EPARSE' }` — which makes *"the server sent
malformed metadata"* indistinguishable from *"the server is unreachable."*

**Why it matters far beyond affiliates.** Follow it downstream:

```
JSON.parse throws
  → snapshot.reachable = false
    → assessListenerImpact() returns 'unknown'      (diagnose.js:771)
      → warrantsAlert() returns true                (monitor.js:106)
        → every probe blip emails everyone
```

One station anywhere on `streams.pacifica.org` putting an odd character in their
title metadata breaks the snapshot for **KPFT's** monitor, silently disables the
listener-impact gate, and restores the alert-noise problem the gate exists to
solve. The station whose metadata caused it need not be KPFT.

**Fix — two parts, and the second matters more than the first:**

1. **Tolerant parse.** Repair the known malformation (unquoted scalar after a
   key) before parsing; on total failure, fall back to regex-extracting
   `listenurl`/`listeners` pairs, which recovered all 39 mounts from the broken
   document in testing.
2. **Stop conflating parse failure with unreachability.** A malformed response is
   positive proof that Icecast is *up and answering*. `EPARSE` must be its own
   state — `reachable: true, parsed: false` — so the impact gate can still reason
   about server liveness instead of falling back to `unknown`.

A sweep for the same class found **one** other place remote data is parsed —
there is none; the other two `JSON.parse` sites read a local file and an env var,
both already guarded. This is a single-site fix.

### 2.4 Can we scan *any* Icecast server?

Short answer: **the probe is universal, the diagnosis is not.**

`probeStream()` speaks plain HTTP and works against any audio stream — Icecast,
SHOUTcast, a CDN edge, anything that returns audio bytes. Uptime, response time,
dead-air detection and cause classification from network errors all work
anywhere.

But every high-value feature depends on `status-json.xsl`: listener-impact
gating, mount-vanished detection, real audience counts, source-reconnect
timing, and server-vs-station correlation. Without it we get a conventional
uptime monitor — which is the thing we are trying not to be.

**Empirical result.** Twelve real third-party stations tested:

| Discovery outcome | Count | Examples |
|---|---|---|
| ✅ Full `status-json.xsl` | 4 | WFMU (2.4.4, **38 mounts**), Pacifica (2.4.3), CanStream UK (2.4.0-**kh22**), KBOO (2.4.99.2) |
| ⚠️ HTML `status.xsl` only | 2 | Radio Paradise (mounts + listener counts scrapeable), WERU |
| ❌ Nothing readable | 6 | WNYC, KCRW, Zeno, SomaFM, KEXP, WWOZ |

**A third expose what we need** — 4 of 12, or 6 of 12 counting the HTML-scrapeable
pair. This is a small, hand-picked sample chosen to span hosting styles, not a
survey; treat the ratio as indicative rather than measured.

> An earlier draft recorded KEXP and WWOZ as untested, because the first attempt
> used stream-specific CDN hostnames that failed DNS — a wrong method, not a
> result. Retested against their real hosts: KEXP redirects and its stream host
> presents a certificate for another name; WWOZ returns 404. Neither exposes a
> status endpoint, so the original count stands, now on evidence rather than a
> failed lookup. The split is not random: stations
running their own Icecast box expose the endpoint; stations behind a streaming
CDN or hosting provider expose nothing. Small affiliates skew toward the second
group, because outsourcing is exactly what a station without an engineer does.

Note also `2.4.0-kh22` — the widely deployed Karl Heyes fork, with a different
admin API surface. Version sniffing cannot be naive.

**Design implication: a discovery adapter layer**, tried in order at station
setup and recorded per host.

| Tier | Source | Yields | Verdict quality |
|---|---|---|---|
| 1 | `status-json.xsl` | Full mount inventory, listeners, metadata, `stream_start` | Full engine |
| 2 | `status.xsl` HTML scrape | Mount paths + listener counts (confirmed working on Radio Paradise) | Full engine, brittle |
| 3 | `/admin/stats.xml` + credentials | Everything, plus per-listener data | Best available |
| 4 | SHOUTcast `/statistics`, `/stats?sid=1`, `/7.html` | Listener counts | Partial |
| 5 | Probe only | Up/down, dead air, response time | Degraded — see below |

**The Tier-5 policy question is the important one.** For a station where we
cannot see Icecast, `listenerImpact` is permanently `unknown`, and today that
means alert-on-everything. That is the wrong default for a station we cannot
observe properly. Options: alert only after a longer confirmation window;
probe from two networks and require both to fail; or be explicit in the UI that
this station is on degraded monitoring and let its admin choose. **Whatever we
choose, it must be a per-station setting, not a global one** — and the station's
dashboard should say plainly which tier it is on, because "we can't tell whether
your listeners were affected" is information the GM deserves.

### 2.5 What this means for phasing

Affiliates do **not** need to wait for generic multi-tenancy. The realistic order:

- **Wave 1** — the 5 sister stations (one host, already fetched).
- **Wave 2** — the ~28 affiliates on `stream.pacificaservice.org` (one more host,
  same code path, needs only the tolerant-parse fix in §2.3).
- **Wave 3** — self-hosted affiliates with a working status endpoint; discovery
  adapter Tiers 1–3.
- **Wave 4** — CDN-fronted affiliates; Tier 4–5, degraded monitoring, honestly
  labelled.

Waves 1 and 2 together are ~33 stations for essentially the engineering cost of
one, and they are the demo that justifies everything after.

---

## 3. Finding 2 — We are measuring the wrong things

### 3.1 ✅ The audience undercount — fixed 2026-08-27

> **Status: fixed and tested.** Each stream now declares a `mounts` list and
> listener counts are summed across the channel (`diagnose.channelAudience()`).
> Verified live: **57 → 88 listeners**, so 35% of KPFT's audience had been
> invisible. 11 regression tests in `test/channel-audience.test.js`.
>
> Stream IDs are unchanged, so stored history stays comparable.
>
> **Follow-up, 2026-08-28.** This paragraph previously claimed samples carried
> `variantsPresent` / `variantsTotal`. They did not — those existed only on the
> live status record and were never written to a sample, so there was no
> per-mount history at all. They are now written, alongside a per-mount
> `mountListeners` breakdown, and the non-primary mounts are probed every fifth
> cycle so a mount that is listed but not serving is caught too. See
> `test/channel-degraded.test.js`.

The original analysis follows.

#### The original analysis

`DEFAULT_STREAMS` monitors three mounts. But mounts on this server are
**bitrate variants of the same channel**, not separate channels:

```
KPFT Main   → /live_128 (22)  + /live_64 (20)          ← we monitor only live_128
KPFT HD2    → /HD3_128 (4)    + /HD3 (1) + /HD3_64 (4) ← we monitor only HD3_128
KPFT HD3    → /classic_country (1)                      ← monitored
```

Dashboard shows **27 listeners**. KPFT actually has **52**. We are reporting
roughly half the station's audience, and — worse — the listener-loss model that
drives "listening hours lost" in the weekly roundup inherits that undercount.

> ⚠️ The mount→channel mapping above is inferred from `server_name` strings
> (`/HD3`, `/HD3_128`, `/HD3_64` all report "KPFT HD2 Live Stream"). It needs
> confirming with whoever runs the encoders before we hard-code it.

### 3.2 The model this implies

The current model is flat: `stream = one URL`. The real world is three levels.

```
Organization  (Pacifica Foundation)
   └── Station          (KPFT Houston)          ── GM, staff, alert recipients, timezone
         └── Channel    (KPFT Main / HD2 / HD3) ── what a listener would call "a station"
               └── Mount (/live_128, /live_64)  ── a bitrate variant; what we actually probe
                     └── on Host                ── an Icecast server; SHARED across stations

Hosts are a separate, global pool rather than a property of a station:

  Host  streams.pacifica.org:9000        → serves 5 stations
  Host  stream.pacificaservice.org:9000  → serves ~28 stations
  Host  someaffiliate.org:8000           → serves 1 station
```

**Why hosts are their own level, and not "the station's server".** Two facts
pull in opposite directions and only this shape satisfies both:

- **Many stations share one host.** All five sister stations are on one server;
  ~28 affiliates are on another. One snapshot fetch per *host* per cycle serves
  every station on it — this is what makes the affiliate wave nearly free (§2.2).
- **One station may span several hosts.** Most stations are a single stream on a
  single server, but a minority run more than one — a separate box for an HD
  feed, a backup server, a different provider for one channel. KPFT-shaped
  stations are the minority case that the model must not preclude.

So the fetch loop iterates **hosts**, deduplicated, and the station view
assembles its channels from whichever hosts they happen to live on. Getting this
wrong in either direction is expensive: assume one host per station and you
refetch the same Pacifica server 33 times a minute; assume one host per *system*
and a station with a second server cannot be represented at all.

What this buys us:

- **Correct audience** = sum of listeners across a channel's mounts.
- **Correct severity.** Today, if `/live_128` dies but `/live_64` keeps serving,
  we call it an outage. It isn't — it's a degraded channel, and listeners on the
  64k variant never noticed. That is a genuinely different alert, and arguably a
  more interesting one, because a single-variant failure points straight at one
  encoder rather than the studio.
- **A real "channel down" definition** — every mount gone, which is what the GM
  actually cares about.

### 3.3 Storage — measured, and much less of a problem than first written

> **This section originally claimed SQLite was "the single highest-leverage
> refactor" and should happen in Phase 0. That was wrong.** It extrapolated from
> the 90-stream case and from a mis-measured sample file. The corrected figures
> below are taken from the live deployment and from measured serialisation
> timings.

**What is actually on disk today:** 5.84 MB total — `events.json` 1.05 MB,
`samples.json` 4.78 MB. It grows by **~63 KB/day**, because raw samples are
capped at 7 days and only events (~49 KB/day) and hourly rollups (~14 KB/day)
accumulate. Ten years of permanent history lands around **229 MB**.

Storage volume is a non-issue and always was.

**What is real is write amplification.** Both files are re-serialised and
rewritten in full every 60 s, so persisting ~63 KB of new data costs ~8.4 GB of
writes per day. Measured projections:

| Scale | Mounts | On disk | Writes/day | Blocking write every 60 s |
|---|---|---|---|---|
| Today (KPFT) | 3 | 6 MB | 8 GB | 11 ms |
| **Phase 1 (5 sister stations)** | **15** | **28 MB** | **39 GB** | **54 ms** |
| + affiliate host | 54 | 100 MB | 140 GB | 194 ms |
| 90 streams | 90 | 166 MB | 234 GB | 323 ms |

**Corrected recommendation:**

- **Phase 1 needs nothing.** 28 MB and a 54 ms hiccup once a minute is
  comfortably within what flat JSON handles. Ship the five stations on the
  existing store.
- **Wave 2 (affiliates) is where it starts to matter** — ~200 ms of blocked
  event loop per minute begins to delay the probes themselves. Halving
  `SAMPLE_RETENTION_DAYS` buys most of that back without any code.
- **SQLite is worth doing before Wave 3 — or before per-listener analytics,
  whichever comes first.** Not before Phase 1. When it happens,
  `store.js`'s public API is a clean seam, and a single file keeps the "one
  persistent volume, no database server" deployment story intact.

Lowering `SAMPLE_RETENTION_DAYS` is safe for the audience model:
`getHourOfDayProfile()` reads rollups as well as raw samples, so listener-loss
estimates keep their full history — only the dashboard's raw-resolution window
shrinks.

### 3.5 Per-listener analytics moves the storage threshold

**Correction to §3.3.** That section concludes SQLite is not needed until roughly
fifty mounts. That holds for what is collected today — one sample per channel per
minute — and stops holding the moment individual listeners are recorded.

Audience analytics beyond counts (who, where, for how long) needs Icecast's
**admin** API rather than the public status endpoint, and it produces data of a
different order:

| | Rows per day |
|---|---|
| Today: 8 channels, one sample a minute | ~11,500 |
| Per-listener at ~250 concurrent, polled each minute | **~360,000** |

That is fifty times the volume on day one, growing with the audience rather than
with the station count. **Whichever arrives first — fifty mounts or the first
per-listener record — is the point to move off flat files**, and it should be
done before the collection starts rather than after, because migrating a
per-listener table is a great deal more work than migrating an empty one.

**Two prerequisites, both worth starting early because neither is code:**

1. **Icecast admin credentials for the Pacifica hosts.** The public status
   endpoint reports counts and nothing else. Everything in the audience-analytics
   ambition — geography, session length, returning listeners — is gated on
   admin access. It is a permissions conversation with a lead time, so it is
   worth asking for before anyone is ready to build.
2. **A retention and aggregation policy.** Listener IP addresses are personal
   data, which is a category this system has not held before. Deciding what is
   aggregated on the way in, and what is never stored at all, is much easier
   before collection than after. The allowlist projection in `redact.js` is the
   right machinery for it and already exists.

**What already works in your favour:** the *when* half needs no new collection.
Permanent hourly rollups carry `avgListeners` and `listenerPeak` per channel and
are never pruned — 399 hours for `kpft-main` already. Hour-of-day, day-of-week
and month-over-month trends are derivable from what is on disk today, and the
record grows whether or not anyone builds the views.

---

### 3.4 ✅ The `unknown` verdict — fixed 2026-08-27

> **Status: fixed and tested.** `fetchIcecastSnapshot()` now retries up to
> `ICECAST_STATUS_ATTEMPTS` times (default 3, 2 s apart) before declaring Icecast
> unreachable. A sustained outage survives every retry and still alerts exactly
> as before; an unparseable document is not retried. 7 regression tests in
> `test/status-retry.test.js`.
>
> The station's stated policy is unchanged and now actually enforced: **email
> when listeners were lost.** Blips that kick nobody off do not email.

The measurements that motivated it follow.

#### The original analysis

Of 443 events in the production record:

| | Count | Share |
|---|---|---|
| `listenerImpact: 'none'` (gate cleared it) | 146 | 33% |
| `listenerImpact: 'confirmed'` | 84 | 19% |
| **`listenerImpact: 'unknown'`** | **141** | **32%** |
| no diagnosis recorded | 72 | 16% |

And of 170 events where Icecast was unreachable, the causes were **131 socket
hang-ups, 35 timeouts, 4 TLS failures** — network flakiness reaching the status
endpoint, not server outages.

This matters because `unknown` alerts. The listener-impact gate was built to
stop probe-side noise from paging people, and it works well when Icecast
answers — but roughly a third of the time the monitor cannot reach its own
witness, and those events fall through the gate by design. 178 alerts have been
sent over 22 days.

**Status of the three proposed remedies:**

- ✅ **Retry the status fetch** before declaring it unreachable — **done**.
- ⏸ **Blocked on data, deliberately.** Whether a *brief* `unknown` should alert
  at all, or wait for a second consecutive unknown. The retry above targets the
  same cohort, so how much noise is left is an empirical question — adding a
  second suppression mechanism before measuring the first risks silencing real
  outages to fix a problem already solved. Re-measure around **2026-09-03**.
- 📋 **Phase 4 feature.** Probing the status endpoint from a second network path,
  which would settle "is it them or our connection" outright rather than
  inferring it. The strongest available fix and the largest; scheduled, not
  outstanding.

**Re-measure before doing more.** The retry lands on the same 32% cohort; how
much of it survives is an empirical question, and the answer should come from a
week of production data rather than from another estimate.

None of this is a bug — the current behaviour is the documented, deliberate
policy. But it is the largest remaining source of alert volume, and it is a
better use of Phase 0 than a storage migration.

---

## 4. Target architecture

```
┌─ Admin (authenticated) ─────────────────────────────────────────┐
│  Stations · Channels · Mounts · Recipients · Alert policy       │
│  Users & roles · Maintenance windows · Audit log                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ writes config
                            ▼
┌─ Config store (SQLite) ─────────────────────────────────────────┐
│  stations, channels, mounts, users, recipients, policies        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ read on change
                            ▼
┌─ Scheduler ─────────────────────────────────────────────────────┐
│  One snapshot fetch per HOST (not per station — the win from §2)│
│  Fan out mount probes · dedupe · backpressure                   │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─ Diagnosis engine (largely as-is, made pure) ───────────────────┐
│  classify(mount, hostSnapshot, prevSnapshot, cycle)             │
│  + new: channel-level rollup (degraded vs down)                 │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─ Event store (SQLite) ──────────────────────────────────────────┐
│  events · samples · rollups · audience model                    │
└───────────────────────────┬─────────────────────────────────────┘
              ┌─────────────┴─────────────┐
              ▼                           ▼
┌─ Notification router ──────┐  ┌─ Read API + UI ─────────────────┐
│  policy → who, how, when   │  │  Fleet view · Station view      │
│  email · webhook · SMS     │  │  Channel detail · History       │
│  escalation · quiet hours  │  │  Public status page             │
└────────────────────────────┘  └─────────────────────────────────┘
```

### Refactor sequence (this order matters)

1. **Leave the store alone.** Flat JSON carries Phase 1 comfortably (§3.3).
   SQLite is a Wave 3 concern — or a prerequisite of per-listener analytics,
   whichever arrives first (§3.5). Not a prerequisite of Phase 1.
2. **Make `diagnose.classify()` pure** — it mostly is. No module state.
3. **Turn `monitor.js` state into a `StationMonitor` class.** The singletons
   (`streams`, `snapshot`, `episodes`, `silenceState`) become instance fields.
   Run one instance for KPFT — identical behavior, still one tenant.
4. **Introduce the host-level snapshot cache** shared across stations.
5. **Move station config into the store**, env vars become bootstrap defaults
   (§5.1). This is the step the admin panel actually waits on.
6. **Then** the admin panel, the stations it adds, and the fleet view — in that
   order (§10).

Steps 2–3 are invisible to users and are where the risk lives. Do not let the
admin panel get built first — it is the fun part and it will pull the schedule.

**Before step 1: write characterization tests.** Not full coverage — capture the
current output of `classify()`, `getPeriodRollup()`, `getAudienceSummary()` and
the audience loss model against the real `data/events.json`, and assert the
refactor doesn't change them. Without this we will silently break the listener-
impact math and not find out until a weekly roundup quotes a wrong number.

---

## 5. The admin panel

> **Sequencing decision (2026-08-27): the panel comes BEFORE the stations.**
>
> An earlier draft of this document had Phase 1 add the five sister stations via
> a config file, with the admin panel following in Phase 2. That was wrong, for
> a reason worth writing down: it builds the configuration path twice. Stations
> would be hardcoded into an env array, then thrown away the moment the panel
> needed to write them somewhere.
>
> Building the add-station flow first means **the five sister stations become the
> test data for it** — the flow is dogfooded on stations we control before an
> affiliate ever touches it. It also settles §5.1 for free: config lives in the
> store, not in env.
>
> The cost is real and should be accepted knowingly: the "here is your dashboard"
> demo to Pacifica arrives later. If that demo has near-term political value,
> keep a throwaway env config to show it — and do not build anything on it.

### 5.0 Two panels, not one

The single most useful distinction in this whole section. "Administering the
system" and "managing my station" are different jobs, for different people, at
different frequencies, with different risk:

| | **Add a station** | **My station** |
|---|---|---|
| Who | Whoever runs the monitor; network engineering | GM, station staff |
| How often | Once, ever | Weekly |
| Tech level | Technical is acceptable | Must be genuinely simple |
| Risk if wrong | Adds probe load, wrong host, wrong mounts | Low |
| Restricted? | **Yes** | No |

Most GMs are not technical; some are. Designing one panel for both audiences
means either patronising the technical ones or losing the rest. Splitting the
surfaces means neither trade-off has to be made: **the GM-facing screen should
not feel like an admin panel at all** — it is "my alerts" and "how are we
doing" — while station creation stays with whoever runs the system.

This also answers "what stops a GM adding a station that isn't theirs": they
never see that surface.

### 5.1 Where configuration lives

**Decided: the store is authoritative; env vars seed it on first boot.**

Today every setting is a Coolify environment variable read once at startup, so
changing one means a redeploy. An admin panel means settings change while the
app runs. Both cannot be in charge, and leaving it ambiguous produces the
permanent bug "I changed it in Coolify and nothing happened".

| Stays in env (secrets) | Moves into the store (panel edits) |
|---|---|
| `SMTP_PASS` | Which stations are monitored |
| Session secret | Alert recipients |
| Admin password hash | Thresholds, quiet hours, timezone |

Secrets never need a UI, so they never conflict. Env changes to *settings* are
ignored after first boot, and that has to be documented where an operator will
actually read it.

**The storage already exists.** `store.getMeta()` / `setMeta()` persists across
redeploys — it is what remembers when the weekly roundup last sent. Admin config
can ride the same mechanism with no new infrastructure.

### 5.2 Progressive disclosure

One obvious path that works for everybody, with depth available underneath:

- **Simple (default).** Paste a stream URL. We discover the rest. Name it, add
  an email, done.
- **Advanced (collapsed).** Mount grouping, failure thresholds, quiet hours,
  dead-air sensitivity, custom status URL.

The discovery flow in §5.4 is what makes the simple path honest rather than a
stripped-down version of the real thing — a non-technical GM supplies *one*
piece of information and everything else has a working default.

### 5.3 Build order

1. **Move station config into the store**, out of env. Invisible; unblocks all of it.
2. **Login.** One admin, credentials in env. That is enough for one operator.
3. **Add-station flow** with discovery (§5.4).
4. **Add the five sister stations with it.** ← the dogfood moment.
5. ✅ **Per-station alert recipients** (2026-08-31). Shipped as a section on each
   station's card in the admin panel, NOT as the separate GM-facing screen this
   line anticipated — that split assumes the roles in step 7, which do not exist
   yet, so it produced two menus for one person. Revisit when step 7 lands.
6. **Fleet view** (§7).
7. **Roles and multi-user — only when a real GM asks for a login.**

Step 7 is deliberately last. The role table in §5.5 is speculative while there
is one operator, and building a permission system before it has users is how it
ends up maintained but never exercised.

### 5.4 Station setup — make it one paste

The add-station flow should not be a form with 14 fields. It should be:

1. Paste an Icecast status URL (or a stream URL — we can derive the host).
2. **We fetch it and show every mount we found**, with live listener counts.
3. Admin ticks the ones that belong to them and groups them into channels.
   Pre-group by `server_name` similarity and offer it as a suggestion.
4. Name the station, set timezone, add recipients. Done.

This is directly enabled by `fetchIcecastSnapshot()` — it already returns exactly
this inventory. **Discovery-driven setup is the differentiator** against every
competitor's "paste a URL and hope."

For a station with one Icecast server and one stream — **the common case, and
most affiliates** — this is a 30-second setup with two fields filled in.

**A minority of stations have more than one Icecast server**, so the flow must
allow "add another server" and attach its mounts to the same station. Keep it
out of the main path: one paste, then an unobtrusive *"This station has another
server"* link. The majority never sees it; KPFT-shaped stations are not forced
through a multi-server wizard they mostly do not need.

Because hosts are a shared pool (§3.2), pasting a URL that is already monitored
should say so and offer its existing mount inventory rather than adding a second
copy of the same server. Anyone adding a Pacifica affiliate will hit this on
their first attempt.

Note that step 3 is exactly the channel/mount grouping in §3.2, so the data model
and the setup UI are the same piece of work rather than two.

### 5.5 Roles — designed now, built at step 7

| Role | Can do | Who |
|---|---|---|
| **Superadmin** | Everything, all stations, add/remove stations and users | Whoever runs the monitor |
| **Network staff** | Read all stations, ack incidents, add annotations | Pacifica national / engineering |
| **Station admin** | Full control of *their* station: channels, recipients, policy | Station GM / chief engineer |
| **Station viewer** | Read-only, their station | Board ops, programming staff |
| **Public** | Public status page only, if enabled | Listeners |

Auth: start with a single admin credential, then email + password with
per-station scoping when step 7 arrives. Magic-link email login is worth
considering — this audience will forget passwords, and SMTP is already
configured and proven.

**On a two-screen login (username, then password):** it adds no security. It is
an identity-*routing* pattern — Google and Microsoft use it to choose an SSO
provider — and an attacker's script posts both steps as fast as one. Done
naively it is actively worse: if screen two only appears for valid usernames,
it is a username enumerator. Use it if the interaction is preferred, but always
advance to screen two, and put the real protection where it belongs: a scrypt
password hash rather than plaintext, `crypto.timingSafeEqual` comparison, rate
limiting and lockout, and a signed `httpOnly` / `Secure` / `SameSite=Strict`
cookie. Node's built-in `crypto` covers all of it with no new dependencies.

### 5.6 Other admin surfaces

- **Alert policy per station** — threshold, quiet hours, the
  `ALERT_ON_HARMLESS_OUTAGE` escape hatch, dead-air sensitivity.
- **Maintenance windows** — scheduled, suppresses alerts, still records events
  and marks them excluded from uptime. Essential; without it, planned transmitter
  work generates 3am pages and the alerts get muted permanently.
- **Test alert / preview** — already exists as an API, needs a button.
- **Audit log** — who changed what. Small effort, saves an argument later.

### 5.7 One station screen, not one per station

**Build the station view once and feed it data.** A dropdown (or ⌘K palette) in
the header selects which station's data fills it. There is no per-station page,
no per-station code, and no per-station maintenance — an improvement to the
screen improves it for all of them at once, whether there are five or three
hundred.

This is why the dropdown beats tabs, and the reason is not aesthetic: tabs imply
a fixed, small, known set. The moment the set is 33 the tab strip has to be
replaced, and replacing navigation late means re-testing every screen that hangs
off it.

Three constraints the shared screen has to respect:

1. **Render 1..N channels, never exactly 3.** KPFT has three channels; WPFW has
   one; a typical affiliate has one. The current dashboard's three-card layout
   encodes today's station shape and will not survive contact with the second
   station. A single-channel station should look deliberate, not like a
   three-column grid with two holes in it.
2. **Every station needs its own URL** — `/station/kpft`, not a dropdown that
   mutates hidden state. Without routing you cannot bookmark a station, send a
   GM a link to theirs, or deep-link from an alert email to the station that
   failed. That last one is the difference between an alert someone acts on and
   one they have to go hunting from.
3. **Remember the selection per viewer.** A GM opening the app should land on
   their own station, not on whichever one sorts first.

### 5.8 Reports and settings stay separate pages

The history page is the best *reporting* surface in the product and is what a GM
actually opens. Administration is rare and destructive-capable. Behind the same
login, but not the same page — otherwise someone browsing incidents is one
misclick from removing a station.

---

## 6. Alerting — where the real product value is

The listener-impact gate is the best idea in this codebase. Extending it:

### 6.0 How mail gets sent — and why it decides portability

Today every deployment carries its own SMTP credentials: `SMTP_HOST`, `PORT`,
`USER`, `PASS`, `FROM`, plus `ALERT_EMAILS`. That is correct for one station
running its own monitor. **It is the wrong shape for thirty-three.**

Follow it through to the affiliate wave and the problem is obvious:

- Every affiliate must supply working SMTP credentials before they can receive a
  single alert. Small stations are exactly the ones least likely to have them.
- Whoever runs the monitor ends up **holding thirty-three stations' mail
  credentials**, which is a far worse thing to be responsible for than one.
- A station that gets its credential wrong fails silently, in the one direction
  that matters: alerts stop arriving, and nothing announces it.

**The simplification: one send-only key at the monitor, recipients per station.**

| | Sending credential | Recipients | Station must configure |
|---|---|---|---|
| **Today** | Per deployment, in env | Per deployment, in env | SMTP host, port, user, password |
| **Proposed** | **One**, at the monitor | Per station, in the store | **An email address. Nothing else.** |

A station adding itself supplies the thing it actually knows — who should be told
— and nothing about mail servers. That is what makes the add-station flow a
30-second task rather than a support conversation, and it removes the only part
of setup that requires a station to have technical infrastructure of its own.

**It also cuts the other way, toward portability.** A station that *wants* to send
from its own domain still can: the per-deployment SMTP variables stay supported
and take precedence when set. Self-hosters keep full control; hosted affiliates
supply nothing. One code path, both models — which is the same trick as
configuration seeding in §5.1.

**The trade-off, honestly.** Mail arrives from the monitor's sending domain
rather than the station's, so a GM sees the alert coming from the monitoring
service rather than from their own station. Mitigations, in order of effort:

- Set `Reply-To` to the station's own contact, so replies land in the right place.
- Use a per-station `From` display name — *"KPFT Stream Monitor"* — over the
  shared address, which is what a recipient actually reads.
- If a station insists on its own domain, they configure their own SMTP, exactly
  as today.

**Prerequisite: a send-only credential, not a mailbox password.** A mailbox
account's SMTP password usually grants read access to that mailbox too, so a
shared one would put every station's alerts behind a credential that can also
read someone's mail. A transactional key from Postmark, SES or Resend can only
send, is scoped to one verified domain, and brings delivery and bounce logs —
which finally answer *"did the GM actually receive it"*, a question this system
cannot answer today. See [`docs/SECURITY.md`](docs/SECURITY.md).

**Consequence for the roadmap:** per-station recipients move into the store
alongside station configuration (§5.1), which is why `/api/stations` is projected
by allowlist rather than blocklist — the recipients land in that structure, and a
blocklist would publish them the moment they arrived.

### Recipients as a routing table, not a list

Today: one `ALERT_EMAILS` env var. What staff actually need:

| Dimension | Options |
|---|---|
| **Who** | Per station, per channel, per severity |
| **When** | Business hours only / 24-7 / quiet hours with escalation |
| **What** | Outages only / include dead air / include degraded-variant / weekly digest only |
| **How** | Email, SMS/Twilio, webhook, Slack, Discord, push |

A realistic KPFT configuration: chief engineer gets everything 24-7 by SMS; GM
gets confirmed listener-impacting outages by email plus the weekly roundup;
board ops gets dead-air alerts during their shift only; a Slack channel gets
everything for the record.

### Escalation

*If a confirmed outage is not acknowledged within N minutes, notify the next
person.* This is the feature that converts "monitoring" into "on-call," and it's
the one a GM will immediately understand the value of. Needs an ack mechanism —
a signed link in the email is enough, no login required.

### Alert quality features

- ~~**Digest mode** — during a flapping event, one message every N minutes instead
  of one per transition.~~ **SHIPPED 2026-09-02**, and not as a digest. A timer
  that re-sends every N minutes still sends N messages about a fault whose cause
  never changes. What shipped instead is *suppression plus one summary*: the
  second confirmed failure inside 45 minutes marks the stream UNSTABLE and says
  alerts are paused, everything after that is recorded and silent, and a single
  summary — total outages, downtime, listener-minutes lost — arrives once the
  stream has held for 30 minutes. See `STORM_WINDOW_MS` and the storm block in
  `monitor.js`. It did protect the gate's credibility: the trigger was 14 true
  alerts in one hour that nobody could act on.
- **Correlated network alert** — when four stations drop simultaneously, send
  *one* "Pacifica Icecast server outage" email, not four station alerts. Only
  possible because of the shared snapshot. Very strong demo moment.
- **"Still down" heartbeat** — a long outage should re-notify hourly; silence
  after the first alert reads as resolved.
- **Recovery with a verdict** — already partly there: how long, how many
  listeners lost, what the cause was, in the recovery mail.

---

## 7. The fleet / master panel

The screen the Pacifica national office opens in the morning.

### Layout

**Top: network status line.** One sentence in English, the way
`store.js:narrate()` already does it for a single station. *"All five stations on
air. 200 listeners. One dead-air event at WBAI overnight, 6 minutes, 8 listeners
affected."*

**Middle: the station grid.** One card per station — status, current listeners,
24h uptime, sparkline, last incident. Sortable by "worst first," which should be
the default. Selectable subset (the user's "selected stations" requirement) via
saved views: *My stations*, *Network*, *Everything*.

**Bottom: unified incident feed** across all stations, filterable, with the
station-vs-server attribution visible in the row itself.

### Cross-station comparison — the genuinely new capability

Once several stations are in one database, questions nobody at Pacifica can
answer today become one query:

- Which station has the worst uptime this quarter?
- Which station is *growing* its audience? (listener trend, month over month)
- What's the network's total simultaneous audience, and when does it peak?
- Is the Icecast host itself degrading — response times creeping up across all
  stations at once?
- How much total listening did the network lose to outages this year?

That last one is a fundraising and board-reporting number, and right now it does
not exist anywhere.

---

## 8. Feature brainstorm — utilities for GMs and station staff

Ordered roughly by value-to-effort. The point of this section is that the same
data supports a lot more than alerting.

### High value, low effort

| Feature | Notes |
|---|---|
| **Public status page** | Per-station, shareable URL, "is the stream down or is it me?" Kills a whole category of listener email to the station |
| **Monthly board report** | PDF/email: uptime, audience trend, incidents, listening hours delivered. GMs need this and currently assemble it by hand or not at all |
| **Silence-in-the-schedule detection** | Dead air already detected; correlate with a program schedule so "silence during a live show" pages loudly and "silence at 4am on a channel that's supposed to be off" doesn't |
| **Audience milestone notifications** | "KPFT just passed its highest simultaneous audience in 90 days." Positive news in a tool that otherwise only ever brings bad news — this matters for adoption |
| **Mobile-first incident view** | The chief engineer reads this on a phone, at night. Deep link from the alert email straight to the incident |
| **Export** | CSV/JSON of events and listener data. Already exists on the history page; make it API-accessible and per-station |

### High value, medium effort

| Feature | Notes |
|---|---|
| **Program schedule integration** | Import a weekly grid (or scrape the station site). Unlocks: which *show* was interrupted, which shows draw audience, per-show listener retention. Transforms this from an ops tool into something programming staff open voluntarily |
| **Now-playing / metadata history** | We already capture `title` per mount. Log it and you get a searchable "what was on air at 3:47pm" — useful for compliance, complaints, and archive lookups |
| **Encoder-health scoring** | Per-mount: reconnect frequency, `stream_start` resets, bitrate stability. Answers "which encoder is about to fail" *before* it does. `stream_start_iso8601` is already captured and currently unused for this |
| **Listener geography** | Icecast can expose per-listener data via admin API (needs credentials). "Where is our audience" is a question every GM has |
| **Annotations / incident notes** | Let staff write on an incident: "transmitter maintenance, planned." Turns the event log into an institutional record instead of a machine log |
| **Comparative benchmarking** | "Your uptime is 99.2%; network median is 99.6%." Peer pressure is an effective ops tool |

### Interesting, higher effort

| Feature | Notes |
|---|---|
| **Anomaly detection on audience** | We have hour-of-day profiles already. Flag "listeners at 40% of normal for this hour" — catches problems that don't break the stream at all: a bad audio chain, a stream URL broken on the website, a mobile app pointed at a dead mount. **This may be the most valuable unbuilt feature in the document** — it detects failures that every conventional monitor misses entirely |
| **Synthetic listener from multiple regions** | Probe from more than one network. Removes the "our connection broke" ambiguity that the listener-impact gate currently works around |
| **Audio fingerprint / loudness monitoring** | Beyond silence: is it too quiet, clipping, or mono-summed? Broadcast engineers care intensely; this is a real product on its own |
| **Stream-vs-broadcast correlation** | If we can also monitor the FM signal, "is it the stream or the transmitter" gets answered automatically |
| **Alert-fatigue analytics** | Track which alerts get acknowledged and which get ignored, and tune the gate accordingly. Self-correcting alert policy — a genuinely novel idea, and a natural extension of how the listener-impact gate was derived in the first place |

---

## 8b. Audience analytics — scope, and who sees what

> Added 2026-08-28. The direction stated by the project owner: listener data is
> not only "what did we lose". It is who is listening, where, when, and how that
> moves over time — and the cross-station view is expected to interest more
> people than the alerting does.

### It does not belong in the admin panel

The admin panel configures the system: add a station, edit it, remove it. Those
are rare, technical, restricted actions (§5.0). Audience analytics is the
opposite — frequent, non-technical, and the thing a GM opens *because they want
to*, not because something broke.

Putting reporting inside the configuration screen would collapse the distinction
§5.0 exists to protect, and would put "delete station" one tab away from the
report a GM reads weekly. **Audience analytics belongs in the reporting surface —
the history page and the fleet view — with the admin panel left alone.**

### Three tiers, not one switch

"Open or restricted" is the wrong shape for the question. There are three kinds
of audience data here and they carry different weight:

| Tier | Example | Sensitivity |
|---|---|---|
| **1. A station's own live counts** | "KPFT Main: 52 listening" | Already public on the dashboard. Leave it |
| **2. A station's own history and trends** | Hour-of-day curve, month-over-month | Low. Should reach that station's staff, and nobody minds if it is wider |
| **3. Cross-station comparison** | "WPFW recovers fastest; KPFT HD3 has the most dead air" | **Open — see below for what to compare** |
| **4. Per-listener detail** | IP, geography, session length | Personal data. Most restricted, and needs a policy before collection (§3.5) |

### Tier 3: open, and what to compare

Cross-station comparison is the most useful thing this system could produce, and
the one most worth getting the framing right on. "Which station is growing" and
"which station has the smallest audience" are facts that will be used in funding
arguments, board discussions and staff evaluations, whether or not that was the
intent.

Two things to design against:

- **It becomes a scorecard.** Once stations know they are ranked, the tool stops
  being a diagnostic and starts being an assessment. Peer pressure can be
  healthy — a station seeing it is the outlier on uptime may finally fix the
  encoder — but the same mechanism produces defensiveness, and in the worst case
  an incentive to keep outages quiet.
- **Audience size is not performance.** WPFW's 100 listeners and KPFT HD3's 4 are
  not a judgement about the people running them; they are markets, transmitters
  and schedules. A chart that lines them up implies otherwise unless it is
  framed very deliberately.

**Decided 2026-08-28: tier 3 is open.** An earlier draft of this section
recommended restricting it. The project owner overruled that, and the reasoning
holds: the underlying numbers are already public — anyone can count another
station's listeners from the Icecast endpoint in ten seconds — and visible
comparison is expected to motivate stations with weak digital reach rather than
merely expose them.

That is the upside named above, chosen deliberately. What follows is how to get
it without the failure modes.

**Compare what a station can change.** This is the whole difference between a
useful league table and an ignored one.

| Comparable and actionable | Not really either |
|---|---|
| **Uptime** — the same standard applies everywhere | **Absolute audience size** |
| **Dead-air minutes** | Peak listener count |
| **Time to recover** from an outage | Total listening hours |
| **Growth rate** — direction, not size | |

Audience size is mostly market size. KPFK has Los Angeles; KPFT has Houston; an
affiliate has a county. Ranking those against each other produces a shrug,
because nobody in the list can do anything about their metro population, and a
metric nobody can move is one nobody acts on.

Uptime and recovery time are the opposite: **the same standard applies to every
station regardless of size**, and a station that is bottom of that table has
something specific to fix. Growth rate works for the same reason — a small
station beating a large one on trend is a genuine result, and it is the one
comparison where being small is not a disadvantage.

**So lead with uptime and trend; show absolute audience as context, not as the
ranking.** The kick comes from a station seeing it is the only one with a
recurring encoder fault, not from seeing it has fewer listeners than Los Angeles.

**One thing to keep watching for.** Once stations know they are ranked, there is
a quiet incentive to keep outages out of the record. This system removes most of
that risk by design — outages are detected externally and recorded automatically,
with no station-side control over what gets logged — which is worth stating out
loud if anyone ever asks whether the table can be gamed. It cannot, and that is
what makes it fair enough to publish.

Tier 2 is the opposite: **a station should see its own history without asking.**
That is the part with obvious operational value and no politics.

### Each station chooses whether its own data is public

Open is the default; it is not imposed. A station that would rather its figures
were not readable by anyone holding the URL can put **its own** data behind a
login, and that is the station's decision rather than the platform's.

This matters more than it looks. A platform-wide switch makes one person decide
for everybody, and whichever way they decide somebody is unhappy. A per-station
setting means the answer can differ — which is the honest position, because a
station with a funding fight underway and a station proud of its numbers do not
have the same interests.

**It does not require roles.** The setting is binary — public, or needs a session
— and the existing single-admin login already satisfies the second. Roles in §5.5
become necessary only for the finer question of *whose* session: letting a
station's own staff see their gated data while other stations cannot. That is a
later problem, and deferring it does not block this.

**What it does require** is that scoping be honoured on the way out, not only on
the way in. A station marked private must be absent from the cross-station
comparison for an anonymous viewer and present for a signed-in one, which means
the fleet view computes over a different set depending on who is asking. The
allowlist projection in `redact.js` is the right place for that, and the
per-station scoping in `streamIdsFor()` is the right seam.

**The one failure to avoid:** a private station appearing in the comparison as a
gap, a blank row, or a rank with a hole in it. That publishes the fact that it is
hiding, which is worse than publishing the number. Absent means absent.

### What this needs that does not exist yet

1. **Per-station read scoping.** Today reads are public or gated wholesale
   (`REQUIRE_LOGIN_FOR_READ`). Tiering requires knowing *who* is looking, which
   means the roles in §5.5 — deferred until now for good reason, and this is the
   feature that finally requires them.
2. **Icecast admin credentials** for tier 4 (§3.5). The public endpoint gives
   counts and nothing else.
3. **A storage move before tier 4 collection begins** (§3.5).

Tiers 1 and 2 need none of that. **They can be built now**, on hourly rollups
that have been accumulating since day one, and they are where the value is
densest per unit of work.

### The number nobody at Pacifica currently has

Worth stating plainly because it is easy to lose among the charts: this system
already computes *listening hours lost* and can compute *listening hours
delivered*. Nobody at Pacifica has that figure for the network, for a year, in
one place.

It is a board number and a fundraising number, and it arrives as a by-product of
monitoring rather than as a separate project.

---

## 9. Displaying traffic and incidents

Current UI is dark, dense, and already has a heatmap and audience chart. Building
on that rather than replacing it.

### Ideas worth prototyping

**The "network pulse" strip.** One row per station, time on the x-axis, a
continuous band colored by state. Server-wide outages appear as a vertical bar
across every row — instantly readable, and it makes the correlation feature
visible rather than something buried in email text.

**Audience ribbon / stacked area.** Total network audience over time, stacked by
station. Shows both scale and share in one shape. Drill down into a station to
re-stack it by channel.

**Outage overlay on the audience chart.** Already implemented for one station
(`/api/listeners` deliberately returns audience and outage windows together so
they can never disagree). Keep this — the *shape* of the drop is the most
persuasive visual we have, because it shows the audience not coming back.

**The "cost of downtime" tile.** Listening hours lost, expressed against a
comparison the GM feels: *"equivalent to losing your entire Tuesday drive-time
audience twice."* The audience loss model already computes the number; it just
needs framing.

**Calendar heatmap, network-wide.** Extend the existing heatmap to a small
multiple — one per station, aligned. Patterns jump out: a station that always
fails on Sunday nights has a scheduling problem, not a technical one.

**Recovery-time distribution.** Histogram of how long outages last. A station
with many 2-minute outages has a different problem than one with a single
4-hour outage, and averaged uptime hides that completely.

**Live "now" view.** Big numbers, current listeners per station, updating.
Unashamedly a wall-display screen for the station lobby or engineering office.
Low information density on purpose — its job is to be visible from across a room.

### Principles

- **Uptime percentages lie.** 99.5% sounds fine and is 3.6 hours a month. Always
  pair the percentage with absolute time and with listeners affected — the
  existing "how the large totals relate" panel already does this well.
- **Show the audience, not the probe.** Every visualization should default to the
  listener's experience.
- **One English sentence at the top of every view.** `narrate()` is the right
  instinct and should be applied everywhere, not just the roundup.

---

## 10. Phasing

> **Revised 2026-08-27.** The admin panel now precedes the stations. Adding the
> five sister stations by hand would build the configuration path twice and throw
> the first one away; building the panel first makes those five stations its test
> data. See the note at the head of §5.

| Phase | Contents | Rough shape |
|---|---|---|
| **0 — Foundations** | Characterization tests · `StationMonitor` class · channel/mount model (✅ done) · move station config out of env into the store | Invisible to users; all the risk lives here. **No storage migration** |
| **1 — Minimum admin** | Single-admin login · discovery-driven add-station flow · per-station alert recipients | Deliberately small: no roles, no audit log, no maintenance windows yet |
| **2 — The five sister stations** | Added *through the panel*, not by config file · host-shared snapshot · correlated network alerts | The dogfood moment, and the demo that sells the rest |
| **2b — Affiliate wave** | Add `stream.pacificaservice.org` · ~28 affiliates · call-sign→station grouping | Same code path, same panel; near-zero marginal cost |
| **3 — Fleet view & staff utilities** | Master panel · public status page · monthly board report · annotations · escalation + ack | The features non-engineers open the app for |
| **3b — Discovery adapters** | Tier 1–5 fallbacks · per-station degraded-monitoring policy | Required before any off-network affiliate (§2.4) |
| **3c — Roles & multi-user** | The role table in §5.5, built when a real GM asks for a login | Not before. A permission system without users is maintenance with no return |
| **3d — Storage** | SQLite behind the existing `store.js` API, once mount count passes ~50 **or per-listener collection begins** (§3.3, §3.5) | Deferred deliberately; not needed before whichever of those comes first |
| **3e — Audience, tiers 1–2** | A station's own counts, history and trends, on rollups already accumulating (§8b) | Needs nothing new. Densest value per unit of work |
| **3f — Audience, tier 3** | Cross-station comparison, open by default, each station able to gate its own data (§8b) | No roles needed: the setting is binary. Compare what a station can change |
| **3g — Audience, tier 4** | Per-listener geography and sessions — requires Icecast admin credentials, a PII policy, and the storage move (§3.5) | Start the credentials conversation early; it is not code |
| **4 — Intelligence** | Audience anomaly detection · encoder health scoring · multi-region probes · alert-fatigue analytics | The state-of-the-art part |

**The through-line:** every phase after 1 adds stations through the same panel.
Sister stations, affiliates on the shared host, and self-hosted affiliates are
the same workflow with progressively weaker discovery — not three projects.

---

## 11. Open questions

**Product**
1. Is the customer Pacifica specifically, or is this a general product that
   Pacifica is the first user of? This changes the tenancy model, the auth model,
   and whether Phase 2 is generic multi-host or not.
2. Does anyone at Pacifica national actually want a fleet view, or is each
   station independent in practice? Worth asking before building it.
3. Public status pages — does a station want listeners to see their uptime?
   Some will, some very much will not. Must be opt-in per station.

**Technical**
4. Who runs `stream.pacificaservice.org`, and does Pacifica national have
   authority to monitor the affiliates on it — or does each affiliate need to
   opt in? This is a permission question, not a technical one, and it gates
   Wave 2 entirely.
5. For affiliates we cannot observe (Tier 5), what is the default alert policy?
   Alerting on everything is wrong; silence is also wrong.
6. Do we have Icecast *admin* credentials for the Pacifica host? Per-listener
   data (geography, session length, user agent) needs them, and it unlocks a
   large slice of §8.
7. Is the mount→channel mapping in §3.1 correct? Needs confirming with whoever
   runs the encoders.
8. Where do external stations' Icecast servers live, and do they use HTTPS with
   valid certs? Affects probe reliability and the error catalog.
9. SMS/Twilio — who pays, and is the budget there? Escalation is much weaker
   without it.

**Operational**
10. Who administers this once there are multiple stations? "Paul's Mac" is not a
   long-term answer for a tool five stations depend on.
11. Data retention at network scale — events are permanent by design. At 90
   streams that is a policy decision, not just a disk one.
12. What happens when the monitor itself goes down? Currently nothing — nobody
    is watching the watcher. A dead-man's-switch ping to an external service is
    about an hour of work and should probably happen regardless of this roadmap.
