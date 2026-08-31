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

1. **Will they issue an admin credential**, and for which hosts?
2. **Does holding a server credential entitle us to read every station's
   listeners on it**, including stations not monitored here? A technical yes is
   not a policy yes.
3. **Is there an existing listener-privacy policy** these panels must comply
   with? If Pacifica has published one, it decides §5 rather than us.
