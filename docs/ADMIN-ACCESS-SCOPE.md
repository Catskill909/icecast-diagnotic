# What Icecast admin access unlocks

> Scoping document, 2026-08-31. Written to answer two questions: can we build the
> listener map AzuraCast has, and what else becomes possible.
>
> Builds on [`AUDIENCE-ROADMAP.md`](AUDIENCE-ROADMAP.md) §4, which already decides
> **how** credentials work (per host, optional, entered in the panel) and names
> the two constraints they create. This covers **what to build with them**.

---

> **The build plan that follows from this is
> [`DEEP-ANALYTICS-PLAN.md`](DEEP-ANALYTICS-PLAN.md)** — the decision to go as
> deep as the data allows and show every limitation on screen, the confidence
> vocabulary that makes that consistent, distribution channel (TuneIn) as a
> first-class metric, and the build order.

## 0. Two things verified before writing any of this

**The admin API is already there and already password-protected.** Probed
2026-08-31:

| | |
|---|---|
| `streams.pacifica.org:9000/admin/stats` | **401** |
| `streams.pacifica.org:9000/admin/listclients?mount=/live_128` | **401** |
| `streaming.wbai.org/admin/stats` | **401** |

401, not 404. The endpoints exist, the server answers, and the only missing piece
is a password. Nothing here needs Pacifica to install, enable or upgrade
anything — **the entire Phase 2 roadmap is gated on one credential.**

### That credential arrived — 2026-09-02

Pacifica sent the `<authentication>` block from the Icecast configuration for
`streams.pacifica.org:9000`, containing `admin-user` and `admin-password`.
**The gate described above is open.** §8 Q1 is answered yes, and the entry
condition for Phase 5 in [`PHASE-PLAN.md`](PHASE-PLAN.md) is met.

**The value is not in this repository and must not be put in it.** Decided
2026-09-02: **production sets `ICECAST_ADMIN_USER` / `ICECAST_ADMIN_PASSWORD` as
environment variables in the Coolify panel; local testing puts them in `.env`,
which is gitignored.** `.env.example` carries the names and no values.

That is not in tension with [`AUDIENCE-ROADMAP.md`](AUDIENCE-ROADMAP.md) §4.1,
which says a credential belongs to the **host** and is entered in the panel: env
is how a credential is *supplied* until that entry exists, exactly as `STREAMS`
and `ALERT_EMAILS` seed a store that then owns them. The §4.1 rule is about the
end state for affiliate operators, who must be able to supply their own without
a redeploy. Env seeds, the store owns.

> **Quote a password containing `#`.** dotenv treats an unquoted `#` as the start
> of a comment even with no whitespace before it, so `PASS=a#b` silently parses as
> `a` and produces a 401 against a password that looks correct in the file.
> Verified against dotenv 16 in this project. In the Coolify UI type the raw value
> **without** quotes — that is a form field, not a parsed file. This applies to
> `SMTP_PASS` and every other secret, not just this one.

**The same message also carried `source-password` and `relay-password`. Those are
not stored, and should not be.** We did not ask for them and nothing here needs
them. The distinction is not pedantic: an admin password **reads**, a source
password **writes** — it is the credential that lets a client connect as a source
and take over a mount, including another station's. Holding it would turn a
read-only diagnostic tool into something capable of silently interrupting five
stations' broadcasts, which is a different product with a different risk profile,
the same reason §3.4 declines `killsource`. Recorded here as a fact about what was
sent, so that a later reader does not go looking for where it was filed.

**The credential covers the whole shared host**, so it reads every Pacifica
sister station on `streams.pacifica.org`, not only KPFT's. That is intended, and
authorised — see §8 Q2, closed 2026-09-02. It is what makes the network-level
question in §2 ("five metros or one national audience?") answerable at all.

The one thing to remember when building on it: **the dashboard needs no login to
read**, so a page showing per-listener rows would show them to anyone with the
URL. §5 covers this.

**Next step is 5.1 and nothing else:** fetch `/admin/stats` and
`/admin/listclients` raw and read the XML. Every design in this document assumes a
field shape the Icecast documentation does not enumerate, and §7 step 0 exists
precisely so that assumption is checked before anything is built on it.

---

## 0.1 5.1, first pass — what `/admin/stats` actually returns

Fetched 2026-09-02 15:53 EDT. **HTTP 200 — the credential works.** Only
`/admin/stats` was requested: it carries no per-listener rows, so it stays clear
of the §8 Q2 question, which `listclients` does not. `listclients` is still
unfetched and stays that way until Q2 is answered.

Three findings change what should be built, and one of them changes what the app
currently *says*.

### `slow_listeners` is per mount, on `/admin/stats`, and needs no listener data

§3.2 listed lagging listeners as "if `listclients` exposes lag on 2.4.3 — to be
confirmed". It does not need `listclients` at all. `/admin/stats` returns a
cumulative `slow_listeners` counter per mount:

| Mount | Listeners | `slow_listeners` |
|---|---|---|
| `/wbai_128` | 15 | **1324** |
| `/kpfk_128` | 68 | **705** |
| `/wpfw_128` | 55 | **469** |
| `/classic_country` | 10 | 302 |
| `/kpfa` | 12 | 57 |
| `/live_128`, `/live_64`, `/kpfk`, `/kpfk_64`, `/kpfa_16`, `/kpfa_64` | — | 0 |

**This is an aggregate count, not a person.** It is the privacy-safe half of §3.2
and it can be collected today, under no part of the §5 decision and no part of Q2.
It measures something no current signal catches: a listener whose buffer drained
and who was dropped — audible to them, invisible to a reachability probe.

Counters are cumulative since `server_start` (2026-08-19), so only the
**delta between polls** is meaningful. Do not publish the raw total.

### The source is not the Barix — it is a Pacifica-hosted relay

Every KPFT and sister-station mount reports `source_ip` `127.0.0.1` and
`user_agent` **`pontifistreamer 3.1.2`** — a process on Pacifica's own server. The
only genuinely external sources on the host are `/classic_country`
(`104.56.82.169`, *PlayIt Live*) and `/padma` (`108.30.98.171`, *ZIPStream R1*).

`/live_128` carries the title "From KPFT Barix", but **the Barix is not what
connects to Icecast.** The chain is `Barix → pontifistreamer (on Pacifica's
server) → Icecast`, and the app has only ever been able to see the last hop.

**This matters because the app tells people to check the Barix.** README's core
table reads a 404 as "KPFT — check the encoder and studio audio chain", and
`faultSplit: source` means the same. That verdict collapses a two-hop chain into
its first hop. The evidence still says *the mount's source went away*; it does
**not** say which of the two hops dropped it, and the wording should stop implying
it does. See §0.2.

### `total_bytes_read` separates "connected" from "actually streaming"

Per mount, cumulative since `stream_start`. A source that connects and passes no
audio is directly visible, which no current signal reports — the mount is present,
so a reachability probe calls it healthy.

Also worth recording: the public listen port is **7267** (`listenurl`), fronted by
9000 for TLS; `clients` (194) exceeds `listeners` (137), so a server-wide client
count is not an audience figure; and `listener_peak` is since server start, not
since `stream_start`.

---

## 0.2 What the first admin fetch caught in the act

The 5.1 fetch landed during a live KPFT fault, which is the reason the finding
above is stated as strongly as it is.

**`/live_128` had 9 listeners and `total_bytes_read` of 5009 bytes**, against
467 MB on `/kpfk_128` and 10.7 GB on `/wbai_128`. At 128 kbps, 5009 bytes is about
a third of a second of audio. The source had connected 20 seconds earlier and
delivered essentially nothing. Sampling `/status-json.xsl` every 10 seconds for
two minutes afterwards:

| | |
|---|---|
| `/live_128`, `/live_64` (KPFT Main) | present in **1 of 12** samples |
| `/HD3_128` (KPFT HD2) | present in **0 of 12** — it had been listed minutes earlier |
| `/classic_country` (KPFT HD3) | present in **12 of 12**, `stream_start` 2026-08-29 |
| every sister station | present in 12 of 12 |

**KPFT HD3 is the control, and it is the one that stays up.** It is also the only
KPFT mount whose source is genuinely external — `104.56.82.169`, *PlayIt Live*.
The two that flap are the two fed by `pontifistreamer` on Pacifica's own host.

**That is a correlation, not a verdict, and it must not be written into the app as
one.** `pontifistreamer` carries every stable sister station on the same box, so
the process is not broken in general; and a relay whose own upstream Barix feed
dies will drop its Icecast connection exactly like this. Both remain live
hypotheses. What the evidence *does* establish is narrower and still new:

- The failure is **not** "Icecast is unhealthy" — 10 of 12 mounts never wavered.
- The failing hop is somewhere in `Barix → pontifistreamer → Icecast`, and
  **`/admin/stats` cannot see which**, because it only ever observes the last hop.
- A mount can be **present and passing no audio**. `total_bytes_read` is the only
  field that shows this, and a reachability probe scores that moment as healthy.

**The actionable change is to stop naming a device we cannot see.** "Check the
Barix" is one hypothesis out of two, printed as a conclusion, in the sentence an
engineer acts on at 3am. Reporting the observation — *the mount's source stopped
delivering audio; Icecast and every other station on the host are fine* — is both
true and enough to route the call, and it is what `faultSplit: source` already
means. The renaming from `kpft`/`pacifica` to `source`/`server` on 2026-08-31 was
this same correction applied to the enum; the operator-facing text still says the
old thing.

**Adding `total_bytes_read` to the poll is the cheapest real upgrade here.** It is
one field on a document already fetched every cycle, it needs no per-listener data
and no §5 decision, and it distinguishes a source that is present from a source
that is working — a fault the monitor currently cannot see at all.

---

## 0.3 `listclients` — tested 2026-09-02, field shape confirmed

### The credential is server-wide. Q2 is now purely a policy question.

| Request | Result |
|---|---|
| `listclients?mount=/classic_country` (ours) | **HTTP 200** |
| `listclients?mount=/wbai_128` (WBAI's) | **HTTP 200** |

It reads **every station's listeners on the host**, not only KPFT's — which is
what the cross-station work in §6 needs, and is authorised (§8 Q2). Nothing here
is blocked on anyone. What remains is ordinary build work: §4 (storage) and §5
(don't put per-listener rows on a page that needs no login).

### The four fields §1 predicted are the four fields that exist

`IP`, `UserAgent`, `Connected`, `ID` — no more. Read from KPFT's own mount;
IP and UserAgent values were masked on sight and the response deleted, because
nothing here needed them.

**There is no lag or buffer field.** §3.2 hoped `listclients` might expose one on
2.4.3. It does not, which makes the per-mount `slow_listeners` counter in §0.1 the
**only** signal for a draining listener — it is not a duplicate of something
`listclients` also offers, it is the sole source.

### `Connected` is seconds, and the first read already contains a non-person

One session on `/classic_country` read `Connected` **340388** — 3 days 22 hours.
Nobody listens to a radio stream for 3.9 days. That is a relay, a scraper or a
stuck client, and **it is inside the listener count the app publishes today**,
including the ATH figure the SoundExchange estimate rests on.

So §3.2's bot filtering is not a refinement to schedule later; it is a
**precondition for quoting any session-derived number at all**. A mean session
length computed without it is meaningless — one 3.9-day connection outweighs
hundreds of real ones. Build order 5.5 before 5.6 and 5.7, exactly as
[`PHASE-PLAN.md`](PHASE-PLAN.md) has it, and the reason is now measured rather
than anticipated.

**It also revises existing figures downward when fixed, and that is correct.**
§4 already says the monitor's own probes inflate counts; this is a second inflation
source, larger and not of our making.

**The server is Icecast 2.4.3**, which fixes exactly which admin endpoints exist
and what they return.

---

## 1. What one request actually gives us

`GET /admin/listclients?mount=/live_128`, per connected listener:

| Field | What it unlocks |
|---|---|
| **IP** | Geography. Distinct-listener estimates. Bot filtering. **Also the single biggest liability in this document** — see §5 |
| **User agent** | Player, device, OS. Which apps the audience actually uses, and whether the stream works in them |
| **Connected** (seconds) | **The important one.** Real session length, without inferring anything from polling |
| **ID** | A stable handle per connection, so the same listener can be followed across polls |

Today the monitor knows *how many* connections exist. This gives it *which*
connections exist and *how long each has lasted* — a different kind of data, not
merely more of it.

> The Icecast docs do not enumerate these fields. **First task on getting a
> credential is to fetch it raw and read the XML**, before designing anything
> against an assumed shape.

---

## 2. The map — yes, but ONLY with admin access

**Nothing about geography is possible today.** Verified 2026-08-31 against the
live server: `/status-json.xsl` returns 16 fields per mount — bitrate, genre,
titles, `stream_start`, `listeners`, `listener_peak` — and **not one of them is
an attribute of a listener**. `listeners: 103` is a bare integer. There is no IP,
no location, and nothing per-connection to derive one from. No amount of polling
turns a count into a place.

So the map sits entirely behind the credential, alongside everything else in §3.

### Not the way AzuraCast does it

**Possible.** AzuraCast resolves listener IPs against a local MaxMind GeoLite2
database and plots them. We can do the same: free with an account, ~70 MB, updates
monthly, resolved in-process. `AUDIENCE-ROADMAP.md` already settles that it must
be a **local** database rather than a lookup API, because an API sends every
listener's IP to a third party.

**But a dot-per-listener map is the wrong build here, for three reasons.**

**It implies precision that does not exist.** IP-to-city is right within 50 km
roughly 60–70% of the time and worse on mobile carriers, whose addresses often
resolve to a regional gateway hundreds of miles from the listener. A pin on a
street map states a certainty the data cannot support. A station manager who
sees a cluster in one suburb will believe it.

**It is the privacy-worst option.** A per-listener map is, definitionally, a
per-listener record rendered in a browser. The natural implementation ships every
listener's coordinates to anyone who loads the page. §5 is not a footnote here.

**It answers a worse question.** "Where is our audience" for a broadcaster means
*which metros, which states, how much is outside the signal area* — not where one
person is sitting. A **choropleth by state and country**, with counts, answers the
real question, is honest about its resolution, and is defensible to publish.

### What to build instead

An **inline SVG choropleth** — US states plus a country list — coloured by
listener share.

> **This does not remove the geo-database dependency, and choosing it instead of
> a pin map is not a way to avoid MaxMind.** Any map needs two things: admin
> access for the IP addresses, and a local database to turn them into places. The
> recommendation below is about PRESENTATION and PRIVACY, not about the
> dependency. If MaxMind specifically is unwanted, IP2Location LITE and DB-IP
> lite have the same shape and terms; the rule that matters is *a local database,
> never a lookup API*, because an API means sending every listener's IP to a
> vendor.
>
> **Country-level is cheaper and, for this network, nearly useless.** Country
> resolution uses a dataset of a few MB against ~70 MB for city-grade. But
> Pacifica is five US sister stations and ~28 US affiliates: a country breakdown
> reports about 98% United States and stops. **State/metro is the only
> resolution that answers a question anyone here is asking**, so the city-grade
> database is a requirement, not an upgrade.

### Correction, 2026-09-02: this section is about the CITY database only

**The comparison below decides the *city* database and nothing else.** It was
written as though one choice covered all geo work, and the ASN database — which
is what the distribution-channel build (5.4) actually needs — is a separate file
with a separate answer:

| | City | ASN |
|---|---|---|
| Answers | in-market share, the map | which connections are relays |
| Accuracy argument below applies | **yes** | **no** — an AS number comes from the public routing table |
| DB-IP Lite viable | weakest tier, so no | **yes, and it needs no account** |
| Size | ~70 MB | 9 MB |

So **5.4 was built on DB-IP ASN Lite**: CC BY 4.0, direct download, no account,
no licence key, same MMDB format. Verified against the real file on 2026-09-02.
The city question below stays open until the map is built, and because both
vendors ship MMDB it is an env path rather than a code change.

**Also corrected: no free database carries a hosting flag.** See
[`DEEP-ANALYTICS-PLAN.md`](DEEP-ANALYTICS-PLAN.md) §3.

### Which database — recommended: MaxMind GeoLite2 City

**Because the required resolution is state/metro, accuracy decides this, not
licensing.**

| | GeoLite2 City | IP2Location LITE DB11 | DB-IP City Lite |
|---|---|---|---|
| State-level accuracy | **best** | good | weakest — the Lite tier is materially reduced at city |
| Licence | MaxMind EULA | CC BY-SA 4.0 | CC BY 4.0 |
| Account / key | account + licence key | account | none |
| Size | ~70 MB | ~100 MB+ | ~50 MB |

DB-IP Lite is the best choice at COUNTRY level — attribution-only licence, no
account, therefore no secret to store or rotate — and it drops out at city level,
which is the level this network needs. An earlier draft of this document
recommended it on licence grounds while assuming a country-first build; that was
answering a question Pacifica is not asking.

**Fallback if the EULA is a blocker:** IP2Location LITE DB11. Share-alike does
not bite here — the database is queried, not redistributed.

### The accuracy ceiling is mobile, not the database

Worth stating before anyone builds a decision on the output. Carrier-grade NAT
means a mobile listener frequently resolves to the carrier's regional gateway,
which can be in a different state from the person. Mobile is a large share of
stream listening, so **the databases are wrong in the same way on the same
listeners** — choosing MaxMind over IP2Location buys less than the comparison
implies. Any figure derived from this needs a stated confidence caveat, the way
ATH carries "estimated".

Three caveats:

- **Verify the terms at download time.** Licensing has changed before — MaxMind's
  twice — and this is written from knowledge current to mid-2026.
- **Attribution is a real obligation** for the CC-licensed options, not a
  courtesy: a credit line with a link on any page showing geographic data.
- **A licence key is a secret**, and it belongs with the Icecast admin
  credentials in the store, under the same allowlist redaction — not in a public
  response and not in a page.

### Outside the US, report the country and stop

GeoLite2's accuracy is not uniform, and the difference is by resolution rather
than by vendor:

| | Accuracy |
|---|---|
| **Country, worldwide** | ~99%, fairly uniform — reliable everywhere |
| **City / subdivision, US** | good — the basis for the in-market figure |
| **City / subdivision, elsewhere** | strong in Canada, Western Europe, Australia; **much weaker** across large parts of Africa, South Asia and Latin America, where it frequently cannot resolve below country |

**The hazard is the fallback, not the miss.** When a city cannot be resolved, the
lookup returns a country or region **centroid** — which manufactures a cluster of
listeners at a point where nobody lives. MaxMind's own well-documented case was a
Kansas farm that received years of harassment because unresolvable US addresses
defaulted to its coordinates. On a map that reads as a genuine finding, and it is
an artefact of the lookup.

**The guard is `accuracy_radius`**, returned per lookup. A wide radius means the
answer is a country, not a place. Gate on it, so a centroid can never become a
dot or a state.

So the rule:

- **US → state / metro.** The in-market vs out-of-market question.
- **Everywhere else → country only.** Never city, however confidently the
  database offers one.
- **`accuracy_radius` decides**, not the presence of a city field.

### One more privacy note: EU listeners raise the bar

GDPR treats an IP address as personal data with stricter handling than US
practice — a distinction a US non-profit may not have considered, and which
applies as soon as any listener is in the EU. It does not change the rule in §5;
it makes it non-optional. GeoLite2 carries an `is_in_european_union` flag, which
is enough to know whether the question is live.

### What this network should actually measure

Not a fifty-state choropleth. Two questions, in order:

1. **In-market vs out-of-market share.** What proportion of KPFT's audience is in
   Greater Houston? That is the figure tied to licence area, underwriting and
   fundraising, and it is one number per station rather than a map.
2. **The network question only Pacifica can ask.** Are the five sister stations
   serving five metros, or is there one national audience overlapping across all
   of them? That needs state/metro across every station at once — precisely what
   a cross-station tool can do and no per-station panel can, and it is a
   strategic finding rather than a chart.

That fits this codebase specifically: no framework, no build step, `script-src
'self'` with no `unsafe-inline`, and three dependencies total. A map library plus
a tile server would add an external script, an external image source, a CSP
change and a runtime network dependency, to draw something less honest. An SVG
map of US states is a static file we ship once.

**The genuinely interesting figure is not the map at all.** It is *share of
audience outside the broadcast footprint*. A Houston station discovering that 40%
of its stream audience is not in Texas has learned something that changes
programming and fundraising. That is one number, and it needs the same data.

---

## 3. What else opens up

Ordered by value to a station, not by ease.

### 3.1 Audience — turning estimates into measurements

| | Today | With admin |
|---|---|---|
| Total listeners / tune-ins | a **floor**, from rises in the count | exact — every connection is individually visible |
| Session length / TSL | not possible | direct, from `Connected` |
| Individual listeners | **unavailable** | estimable — IP + user agent, with the proxy caveat in §1.5 |
| ATH | **estimated** from polling | summed from real session durations — filing-grade rather than early-warning |

**TSL is the one station managers ask for.** "Average time spent listening" is
the number in every industry report and we cannot produce it at all today.

**The ATH upgrade has money attached.** The SoundExchange fee is computed from
aggregate tuning hours; ours is currently labelled an estimate specifically so
nobody files on it. Real session durations change that.

### 3.2 Diagnosis — the part nobody else can do

This is where admin access compounds with what this app already is, rather than
catching up to what other panels have.

- **Did the audience actually come back?** We record every outage and its
  duration. With per-connection data we can measure *how many of the listeners
  present before an outage reconnected after it, and how long they took*. That
  turns "3h35m down" into "we lost 62% of that audience permanently" — the
  sentence that funds an STL replacement.
- **Which players break.** Session length grouped by user agent finds "iOS
  Safari sessions end at exactly 3 minutes" — a real, fixable stream bug that is
  invisible in aggregate counts. How granular device data can get is in §3.3.
- **Bot and scraper filtering.** Some connections are not people. They are
  currently counted as listeners in every figure the app publishes, including
  the royalty estimate. User agents make them separable. **This may revise
  existing numbers downward, and that is a feature.**
- **Slow or lagging listeners.** If `listclients` exposes lag on 2.4.3 —
  to be confirmed from the raw XML — it detects listeners whose buffers are
  draining, which is a network fault the listener experiences and no current
  signal catches.
- **Source-side detail** from `/admin/stats`: the source's own IP and incoming
  bitrate. That distinguishes "the Barix reconnected" from "a *different* source
  connected", and catches an encoder running at the wrong bitrate — a fault that
  is inaudible to monitoring but audible to listeners.

### 3.3 Devices, apps and smart speakers — how granular

The user agent is the richest field `listclients` returns. Granularity in tiers:

| Tier | What | Reliability |
|---|---|---|
| 1 | **Player family** — VLC, iTunes/Apple, browser, Sonos, Roku, Chromecast, generic library, unknown | **high** |
| 2 | **Platform** — iOS, Android, Windows, macOS, Linux | usually |
| 3 | **OS version; Android device model** (`Dalvik/... SM-G991B`); **Sonos model code** (`Sonos/70.1 (ZPS12)`) | sometimes |
| 4 | Individual device identity | **no — and must not be attempted** |

**Smart speakers:** Sonos and Chromecast / Google Home are cleanly identifiable
from the agent string. **Alexa is the hard one** — Echo playback commonly arrives
through TuneIn rather than as an Amazon agent, so "how many Echo listeners" may
be unanswerable even with a credential.

**What carries no information:** `okhttp/4.9.0`, `Lavf/58.29`, an empty agent.
These are common. They mean "some application" and must be labelled as an honest
unknown bucket rather than guessed into a category.

#### The caveat that could invalidate most of this

**Aggregators may be hiding the majority of the audience.** TuneIn, iHeart and
Radio Garden are major distribution for public radio, and each either:

- **proxies** — one connection from their servers stands for many listeners, with
  no device detail at all, or
- **redirects** — each real device connects directly, tagged with their app.

**Which one applies per aggregator is empirical and cannot be answered without
the credential.** If Pacifica's streams are heavily proxied, device statistics
describe only the direct-connection minority — and the proxied share also
distorts every existing listener count, including the royalty estimate.
**Measure the split before building any dashboard on device data**; it may be the
more interesting finding on its own.

#### The cross-cuts are where the value is

A device breakdown alone is a pie chart. Crossed with what this system already
holds, it is diagnostic:

- **Device x session length** — finds player-specific failures like sessions
  ending at a fixed interval.
- **Device x mount** — do smart speakers land on the low-bitrate variant?
- **Device x reconnection after an outage** — which players recover unattended
  and which need a human to press play. Directly actionable, and nobody else can
  compute it because nobody else holds the outage record beside the audience.

#### Implementation

A hand-written pattern table — roughly twenty rules covers most radio streaming
traffic. A user-agent parsing library would be a fourth dependency in a project
with three, for something that does not need one. Classification runs
server-side; the raw agent string is a per-listener attribute and never reaches a
response (§5).

### 3.4 Control — available, and deliberately out of scope

Icecast 2.4.3 admin also offers `killsource`, `killclient`, `moveclients` and
`metadata`. **Recommend not building these.** This is a diagnostic tool that
several stations trust with read access to a shared server; a button that
disconnects another station's source is a different product with a different
risk profile. Worth naming so the decision is on the record rather than an
oversight.

---

## 4. What this costs

**Storage — this is where the SQLite decision expires.** Today: one row per
channel per minute, ~11,500 rows/day. Per-connection collection is proportional
to the *audience*: at ~440 concurrent across four stations, polled each minute,
roughly **630,000 rows/day** — fifty-plus times the current volume, growing with
success rather than with station count.

`HANDOFF.md` §5 already says to revisit at ~50 mounts **or when per-listener
analytics begins, whichever comes first**. This is that, and it must be decided
*before* collection starts.

**Two collection rates, not one.** Session data does not need minute resolution —
`Connected` gives duration directly, so polling every 5 minutes still catches
sessions and cuts volume fivefold. Only the concurrent count needs the current
cadence. **The two should not share a collection loop.**

**The GeoIP database** is a ~70 MB file needing a MaxMind account, a licence key,
and a monthly refresh. It changes the deployment: the Dockerfile copies files
individually — see the trap in `HANDOFF.md` — and a stale database silently
degrades rather than failing.

**Our own probes must be excluded.** Icecast counts every connection as a
listener, ours included — measured: one connection took `/kpfk` from 1 to 2. In
per-connection data our probes become *identifiable rows* with our user agent, so
they can finally be excluded exactly rather than avoided by careful timing.
**This is the first real chance to remove that contamination**, and it means
today's figures are slightly overstated in a way we can finally quantify.

---

## 5. The decision that must come first

**`/admin/listclients` returns personal data about the audience, and this
dashboard is public.**

An IP address plus a user agent is personal data in most jurisdictions this
station's listeners live in. It is not telemetry about the station; it belongs to
the people listening. Nothing else in this system has that property.

`AUDIENCE-ROADMAP.md` §4.2 sets out the two options. To restate the conclusion
because everything in §3 depends on it:

> **Aggregate before it leaves the server.** Counts by state, counts by device,
> distributions of session length — never a row per listener, never coordinates
> per listener, never an IP in any response.

The natural implementation of every panel in this document — fetch the rows, send
them to the browser, group them in the chart — publishes every listener's IP
address to anyone who loads the page. That is not a hypothetical failure mode: it
is the *obvious* way to write it, and this codebase has now shipped that class of
leak three times in one day (`/api/events`, `/api/status`, `/api/history`).

Two further decisions to make explicitly, not by default:

- **Retention.** How long are per-connection rows kept? Aggregates can be kept
  for ever; raw rows should not be. A defensible default is to aggregate on
  arrival and retain raw rows for hours, not months.
- **Whose data is it.** Five stations share one Icecast server. A credential for
  that host exposes *every* station's listeners on it, including stations not
  monitored here. Reading another station's audience because we hold the server
  password is a question for Pacifica, not for us.

---

## 6. What we would have that AzuraCast does not

Worth stating, because most of §3.1 is catching up and it is easy to lose the
part that is genuinely ahead.

AzuraCast is a **broadcasting platform** — it owns the server, so its analytics
are a feature of the thing it runs. This is a **cross-station diagnostic tool**
that watches servers it does not control. Three consequences:

1. **Audience joined to root cause.** Nobody else holds the outage record and the
   audience curve in the same store, per mount, with a diagnosis attached to
   every interruption. "You lost 62% of that audience permanently, and the cause
   was the studio encoder" is not a report AzuraCast can produce, because it does
   not diagnose the handoff.
2. **The per-mount split.** Every other panel sums bitrate variants. Ours is the
   only view where `/live_64` carrying a third of the audience is visible — and
   with per-connection data, *which* listeners are on the low-bitrate mount and
   whether their sessions are shorter.
3. **Fleet view across stations that do not share an operator.** 33 affiliates on
   two hosts, compared on the same axes, is a Pacifica-national capability no
   per-station panel can have by construction.

---

## 7. Recommended order — SUPERSEDED

> **Sequencing now lives in [`PHASE-PLAN.md`](PHASE-PLAN.md) (Phase 5), and the
> detailed order in [`DEEP-ANALYTICS-PLAN.md`](DEEP-ANALYTICS-PLAN.md) §7.**
>
> This list predates the distribution-channel work and **omits it entirely** —
> which matters, because the proxied share is the qualifier on every other
> audience figure, so it has to precede publishing anything session-derived
> rather than being absent. Kept for its reasoning, not as an order to follow.

Assumes a credential exists for one host.

| | Step | Why here |
|---|---|---|
| 0 | **Fetch `listclients` raw and read the XML** | Every design below assumes a field shape the docs do not document |
| 1 | **Decide storage and retention** (§4, §5) | Before collection starts, not after. Rewriting a schema with a month of rows in it is the expensive path |
| 2 | **Credential entry per host**, panel-only, allowlist-redacted | Small, already designed in `AUDIENCE-ROADMAP.md` §4.1 |
| 3 | **Session collection at 5-minute cadence**, aggregated on arrival | The base every metric below reads from |
| 4 | **Session length / TSL** | Highest-value single metric, needs no geo database |
| 5 | **Player and device breakdown** | Free once rows exist; finds real stream bugs |
| 6 | **Bot filtering, and excluding our own probes** | Do this before publishing any figure derived from the rows, or the corrections land in public later |
| 7 | **Exact tune-ins and real ATH** | Upgrades two figures already on the page from estimates to measurements |
| 8 | **Audience retained through an outage** | The one nobody else can build |
| 9 | **Geography — share outside the footprint first, choropleth second** | Needs the GeoIP file and a deployment change |

**Steps 0 and 1 are the whole risk.** Everything after them is ordinary work;
those two are where a wrong decision is expensive to undo.

---

## 8. Open questions for Pacifica

1. ~~**Will they issue an admin credential**, and for which hosts?~~
   **ANSWERED 2026-09-02 — yes, for `streams.pacifica.org:9000`.** See §0. No
   credential yet for `streaming.wbai.org`, which is a separate server and a
   separate ask; every WBAI figure stays credential-free until there is one.
2. ~~**Does holding a server credential entitle us to read every station's
   listeners on it**, including stations not monitored here?~~
   **ANSWERED 2026-09-02 — yes. Authorised.** Pacifica issued the credential to
   this project's own build team for this purpose; the network's stations are
   the intended beneficiaries of the cross-station analysis in §6. Q1 and Q2 are
   both closed, and **nothing in this document is waiting on Pacifica any more.**

   > §5 still applies, for one unrelated reason: **reading the dashboard needs no
   > login**, so whatever a page shows is visible to anyone with the URL. Aggregate
   > on the server, or set `REQUIRE_LOGIN_FOR_READ=true`. Either is fine.
3. **Is there an existing listener-privacy policy** these panels must comply
   with? If Pacifica has published one, it decides §5 rather than us. Worth
   knowing whenever someone happens to find out — **not a gate on any build**,
   because §5's rule (aggregate on the server, never publish a per-listener row)
   is stricter than any policy is likely to require.
